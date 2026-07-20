"use client";

import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Ambulance,
  CheckCircle2,
  Clock3,
  Eye,
  Hand,
  HeartPulse,
  Hospital,
  Image as ImageIcon,
  Loader2,
  Lock,
  MapPin,
  Mic,
  Navigation,
  PhoneCall,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Siren,
} from "lucide-react";
import { QwenCoordinatingScreen, QwenPlanApprovalScreen } from "@/components/qwen-agent-panels";
import type { AgentRunResult } from "@/lib/agent-types";

type AppStep = "start" | "listen" | "confirm" | "coordinating" | "approve" | "sending" | "done";
type LocationState = "idle" | "locking" | "locked" | "unavailable";
type SpeechState = "idle" | "connecting" | "listening" | "processing" | "unsupported" | "error";
type MicState = "idle" | "requesting" | "granted" | "denied" | "unavailable";
type SendPhase = "idle" | "sharing_location" | "preparing_brief" | "finding_care" | "sending_brief" | "calling_help" | "done" | "failed";

type RealtimeTranscriptEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
};

type TriageResult = {
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
  source: "openai" | "local_fallback" | "qwen";
};

type InfographicResult = {
  status: "idle" | "loading" | "generated" | "fallback";
  imageDataUrl?: string;
  altText: string;
  caption: string;
  source?: "openai" | "fallback";
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

type DispatchCall = {
  statusToken?: string;
  status: "idle" | "starting" | "queued" | "ringing" | "in-progress" | "ended" | "failed";
  attempt?: number;
  verificationOnly?: boolean;
  selectedDestination?: HospitalCandidate;
  hospitalName?: string;
  hospitalIndex?: number;
  handoffStatus?: CoordinationHandoffStatus;
  coordinationSession?: CoordinationSession;
  facilityResponses?: FacilityResponse[];
  transcript?: string;
  summary?: string;
  diagnosticCode?: string;
  endedReason?: string;
  messageAlreadySent?: boolean;
  error?: string;
  operatorMessage?: {
    status: "sent" | "not_configured" | "failed";
    provider?: "twilio" | "webhook" | "none";
    id?: string;
    code?: string;
    error?: string;
  };
};

type IncidentLocation = {
  label: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  source: "gps";
};

type HospitalCandidate = {
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
  availabilityStatus?: "unknown_until_confirmed";
};

type CoordinationCallAttempt = {
  id: string;
  targetId: string;
  targetName: string;
  targetType: ContactTarget["type"];
  status: DispatchCall["status"] | "prepared";
  callId?: string;
  callProvider?: "vapi" | "twilio";
  dialedNumberLabel: string;
  routing: "response_line" | "direct_hospital_phone" | "configured_demo_line";
};

type CoordinationSession = {
  id: string;
  mode: "guided_response" | "sequential_demo";
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

const initialReport = "";

const statusSteps: Array<{ phase: SendPhase; label: string }> = [
  { phase: "sharing_location", label: "Sharing your location" },
  { phase: "preparing_brief", label: "Understanding what happened" },
  { phase: "finding_care", label: "Finding nearby help" },
  { phase: "sending_brief", label: "Sharing the details" },
  { phase: "calling_help", label: "Calling for help" },
];

const MAX_LOCATION_ACCURACY_METERS = 3000;

function formatLocationLabel(location: IncidentLocation) {
  if (location.label && !/^current gps location$/i.test(location.label)) return location.label;
  if (location.accuracy && Number.isFinite(location.accuracy)) {
    return `Location locked within about ${Math.round(location.accuracy)} meters`;
  }
  return "Location locked";
}

function getLocationUrl(location: IncidentLocation | null) {
  if (!location) return "";
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
}

function describeLocationError(error: unknown) {
  if (error instanceof Error && error.message === "LOCATION_TOO_BROAD") {
    return "Your location is too broad right now. Turn on precise location or try from your phone so Pulse calls the right nearby hospital.";
  }

  if (typeof error === "object" && error && "code" in error) {
    const code = Number((error as { code?: number }).code);
    if (code === 1) return "Location is needed to send help to the right place.";
    if (code === 2) return "Your browser could not find your location. Check device location settings and try again.";
    if (code === 3) return "Location lookup timed out. Move near a window or enable precise location, then try again.";
  }

  return "Location is needed to send help to the right place.";
}

function requestCurrentLocation() {
  return new Promise<IncidentLocation>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (
          Number.isFinite(position.coords.accuracy) &&
          position.coords.accuracy > MAX_LOCATION_ACCURACY_METERS
        ) {
          reject(new Error("LOCATION_TOO_BROAD"));
          return;
        }

        resolve({
          label: "Current GPS location",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          source: "gps",
        });
      },
      reject,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 12000,
      },
    );
  });
}

function analyzeReport(report: string): TriageResult {
  const text = report.toLowerCase();
  const hasBleeding = /bleed|blood|khoon|cut|wound/.test(text);
  const hasFracture = /broken|fracture|leg|bone|twisted/.test(text);
  const beingMoved = /move|moving|lift|lifting|carry|carrying/.test(text);
  const breathingRisk = /not breathing|unconscious|collapsed|pulse/.test(text);
  const cardiacRisk = /chest|heart|cardiac/.test(text);

  if (breathingRisk || cardiacRisk) {
    return {
      title: "Critical medical emergency detected",
      emergencyType: breathingRisk ? "CARDIAC_ARREST" : "RESPIRATORY_DISTRESS",
      severity: "critical",
      hospitalType: "Emergency department required",
      signals: [
        breathingRisk ? "Breathing or consciousness risk" : "Chest pain or cardiac risk",
        hasBleeding ? "Active bleeding" : "Continuous monitoring required",
        "Immediate responder coordination required",
        "Emergency-ready facility required",
      ],
      warning: breathingRisk
        ? "Check breathing. If not breathing normally, begin hands-only CPR if trained and able."
        : "Keep the person still and monitor breathing until responders arrive.",
      actions: breathingRisk
        ? ["Check breathing", "Begin hands-only CPR if needed", "Keep airway clear", "Stay with the person"]
        : ["Keep the person still", "Monitor breathing", "Keep them awake", "Clear space for responders"],
      situationSummary: breathingRisk
        ? "The person may not be breathing normally. Stay close and act calmly."
        : "The person may be having serious breathing or chest symptoms. Keep them still and watch them closely.",
      doNow: breathingRisk
        ? ["Check breathing", "Keep the airway clear", "Start hands-only CPR if needed", "Stay with the person"]
        : ["Keep the person still", "Watch breathing", "Keep them awake", "Clear space around them"],
      doNotDo: [
        "Do not give food or drink",
        "Do not crowd around them",
        "Do not let them walk around",
      ],
      watchFor: [
        "Breathing changes",
        "Fainting or confusion",
        "Chest pain getting worse",
      ],
      infographicBrief: breathingRisk
        ? "Show a calm bystander checking breathing, keeping the airway clear, and starting hands-only CPR only if the person is not breathing normally."
        : "Show a calm bystander keeping a person still, watching breathing, keeping them awake, and clearing space.",
      dispatchBrief:
        "Critical medical emergency reported by bystander. Patient may have breathing, consciousness, or cardiac risk. Immediate emergency department coordination required.",
      source: "local_fallback",
    };
  }

  return {
    title: "Major trauma detected",
    emergencyType: "MAJOR_TRAUMA",
    severity: "high",
    hospitalType: "Trauma-capable emergency care required",
    signals: [
      hasFracture ? "Possible fracture" : "Impact injury reported",
      hasBleeding ? "Active bleeding" : "Bleeding status unknown",
      beingMoved ? "Patient is being moved" : "Movement risk needs control",
      "Trauma-capable emergency care required",
    ],
    warning: "Do not move the person unless there is immediate danger.",
    actions: [
      "Keep them still",
      hasBleeding ? "Press firmly on bleeding" : "Check for bleeding",
      "Keep them awake",
      "Watch breathing",
    ],
    situationSummary: "The person may have a serious injury. Keep them still and make the area safe.",
    doNow: [
      "Keep them still",
      hasBleeding ? "Press firmly on bleeding" : "Check for bleeding",
      "Keep people back",
      "Watch breathing",
    ],
    doNotDo: [
      "Do not move them unless there is danger",
      "Do not give food or drink",
      "Do not crowd around them",
    ],
    watchFor: [
      "Breathing changes",
      "Heavy bleeding",
      "Confusion or fainting",
    ],
    infographicBrief:
      "Show a calm bystander keeping an injured person still, pressing cloth on bleeding if needed, clearing space, and watching breathing. Non-graphic.",
    dispatchBrief:
      "Major trauma reported by bystander. Possible fracture, bleeding status requires attention, and patient movement must be controlled. Trauma-capable emergency care required.",
    source: "local_fallback",
  };
}

