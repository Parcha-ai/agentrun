---
name: agentrun-setup
description: Onboard to AgentRun by creating a new agent or connecting an existing Claude Code or Codex setup, locally or from another machine. Reuse the intended server, clarify live connection versus history import, and guide the first run with optional self-improvement. Use when asked to set up, install or try AgentRun, or bring an existing agent into it.
---

# Set up AgentRun

AgentRun is an open platform to manage agents, inspect their runs and help them improve, with a console in the
browser. Get the person to their first useful result without making them recreate an existing setup.

## 1. Start with their goal

If their intent is not already clear, ask one question: **Start a new agent, or bring an existing Claude Code or
Codex agent?** Ask only for missing choices, one at a time. A **Build an agent** handoff already chose new; a
**Connect agent** handoff already chose existing. Preserve the user's described job and the destination named in
the handoff. Do not make them answer the same questions again.

- **New:** ask what job it should do and what a useful first result looks like. Offer a suitable template or a
  custom agent, then follow the new-agent path below.
- **Existing:** ask whether they want to **connect for future runs**, **import past history**, or **both**. Then
  confirm the source machine, project and runtime, and follow Connect an existing agent below. No destination model
  key is required for connection or history import; live jobs use the source runtime's existing sign-in.

Work within the setup and actions already requested. Explain any missing decision before acting. Do not enable
learning, transfer history or install a persistent service just because the user asked to connect.

## 2. Reuse or start the intended server

Use the named AgentRun URL, configured `AGENTRUN_BASE_URL`, or existing local CLI configuration first. Check its
`/v2/health`, `/v2/capabilities` and `/v2/openapi.json`, using the existing credential where required. If the named
server is unavailable, diagnose it; do not silently create a replacement on another port or in another data folder.

Read **that server's** `/skills/agentrun-serve/SKILL.md` for its supported setup and commands. The matching skill
takes precedence over examples from a different release. The remote connector currently requires the server,
Python connector and Node bridge from the same reviewed development checkout; the published observation-only
CLI does not include remote native execution. Read `connector/README.md` in that matching checkout for installation;
do not assume sibling files exist beside a downloaded copy of this skill.

Only when they want a new local instance, check `node --version` is 24.22.3 or newer. With nvm, install that version
using `nvm install 24.22.3 && nvm use 24.22.3`. For the published new-agent quickstart:

```sh
umask 077
npx @parcha/agentrun --no-open > agentrun.log 2>&1 &
agentrun_setup_pid=$!
for i in $(seq 600); do
  grep -q 'AgentRun is running at' agentrun.log && break
  kill -0 "$agentrun_setup_pid" 2>/dev/null || break
  sleep 1
done
grep 'AgentRun is running at' agentrun.log || { echo 'AgentRun did not start; inspect its private log.'; exit 1; }
```

It keeps its data in `~/.agentrun` and takes the first free port from 7340 on this machine's loopback. If it did not start,
inspect the log privately and explain the error without exposing tokens. Give the person the console address;
they set its password on the first visit. For an existing instance, preserve its data and authentication.

For a new instance that needs this checkout's remote feature, follow the matching server skill's source-build
instructions instead of the published quickstart. Do not silently downgrade it to an older released connector.

## 3A. Connect an existing agent

Use the console's single **Connect agent** dropdown, which remembers the coding agent, or follow the same flow in
the deployed server skill. Confirm whether the selected project is on **This server** or **Another machine**;
the browser's location does not tell you where its files or native sign-in live.

1. Discover only the chosen project and runtime. Present its project default, Claude Code named agents or Codex
   profiles, and connect only the selected setup. Preserve its instructions, tools, skills, MCP, model, permissions
   and sign-in. Verification checks configuration and sign-in without making a model call.
2. On another machine, use the matching Python CLI and Node bridge from the reviewed checkout. In **Connection
   setup → Another machine**, create a one-use code with **Live agent**, **History only** or **Both** scope. Enter
   it in the source CLI's secure prompt, never in this chat, an argument or a URL. The source gets only a restricted
   connector credential. Keep the outbound source worker online for future live jobs; no persistent service is
   installed automatically.
3. For history, preview the selected project/runtime and confirm its destination and scope before upload. The
   source must opt into `--history-only` or `--history` as well as using a code that allows it. Imported completed
   sessions remain historical; they do not attach a live desktop conversation or become automatic learning.
   Repeating an approved import skips duplicates. Follow the server skill's maintenance-window procedure for a
   local-store import; do not stop a user's server just to take over its store.
4. For a live connection, open the agent and verify its setup and remote-worker status. Run the first requested
   task and show its result in the console. For history-only onboarding, show the imported Runs and counts instead;
   do not ask for a model key or launch a worker.

The server skill and `docs/native-agents.md` in its matching checkout describe supported native connections.
Imported configurations remain references to the source machine, not recreated agents with copied credentials.
Native permissions remain in charge; do not bypass them or promise unsupported native spend caps, interactive
approval handling or learned workflows.

## 3B. Start a new agent

1. Inspect existing agents and available templates first. Offer the closest useful template, or **Build an agent**
   for a custom job. Ask for only the missing inputs, expected result and tools or connections the job needs. Reuse
   a suitable existing agent when the user wants it; do not create duplicates.
2. Inspect the server's model and harness capabilities. Reuse a configured model; only if the chosen new agent
   lacks a route, have the person add an appropriate key in **Settings → Model keys**, outside this chat. A capped
   OpenRouter key is one option, or their Anthropic/OpenAI key for the selected harness. Saving it there takes
   effect without restarting the server. Never print or log credentials.
3. Follow the deployed server skill to apply the chosen template or create the custom definition using supported
   tools and schemas. Use the existing MCP connection or authenticated API/CLI. Install MCP only for the coding
   agent the person chose, if needed; do not configure both tools automatically. Check the identity and destination
   before writing. For templates, explain the tool grants and triggers and confirm any permissions the user has
   not already granted before applying.
4. Start one requested example job with the inputs and permissions agreed on. Follow it to a real result, surface
   failures or approval requests, and link its `console_url`. A successful registration alone is not a successful
   first run. Never invent a result or silently retry an uncertain external effect.

## 4. Finish in the console, then offer learning

Show where to find the agent in **Connected agents**, live and completed work in **Mission Control / Runs**, and
the result of their first task or history import. State what is connected and what remains untested. For a remote
agent, point out that its worker must remain online and how to revoke the connection.

For a live agent, offer **Self-improving** as a separate choice. When requested, turn it On, run a useful task, and
inspect proposed notes or skills after checking and grading in **Learning Dojo**. A fresh next run should use the
accepted learning revision. Risky proposals await owner review; rejected proposals are not bypassed. Reflection
and grading add model usage. Turning learning Off stops supplying and creating AgentRun learning on later runs.
History-only imports do not enter this loop.

For supported commands, authentication and troubleshooting, read the target server's
`/skills/agentrun-serve/SKILL.md`. If unavailable, read `packages/serve/skills/agentrun-serve/SKILL.md` in the
matching checkout; do not substitute a skill from another release.
