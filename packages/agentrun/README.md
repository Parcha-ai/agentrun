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
one and says so. Then it starts AgentRun. On a terminal it first asks whether to make it a service of your user, a
LaunchAgent on macOS or a systemd user unit on Linux, which starts again at login and after a crash and logs to
`~/.agentrun/logs/agentrun.log`. The answer is No unless you say yes, and then AgentRun runs in the background, logging
to the same file. With no terminal to ask on, or its output captured (CI, a script, an agent's shell), it installs the
service without asking; `--service` and `--no-service` choose without the question. Where there is no service manager (a
container, say), it starts AgentRun in the background. In the background it runs until the machine or container stops, and `agentrun stop` stops it (a SIGTERM, then a SIGKILL to the launcher and its server
after 60 seconds). Either way the installer returns once AgentRun answers, and prints its address. `sh -s -- --no-start`
installs only, `--version V` installs another version, `--node-version V` installs that Node.js (at least the floor),
and `--service` fails where there is no service manager. Running it again upgrades, or installs an older version, and
first stops the AgentRun it started in the background itself, whatever version that is. An older version does not start on
a store a later one has upgraded: its server says so and exits, and the store is left as it was. Until the owner's
password is set, it ends by opening the setup page in this machine's browser with the setup code filled in, or, where no browser
opens (a remote machine), by printing that link.

`agentrun open` does the same at any time: the setup page with a code that is still good (it asks the server for a new
one when the last has run out) until the password is set, the console after. It reads the code from the service's log,
`~/.agentrun/logs/agentrun.log`.

`agentrun service status` prints the console's address and its health. `start`, `stop`, `restart`, `logs [--follow]`,
`upgrade [--version V]` (the installer again, then a restart) and `uninstall` (the data stays) do what they say, and
`agentrun service install [--port N] [--data DIR] [--public-url URL]` installs the service after a `--no-start`. A local
model needs nothing here: the server lists the models of the Ollama on this machine itself, at its default address
(port 11434), when it is your own server on your own machine. A server with a public address (`--public-url`,
`--tailscale`), or more than one API token, lists Ollama only where `OLLAMA_HOST` names it, the default address too. For
that, or an Ollama off its default address, `agentrun service install --env OLLAMA_HOST=<host:port>` writes it into the
service and restarts it, and `--env OLLAMA_CONTEXT_LENGTH=<tokens>` does the same for a lower context than
65,536; a model gateway's variables (`AGENT_MODEL_BASE_URL`, `AGENT_MODEL_GATEWAY_IDS`, `AGENT_MODEL`, `AGENT_MODEL_PRICE`) go in
the same way, its key in the console. They stay through restarts, upgrades and later installs, and `--env KEY=` removes one. A service that reached Ollama through a model gateway (`AGENT_MODEL_BASE_URL` with `AGENT_MODEL_API_KEY=none`) takes the gateway off with `agentrun service install --env AGENT_MODEL_BASE_URL= --env AGENT_MODEL_GATEWAY_IDS= --env AGENT_MODEL= --env AGENT_MODEL_PRICE=` and picks the model as `ollama/<tag>`; `--env` takes no `AGENT_MODEL_API_KEY`. On a machine
you alone use, `--env AGENTRUN_MCP_ALLOW_LOOPBACK=1 --env AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` turns on the two start-time
switches the same way (a switch takes `1` alone). `--env` takes the names `agentrun service install --help` lists, and
no others: model keys go in the console, never in a service file. The service never sees the shell that installed it, so
`AGENTRUN_TELEMETRY` or `DO_NOT_TRACK` set there is written into it, and under `CI` it gets `AGENTRUN_TELEMETRY=0`
([anonymous usage counts](../../docs/telemetry.md)). On Linux, a user's
services stop at logout unless lingering is on: `install` and `status` print the one `sudo loginctl enable-linger` line
when it is off. To remove AgentRun, run `agentrun service uninstall`, then delete `~/.agentrun/bin`, `~/.agentrun/lib`,
`~/.agentrun/node` and the `PATH` line; the rest of `~/.agentrun` is your data.

When something doesn't work, `agentrun doctor` (or `npx @parcha/agentrun doctor`) checks the whole setup in one go and
prints, for each problem, what to change and where it is documented: the Node.js it runs on, whether a server answers
for the data directory (`--data`, default `~/.agentrun`) and its version, the service (installed, running, lingering on
Linux), whether a browser elsewhere can open the server's address from this session (an SSH tunnel, `tailscale serve`
on your tailnet, `--public-url` or `--allow-host`), whether the console's password is set (when it is not, the fix
is `agentrun open`), whether a model and which harnesses are ready, the server's start-time switches, and Docker for the
boxes. It only reads: it changes no file, starts and stops nothing, and makes only GET requests. It reads the server
record `DIR/.server.json` as every command does: one that is not a private file of yours, or whose address is not a plain
http or https URL, is refused, and one whose process has exited is stale; nothing is sent to the address either names. It reads capabilities with the server's own token in
`DIR/.token`, and prints no token, key or setup code. `--json` prints the checks for an agent (`{exit, server, checks:
[{id, status, summary, fix, docs}]}`, each `status` `ok`, `warn`, `fail`, `info` or `skip`). Exit 0 when nothing
failed (warnings allowed), 1 when a check failed, 3 when no server answers.

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

