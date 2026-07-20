import { expect, test } from "playwright/test";
import { validateAgentRunResult } from "../src/lib/agent-types";

function validResult() {
  const facility = {
    id: "facility-1",
    name: "City General Hospital",
    address: "Main Road",
    distanceKm: 2.4,
    score: 82,
    confidence: "medium",
    rankingReason: "2.4 km away; current operational status unverified",
    mapsUrl: "https://maps.example/facility-1",
    source: "google_places",
    availabilityStatus: "unknown_until_confirmed",
  };
  const tools = [
    "get_emergency_protocol",
    "search_nearby_care",
    "prepare_verified_handoff",
    "submit_coordination_plan",
  ];
  return {
    runId: "run-1",
    model: "qwen3.7-plus",
    qwenRequestId: "qwen-1",
    fcRequestId: "fc-1",
    latencyMs: 300,
    protocol: {
      emergencyType: "MAJOR_TRAUMA",
      warning: "Do not move the person unless there is immediate danger.",
      actions: ["Keep them still"],
      source: "qwen",
      policyValidated: true,
    },
    facilities: [facility],
    plan: {
      id: "plan-1",
      planHash: "a".repeat(64),
      reportHash: "b".repeat(64),
      selectedFacilityId: facility.id,
      selectedFacility: facility,
      rationale: "Nearest sourced public listing.",
    },
    toolTrace: tools.map((tool, index) => ({
      index: index + 1,
      tool,
      arguments: {},
      resultHash: `${index + 1}`.repeat(64),
      durationMs: 1,
    })),
    humanActionRequired: "Review and approve.",
    fallbackUsed: false,
  };
}

test("accepts the exact grounded four-tool response contract", () => {
  expect(validateAgentRunResult(validResult()).plan.selectedFacilityId).toBe("facility-1");
});

test("rejects a reordered tool trace from the backend", () => {
  const result = validResult();
  [result.toolTrace[0], result.toolTrace[1]] = [result.toolTrace[1], result.toolTrace[0]];
  expect(() => validateAgentRunResult(result)).toThrow(/trace/i);
});

test("rejects a plan tied to an unseen facility", () => {
  const result = validResult();
  result.plan.selectedFacilityId = "invented-facility";
  expect(() => validateAgentRunResult(result)).toThrow(/evidence/i);
});
