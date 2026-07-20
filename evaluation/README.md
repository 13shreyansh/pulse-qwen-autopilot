# Evaluation

`run_live_evaluation.py` sends fictional reports only to the deployed Function Compute agent endpoint. It never calls the dispatch routes and cannot place a message or call.

Run after authenticated Qwen and Function Compute setup:

```bash
export PULSE_EVAL_BACKEND_URL=https://<function-url>
export PULSE_AGENT_BACKEND_TOKEN=<server-side-token>
.venv/bin/python evaluation/run_live_evaluation.py
```

The script writes a sanitized `evaluation/results/live-evaluation.json` containing real Qwen and Function Compute request IDs, tool-order/hash checks, and aggregate counts. It omits reports, exact GPS coordinates, phone numbers, facility names, backend tokens, and signed agent receipts.

The remaining safety cases are covered by automated local suites:

- approval bypass and modified receipts: `tests/agent-approval-api.spec.ts`;
- no phone or uncertain availability: deterministic facility-tool tests;
- Qwen unavailable and retry exhaustion: `backend/tests/test_agent.py`;
- no automatic second call: product flow and approval-token enforcement.

Do not commit a target result or edit output numbers by hand. Publish only the generated result from the live endpoint.
