# Report runs from an external platform

OpenClaw agents and scheduled jobs, Capy threads, and other externally executed agents can report their runs to AgentRun. Register an agent with `sdk: {runtime: "external", platform: "OpenClaw"}`, then report each run through the same three SDK-run calls the SDK wrappers use. The platform keeps executing the run with its own tools, credentials and schedule. AgentRun records the result, usage and tool calls, and shows the platform label in the console.

AgentRun never launches such an agent: `POST /v2/agents/{agent_id}/runs` is refused (409). Stop, cancel and follow-up requests through AgentRun are also refused; use the platform's own controls.

## Register the agent once

Set `AGENTRUN_BASE_URL` to the server's API root, including `/v2`, and `AGENTRUN_API_KEY` to its API token.

```sh
curl -sS "$AGENTRUN_BASE_URL/agents" \
  -H "Authorization: Bearer $AGENTRUN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"definition": {"id": "nightly-digest", "name": "Nightly digest", "instructions": "Summarize the overnight feeds.", "sdk": {"runtime": "external", "platform": "OpenClaw"}, "learning": false, "tools": []}}'
```

Use `platform: "Capy"` for a Capy thread, or your own platform's label. No new runtime is needed for another platform. The label is required for `external`: 1–80 Unicode characters, with no leading or trailing whitespace, control characters or unpaired UTF-16 surrogates. It is preserved exactly, including case and interior spaces. Other SDK runtimes do not accept `platform`.

Each run must supply the registered runtime and platform label; a mismatch is refused (422). The run retains that label even if the agent's definition changes later.

## Report each run

1. **Start.** `POST /v2/agents/{agent_id}/sdk-runs` with an `Idempotency-Key` header (one per run; a retry with the same key and body returns the same run) and `{runtime: "external", platform, input, instructions, model?}`. The response holds `run_id`, a `token` scoped to that run, and the `learning` to apply. When learning is on, `learning.context` supplies the owner's corrections for the platform to apply; `learning.workflows` is empty for external sources. Reusing a key with a changed body, including its platform label, is refused (409).
2. **Events.** `POST /v2/sdk-runs/{run_id}/events` with the run token: `{sequence, events}`, sequences contiguous from 1, at most 100 events per batch. Event types are `text`, `session` (the platform's own session or thread id) and `tool` (`started`, then `completed` or `failed`, with the same `id`).
3. **Complete.** `POST /v2/sdk-runs/{run_id}/complete` with the run token: `{status: "completed" | "failed" | "cancelled", answer, session_id?, usage?}`. `answer` is required for every status; send `""` when there is no answer to report. Usage fields are `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` and `cost_usd`, each optional. Set `evidence_complete: false` when some of the trace was not sent: the result is kept, and nothing is learned from it.

```sh
run=$(curl -sS "$AGENTRUN_BASE_URL/agents/nightly-digest/sdk-runs" \
  -H "Authorization: Bearer $AGENTRUN_API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: job-2026-01-01" \
  -d '{"runtime": "external", "platform": "OpenClaw", "input": "Summarize the overnight feeds.", "instructions": "Summarize the overnight feeds."}')
id=$(echo "$run" | jq -r .run_id)
token=$(echo "$run" | jq -r .token)
curl -sS "$AGENTRUN_BASE_URL/sdk-runs/$id/events" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"sequence": 1, "events": [{"type": "text", "text": "Read 3 feeds."}]}'
curl -sS "$AGENTRUN_BASE_URL/sdk-runs/$id/complete" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"status": "completed", "answer": "Digest ready.", "usage": {"input_tokens": 1200, "output_tokens": 300}}'
```

External sources can receive the owner's corrections when learning is on. They do not receive or compile workflows: a start that carries `workflow_tools` or `workflow_adapters`, even an empty array, is refused (422) before any run is recorded. A platform label never grants a workflow bridge or managed execution capabilities.

From TypeScript, import the reporting helper from its learning subpath:

```ts
import { BackendLearningClient } from '@parcha/agentrun-client/learning';
```

Call `begin({runtime: "external", platform: "OpenClaw", input, instructions})`, then the session's `event` and `complete` methods. The helper can register a missing agent with the same runtime and platform. Do not supply a `workflows` bridge for an external source; the helper refuses it before making a request.

## What to send

Send only what you want stored in AgentRun. A reporter that runs inside a platform decides which sessions it reports and how much of each: for private conversations, report the run with its usage and leave the text and tool payloads out, setting `evidence_complete: false`.
