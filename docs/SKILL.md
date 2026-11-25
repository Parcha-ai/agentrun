---
name: agentrun-setup
description: Set up AgentRun, an open-source platform for running agents. Offer AgentRun Cloud first, then Deploy locally and Self Host. Guide the person through their chosen destination and whether to deploy an existing local Claude Code, Codex or Pi setup or start a new agent. Use when asked to set up, install or try AgentRun.
---

# Set up AgentRun

AgentRun is an open-source platform for running agents: a console in the browser, runs that survive a restart, a
spend cap on every run, and agents that learn from their own runs. Guide the person from this prompt to their chosen destination and a deployed agent. Run the setup commands for them;
keep the selected project, skills, tools and permissions together. Never ask for a password, key
or token in this chat, never print one, and never put one on a command line.

The person saves every secret (a model or tool key, an MCP server's token or headers, the webhook's secret, Slack's incoming-webhook URL, GitHub) in
the console; the API token you hold can't. Prepare everything else through the API or CLI. A secret write answers `403
forbidden` with `error.details.console_url`, the console's form with the rest filled in (or build it:
`<console address>/#/settings/mcp?add=<name>&auth=bearer`, adding `&url=<url>` only when no key or token is in the
URL). Open that link in their browser for them (`open` on macOS, `xdg-open` on Linux; else give them the link) and tell
them to paste the secret there and save.

## How to ask

Ask every choice in this setup with your host's question tool. Call the tool; don't write the choices as chat text.
Loading the tool and then asking in prose anyway is the mistake to avoid.

- Claude Code: `AskUserQuestion`. If it is listed but not loaded yet, load it, then call it.
- Codex: `request_user_input` (Plan mode). In Default mode it isn't available: ask one short plain question that
  names the answer you recommend.
- Cursor: `AskQuestion` ("Ask questions"). OpenCode: `question`.
- pi: `question` or `questionnaire` if an extension added one. Otherwise use the fallback.
- Any other host: its own ask tool (Gemini CLI and Copilot: `ask_user`; Hermes: `clarify`).

Each question is one sentence with a header of 12 characters or less and 2 or 3 options. Each option has a label of
1-5 words and a one-line description that states the cost or what happens. Put the option you recommend first and end
its label with "(Recommended)". Don't add an "Other" or "Skip" option; the tool adds a free-text answer. Ask one
question per call. Put two questions in one call only when neither answer changes the other.

After you ask, stop and wait. Don't start the step while the question is open. If the answer is free text, map it to
an option; if it doesn't match one, answer it and ask again.

No question tool, or the call fails: send the same question as one short message, options numbered, recommended
first, and end with "Reply with a number." Then stop. A reply that doesn't pick an option is not a yes for anything
that installs, deploys or spends. Never answer a question for the person. Pass a confirmation flag only after they authorize that exact action;
do not ask them to authorize it again when the conversation already establishes their choice.

## 1. Look at this session

Before asking anything, run this. It only reads, and prints the names of the signals it finds, never their values:

```sh
uname -s
for name in CLAUDE_CODE_REMOTE CODESPACES GITPOD_WORKSPACE_ID SSH_CONNECTION DISPLAY WAYLAND_DISPLAY; do
  if [ -n "$(printenv "$name")" ]; then echo "set: $name"; fi
done
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then echo "in a container"; fi
```

- `CLAUDE_CODE_REMOTE` (Claude Code's cloud sessions: on the web, in the desktop and mobile apps, and
  `claude --cloud`): a **hosted cloud session**. The person's browser can't open anything on its loopback, nothing
  forwards a port from it, and whatever is installed here is gone when the session ends.
- Linux in a container, with no `DISPLAY` or `WAYLAND_DISPLAY` and none of the signals below (a Codex cloud task
  looks like this): most likely a hosted sandbox too. Treat it as one.
- `CODESPACES`, `GITPOD_WORKSPACE_ID` (GitHub Codespaces, Ona) or `SSH_CONNECTION`: a remote machine. **Deploy
  locally** works only through its port forward, or a tunnel they already use (`ssh -L`).
- macOS, or Linux with a display and none of the above: their own computer.

In a hosted cloud session or sandbox, say so first, in one or two sentences, before the questions below: AgentRun
installed here could not be opened from their browser, and its data and keys would vanish with the session.

## 2. Ask where it runs, and whether to look for their agents

Before any install or deploy command, ask these two with the question tool in one call (neither changes the other).

