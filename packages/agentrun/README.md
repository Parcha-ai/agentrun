# @parcha/agentrun

AgentRun is an open-source platform that supercharges your agents. It adds self-improvement, durable execution and a
control plane on top of your favorite agent harness. Your agents become smarter, more fault tolerant and use fewer
tokens with every run. Start it on your machine with one command:

```sh
npx @parcha/agentrun
```

It starts [AgentRun Server](https://github.com/Parcha-ai/agentrun/tree/main/packages/serve) on the first free port from
7340 on this machine's loopback, keeps its data in `~/.agentrun`, prints the address the server says to open and opens
it in your browser (`--no-open`, a CI run or a machine with no display skips that). The server,
`@parcha/agentrun-serve`, is this package's one dependency, at its exact version, so `npx` installs the two together and
each version of this command runs the server it was released with. Node.js 24.22.3 or newer, on macOS or Linux; an older
Node gets one line naming that floor and the installer's command.

No Node.js on the machine, or an older one? The installer brings its own and keeps AgentRun running after the terminal
closes:

```sh
curl -fsSL https://agentrun.ai/install | sh
```

It downloads a Node.js from nodejs.org: the newest release on the major line of the version this AgentRun needs, so
later security releases come with the next install. It checks the download against that release's `SHASUMS256.txt`
and installs it and AgentRun under `~/.agentrun` (`node/`, `lib/`, `bin/agentrun`). Any other Node, nvm or Homebrew is
left alone, and nothing needs sudo. When no line in your shell's startup file puts `~/.agentrun/bin` on `PATH`, it adds
one and says so. Then it starts AgentRun as a service of your user, a LaunchAgent on macOS or a systemd user unit on
Linux, which starts again at login and after a crash and logs to `~/.agentrun/logs/agentrun.log`. Where there is no
service manager (a container, say), it starts AgentRun in the background, logging to the same file. It runs until the
machine or container stops, and `agentrun stop` stops it (a SIGTERM, then a SIGKILL to the launcher and its server
after 45 seconds). Either way the installer returns once AgentRun answers, and prints its address. `sh -s -- --no-start`
installs only, `--version V` installs another version, `--node-version V` installs that Node.js (at least the floor),
and `--service` fails where there is no service manager. Running it again upgrades, or installs an older version, and
first stops the AgentRun it started in the background itself, whatever version that is.

`agentrun service status` prints the console's address and its health. `start`, `stop`, `restart`, `logs [--follow]`,
`upgrade [--version V]` (the installer again, then a restart) and `uninstall` (the data stays) do what they say, and
`agentrun service install [--port N] [--data DIR]` installs the service after a `--no-start`. For a local model, such
as Ollama's, `agentrun service install --env AGENT_MODEL_BASE_URL=<its /v1 address> --env AGENT_MODEL_GATEWAY_IDS=bare --env
AGENT_MODEL=<tag> --env AGENT_MODEL_PRICE=0,0,0` writes those variables into the
service and restarts it. They stay through restarts, upgrades and later installs, and `--env KEY=` removes one. `--env`
takes those four names alone: model keys go in the console, never in a service file. On Linux, a user's
services stop at logout unless lingering is on: `install` and `status` print the one `sudo loginctl enable-linger` line
when it is off. To remove AgentRun, run `agentrun service uninstall`, then delete `~/.agentrun/bin`, `~/.agentrun/lib`,
`~/.agentrun/node` and the `PATH` line; the rest of `~/.agentrun` is your data.

On a machine you keep on (a Mac mini, a home server, a VPS), `--tailscale` also puts AgentRun on your own
[Tailscale](https://tailscale.com) network, at `https://<machine>.<your tailnet's DNS name>/`, which only your devices
on that network open:

```sh
curl -fsSL https://agentrun.ai/install | sh -s -- --tailscale
```

It runs `tailscale serve --bg --https=443` to AgentRun's port, 7340, where AgentRun keeps listening on loopback only,
and prints the address from `tailscale status --json`. The server is told that address (`AGENTRUN_PUBLIC_URL`), so its
first visit asks for the setup code in `~/.agentrun/logs/agentrun.log`. It never uses Funnel, which would put the
address on the public internet: where Funnel is already on for that address, or the address serves something else, it
changes nothing and says so. It never installs Tailscale, logs in or runs sudo. With Tailscale missing or logged out,
it starts AgentRun on this machine and prints the steps and the command to run again. On Linux, where only root or
Tailscale's operator may change what it serves, it prints the one `sudo tailscale set --operator=$USER` line.
`agentrun service install --tailscale` does the same for an installed service, `--no-tailscale` takes it off, and
`agentrun service uninstall` removes the serve entry it added and no other. Tailscale's Personal plan is free: up to 6
users, unlimited user devices ([pricing](https://tailscale.com/pricing)). The https address needs MagicDNS and HTTPS
certificates turned on in your tailnet's [DNS settings](https://login.tailscale.com/admin/dns).

The server binds its port first and says so; this command then names the address on stderr at once, and prints its line
on stdout once the server is ready, which on a cold, slow disk can take minutes. A start that fails says why on stderr:
the step that failed, how the server ended (its exit code or signal, or still running after 60 seconds without printing
any address, and stopped; `AGENTRUN_START_TIMEOUT_MS` sets that wait, in milliseconds), its last lines on stderr and stdout, and
`~/.agentrun/start.log` (in the folder `--data` names), which holds everything the server wrote in that start. Each start
overwrites that log; it is private to you, as the server's first lines name its API token. A log the disk could not hold
all of is named with the error that cut it short.

Where Docker answers on this machine, a new agent runs in a Docker box of its own with a shell, and a line on stderr,
after the address, says so: `Boxes: docker (on by default; set AGENTRUN_BOXES to change).` Where it does not, that line says why
and that new agents run on the runner. A Docker box's image is built on its first run, which shows that on its
timeline. `AGENTRUN_BOXES=none` turns boxes off.

pi runs every agent out of the box. The Claude Code and Codex harnesses need their own packages beside the server; when
one is missing, AgentRun says so with the one command to paste: `npx` with this package, the server and that harness's
package at their versions, with `--data` naming the same store.

It needs no model key to start. In the console, set a password, then Continue with ChatGPT (Settings → Model keys, or
the first screen), then run your first agent: Codex and pi agents run on your ChatGPT plan, and the sign-in finishes
by itself on this computer. Claude Code, OpenCode, Jev decisions and paid tools need their own keys. Eligible usage in
this app uses your ChatGPT plan. Manage usage in your ChatGPT settings. The sign-in is yours: don't let other people run
agents on this server with it.

Or add a model key. With no `AGENT_MODEL`, the server runs a current model of the first provider it has a key for,
Anthropic, then OpenAI, then Particle (pi only), then OpenRouter: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`PARTICLE_API_KEY` or `OPENROUTER_API_KEY` in your environment, or a key saved in the console's Settings → Model
keys, which counts from the save on. Signed in with ChatGPT, pi and Codex run on the plan's model by default, key or
not, unless `AGENT_MODEL` names another. Other commands are the server's:
`npx @parcha/agentrun import` brings in your local Claude Code, Codex and pi sessions, and
`npx @parcha/agentrun reset-password` clears the console's password. `--data DIR` and `--port N` change where it keeps
its data and the port it takes.

Every other command is the server's API, from a second terminal: `npx @parcha/agentrun agents list`,
`agents create --body @agent.json`, `runs start AGENT_ID --max-cost-usd 2 --body '{"input":{"content":"..."}}'`,
`runs get RUN_ID`, `runs message RUN_ID --content "..."`, and one command for each route the server serves
(`npx @parcha/agentrun help` lists them; `api METHOD PATH` calls any route). It finds the server started with the same
`--data` on its own: the server writes its address and where its token is to `DIR/.server.json` once it listens. For
another server, set `AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY`. The response's JSON goes to stdout and an error's to
stderr; the exit code is 0 when it worked, 1 when the server refused, 2 for bad usage, 3 when the server cannot be
reached, 4 for a missing or refused token and 5 when the server does not offer the command here (a 501,
`unsupported_here`, its error saying why). The token is never a flag and never printed. A list command (`agents list`,
`runs list` and every other that takes `--cursor`) prints one page; `--all` follows `next_cursor` and prints every page
as one list.

`runs wait RUN_ID` waits until the run ends or waits on a person and prints it; `runs start AGENT_ID ... --wait` starts
a run and does the same. Its exit code says how it stopped: 0 completed, 1 failed or cancelled, 8 it waits on a person
(a question, its spend cap, a stopped turn, a paused workflow run), with a line on stderr saying what to do next, such as
`runs message RUN_ID --content "..."` to answer. `--timeout SECONDS` stops waiting after that long and exits 1; the run
goes on. `runs timeline RUN_ID --follow` prints the timeline as it changes, one page per line (NDJSON): upsert its
`rows` by `id`, delete its `drop` ids, and drop everything first on a page with `reset: true`. It resumes a dropped
connection where it left off and ends when the run ends, 0 completed, 1 failed or cancelled.

The TypeScript client for this server is `@parcha/agentrun-client` (packages/client), and the Python client is
`parcha-agentrun` (python/).
