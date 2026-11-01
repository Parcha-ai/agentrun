---
name: agentrun-serve
description: Set up AgentRun Server on this machine and drive it, to create agents, run them and read their results over its HTTP API or its MCP endpoint. Use when asked to run an agent on AgentRun, start the AgentRun server, connect to it over MCP, or check what an AgentRun run did.
---

# AgentRun Server

The open platform's server for agents. One process on this machine's loopback address, port 7340, keeps agents (a
prompt with tools, or a typed workflow) and every run of them: its timeline, its files and its cost. Drive it over HTTP
(`/v2`) or MCP (`/v2/mcp`).

## 1. Install and start

Node 22.19 or later. From a checkout of the repository:

```sh
git clone --branch main --single-branch https://github.com/Parcha-ai/agentrun.git && cd agentrun
npm ci --ignore-scripts && npm run build
```

To try it with no key and no network, give it a faux model, which answers every request itself:

```sh
cat > faux.mjs <<'JS'
export default (context, faux) => faux.message("The answer is 42.");
JS
node packages/serve/dist/cli.js --faux faux.mjs > serve.log 2>&1 &
```

For a real model, leave out `--faux` and set the model and its key first, for example
`export AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5 OPENROUTER_API_KEY=...` (`AGENT_MODEL_BASE_URL` points it at a
gateway; the package README lists every way).

## 2. The address and the token

The server prints its address at every start, as `AGENTRUN_BASE_URL=...`. The token is made once, mode 0600, in the
data directory (`--data DIR` puts it in `DIR/.token`):

```sh
until grep -q '^AGENTRUN_BASE_URL=' serve.log; do sleep 1; done
export "$(grep -m1 '^AGENTRUN_BASE_URL=' serve.log)"
export AGENTRUN_API_KEY=$(cat ~/.local/share/agentrun/agents/.token)
until curl -sf "$AGENTRUN_BASE_URL/health" >/dev/null; do sleep 1; done
H="authorization: Bearer $AGENTRUN_API_KEY"
```

To choose the token instead, start the server with `AGENTRUN_TOKEN` set to 32 characters or more. `GET $AGENTRUN_BASE_URL/capabilities` (no token)
says which models, tools and efforts this server has.

## 3. Create an agent, run it, read the result

```sh
curl -s "$AGENTRUN_BASE_URL/agents" -H "$H" -H 'content-type: application/json' \
  -d '{"definition":{"id":"calc","version":1,"name":"Calc","instructions":"Answer the question.","tools":[],"skills":[]}}'
run=$(curl -s "$AGENTRUN_BASE_URL/agents/calc/runs" -H "$H" -H 'content-type: application/json' \
  -H "idempotency-key: $(date +%s)-calc" -d '{"input":{"content":"What is six times seven?"},"effort":"low"}' \
  | node -p 'JSON.parse(require("fs").readFileSync(0)).run_id')
until curl -s "$AGENTRUN_BASE_URL/runs/$run" -H "$H" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));process.exit(["completed","failed","cancelled","input_required"].includes(r.status)?0:1)'; do sleep 1; done
curl -s "$AGENTRUN_BASE_URL/runs/$run" -H "$H"
```

- A refused definition is `422 input_invalid` with `error.fields`, one entry per field to fix.
- `status` `completed`: the answer is `result.final_answer` (a workflow's is `result.output`). `failed`: `error` says why.
  `input_required`: the agent asked a question (its timeline's last `waiting` row); answer it with
  `curl -s "$AGENTRUN_BASE_URL/runs/$run/messages" -H "$H" -H 'content-type: application/json' -d '{"content":"..."}'`.
- Its steps: `curl -s "$AGENTRUN_BASE_URL/runs/$run/timeline?after=0" -H "$H"`, then `after=<next_after>` until a page
  is `final` with `has_more` false.
- Its files: `curl -s "$AGENTRUN_BASE_URL/runs/$run/files" -H "$H"`, then
  `curl -s "$AGENTRUN_BASE_URL/runs/$run/files/<path>" -H "$H"`. An agent writes files with the tools it names in
  `tools` (`write`, say).
- `cost.usd` is null while unknown, never $0.

## 4. Connect over MCP

The MCP endpoint is `$AGENTRUN_BASE_URL/mcp` (Streamable HTTP, JSON answers). It takes the token as a Bearer header.

```sh
claude mcp add --transport http agentrun "$AGENTRUN_BASE_URL/mcp" --header "Authorization: Bearer $AGENTRUN_API_KEY"
codex mcp add agentrun --url "$AGENTRUN_BASE_URL/mcp" --bearer-token-env-var AGENTRUN_API_KEY
```

Its tools: `list_agents`, `get_agent`, `create_agent`, `start_run`, `list_runs`, `get_run`, `get_timeline`,
`list_run_files`, `read_run_file` and `send_message`. Each calls the HTTP route that does the same, so it checks and
answers the same way: a refusal comes back as a tool error holding the route's `error`. The loop is the one above:
`create_agent`, `start_run`, then `get_run` until the status is final or `input_required`.

To check the endpoint by hand:

```sh
curl -s "$AGENTRUN_BASE_URL/mcp" -H "$H" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}'
```

## Rules

- The server listens on the loopback address only unless started with `--listen`; keep it there, or put TLS in front
  of it.
- Never print the token or write it to a file you share. A browser page from another origin cannot call `/v2/mcp`.
- The whole API is in `GET $AGENTRUN_BASE_URL/openapi.json`, and in brief at `/llms.txt` on the server's root
  (`curl -s "${AGENTRUN_BASE_URL%/v2}/llms.txt"`).
