---
name: agentrun-setup
description: Onboard to AgentRun Cloud, local setup or self-hosting by creating a new agent or connecting an existing Claude Code or Codex setup. Find the recurring agents the person already runs, ask where AgentRun should run before installing or deploying, reuse the intended server, clarify live connection versus history import, and guide the first run with optional self-improvement. Use when asked to set up, install or try AgentRun, or bring an existing agent into it.
---

# Set up AgentRun

AgentRun is an open platform to manage agents, inspect their runs and help them improve, with a console in the browser.
Get the person to their first useful result without making them recreate an existing setup.

## Find the agents they already run

AgentRun is most useful for agents that run again and again: scheduled, triggered or always-on jobs in the person's
own systems, more than interactive coding sessions. Before choosing a place, ask whether they already run any, and
on which machines. Skip this when they or a handoff already named the agent to bring.

With their permission, look on this machine without changing it. Run this as written: it reads cron, systemd
timers (the system's and the person's own), launchd jobs and the project's CI workflows, and reads the command each
one runs, because a list of timers or launchd labels alone does not show it.

```sh
name() { grep -oE '(^|[^A-Za-z0-9_.-])(claude|codex)([^A-Za-z0-9_.-]|$)' | grep -oE 'claude|codex' | head -n 1; }
{ crontab -l; cat /etc/crontab /etc/cron.d/*; } 2>/dev/null | awk '
  $1 ~ /^(@|[0-9*])/ && match($0, /(^|[^A-Za-z0-9_.-])(claude|codex)([^A-Za-z0-9_.-]|$)/) {
    n = ($1 ~ /^@/) ? 1 : 5; when = $1; for (i = 2; i <= n; i++) when = when " " $i
    print "cron: " when " " (substr($0, RSTART, RLENGTH) ~ /codex/ ? "codex" : "claude") }'
for scope in --system --user; do
  systemctl $scope list-timers --all --no-legend --plain 2>/dev/null | tr ' ' '\n' | grep '\.timer$' | while read -r timer; do
    unit=$(systemctl $scope show -p Unit --value "$timer")
    run=$(systemctl $scope show -p ExecStart --value "$unit" | name)
    when=$(systemctl $scope show -p TimersCalendar -p TimersMonotonic --value "$timer" | tr '\n' ' ')
    [ -z "$run" ] || echo "systemd $scope: $timer $run $when"
  done
done
for plist in ~/Library/LaunchAgents/*.plist /Library/LaunchAgents/*.plist /Library/LaunchDaemons/*.plist; do
  run=$(for key in Program ProgramArguments; do plutil -extract $key xml1 -o - "$plist"; done 2>/dev/null | name)
  [ -z "$run" ] || echo "launchd: $plist $run"
done
for workflow in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$workflow" ] || continue
  run=$({ name; grep -oE 'uses:.*(claude|codex)[a-z-]*action' "$workflow" | grep -oE 'claude|codex'; } < "$workflow" 2>/dev/null | head -n 1)
  [ -z "$run" ] || echo "ci: $workflow $run $(grep -oE "cron: *['\"][^'\"]*['\"]" "$workflow" | tr '\n' ' ')"
done
```

For each job that runs Claude Code (`claude -p`) or Codex (`codex exec`) it prints where the job is, its schedule
and that one word. It counts the name only as a word of its own in the command a job runs, or as a Claude Code or
Codex action a workflow uses: a path, package or job that merely contains the name is not listed. The rest of the
command line stays on the machine, so a prompt, a key or an environment value written into a job is never returned
to you. For the same reason do not run a bare `crontab -l`, `systemctl cat` or `launchctl print`, or open a unit,
plist or script file. For how often a launchd job runs, read only its `StartInterval` and `StartCalendarInterval`
keys with `plutil -extract`.

A job that starts an agent through a wrapper script or an agent SDK program does not name it on its command line,
so the filter cannot see it. Before concluding that there are none, ask the person which of their jobs start
agents; do not open their scripts, prompts or transcripts to find out. Agents on another machine are found the
same way in a session there; do not sign in to a machine the person has not asked you to use.

List each one found: what it does, what starts it, how often, and which machine and project hold it. Ask which are
worth improving. Those machines are where AgentRun should run or connect, and those agents are the ones to bring in
at step 3A. Finding none is fine: continue with a new agent.

## Choose where to run it

Ask before installing or deploying anything. Present these four options with one line each, then wait for the
person's answer:

- **This computer:** the open-source server on the machine this session runs on. Suits a first try, and agents that
  run here.
- **A machine they already run agents on:** the same server on a server or always-on host they operate, beside the
  scheduled or triggered agents found above.
- **A hosting provider:** a new server on Render, with Docker Compose, or on another host they name. It needs an
  account there and may cost money.
