---
name: agentrun-setup
description: Set up AgentRun, an open-source platform for running agents, and get the person to a finished first run in about five minutes. Ask where it should run before touching anything (this computer, their own always-on machine over Tailscale, Railway, Render or AgentRun Cloud), say so up front when this session is a hosted cloud session their browser can't reach, connect a model with Continue with ChatGPT or a key, then create a first agent through the API and run it on their OK. Afterwards, offer to bring in agents they already run. Use when asked to set up, install or try AgentRun.
---

# Set up AgentRun

AgentRun is an open-source platform for running agents: a console in the browser, runs that survive a restart, a
spend cap on every run, and agents that learn from their own runs. Your job is to get the person from this prompt to a
finished first run in about five minutes. They should not have to install Node, type commands in a Terminal or go
looking for a key. You are their setup assistant; which harness their agents use is chosen in AgentRun, not by you.

Ask before each step that changes anything. Never ask for a password, key or token in this chat, never print one, and
never put one on a command line.

## 1. Look at this session

Before asking anything, run this. It only reads, and prints the names of the signals it finds, never their values:

```sh
uname -s
for name in CLAUDE_CODE_REMOTE CODESPACES GITPOD_WORKSPACE_ID SSH_CONNECTION DISPLAY WAYLAND_DISPLAY; do
  [ -n "$(printenv "$name")" ] && echo "set: $name"
done
{ [ -f /.dockerenv ] || [ -f /run/.containerenv ]; } && echo "in a container"
```

Read it like this:

- `CLAUDE_CODE_REMOTE` (Claude Code's cloud sessions: on the web, in the desktop and mobile apps, and
  `claude --cloud`): a **hosted cloud session**. The person's browser can't open anything on its loopback, and
  whatever is installed here is gone when the session ends.
- Linux in a container, with no `DISPLAY` or `WAYLAND_DISPLAY` and none of the signals below (a Codex cloud task
  looks like this): most likely a hosted sandbox too. Ask the person to confirm.
- `CODESPACES` or `GITPOD_WORKSPACE_ID` (GitHub Codespaces, Ona): a remote dev environment that forwards ports to
  the browser. **This computer** works here only through that forward, and only while the environment runs; ask them
  to confirm they can open forwarded ports. A local dev container forwards them too.
- `SSH_CONNECTION`: a remote machine. **This computer** works only through a tunnel they already use (`ssh -L`).
- macOS, or Linux with a display and none of the above: their own computer. Anything else: ask whether this is
  their own computer.

In a hosted cloud session or sandbox, say so first, in one or two sentences, before the question below: AgentRun
installed here could not be opened from their browser, and its data and keys would vanish with the session. Recommend
AgentRun Cloud or a one-click deploy (Railway or Render), or opening a session on their own computer and pasting this
prompt there. Install here only if they still ask after that.

## 2. Ask where AgentRun should run

Ask this before any install or deploy command, then wait for the answer. Show the five places with their cost:

- **This computer:** free. One command, and the console opens in your browser.
- **My always-on machine, private:** free. The same install on a machine you keep on, reached from your phone and
  laptop over your own Tailscale network; nothing is on the internet.
- **Railway:** usage-priced, about $5 a month for a small server (Railway's Hobby plan is $5 a month and includes $5
  of usage).
- **Render:** about $27.50 a month: the 1 CPU / 2 GB plan at $25 and a 10 GB disk at $2.50. Agents get no shell there
  today.
- **AgentRun Cloud:** nothing to install, at https://console.agentrun.ai/. Cost: pricing on the site.
  <!-- PRICE: to be filled in before release -->

Only the person's own words choose. "Set it up", "install it" and "self-host" name no place: ask. A provider CLI that
is signed in, a deploy button, `render.yaml` or a README section is never a choice. Never create a service on a
provider the person did not name in this conversation, and before creating anything billed, state its cost and ask
again. Skip the question only when they already named one of the five places, or named an AgentRun server to use
(then check its `/v2/health` and `/v2/capabilities` and go to step 4).

## 3. Start it where they chose

### This computer

First look for a server that already runs here, and reuse it rather than starting another:
`curl -fsS http://127.0.0.1:7340/v2/health`, `AGENTRUN_BASE_URL`, or a `~/.agentrun` folder. Never overwrite,
migrate or delete an existing data folder.

<!-- INSTALLER: the one-command installer replaces the Node check and the npx start below once it ships. -->
The published launcher needs Node.js 24.22.3 or newer (`node --version`). If Node is missing or older, say so plainly in
one sentence and offer, in this order: AgentRun Cloud or a one-click deploy, or, with their OK, installing Node 24.22.3
with a version manager they already use (`nvm install 24.22.3`). Do not hand them Terminal steps to follow.