function phaseIndex(phase: SendPhase) {
  if (phase === "done") return statusSteps.length;
  if (phase === "failed") return -1;
  const index = statusSteps.findIndex((step) => step.phase === phase);
  return index >= 0 ? index : -1;
}

function getHelpStatus(dispatchCall: DispatchCall, sendPhase: SendPhase) {
  const handoffStatus = dispatchCall.handoffStatus || dispatchCall.coordinationSession?.handoffStatus;

  if (handoffStatus === "failed" || dispatchCall.status === "failed" || sendPhase === "failed") {
    return {
      title: "Pulse could not confirm help.",
      detail: dispatchCall.error || "Pulse could not confirm that help accepted this case. Call local emergency services now.",
      tone: "danger" as const,
    };
  }

  if (dispatchCall.verificationOnly) {
    return {
      title: "The details are ready.",
      detail: "No call was placed in this run. Use your location and the steps on this screen.",
      tone: "warning" as const,
    };
  }

  if (handoffStatus === "accepted") {
    return {
      title: "Help is ready to receive them.",
      detail: "Pulse heard a clear yes from the care team. Keep following the steps until responders or transport arrive.",
      tone: "success" as const,
    };
  }

  if (handoffStatus === "not_confirmed" || dispatchCall.status === "ended" || sendPhase === "done") {
    return {
      title: "Help was not confirmed.",
      detail: "Pulse finished the call but did not get a clear yes. Call local emergency services now and continue the steps below.",
      tone: "danger" as const,
    };
  }

  if (handoffStatus === "connected" || ["starting", "queued", "ringing", "in-progress"].includes(dispatchCall.status)) {
    return {
      title: handoffStatus === "connected" ? "Pulse is talking to help." : "Pulse is calling for help.",
      detail: "Pulse has shared what happened and is asking if they can receive the person. Keep this screen open.",
      tone: "warning" as const,
    };
  }

  return {
    title: "Pulse is getting help ready.",
    detail: "Pulse is sharing your location and what happened.",
    tone: "warning" as const,
  };
}

const INTERNAL_PROGRESS_TEXT = /\b(api|candidate|configured|confidence|coordination|demo|google places|operator|provider|readiness|score|sequential|timeline|triage)\b|\bgps\b/i;

function sanitizeProgressText(value: string, fallback: string) {
  return INTERNAL_PROGRESS_TEXT.test(value) ? fallback : value;
}

function publicProgressItem(item: CoordinationTimelineItem, handoffStatus?: CoordinationHandoffStatus, sendPhase?: SendPhase, error?: string): CoordinationTimelineItem {
  if (item.id === "guidance") {
    return {
      ...item,
      label: "Steps shown",
      detail: "Keep following the safety steps on this screen.",
    };
  }

  if (item.id === "destination") {
    return {
      ...item,
      label: "Nearby care found",
      detail: sanitizeProgressText(item.detail, "Pulse found nearby emergency care."),
    };
  }

  if (item.id === "brief") {
    return {
      ...item,
      label: "Details shared",
      detail: "Your location and report were shared.",
    };
  }

  if (item.id !== "facility-call") {
    return {
      ...item,
      label: sanitizeProgressText(item.label, "Progress updated"),
      detail: sanitizeProgressText(item.detail, "Pulse updated the help request."),
    };
  }

  if (handoffStatus === "accepted") {
    return {
      ...item,
      label: "Help is ready",
      detail: "The care team said they can receive the person.",
      state: "done",
    };
  }

  if (handoffStatus === "not_confirmed") {
    return {
      ...item,
      label: "Help not confirmed",
      detail: "The call ended without a clear yes. Call local emergency services now.",
      state: "attention",
    };
  }

  if (handoffStatus === "failed" || sendPhase === "failed") {
    return {
      ...item,
      label: "Call did not complete",
      detail: error || "Pulse could not complete the call. Call local emergency services now.",
      state: "attention",
    };
  }

  return {
    ...item,
    label: "Calling for help",
    detail: "Pulse is asking whether they can receive the person.",
  };
}

function getCoordinationTimeline(dispatchCall: DispatchCall, sendPhase: SendPhase): CoordinationTimelineItem[] {
  const session = dispatchCall.coordinationSession;
  const handoffStatus = dispatchCall.handoffStatus || session?.handoffStatus;
  const sessionTimeline = session?.timeline || [];

  if (sessionTimeline.length > 0) {
    return sessionTimeline.map((item) => publicProgressItem(item, handoffStatus, sendPhase, dispatchCall.error));
  }

  const messageStatus = dispatchCall.operatorMessage?.status;
  const messageReady =
    messageStatus === "sent" ||
    dispatchCall.messageAlreadySent ||
    dispatchCall.status === "queued" ||
    dispatchCall.status === "ringing" ||
    dispatchCall.status === "in-progress" ||
    dispatchCall.status === "ended";
  const callActive = dispatchCall.status === "queued" || dispatchCall.status === "ringing" || dispatchCall.status === "in-progress";
  const accepted = handoffStatus === "accepted";
  const notConfirmed = handoffStatus === "not_confirmed" || dispatchCall.status === "ended" || sendPhase === "done";
  const failed = dispatchCall.status === "failed" || sendPhase === "failed";

  return [
    {
      title: "Location and report",
      detail: "Shared with the details Pulse sends.",
      state: "done",
    },
    {
      title: "Nearby care",
      detail: dispatchCall.hospitalName || "Nearby care selected.",
      state: failed && !dispatchCall.hospitalName ? "attention" : "done",
    },
    {
      title: "Message sent",
      detail: messageReady ? "Map and details were shared." : "Waiting to share the details.",
      state: messageReady ? "done" : failed ? "attention" : "active",
    },
    {
      id: "facility-call",
      label: accepted ? "Help is ready" : notConfirmed ? "Help not confirmed" : "Calling for help",
      title: accepted ? "Help is ready" : notConfirmed ? "Help not confirmed" : "Calling for help",
      detail: accepted
        ? "The care team said they can receive the person."
        : notConfirmed
          ? "The call ended without a clear yes."
        : callActive
          ? "Pulse is asking if they can receive the person."
          : failed
            ? "Call did not complete."
            : "Call is starting.",
      state: accepted ? "done" : notConfirmed || failed ? "attention" : "active",
    },
  ].map((item, index) => ({
    id: "id" in item ? item.id : `fallback-${index}`,
    label: "label" in item ? item.label : item.title,
    detail: item.detail,
    state: item.state,
  })) as CoordinationTimelineItem[];
}