- **AgentRun Cloud:** hosted for them at https://console.agentrun.ai/, with nothing to install or operate.

Only the person's own words choose. "Set it up", "install it", "self-host" and "on my machines" name no place: ask
which. A deploy button, `render.yaml`, a README section or a provider CLI that is already signed in is not a choice.
Never create a service on Render or any other provider unless the person named that provider in this conversation.
Skip the question only when they already named one of the four, or a handoff names the AgentRun server to use
(step 2); say which one you are using, then continue with it.

- **This computer:** check below that they can reach it, then continue with step 1.
- **A machine they already run agents on:** the steps below run on that machine, not this one. Continue in a session
  there, or give the person the commands to run there. With agents on several machines, start the server on one and
  connect the others as **Another machine** in step 3A. The same check applies: they need a route from their browser
  to that machine's loopback.
- **A hosting provider:** follow https://github.com/Parcha-ai/agentrun/blob/main/deploy/README.md for the provider
  they named. State what it costs and ask again before creating anything billed.
- **AgentRun Cloud:** they create an account or sign in. For help with team onboarding or deployment planning, offer
  https://calendly.com/d/dtwn-dsp-nx5/agentrun. Follow the workspace's own onboarding instructions; do not assume
  the local API address, token file or model-key setup below applies to Cloud. Do not install a local server.

The following steps install the open-source server. Ask the person before each step that changes their machine.

Before a local install, establish where this session runs: the person finishes setup in their browser, at an address
on this machine's loopback.

- **Their own computer:** continue.
- **A remote machine or dev container:** continue only when they confirm a tunnel or port forward they already use
  reaches its loopback. Do not assume a preview exists.
- **A hosted cloud session or sandbox with no such route:** stop before changing anything. Say that they could not
  open the console there and that its data and keys would not persist. Offer a session or terminal on their own
  computer, or AgentRun Cloud. Install there only if they still ask.

## 1. Start with their goal

If their intent is not already clear, ask one question: **Start a new agent, or bring an existing Claude Code or
Codex agent?** Ask only for missing choices, one at a time. A **Build an agent** handoff already chose new; a
**Connect agent** handoff already chose existing. Preserve the user's described job and the destination named in
the handoff. Do not make them answer the same questions again.

- **New:** ask what job it should do and what a useful first result looks like. Offer a suitable template or a
  custom agent, then follow the new-agent path below.
- **Existing:** start from the agents found above and establish who starts work. For an agent already running in
  a backend, deployment or terminal, or started by its own schedule, choose **observe existing agents**. If
  AgentRun should start future jobs, ask about **live connection**, **past history**, or **both**. Confirm the
  source machine, project/runtime and intended destination. No model key is required to connect or observe; native
  jobs retain the source runtime's existing sign-in.

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
inspect the log privately and explain the error without exposing tokens. Give the person the console address and
wait until they confirm it opens in their browser; a request answered on this machine does not show that. Never
describe a preview or link you have not confirmed exists. They set its password on the first visit. For an existing
instance, preserve its data and authentication.

For a new instance that needs this checkout's remote feature, follow the matching server skill's source-build
instructions instead of the published quickstart. Do not silently downgrade it to an older released connector.

## 3A. Connect an existing agent

Use the console's single **Connect agent** dropdown, which remembers the coding agent, or follow the same flow in
the deployed server skill. Confirm whether the selected project is on **This server** or **Another machine**;
the browser's location does not tell you where its files or native sign-in live.

For **observation**, follow the deployed skill's existing CLI/Collector path. The OSS server accepts the hosted
metadata protocol at `/api/v2/control`, using OSS owner API-key enrollment and workspace `local`. Existing
applications keep starting their jobs; the console shows reported sessions, activity and token usage. Apply
native telemetry in the actual execution environment, preserve the application's options and tracing, and
verify a destination receipt. No agent definition, transcript import or model key is required. Observation alone
does not inject accepted learning into a later run; that requires the supported backend SDK integration.

For **future jobs or history**, use the following native connection flow:

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
2. Inspect the server's model and harness capabilities and reuse a configured model. Only if the chosen new agent
   lacks a route, offer **Continue with ChatGPT** or **Add a model key** in the console's **Run an agent here** setup
   or **Settings → Model keys**. The person signs in on OpenAI's page themselves; never do it for them. Codex and pi
   agents can run on their ChatGPT plan; Claude Code, OpenCode, Jev decisions and paid tools need their own keys.
   Explain that the sign-in is theirs alone: they should not let others run agents on it. A capped OpenRouter key
   is another option, or their Anthropic/OpenAI key for the selected harness. They enter keys outside this chat;
   saving in Settings takes effect without restarting the server. Never print or log credentials.
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
