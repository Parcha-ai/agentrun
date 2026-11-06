---
name: agentrun-setup
description: Set up AgentRun on this machine or on a Linux server, give it a model key, and make and run a first agent that learns. Use when asked to set up, install or try AgentRun.
---

# Set up AgentRun

AgentRun is an open platform to manage agents: one server keeps your agents and every run of them, with a console in
the browser. Ask the person before each step that changes their machine. Never print, echo, log or read back an API
key.

## 1. Check the machine

- `node --version` is 22.19 or newer on 22, or 24.2 or newer. If not, say so and stop. With nvm:
  `nvm install 22 && nvm use 22`.
- `docker ps` works without sudo. With Docker, every new agent gets a shell in a Docker box of its own. Without it,
  agents run on the runner with no shell: say so and go on. Denied on Linux: `sudo usermod -aG docker $USER`, then log
  out and back in.
- Ask which harness they want: pi (the default), Claude Code or Codex. The start line depends on it.

On a server or VM, read step 3 before you start anything.

## 2. Start it

npm serves `@parcha/agentrun` 0.3.6 with the server 0.1.0-beta.31 today (`npm view @parcha/agentrun-serve version`
says which). A Claude Code or Codex agent needs its harness beside the server, so the start line names it:

```sh
# pi agents
npx -y @parcha/agentrun --no-open
# Claude Code agents
npx -y -p @parcha/agentrun@0.3.6 -p @parcha/agentrun-serve@0.1.0-beta.31 -p @anthropic-ai/claude-agent-sdk@0.3.286 agentrun --no-open --data ~/.agentrun
# Codex agents
npx -y -p @parcha/agentrun@0.3.6 -p @parcha/agentrun-serve@0.1.0-beta.31 -p @openai/codex@0.164.0 agentrun --no-open --data ~/.agentrun
```

Both `-p` flags on one line run all three harnesses. From beta.32 on the plain line is enough for Claude Code too: it
installs Claude Code on first use. Codex keeps its `-p`. Start the line for their harness in the background and wait
for its address:

```sh
npx -y @parcha/agentrun --no-open > agentrun.log 2>&1 &    # or the Claude Code or Codex line
pid=$!
for i in $(seq 600); do
  grep -q 'AgentRun is running at' agentrun.log && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
grep 'AgentRun is running at' agentrun.log || { echo "AgentRun did not start:"; tail -20 agentrun.log; }
```

It prints `AgentRun is running at http://127.0.0.1:<port>/`, where its data is (`~/.agentrun`) and where its token is
(`~/.agentrun/.token`). Read the port off that line: it is 7340 unless 7340 was busy. On the first start with Docker it
then says `Preparing the Docker box image (first start only, a few minutes)...` and, 5 to 10 minutes later,
`The Docker box image is ready.` Agents can be made meanwhile; a run started before that waits for the image and shows
"working", with no model spend. If it did not start, its last lines say why: tell the person, and stop.

## 3. On a Linux server or VM

Run it as a systemd user service instead of step 2's background process. Ask before each file you write. The unit and
the env file below are also in the repository, with these steps as a page for a person:
https://github.com/Parcha-ai/agentrun/tree/main/examples/getting-started/linux-server

1. Write `~/.config/agentrun/agentrun.env` with mode 600, holding one line, `ANTHROPIC_API_KEY=` (or the variable their
   harness needs, step 5). Then stop and ask the person to paste the key into that file themselves, with `nano`, say.
   Don't read it back.
