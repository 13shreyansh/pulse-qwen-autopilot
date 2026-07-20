import { NextRequest, NextResponse } from "next/server";
import { checkDispatchCooldown, getClientKey, issueStatusToken, verifyApprovedDispatchSession } from "@/lib/dispatch-session";
import { rateLimit } from "@/lib/rate-limit";
import { getResponseLinePhone } from "@/lib/response-line";

export const maxDuration = 60;

type TriageResult = {
  title: string;
  emergencyType: string;
  severity: string;
  hospitalType: string;
  signals: string[];
  warning: string;
  actions: string[];
  dispatchBrief: string;
  source?: "openai" | "local_fallback";
};

type HospitalCandidate = {
  id?: string;
  name: string;
  address?: string;
  phone?: string;
  distanceKm?: number;
  travelTimeMinutes?: number;
  source?: "google_places";
  mapsUrl?: string;
  score?: number;
  confidence?: "high" | "medium" | "low";
  rankingReason?: string;
};

type DispatchRequest = {
  transcript?: string;
  triage?: TriageResult;
  incidentLocation?: {
    label: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
  } | null;
  hospital?: HospitalCandidate | null;
  hospitals?: HospitalCandidate[];
  messageAlreadySent?: boolean;
  dispatchSessionToken?: string;
  agentRunId?: string;
  planId?: string;
  planHash?: string;
  selectedFacilityId?: string;
};

type CoordinationHandoffStatus =
  | "preparing"
  | "brief_sent"
  | "calling"
  | "connected"
  | "accepted"
  | "not_confirmed"
  | "failed";

type FacilityQuestion = {
  id: string;
  label: string;
  required: boolean;
};

type FacilityResponse = {
  questionId: string;
  status: "pending" | "yes" | "no" | "unknown";
  evidence?: string;
};

type ContactTarget = {
  id: string;
  type: "hospital_candidate" | "emergency_services" | "family_contact";
  name: string;
  phone?: string;
  status: "selected" | "queued" | "manual_required" | "future_integration";
  note: string;
};

type CoordinationTimelineItem = {
  id: string;
  label: string;
  detail: string;
  state: "done" | "active" | "attention" | "pending";
};

type CoordinationCallAttempt = {
  id: string;
  targetId: string;
  targetName: string;
  targetType: ContactTarget["type"];
  status: OperatorCallResult["status"] | "prepared";
  callId?: string;
  callProvider?: OperatorCallResult["provider"];
  dialedNumberLabel: string;
  routing: "response_line" | "direct_hospital_phone";
};

type CoordinationSession = {
  id: string;
  mode: "guided_response";
  handoffStatus: CoordinationHandoffStatus;
  selectedDestination?: HospitalCandidate;
  contactTargets: ContactTarget[];
  facilityQuestions: FacilityQuestion[];
  facilityResponses: FacilityResponse[];
  callAttempts: CoordinationCallAttempt[];
  bystanderGuidance: {
    warning: string;
    actions: string[];
    emergencyServicesInstruction: string;
  };
  timeline: CoordinationTimelineItem[];
};

type OperatorMessageResult = {
  status: "sent" | "not_configured" | "failed";
  provider: "twilio" | "webhook" | "none";
  id?: string;
  code?: string;
  error?: string;
  providerStatus?: string;
};

type OperatorCallResult = {
  callId?: string;
  status: "queued" | "ringing" | "in-progress" | "ended" | "failed";
  provider: "vapi" | "twilio";
  diagnosticCode?: string;
  error?: string;
};

function normalizeE164Phone(value?: string) {
  const normalized = value?.trim().replace(/[\s().-]/g, "");
  if (!normalized) return null;
  if (/^\+\d{8,15}$/.test(normalized)) return normalized;
  if (/^\d{8,15}$/.test(normalized)) return `+${normalized}`;
  return null;
}

function getOperatorPhone() {
  return getResponseLinePhone();
}

function getDispatchMode() {
  const dryRunRequested = process.env.PULSE_DISPATCH_MODE === "dry_run";
  const dryRunAllowed =
    process.env.NODE_ENV !== "production" || process.env.PULSE_ALLOW_DRY_RUN_IN_PRODUCTION === "true";

  return dryRunRequested && dryRunAllowed ? "dry_run" : "live";
}

function getCallProvider() {
  return process.env.PULSE_CALL_PROVIDER === "twilio" ? "twilio" : "vapi";
}

