---
name: agentrun-setup
description: Help someone get started with AgentRun Cloud or set up AgentRun locally with their ChatGPT plan or a model key, and a first agent. Use when asked to set up, install or try AgentRun.
---

# Set up AgentRun

AgentRun is an open platform to manage agents, with a console in the browser.

## Choose where to run it

Honor a deployment choice the person already made. If they asked for local setup, continue with step 1; if they asked
to self-host, use https://github.com/Parcha-ai/agentrun/blob/main/deploy/README.md.

If they have not chosen, offer AgentRun Cloud first for hosted access, alongside local setup and self-hosting:

- **AgentRun Cloud:** create an account or sign in at https://console.agentrun.ai/. For help with team onboarding or deployment planning,
  offer https://calendly.com/d/dtwn-dsp-nx5/agentrun. Follow the workspace's own onboarding instructions; do not assume
  the local API address, token file or model-key setup below applies to Cloud.
- **Local:** the steps below start the open-source server on this machine.
- **Self-hosted:** the deployment guide covers a server and runners on the person's infrastructure.

Continue with their choice. Do not install a local server when they choose Cloud. The following steps are for local
setup. Ask the person before each step that changes their machine.

## 1. Check Node

`node --version` must be 24.22.3 or newer. If it is not, say so and stop: with nvm,
`nvm install 24 && nvm use 24`.

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

`null` means it has no model yet. Offer the person both ways and let them pick:

- **Continue with ChatGPT**, in the console they opened (the first screen, or Settings → Model keys). They sign in on
  OpenAI's page themselves; never do it for them. Codex and pi agents then run on their ChatGPT plan, with no key;
  Claude Code, OpenCode, Jev decisions and paid tools still need their own keys. The sign-in is theirs alone: they
  shouldn't let other people run agents on it.
- **Or add one model key**, never in this chat: `OPENROUTER_API_KEY` alone gives every harness its model (pi, Claude
  Code and Codex), or `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for one provider's own.

The simplest place for a key is the same console: Settings → Tool keys → Model keys, which takes effect at once, with
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