Behind a proxy of your own instead (your own `tailscale serve`, a reverse proxy with HTTPS), pass the address people
open with `--public-url`, and keep the port the proxy points at fixed:

```sh
npx @parcha/agentrun --port 7340 --public-url https://box.tailnet.example/
agentrun service install --port 7340 --public-url https://box.tailnet.example/
```

The server takes it as its public address, as it takes `AGENTRUN_PUBLIC_URL`: its links name it, a browser that sends
that name as `Host` is let in on loopback (any other gets "unexpected Host header"), and its first visit asks for the
setup code. On loopback (no `--listen`, or a loopback one) it also sets `AGENTRUN_TRUSTED_PROXIES=loopback`, as
`--tailscale` does, so sign-in limits count each visitor by the address the proxy names rather than everyone as one;
an `AGENTRUN_TRUSTED_PROXIES` you set stays as it is (an empty one trusts no proxy), and with `--listen` on another address nothing is trusted. The
service keeps the flag on its command line, so every restart has both, and so does a later `agentrun service install
--env` or `--no-tailscale` (`--tailscale` replaces it with the tailnet address). A later `--public-url` changes the address
alone: the data folder and port stay. It must be an `https://` address, or
`http://` on this machine (`localhost`, `127.0.0.1`), with no path beyond `/` and no user name or password; anything else
is refused with exit 2 before the server starts. `AGENTRUN_PUBLIC_URL` still works; given with `--public-url`, the two
must name the same address. `--public-url` and `--tailscale` don't go together: `--tailscale` names its own.

Started on loopback with no public address, where `tailscale` is on `PATH` and signed in, the command reads
`tailscale status --json` (at most 2 seconds, and it changes nothing) and says once, on stderr, the address your tailnet
could open it at and the two steps to it: `tailscale serve --bg <port>`, which keeps it on your tailnet, then a restart
with `--port <port> --public-url https://<machine>.<tailnet>/`. It never runs either, never suggests Funnel, says
nothing when Tailscale is missing, signed out or slow, and says nothing in CI.

On a Linux server you rent (Ubuntu or Debian, as root), `--vps` sets up AgentRun in Docker Compose instead, with a
shell for its agents in Docker sandboxes, on your tailnet when Tailscale is logged in and on the server's loopback
otherwise:

```sh
curl -fsSL https://agentrun.ai/install | sh -s -- --vps
```

