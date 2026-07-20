import { expect, type Page, test } from "playwright/test";

const baseURL = process.env.PULSE_TEST_BASE_URL || "http://localhost:3000";
const forbiddenPublicTerms = [
  "API",
  "Call ID",
  "Google Places",
  "operator phone",
  "configured",
  "readiness",
  "timeline",
  "provider",
  "score",
  "confidence",
  "mock",
  "test",
  "demo",
  "context only",
  "sequential",
  "candidate",
  "coordination",
];

const triage = {
  title: "Major trauma detected",
  emergencyType: "MAJOR_TRAUMA",
  severity: "high",
  hospitalType: "Trauma-capable emergency care required",
  signals: ["Impact injury reported", "Movement risk needs control"],
  warning: "Do not move the person unless there is immediate danger.",
  actions: ["Keep them still", "Check for bleeding", "Keep them awake", "Watch breathing"],
  situationSummary: "The person may have a serious injury. Keep them still and make the area safe.",
  doNow: ["Keep them still", "Check for bleeding", "Keep people back", "Watch breathing"],
  doNotDo: ["Do not move them unless there is danger", "Do not give food or drink", "Do not crowd around them"],
  watchFor: ["Breathing changes", "Heavy bleeding", "Confusion or fainting"],
  infographicBrief: "Show a calm bystander keeping an injured person still, checking bleeding, clearing space, and watching breathing.",
  dispatchBrief: "Major trauma reported by bystander. Trauma-capable emergency care required.",
  source: "openai",
};

const hospitals = [
  {
    id: "hospital-1",
    name: "City Trauma Centre",
    address: "Main Road",
    phone: "+15551234567",
    distanceKm: 2.4,
    travelTimeMinutes: 8,
    score: 88,
    confidence: "high",
    rankingReason: "8 min estimated drive; listed phone available; appears operational",
    mapsUrl: "https://maps.example/hospital-1",
    source: "google_places",
  },
  {
    id: "hospital-2",
    name: "General Emergency Hospital",
    address: "Second Road",
    phone: "+15557654321",
    distanceKm: 4.1,
    travelTimeMinutes: 14,
    score: 76,
    confidence: "medium",
    rankingReason: "14 min estimated drive; listed phone available",
    mapsUrl: "https://maps.example/hospital-2",
    source: "google_places",
  },
];

const agentRun = {
  runId: "run-test-1",
  model: "qwen3.7-plus",
  qwenRequestId: "qwen-request-test-1",
  fcRequestId: "fc-request-test-1",
  latencyMs: 842,
  protocol: { ...triage, source: "qwen", policyValidated: true, policyOverride: false },
  facilities: hospitals.map((hospital) => ({ ...hospital, availabilityStatus: "unknown_until_confirmed" })),
  plan: {
    id: "plan-test-1",
    selectedFacilityId: hospitals[0].id,
    selectedFacility: { ...hospitals[0], availabilityStatus: "unknown_until_confirmed" },
    handoffBrief: triage.dispatchBrief,
    protocolType: triage.emergencyType,
    reportHash: "report-hash-test",
    planHash: "plan-hash-test",
    rationale: "Nearest sourced emergency-care listing with a public phone number.",
    humanActionRequired: "Review and approve before any message or controlled call.",
  },
  toolTrace: [
    ["get_emergency_protocol", "Selected bounded protocol"],
    ["search_nearby_care", "Returned 2 sourced facility listings"],
    ["prepare_verified_handoff", "Prepared a facility-bound handoff"],
    ["submit_coordination_plan", "Submitted recommendation for human approval"],
  ].map(([tool, resultSummary], index) => ({
    index: index + 1,
    tool,
    arguments: {},
    resultSummary,
    resultHash: `${index + 1}`.repeat(64),
    durationMs: 4,
  })),
  humanActionRequired: "Review and approve before any message or controlled call.",
  agentReceipt: "signed-agent-receipt",
  fallbackUsed: false,
};

