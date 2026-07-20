# 2:50 demo script

## 0:00–0:15 — the human problem

“In an emergency, the first report is often frightened and incomplete. A fluent chatbot can make that worse by inventing facts. Pulse turns that ambiguity into an auditable plan—and stops before acting.”

## 0:15–0:32 — architecture

Show `docs/architecture.png`.

“Qwen interprets and orchestrates. Deterministic code owns safety instructions, Google facility evidence, hashes, and approval enforcement. The Qwen agent runs here on Alibaba Function Compute.”

## 0:32–1:12 — ambiguous report and tool trace

Enter: “A cyclist was hit near the road. He is awake and breathing but cannot stand.”

Confirm the transcript. Point out that immediate conservative guidance appears while Qwen calls the four tools. Open the trace and show the real Qwen and Function Compute request IDs.

## 1:12–1:42 — grounded recommendation

Show the selected protocol, Google listing evidence, travel time, plan rationale, and plan hash.

“Pulse never says this hospital has beds or can accept the patient. A public listing is evidence, not readiness.”

## 1:42–2:15 — human gate

Select the second searched facility. Show that the approval button remains unavailable until an override reason is written. Return to the recommended facility.

“There is no approval or call tool in Qwen. The server signs the report, plan, and facility, and only this separate human action creates the dispatch token.”

Approve. Use the public sandbox outcome or the controlled response-line recording only.

## 2:15–2:38 — truthful outcome and evaluation

Show `accepted`, `not_confirmed`, or `failed`. If not confirmed, show “Review next care option” and that a new approval is required. Show the generated evaluation result without embellishment.

## 2:38–2:50 — proof

Show the Alibaba Function Compute console/log with the matching request ID, the public repository and MIT license, then the live app URL.

End: “Pulse gives Qwen agency where reasoning helps—and removes agency where human accountability matters.”