export default function Home() {
  const [step, setStep] = useState<AppStep>("start");
  const [report, setReport] = useState(initialReport);
  const [submittedReport, setSubmittedReport] = useState("");
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [dispatchCall, setDispatchCall] = useState<DispatchCall>({ status: "idle" });
  const [agentRun, setAgentRun] = useState<AgentRunResult | null>(null);
  const [selectedFacilityId, setSelectedFacilityId] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [incidentLocation, setIncidentLocation] = useState<IncidentLocation | null>(null);
  const [hospitals, setHospitals] = useState<HospitalCandidate[]>([]);
  const [locationState, setLocationState] = useState<LocationState>("idle");
  const [locationError, setLocationError] = useState("");
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  const [micState, setMicState] = useState<MicState>("idle");
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [audioLevels, setAudioLevels] = useState([18, 34, 52, 38, 24]);
  const [silenceNotice, setSilenceNotice] = useState("");
  const [transcriptSource, setTranscriptSource] = useState<"live" | "final" | "typed">("typed");
  const [guidanceImage, setGuidanceImage] = useState<InfographicResult>({
    status: "idle",
    altText: "Simple emergency guidance with calm steps for the bystander.",
    caption: "",
  });
  const reportRef = useRef<HTMLTextAreaElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const committedSpeechRef = useRef("");
  const interimSpeechRef = useRef("");
  const shouldListenRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioMeterFrameRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const realtimeReconnectsRef = useRef(0);

  const fallbackTriage = useMemo(() => analyzeReport(submittedReport || report), [report, submittedReport]);
  const triage = triageResult ?? fallbackTriage;

  useEffect(() => {
    if (step === "listen") {
      window.setTimeout(() => reportRef.current?.focus(), 100);
    }
  }, [step]);

  async function startPulse() {
    if (locationState === "locking") return;

    setStep("start");
    setReport("");
    setSubmittedReport("");
    setTriageResult(null);
    setDispatchCall({ status: "idle" });
    setAgentRun(null);
    setSelectedFacilityId("");
    setOverrideReason("");
    setHospitals([]);
    setSendPhase("idle");
    setSilenceNotice("");
    setTranscriptSource("typed");
    setGuidanceImage({
      status: "idle",
      altText: "Simple emergency guidance with calm steps for the bystander.",
      caption: "",
    });
    committedSpeechRef.current = "";
    interimSpeechRef.current = "";
    realtimeReconnectsRef.current = 0;
    setLocationError("");
    setIncidentLocation(null);
    setLocationState("locking");

    try {
      const location = await requestCurrentLocation();
      setIncidentLocation(location);
      setLocationState("locked");
      setStep("listen");
    } catch (error) {
      setLocationState("unavailable");
      setLocationError(describeLocationError(error));
      setStep("start");
      return;
    }

    await startSpeechCapture();
  }

  async function prepareReportConfirmation(value = report) {
    const fallback = value.trim();
    if (fallback.length < 12) return;

    shouldListenRef.current = false;
    setSpeechState("processing");
    const audioBlob = await stopMediaRecording();
    stopRealtimeConnection();
    stopAudioMeter();
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    try {
      const formData = new FormData();
      if (audioBlob) {
        formData.set("audio", audioBlob, "pulse-report.webm");
      }
      formData.set("fallbackText", fallback);
      const response = await fetch("/api/speech/finalize", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json().catch(() => null)) as {
        text?: string;
        source?: "openai" | "realtime_fallback";
      } | null;
      const finalText = data?.text?.trim() || fallback;
      setReport(finalText);
      setTranscriptSource(data?.source === "openai" ? "final" : "live");
    } catch {
      setTranscriptSource("live");
      setReport(fallback);
    }

    setSpeechState("idle");
    setSilenceNotice("");
    setStep("confirm");
  }

  async function submitCapturedReport(value = report) {
    const cleaned = value.trim();
    if (cleaned.length < 12) return;
    if (!incidentLocation) {
      setLocationError("Location is needed before Qwen can search nearby care.");
      setStep("start");
      return;
    }
    shouldListenRef.current = false;
    setSpeechState("processing");
    stopRealtimeCapture();
    setSubmittedReport(cleaned);
    const immediateGuidance = analyzeReport(cleaned);
    setTriageResult(immediateGuidance);
    setDispatchCall({ status: "idle" });
    setAgentRun(null);
    setSelectedFacilityId("");
    setOverrideReason("");
    setHospitals([]);
    setStep("coordinating");
    setSendPhase("preparing_brief");
    loadGuidanceImage(cleaned, immediateGuidance);

    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report: cleaned,
          location: {
            latitude: incidentLocation.latitude,
            longitude: incidentLocation.longitude,
            accuracyMeters: incidentLocation.accuracy,
          },
          mode: "live",
        }),
      });
      const payload = (await response.json().catch(() => null)) as (AgentRunResult & { error?: string }) | null;
      if (!response.ok || !payload?.agentReceipt || !payload.plan?.selectedFacilityId) {
        throw new Error(payload?.error || "Qwen coordination could not be completed.");
      }
      const chosenHospital = payload.facilities.find((facility) => facility.id === payload.plan.selectedFacilityId);
      if (!chosenHospital) throw new Error("Qwen returned a plan without sourced facility evidence.");

      setAgentRun(payload);
      setTriageResult(payload.protocol);
      setHospitals(payload.facilities);
      setSelectedFacilityId(chosenHospital.id);
      setSpeechState("idle");
      setSendPhase("finding_care");
      setStep("approve");
    } catch (error) {
      setSpeechState("idle");
      setSendPhase("failed");
      setStep("done");
      setDispatchCall({
        status: "failed",
        error: `${error instanceof Error ? error.message : "Qwen coordination failed."} Deterministic safety guidance is shown; no call was placed.`,
      });
    }
  }

  async function loadGuidanceImage(transcript: string, triageForImage: TriageResult) {
    setGuidanceImage({
      status: "loading",
      altText: triageForImage.situationSummary,
      caption: "Making a simple visual guide for you.",
      source: "fallback",
    });

    try {
      const response = await fetch("/api/guidance/infographic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          triage: triageForImage,
          incidentLocation,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        status?: "generated" | "fallback";
        imageDataUrl?: string;
        altText?: string;
        caption?: string;
        source?: "openai" | "fallback";
      } | null;

      setGuidanceImage({
        status: data?.status || "fallback",
        imageDataUrl: data?.imageDataUrl,
        altText: data?.altText || triageForImage.situationSummary,
        caption: data?.caption || "Follow the simple steps below.",
        source: data?.source || "fallback",
      });
    } catch {
      setGuidanceImage({
        status: "fallback",
        altText: triageForImage.situationSummary,
        caption: "Follow the simple steps below.",
        source: "fallback",
      });
    }
  }

  async function createDispatchSessionToken(
    reportForToken: string,
    run: AgentRunResult,
    facilityId: string,
    reason: string,
  ) {
    const isOverride = facilityId !== run.plan.selectedFacilityId;
    const response = await fetch("/api/dispatch/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: reportForToken,
        agentRunId: run.runId,
        planId: run.plan.id,
        planHash: run.plan.planHash,
        selectedFacilityId: facilityId,
        agentReceipt: run.agentReceipt,
        explicitApproval: true,
        decision: isOverride ? "override" : "approve",
        overrideReason: isOverride ? reason.trim() : undefined,
      }),
    });
    const data = (await response.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!response.ok || !data?.token) {
      throw new Error(data?.error || "Pulse could not record the approval. Try again.");
    }
    return data.token;
  }

  async function startDispatchCall(
    transcript: string,
    triageForCall: TriageResult,
    run: AgentRunResult,
    hospital: HospitalCandidate,
    readableLocation: IncidentLocation,
    hospitalIndex: number,
    reason: string,
  ) {
    const attempt = 1;
    const messageAlreadySent = dispatchCall.operatorMessage?.status === "sent";
    setStep("sending");
    setSendPhase("sending_brief");
    setDispatchCall({
      status: "starting",
      attempt,
      hospitalName: hospital.name,
      hospitalIndex,
      messageAlreadySent,
    });

    try {
      const dispatchSessionToken = await createDispatchSessionToken(transcript, run, hospital.id, reason);
      const response = await fetch("/api/dispatch/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          triage: triageForCall,
          incidentLocation: readableLocation,
          hospital,
          hospitals,
          messageAlreadySent,
          dispatchSessionToken,
          agentRunId: run.runId,
          planId: run.plan.id,
          planHash: run.plan.planHash,
          selectedFacilityId: hospital.id,
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as {
          error?: string;
          operatorMessage?: DispatchCall["operatorMessage"];
        } | null;
        throw new Error(error?.operatorMessage?.error || error?.error || "We could not complete the call.");
      }

	      const data = (await response.json()) as {
	        statusToken?: string;
	        status?: DispatchCall["status"];
	        verificationOnly?: boolean;
	        selectedDestination?: HospitalCandidate;
	        handoffStatus?: CoordinationHandoffStatus;
	        coordinationSession?: CoordinationSession;
	        summary?: string;
	        transcript?: string;
	        operatorMessage?: DispatchCall["operatorMessage"];
	      };
	      const nextStatus = data.status || "queued";
	      const nextHandoffStatus = data.handoffStatus || data.coordinationSession?.handoffStatus;
	      setSendPhase(nextStatus === "failed" || nextHandoffStatus === "failed" ? "failed" : nextStatus === "ended" ? "done" : "calling_help");
	      setDispatchCall({
	        statusToken: data.statusToken,
	        attempt,
	        verificationOnly: data.verificationOnly,
	        hospitalName: hospital.name,
	        hospitalIndex,
	        messageAlreadySent,
	        selectedDestination: data.selectedDestination || data.coordinationSession?.selectedDestination,
	        handoffStatus: nextHandoffStatus,
	        coordinationSession: data.coordinationSession,
	        facilityResponses: data.coordinationSession?.facilityResponses,
	        operatorMessage: data.operatorMessage,
	        summary: data.summary,
	        transcript: data.transcript,
	        status: nextStatus,
	      });
      if (nextStatus === "ended" || nextStatus === "failed") {
        setStep("done");
      }
    } catch (error) {
      setDispatchCall({
        status: "failed",
        attempt,
        hospitalName: hospital.name,
        hospitalIndex,
        messageAlreadySent,
        error: error instanceof Error ? error.message : "We could not complete the call. Call local emergency services now.",
      });
      setSendPhase("failed");
      setStep("done");
    }
  }

  useEffect(() => {
    if (dispatchCall.verificationOnly || !dispatchCall.statusToken || dispatchCall.status === "ended" || dispatchCall.status === "failed") {
      return;
    }

    const statusToken = dispatchCall.statusToken;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/dispatch/status?statusToken=${encodeURIComponent(statusToken)}`);
        if (!response.ok) return;
	        const data = (await response.json()) as {
	          status?: DispatchCall["status"];
	          handoffStatus?: CoordinationHandoffStatus;
	          facilityResponses?: FacilityResponse[];
	        };
	        setDispatchCall((current) => ({
	          ...current,
	          status: data.status || current.status,
	          handoffStatus: data.handoffStatus || current.handoffStatus,
	          facilityResponses: data.facilityResponses || current.facilityResponses,
	          coordinationSession: current.coordinationSession
	            ? {
	                ...current.coordinationSession,
	                handoffStatus: data.handoffStatus || current.coordinationSession.handoffStatus,
	                facilityResponses: data.facilityResponses || current.coordinationSession.facilityResponses,
	              }
	            : current.coordinationSession,
	        }));
	        if (data.status === "ended") {
	          setSendPhase("done");
	          setStep("done");
        }
        if (data.status === "failed") {
          setDispatchCall((current) => ({
            ...current,
            error: current.error || "This call was not confirmed. Review the next option and approve again before another attempt.",
          }));
          setSendPhase("failed");
          setStep("done");
        }
      } catch {
        // Polling can recover on the next tick.
      }
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    dispatchCall.statusToken,
    dispatchCall.verificationOnly,
    dispatchCall.status,
  ]);

  async function requestMicrophoneAccess() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState("unavailable");
      return false;
    }

    try {
      setMicState("requesting");
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      setMicState("granted");
      return true;
    } catch {
      setMicState("denied");
      return false;
    }
  }

  function stopRealtimeConnection() {
    dataChannelRef.current?.close();
    peerConnectionRef.current?.close();
    dataChannelRef.current = null;
    peerConnectionRef.current = null;
  }

  function stopAudioMeter() {
    if (audioMeterFrameRef.current) {
      window.cancelAnimationFrame(audioMeterFrameRef.current);
      audioMeterFrameRef.current = null;
    }
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }

  function stopRealtimeCapture() {
    shouldListenRef.current = false;
    stopRealtimeConnection();
    stopAudioMeter();
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
  }

  useEffect(() => {
    return () => {
      shouldListenRef.current = false;
      dataChannelRef.current?.close();
      peerConnectionRef.current?.close();
      if (audioMeterFrameRef.current) {
        window.cancelAnimationFrame(audioMeterFrameRef.current);
      }
      audioContextRef.current?.close().catch(() => undefined);
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function startMediaRecording(stream: MediaStream) {
    audioChunksRef.current = [];
    if (!window.MediaRecorder) return;
    try {
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.start(500);
    } catch {
      mediaRecorderRef.current = null;
    }
  }

  function stopMediaRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(audioChunksRef.current.length > 0 ? new Blob(audioChunksRef.current, { type: "audio/webm" }) : null);
    }

    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const blob = audioChunksRef.current.length > 0 ? new Blob(audioChunksRef.current, { type: "audio/webm" }) : null;
        mediaRecorderRef.current = null;
        resolve(blob);
      };
      recorder.stop();
    });
  }

  function startAudioMeter(stream: MediaStream) {
    stopAudioMeter();
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const audioContext = new AudioContextClass();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = audioContext;

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const centered = value - 128;
          sum += centered * centered;
        }
        const volume = Math.min(100, Math.sqrt(sum / data.length) * 5);
        setAudioLevels((current) => current.map((_, index) => Math.max(12, Math.min(86, volume * (0.55 + index * 0.16) + 10))));
        audioMeterFrameRef.current = window.requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setAudioLevels([22, 40, 62, 44, 28]);
    }
  }

  function handleRealtimeTranscriptEvent(event: RealtimeTranscriptEvent) {
    if (event.type === "conversation.item.input_audio_transcription.delta" || event.type === "transcript.text.delta") {
      interimSpeechRef.current = `${interimSpeechRef.current}${event.delta || ""}`;
      setReport(`${committedSpeechRef.current}${interimSpeechRef.current}`.trimStart());
      setTranscriptSource("live");
      setSilenceNotice("");
      if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = window.setTimeout(() => {
        if (shouldListenRef.current) {
          setSilenceNotice("Still listening. Add anything important, then tap Review report.");
        }
      }, 3800);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" || event.type === "transcript.text.done") {
      const transcript = event.transcript?.trim();
      if (transcript) {
        committedSpeechRef.current = `${committedSpeechRef.current}${transcript} `;
      }
      interimSpeechRef.current = "";
      setReport(committedSpeechRef.current.trimStart());
      setTranscriptSource("live");
    }
  }

  async function startSpeechCapture() {
    if (!window.RTCPeerConnection) {
      setSpeechState("unsupported");
      return;
    }

    stopRealtimeCapture();
    const hasMicrophone = await requestMicrophoneAccess();
    if (!hasMicrophone || !micStreamRef.current) {
      setSpeechState("error");
      return;
    }

    try {
      shouldListenRef.current = true;
      setSpeechState("connecting");
      setSilenceNotice("");

      const sessionResponse = await fetch("/api/realtime/session", { method: "POST" });
      if (!sessionResponse.ok) throw new Error("Speech connection unavailable");
      const session = (await sessionResponse.json()) as { clientSecret?: string };
      if (!session.clientSecret) throw new Error("Speech connection unavailable");

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;
      micStreamRef.current.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, micStreamRef.current as MediaStream);
      });
      startMediaRecording(micStreamRef.current);
      startAudioMeter(micStreamRef.current);

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as RealtimeTranscriptEvent;
          if (event.type === "error") {
            setSpeechState("error");
            return;
          }
          handleRealtimeTranscriptEvent(event);
        } catch {
          // Ignore non-JSON transport messages.
        }
      };
      dataChannel.onerror = () => setSpeechState("error");
      peerConnection.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peerConnection.connectionState) && shouldListenRef.current) {
          if (realtimeReconnectsRef.current < 1) {
            realtimeReconnectsRef.current += 1;
            stopRealtimeConnection();
            window.setTimeout(() => {
              if (shouldListenRef.current) startSpeechCapture();
            }, 400);
          } else {
            setSpeechState("error");
          }
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls?intent=transcription", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) throw new Error("Speech connection failed");

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });
      setSpeechState("listening");
      silenceTimerRef.current = window.setTimeout(() => {
        if (shouldListenRef.current) {
          setSilenceNotice("Listening now. Say what happened, or type it below.");
        }
      }, 3500);
    } catch {
      stopRealtimeConnection();
      setSpeechState("error");
    }
  }

  function reset() {
    stopRealtimeCapture();
    setStep("start");
    setReport("");
    setSubmittedReport("");
    setTriageResult(null);
    setDispatchCall({ status: "idle" });
    setAgentRun(null);
    setSelectedFacilityId("");
    setOverrideReason("");
    setIncidentLocation(null);
    setHospitals([]);
    setSpeechState("idle");
    setMicState("idle");
    setLocationState("idle");
    setLocationError("");
    setSendPhase("idle");
    setSilenceNotice("");
    setTranscriptSource("typed");
    setAudioLevels([18, 34, 52, 38, 24]);
    setGuidanceImage({
      status: "idle",
      altText: "Simple emergency guidance with calm steps for the bystander.",
      caption: "",
    });
    committedSpeechRef.current = "";
    interimSpeechRef.current = "";
    realtimeReconnectsRef.current = 0;
  }

  async function approveCoordinationPlan() {
    if (!agentRun || !incidentLocation) return;
    const hospitalIndex = hospitals.findIndex((hospital) => hospital.id === selectedFacilityId);
    const hospital = hospitals[hospitalIndex];
    if (!hospital) return;
    await startDispatchCall(
      submittedReport,
      triage,
      agentRun,
      hospital,
      incidentLocation,
      hospitalIndex,
      overrideReason,
    );
  }

  function reviewNextFacility() {
    if (!agentRun || hospitals.length < 2) return;
    const currentIndex = Math.max(hospitals.findIndex((hospital) => hospital.id === selectedFacilityId), 0);
    const nextHospital = hospitals[(currentIndex + 1) % hospitals.length];
    setSelectedFacilityId(nextHospital.id);
    setOverrideReason("");
    setStep("approve");
  }

  function addNewDetail() {
    setStep("listen");
    setSpeechState("idle");
    setSilenceNotice("");
    realtimeReconnectsRef.current = 0;
    window.setTimeout(() => {
      reportRef.current?.focus();
      startSpeechCapture();
    }, 80);
  }

  return (
    <main className="min-h-screen bg-[#f6f8fb] text-[#111827]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3 py-2">
          <BrandHeader />
          {step !== "start" && (
            <button
              type="button"
              onClick={reset}
              className="min-h-11 rounded-lg border border-[#c7d2df] bg-white px-4 text-sm font-semibold text-[#475569] shadow-sm transition hover:border-[#c81e36] hover:text-[#c81e36] focus:outline-none focus:ring-4 focus:ring-[rgba(200,30,54,0.16)]"
            >
              Start new
            </button>
          )}
        </header>

        <section className="flex flex-1 items-stretch justify-center py-4 lg:py-6">
          {step === "start" && (
            <StartScreen
              locationError={locationError}
              locationState={locationState}
              onStart={startPulse}
            />
          )}

          {step === "listen" && (
            <ListeningScreen
              audioLevels={audioLevels}
              incidentLocation={incidentLocation}
              locationError={locationError}
              locationState={locationState}
              micState={micState}
              onProcess={() => prepareReportConfirmation()}
              onRequestLocation={startPulse}
              onRestartListening={startSpeechCapture}
              report={report}
              reportRef={reportRef}
              silenceNotice={silenceNotice}
              setReport={(value) => {
                setTranscriptSource("typed");
                setReport(value);
              }}
              speechState={speechState}
            />
          )}

          {step === "confirm" && (
            <ConfirmReportScreen
              incidentLocation={incidentLocation}
              onConfirm={() => submitCapturedReport()}
              onFix={() => {
                setStep("listen");
                window.setTimeout(() => reportRef.current?.focus(), 80);
              }}
              report={report}
              reportRef={reportRef}
              setReport={(value) => {
                setTranscriptSource("typed");
                setReport(value);
              }}
              transcriptSource={transcriptSource}
            />
          )}

          {step === "coordinating" && (
            <QwenCoordinatingScreen
              report={submittedReport}
              warning={triage.warning}
              actions={triage.actions}
            />
          )}

          {step === "approve" && agentRun && (
            <QwenPlanApprovalScreen
              agentRun={agentRun}
              selectedFacilityId={selectedFacilityId}
              overrideReason={overrideReason}
              onSelectFacility={setSelectedFacilityId}
              onOverrideReason={setOverrideReason}
              onApprove={() => void approveCoordinationPlan()}
              approving={dispatchCall.status === "starting"}
            />
          )}

          {step === "sending" && (
            <SendingScreen
                guidanceImage={guidanceImage}
              hospitals={hospitals}
              incidentLocation={incidentLocation}
              report={submittedReport}
              sendPhase={sendPhase}
              triage={triage}
            />
          )}

          {step === "done" && (
            <HelpNotifiedScreen
              dispatchCall={dispatchCall}
              guidanceImage={guidanceImage}
              hospitals={hospitals}
              incidentLocation={incidentLocation}
              onAddDetail={addNewDetail}
              onReviewNextOption={agentRun && hospitals.length > 1 ? reviewNextFacility : undefined}
              onReset={reset}
              sendPhase={sendPhase}
              triage={triage}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function BrandHeader() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-11 place-items-center rounded-lg bg-[#c81e36] text-white shadow-[0_14px_30px_rgba(143,24,48,0.18)]">
        <Siren className="size-6" />
      </span>
      <div>
        <p className="text-lg font-semibold tracking-[0.16em] text-[#111827]">PULSE</p>
        <p className="text-xs font-bold text-[#64748b]">Emergency help</p>
      </div>
    </div>
  );
}

function StartScreen({
  locationError,
  locationState,
  onStart,
}: {
  locationError: string;
  locationState: LocationState;
  onStart: () => void;
}) {
  const isLocating = locationState === "locking";

  return (
    <div className="w-full max-w-7xl">
      <section className="grid min-h-[calc(100vh-9rem)] overflow-hidden rounded-lg border border-[#dde5ee] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.08)] lg:grid-rows-[minmax(0,1fr)_62px]">
        <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
          <div className="flex flex-col justify-center p-5 sm:p-8 lg:border-r lg:border-[#dde5ee] lg:p-10">
            <div className="flex items-start justify-between gap-4 lg:block">
              <div>
                <h1 className="text-5xl font-semibold leading-none tracking-normal text-[#111827] sm:text-6xl lg:text-7xl">
                  Get help now
                </h1>
                <p className="mt-5 max-w-2xl text-base font-semibold leading-7 text-[#475569] sm:text-lg sm:leading-8 lg:text-xl lg:leading-9">
                  I’ll get your location, listen to what happened, and prepare a grounded plan for you to approve while you stay with them.
                </p>
              </div>
              <div className="lg:hidden">
                <LocationPill location={null} locationState={locationState} />
              </div>
            </div>

            {locationError && (
              <div className="mt-6 rounded-lg border border-[#efb4bd] bg-[#fff4f5] p-4">
                <div className="flex gap-3">
                  <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[#c81e36]" />
                  <p className="text-sm font-bold leading-6 text-[#7b2a31]">{locationError}</p>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={onStart}
              disabled={isLocating}
              className="mt-10 flex min-h-28 w-full items-center justify-center rounded-lg bg-[#c81e36] text-center text-white shadow-[0_24px_46px_rgba(143,24,48,0.22)] transition hover:bg-[#a61b32] focus:outline-none focus:ring-8 focus:ring-[rgba(200,30,54,0.16)] disabled:bg-[#d8a1aa] lg:max-w-xl"
            >
              <span className="flex items-center justify-center gap-3 px-4">
                {isLocating ? <Loader2 className="size-8 animate-spin" /> : <PhoneCall className="size-8" />}
                <span className="text-xl font-semibold leading-6 sm:text-2xl">{isLocating ? "Getting location" : "Start Emergency Help"}</span>
              </span>
            </button>

            <p className="mt-6 max-w-xl text-sm font-bold leading-6 text-[#475569]">
              Pulse prepares a plan after your report. Nobody is contacted until you approve it. First, make sure you are safe.
            </p>
          </div>

          <aside className="grid content-center gap-4 border-t border-[#dde5ee] bg-[#f6f8fb] p-5 sm:p-8 lg:border-t-0 lg:p-10">
            <div className="hidden justify-end lg:flex">
              <LocationPill location={null} locationState={locationState} />
            </div>
            <div>
              <p className="text-2xl font-semibold text-[#1d4ed8]">What happens next</p>
              <div className="mt-6 grid gap-5">
                <BystanderStep icon={MapPin} title="Share location" detail="I’ll ask for your location so help knows where to go." />
                <BystanderStep icon={Mic} title="Tell me what happened" detail="Speak or type. You can fix the report before sending." />
                <BystanderStep icon={Hand} title="Stay with them" detail="Keep them still. Watch breathing. Keep this page open." />
              </div>
            </div>

            <div className="rounded-lg border border-[#d8e3f1] bg-white p-5 shadow-sm">
              <div className="flex gap-3">
                <Siren className="mt-1 size-8 shrink-0 text-[#1d4ed8]" />
                <div>
                  <h2 className="text-2xl font-semibold text-[#111827]">I’ll handle the background.</h2>
                  <p className="mt-2 text-sm font-bold leading-6 text-[#475569]">
                    You focus on the person. Details about calls, care options, and evidence stay collapsed unless you open them.
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </div>

        <div className="grid gap-3 border-t border-[#dde5ee] bg-white px-5 py-3 text-sm font-bold leading-5 text-[#475569] sm:grid-cols-3 sm:items-center sm:px-8">
          <div className="flex items-center gap-3">
            <Lock className="size-5 text-[#475569]" />
            <p>Your data stays private.</p>
          </div>
          <div className="flex items-center gap-3">
            <ShieldCheck className="size-5 text-[#475569]" />
            <p>Simple steps stay visible.</p>
          </div>
          <div className="flex items-center gap-3">
            <Clock3 className="size-5 text-[#475569]" />
            <p>Help gets details faster.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function ListeningScreen({
  audioLevels,
  incidentLocation,
  locationError,
  locationState,
  micState,
  onProcess,
  onRequestLocation,
  onRestartListening,
  report,
  reportRef,
  silenceNotice,
  setReport,
  speechState,
}: {
  audioLevels: number[];
  incidentLocation: IncidentLocation | null;
  locationError: string;
  locationState: LocationState;
  micState: MicState;
  onProcess: () => void;
  onRequestLocation: () => void;
  onRestartListening: () => void;
  report: string;
  reportRef: RefObject<HTMLTextAreaElement | null>;
  silenceNotice: string;
  setReport: (value: string) => void;
  speechState: SpeechState;
}) {
  const locked = locationState === "locked" && incidentLocation;
  const canProcess = report.trim().length >= 12;
  const microphoneFallback = speechState === "unsupported" || speechState === "error" || micState === "denied" || micState === "unavailable";
  const listenLabel =
    micState === "requesting"
      ? "Requesting microphone"
      : speechState === "connecting"
        ? "Connecting"
      : speechState === "listening"
        ? "Listening now"
        : microphoneFallback
          ? "Type what happened"
          : "Ready";

  return (
    <div className="grid w-full max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-lg border border-[#dde5ee] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <StatusBadge tone={speechState === "listening" || speechState === "connecting" ? "blue" : microphoneFallback ? "warning" : "green"} icon={Mic} label={listenLabel} />
            <h1 className="mt-5 text-4xl font-semibold tracking-normal text-[#111827] sm:text-5xl">
              I’m listening
            </h1>
            <p className="mt-3 max-w-2xl text-base font-semibold leading-7 text-[#475569]">
              Tell me what happened. You can fix the text here, then send it for help.
            </p>
          </div>
          <LocationPill location={incidentLocation} locationState={locationState} />
        </div>

        <div className="mt-6 rounded-lg border border-[#d8e3f1] bg-[#f8fbff] p-5">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className={`pulse-orb grid size-24 shrink-0 place-items-center rounded-full text-white ${speechState === "listening" ? "" : "opacity-80"}`}>
              {speechState === "connecting" || speechState === "processing" ? <Loader2 className="size-9 animate-spin" /> : <Mic className="size-10" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xl font-semibold text-[#111827]">
                {speechState === "listening" ? "Listening now" : speechState === "connecting" ? "Getting the microphone ready" : microphoneFallback ? "Typing is okay" : "Ready when you are"}
              </p>
              <p className="mt-2 text-sm font-bold leading-6 text-[#475569]">
                {silenceNotice || "Say what you see: injury, breathing, bleeding, and where the person is."}
              </p>
              <div className="mt-4 flex h-12 items-center gap-2" aria-label="Microphone volume">
                {audioLevels.map((level, index) => (
                  <span
                    key={index}
                    className="pulse-wave-bar"
                    style={{
                      height: `${speechState === "listening" ? level : 16}px`,
                      animationDelay: `${index * 110}ms`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {!locked && (
          <div className="mt-6 rounded-lg border border-[#efb4bd] bg-[#fff4f5] p-4">
            <p className="text-sm font-bold leading-6 text-[#7b2a31]">
              {locationError || "Location is needed to send help to the right place."}
            </p>
            <button
              type="button"
              onClick={onRequestLocation}
              disabled={locationState === "locking"}
              className="mt-4 min-h-12 rounded-lg bg-[#c81e36] px-5 text-sm font-semibold text-white transition hover:bg-[#a61b32] focus:outline-none focus:ring-4 focus:ring-[rgba(200,30,54,0.16)] disabled:bg-[#d8a1aa]"
            >
              {locationState === "locking" ? "Getting location" : "Share my location"}
            </button>
          </div>
        )}

        {microphoneFallback && locked && (
          <div className="mt-6 rounded-lg border border-[#ead8a2] bg-[#fff8e6] p-4">
            <p className="text-sm font-bold leading-6 text-[#705616]">
              You can type what happened. Pulse can still share your location and contact help.
            </p>
          </div>
        )}

        <label htmlFor="incident-report" className="mt-7 block text-sm font-semibold text-[#475569]">
          Tell me what happened
        </label>
        <textarea
          ref={reportRef}
          id="incident-report"
          value={report}
          onChange={(event) => setReport(event.target.value)}
          placeholder={locked ? "Say or type what happened, where the person is, and what you can see." : "Share your location first."}
          disabled={!locked || speechState === "processing"}
          className="mt-3 min-h-72 w-full resize-none rounded-lg border border-[#c7d2df] bg-white p-5 text-xl font-semibold leading-9 text-[#111827] outline-none transition placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:ring-4 focus:ring-[rgba(37,99,235,0.14)] disabled:bg-[#edf2f7] disabled:text-[#64748b]"
        />

        <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <button
            type="button"
            onClick={onRestartListening}
            disabled={!locked}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-lg border border-[#c7d2df] bg-white px-4 text-sm font-semibold text-[#475569] transition hover:border-[#2563eb] hover:text-[#1d4ed8] focus:outline-none focus:ring-4 focus:ring-[rgba(37,99,235,0.14)] disabled:text-[#94a3b8]"
          >
            <RefreshCw className="size-4" />
            Restart listening
          </button>
          <button
            type="button"
            onClick={onProcess}
            disabled={!canProcess || speechState === "processing"}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#c81e36] px-5 text-base font-semibold text-white shadow-[0_16px_34px_rgba(143,24,48,0.18)] transition hover:bg-[#a61b32] focus:outline-none focus:ring-4 focus:ring-[rgba(200,30,54,0.16)] disabled:bg-[#d8a1aa]"
          >
            {speechState === "processing" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Review report
          </button>
        </div>
      </section>

      <aside className="grid content-start gap-4">
        <div className="rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-5">
          <p className="text-sm font-semibold text-[#1d4ed8]">Keep it simple</p>
          <div className="mt-5 grid gap-5">
            <BystanderStep icon={Mic} title="I’m listening" detail="Live text appears here. Type over anything that is wrong." />
            <BystanderStep icon={MapPin} title="Location status" detail={locked ? "Location is ready to share." : "Share location before sending."} />
            <BystanderStep icon={Send} title="Review first" detail="Nothing is sent until you confirm the report." />
          </div>
        </div>
        <div className="rounded-lg border border-[#d8e3f1] bg-white p-5 shadow-sm">
          <p className="text-lg font-semibold text-[#111827]">Stay with them. Keep them still.</p>
          <p className="mt-2 text-sm font-bold leading-6 text-[#475569]">If their breathing changes, say what changed and follow the steps on screen.</p>
        </div>
      </aside>
    </div>
  );
}

function ConfirmReportScreen({
  incidentLocation,
  onConfirm,
  onFix,
  report,
  reportRef,
  setReport,
  transcriptSource,
}: {
  incidentLocation: IncidentLocation | null;
  onConfirm: () => void;
  onFix: () => void;
  report: string;
  reportRef: RefObject<HTMLTextAreaElement | null>;
  setReport: (value: string) => void;
  transcriptSource: "live" | "final" | "typed";
}) {
  const sourceText =
    transcriptSource === "final"
      ? "Pulse cleaned up the wording from your voice."
      : transcriptSource === "live"
        ? "Pulse used the words it heard live."
        : "You can edit this before Pulse sends it.";

  return (
    <div className="grid w-full max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-lg border border-[#dde5ee] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] sm:p-7">
        <StatusBadge tone="green" icon={CheckCircle2} label="Review before sending" />
        <h1 className="mt-5 text-4xl font-semibold tracking-normal text-[#111827] sm:text-5xl">
          This is what I heard.
        </h1>
        <p className="mt-3 max-w-2xl text-base font-semibold leading-7 text-[#475569]">
          Check this once. Qwen will use the reviewed report to prepare a plan. Nobody is contacted until you approve that separate plan.
        </p>

        <label htmlFor="confirmed-report" className="mt-7 block text-sm font-semibold text-[#475569]">
          I heard this
        </label>
        <textarea
          ref={reportRef}
          id="confirmed-report"
          value={report}
          onChange={(event) => setReport(event.target.value)}
          className="mt-3 min-h-72 w-full resize-none rounded-lg border border-[#c7d2df] bg-white p-5 text-xl font-semibold leading-9 text-[#111827] outline-none transition placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]"
        />
        <p className="mt-3 text-sm font-bold leading-6 text-[#475569]">{sourceText}</p>

        <div className="mt-6 grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <button
            type="button"
            onClick={onFix}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-lg border border-[#c7d2df] bg-white px-4 text-sm font-semibold text-[#475569] transition hover:border-[#2563eb] hover:text-[#1d4ed8] focus:outline-none focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]"
          >
            Edit more
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={report.trim().length < 12}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#c81e36] px-5 text-base font-semibold text-white shadow-[0_16px_34px_rgba(143,24,48,0.18)] transition hover:bg-[#a61b32] focus:outline-none focus:ring-4 focus:ring-[rgba(200,30,54,0.16)] disabled:bg-[#d8a1aa]"
          >
            <Send className="size-4" />
            Ask Qwen to coordinate
          </button>
        </div>
      </section>

      <aside className="grid content-start gap-4">
        <LocationCard incidentLocation={incidentLocation} compact />
        <div className="rounded-lg border border-[#d8e3f1] bg-white p-5 shadow-sm">
          <p className="text-lg font-semibold text-[#111827]">Stay with them. Keep them still.</p>
          <p className="mt-2 text-sm font-bold leading-6 text-[#475569]">
            This review step prevents wrong speech text from being used to build the coordination plan.
          </p>
        </div>
      </aside>
    </div>
  );
}

function SendingScreen({
  guidanceImage,
  hospitals,
  incidentLocation,
	  report,
	  sendPhase,
	  triage,
	}: {
    guidanceImage: InfographicResult;
	  hospitals: HospitalCandidate[];
	  incidentLocation: IncidentLocation | null;
	  report: string;
	  sendPhase: SendPhase;
	  triage: TriageResult;
	}) {
  const currentIndex = phaseIndex(sendPhase);

  return (
    <div className="grid w-full max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="rounded-lg border border-[#dde5ee] bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.08)] sm:p-8">
        <StatusBadge tone="red" icon={PhoneCall} label="Sending now" />
        <h1 className="mt-5 text-4xl font-semibold tracking-normal text-[#111827] sm:text-5xl">
          I’m contacting help
        </h1>
        <p className="mt-3 max-w-2xl text-base font-semibold leading-7 text-[#475569]">
          Stay with them. Keep them still. Keep this screen open while I share the details.
        </p>
        <FirstAidInfographic guidanceImage={guidanceImage} triage={triage} />
      </section>

      <aside className="grid content-start gap-4">
        <div className="rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-5">
          <p className="text-sm font-semibold text-[#1d4ed8]">Progress</p>
          <div className="mt-5 grid gap-3">
            {statusSteps.map((step, index) => {
              const active = currentIndex === index;
              const complete = currentIndex > index;
              return (
                <div
                  key={step.phase}
                  className={`flex items-center gap-4 rounded-lg border p-4 ${
                    active
                      ? "border-[#d8e3f1] bg-[#f8fbff]"
                      : complete
                        ? "border-[#bbdfc8] bg-[#eef9f2]"
                        : "border-[#dde5ee] bg-white"
                  }`}
                >
                  <span className={`grid size-10 place-items-center rounded-lg ${complete ? "bg-[#15803d] text-white" : active ? "bg-[#2563eb] text-white" : "bg-[#dde5ee] text-[#64748b]"}`}>
                    {complete ? <CheckCircle2 className="size-5" /> : active ? <Loader2 className="size-5 animate-spin" /> : index + 1}
                  </span>
                  <p className="text-base font-semibold text-[#111827]">{step.label}</p>
                </div>
              );
            })}
          </div>
        </div>

        <details className="rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-4">
          <summary className="cursor-pointer text-sm font-semibold text-[#111827] focus:outline-none focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]">
            Details
          </summary>
          <div className="mt-4 grid gap-4">
            <LocationCard incidentLocation={incidentLocation} compact />
            <CareCandidateCard hospital={hospitals[0]} />
          </div>

          <div className="mt-4 rounded-lg border border-[#dde5ee] bg-white p-5">
            <p className="text-sm font-semibold text-[#475569]">What happened</p>
            <p className="mt-3 line-clamp-6 text-sm font-semibold leading-6 text-[#111827]">{report}</p>
          </div>
        </details>
      </aside>
    </div>
  );
}

function HelpNotifiedScreen({
  dispatchCall,
  guidanceImage,
  hospitals,
  incidentLocation,
  onAddDetail,
  onReviewNextOption,
  onReset,
  sendPhase,
  triage,
}: {
  dispatchCall: DispatchCall;
  guidanceImage: InfographicResult;
  hospitals: HospitalCandidate[];
  incidentLocation: IncidentLocation | null;
  onAddDetail: () => void;
  onReviewNextOption?: () => void;
  onReset: () => void;
  sendPhase: SendPhase;
  triage: TriageResult;
}) {
	  const helpStatus = getHelpStatus(dispatchCall, sendPhase);
	  const isFailure = helpStatus.tone === "danger";
	  const coordinationTimeline = getCoordinationTimeline(dispatchCall, sendPhase);

  return (
    <div className="grid w-full max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="rounded-lg border border-[#dde5ee] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] sm:p-7">
        <StatusBadge tone={isFailure ? "danger" : "green"} icon={isFailure ? AlertTriangle : CheckCircle2} label={isFailure ? "Needs attention" : "Help contacted"} />
        <h1 className="mt-5 text-4xl font-semibold tracking-normal text-[#111827] sm:text-5xl">
          {helpStatus.title}
        </h1>
        <p className="mt-3 max-w-2xl text-base font-semibold leading-7 text-[#475569]">{helpStatus.detail}</p>

        <FirstAidInfographic guidanceImage={guidanceImage} triage={triage} />
      </section>

      <aside className="grid content-start gap-4">
        <details className="mt-6 rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-4">
          <summary className="cursor-pointer text-sm font-semibold text-[#111827] focus:outline-none focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]">
            Details
          </summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <LocationCard incidentLocation={incidentLocation} />
            <CareCandidateCard hospital={hospitals[dispatchCall.hospitalIndex ?? 0] || hospitals[0]} />
          </div>

          <CoordinationTimelinePanel items={coordinationTimeline} session={dispatchCall.coordinationSession} />
        </details>

        <div className="grid gap-3">
          {isFailure && onReviewNextOption && (
            <button
              type="button"
              onClick={onReviewNextOption}
              className="min-h-14 rounded-lg bg-[#2563eb] px-4 text-sm font-semibold text-white transition hover:bg-[#1d4ed8] focus:outline-none focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]"
            >
              Review next care option
            </button>
          )}
          <button
            type="button"
            onClick={onAddDetail}
            className="min-h-14 rounded-lg border border-[#c7d2df] bg-white px-4 text-sm font-semibold text-[#475569] transition hover:border-[#2563eb] hover:text-[#1d4ed8] focus:outline-none focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]"
          >
            Add new detail
          </button>
          {incidentLocation && (
            <a
              href={getLocationUrl(incidentLocation)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-14 items-center justify-center gap-2 rounded-lg border border-[#c7d2df] bg-white px-4 text-sm font-semibold text-[#475569] transition hover:border-[#2563eb] hover:text-[#1d4ed8] focus:outline-none focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]"
            >
              <Navigation className="size-4" />
              Show my location
            </a>
          )}
          <button
            type="button"
            onClick={onReset}
            className="min-h-14 rounded-lg bg-[#c81e36] px-5 text-sm font-semibold text-white shadow-[0_16px_34px_rgba(143,24,48,0.18)] transition hover:bg-[#a61b32] focus:outline-none focus:ring-4 focus:ring-[rgba(200,30,54,0.16)]"
          >
            Start new emergency
          </button>
        </div>
      </aside>
    </div>
  );
}

function StatusBadge({
  icon: Icon,
  label,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  tone: "green" | "red" | "warning" | "danger" | "blue";
}) {
  const className =
    tone === "green"
      ? "bg-[#eef9f2] text-[#166534]"
      : tone === "blue"
        ? "bg-[#eef5ff] text-[#1d4ed8]"
      : tone === "danger"
        ? "bg-[#fff4f5] text-[#8f1830]"
        : tone === "warning"
          ? "bg-[#fff8e6] text-[#76520b]"
          : "bg-[#fff4f5] text-[#8f1830]";

  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${className}`}>
      <Icon className="size-4" />
      {label}
    </span>
  );
}