function coordinationSession(handoffStatus: "accepted" | "not_confirmed" | "calling") {
  return {
    id: "coord-test",
    mode: "guided_response",
    handoffStatus,
    selectedDestination: hospitals[0],
    contactTargets: [
      {
        id: "hospital-1",
        type: "hospital_candidate",
        name: hospitals[0].name,
        phone: hospitals[0].phone,
        status: "selected",
        note: "Selected for the first help call.",
      },
      {
        id: "local-emergency-services",
        type: "emergency_services",
        name: "Emergency help line",
        status: "manual_required",
        note: "Backup contact path.",
      },
    ],
    facilityQuestions: [
      {
        id: "receive_now",
        label: "Can your emergency desk receive this patient right now?",
        required: true,
      },
      {
        id: "capability_available",
        label: "Do you have trauma or orthopedic emergency support available right now?",
        required: true,
      },
      {
        id: "er_capacity",
        label: "Is your emergency ward able to start assessment without avoidable delay?",
        required: true,
      },
    ],
    facilityResponses: [
      {
        questionId: "receive_now",
        status: handoffStatus === "accepted" ? "yes" : handoffStatus === "not_confirmed" ? "unknown" : "pending",
        evidence: handoffStatus === "accepted" ? "Receiver confirmed they can receive the patient." : undefined,
      },
      {
        questionId: "capability_available",
        status: handoffStatus === "accepted" ? "yes" : handoffStatus === "not_confirmed" ? "unknown" : "pending",
      },
      {
        questionId: "er_capacity",
        status: handoffStatus === "accepted" ? "yes" : handoffStatus === "not_confirmed" ? "unknown" : "pending",
      },
    ],
    callAttempts: [
      {
        id: "attempt-1",
        targetId: "hospital-1",
        targetName: hospitals[0].name,
        targetType: "hospital_candidate",
        status: handoffStatus === "calling" ? "queued" : "ended",
        dialedNumberLabel: "response line",
        routing: "response_line",
      },
    ],
    bystanderGuidance: {
      warning: triage.warning,
      actions: triage.actions,
      emergencyServicesInstruction: "If Pulse cannot confirm handoff, call your local emergency number now.",
    },
    timeline: [
      {
        id: "guidance",
        label: "Guidance shown",
        detail: triage.warning,
        state: "done",
      },
      {
        id: "destination",
        label: "Nearby care selected",
        detail: hospitals[0].name,
        state: "done",
      },
      {
        id: "brief",
        label: "Details shared",
        detail: "GPS, report, and care options were shared with the response line.",
        state: "done",
      },
      {
        id: "facility-call",
        label: handoffStatus === "accepted" ? "Help accepted the case" : "Calling for help",
        detail: handoffStatus === "accepted" ? "The selected facility accepted the case." : "Response line",
        state: handoffStatus === "accepted" ? "done" : "active",
      },
    ],
  };
}

test.use({
  baseURL,
  geolocation: { latitude: 1.3521, longitude: 103.8198 },
  permissions: ["geolocation", "microphone"],
  viewport: { width: 390, height: 844 },
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
    ],
  },
});

async function mockIntake(page: Page, handoffStatus: "accepted" | "not_confirmed") {
  let dispatchRequests = 0;

  await page.route("**/api/realtime/session", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "mocked" }) });
  });
  await page.route("**/api/dispatch/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ token: "test-session-token", expiresInSeconds: 600 }),
    });
  });
  await page.route("**/api/agent/run", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(agentRun) });
  });
  await page.route("**/api/triage", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ triage }) });
  });
  await page.route("**/api/speech/finalize", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        text: "A person fell near the road, is awake, breathing, and may have a broken leg.",
        source: "openai",
      }),
    });
  });
  await page.route("**/api/guidance/infographic", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "generated",
        imageDataUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
        altText: triage.situationSummary,
        caption: "Here is a simple visual guide for what to do now.",
        source: "openai",
      }),
    });
  });
  await page.route("**/api/hospitals?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        incidentLocation: { label: "Current GPS location", latitude: 1.3521, longitude: 103.8198, source: "gps" },
        hospitals,
        source: "google_places",
      }),
    });
  });
  await page.route("**/api/dispatch/call", async (route) => {
    dispatchRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        statusToken: "mock-status-token",
        status: "ended",
        selectedDestination: hospitals[0],
        operatorMessage: { status: "sent" },
        handoffStatus,
        coordinationSession: coordinationSession(handoffStatus),
      }),
    });
  });

  return {
    getDispatchRequests: () => dispatchRequests,
  };
}

