import crypto from "crypto";

const RECEIPT_TTL_MS = 15 * 60 * 1000;

type AgentReceiptClaims = {
  version: 1;
  runId: string;
  planId: string;
  planHash: string;
  reportHash: string;
  recommendedFacilityId: string;
  facilityIds: string[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function receiptSecret() {
  const secret = process.env.PULSE_AGENT_RECEIPT_SECRET || process.env.PULSE_DISPATCH_SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") return null;
  return "pulse-local-agent-receipt-secret";
}

function digestReport(report: string) {
  return crypto.createHash("sha256").update(report.trim().replace(/\s+/g, " ")).digest("hex");
}

function sign(encodedPayload: string) {
  const secret = receiptSecret();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function agentReceiptReady() {
  return Boolean(receiptSecret());
}

export function issueAgentReceipt(input: {
  report: string;
  runId: string;
  planId: string;
  planHash: string;
  backendReportHash: string;
  recommendedFacilityId: string;
  facilityIds: string[];
}) {
  const reportHash = digestReport(input.report);
  if (!safeEqual(reportHash, input.backendReportHash)) return null;
  const issuedAt = Date.now();
  const claims: AgentReceiptClaims = {
    version: 1,
    runId: input.runId,
    planId: input.planId,
    planHash: input.planHash,
    reportHash,
    recommendedFacilityId: input.recommendedFacilityId,
    facilityIds: Array.from(new Set(input.facilityIds)).sort(),
    issuedAt,
    expiresAt: issuedAt + RECEIPT_TTL_MS,
    nonce: crypto.randomBytes(12).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(encoded);
  return signature ? `v1.${encoded}.${signature}` : null;
}

export function verifyAgentReceipt(input: {
  receipt?: string;
  report: string;
  runId: string;
  planId: string;
  planHash: string;
  selectedFacilityId: string;
}) {
  const parts = input.receipt?.split(".") || [];
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, encoded, signature] = parts;
  const expected = sign(encoded);
  if (!expected || !safeEqual(signature, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AgentReceiptClaims;
    if (
      claims.version !== 1 ||
      claims.expiresAt < Date.now() ||
      claims.issuedAt > Date.now() + 30_000 ||
      claims.runId !== input.runId ||
      claims.planId !== input.planId ||
      claims.planHash !== input.planHash ||
      !safeEqual(claims.reportHash, digestReport(input.report)) ||
      !claims.facilityIds.includes(input.selectedFacilityId)
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
