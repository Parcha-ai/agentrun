---
name: agentrun-serve
description: Connect to AgentRun Server (start it when it is not running), then create agents, run them, answer their questions and read their results over its MCP endpoint or its /v2 API. Use when asked to run an agent on AgentRun, start or check the AgentRun server, connect to it over MCP, or find out what an AgentRun run did.
---

# AgentRun Server

The open platform's server for agents. One process on this machine's loopback address, port 7340 by default, keeps
agents (a prompt with tools, or a typed workflow) and every run of them: its timeline, its files and its cost. A coding
agent drives it over MCP (`/v2/mcp`) or HTTP (`/v2`); a person follows the same runs in its console (`/console/`).

## 1. Check the server

If `AGENTRUN_BASE_URL` is set, check it:

```sh
curl -sf "$AGENTRUN_BASE_URL/health"
```

If it is not set, or nothing answers, start the server from a checkout of the repository (Node 22.19 or later), in the
background, with its data in a directory you name:

```sh
git clone --branch main --single-branch https://github.com/Parcha-ai/agentrun.git && cd agentrun
npm ci --ignore-scripts && npm run build
node packages/serve/dist/cli.js --data "$PWD/.agentrun" > serve.log 2>&1 &
until grep -q '^AGENTRUN_BASE_URL=' serve.log; do sleep 1; done
export "$(grep -m1 '^AGENTRUN_BASE_URL=' serve.log)"
until curl -sf "$AGENTRUN_BASE_URL/health" >/dev/null; do sleep 1; done
```

It runs on the model `AGENT_MODEL` names, with that provider's key in the environment (for example
`AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5` and `OPENROUTER_API_KEY`); the package README lists every way. To
try it with no key and no network, add `--faux faux.mjs` with a module that answers every request itself:

```sh
printf '%s\n' 'export default (context, faux) => faux.message("The answer is 42.");' > faux.mjs
```

## 2. Get the token

The token is made once, mode 0600, in the data directory: `DIR/.token` for `--data DIR` (without `--data`,
`$XDG_DATA_HOME/agentrun/agents/.token`, else `~/.local/share/agentrun/agents/.token`). Read it into the environment and
never print it, echo it or write it anywhere else:

```sh
export AGENTRUN_API_KEY=$(cat .agentrun/.token)
```

## 3. Connect over MCP

```sh
claude mcp add --transport http agentrun "$AGENTRUN_BASE_URL/mcp" --header "Authorization: Bearer $AGENTRUN_API_KEY"
codex mcp add agentrun --url "$AGENTRUN_BASE_URL/mcp" --bearer-token-env-var AGENTRUN_API_KEY
```

Then call `whoami` first. It checks the token and says what this server runs: its harnesses, tools, efforts, thinking
levels, default model and console address. The other tools:

| Tool | What it does |
| --- | --- |
| `agents_list` | The agents, 20 at a time (`cursor` for the next page). |
| `agents_create` | Makes an agent: `name`, `instructions`, `tools`, and optionally `id`, `harness`, `model`, `thinking`. |
| `agents_revise` | Makes an agent's next revision with the fields you change; the rest stay. |
| `runs_start` | Starts a run: `agent_id`, `input` (`{content: "..."}` for an agentic agent), optional `effort`. Answers at once. |
| `runs_get` | A run's status, result or error, `pending` (its question, when it asked one) and `console_url`. |
| `runs_events` | The run's steps, a page at a time (`after`, `limit`). |
| `runs_files` | The files it wrote; with `path`, one file's text. |
| `runs_respond` | Answers a run's question (`content`), or follows up after it completed. |
| `runs_cancel` | Ends a run for good. |

A refusal comes back as a tool error holding the server's `error`: `code`, `message`, and for a `422` each field to fix.

## 4. Create an agent

Look for one first with `agents_list`. Ask the person before you create or revise an agent, and say what it will do.
Then `agents_create`, for example `{"name": "Release notes", "instructions": "Write release notes from the commits you are given.", "tools": ["read", "write"]}`.
It writes files only with a tool like `write` in its `tools`; `whoami` lists the tools this server has.

## 5. Run it, poll it, answer it

1. `runs_start` with `{"agent_id": "...", "input": {"content": "..."}}`. It answers at once with the run, `queued`.
2. `runs_get` every few seconds, until `status` is `completed`, `failed` or `cancelled`. Never wait on one call.
3. `input_required` means the agent asked a question: `pending.question` holds it. Answer with `runs_respond`, or leave
   it for the person in the console, then go on polling.
4. `completed`: the answer is `result.final_answer` (a workflow's is `result.output`). `failed`: `error` says why.
   `runs_files` lists what it wrote and reads a file; `runs_events` pages its steps.
5. Tell the person the outcome, and end with the run's `console_url`, where they can see all of it.

`cost.usd` is null while the cost is unknown; never report it as $0.

## 6. Without MCP: the /v2 API

```sh
H="authorization: Bearer $AGENTRUN_API_KEY"
curl -s "$AGENTRUN_BASE_URL/agents" -H "$H" -H 'content-type: application/json' \
  -d '{"definition":{"id":"calc","name":"Calc","instructions":"Answer the question.","tools":[]}}'
run=$(curl -s "$AGENTRUN_BASE_URL/agents/calc/runs" -H "$H" -H 'content-type: application/json' \
  -H "idempotency-key: calc-$(date +%s)" -d '{"input":{"content":"What is six times seven?"}}' \
  | node -p 'JSON.parse(require("fs").readFileSync(0)).run_id')
until curl -s "$AGENTRUN_BASE_URL/runs/$run" -H "$H" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));process.exit(["completed","failed","cancelled","input_required"].includes(r.status)?0:1)'; do sleep 2; done
curl -s "$AGENTRUN_BASE_URL/runs/$run" -H "$H"
curl -s "$AGENTRUN_BASE_URL/runs/$run/files" -H "$H"
curl -s "$AGENTRUN_BASE_URL/runs/$run/messages" -H "$H" -H 'content-type: application/json' -d '{"content":"..."}'
```

The whole API is in `GET $AGENTRUN_BASE_URL/openapi.json`, and in brief at `/llms.txt` on the server's root
(`curl -s "${AGENTRUN_BASE_URL%/v2}/llms.txt"`). The run's page for a person is `${AGENTRUN_BASE_URL%/v2}/console/#/runs/$run`.

## Troubleshooting

- `401`: the token is not this server's. Read it again from the data directory the server was started with.
- `403` on `/v2/mcp`: the request carried a browser `Origin` that is not the server's own. Call it from your MCP client, not a web page.
- `405` on `/v2/mcp`: it takes POST only (no stream, no session).
- `409 agent_not_runnable`: this server cannot run that agent yet (a harness, tool or key it lacks); `error.details` and `whoami` say which.
- `422 input_invalid`: `error.fields` names each field to fix.
- `429 rate_limited` from `runs_start`: the server is at its most runs at once. Start it again when one ends.
- Keep the server on the loopback address. Started with `--listen` on another one, put TLS in front of it.
