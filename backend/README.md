# Pulse Qwen Agent Backend

FastAPI service for the Qwen Cloud tool loop used by the Pulse Track 4 submission.

## Local development

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/uvicorn backend.app:app --host 0.0.0.0 --port 9000
```

Required environment variables are documented in the repository `.env.example`. The `/agent/run` endpoint always requires a server-side bearer token. `/health` and `/deployment` expose readiness labels and sanitized deployment metadata only.

## Alibaba Function Compute

- Function type: Web Function
- Runtime: Python custom runtime
- Listening port: `9000`
- Startup command: `python3 -m uvicorn backend.app:app --host 0.0.0.0 --port 9000`
- Execution timeout: 60 seconds

The service reads the `x-fc-request-id` header supplied by Function Compute and includes it in the agent response for matching against invocation logs.
