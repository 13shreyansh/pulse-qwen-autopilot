import crypto from "crypto";
import { NextRequest } from "next/server";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const STATUS_TOKEN_TTL_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 45 * 1000;
const recentDispatches = new Map<string, number>();

function secretMaterial() {
  const secret = process.env.PULSE_DISPATCH_SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") return null;
  return "pulse-local-development-secret";
}

function sign(payload: string) {
  const secret = secretMaterial();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function secretKey() {
  const secret = secretMaterial();
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret).digest();
}

function hashValue(value: string) {
  return crypto.createHash("sha256").update(value.trim().replace(/\s+/g, " ").toLowerCase()).digest("base64url");
}

function timingEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function getClientKey(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

export function dispatchSecretReady() {
  return Boolean(secretMaterial());
}

export function issueDispatchSession(input: { clientKey: string; report: string }) {
  const signatureClient = hashValue(input.clientKey);
  const reportHash = hashValue(input.report);
  const issuedAt = Date.now();
  const nonce = crypto.randomBytes(12).toString("base64url");
  const payload = `${issuedAt}.${nonce}.${signatureClient}.${reportHash}`;
  const signature = sign(payload);
  if (!signature) return null;
  return `${payload}.${signature}`;
}

export function verifyDispatchSession(token: string | undefined, clientKey: string, report: string) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 5) return false;
  const [issuedAtRaw, nonce, tokenClientHash, tokenReportHash, signature] = parts;
  if (!issuedAtRaw || !nonce || !tokenClientHash || !tokenReportHash || !signature) return false;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > TOKEN_TTL_MS) return false;

  if (!timingEqual(tokenClientHash, hashValue(clientKey))) return false;
  if (!timingEqual(tokenReportHash, hashValue(report))) return false;

  const payload = `${issuedAtRaw}.${nonce}.${tokenClientHash}.${tokenReportHash}`;
  const expected = sign(payload);
  return Boolean(expected && timingEqual(signature, expected));
}

type ApprovedDispatchClaims = {
  version: 2;
  clientHash: string;
  reportHash: string;
  runId: string;
  planId: string;
  planHash: string;
  facilityId: string;
  decision: "approve" | "override";
  overrideReasonHash?: string;
  approvalId: string;
  issuedAt: number;
  nonce: string;
};

export function issueApprovedDispatchSession(input: {
  clientKey: string;
  report: string;
  runId: string;
  planId: string;
  planHash: string;
  facilityId: string;
  decision?: "approve" | "override";
  overrideReason?: string;
}) {
  const claims: ApprovedDispatchClaims = {
    version: 2,
    clientHash: hashValue(input.clientKey),
    reportHash: hashValue(input.report),
    runId: input.runId,
    planId: input.planId,
    planHash: input.planHash,
    facilityId: input.facilityId,
    decision: input.decision || "approve",
    overrideReasonHash: input.overrideReason ? hashValue(input.overrideReason) : undefined,
    approvalId: `approval_${crypto.randomBytes(10).toString("base64url")}`,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(12).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(`v2.${encoded}`);
  if (!signature) return null;
  return { token: `v2.${encoded}.${signature}`, approvalId: claims.approvalId };
}

export function verifyApprovedDispatchSession(
  token: string | undefined,
  input: {
    clientKey: string;
    report: string;
    runId?: string;
    planId?: string;
    planHash?: string;
    facilityId?: string;
  },
) {
  const parts = token?.split(".") || [];
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  const [, encoded, signature] = parts;
  const expected = sign(`v2.${encoded}`);
  if (!expected || !timingEqual(signature, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ApprovedDispatchClaims;
    if (
      claims.version !== 2 ||
      Date.now() - claims.issuedAt > TOKEN_TTL_MS ||
      claims.issuedAt > Date.now() + 30_000 ||
      !timingEqual(claims.clientHash, hashValue(input.clientKey)) ||
      !timingEqual(claims.reportHash, hashValue(input.report)) ||
      claims.runId !== input.runId ||
      claims.planId !== input.planId ||
      claims.planHash !== input.planHash ||
      claims.facilityId !== input.facilityId
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function issueStatusToken(input: { callId: string; clientKey: string }) {
  const key = secretKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const payload = JSON.stringify({
    callId: input.callId,
    clientHash: hashValue(input.clientKey),
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(12).toString("base64url"),
  });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function verifyStatusToken(token: string | undefined, clientKey: string) {
  if (!token) return null;
  const key = secretKey();
  if (!key) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const [ivRaw, tagRaw, encryptedRaw] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(decrypted) as { callId?: string; clientHash?: string; issuedAt?: number };
    if (!payload.callId || !payload.clientHash || !payload.issuedAt) return null;
    if (Date.now() - payload.issuedAt > STATUS_TOKEN_TTL_MS) return null;
    if (!timingEqual(payload.clientHash, hashValue(clientKey))) return null;
    return payload.callId;
  } catch {
    return null;
  }
}

export function checkDispatchCooldown(clientKey: string) {
  const now = Date.now();
  const last = recentDispatches.get(clientKey) || 0;
  if (now - last < COOLDOWN_MS) {
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((COOLDOWN_MS - (now - last)) / 1000),
    };
  }

  recentDispatches.set(clientKey, now);
  return { ok: true, retryAfterSeconds: 0 };
}
