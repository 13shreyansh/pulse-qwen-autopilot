import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type DeploymentMetadata = {
  provider?: string;
  region?: string;
  functionName?: string;
  gitSha?: string;
  model?: string;
  qwenBaseHostname?: string;
  fcRequestId?: string;
};

function backendDeploymentUrl() {
  const base = process.env.PULSE_AGENT_BACKEND_URL?.trim();
  return base ? `${base.replace(/\/$/, "")}/deployment` : null;
}

export async function GET() {
  const target = backendDeploymentUrl();
  if (!target) {
    return NextResponse.json(
      {
        provider: "Alibaba Cloud Function Compute",
        region: "ap-southeast-1",
        functionName: "pulse-qwen-agent",
        gitSha: process.env.VERCEL_GIT_COMMIT_SHA || "local",
        model: "qwen3.7-plus",
        qwenBaseHostname: "dashscope-intl.aliyuncs.com",
        fcRequestId: null,
        status: "needs_configuration",
      },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const data = (await response.json().catch(() => null)) as DeploymentMetadata | null;
    if (!response.ok || !data) throw new Error("Deployment metadata unavailable");
    return NextResponse.json({
      provider: data.provider || "Alibaba Cloud Function Compute",
      region: data.region || "ap-southeast-1",
      functionName: data.functionName || "pulse-qwen-agent",
      gitSha: data.gitSha || "unknown",
      model: data.model || "qwen3.7-plus",
      qwenBaseHostname: data.qwenBaseHostname || "dashscope-intl.aliyuncs.com",
      fcRequestId: data.fcRequestId || response.headers.get("x-fc-request-id"),
      status: "ready",
    });
  } catch {
    return NextResponse.json(
      {
        provider: "Alibaba Cloud Function Compute",
        region: "ap-southeast-1",
        functionName: "pulse-qwen-agent",
        model: "qwen3.7-plus",
        qwenBaseHostname: "dashscope-intl.aliyuncs.com",
        status: "unavailable",
      },
      { status: 503 },
    );
  }
}
