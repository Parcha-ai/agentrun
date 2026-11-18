---
name: agentrun-setup
description: Set up AgentRun, an open-source platform for running agents, and get the person to a finished first run in about five minutes. Asks every choice with the host's question tool, first where it should run and whether to look read-only for Claude Code or Codex jobs they already schedule; a found job becomes the first run on its own sign-in, otherwise a template agent on a model they connect. Use when asked to set up, install or try AgentRun.
---

# Set up AgentRun

AgentRun is an open-source platform for running agents: a console in the browser, runs that survive a restart, a
spend cap on every run, and agents that learn from their own runs. Get the person from this prompt to a finished first
run in about five minutes, with no Node install, no Terminal steps and no hunt for a key. Never ask for a password, key
or token in this chat, never print one, and never put one on a command line.

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
that installs, deploys or spends. Never answer a question for the person, and never pass a flag that answers one.

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
- `CODESPACES`, `GITPOD_WORKSPACE_ID` (GitHub Codespaces, Ona) or `SSH_CONNECTION`: a remote machine. **This
  computer** works only through its port forward, or a tunnel they already use (`ssh -L`).
- macOS, or Linux with a display and none of the above: their own computer.

In a hosted cloud session or sandbox, say so first, in one or two sentences, before the questions below: AgentRun
installed here could not be opened from their browser, and its data and keys would vanish with the session.

## 2. Ask where it runs, and whether to look for their agents

Before any install or deploy command, ask these two with the question tool in one call (neither changes the other).

Question tool, header `Run where`: "Where should AgentRun run?" Recommendation: This computer because it is free and
the fastest way to a first run.
- This computer (Recommended): free; one command, and the console opens in your browser.
- My always-on machine: free; the same install on a machine you keep on, private on your own Tailscale.
- A hosted service: Railway, Render or AgentRun Cloud; opened from any browser, monthly cost.

In a hosted cloud session or sandbox, the options are **A hosted service (Recommended)**, **My always-on machine**,
then **This session anyway** ("gone when the session ends; your browser can't reach it"). Recommendation: A hosted
service because this session's console is unreachable and disappears with it.

Question tool, header `Scan`: "Do you already run Claude Code or Codex on a schedule? I can check this computer
read-only while AgentRun installs; it shows only where, when and which tool." Recommendation: Check because a job you
already run can be your first run, on its own sign-in, with no model key.
- Check (Recommended): reads cron, systemd timers, launchd jobs and CI workflows; changes nothing.
- I'll tell you: you name the job and its project folder; I don't look.
- No, start fresh: a new agent from a template, on a model you pick.

On **A hosted service**, ask next with the question tool, header `Host`: "Which service should host AgentRun?"
Recommendation: Railway because it costs least and deploys from your own account in the browser.
- Railway (Recommended): about $5 a month (the $5 Hobby plan includes $5 of usage); agents get no shell.
- Render: about $27.50 a month (1 CPU / 2 GB at $25, a 10 GB disk at $2.50); agents get no shell.
- AgentRun Cloud: hosted for you; request access, nothing to install.

Only the person's answers choose. A provider CLI that is signed in, a deploy button, `render.yaml` or a README section
is never a choice. Never create a service on a provider the person did not name in this conversation. Skip `Run where`
only when they already named a place or an AgentRun server (then check its `/v2/health` and `/v2/capabilities`).

## 3. Start it where they chose

On **Check**, run the step 4 scan now, while AgentRun installs; it looks at this computer wherever AgentRun runs. On
**I'll tell you**, ask for the job and its folder (free text, one plain message), and bring it in at step 5.

On **This computer** or **My always-on machine**, before the start, ask once with the
question tool, header `Local reach`: "Do only you use that machine, and should its agents reach tools or a webhook
receiver on it?" Recommendation: Not now because it is the safer default and a restart adds it later.
- Not now (Recommended): runs and the webhook reach nothing local to it.
- Yes, only me: start the server with `AGENTRUN_MCP_ALLOW_LOOPBACK=1` and `AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` set.

### This computer

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

### My always-on machine

Continue in a session on that machine, or an SSH session they already use. With their OK, run
`curl -fsSL https://agentrun.ai/install | sh -s -- --tailscale`: it installs AgentRun as a service, shares it on their
own tailnet only (`tailscale serve`, never Funnel) and prints its `https://<machine>.<tailnet DNS name>/` address. When
Tailscale is missing or signed out, or Linux needs operator rights, it prints the steps and the command to run again;
pass them on, and never run `sudo` or `tailscale up` for them. It asks for a setup code: open its page (below).
On a Linux server they rent (Ubuntu or Debian, as root), run `curl -fsSL https://agentrun.ai/install | sh -s -- --vps`
instead. It runs AgentRun in Docker, gives its agents a shell, keeps it private the same way and prints the setup code.

### A hosted service

- **Railway:** they open https://railway.com/deploy/agentrun-1 and deploy it from their own Railway account with one
  click. The template sets up the image, a volume at `/data` and a public domain, and makes the API token and the seal
  key for them. Never create the service yourself with a Railway CLI.