function serverVerifiedTriage(input: TriageResult, transcript: string): TriageResult {
  const text = transcript.toLowerCase();
  const emergencyType =
    /\b(chest|heart|cardiac|not breathing|no pulse|cpr)\b/.test(text)
      ? "CARDIAC_ARREST"
      : /\b(breath|choking|airway|oxygen)\b/.test(text)
        ? "RESPIRATORY_DISTRESS"
        : /\b(stroke|face droop|slurred|weakness)\b/.test(text)
          ? "STROKE"
          : /\b(bleed|blood|hemorrhage|haemorrhage)\b/.test(text)
            ? "SEVERE_BLEEDING"
            : /\b(pregnan|labor|labour|birth|obstetric)\b/.test(text)
              ? "OBSTETRIC_EMERGENCY"
              : /\b(fall|crash|hit|collision|accident|broken|fracture|injury|road)\b/.test(text)
                ? "MAJOR_TRAUMA"
                : "UNKNOWN";
  const severity =
    /\b(not breathing|no pulse|unconscious|severe bleeding|heavy bleeding|chest pain)\b/.test(text)
      ? "critical"
      : input.severity === "moderate"
        ? "moderate"
        : "high";
  const hospitalTypeByEmergency: Record<string, string> = {
    MAJOR_TRAUMA: "Trauma-capable emergency care required",
    CARDIAC_ARREST: "Cardiac-ready emergency department required",
    RESPIRATORY_DISTRESS: "Emergency department with airway support required",
    STROKE: "Stroke-capable emergency care required",
    SEVERE_BLEEDING: "Emergency department with trauma support required",
    OBSTETRIC_EMERGENCY: "Maternity emergency care required",
    UNKNOWN: "Emergency department required",
  };

  return {
    ...input,
    emergencyType,
    severity,
    hospitalType: hospitalTypeByEmergency[emergencyType],
    dispatchBrief: `${hospitalTypeByEmergency[emergencyType]}. Bystander report: ${transcript.slice(0, 220)}`,
    source: input.source,
  };
}

function requiresInteractiveCall() {
  return process.env.PULSE_REQUIRE_INTERACTIVE_CALL !== "false";
}

function getVapiRingTimeoutSeconds() {
  const configured = Number(process.env.PULSE_VAPI_RING_TIMEOUT_SECONDS);
  if (!Number.isFinite(configured)) return 180;
  return Math.min(Math.max(Math.round(configured), 30), 600);
}

function getVapiMaxDurationSeconds() {
  const configured = Number(process.env.PULSE_VAPI_MAX_DURATION_SECONDS);
  if (!Number.isFinite(configured)) return 300;
  return Math.min(Math.max(Math.round(configured), 60), 43200);
}

function getTwilioAuth(purpose: "message" | "voice" = "voice") {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const username = process.env.TWILIO_API_KEY_SID || accountSid;
  const password = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = normalizeE164Phone(
    purpose === "message"
      ? process.env.SMS_FROM_NUMBER || process.env.TWILIO_FROM_NUMBER || process.env.VAPI_CALLER_NUMBER
      : process.env.TWILIO_FROM_NUMBER || process.env.VAPI_CALLER_NUMBER || process.env.SMS_FROM_NUMBER,
  );

  if (!accountSid || !username || !password || !fromNumber) return null;

  return {
    accountSid,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    fromNumber,
  };
}

function buildMapsUrl(location?: DispatchRequest["incidentLocation"]) {
  if (location?.latitude == null || location.longitude == null) return null;
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
}

function readableScene(body: DispatchRequest) {
  const label = body.incidentLocation?.label?.trim();
  if (label && !/^(current gps location|map location)$/i.test(label)) return label;
  return "the map location";
}

function patientLocationPhrase(body: DispatchRequest) {
  const scene = readableScene(body);
  return scene === "the map location" ? "at the map location we sent" : `around ${scene}`;
}

function hospitalDistancePhrase(body: DispatchRequest) {
  const distance = body.hospital?.distanceKm;
  if (distance == null || !Number.isFinite(distance)) return null;
  const rounded = distance < 1 ? Math.round(distance * 1000) : Math.round(distance * 10) / 10;
  const unit = distance < 1 ? "meters" : "kilometers";
  const hospitalName = body.hospital?.name || "your hospital";
  return `This is about ${rounded} ${unit} from ${hospitalName}.`;
}

function patientNeed(triage?: TriageResult) {
  if (!triage) return "emergency care";
  return triage.hospitalType || triage.emergencyType.toLowerCase().replace(/_/g, " ");
}

