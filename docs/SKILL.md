---
name: agentrun-setup
description: Set up AgentRun on this machine with one command, give it a model key, and make and run a first agent. Use when asked to set up, install or try AgentRun.
---

# Set up AgentRun

AgentRun is an open platform to manage agents: one server on this machine keeps your agents and every run of them,
with a console in the browser. Ask the person before each step that changes their machine.

## 1. Check Node

`node --version` must be 22.19 or newer on 22, or 24.2 or newer. If it is not, say so and stop: with nvm,
`nvm install 22 && nvm use 22`.

## 2. Start it

```sh
npx @parcha/agentrun --no-open > agentrun.log 2>&1 &
pid=$!
for i in $(seq 600); do
  grep -q 'AgentRun is running at' agentrun.log && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
grep 'AgentRun is running at' agentrun.log || { echo "AgentRun did not start:"; tail -20 agentrun.log; }
```

It keeps its data in `~/.agentrun` and takes the first free port from 7340 on this machine's loopback. If it did not start,
its last lines say why: tell the person, and stop. Give the person the address it prints; they open it in their browser and set the console's password on the first visit.

## 3. Give it a model

```sh
curl -s "$(grep -o 'http://[^/ ]*' agentrun.log | head -1)/v2/capabilities" | node -p 'JSON.parse(require("fs").readFileSync(0)).models.default'
```

`null` means it has no model yet. Ask the person to add one model key, never in this chat: `OPENROUTER_API_KEY` alone
gives every harness its model (pi, Claude Code and Codex), or `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for one
provider's own. The simplest place is the console they opened: Settings → Tool keys → Model keys, which takes effect at once, with
no restart. Or they set it in the shell that starts AgentRun, then stop it (`kill %1`, or the PID you started) and start
it again as in step 2. Never print, echo or write a key anywhere. Started this way, the
person's shell and npm keep the keys they exported in their environment, as they always do; the server itself, and its
runs, hold none.

## 4. Make an agent and run it

The person can do it in the console: **New agent**, then **Start a run** on its page. To do it for them, read the
token without printing it, and connect over MCP:

```sh
export AGENTRUN_API_KEY=$(cat ~/.agentrun/.token)
export AGENTRUN_BASE_URL="$(grep -o 'http://[^/ ]*' agentrun.log | head -1)/v2"
claude mcp add --transport http agentrun "$AGENTRUN_BASE_URL/mcp" --header "Authorization: Bearer $AGENTRUN_API_KEY"
codex mcp add agentrun --url "$AGENTRUN_BASE_URL/mcp" --bearer-token-env-var AGENTRUN_API_KEY
```

Call `whoami`, then `agents_create` with a `name`, `instructions` and `tools` the person agreed to, then `runs_start`
with `{"agent_id": "...", "input": {"content": "..."}}`, and `runs_get` every few seconds until it ends. Tell the
person the result and give them its `console_url`.

For everything else (the tools, the `/v2` API, answering a run's question), read the server's own skill:
https://github.com/Parcha-ai/agentrun/blob/main/packages/serve/skills/agentrun-serve/SKILL.md