[Deploying AgentRun](https://github.com/Parcha-ai/agentrun/blob/main/deploy/README.md#one-command-on-a-server-you-rent)
says what it installs and writes, and what `--public` exposes.

The server binds its port first and says so; this command then names the address on stderr at once, and prints its line
on stdout once the server is ready, which on a cold, slow disk can take minutes. A start that fails says why on stderr:
the step that failed, how the server ended (its exit code or signal, or still running after 60 seconds without printing
any address, and stopped; `AGENTRUN_START_TIMEOUT_MS` sets that wait, in milliseconds), its last lines on stderr and stdout, and
`~/.agentrun/start.log` (in the folder `--data` names), which holds everything the server wrote in that start. Each start
overwrites that log; it is private to you, as the server's first lines name its API token. A log the disk could not hold
all of is named with the error that cut it short.

Where a new agent that names no place goes, by mode:

- Where Docker answers on this machine, it runs in a Docker box of its own with a shell, and a line on stderr, after the
  address, says so: `Boxes: docker (on by default; set AGENTRUN_BOXES to change).`
- Where it does not, and the runner has no shell (Mode 1), its create is refused, `name a box`: it names a box, or the
  runner (`"place": {"mode": "runner"}`) to run without a shell. That line says why, and `capabilities.places.default_place`
  is `null`. So is `agentrun deploy` of a package that names no `tools` and no `computer` list, at its preview: name its tools
  (`tools: []` keeps the runner) or its computer list.
- In Mode 2, where the runner's shell is Archil's serverless exec, it is not refused: it runs on the runner, as before.
- In Mode 2 on an Archil region with no serverless exec (`gcp-us-central1`), bash needs a box. A new agent with a shell
  tool and no computer is refused at its create and at `agentrun deploy`: "bash needs a box (a sandbox computer): …".
  Give it a sandbox computer, or leave `bash` out of its tools.

A Docker box's image is built on its first run, which shows that on its timeline. `AGENTRUN_BOXES=none` turns boxes off.

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
another server, set `AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY`, or sign in once with `agentrun login --to URL`
(`--to cloud` for AgentRun cloud): when the server offers a device sign-in, it prints an address and a code to approve
there, then keeps the token in `$XDG_CONFIG_HOME/agentrun/config.json` (0600); else it reads the token from stdin, as
`agentrun login --base-url URL < FILE` does. `agentrun login --base-url URL` typed on a terminal takes the device
sign-in too, when the server offers one. The response's JSON goes to stdout and an error's to
stderr; the exit code is 0 when it worked, 1 when the server refused, 2 for bad usage, 3 when the server cannot be
reached, 4 for a missing or refused token and 5 when the server does not offer the command here (a 501,
`unsupported_here`, its error saying why). The token is never a flag and never printed. A list command (`agents list`,
`runs list` and every other that takes `--cursor`) prints one page; `--all` follows `next_cursor` and prints every page
as one list.

Any other word runs `agentrun-NAME` from an absolute folder of your `PATH`, as git does, when it comes first:
`agentrun NAME [args]` passes the rest as given, with no shell, on this terminal, and exits with its code. A tool adds a
command to the CLI by installing `agentrun-NAME`. The server's and the CLI's own commands come first; NAME is letters,
digits, `-` and `_`. A signal sent to `agentrun` reaches the command, and `agentrun` exits when it does. On Windows it looks for `agentrun-NAME` with `.com`, `.exe`,
`.bat` or `.cmd`, in that order; a batch file (`.bat`, `.cmd`) is refused, since Node runs one only through `cmd.exe`,
which would read the arguments again.

`runs wait RUN_ID` waits until the run ends or waits on a person and prints it; `runs start AGENT_ID ... --wait` starts
a run and does the same. Its exit code says how it stopped: 0 completed, 1 failed or cancelled, 8 it waits on a person
(a question, its spend cap, a stopped turn, a paused workflow run), with a line on stderr saying what to do next, such as
`runs message RUN_ID --content "..."` to answer. `--timeout SECONDS` stops waiting after that long and exits 1; the run
goes on. `runs timeline RUN_ID --follow` prints the timeline as it changes, one page per line (NDJSON): upsert its
`rows` by `id`, delete its `drop` ids, and drop everything first on a page with `reset: true`. It resumes a dropped
connection where it left off and ends when the run ends, 0 completed, 1 failed or cancelled.

The TypeScript client for this server is `@parcha/agentrun-client` (packages/client), and the Python client is
`parcha-agentrun` (python/).
