# Alibaba Function Compute deployment

This guide deploys only the FastAPI agent backend. It does not touch the original Pulse deployment.

## 1. Create the Web Function

- Region: Singapore (`ap-southeast-1`)
- Function name: `pulse-qwen-agent`
- Function type: Web Function
- Runtime: Custom Runtime / Python
- Listening port: `9000`
- Execution timeout: `60` seconds
- Minimum idle instances: `0`
- Maximum instances: `1` for the hackathon demo
- Public HTTP trigger: `GET`, `POST`, `OPTIONS`
- Internet access: enabled so the function can reach Qwen Cloud and configured facility sources
- Logging: optional; Alibaba Log Service is billable and was not enabled for the no-paid-overage deployment

Do not add a payment method or enable paid overage solely for this submission.

## 2. Upload the backend source

Create the source archive locally:

```bash
./deploy/package-function-compute.sh
```

Upload `dist/pulse-qwen-agent-source.zip` in the Function Compute Web IDE. The archive contains only `backend/`.

In the Web IDE terminal, install Linux-compatible dependencies into the function code root:

```bash
pip install -t . -r backend/requirements.txt
```

Startup command:

```bash
python3 -m uvicorn backend.app:app --host 0.0.0.0 --port 9000
```

## 3. Add server-side environment values

```text
DASHSCOPE_API_KEY
QWEN_MODEL=qwen3.7-plus
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
GOOGLE_MAPS_API_KEY
OVERPASS_API_URL
PULSE_FACILITY_SEARCH_URL=https://<new-vercel-project>.vercel.app/api/hospitals
PULSE_AGENT_BACKEND_TOKEN
ALLOWED_ORIGINS=https://<new-vercel-project>.vercel.app
PULSE_DEPLOYMENT_REGION=ap-southeast-1
PULSE_FUNCTION_NAME=pulse-qwen-agent
PULSE_GIT_SHA=<deployed-commit>
```

No value should be copied into a `NEXT_PUBLIC_` variable. Use a new random backend token and enter it independently in Function Compute and the new Vercel project.

## 4. Verify before connecting Vercel

```bash
curl https://<function-url>/health
curl https://<function-url>/deployment
curl -X POST https://<function-url>/agent/run \
  -H 'Authorization: Bearer <backend-token>' \
  -H 'Content-Type: application/json' \
  --data '{"report":"A person fell near the road and cannot stand but is breathing.","location":{"latitude":1.3521,"longitude":103.8198,"accuracyMeters":18},"mode":"demo"}'
```

The successful agent response must contain a real Qwen request ID, a Function Compute request ID, a four-step hashed tool trace, a searched facility ID, a plan hash, and `fallbackUsed: false`.

## 5. Connect the new Vercel project

Add only to the new `pulse-qwen-autopilot` project:

```text
PULSE_AGENT_BACKEND_URL=https://<function-url>
PULSE_AGENT_BACKEND_TOKEN=<same-backend-token>
PULSE_AGENT_RECEIPT_SECRET=<new-independent-secret>
PULSE_DISPATCH_SESSION_SECRET=<new-independent-secret>
```

Re-enter the approved existing OpenAI, Google (if available), Vapi, Twilio, response-line, and dispatch variables securely. Do not copy `.env.local` into the repository. If Google is not configured, the public Singapore demo uses the dated OpenStreetMap snapshot documented in the README.

## 6. Capture authentic proof

Save these under `docs/proof/` after deployment:

1. Function Compute console showing `pulse-qwen-agent`, Singapore region, active status, and the public trigger URL.
2. The matching Function Compute request ID displayed in Pulse; add an invocation-log screenshot only if Log Service is already available without enabling paid usage.
3. Public `/api/deployment` JSON.
4. Repository view of [backend/app.py](../backend/app.py) showing the Qwen hostname, model, typed tools, and `x-fc-request-id` handling.

Do not fabricate or redact the identifying request ID needed to connect the UI with the log. Do redact credentials and unrelated account identifiers.

## Custom-container fallback

If Web IDE dependency installation fails, build [Dockerfile.function-compute](../Dockerfile.function-compute) for `linux/amd64`, push it to Alibaba Container Registry, and create a Function Compute custom-container function on port `9000`. Keep the backend on Alibaba Cloud.