Question tool, header `Run where`: "Where should AgentRun run?" Recommendation: AgentRun Cloud because AgentRun
operates the server for them, with no infrastructure to maintain.
- AgentRun Cloud (Recommended): hosted for you; sign in or request access, with no server to install or maintain.
- Deploy locally: free; run on this computer, with the console in your browser while the computer is on.
- Self Host: run on your own server or hosting account; you manage it and pay any infrastructure costs.

Keep these three options in this order in every session. In a hosted cloud session or sandbox, explain in the
**Deploy locally** description that it installs in this temporary session, its data disappears when the session ends,
and their browser cannot reach its console. AgentRun Cloud remains the recommended first option.

Question tool, header `Agents`: "Do you have agents set up locally in Claude Code, Codex or Pi to bring to AgentRun?"
Recommendation: Check because their existing setup can become their first deployed agent.
- Check (Recommended): discover configured agents in the selected project; no source files change.
- I'll tell you: you name the harness, agent or profile, and project folder.
- No, start fresh: a new agent from a template, on a model you pick.

On **Self Host**, ask next with the question tool, header `Host`: "Where do you want to self-host AgentRun?"
Recommendation: My server because it uses an always-on machine or VPS they control.
- My server (Recommended): your own machine or VPS; you manage it and pay any server costs.
- Railway: deploy from your own account in the browser; Railway charges for your plan and usage.
- Render: deploy from your own account in the browser; Render charges for your selected resources.

