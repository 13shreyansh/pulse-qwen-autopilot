import { NextRequest, NextResponse } from "next/server";
import { agentReceiptReady, issueAgentReceipt } from "@/lib/agent-receipt";
import { validateAgentRunResult } from "@/lib/agent-types";
import { rateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

type AgentRunBody = {
  report?: string;
  location?: {
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
  };
  mode?: "live" | "demo";
};

function backendUrl(path: string) {
  const base = process.env.PULSE_AGENT_BACKEND_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function validCoordinate(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, { name: "qwen-agent", limit: 8, windowMs: 10 * 60_000 });
  if (limited) return limited;

  const target = backendUrl("agent/run");
  const token = process.env.PULSE_AGENT_BACKEND_TOKEN;
  if (!target || !token || !agentReceiptReady()) {
    return NextResponse.json(
      {
        error: "Qwen coordination is not configured yet.",
        fallbackAvailable: true,
        fallbackLabel: "Deterministic safety guidance (not a Qwen run)",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as AgentRunBody | null;
  const report = body?.report?.trim();
  const location = body?.location;
  if (!report || report.length < 12 || report.length > 2_000) {
    return NextResponse.json({ error: "A reviewed report is required." }, { status: 400 });
  }
  if (
    !location ||
    !validCoordinate(location.latitude, -90, 90) ||
    !validCoordinate(location.longitude, -180, 180)
  ) {
    return NextResponse.json({ error: "A precise GPS location is required." }, { status: 400 });
  }
  if (
    location.accuracyMeters != null &&
    (!Number.isFinite(location.accuracyMeters) || location.accuracyMeters < 0 || location.accuracyMeters > 100_000)
  ) {
    return NextResponse.json({ error: "Location accuracy is invalid." }, { status: 400 });
  }

  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        report,
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracyMeters: location.accuracyMeters,
        },
        mode: body?.mode === "demo" ? "demo" : "live",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const backendDetail = typeof payload?.detail === "string" ? payload.detail : undefined;
      return NextResponse.json(
        {
          error: backendDetail || "Qwen coordination could not be completed.",
          fallbackAvailable: true,
          fallbackLabel: "Deterministic safety guidance (not a Qwen run)",
        },
        { status: response.status >= 500 ? 503 : 502 },
      );
    }
    if (!payload) throw new Error("Agent returned an empty response.");
    if (!payload.fcRequestId) {
      payload.fcRequestId = response.headers.get("x-fc-request-id") || "local-development";
    }
    const validated = validateAgentRunResult(payload);
    const receipt = issueAgentReceipt({
      report,
      runId: validated.runId,
      planId: validated.plan.id,
      planHash: validated.plan.planHash,
      backendReportHash: validated.plan.reportHash,
      recommendedFacilityId: validated.plan.selectedFacilityId,
      facilityIds: validated.facilities.map((facility) => facility.id),
    });
    if (!receipt) throw new Error("Agent plan could not be signed.");

    return NextResponse.json({ ...validated, agentReceipt: receipt });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error && error.name !== "TimeoutError"
          ? error.message
          : "Qwen coordination timed out.",
        fallbackAvailable: true,
        fallbackLabel: "Deterministic safety guidance (not a Qwen run)",
      },
      { status: 503 },
    );
  }
}
