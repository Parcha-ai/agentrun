---
name: agentrun-serve
description: Connect existing Claude Code or Codex agents locally or remotely, import selected history, and manage agents and learning through AgentRun Server. Clarify whether the user wants a live connection or historical import, then use the existing instance and its matching CLI. Also use to create agents, run them, answer questions and inspect results over MCP or the v2 API.
---

# AgentRun Server

The open platform's server for agents. One process on this machine's loopback address, port 7340 by default, keeps
agents (a prompt with tools, or a typed workflow) and every run of them: its timeline, its files and its cost. A coding
agent drives it over MCP (`/v2/mcp`) or HTTP (`/v2`); a person follows the same runs in its console (`/`).

Read this skill from the target server's `/skills/agentrun-serve/SKILL.md` when possible; it matches the deployed
build. Inspect `/v2/capabilities` and `/v2/openapi.json` before using an optional feature. A handoff naming an
existing instance is not permission to start a replacement or change its destination.

## Connect agent

Use one entry point for live connections and history. Ask only what the conversation has not established:

1. Does the user want to **connect an agent for future runs**, **import past history**, or both?
2. Which machine holds the existing setup and native sign-in, and which AgentRun instance should receive it?
3. Which project, runtime and specific named agent/profile should be selected? Discover only the chosen source.

Explain the difference before a choice: a live connection retains the original native configuration and sign-in,
and supports new jobs with optional self-improvement. A history import creates historical records; it does not
attach a running conversation, resume it or turn it into learning. Do not infer consent for history from consent
to connect, or enable learning solely because an agent was connected.

### Live connection on this server

Verify that the coding agent, source project and AgentRun server are on the same machine. A browser's loopback
address alone does not prove this. Use the matching installed Node CLI:

```sh
npx @parcha/agentrun native discover --project /absolute/project
npx @parcha/agentrun native connect --project /absolute/project --runtime claude-code --url http://127.0.0.1:7340
```

Use the verified server port, not necessarily 7340. Select `codex` for Codex, `--agent NAME` for a discovered Claude
named agent or `--profile NAME` for a discovered Codex profile. Show the discovered setup and register only the
user's selection. Verify sign-in separately from model execution. Reconnecting reuses its ordinary agent record.

### Live connection from another machine

Use the existing Python connector with its **remote** command from the same reviewed build as the OSS server.
The observation-only hosted connector does not execute jobs. Do not assume an older published launcher includes
this extension. A source checkout can be installed with `uv tool install ./connector` after building its matching
Node runtime. The source machine needs `agentrun-serve remote-bridge` from that build; the connector accepts an
explicit `--bridge` path to its compiled `remote-worker-bridge.js` for checkout-based installations.

Run `python -m agentrun_cli remote --help` in the installed connector environment (or its `agentrun` entry point).
Discover the selected project with `remote discover --project /absolute/project --runtime claude-code` or
`--runtime codex`. Present the supported project default, Claude named agents or Codex profiles before importing.

Have the user open the destination console's **Connect agent → Another machine** page and create a one-use
connection code. Enter it directly into the CLI's secure prompt. Never place it in agent prompts, URLs, command
arguments, shell history or logs. For an explicitly approved unattended setup, use the documented origin-bound,
owner-only credential file; keep its contents out of chat. Do not send a broad server API key to the source.

```sh
agentrun remote connect --origin https://console.example.com --project /absolute/project --runtime claude-code
```

Replace the origin with the intended instance. Add `--selector-kind agent --selector-name NAME` for a Claude
named agent, or `--selector-kind profile --selector-name NAME` for Codex. Use a separate private `--state-dir` for
each connection. Import registers the selected source-bound setup as a normal agent/revision; it does not copy
provider credentials, project files or historical conversations. Connection starts the source worker by default.
Check `agentrun remote status`, the console's machine status and the imported agent link. Keep the source worker
running for jobs. `agentrun remote worker --state-dir /private/connector --foreground` owns it in a terminal;
persistent service installation is a separate user choice. Revocation prevents further remote work.

The worker uses outbound HTTPS, the selected native target and a restricted connector credential. Native files,
skills, MCP, hooks, models, permissions and sign-in remain on the source machine. Do not add permission-bypass
flags or silently substitute managed execution. Independent desktop conversations are not attached.

### Optional self-improvement