function buildIncidentMessage(body: DispatchRequest, transcript: string) {
  const locationLabel = readableScene(body);
  const mapsLink = buildMapsUrl(body.incidentLocation);
  const distanceFromHospital = hospitalDistancePhrase(body);

  return [
    "Pulse emergency patient",
    `Location: ${locationLabel}`,
    distanceFromHospital,
    mapsLink ? `Map: ${mapsLink}` : null,
    `Condition: ${body.triage?.dispatchBrief || transcript}`,
    `Care needed: ${patientNeed(body.triage)}`,
    "Can your emergency desk receive this patient now?",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function facilityQuestionsForTriage(triage: TriageResult): FacilityQuestion[] {
  const capabilityByType: Record<string, string> = {
    MAJOR_TRAUMA: "Do you have trauma or orthopedic emergency support available right now?",
    CARDIAC_ARREST: "Do you have cardiac emergency support and resuscitation capacity available right now?",
    RESPIRATORY_DISTRESS: "Do you have emergency airway or oxygen support available right now?",
    STROKE: "Do you have stroke assessment and urgent imaging support available right now?",
    SEVERE_BLEEDING: "Do you have emergency bleeding control and trauma support available right now?",
    OBSTETRIC_EMERGENCY: "Do you have maternity emergency support available right now?",
  };

  return [
    {
      id: "receive_now",
      label: "Can your emergency desk receive this patient right now?",
      required: true,
    },
    {
      id: "capability_available",
      label: capabilityByType[triage.emergencyType] || `Do you have ${triage.hospitalType} available right now?`,
      required: true,
    },
    {
      id: "er_capacity",
      label: "Can your emergency ward start seeing the patient without a long delay?",
      required: true,
    },
    {
      id: "ambulance_handoff",
      label: "Can you send an ambulance, or guide an ambulance to the correct entrance?",
      required: false,
    },
  ];
}

function buildContactTargets(body: DispatchRequest, coordinationPhone: string | null): ContactTarget[] {
  const hospitalTargets = (body.hospitals?.length ? body.hospitals : body.hospital ? [body.hospital] : [])
    .slice(0, 3)
    .map<ContactTarget>((hospital, index) => ({
      id: `hospital-${index + 1}`,
      type: "hospital_candidate",
      name: hospital.name,
      phone: hospital.phone,
      status: index === 0 ? "selected" : "queued",
      note: index === 0
        ? coordinationPhone
          ? "Selected for the first help call."
          : "Selected, but a response line is not available yet."
        : "Ready as a backup option if the first call is not confirmed.",
    }));

  return [
    ...hospitalTargets,
    {
      id: "local-emergency-services",
      type: "emergency_services",
      name: "Local emergency services",
      status: "manual_required",
      note: "Pulse keeps this visible as the immediate fallback action.",
    },
    {
      id: "family-contact",
      type: "family_contact",
      name: "Family or trusted contact",
      status: "future_integration",
      note: "Reserved for a future contact workflow; no private contacts are inferred.",
    },
  ];
}

function buildFacilityResponses(questions: FacilityQuestion[], status: FacilityResponse["status"], evidence?: string) {
  return questions.map<FacilityResponse>((question) => ({
    questionId: question.id,
    status,
    evidence,
  }));
}

function inferRoutingForTarget(body: DispatchRequest, coordinationPhone: string | null) {
  const selectedPhone = normalizeE164Phone(body.hospital?.phone);
  if (selectedPhone && coordinationPhone && selectedPhone === coordinationPhone) {
    return "direct_hospital_phone" as const;
  }

  return "response_line" as const;
}

function timelineForSession(input: {
  body: DispatchRequest & { triage: TriageResult };
  handoffStatus: CoordinationHandoffStatus;
  message: OperatorMessageResult;
  callAttempt?: CoordinationCallAttempt;
}) {
  const callState =
    input.handoffStatus === "failed"
      ? "attention"
      : input.handoffStatus === "accepted" || input.handoffStatus === "not_confirmed"
        ? "done"
        : input.handoffStatus === "calling" || input.handoffStatus === "connected"
          ? "active"
          : "pending";

  return [
    {
      id: "guidance",
      label: "Bystander guidance shown",
      detail: input.body.triage.warning,
      state: "done",
    },
    {
      id: "destination",
      label: "Nearby emergency care selected",
      detail: input.body.hospital?.name || "Nearest suitable emergency care selected from live search.",
      state: "done",
    },
    {
      id: "brief",
      label: "Incident brief shared",
      detail: input.message.status === "sent"
        ? "GPS, report, and care options were shared with the response line."
        : "Pulse could not share the incident brief yet.",
      state: input.message.status === "sent" ? "done" : "attention",
    },
    {
      id: "facility-call",
      label: "Calling nearby help",
      detail: input.callAttempt
        ? `${input.callAttempt.targetName}: ${input.callAttempt.routing === "direct_hospital_phone" ? "direct hospital desk" : "response line"}`
        : "Waiting for call setup.",
      state: callState,
    },
  ] satisfies CoordinationTimelineItem[];
}

function buildCoordinationSession(input: {
  body: DispatchRequest & { triage: TriageResult };
  coordinationPhone: string | null;
  message: OperatorMessageResult;
  handoffStatus: CoordinationHandoffStatus;
  callAttempt?: CoordinationCallAttempt;
  facilityResponseStatus?: FacilityResponse["status"];
  responseEvidence?: string;
}): CoordinationSession {
  const questions = facilityQuestionsForTriage(input.body.triage);
  const selectedTargetId = "hospital-1";

  return {
    id: `coord-${Date.now()}`,
    mode: "guided_response",
    handoffStatus: input.handoffStatus,
    selectedDestination: input.body.hospital || undefined,
    contactTargets: buildContactTargets(input.body, input.coordinationPhone),
    facilityQuestions: questions,
    facilityResponses: buildFacilityResponses(
      questions,
      input.facilityResponseStatus || "pending",
      input.responseEvidence,
    ),
    callAttempts: input.callAttempt
      ? [input.callAttempt]
      : [{
          id: "attempt-1",
          targetId: selectedTargetId,
          targetName: input.body.hospital?.name || "Selected emergency care",
          targetType: "hospital_candidate",
          status: "prepared",
          dialedNumberLabel: input.coordinationPhone ? "response line" : "not available",
          routing: inferRoutingForTarget(input.body, input.coordinationPhone),
        }],
    bystanderGuidance: {
      warning: input.body.triage.warning,
      actions: input.body.triage.actions,
      emergencyServicesInstruction: "If the person is in immediate danger or Pulse cannot confirm handoff, call your local emergency number now.",
    },
    timeline: timelineForSession({
      body: input.body,
      handoffStatus: input.handoffStatus,
      message: input.message,
      callAttempt: input.callAttempt,
    }),
  };
}

function publicHospital(hospital?: HospitalCandidate | null) {
  if (!hospital) return undefined;
  return {
    id: hospital.id,
    name: hospital.name,
    address: hospital.address,
    distanceKm: hospital.distanceKm,
    travelTimeMinutes: hospital.travelTimeMinutes,
    source: hospital.source,
    mapsUrl: hospital.mapsUrl,
    score: hospital.score,
    confidence: hospital.confidence,
    rankingReason: hospital.rankingReason,
  };
}

function publicCoordinationSession(session: CoordinationSession): CoordinationSession {
  return {
    ...session,
    selectedDestination: publicHospital(session.selectedDestination),
    contactTargets: session.contactTargets.map((target) => ({
      id: target.id,
      type: target.type,
      name: target.name,
      status: target.status,
      note: target.note,
    })),
    callAttempts: session.callAttempts.map((attempt) => ({
      id: attempt.id,
      targetId: attempt.targetId,
      targetName: attempt.targetName,
      targetType: attempt.targetType,
      status: attempt.status,
      dialedNumberLabel: attempt.dialedNumberLabel,
      routing: attempt.routing,
    })),
  };
}

function publicMessageStatus(message: OperatorMessageResult) {
  return { status: message.status };
}

function buildOperatorCallScript(body: DispatchRequest, transcript: string, locationLine: string, hospitalName: string) {
  const patientPlace = patientLocationPhrase(body);
  const distanceFromHospital = hospitalDistancePhrase(body);
  return [
    `Hello, this is Pulse. We have an emergency patient ${patientPlace}.`,
    distanceFromHospital,
    body.triage?.dispatchBrief ? `Condition: ${body.triage.dispatchBrief}.` : null,
    `The patient may need ${patientNeed(body.triage)}. We are trying to reach ${hospitalName}.`,
    locationLine,
    `Original report: ${transcript}.`,
    "Can your emergency desk receive this patient now? If yes, please confirm. If not, please say no so we can try another hospital. Thank you.",
  ]
    .filter(Boolean)
    .join(" ");
}

function safeTwilioFailure(errorText: string): Pick<OperatorMessageResult, "code" | "error"> {
  const fallback = {
    code: "twilio_message_failed",
    error: "Message provider rejected the operator brief before the call could start.",
  };

  try {
    const parsed = JSON.parse(errorText) as { code?: number; message?: string };
    if (parsed.code === 21408) {
      return {
        code: "twilio_geo_permission_disabled",
        error: "Message provider rejected this destination country. Enable messaging geo permissions for the operator country, then retry.",
      };
    }

    return {
      code: parsed.code ? `twilio_${parsed.code}` : fallback.code,
      error: parsed.message
        ? parsed.message.replace(/\+\d[\dX]{6,}/g, "[redacted phone]")
        : fallback.error,
    };
  } catch {
    return fallback;
  }
}

function safeTwilioVoiceFailure(errorText: string) {
  const fallback = "Twilio Voice rejected the operator call.";

  try {
    const parsed = JSON.parse(errorText) as { code?: number; message?: string };
    return parsed.message
      ? parsed.message.replace(/\+\d[\dX]{6,}/g, "[redacted phone]")
      : fallback;
  } catch {
    return fallback;
  }
}

function safeVapiFailure(errorText: string) {
  const fallback = "Vapi rejected the operator call request.";

  try {
    const parsed = JSON.parse(errorText) as {
      error?: string | { message?: string; code?: string };
      message?: string;
      code?: string;
    };
    if (typeof parsed.error === "object" && parsed.error?.message) return parsed.error.message;
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.message || parsed.code || fallback;
  } catch {
    return fallback;
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchTwilioMessageStatus(twilio: ReturnType<typeof getTwilioAuth>, sid: string) {
  if (!twilio) return null;
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages/${sid}.json`,
    {
      headers: {
        Authorization: twilio.authorization,
      },
    },
  );
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    sid?: string;
    status?: string;
    error_code?: string | number | null;
    error_message?: string | null;
  } | null;
}

async function waitForTwilioMessageToLeave(twilio: ReturnType<typeof getTwilioAuth>, sid: string) {
  const sentStatuses = new Set(["sent", "delivered"]);
  const failedStatuses = new Set(["failed", "undelivered"]);
  let latestStatus = "queued";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (attempt > 0) await wait(1000);
    const message = await fetchTwilioMessageStatus(twilio, sid);
    latestStatus = message?.status || latestStatus;

    if (sentStatuses.has(latestStatus)) {
      return { ok: true, status: latestStatus };
    }

    if (failedStatuses.has(latestStatus)) {
      return {
        ok: false,
        status: latestStatus,
        error: message?.error_message || `Twilio marked the SMS as ${latestStatus}.`,
      };
    }
  }

  return {
    ok: false,
    status: latestStatus,
    error: `Twilio has not sent the SMS yet. Current status: ${latestStatus}.`,
  };
}

async function sendOperatorWebhook(
  message: string,
  operatorPhone: string,
  body: DispatchRequest,
): Promise<OperatorMessageResult> {
  const webhookUrl = process.env.PULSE_MESSAGE_WEBHOOK_URL;
  if (!webhookUrl) {
    return { status: "not_configured", provider: "none" };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.PULSE_MESSAGE_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.PULSE_MESSAGE_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        type: "pulse_incident_brief",
        operatorPhone,
        message,
        gps: body.incidentLocation
          ? {
              label: body.incidentLocation.label,
              latitude: body.incidentLocation.latitude,
              longitude: body.incidentLocation.longitude,
              accuracy: body.incidentLocation.accuracy,
              mapsUrl: buildMapsUrl(body.incidentLocation),
            }
          : null,
        triage: body.triage,
        hospital: body.hospital,
        hospitals: body.hospitals?.slice(0, 5) || [],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { status: "failed", provider: "webhook", error: errorText.slice(0, 300) };
    }

    const data = (await response.json().catch(() => null)) as { id?: string; messageId?: string } | null;
    return { status: "sent", provider: "webhook", id: data?.id || data?.messageId };
  } catch (error) {
    return {
      status: "failed",
      provider: "webhook",
      error: error instanceof Error ? error.message : "Message webhook failed",
    };
  }
}

async function sendOperatorMessage(
  message: string,
  operatorPhone: string,
  body: DispatchRequest,
): Promise<OperatorMessageResult> {
  const twilio = getTwilioAuth("message");

  if (!twilio) {
    return sendOperatorWebhook(message, operatorPhone, body);
  }

  const twilioBody = new URLSearchParams({
    To: operatorPhone,
    From: twilio.fromNumber,
    Body: message.slice(0, 1500),
  });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: twilio.authorization,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: twilioBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { status: "failed", provider: "twilio", ...safeTwilioFailure(errorText) };
  }

  const data = (await response.json()) as { sid?: string; status?: string };
  if (!data.sid) {
    return {
      status: "failed",
      provider: "twilio",
      providerStatus: data.status,
      error: "Twilio accepted the request but did not return a message id.",
    };
  }

  const delivery = await waitForTwilioMessageToLeave(twilio, data.sid);
  if (!delivery.ok) {
    return {
      status: "failed",
      provider: "twilio",
      id: data.sid,
      providerStatus: delivery.status,
      error: delivery.error,
    };
  }

  return { status: "sent", provider: "twilio", id: data.sid, providerStatus: delivery.status };
}

async function placeTwilioOperatorCall(
  operatorPhone: string,
  callScript: string,
): Promise<OperatorCallResult> {
  const twilio = getTwilioAuth();

  if (!twilio) {
    return { status: "failed", provider: "twilio", error: "Twilio Voice is not configured" };
  }

  const twiml = [
    "<Response>",
    "<Pause length=\"1\"/>",
    `<Say voice=\"alice\">${escapeXml(callScript.slice(0, 1800))}</Say>`,
    "</Response>",
  ].join("");
  const twilioBody = new URLSearchParams({
    To: operatorPhone,
    From: twilio.fromNumber,
    Twiml: twiml,
    Timeout: String(getVapiRingTimeoutSeconds()),
  });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: twilio.authorization,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: twilioBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { status: "failed", provider: "twilio", error: safeTwilioVoiceFailure(errorText) };
  }

  const data = (await response.json()) as { sid?: string; status?: OperatorCallResult["status"] };
  return { callId: data.sid, status: data.status || "queued", provider: "twilio" };
}

async function placeVapiOperatorCall(
  operatorPhone: string,
  phoneNumberId: string,
  apiKey: string,
  firstMessage: string,
  systemPrompt: string,
): Promise<OperatorCallResult> {
  const assistantId = process.env.PULSE_VAPI_ASSISTANT_ID;
  const useSavedAssistant = Boolean(assistantId && process.env.PULSE_VAPI_USE_SAVED_ASSISTANT === "true");
  const transportConfigurations = [
    {
      provider: "twilio",
      timeout: getVapiRingTimeoutSeconds(),
      record: false,
      recordingChannels: "mono",
    },
  ];
  const assistant = useSavedAssistant
    ? {
        assistantId,
        assistantOverrides: {
          firstMessage,
          maxDurationSeconds: getVapiMaxDurationSeconds(),
          transportConfigurations,
          variableValues: {
            pulseIncidentBrief: systemPrompt,
          },
        },
      }
    : {
        assistant: {
          name: "Pulse Dispatch",
          firstMessage,
          firstMessageMode: "assistant-speaks-first",
          model: {
            provider: "openai",
            model: process.env.PULSE_VAPI_MODEL || "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }],
            temperature: 0.2,
          },
          voice: {
            provider: "vapi",
            voiceId: process.env.PULSE_VAPI_VOICE_ID || "Elliot",
          },
          maxDurationSeconds: getVapiMaxDurationSeconds(),
          transportConfigurations,
          recordingEnabled: true,
          endCallMessage: "Pulse Emergency Dispatch ending the call now. Thank you.",
        },
      };

  const response = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumberId,
      customer: {
        number: operatorPhone,
        numberE164CheckEnabled: true,
      },
      ...assistant,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      status: "failed",
      provider: "vapi",
      diagnosticCode: "vapi_create_call_failed",
      error: safeVapiFailure(errorText),
    };
  }

  const call = (await response.json()) as {
    id?: string;
    status?: OperatorCallResult["status"];
  };

  return { callId: call.id, status: call.status || "queued", provider: "vapi" };
}

