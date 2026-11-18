# Report runs from OpenClaw or Capy

OpenClaw agents and scheduled jobs, and Capy threads, run on their own platform. They can still show up in AgentRun: register an agent with `sdk: {runtime: "openclaw"}` or `sdk: {runtime: "capy"}`, and have the platform report each run through the same three SDK-run calls the SDK wrappers use. The platform keeps executing the run with its own tools, credentials and schedule; AgentRun records it, shows it in the console with its usage and tool calls, and, when learning is on, reflects on it after it completes.

AgentRun never launches such an agent: `POST /v2/agents/{agent_id}/runs` is refused (409), and stopping or cancelling the run from the console is refused too, since only the platform controls it.

## Register the agent once

```sh
curl -sS "$AGENTRUN_BASE_URL/agents" \
  -H "Authorization: Bearer $AGENTRUN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"definition": {"id": "nightly-digest", "name": "Nightly digest", "instructions": "Summarize the overnight feeds.", "sdk": {"runtime": "openclaw"}, "learning": false, "tools": []}}'
```

Use `"capy"` for a Capy thread. One agent belongs to one runtime: a run that names another runtime is refused (422).

## Report each run

1. **Start.** `POST /v2/agents/{agent_id}/sdk-runs` with an `Idempotency-Key` header (one per run; a retry with the same key and body returns the same run) and `{runtime, input, instructions, model?}`. The response holds `run_id`, a `token` scoped to that run, and the `learning` to apply (owner corrections and workflows; empty while learning is off).
2. **Events.** `POST /v2/sdk-runs/{run_id}/events` with the run token: `{sequence, events}`, sequences contiguous from 1, at most 100 events per batch. Event types are `text`, `session` (the platform's own session or thread id) and `tool` (`started`, then `completed` or `failed`, with the same `id`).
3. **Complete.** `POST /v2/sdk-runs/{run_id}/complete` with the run token: `{status: "completed" | "failed" | "cancelled", answer, session_id?, usage?}`. `answer` is required for every status; send `""` when there is no answer to report. Usage fields are `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` and `cost_usd`, each optional. Set `evidence_complete: false` when some of the trace was not sent: the result is kept, and nothing is learned from it.

```sh
run=$(curl -sS "$AGENTRUN_BASE_URL/agents/nightly-digest/sdk-runs" \
  -H "Authorization: Bearer $AGENTRUN_API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: job-2026-01-01" \
  -d '{"runtime": "openclaw", "input": "Summarize the overnight feeds.", "instructions": "Summarize the overnight feeds."}')
id=$(echo "$run" | jq -r .run_id); token=$(echo "$run" | jq -r .token)
curl -sS "$AGENTRUN_BASE_URL/sdk-runs/$id/events" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"sequence": 1, "events": [{"type": "text", "text": "Read 3 feeds."}]}'
curl -sS "$AGENTRUN_BASE_URL/sdk-runs/$id/complete" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"status": "completed", "answer": "Digest ready.", "usage": {"input_tokens": 1200, "output_tokens": 300}}'
```

Such an agent receives owner corrections when learning is enabled. A learned workflow needs a backend workflow bridge (the SDK wrappers' local MCP `learned_workflow` server), which the platforms don't have, so a start that carries `workflow_tools` is refused (422), and an agent set to full learning receives owner corrections.

From TypeScript, `BackendLearningClient` in `@parcha/agentrun-client` makes the same calls (`begin`, then the session's events and completion) and accepts `openclaw` and `capy` as runtimes.

## What to send

Send only what you want stored in AgentRun. A reporter that runs inside a platform decides which sessions it reports and how much of each: for private conversations, report the run with its usage and leave the text and tool payloads out, setting `evidence_complete: false`.