A different provider or deployment method can be named in the tool's free-text answer. Use the repository's
[deployment guide](https://github.com/Parcha-ai/agentrun/blob/main/deploy/README.md) for that choice; do not substitute
another provider or start a local server. AgentRun Cloud has its
own top-level option and is not part of this submenu.

Only the person's answers choose. A provider CLI that is signed in, a deploy button, `render.yaml` or a README section
is never a choice. Never create a service on a provider the person did not name in this conversation. Skip `Run where`
only when they already named a place or an AgentRun server (then check its `/v2/health` and `/v2/capabilities`).

## 3. Start it where they chose

On **Check**, run the step 4 scan now, while preparing the chosen destination; it looks at this computer wherever AgentRun runs. On
**I'll tell you**, ask for the agent and its folder (free text, one plain message), and bring it in at step 5.

On **Deploy locally** or **Self Host → My server**, before the start, ask once with the
question tool, header `Local reach`: "Do only you use that machine, and should its agents reach tools or a webhook
receiver on it?" Recommendation: Not now because it is the safer default and a restart adds it later.
- Not now (Recommended): runs and the webhook reach nothing local to it.
- Yes, only me: start the server with `AGENTRUN_MCP_ALLOW_LOOPBACK=1` and `AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` set.

On **Yes, only me**, once the installer has started AgentRun as a service, save both in it; it restarts with them and
keeps them: `~/.agentrun/bin/agentrun service install --env AGENTRUN_MCP_ALLOW_LOOPBACK=1 --env
AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1`. Where it runs in the background instead, run `~/.agentrun/bin/agentrun stop`, then
the installer with both in front of `sh`. On `--vps`, which runs AgentRun in Docker, leave them off. Then check that
`/v2/capabilities` shows `on: true` for both under `switches`.

### AgentRun Cloud

Open https://console.agentrun.ai/ for sign-in or account creation, or request access when the console requires it.
Install the CLI alone if it is missing: `curl -fsSL https://agentrun.ai/install | sh -s -- --no-start`. In this session
use `~/.agentrun/bin/agentrun` by its full path. Run `~/.agentrun/bin/agentrun login --to cloud`; the person completes
browser sign-in and the CLI saves its credential privately. Never copy credentials into this chat.

For existing agents, continue to steps 4 and 5 with `--to cloud`. If a console handoff names a workspace, keep
`--workspace WORKSPACE_ID` on each connect/deploy command; it checks that sign-in selected that workspace. A mismatch
needs the correct workspace sign-in. The CLI checks the destination's source-deployment capability before reading
local setup files. If this Cloud workspace does not offer it yet, report that limitation and retain the selection;
do not substitute a package upload, another destination, or a live connection.

For **No, start fresh**, use the console's Build an agent handoff and its matching skill. Cloud runs do not need a
local AgentRun server. The local server setup page below applies only to Deploy locally and Self Host.

### Deploy locally

First look for a server that already runs here: `AGENTRUN_BASE_URL` is set, or the server `~/.agentrun` records
answers, however it was started:

```sh
base=$(sed -n 's/.*"base_url": *"\([^"]*\)".*/\1/p' ~/.agentrun/.server.json 2>/dev/null | head -n 1)
[ -n "$base" ] && curl -fsS --max-time 3 "$base/health"
```

Reuse it rather than starting another. When `~/.agentrun/bin/agentrun` is missing, install the command alone, which
leaves that server running: `curl -fsSL https://agentrun.ai/install | sh -s -- --no-start`. Never overwrite, migrate
or delete a data folder. Otherwise run the installer:

```sh
curl -fsSL https://agentrun.ai/install | sh
```

It needs no Node.js and no sudo: it downloads its own Node.js into `~/.agentrun` and changes nothing else on the
machine. It starts AgentRun as a service of this user (launchd on macOS, systemd on Linux), which keeps running after
the terminal closes and starts again at login. Where there is no service manager, such as a container, it starts
AgentRun in the background and says so. Either way it returns once AgentRun answers and prints
`AgentRun is running at <address>`. Its data is in `~/.agentrun`, and it takes the first free port from 7340 on
loopback. If it fails, read the lines it printed and explain the error without quoting a token. On a computer with a
browser it ends by opening the setup page there, where they set the owner password; otherwise open it for them (below).
Wait until they say the password is set; a request from here does not show that.

The command is now `~/.agentrun/bin/agentrun`. The installer adds `~/.agentrun/bin` to PATH in the shell's startup
file (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, fish's `conf.d`, else `~/.profile`), which only a new
terminal reads. Tell the person a new terminal has `agentrun`, and in this session always write the full path.

To restart it, `~/.agentrun/bin/agentrun service restart`; `service stop` and `service start` stop and start it. Where
it runs in the background, `~/.agentrun/bin/agentrun stop` stops it and the installer line starts it again. A reused
server the installer did not start (`service status` shows no service, and there is no `~/.agentrun/agentrun.pid`) was
started some other way: ask how it runs (free text, one plain message), agree on when to stop it, and restart that same
service with its own settings; never stop it unasked.

### My server

The browser is on another device here, so the server needs the address that browser opens. Continue in a session on
that machine, or an SSH session they already use. With their OK, run
`curl -fsSL https://agentrun.ai/install | sh -s -- --tailscale`: it installs AgentRun as a service, shares it on their
own tailnet only (`tailscale serve`, never Funnel) and prints its `https://<machine>.<tailnet DNS name>/` address. When
Tailscale is missing or signed out, or Linux needs operator rights, it prints the steps and the command to run again;
pass them on, and never run `sudo` or `tailscale up` for them. It asks for a setup code: open its page (below).
When they already put the machine behind HTTPS of their own (their own `tailscale serve`, a reverse proxy), install
without `--tailscale`, then give the service that address: `~/.agentrun/bin/agentrun service install --port 7340
--public-url https://<name>/`, with the proxy pointing at port 7340. Where there is no service manager, stop the one
in the background (`~/.agentrun/bin/agentrun stop`) and have them start it in a terminal they keep open with
`~/.agentrun/bin/agentrun --no-open --port 7340 --public-url https://<name>/`.
On a Linux server they rent (Ubuntu or Debian, as root), run `curl -fsSL https://agentrun.ai/install | sh -s -- --vps`
instead. It runs AgentRun in Docker, gives its agents a shell, keeps it private the same way and prints the setup code.

### Railway or Render

- **Railway:** they open https://railway.com/deploy/agentrun-1 and deploy it from their own Railway account with one
  click. The template sets up the image, a volume at `/data` and a public domain, and makes the API token and the seal
  key for them. Never create the service yourself with a Railway CLI.
- **Render:** they open https://render.com/deploy?repo=https://github.com/Parcha-ai/agentrun and confirm the plan
  Render shows; it reads the repository's `render.yaml` (the published image, 1 CPU / 2 GB, a 10 GB disk).

### Open the setup page

Open the setup page in the person's browser yourself, with the code filled in: never send a link for them to click
while you can open it, and never a command that prints or fetches the code.

1. Find the link. Where the installer or `~/.agentrun/bin/agentrun service` started AgentRun, run
   `~/.agentrun/bin/agentrun open` on that machine: it opens the page with a code that is still good, or prints the
   link where no browser opens. Otherwise read the server's log privately (`journalctl --user -u <unit>`, `docker logs
   <container>`, the terminal it runs in): the newest `Set up this server: <address>/setup#code=<code>` (a server at a
   public address; the code fills in **Setup code**). With no such line, the server is on loopback and needs no code:
   the link is the console address followed by `setup`.
2. Open it in a browser they are looking at: `open "<link>"` (macOS), `xdg-open "<link>"` (Linux) or `start ""
   "<link>"` (Windows) when this session runs on their computer, where the installer has already opened it; else your
   client's browser or preview tool. Only when you have neither, send the link itself as the first line.
   When **Deploy locally** is a remote machine (step 1's `SSH_CONNECTION`, Codespaces, Ona), AgentRun is on its
   loopback and their browser reaches it only through a port forward. Codespaces and Ona forward the port themselves.
   Over SSH, send the one command for their own computer, `ssh -o ExitOnForwardFailure=yes -L
   <local>:127.0.0.1:<port> <user>@<host>`, with this machine's port and a `<local>` port free on their computer (7340,
   unless an AgentRun of their own has it), then open the link there with `http://127.0.0.1:<local>/` in place of its
   address, keeping any `#code=...`. An always-on machine's tailnet or HTTPS address needs no forward. Never expose
   AgentRun any other way: no change to the machine's web server or reverse proxy (Traefik, nginx, Caddy; other apps
   share it), no new route, DNS name or firewall rule, and no `sudo`.