2. Write `~/.config/systemd/user/agentrun.service`, with `<node bin>` replaced by the directory `which node` is in:

   ```ini
   [Unit]
   Description=AgentRun
   Wants=network-online.target
   After=network-online.target

   [Service]
   Environment=PATH=<node bin>:/usr/local/bin:/usr/bin:/bin
   EnvironmentFile=%h/.config/agentrun/agentrun.env
   ExecStart=/usr/bin/env npx -y -p @parcha/agentrun@0.3.6 -p @parcha/agentrun-serve@0.1.0-beta.31 -p @anthropic-ai/claude-agent-sdk@0.3.286 agentrun --no-open --data %h/.agentrun
   Restart=on-failure
   RestartSec=5
   TimeoutStopSec=45

   [Install]
   WantedBy=default.target
   ```

   For Codex, `-p @openai/codex@0.164.0` in place of the SDK. For pi alone, the `ExecStart` is
   `/usr/bin/env npx -y @parcha/agentrun --no-open --data %h/.agentrun`.
3. Start it, and keep it up after the person logs out:

   ```sh
   systemctl --user daemon-reload && systemctl --user enable --now agentrun
   sudo loginctl enable-linger $USER
   journalctl --user -u agentrun --no-pager -n 50
   ```

   Watch the journal until `AgentRun is running at http://127.0.0.1:<port>/` and tell the person the port. Keep
   watching until `The Docker box image is ready.` (5 to 10 minutes on the first start). Then
   `curl -s http://127.0.0.1:<port>/v2/health`. A service that fails at once says why in the journal; the usual cause
   is a `PATH` line without node.
4. The console listens on the VM's loopback only. The person opens it from their laptop over
   `ssh -L 7340:localhost:<port> <vm>`, then `http://localhost:7340/`, and sets the password there (step 4) before the
   first run.
5. HTTPS, only after the password is set: Caddy on the VM with `reverse_proxy 127.0.0.1:<port>`, and
   `AGENTRUN_PUBLIC_URL=https://<host>` added to `agentrun.env`, then `systemctl --user restart agentrun`. A server
   with a public URL and no password yet asks for a setup code that the service's output does not show, so the
   password comes first.

A restart keeps the token, the store, the notes and the password, and a run that was mid-way resumes. Tell the person
to back up `~/.config/agentrun/seal.key` together with `~/.agentrun`: it opens the keys saved in the console, and a
restore without it asks for them again.

## 4. Set the password

Give the person the address (over the tunnel, on a server). On the first visit they set the owner's password, 12
characters or more, and land on Mission Control. Do this before the first run: a learned note the grader marks risky
waits for the owner's OK, and only the owner signed in with the password can approve it. The API token gets 403.

## 5. Give it a model

```sh
BASE=$(grep -o 'http://[^/ ]*' agentrun.log | head -1)    # on a server, http://127.0.0.1:<port>
curl -s "$BASE/v2/capabilities" | node -e 'const c=JSON.parse(require("fs").readFileSync(0));console.log("default model:",c.models.default);for(const h of c.harnesses)console.log(h.id,h.available?"ok":h.reason)'
```

A `null` default model means no key yet. Which key:

- `ANTHROPIC_API_KEY` runs pi and Claude Code.
- Codex needs `OPENAI_API_KEY` or `OPENROUTER_API_KEY`.
- One `OPENROUTER_API_KEY` covers all three.

A Claude subscription sign-in is not an API key: they make one at console.anthropic.com, with credit on it. Ask the
person to add the key, never in this chat. The simplest place is the console, Settings → Model keys, which takes effect
at once with no restart. Or they set it where AgentRun starts (the shell for step 2, `agentrun.env` for step 3) and
start it again. While a key is in the environment, the console refuses to save one for that provider. Never print,
echo or write a key anywhere. A harness that reads anything but `ok` says what it needs; for Claude Code or Codex that
is the start line of step 2 or 3.

## 6. Make your first agent

Ask what the agent is for before you create it. `POST /v2/agents` takes `{definition, skills}`. `definition` holds
`id`, `name`, `instructions`, `harness` (`pi`, `claude-agent` or `codex`), `learning`, `tools`, `tool_settings` and
the names of its `skills`; `skills` holds each one's `<name>/SKILL.md`, with `name` and `description` in its front
matter. Leave `tools` out and the agent gets a shell in the Docker box where Docker answers; `bash` can't be named
without a box. Write `agent.json`:

```json
{
  "definition": {
    "id": "engineer",
    "name": "Engineer",
    "harness": "claude-agent",
    "learning": true,
    "instructions": "You are an engineering agent. Do the task in your shell and report what you found.",
    "skills": ["report-format"]
  },
  "skills": {
    "report-format/SKILL.md": "---\nname: report-format\ndescription: How to write a report for this team\n---\n\nStart with STATUS: OK or STATUS: FAIL, keep it to five lines, end with a line that starts with Next: and names one action.\n"
  }
}
```

```sh
npx -y @parcha/agentrun agents create --body @agent.json
```

The CLI finds the server started with the same `--data`, and its token, on its own, and never prints the token. For
another server set `AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY`. The answer is the agent; a `warnings` entry names a key
or harness this server lacks, and a run of it is refused until that is fixed. An agent made in the console gets a UUID
as its id: `agents list` shows it, and the run commands below take it in place of `engineer`.

## 7. Run it, and watch it learn

```sh
npx -y @parcha/agentrun runs start engineer --body '{"input":{"content":"Install httpx in your box and tell me its version."},"max_cost_usd":1}'
npx -y @parcha/agentrun runs get <run_id>
```

Call `runs get` every few seconds until `status` is `completed`, `failed` or `cancelled`; never hold one call.
`completed`: the answer is `result.final_answer`. `input_required`: the agent asked a question; answer it with
`runs message <run_id> --content "..."`, or leave it to the person in the console. `409 agent_not_runnable` on the
start names what the server lacks and the exact line to restart with.

Give the person the run's page, `http://localhost:<port>/#/runs/<run_id>` (the API doesn't return that link yet).
Learning finishes after the run: `learning.state` in `runs get` goes `merged` or `dropped` within seconds, and the
run's page shows a learning chip naming what it kept. The agent's Learning tab lists the note under "What it has
learned" with the run it was learned in, and the next run starts from it. A note under "Waiting for your OK" needs the
owner's Approve in the console, signed in with the password.

## 8. Tools and their keys

`web_search` and `web_fetch` work with no key: the harness's own search where it has one, else keyless Exa.
`PARALLEL_API_KEY` picks Parallel for search and fetch; `MONID_API_KEY` unlocks monid's paid data tools. The person
adds them in the console under Settings → Tool keys; each is checked against its provider before it is kept, and
takes effect at once. Built-in tools allow by default. A catalog tool asks: the run pauses on a card in the console
until the owner answers.

## Drive it from your own session

```sh
export AGENTRUN_API_KEY=$(cat ~/.agentrun/.token)
export AGENTRUN_BASE_URL="$BASE/v2"
claude mcp add --transport http agentrun "$AGENTRUN_BASE_URL/mcp" --header "Authorization: Bearer $AGENTRUN_API_KEY"
codex mcp add agentrun --url "$AGENTRUN_BASE_URL/mcp" --bearer-token-env-var AGENTRUN_API_KEY
```

Call `whoami`, then `agents_create`, `runs_start` and `runs_get` every few seconds until the run ends. For everything
else (the tools, the `/v2` API, answering a run's question), read the server's own skill:
https://github.com/Parcha-ai/agentrun/blob/main/packages/serve/skills/agentrun-serve/SKILL.md

## If it goes wrong

- The port is not 7340: read it off the `AgentRun is running at` line. A restart right after a stop can land on 7342.
- `409 agent_not_runnable`: the message names the harness, tool or key the server lacks, and the line to restart with.
- The person set `AGENTRUN_TOKEN` themselves: `~/.agentrun/.token` is then stale. Give the CLI `AGENTRUN_API_KEY` from
  their environment instead.
- Learning shows `dropped`: the run's page says why. State the rule more plainly in the task and run it again.
- Docker can't host boxes on the VM: `AGENTRUN_BOXES=none` runs agents on the runner, with no shell.