- **Render:** they open https://render.com/deploy?repo=https://github.com/Parcha-ai/agentrun and confirm the plan
  Render shows; it reads the repository's `render.yaml` (the published image, 1 CPU / 2 GB, a 10 GB disk).
- **AgentRun Cloud:** hosted for you, by request. They request access at https://console.agentrun.ai/ and follow its
  onboarding; the steps below don't apply. For team onboarding, offer https://calendly.com/d/dtwn-dsp-nx5/agentrun.

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

On **Check**, run this as written. It reads cron, systemd timers (the system's and the person's own), launchd jobs and
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

1. **Connect it.** It keeps its own sign-in; connecting and importing need no model key. Ask which project folder the
   job runs in (free text, one plain message; never read it from the job). On this computer run
   `~/.agentrun/bin/agentrun native discover --project <folder>`, show what it found, then the same with
   `native connect --project <folder> --runtime claude-code` (or `codex`; `--agent NAME` or `--profile NAME` for the
   setup they pick). It prints the agent's id. When AgentRun runs elsewhere, connect from here with a one-use code from
   the console's **Connect agent → Another machine**, as `<console address>/skills/agentrun-serve/SKILL.md` says; the
   person types the code into the connector's own prompt, never into this chat.
2. **Import its recent history.** `~/.agentrun/bin/agentrun import --from claude-code --dry-run` (or `codex`)
   lists every session of that tool in this home, not only this job's; nothing leaves this computer. With their OK,
   stop the server (step 3), run it without `--dry-run`, and start the server again. Elsewhere, a one-use code with
   **Both** scope imports this project's history. Then give them the console's **Runs** address, where it now shows.
3. Question tool, header `First run`: "Run <agent> once through AgentRun now? It is a real run of that job: it may
   post or write wherever the job does." Recommendation: Run it now because one finished run shows the job working.
   - Run it now (Recommended): you give it a task next; I follow it to the end.
   - Not now: it waits in the console; nothing runs until you press Run.
4. On **Run it now**, ask for the task (free text, one plain message), then run `~/.agentrun/bin/agentrun runs start
   <agent id> --wait --timeout 600 --body '{"input":{"content":"<task>"}}'`. AgentRun caps no connected agent;
   its own plan bounds it. Go to step 8.

## 6. Connect a model

Reuse what the server has: when `~/.agentrun/bin/agentrun server capabilities` shows `models.ready` true, go to step 7.
Otherwise, on this computer, look read-only for a local model in Ollama: `ollama list` and `ollama show <tag>`
(`tools` under its capabilities). Never start a model download.

Question tool, header `Model`: "Which model should your first agent use?" Recommendation: Continue with ChatGPT
because it runs on the plan you already pay for, with no key to find.
- Continue with ChatGPT (Recommended): sign in with your ChatGPT plan in the console; no key.
- OpenRouter key: a key with a spend limit you set, pasted in the console.
- Local model: free, on this computer; offer it only when a model with tool calling is already pulled.

On **Continue with ChatGPT**, they open `<console address>/#/settings/keys` (Settings → Model keys), press **Continue
with ChatGPT** and sign in on OpenAI's page themselves. On a server that isn't this computer, the sign-in tab ends on a
page that won't load: they copy that page's whole address into the console. The sign-in is theirs alone.

On **OpenRouter key**, they open https://openrouter.ai/keys, create a key, set its credit limit (a few dollars is
plenty), and paste it into Settings → Model keys, never into this chat; it works without a restart. Claude Max, Ultra
and Team plans include monthly API credits: a key from the Claude Console organization linked to the plan, saved
there, runs the claude-agent harness on them (AgentRun Cloud included). Pro, Free and Enterprise plans don't.

On **Local model**, only on this computer, give the service the model; it restarts with it and keeps it:

```sh
~/.agentrun/bin/agentrun service install --env AGENT_MODEL_BASE_URL=http://localhost:11434/v1 --env AGENT_MODEL_GATEWAY_IDS=bare --env AGENT_MODEL=<tag> --env AGENT_MODEL_PRICE=0,0,0
```

Where AgentRun runs in the background, run `~/.agentrun/bin/agentrun stop`, then the installer with the same four in
front of `sh`: `curl -fsSL https://agentrun.ai/install | AGENT_MODEL_BASE_URL=http://localhost:11434/v1
AGENT_MODEL_GATEWAY_IDS=bare AGENT_MODEL=<tag> AGENT_MODEL_PRICE=0,0,0 sh`. Then confirm `models.ready` in the
capabilities.

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

Report the console address, the run's link and cost, the data folder, `server.version` and any step still pending.
On this computer, say how it runs: as a service that starts again at login (`~/.agentrun/bin/agentrun service
uninstall` removes it and keeps the data), or in the background until the machine stops. Offer **Learning** (off by
default; turned on in the agent's **Learning** tab; reflection and grading add model usage). Don't turn on learning or
import more history unasked.