3. Say it is open and sets the owner password. A link with a code works **once** and **expires 30 minutes** after it
   was printed: give that clock time with its time zone when you can tell.

The setup link is not the API token: it works once and briefly, so it may go to an opener, a browser tool or the chat.
Never the API token (`AGENTRUN_TOKEN`, or `.token` in the data folder). On Railway or Render, whose log you may not
read, open the console address and say where the value for **Setup code** is: they paste `AGENTRUN_TOKEN` there
themselves. On Railway, the service's **Variables** tab holds `AGENTRUN_TOKEN`, and on Render its **Environment** tab
does. An expired code: they press **Get a new code**, or you send `curl -sS -X POST "$CONSOLE_ADDRESS/v2/setup/code"`
(it never returns the code), read the newest line and open it. A server that answers that with 404 has no such button:
restarting it prints a new code.

## 4. Look for the agents they already run

On **Check**, use the current project if it is the setup they named; otherwise ask for its folder (free text, one plain message). Discover
Claude Code project defaults/named agents and Codex project defaults/profiles with
`~/.agentrun/bin/agentrun native discover --project <folder>`. For Pi, inspect the selected project's `.pi` settings
and the user's Pi configuration to identify its saved setup; do not read authentication files, transcripts or unrelated
projects. An agent does not need a schedule to be deployed. Show the available harness, agent/profile and project,
then let the person select one or several. Preview and deploy each selected setup with step 5, preserving each identity.
If no setup is found, ask which folder and harness they use (free text, one plain message) before concluding there are none.

### Optional scheduled jobs

Only when they request a scheduled job too, run this as written. It reads cron, systemd timers (the system's and the person's own), launchd jobs and
the project's CI workflows, and reads the command each one runs, because a list of timers or launchd labels alone does
not show it.

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
agents (free text, one plain message); do not open their scripts, prompts or transcripts to find out.

Show at most three finds, one line each: tool, schedule, where. Then, question tool, header `Agent`: "Which of these
should AgentRun run first?" Recommendation: the most recent find because its setup and sign-in still work. One option
per find, that one first and marked (Recommended), each described as "<tool>, <schedule>, <where>", then **Start
fresh** ("a new agent from a template; you pick its model next"). On a three-option tool, offer two finds; the third
can be named in the free-text answer. Nothing found, no job named, or **Start fresh**: go to step 6.

## 5. Bring in the agent they picked

Use the same process for Cloud, Deploy locally and Self Host. Set the destination to `cloud` or the selected
instance URL; keep that choice throughout. On macOS, safe source capture also requires Python 3. If it is unavailable,
explain the prerequisite and install it only within the person's setup authorization. Linux uses the native reader.

1. **Preview the setup.** Run `~/.agentrun/bin/agentrun connect <folder> --from codex --to <destination> --dry-run`.
   Use `claude-code` or `pi` for the other harnesses, with `--source-agent NAME` for a named Claude agent or
   `--profile NAME` for a Codex profile. For a Cloud workspace handoff, also pass `--workspace WORKSPACE_ID`.
   Show the source selection, destination, file/skill/tool counts and blockers. This captures project files,
   instructions, authored skills and assets, effective settings and tool requirements. Credentials stay private.
   Unsupported extensions, tools or policy are blockers; never remove them or widen permissions to make deployment pass.