function BystanderStep({
  detail,
  icon: Icon,
  title,
}: {
  detail: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="flex gap-4">
      <span className="grid size-12 shrink-0 place-items-center rounded-lg border border-[#d8e3f1] bg-[#f8fbff] text-[#1d4ed8]">
        <Icon className="size-6" />
      </span>
      <div>
        <h2 className="text-lg font-semibold text-[#111827]">{title}</h2>
        <p className="mt-1 text-sm font-semibold leading-6 text-[#475569]">{detail}</p>
      </div>
    </div>
  );
}

function LocationPill({
  location,
  locationState,
}: {
  location: IncidentLocation | null;
  locationState: LocationState;
}) {
  if (locationState === "locked" && location) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-[#eef9f2] px-4 py-2 text-sm font-semibold text-[#166534]">
        <MapPin className="size-4" />
        Location shared
      </span>
    );
  }

  if (locationState === "locking") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-[#fff8e6] px-4 py-2 text-sm font-semibold text-[#76520b]">
        <Loader2 className="size-4 animate-spin" />
        Getting location
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-[#fff4f5] px-4 py-2 text-sm font-semibold text-[#8f1830]">
      <MapPin className="size-4" />
      Location needed
    </span>
  );
}

function LocationCard({
  compact = false,
  incidentLocation,
}: {
  compact?: boolean;
  incidentLocation: IncidentLocation | null;
}) {
  return (
    <div className={`overflow-hidden rounded-lg border border-[#dde5ee] bg-white ${compact ? "p-4" : "p-5"}`}>
      <div className="pulse-mini-map relative min-h-36 overflow-hidden rounded-lg border border-[#dde5ee] bg-[#f6f8fb]">
        <div className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-lg bg-[#c81e36] text-white shadow-[0_16px_34px_rgba(143,24,48,0.2)]">
          <MapPin className="size-7" />
        </div>
      </div>
      <div className="mt-4 flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#eef9f2] text-[#166534]">
          <CheckCircle2 className="size-5" />
        </span>
        <div>
          <p className="text-sm font-semibold text-[#111827]">Your location was shared</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-[#475569]">
            {incidentLocation ? "Open your location if you need to guide someone nearby." : "Pulse is waiting for your location."}
          </p>
          {incidentLocation && (
            <p className="mt-2 text-sm font-bold text-[#64748b]">{formatLocationLabel(incidentLocation)}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function CareCandidateCard({ hospital }: { hospital?: HospitalCandidate }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#dde5ee] bg-white p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-[#eef9f2] text-[#166534]">
          <Hospital className="size-6" />
        </span>
        <div>
          <p className="text-sm font-semibold text-[#111827]">Nearby emergency care</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-[#475569]">
            {hospital ? hospital.name : "Pulse is finding the nearest suitable emergency care."}
          </p>
          {hospital && (
            <p className="mt-2 text-sm font-bold text-[#64748b]">
              {hospital.travelTimeMinutes ? `${Math.round(hospital.travelTimeMinutes)} min drive` : `${hospital.distanceKm} km away`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CoordinationTimelinePanel({
  items,
  session,
}: {
  items: CoordinationTimelineItem[];
  session?: CoordinationSession;
}) {
  return (
    <div className="mt-6 rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#c81e36]">Help progress</p>
          <h2 className="mt-1 text-2xl font-semibold text-[#111827]">Where things stand.</h2>
        </div>
        <Radio className="size-7 text-[#15803d]" />
      </div>

      <div className="mt-5 grid gap-3">
        {items.map((item) => {
          const isDone = item.state === "done";
          const needsAttention = item.state === "attention";
          return (
            <div key={item.id} className="flex items-center gap-4 rounded-lg border border-[#dde5ee] bg-white p-4">
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-lg ${
                  isDone
                    ? "bg-[#15803d] text-white"
                    : needsAttention
                      ? "bg-[#fff4f5] text-[#c81e36]"
                      : "bg-[#fff8e6] text-[#76520b]"
                }`}
              >
                {isDone ? <CheckCircle2 className="size-5" /> : needsAttention ? <AlertTriangle className="size-5" /> : <Loader2 className="size-5 animate-spin" />}
              </span>
              <div>
                <p className="text-sm font-semibold text-[#111827]">{item.label}</p>
                <p className="mt-1 text-sm font-semibold leading-5 text-[#475569]">{item.detail}</p>
              </div>
            </div>
          );
        })}
      </div>

      {session && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-[#dde5ee] bg-white p-4">
            <p className="text-sm font-semibold text-[#111827]">What Pulse asked</p>
            <div className="mt-3 grid gap-2">
              {session.facilityQuestions.map((question) => {
                const response = session.facilityResponses.find((item) => item.questionId === question.id);
                return (
                  <div key={question.id} className="rounded-lg bg-[#f6f8fb] px-4 py-3">
                    <p className="text-sm font-bold leading-5 text-[#111827]">{question.label}</p>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#64748b]">
                      {response?.status === "yes" ? "Confirmed" : response?.status === "no" ? "Unavailable" : response?.status === "unknown" ? "Not confirmed" : "Pending"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border border-[#dde5ee] bg-white p-4">
            <p className="text-sm font-semibold text-[#111827]">Who may help next</p>
            <div className="mt-3 grid gap-2">
              {session.contactTargets.slice(0, 4).map((target) => (
                <div key={target.id} className="rounded-lg bg-[#f6f8fb] px-4 py-3">
                  <p className="text-sm font-bold leading-5 text-[#111827]">{target.name}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-normal text-[#64748b]">
                    {target.status === "selected" ? "Calling first" : target.status === "queued" ? "Ready next" : target.status === "manual_required" ? "Backup path" : "Not connected yet"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FirstAidInfographic({
  guidanceImage,
  triage,
}: {
  guidanceImage: InfographicResult;
  triage: TriageResult;
}) {
  const doNow = (triage.doNow?.length ? triage.doNow : triage.actions).slice(0, 4);
  const doNotDo = (triage.doNotDo?.length ? triage.doNotDo : ["Do not move them unless there is danger", "Do not give food or drink", "Do not crowd around them"]).slice(0, 3);
  const watchFor = (triage.watchFor?.length ? triage.watchFor : ["Breathing changes", "Heavy bleeding", "Confusion or fainting"]).slice(0, 3);
  const enrichedSteps = doNow.slice(0, 3).map((action) => ({
    title: normalizeAction(action),
    detail: getActionDetail(action, "Stay calm and keep following the steps."),
  }));

  return (
    <div className="mt-7 rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#c81e36]">Do this now</p>
          <h2 className="mt-1 text-2xl font-semibold text-[#111827]">{triage.situationSummary || "Stay with the person."}</h2>
        </div>
        {guidanceImage.status === "loading" ? <Loader2 className="size-7 animate-spin text-[#15803d]" /> : <ImageIcon className="size-7 text-[#15803d]" />}
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-[#dde5ee] bg-white">
        {guidanceImage.imageDataUrl ? (
          <div className="flex min-h-72 w-full items-center justify-center bg-[#f6f8fb] p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={guidanceImage.imageDataUrl}
              alt={guidanceImage.altText}
              className="max-h-[520px] w-full object-contain"
            />
          </div>
        ) : (
          <div className="grid min-h-64 gap-3 bg-[#eef9f2] p-4 md:grid-cols-3">
            {enrichedSteps.map((step, index) => {
              const Icon = getActionIcon(step.title);
              return (
                <div key={step.title} className="flex flex-col justify-between rounded-lg border border-[#d7ebdf] bg-white p-4">
                  <span className="grid size-14 place-items-center rounded-lg bg-[#fff4f5] text-[#c81e36]">
                    <Icon className="size-8" />
                  </span>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-normal text-[#15803d]">Step {index + 1}</p>
                    <h3 className="mt-2 text-xl font-semibold leading-6 text-[#111827]">{step.title}</h3>
                    <p className="mt-2 text-sm font-semibold leading-6 text-[#475569]">{step.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="mt-3 text-sm font-bold leading-6 text-[#475569]">
        {guidanceImage.status === "loading" ? "A simple picture guide is loading. The steps below are ready now." : guidanceImage.caption || "Use these simple steps now."}
      </p>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <GuidanceList title="Do" tone="green" items={doNow} />
        <GuidanceList title="Don't" tone="red" items={doNotDo} />
        <GuidanceList title="Watch" tone="warning" items={watchFor} />
      </div>
    </div>
  );
}

function GuidanceList({
  items,
  title,
  tone,
}: {
  items: string[];
  title: string;
  tone: "green" | "red" | "warning";
}) {
  const className =
    tone === "green"
      ? "border-[#bbdfc8] bg-[#eef9f2] text-[#166534]"
      : tone === "warning"
        ? "border-[#ead8a2] bg-[#fff8e6] text-[#76520b]"
        : "border-[#efb4bd] bg-[#fff4f5] text-[#8f1830]";

  return (
    <div className={`rounded-lg border p-4 ${className}`}>
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-3 grid gap-2">
        {items.map((item) => (
          <p key={item} className="rounded-lg bg-white/75 px-3 py-2 text-sm font-bold leading-5 text-[#111827]">
            {normalizeAction(item)}
          </p>
        ))}
      </div>
    </div>
  );
}

function normalizeAction(action: string) {
  return action
    .replace(/\bhim\b/gi, "them")
    .replace(/\bpatient\b/gi, "person")
    .replace(/^Stop people from moving them$/i, "Keep them still");
}

function getActionIcon(action: string) {
  if (/bleed|press|pressure|cloth|wound/i.test(action)) return Hand;
  if (/breath|pulse|cpr|airway|heart/i.test(action)) return HeartPulse;
  if (/watch|awake|monitor|check/i.test(action)) return Eye;
  if (/space|responder|ambulance|clear/i.test(action)) return Ambulance;
  return Lock;
}

function getActionDetail(action: string, fallback: string) {
  if (/cpr/i.test(action)) return "Use hands-only CPR if they are not breathing normally.";
  if (/breath|airway|pulse/i.test(action)) return "Keep checking breathing and keep the airway clear.";
  if (/bleed|press|pressure|cloth|wound/i.test(action)) return "Use cloth or clothing and press firmly.";
  if (/awake|monitor|watch|check/i.test(action)) return "Stay close and keep checking for changes.";
  if (/space|responder|ambulance|clear/i.test(action)) return "Move people back so responders can reach them.";
  if (/still|move/i.test(action)) return "Do not move them unless there is danger.";
  return fallback;
}
