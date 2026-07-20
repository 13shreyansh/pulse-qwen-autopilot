import crypto from "crypto";
import { expect, test } from "playwright/test";
import { issueAgentReceipt } from "../src/lib/agent-receipt";

const report = "A person fell near the road and may have a broken leg.";

function receipt() {
  return issueAgentReceipt({
    report,
    runId: "run-api-test",
    planId: "plan-api-test",
    planHash: "plan-hash-api-test",
    backendReportHash: crypto.createHash("sha256").update(report).digest("hex"),
    recommendedFacilityId: "facility-1",
    facilityIds: ["facility-1", "facility-2"],
  });
}

function approvalBody(overrides: Record<string, unknown> = {}) {
  return {
    report,
    agentRunId: "run-api-test",
    planId: "plan-api-test",
    planHash: "plan-hash-api-test",
    selectedFacilityId: "facility-1",
    agentReceipt: receipt(),
    explicitApproval: true,
    decision: "approve",
    ...overrides,
  };
}

test("does not issue a dispatch token without explicit human approval", async ({ request }) => {
  const response = await request.post("/api/dispatch/session", {
    data: approvalBody({ explicitApproval: false }),
  });
  expect(response.status()).toBe(422);
});

test("rejects a modified plan even when approval is asserted", async ({ request }) => {
  const response = await request.post("/api/dispatch/session", {
    data: approvalBody({ planHash: "modified-plan-hash" }),
  });
  expect(response.status()).toBe(403);
});

test("requires an auditable reason for a facility override", async ({ request }) => {
  const missingReason = await request.post("/api/dispatch/session", {
    data: approvalBody({ selectedFacilityId: "facility-2", decision: "override", overrideReason: "short" }),
  });
  expect(missingReason.status()).toBe(422);

  const approvedOverride = await request.post("/api/dispatch/session", {
    data: approvalBody({
      selectedFacilityId: "facility-2",
      decision: "override",
      overrideReason: "The operator knows the nearer entrance is closed.",
    }),
  });
  expect(approvedOverride.status()).toBe(200);
  const result = await approvedOverride.json();
  expect(result.token).toMatch(/^v2\./);
});