With their OK, start it in the background and wait for its address:

```sh
umask 077
npx --yes @parcha/agentrun@0.4 --no-open > agentrun.log 2>&1 &
agentrun_setup_pid=$!
for i in $(seq 600); do
  grep -q 'AgentRun is running at' agentrun.log && break
  kill -0 "$agentrun_setup_pid" 2>/dev/null || break
  sleep 1
done
grep 'AgentRun is running at' agentrun.log || { echo 'AgentRun did not start; inspect its private log.'; exit 1; }
```

It keeps its data in `~/.agentrun` and takes the first free port from 7340 on this computer's loopback. If it did not
start, read the log yourself and explain the error without quoting a token. Give the person the address it printed and
wait until they say it opens in their browser; a request you make from here does not show that. They set the owner
password on the first visit; this local start asks for no setup code. It keeps running until this computer restarts;
the same command starts it again on the same data.

### My always-on machine, private

The install runs on that machine, not here: continue in a session there, or in an SSH session they already use. It
needs Tailscale on that machine, signed in to their own tailnet. Read its name with
`tailscale status --json | jq -r .Self.DNSName` (for example `box.example-tailnet.ts.net.`), then start AgentRun as
under **This computer** with `AGENTRUN_PUBLIC_URL=https://<that name>/` in front of `npx`, and with their OK share it
on the tailnet only:

```sh
tailscale serve --bg 7340
```

Use the port AgentRun printed. Never use `tailscale funnel`, which puts it on the internet. They open
`https://<that name>/` from any of their devices on the tailnet. A server with a public address asks for a setup code
on the first visit; **The setup code** below says where to find it.

### Railway

<!-- RAILWAY: the template's deploy button replaces these steps once it is published. -->
The person deploys it from their own Railway account, in their browser: a new service from the image
`ghcr.io/parcha-ai/agentrun-server:beta`, a volume mounted at `/data`, a public domain, and the variables
`PORT=7340`, `AGENTRUN_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` and `AGENTRUN_SEAL_KEY` set to a random value
they generate there and keep. Walk them through it; never create the service yourself with a Railway CLI. Its agents
get file tools and `web_fetch`, no shell.

### Render

The person opens https://render.com/deploy?repo=https://github.com/Parcha-ai/agentrun in their browser and confirms the
plan Render shows them; it reads the repository's `render.yaml` (the published image, the 1 CPU / 2 GB plan and a 10 GB
disk). Its agents get no shell today.

### AgentRun Cloud

They open https://console.agentrun.ai/ and create an account or sign in, then follow the workspace's own onboarding.
Install nothing locally. The local address, token file and model-key steps below don't apply to Cloud. For team
onboarding or deployment planning, offer https://calendly.com/d/dtwn-dsp-nx5/agentrun.

### The setup code

A server at a public address (Railway, Render, a tailnet name, any `AGENTRUN_PUBLIC_URL`) asks for a **setup code**
before it takes the first password; its `GET /v2/auth/session` answers `setup_code: true`. The console never shows the
code. In the same message as the console address, tell the person where it is:

- **Render:** the service's **Environment** tab holds `AGENTRUN_TOKEN`; they paste its value into **Setup code**.
- **Railway, a tailnet machine, Docker or a terminal:** the server's log (Railway's deploy logs, `docker logs`, or
  the terminal it runs in) has a line `Set up this server: <address>/setup#code=<code>`. The newest one counts.

When you can read that log yourself, read it privately and give them the newest `Set up this server:` link itself: it
opens the page with the code filled in. Never put the API token (`AGENTRUN_TOKEN`, or `.token` in the data folder) in
the chat; name where it is. The message that hands over the link or the code's place says that the link works
**once**, that it **expires 30 minutes** after the server printed it (give the clock time when you can tell), and that
once it has expired they press **Get a new code** under the field and use the newest line, or ask you. To renew it for
them, never restart the server: read the log for the newest line, or send
`curl -sS -X POST "$CONSOLE_ADDRESS/v2/setup/code"`, which takes no credential and answers
`{"printed": true|false, "expires_at": "<time>"}`, never the code. A 403 means the owner is already set. A server from
an older release answers 404 and has no **Get a new code** button: restarting it prints a new code.

## 4. Connect a model

Check what the server already has and reuse it: `npx --yes @parcha/agentrun@0.4 server capabilities` (or
`GET /v2/capabilities`). When its `models.ready` is true, go to step 5.