test("mobile panic flow shows guidance before dispatch and accepted help evidence", async ({ page }) => {
  const mocks = await mockIntake(page, "accepted");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Get help now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Emergency Help" })).toBeVisible();

  await page.getByRole("button", { name: "Start Emergency Help" }).click();
  await expect(page.getByLabel("Tell me what happened")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Listening now").or(page.getByText("Typing is okay"))).toBeVisible();

  await page.getByLabel("Tell me what happened").fill("A person fell near the road, is awake, breathing, and may have a broken leg.");
  await page.getByRole("button", { name: "Review report" }).click();

  await expect(page.getByRole("heading", { name: "This is what I heard." })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("I heard this")).toHaveValue(/A person fell near the road/);
  expect(mocks.getDispatchRequests()).toBe(0);

  await page.getByRole("button", { name: "Send for help" }).click();

  await expect(page.getByRole("heading", { name: "Review before Pulse contacts anyone" })).toBeVisible({ timeout: 20000 });
  expect(mocks.getDispatchRequests()).toBe(0);
  await expect(page.getByText("Qwen Incident Coordinator")).toBeVisible();
  await expect(page.getByText("fc-request-test-1")).toBeVisible();
  await page.getByRole("button", { name: "Approve plan and contact controlled line" }).click();

  await expect(page.getByRole("heading", { name: "Help is ready to receive them." })).toBeVisible({ timeout: 20000 });
  expect(mocks.getDispatchRequests()).toBe(1);
  await expect(page.getByText("Details", { exact: true })).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect(await page.getByText("City Trauma Centre", { exact: true }).count()).toBeGreaterThan(0);
  await expect(page.getByText("What Pulse asked")).toBeVisible();
  await expect(await page.getByText("Confirmed", { exact: true }).count()).toBeGreaterThan(0);
  await expect(page.getByAltText(triage.situationSummary)).toBeVisible();

  const finalText = await page.locator("body").innerText();
  for (const term of forbiddenPublicTerms) {
    expect(finalText, `public flow should not contain ${term}`).not.toContain(term);
  }
});

test("mobile panic flow does not overstate an unconfirmed handoff", async ({ page }) => {
  const mocks = await mockIntake(page, "not_confirmed");

  await page.goto("/");
  await page.getByRole("button", { name: "Start Emergency Help" }).click();
  await expect(page.getByLabel("Tell me what happened")).toBeVisible({ timeout: 15000 });
  await page.getByLabel("Tell me what happened").fill("A person collapsed after a collision and needs urgent help.");
  await page.getByRole("button", { name: "Review report" }).click();
  await expect(page.getByRole("heading", { name: "This is what I heard." })).toBeVisible({ timeout: 15000 });
  expect(mocks.getDispatchRequests()).toBe(0);
  await page.getByRole("button", { name: "Send for help" }).click();

  await expect(page.getByRole("heading", { name: "Review before Pulse contacts anyone" })).toBeVisible({ timeout: 20000 });
  expect(mocks.getDispatchRequests()).toBe(0);
  await page.getByRole("button", { name: "Approve plan and contact controlled line" }).click();

  await expect(page.getByRole("heading", { name: "Help was not confirmed." })).toBeVisible({ timeout: 20000 });
  expect(mocks.getDispatchRequests()).toBe(1);
  await expect(page.getByText("Call local emergency services now").first()).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect(await page.getByText("Not confirmed", { exact: true }).count()).toBeGreaterThan(0);

  const finalText = await page.locator("body").innerText();
  for (const term of forbiddenPublicTerms) {
    expect(finalText, `unconfirmed flow should not contain ${term}`).not.toContain(term);
  }
});