When requested, verify the imported agent and enable its existing **Self-improving** control. Notes and skills are
additive, pinned to a learning revision for each run. Reflection resumes the exact task session with tools disabled;
the existing checker, grader and merge rules decide what becomes active. Risky proposals await owner review in
Learning Dojo; a connector cannot approve them. Reflection and grading add model usage. Off means later runs
receive and create no AgentRun learning. Do not start a paid run unless authorized, and do not promise enforcement
of native dollar caps, interactive approvals, learned workflows or unsupported desktop tools.

### Historical import

Confirm source runtimes, projects and scope, then inspect the local importer with `npx @parcha/agentrun import
--help`. This importer writes a local store; the remote connector does not upload session history. If source files
and the intended store are on different machines, explain that limitation before offering a migration; never
silently import into another instance or transfer transcripts without approval.

Identify the existing server's actual data directory, store configuration, seal key and supervisor. Preserve them
without printing secrets. Run the selected `import --data DIR --dry-run` first. Before write import, inspect active
and queued work and enabled triggers, present scope and the stop/restart plan, and obtain any missing approval.
The importer requires exclusive store ownership: stop the original service in an agreed idle window, import the
approved sources, and restart the same service even if import fails. Do not delete locks, reset owner setup or
bypass ownership. Verify health and imported/skipped counts at the original console address. If safe restart is
not possible, stop after the dry run and explain the operator action required.

## 1. Check the server

If `AGENTRUN_BASE_URL` is set, check it:

```sh
curl -sf "$AGENTRUN_BASE_URL/health"
```

If the user named an existing server and it does not answer, diagnose that instance; do not start another one.
Only when the user wants a new local server, start it from a checkout of the repository (Node 24.22.3 or later), in the
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
| `agents_create` | Makes an agent: `name`, `instructions`, `tools`, and optionally `id`, `harness`, `model`, `thinking`, and `definition` for any other field (`place`, say). |
| `agents_revise` | Makes an agent's next revision with the fields you change, and any other in `definition`; the rest stay. |
| `runs_start` | Starts a run: `agent_id`, `input` (`{content: "..."}` for an agentic agent), optional `effort`. Answers at once. |
| `runs_get` | A run's status, result or error, `pending` (its question, when it asked one) and `console_url`. |
| `runs_events` | The run's steps, a page at a time (`after`, `limit`). |
| `runs_files` | The files it wrote; with `path`, one file's text. |
| `runs_respond` | Answers a run's question (`content`), or follows up after it completed or was stopped (a fresh turn with its history). |
| `runs_cancel` | Ends a run for good: it takes no more messages (`409 not_continuable`); go on in a new run. |

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

To give a run a file, upload it in one call, its bytes the body, then name it in the run's `file_ids`; the run finds it
at `inputs/<path>` in its workspace (MCP has no upload tool: use the API):

```sh
file=$(curl -s "$AGENTRUN_BASE_URL/files?path=notes.md" -H "$H" --data-binary @notes.md \
  | node -p 'JSON.parse(require("fs").readFileSync(0)).file.file_id')
curl -s "$AGENTRUN_BASE_URL/agents/calc/runs" -H "$H" -H 'content-type: application/json' \
  -d '{"input":{"content":"Summarize inputs/notes.md."},"file_ids":["'"$file"'"]}'
```

The whole API is in `GET $AGENTRUN_BASE_URL/openapi.json`, and in brief at `/llms.txt` on the server's root
(`curl -s "${AGENTRUN_BASE_URL%/v2}/llms.txt"`). The run's page for a person is `${AGENTRUN_BASE_URL%/v2}/#/runs/$run`.

For everything the MCP tools do not cover (tool keys, triggers, webhooks, files, revisions, learning, waiting on a run from a script), use the `agentrun` CLI and its skill, agentrun-cli: `npx @parcha/agentrun skill install`.

## Troubleshooting

- `401`: the token is not this server's. Read it again from the data directory the server was started with.
- `403` on `/v2/mcp`: the request carried a browser `Origin` that is not the server's own. Call it from your MCP client, not a web page.
- `405` on `/v2/mcp`: it takes POST only (no stream, no session).
- `409 agent_not_runnable`: this server cannot run that agent yet (a harness, tool or key it lacks); `error.details` and `whoami` say which.
- `422 input_invalid`: `error.fields` names each field to fix.
- `429 rate_limited` from `runs_start`: the server is at its most runs at once. Start it again when one ends.
- Keep the server on the loopback address. Started with `--listen` on another one, put TLS in front of it.
