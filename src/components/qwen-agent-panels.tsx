import { AlertTriangle, CheckCircle2, Clock3, Hospital, Loader2, Lock, MapPin, Radio, ShieldCheck } from "lucide-react";
import type { AgentFacility, AgentRunResult } from "@/lib/agent-types";

export function QwenCoordinatingScreen({
  report,
  warning,
  actions,
}: {
  report: string;
  warning: string;
  actions: string[];
}) {
  return (
    <div className="grid w-full max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="rounded-lg border border-[#dde5ee] bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.08)] sm:p-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#c7d7ff] bg-[#eef4ff] px-3 py-2 text-sm font-semibold text-[#1d4ed8]">
          <Loader2 className="size-4 animate-spin" />
          Qwen Cloud · qwen3.7-plus
        </div>
        <h1 className="mt-5 text-4xl font-semibold text-[#111827] sm:text-5xl">Qwen is coordinating the next step</h1>
        <p className="mt-3 max-w-2xl text-base font-semibold leading-7 text-[#475569]">
          It is selecting a bounded safety protocol, checking sourced nearby-care listings, and preparing a plan for your approval.
        </p>

        <div className="mt-7 rounded-lg border border-[#f2c7ce] bg-[#fff7f8] p-5">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[#c81e36]" />
            <div>
              <p className="font-semibold text-[#8f1830]">Do this while Pulse checks</p>
              <p className="mt-1 text-sm font-semibold leading-6 text-[#475569]">{warning}</p>
            </div>
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {actions.slice(0, 4).map((action) => (
              <li key={action} className="flex gap-2 text-sm font-semibold text-[#111827]">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#15803d]" />
                {action}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <aside className="grid content-start gap-4">
        <div className="rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-5">
          <p className="text-sm font-semibold text-[#1d4ed8]">Auditable tool loop</p>
          <div className="mt-5 grid gap-4">
            {[
              [ShieldCheck, "Safety protocol", "Deterministic guidance only"],
              [MapPin, "Nearby care", "Google listing and travel evidence"],
              [Lock, "Human gate", "No contact before approval"],
            ].map(([Icon, title, detail]) => {
              const StepIcon = Icon as typeof ShieldCheck;
              return (
                <div key={String(title)} className="flex gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white text-[#2563eb] shadow-sm"><StepIcon className="size-5" /></span>
                  <div><p className="font-semibold text-[#111827]">{String(title)}</p><p className="mt-1 text-sm font-medium text-[#64748b]">{String(detail)}</p></div>
                </div>
              );
            })}
          </div>
        </div>
        <details className="rounded-lg border border-[#dde5ee] bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-[#111827]">Reviewed report</summary>
          <p className="mt-3 text-sm font-semibold leading-6 text-[#475569]">{report}</p>
        </details>
      </aside>
    </div>
  );
}

function FacilityOption({
  facility,
  recommended,
  selected,
  onSelect,
}: {
  facility: AgentFacility;
  recommended: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label className={`block cursor-pointer rounded-lg border p-4 transition ${selected ? "border-[#2563eb] bg-[#f4f8ff] ring-2 ring-[rgba(37,99,235,0.12)]" : "border-[#dde5ee] bg-white hover:border-[#9fb6d5]"}`}>
      <div className="flex items-start gap-3">
        <input type="radio" name="facility" checked={selected} onChange={onSelect} className="mt-1 size-4 accent-[#2563eb]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-[#111827]">{facility.name}</p>
            {recommended && <span className="rounded-full bg-[#dcfce7] px-2 py-1 text-xs font-bold text-[#166534]">Qwen recommendation</span>}
          </div>
          <p className="mt-1 text-sm font-medium text-[#64748b]">{facility.address}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-[#475569]">
            <span className="rounded-full bg-white px-2 py-1">{facility.distanceKm} km</span>
            {facility.travelTimeMinutes != null && <span className="rounded-full bg-white px-2 py-1">~{Math.round(facility.travelTimeMinutes)} min drive</span>}
            <span className="rounded-full bg-white px-2 py-1">Public Google listing</span>
          </div>
          <p className="mt-3 text-sm font-semibold leading-6 text-[#475569]">{facility.rankingReason}</p>
        </div>
      </div>
    </label>
  );
}

export function QwenPlanApprovalScreen({
  agentRun,
  selectedFacilityId,
  overrideReason,
  onSelectFacility,
  onOverrideReason,
  onApprove,
  approving,
}: {
  agentRun: AgentRunResult;
  selectedFacilityId: string;
  overrideReason: string;
  onSelectFacility: (facilityId: string) => void;
  onOverrideReason: (reason: string) => void;
  onApprove: () => void;
  approving: boolean;
}) {
  const recommendedId = agentRun.plan.selectedFacilityId;
  const isOverride = selectedFacilityId !== recommendedId;
  const selectedFacility = agentRun.facilities.find((facility) => facility.id === selectedFacilityId);
  const approvalReady = Boolean(selectedFacility) && (!isOverride || overrideReason.trim().length >= 8);

  return (
    <div className="grid w-full max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
      <section className="rounded-lg border border-[#dde5ee] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] sm:p-7">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#bbdfc8] bg-[#eef9f2] px-3 py-2 text-sm font-semibold text-[#166534]"><CheckCircle2 className="size-4" />Qwen plan ready</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-[#c7d7ff] bg-[#eef4ff] px-3 py-2 text-sm font-semibold text-[#1d4ed8]"><Radio className="size-4" />{agentRun.model}</span>
        </div>
        <h1 className="mt-5 text-4xl font-semibold text-[#111827] sm:text-5xl">Review before Pulse contacts anyone</h1>
        <p className="mt-3 max-w-2xl text-base font-semibold leading-7 text-[#475569]">Qwen recommends a sourced nearby-care listing. You—not the agent—decide whether the controlled call can begin.</p>

        <div className="mt-6 rounded-lg border border-[#d8e3f1] bg-[#f8fbff] p-5">
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-[#1d4ed8]">Selected protocol</p>
          <h2 className="mt-2 text-xl font-semibold text-[#111827]">{agentRun.protocol.title}</h2>
          <p className="mt-2 text-sm font-semibold leading-6 text-[#475569]">{agentRun.plan.rationale}</p>
          <p className="mt-3 text-sm font-bold text-[#8f1830]">{agentRun.protocol.warning}</p>
        </div>

        <fieldset className="mt-6 grid gap-3">
          <legend className="mb-2 text-sm font-semibold text-[#475569]">Choose the facility for the approved plan</legend>
          {agentRun.facilities.slice(0, 3).map((facility) => (
            <FacilityOption
              key={facility.id}
              facility={facility}
              recommended={facility.id === recommendedId}
              selected={facility.id === selectedFacilityId}
              onSelect={() => onSelectFacility(facility.id)}
            />
          ))}
        </fieldset>

        <div className="mt-5 flex gap-3 rounded-lg border border-[#f4d38a] bg-[#fffbeb] p-4 text-sm font-semibold leading-6 text-[#7c5a0b]">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          Public listings do not prove current beds, capacity, equipment readiness, or acceptance. The call must verify availability.
        </div>

        {isOverride && (
          <label className="mt-5 block text-sm font-semibold text-[#475569]">
            Why are you overriding Qwen’s recommendation?
            <textarea
              value={overrideReason}
              onChange={(event) => onOverrideReason(event.target.value)}
              placeholder="Write at least 8 characters so the override is auditable."
              className="mt-2 min-h-24 w-full rounded-lg border border-[#c7d2df] p-3 text-base text-[#111827] outline-none focus:border-[#2563eb] focus:ring-4 focus:ring-[rgba(37,99,235,0.14)]"
            />
          </label>
        )}

        <button
          type="button"
          onClick={onApprove}
          disabled={!approvalReady || approving}
          className="mt-6 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-lg bg-[#c81e36] px-5 text-base font-semibold text-white shadow-[0_16px_34px_rgba(143,24,48,0.18)] transition hover:bg-[#a61b32] focus:outline-none focus:ring-4 focus:ring-[rgba(200,30,54,0.16)] disabled:bg-[#d8a1aa]"
        >
          {approving ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
          {approving ? "Recording approval…" : "Approve plan and contact controlled line"}
        </button>
        <p className="mt-3 text-center text-xs font-semibold leading-5 text-[#64748b]">Hackathon safety: public testing uses a sandbox outcome; any authentic recording calls only Pulse’s controlled test line.</p>
      </section>

      <aside className="grid content-start gap-4">
        <div className="rounded-lg border border-[#dde5ee] bg-[#f6f8fb] p-5">
          <p className="text-sm font-semibold text-[#1d4ed8]">Qwen Incident Coordinator</p>
          <div className="mt-4 grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-3"><span className="font-semibold text-[#64748b]">Model</span><span className="font-bold text-[#111827]">{agentRun.model}</span></div>
            <div className="flex items-center justify-between gap-3"><span className="font-semibold text-[#64748b]">Latency</span><span className="font-bold text-[#111827]">{agentRun.latencyMs} ms</span></div>
            <div className="flex items-center justify-between gap-3"><span className="font-semibold text-[#64748b]">Tools</span><span className="font-bold text-[#111827]">{agentRun.toolTrace.length} validated</span></div>
          </div>
        </div>

        <details className="rounded-lg border border-[#dde5ee] bg-white p-4" open>
          <summary className="cursor-pointer text-sm font-semibold text-[#111827]">Verified tool trace</summary>
          <ol className="mt-4 grid gap-3">
            {agentRun.toolTrace.map((entry) => (
              <li key={`${entry.index}-${entry.tool}`} className="rounded-lg border border-[#e5eaf0] bg-[#f8fafc] p-3">
                <div className="flex items-start gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#2563eb] text-xs font-bold text-white">{entry.index}</span><div className="min-w-0"><p className="break-words text-sm font-bold text-[#111827]">{entry.tool}</p><p className="mt-1 text-xs font-semibold leading-5 text-[#64748b]">{entry.resultSummary}</p><code className="mt-2 block break-all text-[10px] text-[#64748b]">sha256:{entry.resultHash}</code></div></div>
              </li>
            ))}
          </ol>
        </details>

        <details className="rounded-lg border border-[#dde5ee] bg-white p-4" open>
          <summary className="cursor-pointer text-sm font-semibold text-[#111827]">Cloud receipts</summary>
          <div className="mt-3 grid gap-3 text-xs text-[#475569]">
            <div><p className="font-bold">Qwen request ID</p><code className="mt-1 block break-all">{agentRun.qwenRequestId}</code></div>
            <div><p className="font-bold">Function Compute request ID</p><code className="mt-1 block break-all">{agentRun.fcRequestId}</code></div>
            <div><p className="font-bold">Plan hash</p><code className="mt-1 block break-all">{agentRun.plan.planHash}</code></div>
          </div>
        </details>

        <div className="flex gap-3 rounded-lg border border-[#d8e3f1] bg-white p-4 text-sm font-semibold leading-6 text-[#475569]"><Clock3 className="mt-0.5 size-5 shrink-0 text-[#2563eb]" /><span>A second contact attempt always needs a new approval.</span></div>
        <div className="flex gap-3 rounded-lg border border-[#d8e3f1] bg-white p-4 text-sm font-semibold leading-6 text-[#475569]"><Hospital className="mt-0.5 size-5 shrink-0 text-[#2563eb]" /><span>{selectedFacility?.name || "Select a sourced facility"}</span></div>
      </aside>
    </div>
  );
}
