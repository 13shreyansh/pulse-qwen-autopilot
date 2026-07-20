import { NextRequest, NextResponse } from "next/server";
import { verifyAgentReceipt } from "@/lib/agent-receipt";
import { dispatchSecretReady, getClientKey, issueApprovedDispatchSession } from "@/lib/dispatch-session";
import { rateLimit } from "@/lib/rate-limit";

type ApprovalBody = {
  report?: string;
  agentRunId?: string;
  planId?: string;
  planHash?: string;
  selectedFacilityId?: string;
  agentReceipt?: string;
  explicitApproval?: boolean;
  decision?: "approve" | "override";
  overrideReason?: string;
};

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, { name: "dispatch-session", limit: 6, windowMs: 60_000 });
  if (limited) return limited;

  if (!dispatchSecretReady()) {
    return NextResponse.json({ error: "Dispatch session signing is not configured." }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as ApprovalBody | null;
  const report = body?.report?.trim();
  if (!report || report.length < 12) {
    return NextResponse.json({ error: "Reviewed report is required before dispatch." }, { status: 400 });
  }

  const agentRunId = body?.agentRunId?.trim();
  const planId = body?.planId?.trim();
  const planHash = body?.planHash?.trim();
  const selectedFacilityId = body?.selectedFacilityId?.trim();
  if (!agentRunId || !planId || !planHash || !selectedFacilityId || body?.explicitApproval !== true) {
    return NextResponse.json({ error: "Explicit plan approval is required before dispatch." }, { status: 422 });
  }

  const receipt = verifyAgentReceipt({
    receipt: body?.agentReceipt,
    report,
    runId: agentRunId,
    planId,
    planHash,
    selectedFacilityId,
  });
  if (!receipt) {
    return NextResponse.json({ error: "The Qwen plan receipt is invalid or expired." }, { status: 403 });
  }

  const isOverride = selectedFacilityId !== receipt.recommendedFacilityId;
  if (isOverride && (body?.decision !== "override" || (body.overrideReason?.trim().length || 0) < 8)) {
    return NextResponse.json({ error: "A written reason is required for a facility override." }, { status: 422 });
  }
  if (!isOverride && body?.decision !== "approve") {
    return NextResponse.json({ error: "Approve the recommended facility to continue." }, { status: 422 });
  }

  const approved = issueApprovedDispatchSession({
    clientKey: getClientKey(request),
    report,
    runId: agentRunId,
    planId,
    planHash,
    facilityId: selectedFacilityId,
    decision: isOverride ? "override" : "approve",
    overrideReason: isOverride ? body.overrideReason?.trim() : undefined,
  });
  if (!approved) {
    return NextResponse.json({ error: "Dispatch session signing is not configured." }, { status: 500 });
  }

  return NextResponse.json({
    token: approved.token,
    approvalId: approved.approvalId,
    expiresInSeconds: 600,
  });
}