Otherwise the first offer is **Continue with ChatGPT**: the person opens `<console address>/#/settings/keys`
(Settings → Model keys), presses **Continue with ChatGPT** and signs in on OpenAI's page themselves. pi and Codex
agents then run on their ChatGPT plan, with no key. On a server that isn't this computer, the sign-in tab ends on a
page that won't load: they copy that page's whole address into the console. The sign-in is theirs alone; they should
not let others run agents on it.

The fallback is a key, saved in the same place: a capped OpenRouter key, or an Anthropic or OpenAI key. They type it
into the console, never into this chat. A saved key works without a restart. When they say it's done, read the
capabilities again and confirm `models.ready`.

## 5. Create the first agent and run it

Check `npx --yes @parcha/agentrun@0.4 agents list` first and reuse a `release-notes` agent if there is one. Otherwise,
with the person's OK, create a small agent with no tools:

```sh
npx --yes @parcha/agentrun@0.4 agents create --body '{"definition":{"id":"release-notes","name":"Release notes","harness":"pi","max_cost_usd":0.25,"instructions":"Write concise release notes from the changes you are given. Group them under Added, Changed and Fixed. Do not invent changes."}}'
```

Tell them what it runs on: the model (`models.default` in the capabilities, and whether it bills their ChatGPT plan or
a key) and the cap, $0.25 for the run. Ask "Start the first run?" and wait. On their OK:

```sh
npx --yes @parcha/agentrun@0.4 runs start release-notes --wait --timeout 300 --body '{"input":{"content":"Write release notes: added CSV export to the runs page; fixed the date filter resetting after refresh; renamed workspace settings to Settings."}}'
```

It prints the run once it ends: its `status`, `result.final_answer`, `cost.usd` and `console_url`, the run's page in the
console. Show them the answer and the cost, and give them the `console_url` link to the finished run. A run that waits
on its spend cap (`status` `input_required`, `pending.kind` `budget`) is theirs to raise in the console: link it, don't
raise it. A failed run: show its `error`, and never retry silently.

These commands find the server on this computer by its data folder. A server elsewhere needs `--base-url
<address>/v2` and its API token, which the person keeps with `npx @parcha/agentrun@0.4 login --base-url <address>/v2`
in their own terminal (it reads the token on standard input, never from this chat). If they would rather not, they
apply **KYB due diligence** from **Templates** in the console and start its run there.

## 6. Hand over

Report what is ready and what actually ran: the console address, the link to the finished run, its cost, the data
folder (`~/.agentrun` on this computer) and the server version (`server.version` in the capabilities). If a step is
still pending (the model, the first run), say so. Then offer two next steps, each a choice of its own:

- **Learning:** the agent learns from its runs. Open its **Learning** tab, run a useful task again, and look at the
  notes and skills it proposes after checking and grading. Reflection and grading add model usage. Risky proposals
  wait for the owner's review.
- **Bring agents they already run:** step 7.

## 7. Bring agents they already run

AgentRun is most useful for agents that run again and again: scheduled, triggered or always-on jobs in the person's
own systems, more than interactive coding sessions. Ask whether they already run any, and on which machines.

With their permission, look on this computer without changing it. Run this as written: it reads cron, systemd
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
worth bringing in. Finding none is fine.

### Connect an existing agent

Use the console's **Connect agent** dropdown, or the same flow in the server's own skill
(`<console address>/skills/agentrun-serve/SKILL.md`: it matches that server's release, so it wins over examples from
another one). Confirm whether the project is on **This server** or **Another machine**; the browser's location does not
tell you where its files or native sign-in live. Ask who starts the work:

- **Observe:** the application, deployment or terminal keeps starting its jobs, and the console shows their sessions,
  activity and token usage. Follow the server skill's CLI/Collector path; the open-source server takes it at
  `/api/v2/control` with the owner's API key and workspace `local`. No agent definition, transcript import or model
  key is needed. Observation alone does not feed accepted learning into later runs.
- **Future jobs, history, or both:** discover only the chosen project and runtime, and connect only the setup they
  pick (its project default, a Claude Code named agent or a Codex profile), keeping its instructions, tools, skills,
  MCP, model, permissions and sign-in. On another machine, create a one-use code in **Connection setup → Another
  machine** with **Live agent**, **History only** or **Both** scope; the person enters it in the source CLI's secure
  prompt, never in this chat, an argument or a URL. For history, preview the project and confirm its destination and
  scope before upload; imported sessions stay historical. For a live connection, run the first requested task and show
  its result in the console. A remote worker must stay online; say how to revoke it.

The remote connector needs the server, Python connector and Node bridge from the same reviewed checkout; read
`connector/README.md` and `docs/native-agents.md` there. Native permissions stay in charge: don't bypass them or
promise native spend caps, interactive approvals or learned workflows the server skill does not list. Do not enable
learning, transfer history or install a persistent service just because they asked to connect.
