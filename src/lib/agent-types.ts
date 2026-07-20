export type AgentProtocol = {
  title: string;
  emergencyType: string;
  severity: string;
  hospitalType: string;
  signals: string[];
  warning: string;
  actions: string[];
  situationSummary: string;
  doNow: string[];
  doNotDo: string[];
  watchFor: string[];
  infographicBrief: string;
  dispatchBrief: string;
  source: "qwen";
  policyValidated: true;
  policyOverride: boolean;
};

export type AgentFacility = {
  id: string;
  name: string;
  address: string;
  phone?: string;
  distanceKm: number;
  travelTimeMinutes?: number;
  score: number;
  confidence: "high" | "medium" | "low";
  rankingReason: string;
  mapsUrl: string;
  source: "google_places" | "openstreetmap";
  sourceAsOf?: string;
  availabilityStatus: "unknown_until_confirmed";
};

export type AgentPlan = {
  id: string;
  selectedFacilityId: string;
  selectedFacility: AgentFacility;
  handoffBrief: string;
  protocolType: string;
  reportHash: string;
  planHash: string;
  rationale: string;
  humanActionRequired: string;
};

export type AgentTraceEntry = {
  index: number;
  tool:
    | "get_emergency_protocol"
    | "search_nearby_care"
    | "prepare_verified_handoff"
    | "submit_coordination_plan";
  arguments: Record<string, unknown>;
  resultSummary: string;
  resultHash: string;
  durationMs: number;
};

export type AgentRunResult = {
  runId: string;
  model: "qwen3.7-plus" | string;
  qwenRequestId: string;
  fcRequestId: string;
  latencyMs: number;
  protocol: AgentProtocol;
  facilities: AgentFacility[];
  plan: AgentPlan;
  toolTrace: AgentTraceEntry[];
  humanActionRequired: string;
  agentReceipt: string;
  fallbackUsed: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown, minLength = 1) {
  return typeof value === "string" && value.length >= minLength;
}

function isFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function isSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function validateAgentRunResult(value: unknown): Omit<AgentRunResult, "agentReceipt"> {
  if (!isRecord(value)) throw new Error("Agent response is not an object.");
  const protocol = value.protocol;
  const facilities = value.facilities;
  const plan = value.plan;
  const trace = value.toolTrace;

  if (
    !isString(value.runId) ||
    !isString(value.model) ||
    !isString(value.qwenRequestId) ||
    !isString(value.fcRequestId) ||
    !isFiniteNumber(value.latencyMs) ||
    value.fallbackUsed !== false ||
    !isString(value.humanActionRequired)
  ) {
    throw new Error("Agent response metadata is incomplete.");
  }

  if (
    !isRecord(protocol) ||
    !isString(protocol.emergencyType) ||
    !isString(protocol.warning) ||
    !Array.isArray(protocol.actions) ||
    protocol.source !== "qwen" ||
    protocol.policyValidated !== true
  ) {
    throw new Error("Agent protocol is invalid.");
  }

  if (!Array.isArray(facilities) || facilities.length === 0) {
    throw new Error("Agent returned no grounded facility evidence.");
  }
  for (const facility of facilities) {
    if (
      !isRecord(facility) ||
      !isString(facility.id) ||
      !isString(facility.name) ||
      !isString(facility.address) ||
      !isFiniteNumber(facility.distanceKm) ||
      !isFiniteNumber(facility.score) ||
      (facility.source !== "google_places" && facility.source !== "openstreetmap") ||
      facility.availabilityStatus !== "unknown_until_confirmed"
    ) {
      throw new Error("Agent returned invalid facility evidence.");
    }
  }

  if (
    !isRecord(plan) ||
    !isString(plan.id) ||
    !isSha256(plan.planHash) ||
    !isSha256(plan.reportHash) ||
    !isString(plan.selectedFacilityId) ||
    !isString(plan.rationale) ||
    !isRecord(plan.selectedFacility) ||
    plan.selectedFacility.id !== plan.selectedFacilityId ||
    !facilities.some((facility) => isRecord(facility) && facility.id === plan.selectedFacilityId)
  ) {
    throw new Error("Agent plan is not bound to returned evidence.");
  }

  if (!Array.isArray(trace) || trace.length < 4 || trace.length > 5) {
    throw new Error("Agent tool trace is incomplete.");
  }
  const expectedTools = [
    "get_emergency_protocol",
    "search_nearby_care",
    "prepare_verified_handoff",
    "submit_coordination_plan",
  ];
  if (trace.length !== expectedTools.length) {
    throw new Error("Agent tool trace did not complete the required four tools.");
  }
  for (const [index, entry] of trace.entries()) {
    if (
      !isRecord(entry) ||
      entry.index !== index + 1 ||
      entry.tool !== expectedTools[index] ||
      !isRecord(entry.arguments) ||
      !isSha256(entry.resultHash) ||
      !isFiniteNumber(entry.durationMs)
    ) {
      throw new Error("Agent tool trace is invalid.");
    }
  }

  return value as Omit<AgentRunResult, "agentReceipt">;
}