function hasUsableIncidentCoordinates(location: DispatchRequest["incidentLocation"]) {
  return (
    location?.latitude != null &&
    location.longitude != null &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

async function verifiedHospitalPackage(request: NextRequest, body: DispatchRequest) {
  if (!hasUsableIncidentCoordinates(body.incidentLocation)) {
    throw new Error("GPS location is required before dispatch.");
  }

  const url = new URL("/api/hospitals", request.nextUrl.origin);
  url.searchParams.set("lat", String(body.incidentLocation?.latitude));
  url.searchParams.set("lng", String(body.incidentLocation?.longitude));

  const response = await fetch(url.toString());
  const data = (await response.json().catch(() => null)) as {
    incidentLocation?: DispatchRequest["incidentLocation"];
    hospitals?: HospitalCandidate[];
    source?: "google_places" | "unavailable";
    error?: string;
  } | null;

  if (!response.ok || data?.source !== "google_places" || !data.hospitals?.[0]) {
    throw new Error(data?.error || "Verified Google hospital search failed.");
  }

  const selectedHospital = data.hospitals.find((hospital) => hospital.id === body.selectedFacilityId);
  if (!selectedHospital) {
    throw new Error("The approved facility is no longer present in verified search results.");
  }

  return {
    ...body,
    incidentLocation: {
      ...body.incidentLocation,
      ...data.incidentLocation,
      label: data.incidentLocation?.label || body.incidentLocation?.label || "Current GPS location",
      accuracy: body.incidentLocation?.accuracy,
    },
    hospital: selectedHospital,
    hospitals: data.hospitals,
  } satisfies DispatchRequest;
}

export async function POST(request: NextRequest) {
  const requestLimit = await rateLimit(request, { name: "dispatch-call", limit: 3, windowMs: 10 * 60_000 });
  if (requestLimit) return requestLimit;

  const requestBody = (await request.json()) as DispatchRequest;
  const transcript = requestBody.transcript?.trim();
  const triage = requestBody.triage;

  if (!transcript || !triage) {
    return NextResponse.json({ error: "Transcript and triage are required" }, { status: 400 });
  }

  const clientKey = getClientKey(request);
  if (!verifyApprovedDispatchSession(requestBody.dispatchSessionToken, {
    clientKey,
    report: transcript,
    runId: requestBody.agentRunId,
    planId: requestBody.planId,
    planHash: requestBody.planHash,
    facilityId: requestBody.selectedFacilityId,
  })) {
    return NextResponse.json({ error: "Pulse needs a fresh human-approved Qwen plan before calling for help." }, { status: 403 });
  }

  if (!requestBody.messageAlreadySent) {
    const cooldown = checkDispatchCooldown(clientKey);
    if (!cooldown.ok) {
      return NextResponse.json(
        {
          error: "Pulse is already processing a help request from this browser.",
          retryAfterSeconds: cooldown.retryAfterSeconds,
        },
        { status: 429 },
      );
    }
  }

  let body: DispatchRequest & { triage: TriageResult };
  try {
    body = {
      ...(await verifiedHospitalPackage(request, requestBody)),
      triage: serverVerifiedTriage(triage, transcript),
    };
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Verified Google hospital search failed." },
      { status: 502 },
    );
  }

  const dispatchMode = getDispatchMode();
  const callProvider = getCallProvider();
  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const operatorPhone = getOperatorPhone();

  const hospitalName = body.hospital?.name || "your emergency desk";
  const locationLabel = readableScene(body);
  const hospitalPhoneLine = body.hospital?.phone
    ? `Internal note: listed hospital phone from search data is ${body.hospital.phone}.`
    : "Internal note: search data did not return a hospital phone number.";
  const mapsLink = buildMapsUrl(body.incidentLocation);
  const patientPlace = patientLocationPhrase(body);
  const distanceFromHospital = hospitalDistancePhrase(body);
  const locationLine = [
    `Scene: ${locationLabel}.`,
    mapsLink ? `A map link was shared by message: ${mapsLink}.` : null,
  ].filter(Boolean).join(" ");

  const firstMessage =
    [
      `Hello, this is Pulse. We have an emergency patient ${patientPlace}.`,
      distanceFromHospital,
      `Condition: ${body.triage.dispatchBrief}.`,
      "We sent the location by message.",
      "Can your emergency desk receive this patient now?",
    ].filter(Boolean).join(" ");

  const systemPrompt = [
    "You are Pulse calling a hospital or emergency desk with a short emergency handoff.",
    "Sound calm, direct, and human. Do not sound like a system.",
    "Do not claim ambulance dispatch, government EMS dispatch, or hospital acceptance unless the receiver explicitly confirms it.",
    "Do not claim to be government emergency services.",
    "Keep the conversation short, natural, and under 45 seconds.",
    "Ask exactly one question at a time, then wait for the receiver's answer.",
    "Do not repeat words such as 'can can' or 'or or'.",
    "Do not mention the bystander unless the receiver asks who reported the emergency.",
    "Never say these words to the receiver: sequential, candidate, coordination, handoff, triage, ranking, coordinates, demo, hackathon, configured line, API, Vapi, automated.",
    `Hospital or emergency desk being called: ${hospitalName}.`,
    body.hospital?.address ? `Internal address context: ${body.hospital.address}.` : null,
    body.hospital?.distanceKm != null ? `Internal distance context: ${body.hospital.distanceKm} kilometers from the scene.` : null,
    hospitalPhoneLine,
    `Plain emergency summary: ${body.triage.dispatchBrief}.`,
    `Likely care needed: ${patientNeed(body.triage)}.`,
    `Bystander report: ${transcript}.`,
    locationLine,
    `The bystander has already been told: ${body.triage.warning}.`,
    "Use the location as a normal place. Do not explain how the location was found.",
    "Call flow:",
    "1. Opening statement has already been spoken. Wait for the receiver to answer.",
    `2. If they need the details repeated, say: Emergency patient ${patientPlace}. ${distanceFromHospital || ""} Condition: ${body.triage.dispatchBrief}. Location was sent by message.`,
    "3. Ask only: Can your emergency desk receive this patient now?",
    "4. If they say yes, say: Thank you, confirmed. Then end politely.",
    "5. If they say no or sound unsure, say: Understood, thank you. We will try another nearby hospital. Then end politely.",
    "Never say that Pulse itself is sending an ambulance.",
    "Do not provide complex medical instructions.",
  ].filter(Boolean).join("\n");

  const incidentMessage = buildIncidentMessage(body, transcript);
  const operatorMessage: OperatorMessageResult = body.messageAlreadySent
    ? { status: "sent", provider: "none", id: "already-sent" }
    : operatorPhone
      ? await sendOperatorMessage(incidentMessage, operatorPhone, body)
      : { status: "not_configured", provider: "none" };

  if (dispatchMode === "dry_run") {
    const coordinationSession = buildCoordinationSession({
      body,
      coordinationPhone: operatorPhone,
      message: operatorMessage,
      handoffStatus: "brief_sent",
      facilityResponseStatus: "pending",
    });

    return NextResponse.json({
      status: "ended",
      verificationOnly: true,
      operatorMessage: publicMessageStatus(operatorMessage),
      coordinationSession: publicCoordinationSession(coordinationSession),
      handoffStatus: coordinationSession.handoffStatus,
      selectedDestination: publicHospital(coordinationSession.selectedDestination),
      summary:
        `Coordination package prepared for ${hospitalName}. No outbound call was placed because local verification mode is enabled.`,
    });
  }

  if (callProvider === "twilio" && requiresInteractiveCall()) {
    return NextResponse.json(
      {
        error: "Pulse needs an interactive call setup before it can place live help calls.",
      },
      { status: 500 },
    );
  }

  if (!operatorPhone || (callProvider === "vapi" && (!apiKey || !phoneNumberId))) {
    return NextResponse.json({ error: "Pulse could not start the help call." }, { status: 500 });
  }

  if (operatorMessage.status !== "sent") {
    return NextResponse.json(
	      {
	        error:
	          operatorMessage.status === "not_configured"
	            ? "Pulse could not share the incident brief yet."
	            : "Pulse could not send the incident brief.",
	        operatorMessage: publicMessageStatus(operatorMessage),
	      },
      { status: 500 },
    );
  }

  const operatorCall =
    callProvider === "twilio"
      ? await placeTwilioOperatorCall(
          operatorPhone,
          buildOperatorCallScript(body, transcript, locationLine, hospitalName),
        )
      : await placeVapiOperatorCall(operatorPhone, phoneNumberId as string, apiKey as string, firstMessage, systemPrompt);

  if (operatorCall.status === "failed" || !operatorCall.callId) {
    const coordinationSession = buildCoordinationSession({
      body,
      coordinationPhone: operatorPhone,
      message: operatorMessage,
      handoffStatus: "failed",
      callAttempt: {
        id: "attempt-1",
        targetId: "hospital-1",
        targetName: hospitalName,
        targetType: "hospital_candidate",
        status: "failed",
        callId: operatorCall.callId,
        callProvider: operatorCall.provider,
        dialedNumberLabel: "response line",
        routing: inferRoutingForTarget(body, operatorPhone),
      },
      facilityResponseStatus: "unknown",
      responseEvidence: operatorCall.error,
    });

    return NextResponse.json(
      {
        error: "Pulse could not complete the help call.",
        coordinationSession: publicCoordinationSession(coordinationSession),
        handoffStatus: coordinationSession.handoffStatus,
      },
      { status: 502 },
    );
  }

  const callAttempt: CoordinationCallAttempt = {
    id: "attempt-1",
    targetId: "hospital-1",
    targetName: hospitalName,
    targetType: "hospital_candidate",
    status: operatorCall.status,
    callId: operatorCall.callId,
    callProvider: operatorCall.provider,
    dialedNumberLabel: "response line",
    routing: inferRoutingForTarget(body, operatorPhone),
  };
  const coordinationSession = buildCoordinationSession({
    body,
    coordinationPhone: operatorPhone,
    message: operatorMessage,
    handoffStatus: operatorCall.status === "in-progress" ? "connected" : "calling",
    callAttempt,
    facilityResponseStatus: "pending",
  });
  const statusToken = issueStatusToken({ callId: operatorCall.callId, clientKey });
  if (!statusToken) {
    return NextResponse.json({ error: "Pulse could not prepare secure status tracking." }, { status: 500 });
  }

  return NextResponse.json({
    status: operatorCall.status,
    statusToken,
    selectedDestination: publicHospital(body.hospital),
    operatorMessage: publicMessageStatus(operatorMessage),
    coordinationSession: publicCoordinationSession(coordinationSession),
    handoffStatus: coordinationSession.handoffStatus,
  });
}