2. **Connect and deploy it.** After the person selects this setup and authorizes deployment, run
   `~/.agentrun/bin/agentrun deploy <folder> --from codex --to <destination> --yes` with the same selector and workspace.
   This connects, uploads and moves the same agent into managed execution. A separate connect without `--dry-run`
   stops after upload; use it only when they requested connection first. If they already selected a connected console agent,
   use `~/.agentrun/bin/agentrun deploy --connected <agent-id> --to <destination> --yes` to preserve its identity.
3. **Resolve destination setup.** Model and tool accounts are configured at the destination. Open the console setup
   links for missing requirements, then retry the same command. Keep the private deployment journal after interrupted
   responses; it retains the identity and exact pending upload. Do not enroll another copy. Some source configurations
   require an equivalent the destination does not yet offer; report that blocker instead of claiming success.
4. **Verify deployment.** Only `status: deployed` and its confirmed snapshot establish managed execution. Show the
   returned `console_url`; an upload or a connected status alone is incomplete. The source machine can be offline
   for subsequent managed runs. No conversation history is imported and no original source session is stopped.

Question tool, header `First run`: "Run <agent> once in AgentRun now? It is a real run of that job: it may
post or write wherever the job does." Recommendation: Run it now because one finished run verifies the deployed setup.
- Run it now (Recommended): you choose its task; I follow it to completion.
- Not now: it remains deployed and ready for a later run.

Once requested, ask for its task (free text, one plain message), use the destination's run command and follow its result. Go to step 8 with the
deployment link and, if requested, the run result.

A person who explicitly wants future jobs to execute on their source computer can choose the existing live connection
instead: `~/.agentrun/bin/agentrun native connect --project <folder> --runtime claude-code` (or `codex`) locally, or the
selected server's matching `/skills/agentrun-serve/SKILL.md` for a remote source. Source-native jobs use the source
sign-in and need no model key on the destination. History is a separate optional operation: preview with
`~/.agentrun/bin/agentrun import --from claude-code --dry-run` (or `codex`) and follow the matching skill only when
requested. Neither path substitutes for a requested deployment.

## 6. Connect a model

Reuse what the server has: when `~/.agentrun/bin/agentrun server capabilities` shows `models.ready` true, go to step 7.
Otherwise, on this computer, look read-only for a local model in Ollama: `ollama list` and `ollama show <tag>`
(`tools` under its capabilities). Never start a model download.

Question tool, header `Model`: "Which model should your first agent use?" Recommendation: Continue with ChatGPT
because it runs on the plan you already pay for, with no key to find.
- Continue with ChatGPT (Recommended): sign in with your ChatGPT plan in the console; no key.
- OpenRouter key: a key with a spend limit you set, pasted in the console.
- Local model: free, on this computer; offer it only when a model with tool calling is already pulled.

If they already run a LiteLLM or other OpenAI-compatible proxy, they answer **Model gateway** (the tool's free answer).

On **Continue with ChatGPT**, they open `<console address>/#/settings/keys` (Settings → Model keys), press **Continue
with ChatGPT** and sign in on OpenAI's page themselves. On a server that isn't this computer, the sign-in tab ends on a
page that won't load: they copy that page's whole address into the console. The sign-in is theirs alone.

On **OpenRouter key**, they open https://openrouter.ai/keys, create a key, set its credit limit (a few dollars is
plenty), and paste it into Settings → Model keys, never into this chat; it works without a restart. Claude Max, Ultra
and Team plans include monthly API credits: a key from the Claude Console organization linked to the plan, saved
there, runs the claude-agent harness on them (AgentRun Cloud included). Pro, Free and Enterprise plans don't.

On **Model gateway**, they open `<console address>/#/settings/keys` (Settings → Model keys), press **Use a model
gateway**, enter its address and key there (never in this chat), press **Test**, pick the default model from the list
it shows, and save; it works without a restart. Every model then goes to the gateway, not to a provider's key.

On **Local model**, only on this computer, give the service the model; it restarts with it and keeps it:

```sh
~/.agentrun/bin/agentrun service install --env AGENT_MODEL_BASE_URL=http://localhost:11434/v1 --env AGENT_MODEL_GATEWAY_IDS=bare --env AGENT_MODEL=<tag> --env AGENT_MODEL_PRICE=0,0,0 --env AGENT_MODEL_API_KEY=none
```

`AGENT_MODEL_API_KEY=none` is the key Ollama ignores: without one the server refuses each run (`model_key_required`).
Where AgentRun runs in the background, run `~/.agentrun/bin/agentrun stop`, then the installer with the same five in
front of `sh`: `curl -fsSL https://agentrun.ai/install | AGENT_MODEL_API_KEY=none AGENT_MODEL_BASE_URL=http://localhost:11434/v1
AGENT_MODEL_GATEWAY_IDS=bare AGENT_MODEL=<tag> AGENT_MODEL_PRICE=0,0,0 sh`. A background start keeps only what that
line sets, so on **Yes, only me** (step 3) put `AGENTRUN_MCP_ALLOW_LOOPBACK=1 AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` in
front of `sh` too. Then confirm `models.ready` in the capabilities, and on **Yes, only me** both switches `on: true`
under `switches`.

Claude Code through a gateway they already run (LiteLLM, say): restart the server with `ANTHROPIC_BASE_URL=<gateway>
ANTHROPIC_API_KEY=<its key, or any placeholder when it adds its own>`; the gateway must take Anthropic Messages at `/v1/messages`.

## 7. Create the first agent and run it

Check `agents list` first. Reuse a `release-notes` agent only when `agents get release-notes` shows this one, with no
tools; if another agent has that id, use the first free `release-notes-N` (N from 2) in both commands. Otherwise:

```sh
~/.agentrun/bin/agentrun agents create --body '{"definition":{"id":"release-notes","name":"Release notes","harness":"pi","tools":[],"max_cost_usd":0.25,"instructions":"Write concise release notes from the changes you are given. Group them under Added, Changed and Fixed. Do not invent changes."}}'
```

With `"tools":[]` it needs no shell, so it runs at once with no container to start; keep the empty list.

Question tool, header `First run`: "Start the first run of release-notes now on <model>, capped at $0.25?" (the model
from `models.default`, and whether it bills their ChatGPT plan, a key or nothing). Recommendation: Run it now because
it is the fastest way to a finished result, and the cap bounds the spend.
- Run it now (Recommended): I follow it to the end and give you the link to the finished run.
- Show me the agent: open it in the console; nothing runs until you press Run.

```sh
~/.agentrun/bin/agentrun runs start release-notes --wait --timeout 300 --max-cost-usd 0.25 --body '{"input":{"content":"Write release notes: added CSV export to the runs page; fixed the date filter resetting after refresh; renamed workspace settings to Settings."}}'
```

If they want an agent to use a service such as Sentry, GitHub or Slack, follow [Give an agent tools](https://github.com/Parcha-ai/agentrun/blob/main/docs/connect-tools.md): connect it as an MCP server in the console and give the agent its tools, never a token in the box.

## 8. Hand over

`runs start --wait` prints the run's `status`, `result.final_answer`, `cost.usd` and `console_url` once it ends: show
the answer, the cost and the `console_url` link. A run waiting on its cap (`status` `input_required`, `pending.kind`
`budget`) is theirs to raise in the console: link it. A failed run: show its `error`, and never retry silently.

For a server elsewhere, the commands above run from here with the command alone installed
(`curl -fsSL https://agentrun.ai/install | sh -s -- --no-start`), `--base-url <address>/v2` and its API token, which
the person saves in their own terminal with `~/.agentrun/bin/agentrun login --base-url <address>/v2` (it reads
standard input). Or they create and run the agent in the console.

When something doesn't work, at any step, run `~/.agentrun/bin/agentrun doctor` on the machine AgentRun runs on: it
checks the setup read-only and prints each problem with what to change (`--json` for you to read; exit 3 means no
server answers).

Report the console address, the run's link and cost, the data folder, `server.version` and any step still pending.
On this computer, say how it runs: as a service that starts again at login (`~/.agentrun/bin/agentrun service
uninstall` removes it and keeps the data), or in the background until the machine stops. Offer **Learning** (off by
default; turned on in the agent's **Learning** tab; reflection and grading add model usage). Don't turn on learning or
import more history unasked. Tell them AgentRun counts itself anonymously (a random id, version and platform; never
prompts, files or keys), and that https://github.com/Parcha-ai/agentrun/blob/main/docs/telemetry.md says how to turn
it off.
