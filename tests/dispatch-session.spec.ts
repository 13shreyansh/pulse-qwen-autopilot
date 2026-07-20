import { expect, test } from "playwright/test";
import {
  issueApprovedDispatchSession,
  issueDispatchSession,
  issueStatusToken,
  verifyApprovedDispatchSession,
  verifyDispatchSession,
  verifyStatusToken,
} from "../src/lib/dispatch-session";
import { issueAgentReceipt, verifyAgentReceipt } from "../src/lib/agent-receipt";

test.describe("dispatch session tokens", () => {
  test("binds dispatch token to client and reviewed report", () => {
    const token = issueDispatchSession({
      clientKey: "198.51.100.10",
      report: "A person fell near the road and may have a broken leg.",
    });

    expect(token).toBeTruthy();
    expect(
      verifyDispatchSession(
        token || undefined,
        "198.51.100.10",
        "A person fell near the road and may have a broken leg.",
      ),
    ).toBe(true);
    expect(
      verifyDispatchSession(
        token || undefined,
        "198.51.100.11",
        "A person fell near the road and may have a broken leg.",
      ),
    ).toBe(false);
    expect(
      verifyDispatchSession(
        token || undefined,
        "198.51.100.10",
        "A different report should not verify.",
      ),
    ).toBe(false);
  });

  test("keeps status call IDs inside an encrypted client-bound token", () => {
    const token = issueStatusToken({
      callId: "call-sensitive-id",
      clientKey: "198.51.100.10",
    });

    expect(token).toBeTruthy();
    expect(token).not.toContain("call-sensitive-id");
    expect(verifyStatusToken(token || undefined, "198.51.100.10")).toBe("call-sensitive-id");
    expect(verifyStatusToken(token || undefined, "198.51.100.11")).toBeNull();
  });

  test("binds an approved dispatch to report, Qwen plan, and facility", () => {
    const approved = issueApprovedDispatchSession({
      clientKey: "198.51.100.10",
      report: "A person fell near the road and may have a broken leg.",
      runId: "run-1",
      planId: "plan-1",
      planHash: "abc123",
      facilityId: "facility-1",
    });

    expect(approved).toBeTruthy();
    expect(verifyApprovedDispatchSession(approved?.token, {
      clientKey: "198.51.100.10",
      report: "A person fell near the road and may have a broken leg.",
      runId: "run-1",
      planId: "plan-1",
      planHash: "abc123",
      facilityId: "facility-1",
    })?.approvalId).toBe(approved?.approvalId);
    expect(verifyApprovedDispatchSession(approved?.token, {
      clientKey: "198.51.100.10",
      report: "A person fell near the road and may have a broken leg.",
      runId: "run-1",
      planId: "plan-1",
      planHash: "abc123",
      facilityId: "invented-facility",
    })).toBeNull();
  });

  test("rejects modified agent receipts and allows only searched facilities", () => {
    const report = "A person fell near the road and may have a broken leg.";
    const reportHash = "edf852335f8d074869da85b9288e22818fcd023f169270463914624dd66b6a60";
    const receipt = issueAgentReceipt({
      report,
      runId: "run-1",
      planId: "plan-1",
      planHash: "plan-hash",
      backendReportHash: reportHash,
      recommendedFacilityId: "facility-1",
      facilityIds: ["facility-1", "facility-2"],
    });

    expect(receipt).toBeTruthy();
    expect(verifyAgentReceipt({
      receipt: receipt || undefined,
      report,
      runId: "run-1",
      planId: "plan-1",
      planHash: "plan-hash",
      selectedFacilityId: "facility-2",
    })?.recommendedFacilityId).toBe("facility-1");
    expect(verifyAgentReceipt({
      receipt: receipt ? `${receipt.slice(0, -1)}x` : undefined,
      report,
      runId: "run-1",
      planId: "plan-1",
      planHash: "plan-hash",
      selectedFacilityId: "facility-1",
    })).toBeNull();
  });
});
