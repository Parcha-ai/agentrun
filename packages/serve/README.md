# @parcha/agentrun-serve

AgentRun Server: the Agentrun v2 API on your own machine, or in one container. `agentrun-serve` serves the same `/v2` contract (`agentrun.v2/0`) as the hosted
API, over one agent store of [`@parcha/pi-durable-agent`](../pi-durable-agent/README.md) in a directory: many agents,
each with revisions written once (an agentic prompt, or an agentrun-dsl workflow), and every run pinned to the revision
it ran. Each run is a [`@parcha/pi-durable-disk`](../pi-durable-disk/README.md) run directory beside the store. An SDK
pointed at it works the way it works against the hosted API; the capabilities document says what this server does not
offer.

Published to npm from the next release (`@latest`): `npx @parcha/agentrun-serve` then starts it with nothing else installed, its
console included. Until then, run it from a checkout (below) or the container.

## Quick start (no key, no network)

Node 22.19 or later on 22, or 24.2 or later. In a checkout of this repository:

```sh
npm ci --ignore-scripts && npm run build
cat > faux.mjs <<'JS'
export default (context, faux) => faux.message("The answer is 42.");
JS
node packages/serve/dist/cli.js --faux faux.mjs
```

Installed, `agentrun-serve` is a launcher that needs a POSIX `sh` with a builtin `printf` (Linux, macOS; not Windows). It hands the server its keys and token over a pipe, so none is in any process's environment, the run's processes included. Started as `node dist/cli.js`, as above, the server reads them from its own environment. `GET /v2/capabilities`' `secrets` says how they are held, and what that does not cover. Started with `npx @parcha/agentrun`, your shell and npm keep the keys you exported in their environment, as they always do; the server itself, and its runs, hold none. For the strictest custody, start this launcher directly, with each key set for that one command and not exported: once the launcher has handed a key to the server, no process holds it in its environment. The launcher takes keys from its environment only, not from a file or standard input.

It prints where it listens and, at the start that made it, the token:

```
agentrun-serve on http://127.0.0.1:7340/v2 (agent store in ~/.local/share/agentrun/agents)
AGENTRUN_BASE_URL=http://127.0.0.1:7340/v2
AGENTRUN_API_KEY=ar_local_...
Open http://127.0.0.1:7340/
Boxes: docker (on by default; set AGENTRUN_BOXES to change).
Set your password: http://127.0.0.1:7340/setup (the first visit sets it)
```

When the box image is not built yet, a line after the banner says its first build is under way (`Preparing the Docker
box image (first start only, a few minutes); agents can be made now, and their first run waits for it.`), and another
when it ends (`The Docker box image is ready.`, or why it failed). `npx @parcha/agentrun` prints the `Boxes:` line and
these two on stderr, after its own line on stdout. On a machine where Docker is not running, the `Boxes:` line says so instead (`Boxes: none, so new agents run on the
runner. Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart
AgentRun.`); see [Boxes](#boxes).

`Open` is [the console](#the-console), which takes [your password](#your-password). For a client, export the two lines before
it, then make an agent, start a run, and read its timeline until a page says `final`:

```sh
H="authorization: Bearer $AGENTRUN_API_KEY"
curl -s "$AGENTRUN_BASE_URL/agents" -H "$H" -H 'content-type: application/json' \
  -d '{"definition":{"id":"calc","name":"Calc","instructions":"Answer the question."}}'
run=$(curl -s "$AGENTRUN_BASE_URL/agents/calc/runs" -H "$H" -H 'content-type: application/json' \
  -d '{"input":{"content":"What is six times seven?"}}' | node -p 'JSON.parse(require("fs").readFileSync(0)).run_id')
curl -s "$AGENTRUN_BASE_URL/runs/$run/timeline?wait_ms=5000" -H "$H"
curl -s "$AGENTRUN_BASE_URL/runs/$run" -H "$H"
curl -s "$AGENTRUN_BASE_URL/runs" -H "$H"
```

An edit is a new revision: `PUT $AGENTRUN_BASE_URL/agents/calc/definition` with
`{"definition":{"instructions":"Answer in one word."}}` makes revision 2 current, and the next run runs it.

| Flag | Default | What |
| --- | --- | --- |
| `--data DIR` | `~/.local/share/agentrun/agents` | The agent store (`DIR/store.sqlite`) and its runs (`DIR/disk/agents/<agent>/runs/<id>/`). The token is `DIR/.token`, mode 0600, made once and kept, unless `AGENTRUN_TOKEN` gives it. |
| `--listen ADDR` | `127.0.0.1` | The address to listen on. On any other, every `Host` name is served and the token is the only lock: put TLS in front of it. |
| `--port N` | the first free port from `7340` | The port. `0` is any free port. |
| `--open` | off | Open the console in this machine's browser once the server listens; not in CI, nor on Linux with no display. |
| `--faux MODULE` | none | Answer every model request from the module's default export (below). |
| `--allow-host NAME` | none | Another `Host` name to accept on a loopback address, on any port. Repeat it. |
| `--max-runs N` | `AGENTRUN_MAX_RUNS`, else as many pi runs as fit | The most runs at once, beside the memory each run's harness reserves ([capacity](#capacity-and-health)). Over either, a new run is `429 rate_limited`. |
| `--documents DIR` | `AGENTRUN_SERVE_DOCUMENTS` | A read-only directory of documents a workflow's `pdf_pages` calls read by file name, confined to it. |
| `--allow-code-nodes` | off (`AGENTRUN_SERVE_CODE_NODES=1` turns it on) | Run workflows' `code` nodes. They run in the run's process through the DSL's `new Function` transform, which is no sandbox, so only turn it on for workflows you wrote. Off, a workflow with a code node saves with a `not_set_up_here` warning and its runs are `409 agent_not_runnable` with `details.code: true`. A call `via: "shell"` or `"executor"` is refused either way. |
| `--learning on\|off` | on (`AGENTRUN_SERVE_LEARNING`) | Whether runs [learn](#learning). On, a run of an agent whose definition says `learning: true` starts from what that agent learned and adds to it; off, no run does, whatever its agent says. Any other value refuses the start. Capabilities report it as `features.learning`. |
| `--learning-budget BYTES` | `8000` (`AGENTRUN_SERVE_LEARNING_BUDGET`) | How much of what an agent learned its runs' instructions hold under `# Learned`, in UTF-8 bytes: every note whole while they fit, else the index and the notes changed last, whole, while they fit ([learning](#learning)). `0` gives the index alone. A value that is not a whole number of bytes refuses the start. |
| `--drain-timeout D` | `30s` (the image: `6s`) | How long a busy run may finish its turn when the server stops (`8s`, `500ms`, `1m`). A turn cut off resumes at the next start; its model request is sent again. The server keeps its data directory until its runs' processes have exited (up to this and a second), and says so as it stops; a server started on the same `--data` meanwhile waits for it, saying so, then starts. |

`AGENTRUN_TOKEN`, when set, is the token (32 characters or more), and the server prints `$AGENTRUN_TOKEN` in its
place: a token from the environment stays out of the logs. `DIR/.token`'s token is printed only by the start that made
it; a later start prints `AGENTRUN_API_KEY=<in DIR/.token>`, to read it there. With `AGENTRUN_ACCOUNTS=0` the `Open`
link carries the token (`?token=<in DIR/.token>` on a later start); it encodes the token, and the server also takes one
whose `+` arrived as a space. `AGENTRUN_PUBLIC_URL`, when set, is the
address people open (a container's published port, or a proxy's URL): the printed `Open` link and `AGENTRUN_BASE_URL`
use it.

## Sandbox in 60 seconds

An agent with a shell, in a Docker container of its own: on a machine with Docker, in a checkout built as above, with
a model key. Start the server; the Docker box is on by default wherever Docker answers:

```sh
export AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5 OPENROUTER_API_KEY=...
node packages/serve/dist/cli.js
```

Its log says `event=boxes available=docker`, and its banner's last line `Boxes: docker (on by default; set
AGENTRUN_BOXES to change). docker boxes reach only pypi.org, files.pythonhosted.org, registry.npmjs.org, registry.yarnpkg.com,
github.com, and codeload.github.com.` (on Linux; elsewhere it says why the box has no
network: [Sandbox](#sandbox)). The first start builds [the box's image](#the-boxs-image) (python 3.12, git, curl, node, npm and rg,
about 300 MB, a minute or two, the build alone on the network): its banner then says `Boxes: docker is preparing
(building the box image (python, git, curl, node, npm, rg)).`, and the log `event=box_image ... state=preparing`, then
`state=ready` with how long it took; a later start finds it built. A run that needs its box sooner waits for it, with a
row on its timeline saying so. In a second shell, export the two `AGENTRUN_` lines it printed (a later start prints
where the key is: `export AGENTRUN_API_KEY=$(cat ~/.local/share/agentrun/agents/.token)`). Then make a sandbox agent,
run it, watch it, and read the file it wrote:

```sh
H="authorization: Bearer $AGENTRUN_API_KEY"; J='content-type: application/json'
curl -s "$AGENTRUN_BASE_URL/agents" -H "$H" -H "$J" -d '{"definition":{"id":"boxed","name":"Boxed","instructions":"Do each step with bash.","place":{"mode":"sandbox","box":"docker"},"tools":["bash","write","read"]}}'
run=$(curl -s "$AGENTRUN_BASE_URL/agents/boxed/runs" -H "$H" -H "$J" -d '{"input":{"content":"Save what cat /etc/os-release prints in out.txt."}}' | node -p 'JSON.parse(require("fs").readFileSync(0)).run_id')
curl -sN "$AGENTRUN_BASE_URL/runs/$run/timeline" -H "$H" -H 'accept: text/event-stream' | grep -o '"summary":"[^"]*"'
curl -s "$AGENTRUN_BASE_URL/runs/$run/files" -H "$H"; curl -s "$AGENTRUN_BASE_URL/runs/$run/files/out.txt" -H "$H"
```

The `place` above is what a new agent gets anyway on a server with docker, so a definition that names only its name and
instructions lands in the box too, with `bash` as its one tool ([Place](#place)).

The timeline ends when the run does. `out.txt` names the image's Debian, whatever this machine runs, and it is in
the run's `work/`, the one directory the container binds. No key? Start the server with `--faux box.mjs`, a
[faux model](#the-faux-model) that makes one `bash` call and then answers, and run the same commands:

```sh
cat > box.mjs <<'JS'
export default (context, faux) => context.messages.some((m) => m.role === "toolResult") ? faux.message("Saved out.txt.")
  : faux.message(faux.toolCall("bash", { command: "cat /etc/os-release | tee out.txt" }), { stopReason: "toolUse" });
JS
node packages/serve/dist/cli.js --faux box.mjs
```

The box has python 3.12, git, curl, node, npm and rg. On Linux it reaches Python's and npm's package registries and
GitHub, and nothing else: `pip install` and `npm install` work in it. [The box's image](#the-boxs-image) says how to give
it more. The rest is under [Sandbox](#sandbox).

## Logs

stdout gets one line per event, `at=<time> event=<name> key=value ...` (a value with a space is quoted):

```
at=2026-10-25T21:04:05.120Z event=request method=POST path=/v2/agents/calc/runs status=202 ms=41
at=2026-10-25T21:04:05.121Z event=run_started run=01a1... agent=calc kind=agentic
at=2026-10-25T21:04:06.802Z event=run_ended run=01a1... agent=calc status=completed cost_usd=0.0012
at=2026-10-25T21:04:09.010Z event=auth_failed route=/v2/runs reason=wrong_token
```

A request's path has no query. `auth_failed` names the route and why (`no_credential`, `wrong_token`,
`wrong_link_token`, `wrong_password`, `sign_in_table_full`), never the token given nor any part of it. `AGENTRUN_LOG=quiet` leaves out the request lines; the
run and `auth_failed` lines stay. A run whose process failed at its start says why in its `error.message`, in words.
One line at start, `event=boxes`, says which boxes this server has ([Boxes](#boxes)), and with a Docker box,
`event=box_image` says whether its image is `ready`, `preparing` (being built or pulled) or `unavailable` and why, again
when that ends; quiet keeps them too.
`event=harness_offers why=start ms=<n>` says how long the server took to check what each harness offers (each CLI's
package and pins; [harnesses](#harnesses)), the bulk of its start; quiet keeps it too. It is made at the start only: a
PUT of `/settings/tools` and a save or delete of a tool key change no harness's offer, so they remake capabilities at
once without checking again (a key some harness reads would, with `why=key`).

## In a container

The image is public: `ghcr.io/parcha-ai/agentrun-server` (`:beta`, or an exact version such as `:v0.1.0-beta.27`).
`compose.yaml` at the repository's root is the one way to run it: the server, its data on a named volume, and the host's
Docker socket, so each run's `bash` gets a Docker box ([in the published image](#in-the-published-image)).

1. Start it (below).
2. Open the console and set your password.
3. Sign in with it on any browser; the token in the log stays for scripts and the CLI.

On a fresh server with no `AGENTRUN_PUBLIC_URL`, whoever reaches the console first sets the password, so set it right after
the start, before the port is reachable by anyone else. With `AGENTRUN_PUBLIC_URL` set, the setup code the server
prints still guards it.

On a Linux host with Docker Engine 26 or later, with no checkout:

```sh
curl -fsSLO https://raw.githubusercontent.com/Parcha-ai/agentrun/main/compose.yaml
export AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5 OPENROUTER_API_KEY=...
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env
docker compose up -d
docker compose logs agentrun | grep Open
```

The `.env` beside `compose.yaml` keeps the socket's group (`DOCKER_GID`) for every later `docker compose` command, in any
shell: compose reads it each time, and `compose.yaml` needs it to be read at all.

From a checkout, the same command in its root, with `--build` to build the image from it.
`packages/serve/docker/Dockerfile` builds that image: the server and the open packages it runs, on Node 22 and Debian 13
(trixie), with git 2.47 for an agent's learning folder and the Docker client. Everything it keeps is under `/data`: the agent store,
the runs and the token.

The token is in the log of the start that made it. On a stop the server gives a busy run 6 s
(`--drain-timeout 6s`) to finish its turn, so a busy `docker stop` ends in about 7.5 s, inside Docker's default 10 s
grace, and Compose's `stop_grace_period` is 15 s; a turn cut off resumes at the next start. Compose publishes the port
on this machine's loopback only (port 7340, or `AGENTRUN_PORT`; set `AGENTRUN_PUBLIC_URL` with it, so the printed link names that port), and
the volume `agentrun-data` keeps `/data` across `down` and `up`. In the container the server listens on `0.0.0.0`, and
every route but `GET /v2/capabilities` and `GET /v2/health` still needs the token. Compose's `healthcheck` and
`render.yaml`'s `healthCheckPath` are `GET /v2/health`.

`render.yaml` at the repository's root is a Render blueprint for the same image: one web service with a 1 GB disk at
`/data`. Render generates `AGENTRUN_TOKEN`, which scripts and the CLI read in the service's Environment tab, and
`AGENTRUN_SEAL_KEY`, which seals the keys, MCP server credentials and webhook trigger secrets the server saves (keep a
copy: a service that loses it loses them). With no
`AGENTRUN_PUBLIC_URL` the server takes Render's own `RENDER_EXTERNAL_URL` as its public address, so setup takes the
code the start prints in the service's log (`Set up this server: ...`). On another host, set `AGENTRUN_PUBLIC_URL` to
the address people open before the first start; without it, whoever opens the console first sets the password. Set
`AGENT_MODEL` and the provider's key there too. Render waits 30 s after SIGTERM, above the image's 6 s drain; it does not
let a service with a disk change that.

## The disk, and earlier data directories

The data directory has two parts. Its own files, the control plane, hold the agent store (`DIR/store.sqlite`, where
each run's row keeps its claim: an epoch and its holder), the token and the server's settings; only the server opens
them. Everything the agents make is on the disk, `DIR/disk/`: one folder per agent, `DIR/disk/agents/<agent>/` (its id
in lower case, a dash and 16 hex digits of its SHA-256), with its learning folder (`learning/`) and its runs
(`runs/<id>/`, each with `store/run.sqlite`, its log, and `work/`, where its tools work). Nothing is copied in or out of
a run's folder: where it works, it works in that folder.

A run's own process writes its `run.sqlite` in WAL, under an exclusive lock, with no automatic checkpoint, and ends
with its WAL in place. The server reads it with a fresh read-only open per read, never shows a read older than one
before, and never opens it for writing while the run's process holds it. Once that process is gone the server takes
the run back (its epoch bumped, the server its holder) and checkpoints its WAL into the database file.

A data directory an earlier version wrote, with its runs under `DIR/runs/` (or a store of store version 1), is refused
at start, saying so: this version neither reads nor moves it. Keep it with that version, or start this one on a new data
directory (an empty folder, or a new volume).

## Upgrading from 0.1.0-beta.26

0.1.0-beta.27 keeps every agent in one store, `DIR/store.sqlite`, with its revisions (and this version each run on the
disk, above).
0.1.0-beta.26 and earlier kept one agent home per agent, `DIR/<agent>/agent.sqlite`, and this version does not read
those. So it refuses to start on a data directory that holds one, and names each home it found, instead of serving
it as if it had no agents.

To keep those agents and their runs, keep the earlier version on that data directory. To start this version, give it a
new data directory (a new volume), or move the old homes out of the one you have. Then create the agents again, here or
through `POST /v2/agents`. Their earlier runs stay readable where you moved them, with the earlier version.

## Capacity and health

Each run is a process of its own, and how much memory it takes depends on its harness. The server admits runs by
memory: each run that holds a live process (working, or waiting for an answer) reserves its harness's size out of the
container's limit when it has one (cgroup), else the machine's, less the server's own 128 MiB.

| Harness | Reserved per run | Measured per run |
| --- | --- | --- |
| pi | 128 MiB | up to 106 MB |
| codex | 192 MiB | up to 143 MB |
| claude-agent | 288 MiB | up to 215 MB |
| opencode | 704 MiB | up to 524 MB |

The measure is a short task (write a file, read it back, answer) on a real server in a container of its own; the table
in `src/harness.ts` says how it was taken. So a 512 MB instance holds 3 pi runs, 2 codex runs or 1 claude-agent run at
once (or 1 codex and 1 pi), 1 GB holds 7, 4 or 3, and 8 GB 63, 42 or 28; an opencode run, OpenCode's own process with
it, needs a 1 GB instance for one and 2 GB for two. A start that does not fit in what is left is
`429 rate_limited` with `retry-after`, its message naming the harness and the memory, and nothing starts: there is no
queue, so the client tries again once a run ends. A harness whose one run needs more than all the memory for runs (claude-agent
on a host under 416 MB, opencode under 832 MB) is unavailable: capabilities say why in its `harnesses` entry, and
its runs are `409 agent_not_runnable` with that reason. pi always has one place, however small the host.

`--max-runs N` or `AGENTRUN_MAX_RUNS` caps the count as well (by default, as many as pi runs fit), and both limits
apply. Capabilities report pi's count in `limits.max_concurrent_runs`, and each harness's own in its `harnesses` entry
(`max_concurrent_runs`, beside `run_memory_mib`). A message to a run already going is never refused for a place, nor is
the relaunch of one whose process went, and a run's process the next server adopts after a restart holds its harness's
memory there. A run whose harness can never fit (the server restarted on a smaller host) is not started again: it fails
with why if it was working, and a message to it is `409 agent_not_runnable`.

A data directory serves one AgentRun Server at a time: two servers on a shared disk are not supported (each
counts only its own runs, and a run could be relaunched twice).

`GET /v2/health`, with no credential like capabilities, answers `200 {status: "ok", checks: {store: "ok", disk: "ok"}}`
when the agent store opens for a read and the data directory's disk has at least 64 MiB free (`AGENTRUN_MIN_FREE_MB`),
and `503` with `status: "failing"` and which check failed (`store: "does_not_open"`, `disk: "below_floor"`, or
`disk: "cannot_check"` when the free space cannot be read) otherwise.
It names no path, size or version. One route serves as both liveness and readiness: any answer says the server is up,
and a 200 says it can work, and the platforms here take one path.

A run whose end the agent store cannot take (a full disk) still ends: a cancel makes it `cancelled`, with its cost from
its rows, and the server writes the end to the store again every 30 s until it lands; a restart before then reads the
run as the store last had it. A run whose process was killed is opened again on its next message at once: the run's row
names its process (its pid, that process's start and this boot), and a process that is gone holds nothing. One server
serves a data root, and the agent disk under it (`<data>/disk`): a second server on the same root is refused at start
(`server.lock`), so the row's claim never has two servers claiming it at once.

## Sandbox

A sandbox agent's `bash` runs in a box, a machine apart from this server: today a Docker container made for each run,
which binds the run's `work/` and nothing else, or a Daytona sandbox, which gets a copy of it. Neither holds a key. A
Docker box on Linux reaches the package registries and GitHub through a proxy, and nothing else; a Daytona box reaches
them through Daytona's domain list. Its `read`, `write` and `edit` work on that same `work/`: on this server, where the box binds it and this server
holds directory handles (Docker on Linux), else in the box. The agent's loop, its log, its model calls and every key stay
on the server. An agent says so in its [place](#place); the server says which [boxes](#boxes) it has; [a run in a Docker
box](#a-run-in-a-docker-box) is what the container gets, and [a run in a Daytona box](#a-run-in-a-daytona-box) what a
Daytona sandbox gets;
[the box's image](#the-boxs-image) is what it starts from. [Sandbox in 60 seconds](#sandbox-in-60-seconds) is all of it
end to end. The [published image](#in-the-published-image) hosts Docker boxes through the host's Docker socket.

### Place

A definition may name where its runs execute: `{"mode": "runner"}` or `{"mode": "sandbox", "box": ...}`, the box one of
the ids under [Boxes](#boxes). A runner has no shell. In a sandbox the agent's `bash` runs in the named box and its
file tools (`read`, `write`, `edit`) work on the `work/` the box has ([a run in a Docker box](#a-run-in-a-docker-box)),
while the agent's loop, its log and every key stay on the server, whatever its harness. Any other shape is `422 input_invalid` on `definition.place`, whose `fix` is the change to make: the field to
remove, or the place it most likely meant, to copy (`"place": {"mode": "sandbox", "box": "docker"}`). One that names a
place keeps it, `runner` included. An edit that names no place keeps the agent's.

The box is a new agent's default machine. A new agentic agent whose definition names no place is saved in the Docker box
(`{"mode": "sandbox", "box": "docker"}`) wherever this server has docker, ready or still preparing its image (its first
run then waits for the image, with one timeline row). The place is written on the agent's first revision, so its answers
show it. If that definition names no `tools` either, it gets `["bash", "bash_background", "bash_output", "bash_input",
"bash_signal", "bash_list"]`, so the agent has a shell and can run a command in the background
([background processes](#background-processes)). A definition that
names its tools keeps exactly those, an empty list included. Where docker is unavailable, a new agent is saved with no
place. So is one whose tools name one the box refuses (`browser`, runner-only for now). A workflow is never given a box.

`capabilities.places.default_place` is the place a new agent gets here, and where a revision that names no place runs.
It is worked out again at each run, the same way as at create: an agentic revision with no place runs in the Docker box
wherever this server has docker now, and on the runner where it does not. A workflow, and a revision whose tools name
one the box refuses, run on the runner. A save checks a revision with no place against where it would run, so `bash`
with no place saves where docker is there and is `422` where it is not. When that is the runner,
`default_reason` says why in docker's own words, such as `new agents run on the runner, because the docker box is
unavailable here: Docker isn't running on this machine (no docker command on PATH): install or start Docker, then
restart AgentRun`. The console's new-agent form says docker's reason too, under its place picker. The console's new-agent form starts on `default_place`, with bash ticked when that place is a sandbox.
What a person picks or unticks there is what is sent.

A run runs in its revision's place, else where `default_place` says at that run (a workflow, and a revision whose tools
name one the box refuses, on the runner). A run request names no place: `POST /agents/{id}/runs`
with `place` is `422 input_invalid`, as with any field the body does not keep. The run keeps the place it resolved to,
and `GET /v2/runs/{id}` shows it as `place`. A harness's own tools in the box, when they come, will be an option of
`sandbox` (such as `native_tools: true`), never a third mode.

`bash` may be named only by an agentic definition whose place is a sandbox (`422` on a runner, named or by default, with
the sandbox place as its `fix`), and a workflow's place is `runner` or none (`422` on a sandbox, with the runner place as
its `fix`). In `capabilities.tools`, `bash` is `available: false` with a `reason` (`no box is set up on this server: …`,
each box's own reason) when no box this server has can run it.

`GET /v2/capabilities` lists `places`: the modes, the default, a new agent's place, and each box with `available`, its `state` (`ready`,
`preparing` while the server builds or pulls its image, or `unavailable`) and, when it is not ready, the `reason`.
A definition naming a box this server does not have saves with a warning on `definition.place`, and a run of it is
`409 agent_not_runnable` with `details.box`. `GET /v2/openapi.json` marks `definition.place`, the run's `place` and
`capabilities.places` `x-agentrun-serve: "place/1"`, `default_reason` `"place/3"`, and `default_place` `"place/4"`
(it replaced `places.default`).

### A run in a Docker box

With docker on (by default, when `AGENTRUN_BOXES` is not set; or listed in it) and a Docker daemon this server's user
may use, a run whose place is
`{"mode": "sandbox", "box": "docker"}` gets one container, made on its first `bash` call (a run with none gets no
container). Those four tools are pi's own, on every harness. `bash` runs in the container. `read`, `write` and `edit`
run on this server, on the `work/` the container binds, because a `docker exec` costs half a second or more per call:
they follow no link anywhere on the way (one pointing inside `work/` included), take only a regular file with one hard
link, and write through a temporary file renamed over the old one, keeping its mode (a new file is `0644`). A refusal
says so and names the box's path; `bash`, in the container, can still reach the file. Where this server reaches
directories by path (no `/proc/self/fd`, as on macOS), or a box binds nothing, all four run in the container, made on
the first of them.
`web_fetch`, `web_search` and the `monid.*` tools stay on this server, and so do
the run's loop, its log, its model calls and every key. What the server itself files in `work/` (monid's long answers,
the browser's evidence) never goes through a link a box's command planted there: each directory is held open on the
way (`/proc/self/fd`). On a host without it (macOS), where a link swapped in mid-walk could still turn a write, a sandbox run's `work/` gets none of
these files: monid's long answers say they could not be saved, and the browser's evidence is not filed. `browser` is runner-only for now (`422` in a sandbox place): its downloads
go through `work/` by path.

- The container binds the run's `work/` alone, read-write, at `/workspace`, where the tools start. Nothing
  else of the data directory enters it. `read`, `write` and `edit` take a path in that directory, relative or absolute,
  or under the run's own `work/` on this machine, which names the same file there (another harness's cwd may name
  one); any other (another path of this machine, `..` out of it, `~`) is refused as outside the workspace, and their
  errors name the box's paths, never this machine's. A mount source that is, or passes through, a link below the data directory is
  refused: the tool call fails, and no container is made. The data directory is resolved to its real path once, at start.
- It has no network of Docker's (`--network none`). On Linux, with a Docker daemon of this machine's own, it reaches a
  list of hosts alone, on ports 80 and 443, through the run's egress proxy. The list, by default: `pypi.org`,
  `files.pythonhosted.org`, `registry.npmjs.org`, `registry.yarnpkg.com`, `github.com` and `codeload.github.com`.
  `AGENTRUN_BOX_ALLOW` replaces it with a comma list of host names, such as
  `pypi.org,files.pythonhosted.org,registry.npmjs.org,registry.yarnpkg.com,github.com,codeload.github.com,deb.debian.org`
  to add one (`*.example.com` names the hosts below `example.com`); `AGENTRUN_BOX_ALLOW=none` is the box offline, as it
  was: no proxy, no network at all. `*`, an address or a CIDR refuses the start.
  - How: the run's process starts the proxy with the list on a Unix socket in a directory of its own under
    `/tmp/agentrun-egress-<uid>/`, bound into the box read-only at `/run/agentrun/egress/`. A `socat` in the box relays
    `127.0.0.1:3128` to it, and `HTTP_PROXY` and `HTTPS_PROXY` (and their lowercase twins) name that port, with
    `NO_PROXY` for loopback. pip, npm, git and curl read them. A program that skips them has no route out.
  - A host off the list, an address and any other port are refused before any lookup, in words: `403 example.com is
    not on this box's network list: use web_fetch for web pages, or ask the operator to add it to AGENTRUN_BOX_ALLOW`.
    So is a listed name whose address is private, this machine's or a cloud's metadata. The proxy holds no key and adds
    none. Its decisions are in the run's process log (`box_egress`: host, port, address, class).
  - Only a Docker daemon on this same Linux machine can reach the proxy's socket. The server checks it once, at start,
    and fails closed: the box has the list only when this machine is Linux, the docker CLI's endpoint is a local unix
    socket, and `docker info` answers within 5 s with Linux containers on this machine's own kernel, keeping its data
    in a directory this server sees. The kernel is the evidence, not the runtime's name:
    - a Docker whose kernel differs from this server's (Docker Desktop on a Mac, OrbStack, Colima) sees a socket bound
      in from the host but cannot connect to it, so its box has no network;
    - a Docker on this server's kernel passes whatever it calls itself, if its data directory is one this server sees:
      Docker Desktop with WSL2 shares the kernel string, but keeps its data outside the distro, so it gets none unless
      the distro has that directory (`/var/lib/docker`); where it passes, the proxy enforces the list as anywhere;
    - a server in a container given the host's docker socket shares the host's kernel but not its files (docker
      info's `DockerRootDir` is not there), so its box has no network rather than every tool call failing.

    Capabilities and the banner say why, naming what was found: `docker boxes have no network: this Docker (OrbStack)
    runs in a VM (its kernel is "6.15.11-orbstack-…", this machine's "6.1.0-…") that can't reach this server's egress
    proxy yet`. At each start the server removes the proxy directories of runs that are gone (a socket that refuses a
    connect, over a minute old); a live run's, of any server of this user's, stays.
  - On a Mac, where Docker runs in a VM, a socket bound in from the Mac does not connect, so the proxy runs inside the
    VM instead: one container per server, `agentrun-egress-<12 hex of the data root>`, labelled `agentrun.egress`. It
    is `node:22-bookworm-slim` pinned by digest, with the kernel's two proxy files and a short entry bound read-only from
    `<data>/egress/`, the list as its one variable, a read-only root, no capability, the server's uid:gid, 256 MiB and
    256 processes. It listens on a Unix socket in a tmpfs volume of the same name, owned by the server's uid, and the
    box mounts that volume read-only at `/run/agentrun/egress/`. The box keeps `--network none`, its `socat` and its
    proxy variables; the proxy container is the only container with a network (Docker's default), and it publishes no
    port. The server turns this on only when `docker info` names a VM runtime it knows, on a kernel that is not the
    Mac's: `Operating System: Docker Desktop` (Docker Desktop), `OrbStack` (OrbStack), or a host name of `colima` or
    `colima-<profile>` (colima). Anything else on a Mac (Rancher Desktop, a Podman machine, a colima whose host name
    was changed, a daemon elsewhere) has no network, and `network_reason` says what was seen. At each start, before any
    run gets the volume's name, the server makes the volume if it is missing; a volume named exactly this server's
    `agentrun-egress-<12 hex>` that lacks its label (Docker made it with its defaults when a box mounted it first) is
    replaced, and no other volume is touched. It removes every container of its own label, pulls the image once if
    Docker lacks it, starts the proxy and waits up to 10 s for it to say it is ready; until then, and if it never does,
    the box's network is `none` with why. Docker restarts a proxy that dies (`--restart unless-stopped`); the server
    starts one that is gone again within about 10 s; its stop removes it, by the id Docker gave it, never by its name.
    Linux keeps the path above, unchanged.
    - The proxy's code is bound from the data directory (`<data>/egress/`), so Docker Desktop must share that path with its
      VM. The default data directory, under your home in `/Users`, is shared. One elsewhere (`XDG_DATA_HOME` or `--data`
      outside Docker Desktop's shared paths) makes the bind fail: the box's network is then `none`, and `network_reason`
      says the proxy did not start. Add the path under Docker Desktop's Settings > Resources > File sharing, or keep the
      data directory under `/Users`.
  - The proxy container's own threat model, on a Mac. It has a network: Docker's bridge, the VM's NAT, then the Mac, its
    LAN and the internet. Nothing reaches it but through the socket in the volume: no TCP listener, no published port,
    no Docker socket, no key, and a variable that is the list alone; its entry refuses to start with no list, since a
    proxy with none would reach every public host. The host list comes first, so an unlisted name is never looked up
    and an address is never dialled: `host.docker.internal`, `gateway.docker.internal`, `host.orb.internal`,
    `host.lima.internal` and the VM's own addresses cannot even be asked for. A listed name that resolves to the VM or
    the Mac is refused by the same address rule as on Linux: OrbStack's Mac host and gateway (seen at addresses in
    `0.0.0.0/8`, which the rule refuses as unspecified; OrbStack's docs do not name them), Docker Desktop's VM network
    and colima's host address (both in RFC 1918 private space), the Docker bridge, a home LAN, a Tailscale address,
    cloud metadata and IPv6 unique local. What stays: the rule checks the container's own interfaces, not the Mac's, so
    a listed name that DNS points at the Mac's public address, or at the router through hairpin NAT, would be dialled;
    and the cap of 256 connections open at once is the server's, shared by all its runs, not each run's, so one run that
    holds many open can starve the others until its connections close.
  - Capabilities give the list as `places.allow`, and each box's `network`: `allowlist` or `none`, with
    `network_reason` when an available box has none. An image with no `socat` gets no network, and the run's timeline
    says so once.
  - What it allows, and what it does not: a box reaches no cloud metadata address, nothing of this machine or its
    network, and no resolver, so no name leaves this machine but a listed one. It can send what its run has to a listed
    host with the agent's own credentials (an `npm publish`, a `git push`), as `web_fetch` can send to any public host.
  Docker still binds its copies of this machine's
  `/etc/resolv.conf`, `/etc/hostname` and `/etc/hosts` into it, read-only, so a box's command can read this machine's
  resolver settings (its nameservers and search domains), with no network to use them. Its environment is
  `LANG=C.UTF-8` and `HOME=/tmp` and the image's own: never this server's, so no key or token is in it. It runs as this
  server's uid:gid, so what it writes in `work/` stays this server's. It starts from [the box's image](#the-boxs-image).
  It may use 2 CPUs' time, 4 GiB of memory, swap included, and 1,024 processes and threads (`--cpu-period 100000
  --cpu-quota 200000 --memory 4g --memory-swap 4g --pids-limit 1024`), so a runaway build or a fork bomb stops in the
  box. `AGENTRUN_BOX_CPUS` (at least `0.01`), `AGENTRUN_BOX_MEMORY` (with its unit, such as `8g`, and at least `6m`) and
  `AGENTRUN_BOX_PIDS` (at most 4,194,304) change them; any other value refuses the start. `AGENTRUN_BOX_CPUS` caps CPU
  time, as a CFS quota (the cap `--cpus` sets), so it holds whatever CPU count Docker's VM has, and where the kernel
  gives Docker no CPU controller (a rootless Docker without one delegated), Docker ignores it with a warning.
- `bash` takes pi's `{command, timeout?}`, `timeout` in seconds, 300 when the call names none; a timeout kills the
  command's process group in the container. Its answer is its output's last 2,000 lines or 50 KB. Each call is a fresh
  shell in `work/`.
- A command that should outlive one call (a server, a watcher, a long build) goes in the background instead
  ([background processes](#background-processes)).
- It has no capability and can gain none (`--cap-drop ALL`, `--security-opt no-new-privileges`), so even as root (a
  server run as uid 0) it cannot make a device node in `work/`. Its Docker daemon must be this machine's: where
  `DOCKER_HOST`, or the docker context, names another machine (tcp://, ssh://), no box is made, since that daemon would
  bind its own paths, and the refusal says which setting to undo.
- The container is labelled `agentrun.run=<run id>`, and the label is its only record. A run's process that starts again
  after a crash finds it by the label and first kills the commands the dead process left running. It is destroyed when
  the run ends (completed, failed or cancelled: a follow-up after a completed run gets a fresh one, with the same
  `work/`) and when the run is archived. A start destroys every such container whose run has ended or is archived; one
  of a run this data directory does not know is left to its 24-hour lifetime.

### Background processes

An agent whose place is a sandbox may also name `bash_background`, `bash_output`, `bash_input`, `bash_signal` and
`bash_list`, to run a command that outlives one call: a dev server, a watcher, a long build, a program that reads its
input as it goes. Each call is one short command in the run's box, on the same path as `bash`, so they work on every box
`bash` runs on, and nothing new runs on this server.

The permission gate holds all five to `bash`'s setting (none is a settings key of its own, so no setting of one lifts
`bash`'s), and `capabilities.tools` and an agent's `tools` show each as the gate takes it, `permission_from` being
where `bash`'s setting came from:

- `bash: deny` refuses all five, as it refuses `bash`, with no shell at all.
- `bash: ask` parks only the calls that start or feed a process: `bash_background` and `bash_input` (and `bash`
  itself), each under its own name, so an approval runs that call. `bash_output`, `bash_list` and `bash_signal` run
  unasked: they reach only the processes this run started, by its own ids (another run's id, or one never started, is
  answered "there is no background process"), so watching an approved process costs no approval per page. They run so
  on a server with accounts off too, where an ask is refused. Only an `ask` set as written lets them: where `bash` asks
  because its setting is a value not offered, or because the settings file never read, they ask too. A save of the
  settings as served keeps that stand-in, and the file keeps the value as written; only a different permission sets it.
- `bash: allow` runs all five.

- `bash_background {command}` starts the command from `work/`, in a fresh shell (`bash`, else `sh`) under a session of
  its own (`setsid`, its runner under `nohup`), and answers its id (`"1"`, then `"2"`, and on) at once. Its stdout and
  stderr go together to `work/background/<id>/output.log`, beside `command`, `started`, `pid` (its process group) and,
  once it ends, `exit` (its code; 128 + n for signal n). The run's files show them (`GET /v2/runs/{id}/files`), so the
  console and the API show each log, during the run and after it.
- Those files are for people to read: the run's own file tools can write anything in `work/`, so no call trusts one.
  The group a signal goes to, the exit code, the start time, the command and the run's-end mark are kept in the box's
  own directory (its `TMPDIR`, else `/tmp`), out of `work/`. A copy in `work/` is written from inside
  `work/background/<id>`, entered and checked by its real path, to a new file of a name no one can guess, created and
  written in one exclusive open, then renamed over its name; so a link planted at the name or at the directory is never
  followed, and a real directory standing at the name skips that copy (as does a failed check). At the run's end every
  copy (`command` and `started` among them) is written again, so a link planted at one since its start does not stay.
  `output.log` is opened first and then checked as opened (through `/proc`: the file reached is
  `work/background/<id>/output.log` itself, by its real path, and a regular file), and every read is of that open file,
  so a link swapped in after the check is never read. A link planted at it is refused, saying so; a box with no `/proc`
  to check by refuses every log, saying that instead. A directory made in `work/background/` that this box did not
  start reads as "not started in this box", and is never signalled.
- A process runs until no live process of its group is left: a child the command starts with `&` (a server, its
  output sent elsewhere) keeps it running, counted against the cap, signalled with it and ended at the run's end; its
  exit code is the shell's.
- A child that leaves the process group (one that calls `setsid`, a daemon that detaches) is not tracked: it is not
  counted against the cap, no `bash_signal` reaches it, and the run's end does not end it. Only the box's end (its
  destroy at the run's end) or its 24-hour lifetime ends it; the box's process limit (`AGENTRUN_BOX_PIDS`) only bounds
  how many processes there can be.
- A process whose runner ended before it did (its box was replaced, or the runner was killed) reads as gone, its exit
  code not known.
- At most 8 run at once in a run's box: a ninth start is refused, saying so, until one ends. Each log keeps the first
  16 MiB of the output; later output is dropped while the process runs on, and `bash_output` says so.
- `bash_background {command, tty: true}` runs the command on a terminal instead: `script -qfec` (util-linux) in the box
  gives it a pty, so a program that needs one works (a prompt, a REPL, a progress display). Paging, input and signals are
  the same calls: the log holds what the terminal shows (input echoed, lines ending in `\r\n`), `bash_input` types into
  the terminal, and `bash_signal` reaches the terminal's processes: `INT` goes to its foreground job, as Ctrl-C does, so an
  interactive shell's running command stops and the shell runs on; `TERM` and `KILL` go to every process group of the
  terminal's session. That session is tracked as the process: a child its command leaves running on the terminal keeps
  the process running, counted against the cap, reached by `bash_signal` and ended at the run's end, after `script`
  itself is gone. A box with no `script`, or with another `script` than util-linux's (busybox's takes no `-e`, and without it
  always exits 0, so the command's exit code would be lost), refuses `tty: true`, saying so, and starts nothing. `bash_list` marks such a
  process `(tty)`.
- `bash_output {id, offset?, max_bytes?}` reads the log from a byte offset (0 when absent), at most 48 KiB a call (the
  default), never splitting a character (a page too small for the character it starts at is refused, saying so): whether the process still runs, its exit code once it ended, the log's size,
  and the offset to read from next. Once it says the process ended, the log is whole.
- `bash_input {id, text, close?}` writes `text` to the process's stdin as given (end a line with `\n`), at most 64 KiB a
  call; `close: true` closes its stdin after it, so the process reads the end of its input. The stdin is a fifo in the
  box's `TMPDIR` (else `/tmp`), never in `work/`.
- `bash_signal {id, signal}` sends the process's group `TERM`, `INT` or `KILL`, and answers its state after up to 2 s.
- `bash_list` names each process: running or how it ended, its output's size, when it started and its command's start
  (every running one, then the newest that ended, 40 at most).
- The run's end ends them: before its box is copied back and destroyed, the server sends each running group `TERM`,
  then `KILL` after 3 s, and marks each with `ended` beside its log, which stays in the run's files; the server's log says
  `background_ended` with how many. A follow-up's box starts with none running, and its ids go on from the last.

### A run in a Daytona box

With `AGENTRUN_BOXES=daytona` and `DAYTONA_API_KEY`, a run whose place is `{"mode": "sandbox", "box": "daytona"}` gets one
Daytona sandbox, made on its first `read`, `write`, `edit` or `bash` call, with the same tools, path rules, environment,
`bash` and labels as a Docker box. What differs (its `read`, `write` and `edit` run in the sandbox, as its `bash` does,
since nothing binds `work/` there):

- The key is this server's alone. The server makes, copies to and from, and destroys the sandbox itself. The run's
  process holds no key: it reaches its sandbox only through the server's box relay, on loopback, which takes a call for
  a run only with that run's own door token (`DIR/disk/agents/<agent>/runs/<id>/door-token`, handed to that run's process alone) and adds
  the key to the calls a run's tools make of their own sandbox (a read of it, and its toolbox's programs and files). It
  refuses every other call (a create, a listing, a stop, a delete, another run's sandbox or token, any other host), and
  it never follows a redirect, nor does the server's own Daytona client: a redirect would carry the key.
- It reaches the hosts `AGENTRUN_BOX_ALLOW` names, and no other: Daytona's domain list (`domainAllowList`), which
  Daytona's egress proxy enforces. Unset or empty, the list is the package registries and GitHub: `pypi.org`,
  `files.pythonhosted.org`, `registry.npmjs.org`, `registry.yarnpkg.com`, `github.com` and `codeload.github.com`. A
  comma list of hosts (a `*.` wildcard allowed, at most 100) replaces it, so to add one, copy this list and extend it.
  `AGENTRUN_BOX_ALLOW=none` blocks its network (`networkBlockAll`), as before the list. `*`, an IP address, a CIDR, a
  port or a URL refuses the start. Capabilities show the hosts in `places.allow`, and the box's `network` (`allowlist` or
  `none`) in its `places.boxes` entry. Daytona's proxy re-signs each TLS connection with Daytona's own CA, which the
  sandbox's environment names to pip, npm, git and curl (`REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`,
  `CURL_CA_BUNDLE`, `SSL_CERT_FILE`).
- A sandbox whose own read does not carry the list it was asked for is deleted. Daytona takes a domain list on its tier 3
  and 4 only: where it keeps none, or refuses it, the server makes the run's box again with its network blocked, never
  open, and makes every later Daytona box that way until it starts again. The log says so once, with Daytona's own
  words (`event=box_network box=daytona network=none refused=<code> message="…"`), and capabilities show the box's
  `network` as `none` with its `network_reason`. A box the server finds is kept when it has no network, or the list the
  setting names now (the same hosts, in any order, as Daytona reads them back); any other (a wider or narrower list, a
  list when the setting is `none`) is destroyed and made again, so a changed list holds for a run's box after a restart.
- A sandbox Daytona does not report blocked, when blocked was asked, is deleted, and the tool call fails saying so. An
  organization on Daytona's tier 1 or 2 keeps its own network policy, which a sandbox cannot override, so a run there
  gets no Daytona box unless that policy blocks it.
- A sandbox cannot bind `work/`. The server copies `work/` into it at `/workspace` when it makes it, and
  copies what changed back at each turn's end (a read of the run's files waits for that copy) and once more before the
  run's end is recorded. Daytona's answer is never trusted: the copy back writes regular files and directories only,
  never a link and nothing outside `work/`, and a file this server changed since the last copy stays as this server
  has it. A file the box removed is removed here too. What the server files in `work/` during the run (monid's long
  answers) is copied into the sandbox as well. The copy's mark is `box-sync.json` beside the run, which the server alone
  writes; the run's process notes each file it copied in, in `box-mirrored.jsonl` beside it, and a copy back counts
  those as held by both sides, so an edit the box makes to one comes back.
- The sandbox is destroyed after the last copy back, and only once that copy is whole: when the run ends, and when it
  is archived (a copy that fails at an archive keeps the sandbox for the run's end). A copy that fails at the run's end
  is tried again, and the end waits for it. One that stops for good (an archive the server cannot read, or a limit a copy
  that brought nothing reached) keeps the sandbox, says so in the log (`event=box_kept` with its id), and lets the run
  end with what did come back. A start pulls a run it finds waiting for the person, and copies back, then destroys, the
  sandbox of every run that has ended or is archived. One whose copy fails is kept for the next start.
- A kept sandbox has Daytona's auto-delete turned off (a sandbox is made with auto-delete at 0, which deletes it as it
  stops) and is set to stop after 15 minutes without activity, so once stopped it costs its disk alone (3 GiB on
  Daytona's default snapshot, at Daytona's storage price) and no compute; its files stay. The next start wakes it, copies
  back again, and destroys it once that copy is whole; else its 24-hour lifetime ends it. To remove one sooner, delete
  the sandbox in Daytona's dashboard or API: it carries the labels `agentrun.box=run` and `agentrun.run=<run id>`.
- A run's sandbox that Daytona stopped, paused (a sandbox class that pauses when idle, while the run waits for its
  person) or archived (a stopped one it moved away) is started again, an archived one restored, when the server next
  needs it: for the run's next tool call, a copy back, or the start's sweep. One still stopping, pausing or archiving
  is waited for (a minute at most) first. It is never replaced by a new one, so
  what only it holds stays.
- The sandbox is Daytona's default snapshot, made as its user, with `sudo -n` making `/workspace`.

### A run in a Modal sandbox

With `modal` listed in `AGENTRUN_BOXES`, its token set and its SDK installed, a run whose place is
`{"mode": "sandbox", "box": "modal"}` gets one Modal sandbox, made on its first `read`, `write`, `edit` or `bash` call. It
is Modal's default sandbox runtime (gVisor), not a virtual machine: the server does not ask Modal for its VM runtime. It works like a
[Daytona box](#a-run-in-a-daytona-box): the same tools, path rules, environment and labels, and its `read`, `write` and
`edit` run in the sandbox too. What differs:

- The token and the SDK's client are this server's alone. The server makes the sandbox, copies `work/` into it at
  `/workspace`, copies what changed back at each turn's end and once more before the run's end is recorded,
  and ends it after that last copy, at the run's end, a cancel included, and at an archive. The copy rules (no link,
  nothing outside `work/`, a file this server changed stays as it has it) are Daytona's.
- The run's process holds no token. Its calls to its sandbox go through the server's box relay, on loopback, with that
  run's own door token. The relay makes only the calls a run's tools make of their own sandbox, with the server's
  client: finding it, reading its state and tags, and starting a program in it with that program's input, output and
  exit. It refuses everything else: a create, a listing, an end, a tag change, or another run's sandbox or program.
- It has no network, whatever `AGENTRUN_BOX_ALLOW` names. The provider takes a domain list when a sandbox is made, but
  its SDK cannot read a sandbox's list back, so this server cannot check that a box holds the list it asked for (as it
  does for Daytona). Each box is made with its network blocked, never with the provider's open default. Capabilities
  show the box's `network` as `none`, with `network_reason`, unless the setting is `none`.
- A sandbox that is gone (it ended, or its lifetime ran out) is made again on the run's next tool call and seeded
  with the run's `work/`. The call that met the gone box fails, saying so.
- Each Modal sandbox reserves 2 CPUs and 4 GiB of memory by default, which the provider bills for while the box lives:
  the Docker box's defaults, asked of the provider as the sandbox's CPU and memory. `AGENTRUN_BOX_CPUS` and
  `AGENTRUN_BOX_MEMORY` change both boxes alike (such as `AGENTRUN_BOX_CPUS=1 AGENTRUN_BOX_MEMORY=1g`). The provider has
  no process limit, so `AGENTRUN_BOX_PIDS` does not apply. Its lifetime is 24 hours, as every box's is.
- A start copies back, then ends, the sandbox of every run that has ended or is archived.

### The box's image

A Docker box starts from this server's own image by default: `agentrun-box`, python 3.12 (`python:3.12-slim`, pinned by
its digest) with git, curl, node and npm (Debian's `nodejs` and `npm`), rg (`ripgrep`), `socat` (the relay to the box's
network proxy, when it has one) and their certificates, about 360 MB. Its
recipe is `BOX_RECIPE` in `src/box-image.ts`, its base `BOX_BASE` there. The server builds it on first use
(`docker build`, at most 10 minutes, its context a private directory under `TMPDIR` holding the recipe alone as its
`Dockerfile`, removed after), tags it with the recipe's hash (`agentrun-box:<12 hex>`) and labels it with the whole hash
(`agentrun.box-image`), and builds again only when the recipe changes: a start that finds the image with this recipe's
hash uses it. To move the base, read the tag's index digest again from Docker Hub (the comment beside `BOX_BASE` says
how) and put it there: the recipe's hash changes, and so does the image's tag, so the next start builds it. The build
reaches the network, for the base image and apt; a box made from it never does through Docker's (`--network none`). A build that fails
leaves the box unavailable with the reason ([Boxes](#boxes)). Images of older recipes stay until you remove them:
`docker image ls --filter label=agentrun.box-image` lists them all, and `docker image rm agentrun-box:<12 hex>` removes
one.

A box reaches its package registries (on Linux), so `pip install` and `npm install` work in it, but not `apt-get`: the
box runs as this server's user, with no root. For other tools, name another image
in `AGENTRUN_DOCKER_IMAGE`: the server then pulls it when Docker has none (at most 10 minutes) and builds nothing.
This image, its build and the wait for it are the Docker box's alone: a Daytona box is made by the server from
Daytona's own image, and a Daytona run never waits on this one.

```sh
AGENTRUN_DOCKER_IMAGE=python:3.12-bookworm AGENTRUN_BOXES=docker node packages/serve/dist/cli.js
```

`python:3.12-bookworm` adds compilers and the build tools of Debian's `buildpack-deps`. To bring your own, build one
`FROM` the base you want, tag it, and name the tag. An image based on Debian has what a box needs to run commands:
`sh`, `sleep` and `setsid`, and `bash` for the `bash` tool when there is one (else `sh`). The image's own entrypoint
never runs; the box's first process is a `sleep` of its lifetime.

### In the published image

The published image, `ghcr.io/parcha-ai/agentrun-server`, runs Docker boxes on the Docker of the host it runs on, through
that Docker's socket, as `compose.yaml` at the repository's root starts it ([in a container](#in-a-container)). The image
has the Docker client (Debian's `docker-cli`) and no daemon; `group_add` gives the image's `node` user the socket's group
(`DOCKER_GID`), so the server never runs as root.

- **The socket is root on the host.** Whatever can reach `/var/run/docker.sock` can start a privileged container and do
  anything on the host: the server, and every run's process it starts, since a run makes its own box. It is the same
  trust as a server on a host whose user is in the `docker` group. Give the server the socket only where you would give
  it root. A box never gets it.
- **A box is a container beside the server's.** It is made as on a Linux host (`--network none`, every capability dropped,
  no new privileges, the server's uid, the box limits), and its only way out is the run's egress proxy, with the same
  host list and the same address rule ([a run in a Docker box](#a-run-in-a-docker-box)).
- **Its files.** The daemon has none of the server's paths, only what it mounted into the server's container. At its
  start the server reads its own container's id from `/proc/self/mountinfo`, asks Docker for that container's mounts
  (`docker inspect`), and takes the named volume that holds the data directory. A box mounts that run's `work/` from it,
  and the run's egress proxy's directory (`<data>/box-egress/<16 hex>/`, read-only), as the volume's subpaths
  (`--mount type=volume,...,volume-subpath=disk/agents/<key>/runs/<run>/work`), never the rest. The run's files and the box's are the same
  files, as on a host.
- **Any other layout** (the data directory not on a read-write named volume of the server's own container, the socket of
  another Docker than the one that runs the server, a container whose id `/proc/self/mountinfo` does not name) makes
  docker unavailable at the start, its reason in capabilities and the `event=box_paths` line: `run AgentRun in a
  container with docker compose up from compose.yaml (its named data volume is how boxes reach a run's files)`. On an
  older engine: `Docker Engine <26 can't mount a named volume's subpath: upgrade to Docker 26+`.
- On a host the server finds no container of its own and asks Docker nothing: a box binds this machine's paths and its
  proxy's directory is under `/tmp`, as before.

### Boxes

A box is a machine apart from this one where a run's tools run. Runs execute in `docker`, `daytona` and `modal` boxes
([place](#place)); the others are set up and probed, and say runs in them are not available yet.

Docker is on by default. With `AGENTRUN_BOXES` not set at all (a plain `npx @parcha/agentrun`), the server probes
`docker` as if it were listed, and offers it when Docker answers (`ready`, or `preparing` while its image comes), so a
new agent lands in the Docker box with a shell. When Docker does not answer, new agents run on the runner, and the
banner, `capabilities.places.default_reason`, docker's own `reason` and the console's new-agent form say why. Every
other box is yours to list.

`AGENTRUN_BOXES`, when set, wins: it lists the boxes to set up, as a comma list of the ids below
(`AGENTRUN_BOXES=docker,daytona`), and the server never probes a box the list does not name, Docker included. An empty
value (`AGENTRUN_BOXES=`) or `AGENTRUN_BOXES=none` sets up no box. `none` stands alone, and a name that is no box
refuses the start. At start the server probes each listed box once. The probes run at once, each within 5 s. Then one
log line says what the server found:

    event=boxes available=<ids or none> unavailable=<ids> <id>="<why>" ...

The line gives a reason for each listed box that is unavailable, and the banner says the same in words
(`Boxes: docker is ready, so sandbox agents run their tools there.` with a list; `Boxes: docker (on by default; set
AGENTRUN_BOXES to change).` without one). Each reason says what to do next: a box the list
does not name says `not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker` (keeping the boxes it already
lists), a missing `docker` command says `Docker isn't running on this machine (no docker command on PATH): install or
start Docker, then restart AgentRun`, and a `docker` whose daemon does not answer says to start Docker or add this
user to the `docker` group, then restart AgentRun, since the probe runs once. A reason never holds a key, a command's output or a
provider's answer.

- `docker`: the `docker` command on PATH, with a daemon that answers `docker version` for this server's user. It needs no key.
  Then the server asks Docker for [the box's image](#the-boxs-image) (`docker image inspect`). When Docker has it (the
  default with this recipe's hash), the box is `ready`. When not, the server builds the default, or pulls the image
  `AGENTRUN_DOCKER_IMAGE` names, once, in the background, for at most 10 minutes. Meanwhile the box is available and
  `preparing` (`building the box image (python, git, curl, node, npm, rg)`, or `pulling <image>`), and a sandbox run whose
  first box comes then waits for the image, with one row on its timeline (`Preparing the box image: building it (python,
  git, curl, node, npm, rg)…`), instead of a first tool call that pulls it silently. A build or pull that fails is tried once
  more, 5 seconds later, the box `preparing` meanwhile with what failed (`trying once more: the build of the box image
  could not reach the network (…)`). One that fails again, or takes longer, makes the box unavailable with the reason
  (the build could not reach the network, pull its base or install a package, ran out of disk; the registry refused the
  image, has no such image, could not be reached; or the time ran out) until a restart tries again. A run that was
  waiting fails its call with that reason, and the next sandbox run is `409 agent_not_runnable`. A server stopped or
  killed while its image comes leaves no run waiting on it: a run's first box fails its call at once, with `the server
  stopped while building it: restart the server to build it again`, never Docker's own error, and the next start
  builds it again.
- `daytona`: needs `DAYTONA_API_KEY`. Set `DAYTONA_API_URL` and `DAYTONA_TARGET` when Daytona's defaults do not fit.
  The probe makes one authenticated read, of a box that does not exist. If Daytona refuses the key, the box is unavailable.
- `modal`: needs `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` and the SDK, which the host installs (`npm install modal`).
  Its sandboxes live in the app that `AGENTRUN_BOX_APP` names (default `agentrun`). The probe checks that the SDK loads
  and the token is set. It asks nothing of the provider. Runs execute in it: [a run in a Modal sandbox](#a-run-in-a-modal-sandbox).
- `bwrap` is not in this release yet.

The boxes come from `@parcha/pi-transport`, a dependency of this package, so every install of the server, `npx
@parcha/agentrun`'s included, has the Docker box's provider.
The keys belong to the server alone. The launcher hands them over with the server's other secrets, and no run's process
gets them, in its environment or on its pipe.

## Models

An agentic revision names its model as `provider/model-id` (`"model"` in its definition), or names none and runs on
this host's default, `AGENT_MODEL`. With no `AGENT_MODEL`, a model provider's key, the server's own or saved as a
[tool key](#tool-keys), gives the default, the first of: `anthropic/claude-sonnet-5-5` with `ANTHROPIC_API_KEY`,
`openai/gpt-6.1-sol` with `OPENAI_API_KEY`, `openrouter/anthropic/claude-sonnet-5.5` with `OPENROUTER_API_KEY`. Each is
its provider's capable everyday model, not its dearest ($2 in and $10 out per million tokens); set `AGENT_MODEL` for
another. claude-agent takes only the Anthropic one and codex only the OpenAI one. A workflow revision names no model: each model node names a tier (`fast`, `default`
or `strong`), and the host maps it, `fast` to `AGENT_MODEL_FAST` and `strong` to `AGENT_MODEL_STRONG`, each falling back
to `AGENT_MODEL`. Capabilities show the mapping in `models` (`{source, route_prefix, fast, default, strong}`):
`source` is `gateway`, `providers` or `faux` (the published document marks these as `models/2`, beyond the contract's
`managed`, `chatgpt`, `env` and `faux`), and `route_prefix` is the routing prefix this server puts before a gateway's
model ids (`agent-model`), which a client takes off to show the gateway's own id, and null with any other source.
`models` also says `ready`, whether a revision that names no model runs here, and when it does not, `needs`: `key` (no
model provider's key, or none for the default's provider) or `model` (`AGENT_MODEL` names one this server does not
know); and `priced`, whether that model has a price here, which a run's `max_cost_usd` needs (false for a gateway
model with no price set that the catalog does not list in any form; null while `ready` is false, with no model to price). Where the models come from:

- `--faux MODULE`: every model is the module's (below), with no key and no network: `faux-1`, or for a tier the model
  id its variable names.
- `AGENT_MODEL_BASE_URL`: every model id goes to that one OpenAI Responses endpoint, a gateway, at `<base>/v1/responses`
  with one trailing `/v1` taken off the base first, as for every harness (OpenRouter's is `https://openrouter.ai/api` or
  `https://openrouter.ai/api/v1`): a revision's `provider/model-id` is sent whole, as a gateway like OpenRouter names its
  models `vendor/model`, and `AGENT_MODEL`, `AGENT_MODEL_FAST` and `AGENT_MODEL_STRONG` are sent as they are. For a
  gateway that wants the id alone, `AGENT_MODEL_GATEWAY_IDS=bare` sends a revision's model without its provider. `AGENT_MODEL_API_KEY` is its key when it needs one. `AGENT_MODEL_PRICE` is `input,output,cacheRead[,cacheWrite]`
  in USD per million tokens, so a run's cost estimate has a price; `AGENT_MODEL_FAST_PRICE` and `AGENT_MODEL_STRONG_PRICE`
  price their tier's model, and default to it. With no price set, a model id pi-ai's catalog knows (`gpt-6-luna`, say)
  takes the catalog's list price; one it lists only with its version's separators written the other way (a gateway's
  `gpt-5-4-mini` for the catalog's `gpt-5.4-mini`, `claude-haiku-4.5` for `claude-haiku-4-5`) takes that entry's price,
  only when every entry of that form lists one price (else none), and the id sent to the gateway stays as named; any
  other has no price: its answers' cost is unknown, so the run's `cost.usd` is
  `null`, never $0. A model the catalog lists at $0, or one `AGENT_MODEL_PRICE=0,0` prices, is a known $0. A revision's `provider/model-id` takes that provider's
  entry when it is paid; a bare id, a provider the catalog does not list for it, or one it lists at $0 takes the highest
  price any provider lists (one entry's whole price, the most input plus output; a $0 entry never wins over a paid one),
  as the gateway does not say whose model answers. A run with `max_cost_usd` on a model with no price is refused before it
  starts: 409 `agent_not_runnable`, whose `error.fields` entry names `definition.model`, the reason `not_set_up_here`, "The
  model <id> has no price here, so a run's spend cap cannot be kept on it." and the `fix` naming `AGENT_MODEL_PRICE`, as
  every 409 `agent_not_runnable` names each thing that keeps a run from starting; an agent saved with a default cap on one
  gets that as a warning. One
  without a cap runs, on every harness, with each request's cost unknown: codex's and opencode's proxy books it unknown,
  never $0, so the run's `cost.usd` is `null` and `/usage` counts it in `unpriced_runs`.
- Otherwise pi-ai's providers serve them, each with its key from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, Bedrock's `AWS_*` keys, ...), and its catalog prices the run. The `AGENT_MODEL`
  variables are then `provider/model-id` too. The launcher holds every key pi-ai reads, as it holds the rest, and a run's
  process is handed a model key only when its model needs it: a pi run its model's provider's (a run on Gemini
  `GEMINI_API_KEY`, one on `openrouter/...` `OPENROUTER_API_KEY`; a workflow each of its tiers'), or `AGENT_MODEL_API_KEY`
  through the gateway; a codex run `OPENAI_API_KEY`, or `AGENT_MODEL_API_KEY` through the gateway; a claude-agent run
  `ANTHROPIC_API_KEY`. No run gets another's. A workflow's decision nodes get their providers' keys on a descriptor of
  their own, whatever its model, and only those ([Safety](#safety)).

A definition is checked for what keeps it from running here when it is saved, with the same checks a run makes before
it starts:

- What no setting of this host fixes refuses the save, `422 input_invalid` by field, and nothing is written: a tool
  this host does not bind (`definition.tools[i]`), `bash` on an agent whose place is not a sandbox, a model pi-ai does
  not know when no gateway is set (`definition.model`, saying why), empty instructions (`definition.instructions`), and a workflow that needs a tool
  call this host does not run, code, or a node tool other than `read`, `write` and `edit` (`definition.workflow`, one
  field per need).
- What a setting of this host fixes saves, and the `201` or `200` carries it in `warnings` (`[{field, reason:
  "not_set_up_here", message}]`, empty when there is none): no key for the model's provider, no default model for a
  revision that names none, no model for a tier a workflow's nodes name, no key for the decision provider a workflow's
  typed questions name ([decision workflows](#decision-workflows)). A decision provider this server does not have
  refuses the save.

A run is refused before it starts, `409 agent_not_runnable`, saying which, for any of these: a warning the host has not
fixed yet, or a revision saved before these checks. A run needs only the tiers it uses: an agentic one its model or the default, a workflow the tiers its nodes name, so a
workflow of fast nodes runs with `AGENT_MODEL_FAST` and no `AGENT_MODEL`. A run thinks at its `effort` (`low`, `medium`,
`high`), else at its agentic revision's `thinking` (`low` to `max`), else at the host's `AGENT_THINKING`, else at medium;
it is never off, and a model node that names its own thinking level keeps it. An agentic run started with an `effort` also
gets a short note on how to work, right after its instructions, on every harness (`src/effort-guidance.ts`): `low`
answers directly, `medium` plans briefly and checks once, `high` plans each part, fills the gaps and reviews. A run
started with none gets no note.

## Tools

A revision names its tools from one closed table (`src/tools.ts`): each name is how the run's process binds it and the
variables of this server's environment it needs. Nothing outside the table can be named, and no tool is loaded from
anywhere else. `GET /capabilities` lists every one in `tools`, `available: true` or `false` with the variables it is
`missing` (their names, never their values), `nodes` for whether a workflow's model node may name it, and `calls` for
whether a workflow's `call` node `via: "tool"` may run it. A run of a
revision that names a tool outside the table, or one whose variables are not set, is refused before it starts (`409
agent_not_runnable`, with `details.unbound` and `details.missing`).

| Tool | What it does | Needs | A workflow's model node may name it, a call node run it |
| --- | --- | --- | --- |
| `read` | Read a file in the run's `work/`; in a box, also an image (png, jpg, gif, webp, by its bytes) at any absolute path in the box, such as one rendered to `/tmp`, read through the box and never from the host | nothing | yes, no |
| `write` | Write a file in the run's `work/` | nothing | yes, no |
| `edit` | Edit a file in the run's `work/` | nothing | yes, no |
| `bash` | Run a shell command in the run's box, from its `work/`: pi's `{command, timeout?}`, 120 s when the call names no timeout and at most 600 s (a longer one runs at 600 s and says so; longer work is `bash_background`) | an agentic definition whose place is a sandbox ([Sandbox](#sandbox)) | no, no |
| `bash_background` | Start a shell command in the background in the run's box, from its `work/`, and answer its id at once: `{command, tty?}` in, `tty: true` for a terminal. Its stdout and stderr go to `work/background/<id>/output.log`, the first 16 MiB; at most 8 run at once ([background processes](#background-processes)) | an agentic definition whose place is a sandbox | no, no |
| `bash_output` | Read a background process's output from a byte offset: `{id, offset?, max_bytes?}` in (at most 48 KiB a call), its state, exit code, the log's size and the next offset out | an agentic definition whose place is a sandbox | no, no |
| `bash_input` | Write to a running background process's stdin: `{id, text, close?}` (at most 64 KiB a call) | an agentic definition whose place is a sandbox | no, no |
| `bash_signal` | Send a background process's group `TERM`, `INT` or `KILL`: `{id, signal}` | an agentic definition whose place is a sandbox | no, no |
| `bash_list` | List the run's background processes: id, state or exit code, output size, start time and command | an agentic definition whose place is a sandbox | no, no |
| `ask_person` | Ask the person who started the run; the turn ends until a message answers | nothing | no, no |
| `web_fetch` | Read one web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked ([search and fetch](#search-and-fetch)), a part at a time: `{url, offset?, max_chars?}` in, a Page out, `{ok, url, status, title, text, chars, truncated?, original_chars?, beyond_read?, offset?, next_offset?, html_chars?, converted?, links, links_omitted?, via, parallel?, refused?, error?}` | nothing (`PARALLEL_API_KEY` for Parallel, one billed extract a page a run) | yes, yes |
| `web_search` | Search the web, natively where the harness or the model's provider can, else through Parallel where the server holds its key, else keyless through Exa, or through the provider picked ([search and fetch](#search-and-fetch)): `{query, n?}` in, `{provider, query, results: [{url, title, snippet, published?}], text?}` or `{error}` out | nothing (`PARALLEL_API_KEY` for Parallel) | yes, yes |
| `browser` | A hosted browser, Browserbase's or Kernel's, on pi-browser's durable adapter: `snapshot`, `run`, `screenshot`, `browser_read`, `browser_release`, `browser_relaunch`, `browser_downloads` and `browser_upload` (into and from the run's `work/`); Kernel keeps no downloads, so a run on Kernel has no `browser_downloads` | `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`, or `KERNEL_API_KEY` | yes, no |
| `monid.discover` | Search monid's catalog of paid data endpoints in plain words: `{query, limit?, minScore?}` in, `{results: [{provider, endpoint, description, score, price}]}` out | `MONID_API_KEY` | no, no |
| `monid.inspect` | One monid endpoint before it runs: `{provider, endpoint}` in, the JSON Schemas of its input (`pathParams`, `queryParams`, `body`), its price, notes and documentation out | `MONID_API_KEY` | no, no |
| `monid.run` | Run one monid endpoint, paid per call from the monid wallet: `{provider, endpoint, input}` in, the run's `output`, `price` and `cost` out | `MONID_API_KEY` | no, no |
| `pdf_pages` | A workflow call only: `{path, maxPages?, dpi?}` in, `{name, pageCount, dpi, pages: [{page, image}], text}` out. Draws a document's first pages (3 by default, at 110 dpi) as PNGs under the run's `work/pages/<stem>/<dpi>/` (`<stem>`: the document's path below its directory made one name, with a short hash, so two documents of one file name never share pages), the dpi lowered so a page's long side is at most 1568 px, with its text (`pdftotext`, cut at 20,000 characters). A PNG or JPEG passes through as one page, scaled down to 1568 px. `path` is under `--documents` or the run's `work/`, never outside | `pdftoppm`, `pdftotext` | no, yes |
| `llm` | A workflow call only: `{prompt, system?, maxTokens?, tier?}` in, `{text, model, usage, cost_usd}` out. One completion on the run's model of the tier (`default`; a tier the state fills in, such as `"{requestedTier}"`, may be any of the three, and a tier with no model fails the call), no tools and no loop; `cost_usd` is null when the model has no price, never 0 | a model | no, yes |

`bash` and the background tools run only in a box: a runner agent, and a workflow, get no shell on this machine (see [Safety](#safety)). In a
sandbox place `read`, `write` and `edit` run in the box too.

A call tool that fails on its own (an unreadable PDF, a model's refusal) fails its call node; inside a `map` with
`onItemFailure: "collect"` it fails that item, and the other items go on. A cancel or the node's deadline still
stops the run.

`web_fetch`'s direct fetch reaches public hosts only, through pi-browser's guard (`publicFetch`): each redirect hop is
resolved, every address it resolves to is checked, and the connection is dialled at the address checked, so a
loopback, private, link-local, carrier-grade or metadata address (`127.0.0.1`, `10.x`, `169.254.169.254`, `fc00::`,
`::ffff:127.0.0.1` and the like), a name such as `localhost`, a public name that resolves to one of them and a
redirect to one are all refused, as is any scheme but http(s). A URL on a port other than 80 or 443, or longer than
4,096 characters, is refused before the guard is asked. A body is at most 5 MiB and a fetch at most 30 s. A Page holds
a part of the page's text: about `max_chars` characters from `offset` (20,000 by default, at least 200, at most
50,000; a quote or a line break counts two, as the JSON answer holds it, and a part holds one character at least, so
it always advances), its length as `chars`. A part that is not the whole page says so: `truncated` while more follows,
`next_offset` where it begins, `original_chars` the page's whole length where it is known, and for an agent a line
after the JSON says which characters these are and the call that reads on. A page whose HTML is longer than 1,000,000
characters (scripts and styles aside) is cut before it is read: every part gives `html_chars`, the page's whole
length, and no `original_chars`, its text is the start of the page, and the last part's line says `The page was cut at
1,000,000 characters of HTML before reading; the rest wasn't read.` `converted: "text"` says the text is the page's
plain text, its conversion to markdown having run out of time. A page is read to its first 1,000,000 characters: an
`offset` at or past them is refused, and the last part a read reaches of a longer page has `beyond_read`. The links,
absolute http(s) only, come with the part at offset 0: at most 200, in 20,000 characters, with `links_omitted`
counting those left out. A page is fetched once a run, at the first call for its URL, through either provider, and the
run keeps what it read of its last 8 pages by the URL asked for: every later part of that URL comes from it, with no
request, so a page's parts are always one read's. Through Parallel that is one billed extract a page a run, asked for
its first 1,000,001 characters (the extract has no offset: its text always starts at the page's start). A refusal or a
failure is a Page with `ok: false` and `refused` or `error`, never a thrown error: an agent reads why, and a workflow
can branch on it. An agent gets the Page as JSON text; a workflow's `call` node `via: "tool", tool: "web_fetch"` gets
it as its output (`args: {url, offset?, max_chars?}`, 50,000 characters of text by default, `out` a schema of that
shape). A call node naming a tool the table cannot run that way is refused before the run starts (`409`).

On another harness, every host tool's result reaches the model within the host's bound of 120,000 characters
(`HOST_RESULT_MAX_CHARS`, `@parcha/agentrun-kernel`): the kernel's tool bridge cuts a longer one, its start with a line
saying where it was cut, and flags the call `truncated`. Each CLI adapter tells its CLI to pass a result that long to
the model whole: the Claude Agent CLI would otherwise save a result past 50,000 characters to a file and tell the model
to read it, which a run's confinement refuses, Codex keeps only the ends of a result past 10,000 tokens, and OpenCode
would cut one past 2,000 lines or 51,200 bytes and save the rest to a file the session has no tool to read. A
`web_search` answer past 100,000 characters leaves out its least relevant results, `omitted` counting them.

### Search and fetch

`web_search` and `web_fetch` work on every harness with only a model key. Each resolves, for a run, in one order: (1) the
provider the user picked, optional: the agent's own (`definition.tool_settings`) over the server's
(`PUT /settings/tools`); (2) the native tool, the harness's own or its model provider's hosted one (on claude-agent
only where it is picked: `auto` there skips Claude's own search, an explicit `native` pick); (3) for
`web_search`, Parallel, where the server holds a Parallel key (`PARALLEL_API_KEY` in its environment, or one saved on Tool
keys): `auto` then uses that key and bills it, each search booked as the run's cost ($0.001 a search); (4) the kernel's
keyless fallback. A revision's `tools` (and a pack's grant) names the capability, never a provider. On codex, `auto` is
Codex's own search, except behind a gateway, on OpenRouter (which runs neither Codex's nor Claude's own search, and
counts no searches to price) or under a spend cap (its request has no input bound, which a cap cannot
admit), where it is Parallel on the server's key, else keyless Exa. `off` turns `web_search` off: nothing is searched,
and an agent naming it is refused (`409`) until it is turned on again. A pick of `exa-keyless` is keyless Exa alone,
the key held or not.
A workflow's model nodes may each run on another tier's model, so a workflow's `web_search` never searches natively:
it is Parallel on the server's key, else keyless Exa, or the provider picked, and a pick of `native` alone is
unavailable for a workflow.

| | `claude-agent` | `codex` | pi |
| --- | --- | --- | --- |
| `web_search`, `auto` (the default) | Parallel on the server's key, else keyless Exa: Claude's own WebSearch is the `native` pick | Codex's own search, each search booked; behind a gateway, on OpenRouter or under a spend cap, Parallel on the server's key, else keyless Exa, a host tool | one request to the run's own model provider with its hosted search (Anthropic, OpenAI direct); behind a gateway (`AGENT_MODEL_BASE_URL`) or on another provider, Parallel on the server's key, else keyless Exa |
| `web_search`, `native` | Claude's own WebSearch, unavailable on OpenRouter or under a spend cap | the same, unavailable behind a gateway, on OpenRouter or under a spend cap | the same, unavailable where there is none: never keyless Exa |
| `web_search`, `off` | unavailable (`web_search is turned off in settings`): nothing is searched | the same | the same |
| `web_search`, `exa-keyless` | Exa's public MCP search, a host tool | the same | the same |
| `web_fetch`, `kernel` (the default) | the guarded direct fetch | the same | the same |
| either, `parallel` | Parallel's search and extract, host tools | the same | the same |

`GET /settings/tools` answers the server's settings, `{web_search: {provider}, web_fetch: {provider}, browser: {provider}}`, the default
where none is set; `PUT /settings/tools` takes the same map and replaces it (a capability it leaves out takes its
default). An agent's `definition.tool_settings` has the same shape and is over the server's. A provider is one offered
for its capability (`auto`, `native`, `exa-keyless` or `parallel` for `web_search`; `kernel` or `parallel` for `web_fetch`;
`auto`, `browserbase`, `kernel` or `chrome` for `browser`, [below](#tools)); an
unknown capability or provider is `422`. Any tool's settings also take a `permission`, `allow`, `ask` or `deny`, which the
tool gate holds every call to (an ask parks the run for the owner's approval); a workflow's call node, which cannot wait
for an approval, refuses its run when its tool is set to ask or deny (`409`, `details.asks` or `details.denied`). The
settings are kept in the data directory
(`tool-settings.json`, 0600, written whole and durably), not a secret, and read by every run launched from then on.
`GET /capabilities` is the one tool catalog: each of the three tools there gives the providers offered (`providers`), the
server's (`provider`, its default where it sets none), the built-in default (`default_provider`) and `resolves`, what it
resolves to on each harness under the server's settings and default model (`native`, `kernel`, `exa-keyless`,
`parallel`, or `unavailable: <reason>`), with `why`, keyed the same, one plain sentence for each (`Codex's own search`,
`behind a gateway Codex has no own search; your Parallel key (saved)`, where `saved` is a key saved on Tool keys and
`server` one in the server's environment), both recomputed at each `PUT` and each key saved or deleted. `GET /agents/{id}` projects it onto the agent:
`tools`, each tool its current revision grants in the same order, and for one with a choice the provider in force,
`provider_from` (`agent`, its own `tool_settings`; `server`; or `default`), `default_provider` (the server's) and
`resolved`, on its harness and model. Parallel picked where
the server holds no `PARALLEL_API_KEY` resolves `unavailable: parallel picked, no PARALLEL_API_KEY`, never to another
provider: a revision naming the tool saves with a warning, and its run is `409` with `details.missing`.

The server resolves a run's tools at its first launch, from its pinned revision and the settings then, keeps the outcome
in the run's `serve.json` for the run's life (a later `PUT` changes the next runs, never a run already started; a
Parallel key gone since makes Parallel unavailable, never another provider), and hands its process the outcome as a
description with no secret in it (`AGENTRUN_SERVE_TOOL_PLANE`); the run reads its providers there, never from a request.
A workflow's tools are those its revision lists and those its model and call nodes name.

Upgrading to the tool gate: a workflow whose call node's tool is set to ask, by a setting or a default, now refuses its
run (`409` with `details.asks`); set that tool to allow for the agent (`definition.tool_settings`). Built-in tools are
allowed by default; catalog (`monid.*`) and MCP tools, which ask by default, are no call node's tools here.

Upgrading: a server holding `PARALLEL_API_KEY` used to read every `web_fetch` page through Parallel's extract on its own.
Now `web_fetch` is the guarded direct fetch unless Parallel is picked; to keep the old behaviour, set
`PUT /v2/settings/tools {"web_fetch": {"provider": "parallel"}}` once (or `tool_settings` in an agent). Parallel's key reaches an agentic run only when one of its capabilities resolves to Parallel (see
[Decision workflows](#decision-workflows)), and a web tool reaches Parallel only where its own capability does.

pi's native `web_search` is one standalone request, as Claude's CLI runs its WebSearch: one user turn carrying the
query and an instruction to answer with sources, on the run's own model and key, with the provider's hosted tool added
and nothing else (Anthropic's `{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}`, OpenAI's Responses
`{"type": "web_search"}`). The results, their citations and the search count are read from the provider's own events;
nothing of the request enters the run's conversation but the tool's answer, with `text`, the provider's own short
answer with its sources. A `pause_turn`
answers what it has, and nothing is retried. It is booked as one of the run's requests: its tokens at the model's price
plus $10 per 1,000 searches (Anthropic) or calls (OpenAI).

With no native search and no Parallel key, web_search falls back to Exa's public keyless MCP endpoint, a third-party
service with its own rate limits (unpublished) and its own terms (https://exa.ai/terms). To turn it off, set
`web_search` to `native` (native only) for the server (`PUT /v2/settings/tools`) or for an agent (`tool_settings`). To
search with a key instead, save a Parallel key on Tool keys (or set `PARALLEL_API_KEY`): `auto` then searches through
Parallel and bills the key.

Keyless Exa is one exchange with Exa's public MCP endpoint (`https://mcp.exa.ai/mcp`, its `web_search_exa` tool, at most
8 results, no key), dialled over IPv4 alone: the server looks Exa's name up for IPv4 and connects to that address, since
Exa takes keyless use only over IPv4, straight to its endpoint (through a proxy it answers `403`, said by name). Past its
free limit Exa answers a `429` with a Retry-After, or a tool result it marks rate-limited (`ai.exa/rateLimited`); the
search is tried once more after a jittered 1 to 3 s, or the Retry-After Exa names when it is 5 s or less (a longer one, as
for its daily limit, is not waited out). Still limited, the tool answers `{error}` in our words: `Free web search is
rate-limited right now. Try again in a minute, or add a Parallel key in Settings → Tool keys to search with a key.` Any
other failure Exa answers reads `Free web search failed. Exa said: "<the first sentence of its text>"`, cut at 120
characters; Exa's own instructions (a key for its MCP URL) are never passed on.

Every provider answers one shape, `{provider, query, results: [{url, title, snippet, published?}], text?}`, `provider`
naming the one that served it (`native`, `exa-keyless`, `parallel`), each snippet cut at 3,000 characters; the answer
the model reads ends with one line asking it to cite the URL of each result it relies on.

`web_fetch` answers a Page with `via`, a part of the page at a time (`offset`, `max_chars`, as above). With Parallel
picked the page is read through Parallel's extract (`POST https://api.parallel.ai/v1/extract`, its full content as the
text, about $0.001 an extract, one a page a run) and `via` is
`"parallel"`, with status 200 and the absolute links of its markdown; when Parallel lists the URL in its errors, answers
with no content, a 5xx or not within 60 s, it is the guarded direct fetch, `via: "direct"`, with `parallel` saying why
Parallel gave no page (`refused the key (401)`, `answered 503`, `timed out`, `listed the URL in errors`, `not tried:
refused earlier in this run`), and the model reads a line saying so; a 401 or 403 stops Parallel for the rest of the
run. A fetch Parallel was not picked for says nothing of it. A URL passes the guard's own check before anything is sent to Parallel: a URL the guard
refuses is refused and never leaves the machine. A call stopped before its page arrived answers `ok: false` with
`via: "stopped"`: no page came for it (the run's read of the URL goes on for its other calls).

`web_search` through Parallel uses its Search API (`POST https://api.parallel.ai/v1/search`, its `fast` mode, about
$0.001 a search). On every provider the query is cut at 200 characters and `n` is 1 to 25 (10 by default). A result is a lead: the agent reads the page with `web_fetch`. A failure answers
`{error}`, with nothing searched instead; a 401 or 403 to either web tool stops Parallel for both for the rest of the run.

Parallel's fees are the run's spend, booked as monid's are: each search and each page Parallel extracts is marked in the
run's records before it is sent (`agentrun.tool_started`, held at its price) and settled once Parallel answers
(`agentrun.tool_cost`: `tool` `web_search` or `web_fetch`, `charged_by` `"parallel"`, `usd`), shown on its timeline
(`Tool cost: parallel charged $0.0010 for web_search`), summed into its cost and under `/usage`'s `tools` meter. Parallel
answers what it used as counts, never an amount, so each is booked at Parallel's published price (docs.parallel.ai,
read 2026-11-03), an estimate: a `fast` search $0.001 for up to 10 results and $0.001 for each one past them, an extract
$0.001 a URL; on a 4xx other than a 408 nothing (Parallel refused it), and on a 408, a 5xx, a timeout or a lost
connection its price (Parallel may have billed it). Under a [spend cap](#spend-cap) each is a paid call: sent only when
what the run has spent and holds, plus its price, fits the cap. Otherwise nothing reaches Parallel: a search answers the
cap's refusal (`spend_cap_reached: Not sent: this run has spent $0 of its $0.0009 cap, and the next step, Parallel's search, could cost up to $0.001 …`) and a page is the
guarded direct fetch, with `parallel` giving the same words. One sent holds its price until Parallel answers: a model
request checked meanwhile, from any branch, tool round or harness, counts it beside what the run has spent, so the two
never pass the cap together. A workflow's `call` node naming either tool is booked the same way, under the node's own
call (its execution path).

Keyless Exa, where `web_search` resolves to it, searches through Exa's public MCP endpoint (`https://mcp.exa.ai/mcp`, its
`web_search_exa` tool), with no key. What leaves the server is
the search query (cut at 200 characters) and the number of results asked for (1 to 8, 5 by default), nothing else
from the run, and no key. It goes to Exa over IPv4, straight from the run's process. Exa is a third party: its free,
keyless use has a rate limit it does not publish, and its own terms. Past that limit the search is tried once more, and
then is a tool error in our words (above): the model reads why and answers without it. A search ends at 60 s, its retry
included, so a call never hangs. The answer is the query and its results, each a URL, a title, a
snippet of at most 3,000 characters and its date when Exa knows it, then a line asking the model to cite the URLs it
relies on. Keyless Exa is the default for a harness with no native search when the server holds no Parallel key; `off`
turns `web_search` off, keyless Exa included.

The `browser` tool runs hosted sessions, at Browserbase or at Kernel, never a Chrome on this machine. Which one is
picked like `web_search`'s provider: the agent's own (`definition.tool_settings.browser.provider`) over the server's
(`PUT /settings/tools`), one of `auto` (the default), `browserbase`, `kernel` and `chrome`. `auto` is Browserbase where
the server holds its keys (`BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`), else Kernel where it holds
`KERNEL_API_KEY`, else unavailable, saying which keys would do. A vendor picked is that vendor alone: without its key
it is unavailable, never the other one. `chrome`, a Chrome on the server's own host, is in the list but not set up on
any server yet: it reads unavailable (`a local Chrome is not set up on this server`), and a run that would get it is
`409`. Capabilities' `tools[]` give the browser's providers, the server's pick and what it resolves to; a run keeps the
vendor its first launch resolved for its life, and one whose vendor's key is gone since is refused each browser call,
saying why. Kernel's browsers run headless, and keep no downloads, so a run on Kernel has no `browser_downloads`. The keys come from the server's environment or Tool keys and reach the
run's process over its pipe, as the rest do. A session's custody (its lease, its tag, what it was
doing) is kept in the run's own store, so a run opened again on its directory reconciles the sessions it held. Each
page it reads is filed under the run's `work/evidence/`, each read in a file of its own (`0001-browser_read.md`, ...),
reads at once included. There is no recording. The owner watches the browser live, takes it over and hands it back, and
the agent can ask them to (below). When the run is let go (its work done, or a SIGTERM)
the sessions it still holds are released at their vendor. An agent's browser stays signed in from one run to the next
([saved sign-ins](#saved-sign-ins)).

A session's time is the run's spend, as a paid tool's charge is: each browser call books what its session ran since the
last charge, and the release books the rest, topped up to the provider's minimum. Each is part of its `cost.usd` and
`/usage`'s `browser_time` meter (dollars, and seconds once the run has ended). On the timeline a charge has no row of its
own: it shows on the row of the browser call it was booked under, that call's `tool_use` row, as `usage`
(`{"usd": 0.0017, "requests": 0}`, every charge of that call summed). The release's charge goes under the session's
last call, so it lands on that call's row. Booked after the answer, it is served as a change of that row (the same `id`,
its new `usage`), never a new row. Prices are by provider (pi-browser's provider name):

| Provider | List price | Minimum | Its own price |
| --- | --- | --- | --- |
| `browserbase` | $0.12 an hour | 60 s | `AGENTRUN_BROWSER_USD_PER_HOUR_BROWSERBASE` |
| `kernel` (headless) | about $0.06 an hour, by the second | none | `AGENTRUN_BROWSER_USD_PER_HOUR_KERNEL` |
| `cdp` (a local Chrome) | $0 | none | `AGENTRUN_BROWSER_USD_PER_HOUR_CDP` |

A variable gives the provider's price in US dollars an hour (a contract rate; the minimum stays). A provider with no price,
or a variable that is not a non-negative decimal, has no price: its time is booked as an unknown cost, and under a cap
every browser call is refused. Under a cap the browser's time is held before it runs (see [Spend cap](#spend-cap)).

#### The browser's live view

The owner watches a run's browser live from the console, and takes it over: the same view for every vendor (pi-browser's
own viewer, a screencast of the page the agent is on), never the vendors' own live-view links, which stay in the run's
process. As a session opens, the run's process runs its viewer on a loopback port of its own and hands it to the server in
one file in the run's directory, outside `work/` (`browser-live/<session>.json`, one file per session, 0600), which goes
when that session ends: a session's end never touches another's, so a relaunch's old session never hides its new one's
view. A session a restarted process keeps (it was still running at the vendor) gets its viewer handed over again by the
new process, with a new token, and nobody holding the browser. `GET /v2/runs/{id}/browser` answers `{state: "live", viewer}` while a session is open (`viewer`, a link on this server
with its token in the fragment), `{state: "none"}` when the run has a browser but no session is open, and
`{state: "off", reason}` when it has none: its agent has no `browser` tool, or its browser resolves unavailable here (the
tool plane's words, `a local Chrome is not set up on this server`, or for Kernel with no key, that it needs a Kernel key). It takes the owner's
password session in the console: a token, which a run's process, an MCP client or a script may hold, is `403`.

The viewer lives under `/v2/runs/{id}/browser/live/`. Its page, script and style are this server's own (the files of the
pi-browser it has installed), framed by this server's own origin alone (`frame-ancestors 'self'`, the console's `'none'`
everywhere else); only its WebSocket goes to the run's port, taken only from this server's own origin (as the request
reaches it, or the public address, `AGENTRUN_PUBLIC_URL`, for a TLS proxy that rewrites `Host`) with the owner's session,
and on a loopback address only at one of its names, as every route is (a rebound name is refused, whatever its `Origin`).
One viewer at a time: a second is refused (`viewer_in_use`). A browser with no page yet (Kernel's headless one starts with
none) shows "No page yet" until one opens. The token dies with the session: the answer says `none` and the old link opens
nothing. The token is in no record, timeline row, run view, run file, home, log or the model's context.

**Take over, hand back.** The viewer watches until the owner presses **Take over** in it; until then the run drops its
input before the browser (`held not_taken`). Take over holds the browser for the owner until they press **Hand back**,
the viewer has been gone 2 minutes, or 15 minutes pass with no input from them. While they hold it, their input is the only
input; the agent's browser calls wait inside the tool (they do not fail), then go on with the page's old element ids
dropped, and the model is told in plain words that the person had the browser and the page may have changed. A call that
was under way at the take acts no more: each change of hands moves the session's epoch, and an act from before it is
refused, each action of a run checked on its own; the act already in the browser (a run's code is one batch there) ends
first, and only then does the owner's input reach the browser. The run stays `working`; its timeline says "You took over the browser" and how it came back ("You handed the
browser back", or that it went back to the agent after the idle or away window). The owner's time counts: Take over holds
the next 15 minutes of session time at the provider's price under the run's cap first, and with no room it is refused in
the cap's words, shown in the viewer. A take-over that input keeps alive is held again every 15 minutes, and with no room
the browser goes back to the agent at the cap ("The browser went back to the agent at the run's spend cap", in the viewer
and on the timeline, with the cap's words). A take-over and an ask on the same session share one hold; an ask that joins it holds the extra stretch its own expiry needs
(refused in the cap's words without room), and a re-hold the cap refuses ends both: the take-over goes back to the agent,
and the ask expires, the agent told the cap's words. When the
browser comes back, what was held up front goes, and the time the person had stays held, at the provider's price, until
the session's next charge books it: take-overs given back with no browser call between them still meet the cap.

**The agent asks.** The agent may ask the owner to do something in its browser (`browser_request_handoff`: an instruction
and how it will know it is done, such as signing in). Its person's time is held the same way first; with no room no ask is
made, and the tool's result says why. The run then reads `input_required`/`waiting` with
`pending: {kind: "browser", instruction, completion_condition, asked_at, expires_at}`, its timeline shows "Waiting for you:
<instruction>", and the webhook's `run.needs_input` says `pending.kind: "browser"`; the agent's turn waits inside the tool
call. The owner takes over in the viewer, does it, and answers `POST /v2/runs/{id}/browser/hand-back` with
`{outcome: "done"}` or `{outcome: "cancelled"}` (the owner's password session alone, as above). The first answer wins: the
same answer again is `200`, a different one `409 handoff_answered` with the answer it has. Any answer hands the browser back
to the agent. Unanswered for 15 minutes, the ask expires: the agent hears `expired`, and a later answer is `409` with
`outcome: "expired"`. The ask's record is one 0600 file in the run's directory (`browser-ask/`, never `work/`): the
instruction, the done-when condition and the ask's times, never the viewer's link or token. A run's process that dies
while the ask waits is started again, as a working run's is, and the new process takes the wait up: it reads the owner's
answer, or writes the expiry. The record goes when the run ends, or when its process lets its browser sessions go.

### Saved sign-ins

Sign in once in one of an agent's runs (for now, through the run's browser while it runs), and every later run of that
agent starts from that signed-in browser. Sign-ins are kept per agent, never shared between agents, and the server
picks which one a run gets, never the model.

- **Where the cookies are.** At the browser's vendor: a Browserbase context, or a Kernel profile under a random name
  (`agentrun-` and 24 hex digits: Kernel's names are its account's, so a name derived from the agent would be any
  server's that shares the key). This
  server keeps only a pointer per agent and vendor, sealed under the seal key (`AGENTRUN_SEAL_KEY`) and bound to its
  agent, in `<data>/homes/<key>/sign-ins/sign-ins.json`. With no seal key nothing is kept and runs start signed out;
  capabilities say `sign_ins: true` only with a seal key and a browser vendor here. A local Chrome keeps none: its
  cookies would sit on this server's disk.
- **How a run gets it.** Before a run with the `browser` tool is launched, the server makes the agent's context at
  Browserbase (`POST /v1/contexts`, which opens no session; Browserbase bills sessions, not contexts) or its profile at
  Kernel (`POST /profiles`, which starts no browser) if it has none,
  and hands the run's process the pointer over its pipe, with its secrets, never in its environment. The run's process
  never gets the seal key. Every session the run opens uses that profile, by the name `default`; the model never sees
  the pointer. A vendor that does not answer leaves that run's browser signed out, said in the server's log.
- **One run saves at a time.** The first run of an agent to start with the browser holds the sign-in's save lease, and
  its sessions save what changed (Browserbase `persist`, Kernel `save_changes`). A run of the same agent started while
  another holds it starts signed in and saves nothing. The lease ends when its run ends (completed, failed or
  cancelled) or lets go cleanly to wait for its person. A run whose process went, or a server restart, keeps it with
  the run for its relaunch, since a session it opened before may still write back at the vendor, but for no longer than
  such a session can live (pi-browser's session timeout, 30 minutes) while its process stays gone: a run that waits on
  its person after its process died, or is never opened again, lets the others save after that. A run whose process
  went without letting its sessions go keeps the lease that way even once it ends. Each launch decides again whether
  its run saves: a follow-up of a run that saved, opened while another run holds the lease, saves nothing. One that names a run
  that ended while the server was down counts as let go. Browserbase writes a saved context back a few seconds after
  its session ends, so a Browserbase saver's lease stays named for it 10 seconds past its end (a bound this server
  chose; Browserbase publishes none): a run started in that time starts from the context as it was, and saves nothing
  over it, and the saver itself, resumed in that time, waits it out before it saves again. A gone holder's Browserbase
  lease gets the same 10 seconds past the 30 minutes. A V1 limit: the lease goes to the first run of the agent to
  start with the browser in its tools, whether or not it opens a browser, and stays with it until it ends, so a long
  run that never browses keeps the others of that agent from saving meanwhile.
- **What you see.** `GET /v2/agents/{id}` lists `sign_ins`: `{key: "default", provider, state, held_by, verified_at}`,
  `held` with the run's id while a run holds the lease, else `ready`; `verified_at` is when a saving session last ended.
  `unreadable` (this server's own state, marked `signins/1` in the served contract) is a pointer that does not open
  under the seal key the server has now (none, or another): runs start signed out, and none is made in its place until
  you forget it, since the vendor's object it points to would be left behind. A run still going when the server
  starts that was handed the sign-in, which now does not open (or whose sign-ins file can't be read or is damaged), is
  not taken up: it is stopped (or, its process already gone, never opened again) and ends failed ("This server can't
  read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged): …"), and its rows are
  not read, since what it says could repeat the pointer, which the server could not cut. Once the sign-in opens again
  (the right seal key back), its rows are read and shown, cut of it. A run that had already ended keeps how it ended,
  but while the sign-in does not open none of what it said is served (rows, answer, output, error words, a review's
  reason, a workflow run's graph, and its files, `GET /runs/{id}/files` and each file, which answer 403 `forbidden`),
  it can't be continued, and what its end-of-run learning turn wrote is not checked, graded or merged (it waits as it
  was for a server that reads the sign-in). It is shown again, cut, once the sign-in opens. A run that was never
  handed the sign-in (one launched signed out since the key changed) is taken up as any other. That a run was handed
  it is kept in its `serve.json`; a launch that can't save that hands it none, and the run browses signed out. A run
  still going whose `serve.json` is there but can't be read or parsed (where its plane and that mark are kept) is
  hidden the same way when its agent's revision grants the browser, or can't be read: nothing else says which browser
  it ran on, so whether it was handed the sign-in is not known ("This server can't read the run's record (its
  serve.json is damaged or can't be read), …"). An ended run whose `serve.json` is damaged since is withheld the same
  way, its end kept. That mark is the SHA-256 of each pointer the run was handed (a list, one per pointer; never a
  pointer), and what a run was handed is read back by it alone: each hash matched to the agent's live pointer or a
  forgotten one (below). A run with no mark was never handed one. When any of its hashes matches no pointer that opens
  (one under another seal key or none, one forgotten and since dropped out of the newest 32 kept, the agent's sign-ins
  file gone), the run is hidden or withheld as above, and shown again, cut, once every one does: nothing keeps that
  verdict, each server reads it anew. Forgetting the agent's other sign-ins never withholds it. A mark of any other
  shape (one an older build wrote, `true` or a single hash, or a damaged one) is read as handed some sign-in no one
  can name: the run is hidden or withheld, never served uncut, and forget waits for it while it goes. A run list's row
  for an ended run the server has not read (from its row and `serve.json` alone) serves its error (its details too)
  and review cut the same way, or withholds them in the same words, and withholds them when its `serve.json` is
  damaged. Its `held_by` still names a run that holds its lease, as a held one does.
  Never the pointer. `DELETE /v2/agents/{id}/sign-ins/{key}` forgets one: the vendor's context or profile is deleted,
  then the pointer. A delete the vendor does not answer is said in the answer (`at_vendor: "not_deleted"`), and the
  pointer goes all the same. It is `409 sign_in_held` while a run holds the lease (`details.held_by`), and also while
  a run it was handed is still going without the lease (`details.handed_to`): one that waits for its person, say, or
  one whose process went more than 30 minutes ago. What that run says could repeat the pointer, and once it is forgotten
  a restarted server could not read it back to cut it. The message names the run, never the pointer; forget it once
  that run ends. A forgotten pointer is still kept, sealed as it was, in the agent's sign-ins file
  (`forgotten`), the newest 32 per agent: never listed in `sign_ins`, never served, never handed to a run, never a
  sign-in a forget finds. It is kept only so a later server still cuts it from what a run that was handed it said: one
  that ended before the forget, or one opened again since on a new sign-in. Archiving an agent keeps its sign-ins; this server has no route that deletes an agent.

`monid.discover`, `monid.inspect` and `monid.run` give an agent [monid](https://monid.ai)'s whole catalog of data
endpoints on one key, `MONID_API_KEY`: it finds an endpoint in plain words, reads its input schemas and price, and runs
it. Each run is paid per call from the monid workspace's wallet, and is sent once, never retried. An async provider's
run is read until it ends, about two minutes at most, and asked to stop at monid when the run stops or it outlasts that.
A refusal comes back as `{error, status?}` in words: the wallet too low (402), a workspace control such as its budget
(`BLOCKED`), `FAILED`, `TIMED_OUT`, the provider's own error (not charged). The model reads each answer as JSON cut at
60,000 characters, the whole of it then filed under the run's `work/evidence/monid/`. An answer carries what monid
charged (`cost`, in dollars), and that charge is the run's spend: booked once in the run's own records as a tool cost
(`agentrun.tool_cost`: `tool` `monid.run`, `charged_by` `"monid"`, `usd`), shown in its timeline on a line of its own
(`Tool cost: monid charged $0.0030 for monid.run`) and summed into its cost, the total its [spend cap](#spend-cap)
reads, and `/usage` grouped by meter shows it as its own meter, `tools`, apart from `tokens`. Each run is marked in the
run's records before it is sent, held at the price an earlier `monid.inspect` of the run quoted for that endpoint, else
at an allowance of $1; its charge settles the mark. A mark a crash left unsettled leaves the run's cost unknown, as a
model request a crash cut does, and its cap counts it at its held figure, never $0. A run that may have charged and says
no cost (`FAILED`, `TIMED_OUT`, one stopped by the run or the wait, one whose sending failed) books an unknown charge,
never $0: the run's cost reads `null`, and under a cap it counts at its held figure, the bound the cap let it go at, as
a crash-cut mark does, so the run goes on while its cap allows, in its process and in one opened again from its store;
one monid says it did not charge (refused as sent, `BLOCKED`, `STOPPED`, the provider's error) books nothing. Under a
cap, each `monid.run` is held as a model request is: unless what the run has spent plus what the run is held at (the
price an inspect quoted, else the $1 allowance) fits its `max_cost_usd`, or when the spend is unknown, the call is
refused with a `spend_cap_reached` error the model reads, naming its price and the cap (and, when the allowance was
used, that `monid.inspect` gives a quote), and monid is never called. Runs go one at a time under a cap, and on
claude-agent and codex the check holds each model request still in flight at its worst case. A run sent holds its
figure until its charge is in, on every harness: a model request checked meanwhile counts it beside what the run has
spent, and a run that fails without an answer counts at it. `discover` and `inspect`
cost nothing and are never refused. They run on every harness: pi binds them, and claude-agent and codex call them as
host tools in the run's process, where a `monid.run` call a crash cut off is answered interrupted, never sent again
(`discover` and `inspect` may run again). On each, the model, the call's journal and the run's timeline name them
`monid_discover`, `monid_inspect` and `monid_run`: a model API takes no dot in a tool's name. The key is a secret like
the model keys: a run's process gets it over its pipe, never in its environment.

## Tool keys

A tool's key comes from one of two places. The server's own environment, through its launcher: `PARALLEL_API_KEY`,
`MONID_API_KEY`, `BROWSERBASE_API_KEY` and `KERNEL_API_KEY` are among the secrets it hands the server over its pipe. Or the page, by name:
`PUT /v2/settings/tool-keys/{id}` with `{values: {NAME: "..."}}` saves one, field by field (`parallel` takes
`PARALLEL_API_KEY`, `monid` `MONID_API_KEY`, `browserbase` `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`,
`kernel` `KERNEL_API_KEY`, `typesafe` `TYPESAFE_API_KEY`, which unlocks Jev's decisions, `decisions.jev`), and `DELETE` forgets it. A model
provider's key is saved the same way (`anthropic`, `openai` and `openrouter`, each `kind: "model"`, the others
`"tool"`): every run gets it, as every run gets the launcher's model keys, and with no `AGENT_MODEL` it gives the
default model ([models](#models)); its `harnesses` are pi and the harnesses that talk to that provider's API (OpenAI's:
codex and opencode; OpenRouter's, all four), of
those this server runs or would run once the key is set, so a row names them before it is saved: one left out is one
this server cannot run for another reason (not installed, not the pinned build, more than this host's memory). `GET
/v2/settings/tool-keys` lists each key, what it unlocks and the harnesses that run that, and each field's `set` and
`source` (`server`, `stored` or null): never a value, nor any part of one. `unlocks` holds only what capabilities show
this server binds, its `tools` and `workflows.decisions.providers` (as `decisions.<id>`): a key whose tools it binds
none of still lists, with nothing in `unlocks`. A field the server is started with is the server's, and wins: saving
it is `409 key_set_by_server`. A value is text of at most 1024 bytes with no control character (`422` otherwise).

A key is checked against its provider before it is kept, with one call that costs nothing, given 5 s: monid's
discover of one result, Parallel's list of monitors, Browserbase's list of projects, Kernel's list of browsers (at most
one) and TypeSafe's list of models (at `BROWSERBASE_BASE_URL`, `KERNEL_BASE_URL` or `TYPESAFE_BASE_URL` when the server
is started with one). A key the provider refuses (401)
is `422 input_invalid`, its field's reason `refused_by_provider`, in plain words with the provider's first sentence
(`Monid refused this key (401: Invalid API key format)`) and never any of the key, and nothing is kept: a key saved
before stays as it was. Otherwise it is kept, and `GET` gives its row a `check`: `{state: "accepted", at}`, or
`{state: "not_checked", reason, at}` when the provider would not answer the check (403: a key scoped away from that
call may still work for its tools), did not answer in 5 s, could not be reached, answered a redirect (never followed,
so the key goes nowhere else) or something else, or has no call that costs nothing. A tool's key the server is
started with is checked once as it starts, with the same call, in the background (the start never waits on it): its
row's `check` is `accepted`, `not_checked`, or `{state: "refused", reason, at}` (`Browserbase refused
BROWSERBASE_API_KEY (401: Unauthorized) when this server started: set the right one where AgentRun starts, then
restart it`), and a tool that needs a refused key reads unavailable in capabilities with the same words. `check` is
null when the key is not set, or is the server's and its check has not answered yet; a key saved before this server
checked keys reads `not_checked`, and is checked when saved again. A model key the server is started with is not
checked here: a run on a refused one fails at its first request, saying so. A save of Browserbase's project id alone sends no key, and leaves its
check as it was. A save whose check is still waiting when the server begins to close keeps nothing (`503
unavailable`, while its connection lasts): the check stops waiting, and the server's lock, released at close, may be
another server's by then. Under `--faux` a key is checked only against the fake its runs are given (`fauxMonid`,
`fauxParallel`, `fauxJev`); with none it is `not_checked`, and nothing reaches the network. A key the server starts
with is checked under `--faux` only against a check's own fake (`fauxBrowserbase`, `fauxMonidCheck`, `fauxKernel`), so the fakes the runs use see the
runs' calls alone; with none, its `check` stays null.

A saved key is kept only as ciphertext: AES-256-GCM in `DIR/tool-keys.json` (0600), each value bound to its field's
name, under the seal key `AGENTRUN_SEAL_KEY`, which only the server opens it with. A run's process never gets the seal
key. With `AGENTRUN_SEAL_KEY` not set, the launcher keeps it in `agentrun/seal.key` under `$XDG_CONFIG_HOME` (or
`~/.config`), making it the first time: 32 random bytes in base64, 0600 in a 0700 directory, and one another user can
read is refused, not changed. It is outside the data directory on purpose: a copy or a backup of the data directory
holds the keys as ciphertext alone, and opens nowhere without the seal key. With no seal key (started with no launcher and
no `AGENTRUN_SEAL_KEY`, or with no home directory) nothing is saved, never in the clear: `409 no_sealing_key`, and capabilities' `features.tool_keys.at_rest` is
`unavailable` (`sealed` otherwise).

A stored value that does not open is never a reason not to start. It reads `set: false, stored_unreadable: true`, and
`reenter` names those fields with why: `seal_key_missing`, `seal_key_changed` (a lost `seal.key` is made anew, so it
shows as this) or `file_unreadable`. The log says so once, naming the condition and the file, never a value; a `PUT` of
the value seals it again under the current key. In a container, `~/.config` is the container's own and goes with it:
pass `AGENTRUN_SEAL_KEY`, or mount a directory at `XDG_CONFIG_HOME`, so a new container opens the keys the volume holds.

A saved key is read by name like one the launcher hands over, and the launcher's value wins for a name it holds. A run
gets the saved keys at its launch, over the pipe its secrets come on (a workflow run's `PARALLEL_API_KEY` on its
decision descriptor), never in any process's environment, and never the seal key. No restart: a `PUT` or `DELETE`
answers once capabilities, a save's checks and a run's checks see the change, in milliseconds. No harness reads a tool
key, so a key leaves what each harness offers as it is, and the harnesses are not checked again. A run already
running keeps what it was handed; the next run started, or a run's process started again, takes what is saved then.
`BROWSERBASE_PROJECT_ID` is on the launcher's list for this, as every field a person may save is. Capabilities name each
tool's key (`tools[].key`, a `GET /settings/tool-keys` id; for `browser` its vendor's, `kernel` where Kernel is picked or resolved, else `browserbase`), so a page can link a tool's
missing names to where its key is saved. `agentrun-serve import` opens the saved keys in its data directory too and
cuts each out of what it writes, as it cuts a key-shaped variable of its environment; one that does not open there is
not known, so not cut, and the import says so.

## MCP servers

Add a remote MCP server once, with its credential, and see its tools before you keep it. An agent that grants one of
its tools calls it on pi and on claude-agent ([below](#agents-call-a-servers-tools)).

```sh
curl -X POST "$BASE/v2/settings/mcp-servers/preview" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url": "https://mcp.example.com/mcp", "auth": {"type": "bearer", "token": "..."}}'
curl -X PUT "$BASE/v2/settings/mcp-servers/example" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url": "https://mcp.example.com/mcp", "auth": {"type": "bearer", "token": "..."}}'
```

`POST /v2/settings/mcp-servers/preview` takes `{url, auth}` (or `{name}` for a saved server) and connects over
Streamable HTTP with the official MCP SDK client (`@modelcontextprotocol/client`): the 2026-07-28 revision first, a
2025-era server through its `initialize`. It answers the revision agreed (`protocol`), the server's `server_info`, any
`instructions` and every tool `tools/list` gives, all pages, each with its name, title, description, `input_schema`,
`output_schema` and `annotations` (the server's own claims, not checked). It stores nothing. `auth` is `{type: "none"}`
(or absent), `{type: "bearer", token}` (sent as `Authorization: Bearer <token>`) or `{type: "headers", headers: {Name:
value}}` (up to 8). An `oauth` server is signed in to first ([below](#signing-in-with-oauth)), then previewed by name.
`url` is `https`, or `http` on loopback.

What can go wrong, told apart:

- `422 auth_required`: the server answered 401 or 403. `details.auth` is `oauth` when it names protected-resource
  metadata (in its `WWW-Authenticate`, or at `/.well-known/oauth-protected-resource`), else `bearer`.
- `422 not_mcp`: the URL answered, but nothing it answered was a JSON-RPC reply (a web page, a JSON API, a 404).
- `422 input_invalid`, field `url`, reason `redirect`: the server answered a redirect. None is followed, so a
  credential goes only to the address you gave; the message names where it points.
- `424 upstream_failed`: the server could not be reached, did not answer within 15 s (30 s for the whole listing),
  answered 5xx or more than 4 MiB at once, or failed to list its tools; `details.status` is its HTTP status, if any.

A server is kept with at most 500 tools and 1 MiB of tool names, descriptions and schemas: past either, the listing
stops at that page and the answer is `422 input_invalid` (field `url`, reason `too_many_tools` or `tools_too_large`),
naming the limit and how many tools were read.

`PUT /v2/settings/mcp-servers/{name}` previews the same way, then keeps the server: its URL, the tools it listed (the
snapshot an agent will be shown) and its credential. A name is lowercase letters, digits and dashes, starting with a
letter, at most 32, with no underscores, so `mcp__<server>__<tool>` splits one way. Each credential header's value is
sealed like a [tool key](#tool-keys): AES-256-GCM under `AGENTRUN_SEAL_KEY`, bound to the server's name and the header,
in `DIR/mcp-servers.json` (0600, written whole, synced and renamed), which holds no value in the clear. With no seal key,
a server that takes a credential is `409 no_sealing_key`, before anything is contacted; one with `auth.type` none is
kept. A `PUT` that sends no `token` (or no `headers`) keeps the sealed credential, as long as the auth type and the URL's
origin stay the same: a saved credential never goes to another origin unless you send it again.

`GET /v2/settings/mcp-servers` and `GET .../{name}` show each server with `credential`: `sealed`, `seal_key_missing`
(no seal key now) or `unreadable` (sealed under another key, or damaged: a `PUT` with the credential seals it again),
null for `auth.type` none. No read, log line or error shows a credential; a server's error text is cut of the values
sent before it is shown. `POST .../{name}/refresh` lists the tools again with the saved URL and credential, keeps them,
and answers `{added, removed, changed, server}`: `changed` names a tool whose title, description, schemas or
annotations differ. `DELETE .../{name}` forgets the server and its credential. A saved-servers file that does not read (damaged, or
another format) is never written over: the list answers `servers: []` with `file_unreadable: true`, and every other
route is `409 store_unreadable` until the file is restored or removed. Capabilities' `features.mcp_client`
says `transports: ["streamable-http"]`, the `auth` types and `at_rest` (`sealed`, or `unavailable` with no seal key).

### Signing in with OAuth

A server whose preview answers `details.auth: "oauth"` is signed in to by this server, which keeps the tokens: the
agent's machine never sees one. `POST /v2/settings/mcp-servers/{name}/oauth/start` with `{url, scopes?, client_id?,
client_secret?}` answers `{authorization_url}`, the page the owner opens. It runs the official MCP SDK's OAuth: the
server's protected-resource metadata (RFC 9728), then its authorization server's (RFC 8414); PKCE S256; the server's URL
as the RFC 8707 `resource`. The client is, in this order, the `client_id` (and `client_secret`) you give; else, signing in again to the same
origin, the client kept sealed from the last sign-in (so a pre-registered client's id and secret are given once); else this
server's client metadata document, `GET /v2/settings/mcp-servers/oauth/client.json`, when this server's address
(`AGENTRUN_PUBLIC_URL`) is public `https` and the authorization server takes one; else dynamic client registration.

The authorization server sends the browser back to `GET /v2/settings/mcp-servers/oauth/callback`, which takes no token:
its `state` is random, bound to the server's name, used once and good for 10 minutes (else `400`), and the PKCE verifier
never left this server. It finishes only in the browser that started the sign-in: the start's answer sets a cookie
for that sign-in alone (named by its state, so two tabs do not replace each other's; `HttpOnly; SameSite=Lax`, path
the callback, 10 minutes, cleared when it finishes), and a callback without it is `403` with nothing exchanged. So a
start must come to the address the callback is under: one that came to another (the console opened under another
name for this machine than the server's own address) is `409 wrong_origin`, with `details.open` the console's MCP
page there.
The redirect URI never changes with the address a request came to, so a registered client's stays valid. Behind a
proxy on a public https address, set `AGENTRUN_PUBLIC_URL` to that address and have the proxy pass the `Host` header
and `X-Forwarded-Proto: https`: without them a start reads as another address (or plain http) than the callback's,
and every start answers `409 wrong_origin`. For an MCP server whose URL is not loopback, every endpoint its authorization server names (and
every request to one) must be `https` and resolve to no private, loopback or link-local address, or the sign-in or
refresh is refused with words and nothing is sent. A loopback MCP server is a development-only exception: its
authorization server may name endpoints on the MCP server's own loopback host, exactly as its URL writes it (never
another loopback address, the IPv6 loopback, or a name for this machine in its place), on any port but this server's own; any other
loopback endpoint is refused the same way. The host is pinned, not the port, as a local authorization server listens on
its own port. What that leaves: such an authorization server can still have this server send its sign-in and refresh
requests to other ports on that same loopback host (a port Docker publishes there, say), blind, learning only the
endpoint and its status, never a body. That is why the allowance is for development only. The callback exchanges the code, seals the token set (access and refresh tokens, expiry,
scopes, the client and its secret) under `AGENTRUN_SEAL_KEY`, bound to the server's name, lists the tools as a `PUT`
does, and redirects to the console's MCP servers page, `/#/settings/mcp?server=<name>&sign_in=ok` (or
`sign_in=failed&error=<code>`). The redirect URI is this server's own callback under its address: on loopback, the
plain `http` address and port it listens on.

Reads show `auth.type: "oauth"`, `credential: "sealed"` and `oauth: {expires_at, scopes, client, client_id}`, where
`client` is `pre-registered`, `metadata-document` or `dynamic`; never a token or a client secret. A `PUT` with `auth: {type: "oauth"}` keeps the token
set. Refresh tokens never leave this server: a run's launch refreshes an access token that expires within 5 minutes
(one refresh at a time per server, so a rotating refresh token is spent once; one given with no expiry is taken to last an hour) and hands the run the access token
alone. A refresh the authorization server refuses (revoked, expired) makes the server read `credential: "expired"`,
and a preview, refresh or run says to sign in again in Settings → MCP servers. A launch's refresh waits at most 4 s a
try, two tries, so an authorization server that does not answer holds a start's answer about 8 s at most; the run's
call is then refused unsent, saying to try again. A token that expires during a run is not
refreshed in that run: its calls fail as unauthorized, and the run's next launch refreshes it. A server that stops aborts any
refresh or code exchange under way and writes nothing after; if the authorization server had already rotated that
refresh token, the next start reads `credential: "expired"` and asks for a sign-in again.

`test/fixtures/fake-mcp-server.mjs` is a loopback MCP server for trying this: `startFakeMcp({era, token, oauth})`
answers `{url, log, tools, close}`; it serves `add`, `slow_write`, `delete_thing` and `paid`, and logs each request's
method, tool and whether an `Authorization` header came, never its value.

### Agents call a server's tools

An agent grants a saved server's tool by its catalog name, `mcp:<server>/<tool>`, in `definition.tools`
(`"tools": ["mcp:github/list_issues"]`). A save checks each one against the server's saved tools: a server that is not
saved, or a tool it did not list, is `422` naming the server's tools, and so is a name whose wire name,
`mcp__<server>__<tool>`, is over 52 characters, or a tool whose `x-mcp-header` declaration cannot be sent (on a
property not reached through `properties` alone, not a string, integer or boolean, not a header name, or declared twice). pi, claude-agent and codex run them (`features.mcp_client.harnesses`); on
another harness the save warns that they are not bound there yet, and a run is refused. A workflow's nodes bind no MCP
tool yet: a workflow that grants one, in its `tools` or on a node, is `422` ("a workflow's nodes don't bind MCP tools
here yet; grant it to an agentic agent").

A known **meta tool**, one that runs other actions by name, is never granted: Composio's `COMPOSIO_MULTI_EXECUTE_TOOL`,
`COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL` and `COMPOSIO_PROXY_EXECUTE`, Klavis Strata's `execute_action`
(on `klavis.ai`), Zapier's `execute_zapier_read_action`, `execute_zapier_write_action` and `write_code_action` (on
`mcp.zapier.com`), Arcade's `Arcade_UseTool`, Docker's `mcp-exec` and generated `code-mode-*` tools, and Cloudflare's
`portal_execute` and `portal_codemode_execute`. A grant of one couldn't name the real action, so allow would cover every
action it runs and deny could target none. Reads mark it `grantable: false` with its `reason`, a save that grants it is
`422` in those words, a run of a revision saved granting one is `409 agent_not_runnable` naming it under
`details.not_grantable` (each with its `tool` and `reason`), and a run that pinned one before is refused at its launch. Use the server's direct tools instead:
each of these providers has a direct mode. The list is closed: a meta tool it doesn't know is an MCP tool like any other,
asked by default.

- **Pinned.** A run's first launch keeps each granted tool as the server listed it when you saved it (its description
  and schema) and the server's URL then, in the run's directory (`mcp-tools.json`). A refresh or a new save never
  changes a running agent's tools. If the server's URL has changed since, that run's calls answer "the server's
  address changed since this run started" and nothing is sent, the new credential least of all.
- **The credential.** A run whose revision grants a server's tool is handed that server's credential at each launch
  (so a new one counts at the next), over its secrets pipe, never its environment; a run that grants none of a
  server's tools gets none of it. It stays in the run's process: no harness's CLI, file or log holds it, and a run
  that writes it into a learned note is refused by the secret scan.
- **pi** binds each granted tool in the run's process as `mcp__<server>__<tool>`, with the pinned description and
  schema, and calls the server from there.
- **claude-agent** uses the Claude CLI's own MCP client: one HTTP server entry per granted server at the session's
  model proxy, `/mcp/<server>`, behind the session's key, sent over the CLI's stdin (never its arguments), with only
  those servers (`strictMcpConfig`) and only the granted tools allowed. The proxy answers the MCP exchange itself and
  makes the call with the credential. The CLI's tool search is off in such a session, so the granted tools are
  offered whole. The proxy answers the handshake and the tool list itself, so a remote server that can't be reached
  shows at the first call, as that call's error; only a proxy route the CLI can't connect to fails the turn.
- **codex** uses Codex's own MCP client the same way: the harness writes each granted server in Codex's
  `mcp_servers` (an agent's own `config` still may not), at the session's model proxy with the session's key, with
  only the granted tools enabled. Each call runs without Codex asking (`default_tools_approval_mode = "approve"`): the
  proxy is the gate. Codex sends a call as soon as it starts it, so the proxy records the call in the session before
  it sends anything. Each server is `required`, but the proxy answers its handshake, so a remote server that can't be reached shows at the first call, as that call's error; only a proxy route Codex can't reach fails the turn. A tool whose schema Codex would drop or retype (a `not`, `patternProperties`, ...) is `422` at the save, naming the place and why.
- **A call** goes to the pinned URL alone, the 2026-07-28 revision first and a 2025-era server through its
  `initialize`; on 2026-07-28 each `x-mcp-header` parameter of the pinned tool is sent as its `Mcp-Param-*` header. No
  redirect is followed, at most 4 MiB is read, and it may take 120 s. The
  model reads the text blocks joined; past 60,000 characters, or with blocks that are not text, the whole answer is
  filed under the run's `evidence/mcp/<server>/` and the text says where. A tool's own error (`isError`) reaches the
  model as its error. A refused credential (401, 403) reads "the MCP server <name> refused its credential (its sign-in
  expired or was revoked, or its key changed): sign in again in Settings → MCP servers, or update its credential
  there"; another failure names the server and the HTTP status, never a header. A stop, or a
  client that goes away, cancels the call at the server. A call a crash cut off is answered interrupted on the
  resumed run and never sent again.
- **The gate.** Every call passes the run's one tool gate as `mcp:<server>/<tool>`, on every harness. Set
  `mcp:<server>/<tool>` or, for all of a server's tools, `mcp:<server>/*` to `allow`, `ask` or `deny` in
  `PUT /v2/settings/tools` or an agent's `definition.tool_settings` (the agent's exact key, then its server-wide key,
  then the server's two, then the default). An MCP tool with no setting asks. A denied call is refused and the model
  reads why; nothing is sent. An asked call parks, as any tool's does: its turn ends, nothing is sent, and the run
  reads `input_required` with `pending.kind: "approval"`, the tool, its arguments and its price (or "not metered"),
  until the owner answers `POST /v2/runs/{id}/approvals/{approval_id}` from their password session. Allowed, the run
  sends the call once and resumes with its result; denied, it resumes with the refusal. A restart while a call is
  parked loses nothing.
- **Prices.** `PUT /v2/settings/mcp-servers/{name}` takes `prices`, each tool's price in USD a call
  (`{"prices": {"search": 0.01}}`; a finite number, 0 or more, for a tool the server lists; else `422`). A priced call
  is held at its price under the run's `max_cost_usd`, refused unsent when the cap cannot take it, and booked as the
  run's tool cost (a `Tool cost` row, the `tools` meter of `GET /usage`). A tool with no price runs "not metered": a
  row says so, the run's usage row counts it (`not_metered`), and `GET /usage`'s `tools` line counts the calls
  (`not_metered_calls`); it is outside the run's cost and its cap. A run keeps the prices its first launch saw.
  A PUT that names no `prices` keeps the saved ones, for the tools the server still lists at the same URL (a new URL
  keeps none), so a save from any client never leaves a paid tool unmetered; `"prices": {}` clears them. A read lists
  the tools no price meters as `not_metered`.
- **The timeline** shows each call as `<server> · <tool>`.

## Webhooks

One URL hears of your runs without anyone watching the page. `PUT /v2/settings/webhook` with `{url}` sets it: an `http`
or `https` address, with no user or password in it. Loopback and private-network addresses are allowed, so a receiver
on your own machine or network works. Two kinds of message are POSTed to it about runs: `run.needs_input` when a run comes to
need its person (`input_required`: an `ask_person` question, or a stopped turn) and `run.ended` when it ends
(completed, failed or cancelled, once carried back). A [schedule](#schedules) whose firing fails sends a third,
`trigger.failed`; a server with no triggers never sends one.

A run's end and its `run.ended` are one durable step. The server chooses the end's time once and gives it to the agent
store, so the row's `ended_at` and the message's `webhook-id` name one time. `run.ended` is queued only once the agent
store has the end, so a receiver that reads the run back on its message (`GET /v2/runs/{id}`) reads it ended; while the
store refuses the end (a full disk, a busy store), nothing is sent, until a later try of the write or the next server
stores it. The outbox (`DIR/webhook-outbox.json`) keeps, in the same write as each message, which end and which wait of
each run it queued. A server that starts queues any end of the last day that the agent store holds and the outbox does
not, under the same `webhook-id` (one lost to a kill, or to a crash of the machine; one whose run's `serve.json` can't
be read goes with an empty `title`), and a server that takes over a run
queues a wait it stands at that the outbox does not name (one the run came to while no server was up), under its one
`webhook-id`. An end before the webhook was set is never sent. A run is continued only once its end's
`run.ended` is in the outbox on disk (`503` meanwhile), so a continued run's next end is its own, under its own id.

```json
{ "type": "run.needs_input", "timestamp": "2026-11-01T12:00:00.000Z",
  "data": { "run_id": "…", "agent_id": "triage", "status": "input_required", "title": "…",
            "url": "https://agents.example.com/#/runs/…", "pending": { "kind": "question" } } }
```

A message is thin: ids, the status, the title and a link to the run on the page; never a tool's arguments, an output
or an input, which the API reads (`GET /v2/runs/{id}`). `pending.kind` is `question` (an `ask_person`),
`approval` (a tool call that waits for a person's approval), `stopped`, `budget` (a run paused at its cap) or `browser`
(the agent asked for the owner in its browser).

Messages are signed by the [Standard Webhooks](https://www.standardwebhooks.com) spec, so a receiver verifies them
with any of its libraries: `webhook-id` (the same on every try of a message, so it is the receiver's idempotency key),
`webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">` under
the secret's bytes. A receiver checks the signature against the raw body and refuses a timestamp more than 5 minutes
from its clock, so a replay does not pass. The first `PUT` makes the secret, `whsec_` and 32 random bytes in base64,
and answers `201` with it, once; `GET /v2/settings/webhook` never shows it. It is kept like a [tool key](#tool-keys):
sealed under `AGENTRUN_SEAL_KEY` in `DIR/webhook.json` (0600), so with no seal key no webhook is set
(`409 no_sealing_key`). A new secret is a `DELETE` and a `PUT`.

A try that is not answered 2xx within 15 s fails; a redirect is not followed. A failed message is tried again on the
spec's schedule, with jitter: after about 5 s, 5 min, 30 min, 2 h, 5 h and 10 h, then logged as failed
(`event=webhook condition=delivery_failed`). Each message goes on its own tries, so two queued close together can
arrive in either order: a receiver orders them by `webhook-timestamp`, or reads the run (`GET /v2/runs/{id}`). A
`410 Gone` turns the webhook off (`disabled` in `GET`, and the log says why) until a `PUT` sets it again. Pending messages are kept in `DIR/webhook-outbox.json`, so the next server goes on with
them after a restart; a message can then come twice, under the same `webhook-id`. An outbox file of another version
is not read: the server starts with none, and the log says so (`condition=outbox_not_read`). `GET /v2/settings/webhook/deliveries`
lists the last 50 attempts (`webhook_id`, type, status code, latency, error, when, and the next try's time), and
`POST /v2/settings/webhook/deliveries/{webhook_id}/redeliver` sends one of those messages again, once, under the same
`webhook-id`. `POST /v2/settings/webhook/test` sends a `webhook.test` message once and answers how it went. A webhook a
410 turned off sends nothing, a test or a redelivery included (`409 webhook_off`), until a `PUT` sets it again.
`DELETE /v2/settings/webhook` removes the webhook and drops its pending messages.

## Schedules

A schedule starts an agent's runs with no one there. `POST /v2/triggers` with a `source` and a `target`:

```json
{ "name": "nightly triage",
  "source": { "kind": "schedule", "cron": "30 1 * * *", "timezone": "America/Los_Angeles" },
  "target": { "kind": "start_run", "agent_id": "triage", "input": { "content": "Triage last night's issues." },
              "max_cost_usd": 2 } }
```

A source is a cron line of five fields in an IANA zone (default UTC), `{at}` for one time (the trigger turns itself off
after it fires), or `{every_s, start_at?}` for every N seconds, from 60 to a year and a day, on the grid from `start_at`. A time a clock
change repeats fires once, at its first pass; one it skips fires at the first time after the gap. Each next time is
reckoned from the last nominal one, so a timer that wakes late does not drift. Every run a trigger starts is capped: by
the target's `max_cost_usd`, else by the agent's default (its definition's `max_cost_usd`) as it stands when the firing
starts. A target with neither is `422`, and a firing that finds neither (the default removed since) fails, so no trigger
starts an uncapped run, a workflow agent's included ([workflow runs](#a-workflow-run-under-its-cap)). Each run's
input ends with a line naming the schedule and the time it fired for, in its zone, and the run's `trigger` names the
trigger and the firing, in the run's view and in the runs lists (`GET /v2/runs`, `GET /v2/agents/{id}/runs`) alike;
a run a caller started has `trigger: null`.

A firing starts its run once. Its key comes from the trigger and its nominal time, it is recorded `due` in
`DIR/triggers.json` (written whole and synced) before its run starts, and the run is started under that key, so a firing
a restart drives again finds its run. A firing's key stays bound to that run: when the server stopped while setting the
run up, the firing reads `failed` ("The server stopped while setting up the run.") with that run's id, it never fires
again, the next firing goes ahead, and `POST /v2/triggers/{id}/fire` is how a person tries it again. While the trigger's last run is active (working, or waiting on a person), a firing
is `skipped`, with why (a webhook trigger with `accept` is the exception: [each event it takes](#webhook-triggers)
starts its own run); a full server (`429`) keeps it due and tries again. Times missed while the server was down are
one `missed` firing with their count, and the schedule goes on from now; the latest of them still fires, once, when it is
no older than the trigger's `catchup_window_s` (default an hour; 0, never), marked `catch_up`. A
firing while the last run is active (working, or parked waiting on a person) is skipped with why, never queued,
because a firing queued behind a parked run would wait as long as the person does. A firing whose run is refused is `failed`, and a webhook set on this server
gets a `trigger.failed` message for it (`data: {trigger_id, name, firing_key, nominal_at, error, auto_paused}`, its
`webhook-id` made from the firing's key, so a restart never sends it twice). Five failed firings in a row turn the
trigger off (`disabled: {reason: "auto_paused"}`); a firing that starts its run resets the count, and so does turning
it on again. Run now (below) works on an auto-paused trigger too, and counts toward the streak like any firing: one that
starts its run resets it, one that fails adds to it. A trigger whose cron line or zone no longer reads here (after an
upgrade of the cron library or of the time zone data) is turned off alone, at a start or when it comes due
(`disabled: {reason: "source_unreadable", detail}`), and every other schedule goes on firing; turning it on again takes a
new source. A trigger's firings are driven one at a time, in order, so a firing a crash left due settles to its run
before the next one's overlap is checked. `PATCH /v2/triggers/{id}` changes it, and
`{enabled: false}` pauses it: the time it was off is skipped, not caught up. `POST /v2/triggers/{id}/fire` runs it now,
once per `Idempotency-Key` (required): the same key within `limits.idempotency_ttl_s` answers its firing, after the
firing has left the history too, and later it is a new firing that a run the key started still answers. `GET /v2/triggers/{id}/firings` lists its last 200 firings.

### Webhook triggers

A trigger with `source: {kind: "webhook"}` fires on each request to `POST /v2/hooks/{trigger_id}`: this server's one
route with no token. The request is signed by the trigger's own secret under the
[Standard Webhooks](https://www.standardwebhooks.com) spec, the one this server's outbound [webhooks](#webhooks) sign
with, so a sender uses any of its libraries: `webhook-id` (1 to 255 printable ASCII characters, no space), `webhook-timestamp` (Unix seconds, within 5 minutes of this
server's clock either way) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">` under the
secret's bytes (several, space-separated, and any one may match). The signature is checked on the raw body, as sent and whatever its content type, before
anything else. A bad signature, a stale timestamp, an unknown trigger, one that is off and one that is not a webhook's all
answer the same `401`, so no trigger id can be found by asking; a body past 256 KiB is `413`.

The secret, `whsec_` and 32 random bytes in base64, is made with the trigger and shown in the `201` once; no `GET`
shows it. It is kept sealed under `AGENTRUN_SEAL_KEY` in `DIR/trigger-settings-webhook.json` (each trigger source's
sealed settings have a file of their own), so with no seal key no webhook trigger is made (`409 no_sealing_key`).
`POST /v2/triggers/{id}/secret` makes a new one, shown once, and the old one signs nothing from then on. Like every
secret this server keeps (its tokens, its outbound webhook's secret), it is cut from what a run shows, from what an
import keeps and from every learning text. A secret that does not open under the seal key the server starts with is
said in its log (`condition=trigger_setting_unopened`, naming the trigger), and its trigger is refused until a new
secret is made. A `trigger-settings-webhook.json` that does not read is never written over: until it is fixed or moved
away, no webhook trigger is made or rotated (`409 store_unreadable`) and none fires.

The request's `webhook-id`, which its signature covers, is its firing's key: the first answers `202` once the firing is
recorded, and its run starts after; the same `webhook-id` again, for a day after, answers `200` with that firing and
starts nothing (`{"ok": "duplicate"}` once the firing has left the trigger's history of 200 and the 1,000 it keeps past
it). Each trigger keeps the keys of its last day's pushed firings in `triggers.json`, at most 5,000, the oldest let go
first past that, which the log says once (`condition=trigger_seen_full`). The agent gets the trigger's input,
then the body, cut at 16 KiB, inside `<trigger-payload source="webhook" scheme="standard" untrusted>...</trigger-payload>`:
whatever the sender wrote is data, not an instruction. The tag names the signature scheme, the event as that scheme
reads it (`event="..."`), the JSON body's top-level `action` (`action="..."`) and an unsigned delivery id
(`delivery="..."`, GitHub's `X-GitHub-Delivery`) and, for a GitHub delivery, its pull request or issue's `number="..."`
(`pull_request.number`, else `issue.number`) and a pull request's `head_sha="..."` (40 hex; a comment event has none, so
no `head_sha` at all), read from the signed body so the payload's cut never loses them, each when there is one, so an
agent's instructions can read what it was given; a sender's words there are cut to 200 characters, their quotes and brackets escaped, and a closing tag in
the body, in any case, is defused.

A webhook trigger's `signature` names its scheme, one of a table of them: `standard` (the default, above) or `github`,
for a GitHub repository or organization webhook. A request is checked by the one scheme whose signature header it
carries (`webhook-signature`, `X-Hub-Signature-256`), and the scheme gives its firing key, from what its signature
covers, and its event. With `github`, paste the trigger's whole `whsec_...` secret, as it is, into the GitHub webhook's
Secret (content type `application/json`): each delivery is checked by `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of
the raw body>`, keyed by the UTF-8 bytes of that string. GitHub signs the body alone, not `X-GitHub-Delivery` nor a
time, so the firing's key is the SHA-256 of the raw body: a redelivery from GitHub's page sends the same body and
answers its firing, and so does a captured delivery sent again within the key's day under any delivery id. After the
day it would fire again (over TLS, a risk taken); there is no 5-minute window. Two real deliveries never share a body,
since GitHub's carry their own ids and times. `X-GitHub-Delivery` (1 to 255 printable ASCII characters) only names the
delivery on the payload's tag, for tracing. A request that carries no scheme's signature header, or more than
one, or is signed under a scheme other than its trigger's, is the same `401` as a bad signature, and the headers are
checked before the body is read.

`accept` makes a trigger take only the events it names, from the delivery alone:

```json
{ "kind": "webhook", "signature": "github",
  "accept": [
    { "event": "pull_request", "actions": ["opened", "synchronize", "ready_for_review"],
      "where": [ { "pointer": "/pull_request/draft", "in": [false] } ] },
    { "event": "issue_comment", "actions": ["created"],
      "where": [ { "pointer": "/issue/pull_request", "exists": true },
                 { "pointer": "/comment/author_association", "in": ["OWNER", "MEMBER", "COLLABORATOR"] },
                 { "pointer": "/comment/body", "prefix": "@reviewer review" } ] } ] }
```

A rule's `event` is the event as the trigger's scheme reads it: GitHub's `X-GitHub-Event`, or a Standard Webhooks
body's top-level `type`. GitHub signs the body, not `X-GitHub-Event`: a delivery a trigger ignored keeps its key for
the day, so the same body sent again under another event answers `{"ok": "duplicate"}`, and where it matters a rule
should also test a field only that event's body has (`/pull_request`, `/comment`, `/issue/pull_request`); `actions`, when given,
lists the values the body's top-level `action` may take; each of `where`'s conditions is a JSON pointer (RFC 6901) into
the body with one test: `in` (the value there equals one of the JSON values listed, an object's fields in any order),
`exists` (`true`, the pointer names a value, `null` included; `false`, it names none) or `prefix` (the value is a string
whose first line, trimmed, starts with it, ignoring case). A delivery fires when any rule takes it, with all its
conditions holding. A verified delivery no rule takes (GitHub's `ping` among them, a body that is not JSON too) answers
`200 {"ok": "ignored"}`, fires nothing, and is one log line (`condition=hook_ignored`, with the trigger and why). Without
`accept`, every verified request fires, as before. A trigger holds at most 20 rules, each at most 20 conditions and 20
actions; an `in` lists at most 20 values of at most 1024 characters of JSON each, a pointer is at most 512 characters,
and an event, an action or a prefix at most 200. A trigger with `accept` starts a run for each event it takes, its last
run active or not, since the events it takes are each their own work (a review per pull request); the server's run
limit still holds: a start it refuses (`429`) keeps the firing due and tries it again, and past 20 firings due a new
delivery answers `429`. This holds for every firing of such a trigger, a run now (`POST /v2/triggers/{id}/fire`)
included. Runs start in the order their events came while the server has room; while one firing waits to be tried
again after a `429`, a later one can start first.

Such a trigger can take every run this server has room for, starving other triggers and the runs people start. Give it
`max_active_runs` (1 to 100; `null` clears it): past that many of its runs active, a firing waits due and is tried
again, as at a full server, and is never skipped. It counts the runs this trigger started while they work, kept apart
from its history (so a long run counts however many firings follow it) and read again at each check; a run a person
opens again after it ended is that person's follow-up, not counted. Only a trigger whose firings each start a run
takes it (`422` otherwise). On a public repository, a rule for `issue_comment` or `issues` events needs a condition on
`/comment/author_association` or `/issue/author_association` (`in: ["OWNER", "MEMBER", "COLLABORATOR"]`): without one,
anyone who can comment starts runs.

A trigger's input, a started run's first message or a firing's message, is the trigger's, never the person's: it carries
the origin `{kind: "trigger", trigger_id, source, owner}`, `owner` decided by the trigger's definition as it fires and
never by its payload (true for a schedule, fired on time or by hand; false for a webhook, its body empty or not). The
model reads the very text it did; the run's timeline shows it as a `phase` row, "Trigger <its id>: <its first line>",
with `origin: "trigger"` and `trigger: {id, source, owner}` (so a client labels it by its source without reading the
summary), never as "You: ...", and what the run learns reads it as the trigger's.

A trigger's target may also be `{kind: "message_run", run_id, input: {content}}`, with a webhook or a schedule source:
each firing sends its input to that run as `POST /v2/runs/{id}/messages` would (a steer, or a follow-up that opens a
completed run again), under its own cap. The run must have a cap (`422` on `target.run_id` otherwise, and a firing to a
run that has none fails), and a firing never answers a run that waits on its person (a question, an approval, its
cap): it is `skipped`, "The run is waiting on a person.", and the run still waits. The firing's key is the message's id in the run's store, which takes
one message per id; a firing driven again after a restart first looks for it there, so it sends the message once and
never opens a completed run again for one it already has. A firing to a run that is working waits for it (tried every
5 s), and a trigger holds at most 20 firings due: past them a webhook event and a run now answer `429 rate_limited`
with `Retry-After: 30`, recording nothing, and a schedule's time is `skipped`.

### GitHub triggers (Connect GitHub)

A server has at most one GitHub App, made with GitHub's app-manifest flow, and every `github` trigger (and every
GitHub template) uses it. In the console, Connect GitHub calls `POST /v2/integrations/github/connect` (`{org?}`, to make
the App under an organization) and posts the form it answers to GitHub: `action`, GitHub's new-App page, and
`manifest`, which names a name GitHub lets the person edit, the server's public URL, its hook `/v2/hooks/github`, its
callback and setup URLs, the permissions (pull requests write; contents, metadata and issues read) and the events
(`pull_request`, `issue_comment`). It needs the address GitHub can reach, `AGENTRUN_PUBLIC_URL` (`409 github_no_public_url`,
"GitHub can't reach this server: set its public URL first"), a seal key (`409 github_no_seal_key`, naming
`AGENTRUN_SEAL_KEY`), and no App connected already (`409 github_already_connected`, "This server already has a GitHub
App. Disconnect it first."), and a request at the public URL itself, where GitHub sends the browser back
(`409 github_wrong_origin`, "Open this server at <public URL> to connect GitHub.", the URL in `details.public_url`). Its
`state` is random, used once, good for an hour, and bound to the browser that started it
by a cookie on the callback's path; GitHub reads it from `action`'s URL, and the form posts only `manifest`.

GitHub sends the browser back to `GET /v2/integrations/github/callback` with a code. The server converts it with GitHub
and keeps the App's id, slug and client id, which are no secret, and its private key and webhook secret, which are,
sealed in `DIR/trigger-settings-github.json`; GitHub's client secret is never kept, and no secret is logged or answered.
The browser goes on to install the App, with a fresh install state GitHub passes on and its cookie on the installed
path; GitHub's redirect after (`/v2/integrations/github/installed`) records the installation only with that state and
cookie, once GitHub, asked with the App's own JWT, says it is the App's, and sends the browser to the console at the
public URL, `<public>/#/settings/github?github=connected`. Without the state and cookie it records nothing and lands
there too: an installation made from GitHub's own pages arrives as the App's signed installation event. Neither leg ever answers an error body: a state
that is unknown, used, older than an hour or from another browser sends the browser to
`<public>/#/settings/github?github=error&reason=state_invalid`,
a code GitHub does not convert to `...&reason=conversion_failed`, one whose App GitHub made while another Connect kept
its App to `...&reason=already_connected` (the first App stays), and an installation GitHub does not confirm, or one
checked while GitHub was disconnected or connected again, to `...&reason=installation_unverified`; nothing is kept. The
App's `installation` events keep the list current, each taken only in its own shape (the installation, its account and
this App's id) and as GitHub, asked with the App's JWT, bears it out: `X-GitHub-Event` is not signed, so another
event's signed body sent as one changes nothing. GitHub out of reach when an event is checked answers it `503`, so
GitHub shows the delivery failed and it can be sent again; and the list is repaired from GitHub's own installations at
the server's start and when `GET /v2/integrations/github` is read (at most once a minute), by the same rule: none left
turns the github triggers off, one dropped only shrinks it. A list that an event or the install redirect wrote while
GitHub was asked is not overwritten by GitHub's older answer: the repair asks once more, and leaves the list as it is
when it moved again. An installation event follows the same rule: GitHub's answer to its check is taken only when no write came meanwhile
(else it is asked once more), so an older suspend never undoes a newer unsuspend. A server that closes stops its repair
and its events' checks, which write nothing after (an event cut so answers `503`, to be sent again).
`GET /v2/integrations/github` shows `{app_id, slug, installations}`, never a secret.

A trigger with `source: {kind: "github", accept: [...]}` takes the App's events its `accept` names (the same rules as a
webhook trigger's, above; required) and keeps no secret of its own. `POST /v2/hooks/github` takes no token: each delivery
is checked by `X-Hub-Signature-256` under the App's webhook secret, and one event fires **every** github trigger whose
`accept` takes it, each its own firing, keyed by the SHA-256 of the signed body, and its own run (github triggers may
take the same events; `max_active_runs` caps each). Every other github trigger keeps the body's key for its day, so the
same body sent again under another `X-GitHub-Event`, which GitHub does not sign, starts nothing: where it matters, a rule
also tests a field only that event's body has. When a trigger that takes an event holds too many firings due, the delivery is refused `429` with `Retry-After`
though the others recorded theirs: the retry records it there once it has room, and is the others' duplicate. An event no
trigger takes is `200 {"ok": "ignored"}`; GitHub's `ping` is
`200 {"ok": "pong"}`. The payload's tag also names the installation and the repository (`installation="..."
repo="owner/name"`). A github trigger made or turned on with no App connected is `409 github_not_connected` ("Connect GitHub
in Settings"). A `{kind: "webhook", signature: "github"}` trigger is unchanged: a repository webhook with its own secret.

An installation deleted or suspended on GitHub leaves the list, and one unsuspended comes back; the github triggers turn
off only when no installation is left (`disabled: {reason: "connection_lost", detail}`, naming it), and coming back
turns none on. `DELETE /v2/integrations/github` disconnects the App and turns every github trigger off the same way,
answering `{disconnected: true, triggers_off, note}`, the note "Delete the App itself on GitHub: <its settings URL>":
the App's credentials leave this server only, and it stays on GitHub until deleted there. Turned off, a trigger is kept:
an agent keeps its triggers, and each goes on again once turned on with GitHub connected.

An MCP server saved with `auth: {type: "github_app", headers?}` (`PUT /v2/settings/mcp-servers/{name}`) uses the
connected App's tokens and keeps none of its own: only its static headers (such as `X-MCP-Tools`), sealed as written,
and never an `Authorization`. Its tools are listed with a token of the App's installation. At each launch of a run that
grants its tools (its start, every resume, a relaunch after a crash) the server mints an installation token for that
run, narrowed to the one repository the run is about, with the App's permissions: a GitHub event's run uses its
installation and repository (the server's own payload tag); any other names it in its input as
`https://github.com/<owner>/<repo>`, whose installation the server asks GitHub for with the App's JWT. The token goes to
the run's MCP calls with the static headers beside it, lives only in memory (handed to the run's process over its pipe,
never its environment, journal, a log line or an answer), and is cut from whatever a run shows while it may be in use.
A run whose repository the App does not cover, or that names none, has those calls answered in words ("The GitHub App
isn't installed on owner/repo"). A known limit: a token lasts an hour and is not renewed inside a live run's process
(it is minted at each launch): a run still working past it has its GitHub calls answered, unsent, "The GitHub token for
this run expired: it is minted again when the run resumes", and its next resume mints a fresh one.

## Templates

A template package makes a working agent in one call: its definition, its skills and rules, and its triggers, from a
folder the server ships. `GET /v2/templates` lists them; `POST /v2/templates/{name}/apply` with `{parameters,
overrides?: {model}}` makes one, or nothing when a check fails (a trigger refused archives the agent it made). A
package's `version` is SemVer and never `definition.version`, the agent's revision number. The first package is `code-review`, a code review agent for one GitHub repository. The format and the
rules of an apply are in [templates/README.md](https://github.com/Parcha-ai/agentrun/blob/main/packages/serve/templates/README.md);
`agentrun template validate DIR` checks a folder as the server does.

## What it serves

| Route | Here |
| --- | --- |
| `GET /health` | Without a credential: whether the store reads and the disk has room ([capacity and health](#capacity-and-health)). |
| `GET /openapi.json` | Without a credential: this API as an OpenAPI 3.1 document, the `agentrun.v2/0` contract (vendored in `src/openapi/`, its source in `info`) with this server's own routes marked `x-agentrun-serve` the operations it answers `501` marked `x-agentrun-serve-unsupported`, and a contract operation that takes more than the contract gives marked `x-agentrun-serve-changed` with each change named; `links.openapi` in capabilities points at it. |
| `GET /capabilities` | Without a credential. `backend: local`, every feature flag present and true only when it works; `tools`, the tools an agentic revision may name; `workflows`, what a workflow revision's model nodes get and, in `workflows.decisions.providers`, the decision providers its typed questions run on; `models`, where models come from and the model of each tier. |
| `POST /agents`, `GET /agents`, `GET /agents/{id}` | `POST` takes `{definition, skills?, note?}` and makes the agent with its first revision, current. A definition has `instructions` (an agentic revision) or `workflow` (a workflow revision, checked by the DSL first), and `name`, `description`, `model` and `thinking` (agentic only), `harness` ([harnesses](#harnesses)), `place` ([place](#place)), `tools`, `tool_settings` ([search and fetch](#search-and-fetch)), `skills` (names; each `<name>/SKILL.md` is in `skills`) and `version`, which is the number the revision gets, and `max_cost_usd`, the agent's default cap (an agentic agent's or a workflow's), kept by an edit that leaves it out and cleared only by 0, and `cap_mode`, how such a cap prices a request, `expected` or `strict` ([spend cap](#spend-cap)). A field the store does not keep (`input_schema`, `output_schema`) is `422 input_invalid` by name, and so is a definition that can never run here; one this host cannot run yet saves with `warnings` ([models](#models)). The ETag (`home_etag`) is the current revision's id. `GET /agents/{id}` adds `tools`, the tools its current revision grants with each one's provider ([search and fetch](#search-and-fetch)). |
| `PUT /agents/{id}/definition` | The same body, checked [the same way](#models): a new revision, its parent the current one, made current. Without `skills` the current revision's skill files carry over. A definition that is the current revision already writes nothing, so a PUT sent twice makes one revision. An agent's id, name and description stay those it was made with. `If-Match` that is not the current ETag is `412 precondition_failed`; the store compares it again inside the commit, so of two edits that read the same revision exactly one lands. The contract's body is taken too: the definition itself, with `If-Match` required (`412` without it) and `definition.version` greater than the current one (`422`). Any such version is taken, and always makes a new revision, the same definition included; the revision is numbered as this server numbers them, the next, and the answer says which; the route reads a body holding `definition` as this one, any other as the contract's. |
| `GET /agents/{id}/revisions` | The agent's revisions, newest first: `revision`, `version`, `parent`, `kind`, `current`, `note`, `created_at` and the `definition`. |
| `POST /agents/{id}/current` | `{revision}`: one of the agent's revisions becomes current again. |
| `POST /agents/{id}/archive`, `POST /agents/{id}/unarchive` | [Archiving](#archiving): hides the agent and its runs from the lists, or shows them again. Answers the agent, with `archived_at`. |
| `DELETE /agents/{id}/sign-ins/{key}` | This server's own route (`x-agentrun-serve: "signins/1"`): forgets one of the agent's [saved sign-ins](#saved-sign-ins), at its vendor and here. `409 sign_in_held` while a run holds its save lease, or while a run it was handed is still going. |
| `POST /agents/{id}/runs`, `GET /agents/{id}/runs` | A run of the current revision, or of `revision`. An agentic run's input is `{content: string}`; a workflow run's is what its workflow's input schema takes. `file_ids` names [uploaded](#uploads) files, copied into the run's `work/inputs/` before it starts and named in its first message. The agent's runs, newest first. |
| `GET /runs` | Every agent's runs, newest first, a page of at most 100; `agent`, `revision` and `status` narrow it, and `archived=true` lists only archived ones. A failed run's summary carries its `error`, and a waiting run's its `pending`. |
| `GET /runs/{id}` | The run: its revision, kind, status, state, result, error, `pending` (this server's own, `pending/1`: what it waits on, by `kind`, such as `{kind: "question", question, asked_at}` for a question it asked a person, or `{kind: "browser", instruction, completion_condition, asked_at, expires_at}` for its agent's ask for the owner in its browser; else null) and cost (`basis: estimate`; $0 before its first model request, a cancelled run's included). |
| `GET /runs/{id}/timeline` | JSON pages with the change-number cursor (`after`, `next_after`, `reset`, `drop`, `has_more`, `final`, `wait_ms` long poll, and this server's own `limit`, 1 to 500 rows a page, default 500), or server-sent events with `Accept: text/event-stream` (`id` is the cursor, `Last-Event-ID` resumes). Rows sort by `seq`; the usage row (`Cost so far`), the run's running total, is always the last row, and moves to the end when a row comes after it. |
| `POST /runs/{id}/messages` | To an agentic run: `steer` while the agent works, `answer` when it asked the person, `follow_up` after a stop or after it completed: a completed run opens again, the same run on its own session and store, takes a place under `--max-runs` (`429` when none is free), and completes again. A failed or cancelled run, an archived run and a run of an archived agent are `409 not_continuable`; a workflow run takes none (`501`). |
| `POST /runs/{id}/stop`, `POST /runs/{id}/cancel` | Stop ends an agentic run's turn and leaves the run `input_required` and idle. Cancel ends a run `cancelled` once its process has exited. |
| `POST /runs/{id}/archive`, `POST /runs/{id}/unarchive` | [Archiving](#archiving) one run. Answers the run, with `archived_at`. |
| `GET /runs/{id}/files`, `GET /runs/{id}/files/{path}` | The files under the run's `work/`, raw. |
| `POST /files`, `PUT /files/{id}`, `GET /files`, `GET` and `DELETE /files/{id}` | [Uploads](#uploads): a file sent in one call (`POST /v2/files?path=...`, its bytes the body), or reserved and then sent (`PUT /v2/files/{id}`); the server's uploads listed, read and deleted. |
| `GET /agents/{id}/home/files`, and `GET`, `PUT`, `DELETE` on a file's path below it | The files in the agent's home, listed, read, written and deleted ([agent home](#agent-home)). This server's own routes (`x-agentrun-serve: "home/1"`). |
| `GET /stats` | This server's own route, outside the contract (`x-agentrun-serve: "stats/1"`): the agents, the runs (`total`, `active`, `needs_input`, `failed`, `needs_review`, `status_unknown`), each agent's run count, the cost and what is archived, read from the agent store's aggregates alone, no run's files opened. Archived agents and runs are left out of every number but `archived`. A completed or cancelled run counts only in `runs.total`, but for an escalated one (completed, waiting for a person's review), which `needs_review` (`stats/3`) counts; `failed` never does. Each running run is in exactly one of `active` (queued or working) and `needs_input` (`input_required`), both from the runs this server holds, and `status_unknown`: a running run it does not hold, or holds as ended before its end is written. `cost.usd` sums the runs that ended with a cost and is null when none did, never $0, with `basis` `estimate`, or null beside a null `usd`; `unknown_runs` counts the rest. `analytics` (`stats/2`) sums the runs' metrics over the runs not archived that `from` and `to` (RFC 3339 date-times to the millisecond, an impossible one or a finer fraction refused; runs started in [`from`, `to`)) and `agent` pick, each optional, 400 when malformed: `filter` echoes them; `totals` (runs, completed, an escalated run included, `needs_review` (`stats/3`), failed, never an escalated run, `runs_with_metrics`, tokens and each token kind, requests, unmetered, `cost_usd` and `unknown_cost_runs`), `time` (`wall_ms` over the ended runs, `active_ms` where metrics have it), `by_harness_effort`, `by_day` (UTC), `by_source` (`live` or the import source) and the top 20 `tools`. A run with no metrics counts in `runs` and in no token sum. `learning` (`learning/1`) counts the runs that tried to learn over the same filters, from the learning ledger and the runs this server holds ([Learning](#learning)). The query bounds `analytics` and `learning` alone. |
| `GET /runs/{id}/graph` | A workflow run drawn, live: its workflow, the DSL's `workflowGraph`, each node's state (a map's items with their labels and the branch each route took for them, a route's branch), every decision with its receipt (answers, evidence, the state the judge saw, image links), every call with its input and output, and the totals (cost, null when any part is unknown). While the run goes it reads the run process's `live.json`, rewritten every 300 ms, never the run's store, which the process holds; once it ended, its store is read lock-free, so a poll never waits on it and never answers `home_busy`. An agentic run has none (`404`). |
| `POST /runs/{id}/pause`, `POST /runs/{id}/resume` | A workflow run: what is in flight finishes, and no node, model call or decision starts until it is resumed. Its status reads `paused`, and stays so across a server restart. An agentic run is `501`, an ended one `409`. |
| `POST /workflows/validate` | `{workflow, tools?}`: every issue a save would refuse (`[{path, code, message}]`, the DSL's validation with code not run) and what this host lacks as `warnings`. Writes nothing. A refused save's `422` carries each issue as a field under `definition.workflow`, with its `code`. |
| `GET /settings/tool-keys`, `PUT` and `DELETE /settings/tool-keys/{id}` | [Tool keys](#tool-keys), this server's own routes (`x-agentrun-serve: "toolkeys/1"`): each key's fields by name and where each is set, never a value; save one sealed, or forget it. |
| `GET /settings/mcp-servers`, `POST /settings/mcp-servers/preview`, `GET`, `PUT` and `DELETE /settings/mcp-servers/{name}`, `POST .../{name}/refresh`, `POST .../{name}/oauth/start`, `GET /settings/mcp-servers/oauth/callback` and `GET .../oauth/client.json` | [MCP servers](#mcp-servers), this server's own routes (`x-agentrun-serve: "mcpservers/1"`): preview a remote MCP server's tools, save it with its credential sealed, read it back without the credential, refresh its tools, forget it, or [sign in to it with OAuth](#signing-in-with-oauth) (the callback and the client document take no token). |
| `GET /settings/tools`, `PUT /settings/tools` | This server's own: the providers of `web_search`, `web_fetch` and `browser` ([search and fetch](#search-and-fetch)). |
| `GET /runs/{id}/browser` | This server's own (`x-agentrun-serve: "liveview/1"`): the run's live browser view for the owner, `{state: "off", reason}`, `{state: "none"}` or `{state: "live", viewer}` ([the live view](#the-browsers-live-view)). |
| `POST /runs/{id}/browser/hand-back` | This server's own (`liveview/2`): the owner's answer to the agent's ask for them in its browser, `{outcome: "done" \| "cancelled"}`; the first answer wins, a different one is `409 handoff_answered` ([the live view](#the-browsers-live-view)). |
| `GET`, `PUT` and `DELETE /settings/webhook`, `POST /settings/webhook/test`, `GET /settings/webhook/deliveries` and `POST .../deliveries/{webhook_id}/redeliver` | [Webhooks](#webhooks), this server's own routes (`x-agentrun-serve: "webhook/1"`): the URL run notices are POSTed to, signed by the Standard Webhooks spec; never its secret but once. |
| `GET` and `POST /triggers`, `GET`, `PATCH` and `DELETE /triggers/{id}`, `POST /triggers/{id}/fire`, `GET /triggers/{id}/firings`, `POST /triggers/{id}/secret`, `POST /hooks/{id}` (no token: [signed](#webhook-triggers)) | [Schedules](#schedules), this server's own routes (`x-agentrun-serve: "trigger/1"`): schedules that start an agent's capped runs, each firing once, and their history. |
| `GET /templates`, `POST /templates/{name}/apply` | [Templates](#templates), this server's own routes (`x-agentrun-serve: "templates/1"`): the template packages it ships, and an apply that makes one's agent and triggers, all or nothing. |
| `POST /mcp` | This server's own route (`x-agentrun-serve: "mcp/1"`): the [MCP endpoint](#for-coding-agents), Streamable HTTP with one JSON-RPC message per POST (`initialize`, `ping`, `tools/list`, `tools/call`), answered as JSON, stateless. Its ten tools call these routes in process with the caller's token. The Bearer token only, never the page's cookie; a browser `Origin` other than this server's own is `403`; any other method is `405`. |
| `GET /usage` | The runs' cost estimates, by meter, agent, key, day or region (`key` and `region` are one line, `local`). A run of unknown cost adds what it is known to have spent so far (its `so_far_usd`: each priced charge, browser time and paid tools included) and is counted in `unpriced_runs` (in the total and in each line it is unknown on), so no sum is ever null, it never passes as $0, and a total is never below a line of its own: with `unpriced_runs` above 0 the total is a lower bound. |

Home export and import, quotes and `POST /runs/{id}/kill` answer `501 unsupported_here` naming the feature, and
capabilities declare each one false. No run waits out `input_wait_s` here (`null`). `limits.max_cost_usd` is the highest cap a run may name: `null` here, as any cap
above $0 is taken; it does not mean caps are unsupported ([spend cap](#spend-cap)).

## Uploads

A run's input files. Send one in one call, its bytes the body and its path in the query:

```sh
curl -s "$AGENTRUN_BASE_URL/files?path=plan.md" -H "authorization: Bearer $AGENTRUN_API_KEY" --data-binary @plan.md
```

It answers `201` with the file, `ready`, under `file`: its `file_id`, `size_bytes` (the body's length) and `sha256`
(the body's own).
Its `content_type` is the query's `content_type`, else the request's own type when it names one (not
`application/octet-stream`, not curl's `application/x-www-form-urlencoded`), else its path's extension's, as a run's files
are served (`plan.md` is `text/markdown; charset=utf-8`), else `application/octet-stream`. A `sha256` in the query is
checked against the bytes (`422 input_invalid` when they differ). A multipart form (`curl -F`) is `415`: send the bytes
themselves. Without `path` a body that is not JSON is `422` at `path`, saying how to call. `Idempotency-Key` replays the
first file for the same bytes.

Or, as the contract has it, in two calls: `POST /v2/files` with the JSON `{path, size_bytes, content_type?, sha256?}`
reserves the file, `pending`, and answers where to send its bytes, `upload.url`; `PUT` them there as the raw body, any
content type. Their length must be `size_bytes` and their SHA-256 the `sha256` given (`422 input_invalid` at that
field), and then the file is `ready`. `upload.url` is a path from the server's root, `/v2/files/{id}`: send it to the
server's address (`curl -X PUT --data-binary @plan.md "${AGENTRUN_BASE_URL%/v2}$url"`), not after the `/v2` base, where a
`404` says so. With no `content_type` the reservation's type is its path's extension's.

Either way the bytes are streamed to disk, never held whole, so `max_body_bytes` does not apply; a file is at most
`limits.max_upload_bytes`, 50 MiB (`413`). The same bytes sent again change nothing; other bytes are a `422`.
`GET /v2/files` lists the server's uploads, pending and ready, newest first (`limit`, `cursor`), `GET /v2/files/{id}` reads
one's record, and `DELETE /v2/files/{id}` removes it and its bytes (`204`): these three are this server's own
(`x-agentrun-serve: "files/1"`).

A run names up to `limits.max_files_per_run`, 20, ready files in `file_ids`: an unknown, pending or repeated one is
`422` at `file_ids` before anything starts. Each is copied, never linked, into the run's `work/inputs/` at its `path`,
folders kept, before the run's process starts, whatever its harness; a name already taken gets a suffix (`notes-2.txt`,
`docs-2/`), the same for the same files in the same order. The run reads them as any file of its workspace, and
`GET /v2/runs/{id}/files` lists them. An agentic run is told of them in its first message, on every harness: after the
input's `content` and a blank line, one line,
`Files for this run: "inputs/notes.txt" (32 B), "inputs/docs/plan.md" (1.5 KB).`, each file by the path the run's tools
take, quoted as a JSON string with a control, format or separator character as its `\uXXXX` escape (so no name forges an
entry or reorders the line), and its size, at most 20 and then how many more, and never past what the run's door takes
in one message (fewer named, then only how many). That is the message the harness gets, so it is the timeline's first
`user_message`; the run's `input` stays as it was sent. A run given no files is sent its `content` as it is. A deleted
upload stays in the runs that copied it; a run started after names it in vain. Each upload is kept in
`DIR/files/<file_id>/`, 0600. A start clears the temp files a crashed upload left (`.incoming.*.tmp` in `DIR/files/`,
`bytes.*.tmp` in a file's folder), each only when it is a regular file (a `DIR/files/` that is a link is not swept), and
logs `event=uploads_swept removed=N`. `upload.expires_at`, which the contract requires, is advisory and not enforced in
this release: a `PUT` after it is still taken.

## Agent home

Each agent has a home, a directory of its own at `<data>/homes/<key>/`, kept across its runs; runs do not see it yet.
The key is the agent's id in lower case and 16 hex digits of the id's SHA-256, so two ids that differ only in case
(`keeper`, `Keeper`) never share a home on a disk that folds case, as macOS's does by default. `GET /v2/agents/{id}/home/files` lists every file in it, recursively, in the shape of a run's file list (with
`agent_id` in place of `run_id`), and a home never written to lists none. Below it, a file's own path: `GET` reads the
file as a run's file is read, and `PUT` writes the raw body as the file, whole (a temporary file renamed over it,
`0600`), making the directories on the way and the home itself on the first write, and answers its entry; of two writes
at once, the last wins. A body over `capabilities.home.max_file_bytes` (`limits.max_body_bytes`) is `413`.
`DELETE` removes a file (`204`; `404` when it is not there) and leaves an emptied directory in place. Paths are checked
as a run's are, a write goes at most 16 directories deep (as deep as the list goes), and a link anywhere on the way is
never followed: a read is `404`, a write or a delete
`403 system_file_forbidden`. `learning/` and `sign-ins/` (the agent's [saved sign-ins](#saved-sign-ins)) are the
server's alone (`capabilities.home.host_owned`): the list shows each as one entry, `{"path": "learning", "host_owned":
true}`, with none of what is in it, and a `GET`, `PUT` or `DELETE` at or under one, however the path is spelled
(`./Learning/x`), is `403 system_file_forbidden` (`details.reason` `host_owned`). A read's refusal names where to read
it instead: the learning API (`/v2/agents/{id}/learning`) on a server that has that route (on one that does not, `the
server keeps learning/ for itself; this server has no learning API yet`), and `/v2/agents/{id}` for `sign-ins/`. A host-owned name is matched by its
first segment folded (compatibility form, any case, no combining marks) and, where that segment and `learning/` are both
on disk, by identity (the same
device and inode), so a disk that takes another spelling for one name is refused the same way. A path takes only plain
segments: each its own NFC form, with no default-ignorable code point, or it is `400 invalid_file_path`. An archived agent's home is read and written as
its definition is. A write is held to its directory through `/proc/self/fd`; where there is none (macOS),
`capabilities.home.writes` is `false` and `PUT` and `DELETE` are `501 unsupported_here`, as Node has no `openat` to
write safely by path, while the list and reads still work. `GET` and `PUT /agents/{id}/home`, the contract's packed home, stay `501`.

## For coding agents

A coding agent (Claude Code, Codex) sets the server up and drives it with
[`skills/agentrun-serve/SKILL.md`](skills/agentrun-serve/SKILL.md), shipped in this package. `GET /llms.txt`, at the
server's root and without a credential, is the API in brief ([`src/llms.txt`](src/llms.txt)), with no data of the
server's.

`POST /v2/mcp` is the MCP endpoint: Streamable HTTP in its simplest form, one JSON-RPC message per POST answered as JSON,
with no stream and no session. Its ten tools:

| Tool | Routes |
| --- | --- |
| `whoami` | `GET /capabilities`: the token checked, and what this server runs. |
| `agents_list`, `agents_create` | `GET /agents`, `POST /agents` (the arguments are the definition; `definition` carries any other field, checked by the route). |
| `agents_revise` | `GET /agents/{id}`, then `PUT /agents/{id}/definition` with the fields given changed, on that revision (`If-Match`). |
| `runs_start` | `POST /agents/{id}/runs`, answered at once. |
| `runs_get` | `GET /runs/{id}` (its `pending` is a waiting run's question), with `console_url`. |
| `runs_events` | `GET /runs/{id}/timeline` with `limit` (100 by default). |
| `runs_files` | `GET /runs/{id}/files`, or one file's text up to 64 KiB. |
| `runs_respond`, `runs_cancel` | `POST /runs/{id}/messages`, `POST /runs/{id}/cancel`. |

Each tool calls its routes in process, with the caller's token, so it checks and answers as they do: the route's JSON is
the result's structured content (and its text), and a refusal is a result with `isError` holding the route's `error`. A
run is started, then polled with `runs_get`; no call is held open for one, and a question a run asks waits as its
`input_required` state, for `runs_respond` or a person in the console. The endpoint takes the Bearer token only (the
page's session cookie is never taken there), refuses a browser `Origin` other than this server's own, and on loopback
refuses a `Host` that is not a loopback name, as every route does.

```sh
claude mcp add --transport http agentrun "$AGENTRUN_BASE_URL/mcp" --header "Authorization: Bearer $AGENTRUN_API_KEY"
codex mcp add agentrun --url "$AGENTRUN_BASE_URL/mcp" --bearer-token-env-var AGENTRUN_API_KEY
```

## Harnesses

A definition names the harness that runs it: `pi` (the default, and what a definition that names none gets),
`claude-agent`, `codex` or `opencode`; any other is `422 input_invalid` on `definition.harness`. Every answer names it. An edit
(`PUT /agents/{id}/definition`) that names no harness keeps the agent's, as it keeps its skill files; name `pi` to move it
back.
`GET /v2/capabilities` lists each in `harnesses`, with `available` and, when not, the `reason`, and `default_model`: the
model the harness runs when a definition names none (`provider/model-id`, as a save and a run resolve it), or null where
it runs none (the harness does not run here, or no default model here runs on it: claude-agent never takes a gateway's
model). A definition naming a
harness this server does not run yet saves with a warning on `definition.harness`, and a run of it is
`409 agent_not_runnable` with `details.harness`; it never runs on pi instead. This server runs pi always, and
`claude-agent`, `codex` and `opencode` when each adapter's package, pins and provider endpoint check out; the harness's
`reason` says what is missing. `claude-agent` and `codex` install themselves on first use: AgentRun never ships the
Claude Agent SDK or the Codex CLI, and the first run on each (or the first agent saved on it) installs the version AgentRun
pins (`@anthropic-ai/claude-agent-sdk@0.3.286`, `@openai/codex@0.164.0`) from npm into `<data>/harnesses/claude-agent`
or `<data>/harnesses/codex`, with the npm that runs the server, once. Each install is pinned by the lock the server
ships, `harnesses/claude-agent/` or `harnesses/codex/` (a package.json that names the package at the pin, and npm's lock
for it: every package of the tree, the platform packages that hold the Claude CLI or the Codex binary and the peers'
dependencies included, by sha512), which `npm ci --ignore-scripts --include=optional` holds every tarball to, from
whichever registry the person's npm config names; a config that omits optional packages still gets this platform's CLI.
It lands whole or not at all: npm writes into a fresh directory beside the install's own, the result is checked there
(the package at the pin, its entry, this platform's CLI or binary, and for Claude the MCP library), then it is renamed
into place and made read-only. `node scripts/harness-locks.mjs` makes the locks again when a pin moves (`--check`
checks them). Every run that needs one waits for that one install, its ready time counted from the install's end, and
shows a `phase` row, `Installing Claude Code (first use)…` or `Installing Codex (first use)…`, while it does. Each run
then loads the harness from its own packages inside its install and nowhere else, never from a `node_modules` above it;
a tree that is not whole is installed again. Claude Code as an earlier build installed it, at the top of `<data>/harnesses`
itself, is removed before the first install (the server logs `harness_install_removed`), and it installs again; a
`harnesses` directory that holds anything else is left as it is. Until it is installed, capabilities list the harness with `installs:
"on_first_use"`. When npm fails, the run fails and its error names the command that installs it by hand, the same locked
install: the shipped `package.json` and `package-lock.json` copied into a fresh `<data>/harnesses/<harness>.new`, `npm ci
--ignore-scripts --include=optional` there, then that directory put in place of `<data>/harnesses/<harness>` (made
writable first: the server leaves its install read-only). A server that stops
mid-install stops its npm (SIGTERM). `opencode` needs `opencode-ai@1.19.5` installed beside the server (an exact optional peer of
it), and its model goes where codex's does: the gateway at `AGENT_MODEL_BASE_URL`, or
OpenAI with `OPENAI_API_KEY`, on the Responses API. The packages and pins are checked once, at the start
(`event=harness_offers why=start`): a harness
installed after it, or put back on its pinned build, stays unavailable until AgentRun restarts, and its reason ends
saying so, `once it is installed, restart AgentRun to pick it up` or `once the pinned build is installed, restart
AgentRun`. Run from npx, a reason whose install line is the npx line that starts the server with what is missing needs
no such clause: running that line is the restart. A reason a setting fixes (a model key, say) names no restart.

`claude-agent` sends its requests to `ANTHROPIC_BASE_URL` (else Anthropic) with `ANTHROPIC_API_KEY` and Anthropic's own
model id, and prices the run by it: a revision's `anthropic/<model-id>`, its dots as dashes, so OpenRouter's dotted name
(`anthropic/claude-sonnet-5.5`) and Anthropic's own (`claude-sonnet-5-5`) are one model. `pi` sends its Anthropic models'
requests there too, compaction, a hosted search, a learned node and a grade included: to `ANTHROPIC_BASE_URL` with
`ANTHROPIC_API_KEY` as `x-api-key` alone (never `ANTHROPIC_AUTH_TOKEN` or an OAuth token), and capabilities read its
Anthropic default ready only where that route runs (`models.needs: "key"` without `ANTHROPIC_API_KEY`, or with an
`ANTHROPIC_BASE_URL` a key may not go to, whose run is refused in its words). Such a base refuses Anthropic's route
alone: a model of any other provider runs as it does without it. `codex` and `opencode` send their requests
to serve's gateway (`AGENT_MODEL_BASE_URL`), else OpenAI with `OPENAI_API_KEY`. A harness with none of its own settings, where
`OPENROUTER_API_KEY` is set, runs through OpenRouter (`https://openrouter.ai/api`, the key as a bearer token):
claude-agent on its Messages endpoint, with Anthropic's own id on the wire (OpenRouter takes it: its Claude Code guide
says its "Anthropic Skin … handles model mapping") and the run priced by OpenRouter's catalog entry; codex and opencode on its Responses API, with the model's whole id (`openai/gpt-6-sol`). On that key alone the defaults are
`openrouter/openai/gpt-6-sol` for pi (pi-ai's OpenRouter provider, on the bearer route), `anthropic/claude-sonnet-5.5` for
claude-agent and `openai/gpt-6-sol` for codex and opencode; a direct provider's key gives the default for its harnesses where it is
set. A model named `openrouter/<vendor>/<model>` (pi's name for it) goes through OpenRouter on every harness. An endpoint
the host names never gets OpenRouter's key: `ANTHROPIC_BASE_URL` without `ANTHROPIC_API_KEY` is refused. A model with more
than one segment after its provider (`anthropic/anthropic/claude-sonnet-5.5`) is refused, naming the form to use. A provider
that refuses the run's key (401) fails the run naming the key and where to set it ("OpenRouter refused
OPENROUTER_API_KEY (401: User not found): set it where AgentRun starts, or save it in Settings → Model keys."), on every
harness, with the provider's first sentence only.

`claude-agent` loads the revision's skills itself: the model is shown each as `agentrun:<name>`, loads one with the Skill
tool and reads its other files with `read_skill_file`, and the system prompt holds the instructions alone. A skill the
adapter does not take (a name that is not lowercase letters, digits and dashes, a `SKILL.md` without front matter giving
its `name` and a `description`, a file path that is not plain or is deeper than five segments) stays inlined in the
system prompt; so do all of them when together they hold more than 1 MiB. On `pi`, `codex` and `opencode`, a run with the
`read` or `bash` tool is told each skill's name, what it is for (its `description`) and its `SKILL.md`'s path under
`.agents/skills/`, and reads the file when the skill fits the step it is on; a run with neither gets every `SKILL.md`
inlined in its system prompt.

`definition.harness` and `capabilities.harnesses` are this server's, outside the `agentrun.v2/0` contract:
`GET /v2/openapi.json` marks each `x-agentrun-serve: "harness/1"`, beside the other properties it adds (`model/1`,
`serve/1`), and lists them in `info.x-agentrun-serve.fields`.

## Decision workflows

A workflow's typed questions (its `judge`, `pick`, `sift`, `route` and `ask` nodes) run on a decision provider when
this server's environment sets the provider's key. They are fast decisions, not agent turns: one request per node, with
typed answers and their probabilities.

- Jev, TypeSafe's System One, through `@parcha/agentrun-jev`, answers a node that names no provider. Set
  `TYPESAFE_API_KEY`: it is the route whose key stays out of a run's reach (below). `OPENROUTER_API_KEY` also works,
  for Jev through OpenRouter, and so does a model gateway on OpenRouter: with `AGENT_MODEL_BASE_URL` on the host
  `openrouter.ai` and neither key set, Jev runs on `AGENT_MODEL_API_KEY`.
- Parallel Decisions, through `@parcha/agentrun-decisions`, answers a node that says `provider: "parallel"`, with web
  citations as its evidence. It runs on one of two routes. With `PARALLEL_API_KEY` set, on Parallel's own API: each
  request is booked at Parallel's list price as an estimate. Without it, on Parallel's model through OpenRouter,
  `parallel/decisions-fast`, on the OpenRouter key (below): only an OpenRouter key is needed. Its citations (OpenRouter's
  `url_citation` annotations) are the same evidence, and its cost is the one OpenRouter reports. A request whose outcome
  was lost after sending is never sent again on either route: the run escalates it as interrupted. Capabilities say which
  route it runs on (`route: "parallel"` or `"openrouter"`).
- OpenRouter's Decisions models answer a node that says `provider: "openrouter"` and names its model in `model`
  (`liquid/d1`, `perplexity/pplx-decider-v1.2`, `cloudflare/clef`, `typesafe/jev-1.14`). They run on the OpenRouter key
  Jev's OpenRouter route reads (`OPENROUTER_API_KEY`, else `AGENT_MODEL_API_KEY` with `AGENT_MODEL_BASE_URL` on
  openrouter.ai), handed to the run's process on the decision descriptor as Jev's is. That key is also the model
  gateway's, which a run's process holds. Images to them are experimental. A model that cites the web returns
  `url_citation` annotations, which become the node's evidence. A cost OpenRouter reports above 0 is booked; 0 (a model its
  catalog prices at 0) or none is unknown, never $0.
- A decision node's `images` are files of the run's `work/`, such as the pages `pdf_pages` draws: the run's process
  reads them and sends them with the request. The receipt keeps each image's SHA-256, never its bytes.
- `GET /capabilities` lists the providers in `workflows.decisions.providers` (`[{id: "jev" | "parallel" | "openrouter", available,
  reason?, note?, route?}]`, `route` on parallel), and `runJudge` is among `workflows.adapters` once any of them runs here. On the OpenRouter route,
  jev's `note` names the variable Jev runs on (`OPENROUTER_API_KEY` or `AGENT_MODEL_API_KEY`) and says that it is the
  model gateway's key.
- With no key for a provider a workflow's nodes name, the workflow saves with a `not_set_up_here` warning on
  `definition.workflow` naming the variable, and a run of it is `409 agent_not_runnable`, with `details.adapters:
  ["runJudge"]` and `details.decisions` naming each missing provider, for example `{parallel: {reason:
  "not_set_up_here", needs: ["PARALLEL_API_KEY"]}}`. A provider this server does not have refuses the save, `422`.
- Each question's receipt is a row of the run's store (`agentrun.decisions`) before its answer acts, and a resumed run
  takes an answered one instead of asking again.
- Jev's API reports token counts and no price, so each answered decision is booked at TypeSafe's published price
  ($0.042 per million input tokens; output tokens are free) as an estimate, and the run's `cost.usd` is its decisions'
  sum, with `basis: "estimate"`. A decision whose cost is unknown (no token counts, the OpenRouter route, or a call that
  failed after it may have been sent) keeps its receipt's cost `null`, and the run's reads `null`, never `0`.
- The TypeSafe and Parallel keys never enter a run's environment, which its tools and its model's provider read. The
  server drops `TYPESAFE_API_KEY` and `PARALLEL_API_KEY` from every run's process. It hands a run's process those it
  needs ([Safety](#safety)), a workflow's decision providers' and Parallel's where its `web_fetch` or `web_search`
  resolves to Parallel, once, by name, on an inherited pipe (the first descriptor after its stdio and its secrets pipe, as macOS refuses a high one), at each
  launch, a resume after a restart included. The process reads them once into its decision providers and web tools,
  closes the descriptor before anything else runs, and keeps the keys nowhere else. It is never in an
  environment, an argument list or a file, and no program the run starts inherits it. With no key, no descriptor is
  opened. On the OpenRouter route Jev's key comes on the same descriptor, never from the run's environment; that key is
  also the model gateway's key, which a run's process holds for its model nodes.
- `TYPESAFE_API_KEY` and `PARALLEL_API_KEY` are among the secrets the launcher hands the server over its pipe, so the
  server holds them out of its own environment too. Neither is ever among the secrets a run's process gets over its own
  pipe, which are its tools' environment: the decision descriptor is their only way into a run.

## Archiving

An agent or a run is archived, never deleted: `DELETE` stays `405`. These routes are this server's own, outside the
`/v2` contract, like `GET /runs` and an agent's revisions; capabilities list them in `features.archive`.

- `POST /v2/agents/{id}/archive` hides the agent and its runs from `GET /agents`, `GET /runs` and
  `GET /agents/{id}/runs`; `POST /v2/runs/{id}/archive` hides one run. `.../unarchive` shows them again. Each is
  idempotent (archiving again keeps the first time), takes no body, and answers what it changed.
- Each list takes `archived=true` to list only archived ones (`false`, the default, lists the others).
- Every read by id still answers, with `archived_at` (null when it is not archived; a run's is its own, else its
  agent's): `GET /agents/{id}`, `GET /runs/{id}`, its timeline and its files. `/usage` still counts archived runs: the
  spend happened.
- A new run of an archived agent is `409 agent_not_runnable`, saying it is archived (`details.archived_at`); a run
  already going when its agent is archived keeps going.
- The store keeps each change as one row of `archive_changes` in `store.sqlite`, written once
  ([the store](../pi-durable-agent/README.md#agents-in-a-folder-the-agent-store)). A data directory an earlier version
  wrote opens as it is, with nothing archived. Going back to an earlier version keeps every row, but that version does
  not read them: archived agents and runs show as not archived there, and an archived agent's runs start again.

## The console

Open the link the server prints, once, in a browser. `/` is the console (`apps/console` in the repository), on the
server's own origin, under a CSP that allows that origin only:

- **Mission Control**: the store's counts and the latest runs.
- **Agents**: each agent with its kind and harness, archived ones behind **Archived**. **New agent** and an agent's page:
  a name, a description, a prompt (with its model, thinking level and tools) or a workflow, sent to `POST /v2/agents`;
  an edit is `PUT /v2/agents/{id}/definition` with `If-Match` set to the revision it started from (412 when another came
  first). Its revisions, with **Make current** (`POST /v2/agents/{id}/current`), and **Archive** or **Unarchive**.
- **Playground**: a run of an agent, on the revision you pick, with its input, followed as it goes.
- **Runs**: every run, newest first, filtered by agent and by state, archived runs behind **Archived**; the address
  keeps the filters. A run's page follows `GET /v2/runs/{id}/timeline` with a long poll, sends messages (an answer while
  it waits on `ask_person`), stops or cancels the run, shows its files and a workflow's graph, and has **Archive** or
  **Unarchive**.
- **Settings → MCP servers**: add a remote MCP server (its name, address and credential: none, a bearer token, headers,
  or **Sign in** with OAuth), **Preview** its tools and protocol, then **Save**; each saved one with its tool count and
  its credential's state, **Refresh**, **Change** (a credential left empty keeps the saved one) and **Delete**. An
  agent's Tools step lists each saved server's tools; a box ticked grants `mcp:<server>/<tool>`.

Its files (`index.html`, and Vite's hashed files under `/assets/`) are public and hold no data: everything it shows
comes through `/v2`. The store's read-only JSON stays under `/api/*` (`/api/store`, `/api/agents/{id}`, `/api/runs` and
the rest of [`@parcha/pi-durable-agent`](../pi-durable-agent/README.md#looking-at-a-store)'s store page's data), for a
script with the token or a browser with its cookie. With accounts on (the default) the console asks for the owner's password
([your password](#your-password)) and the browser holds the owner's session cookie; a `?token=` link sets no cookie: the
token is for scripts and the CLI. With `AGENTRUN_ACCOUNTS=0`, the printed link (`/?token=`) sets a cookie (`HttpOnly`,
`SameSite=Strict`, `Path=/`, and `Secure` when `X-Forwarded-Proto` says https) and sends the browser to the same address
without the token. The cookie's value is derived from the token, never the token itself, and it lasts until the browser
closes. Without it, the console says to open the link. Either cookie takes the place of `Authorization: Bearer` on
`/api/*` and `/v2`: for a `GET`, and for any other method only when the request's `Origin` is the server's own origin
and its body is `application/json`, or, on a `PUT` or `POST` to a route that takes bytes (`PUT /v2/files/{id}`,
`POST /v2/files`), of any content type. A request that sends an `Authorization` header is checked on that header alone.

The repository's `npm ci && npm run build` builds the console (`apps/console`) first, and the server's build copies it
into `dist/console`; the image always carries it. A server built without it answers `/` with a 404 that says so. `/console/`
(the console's address before) and `/setup` and `/sign-in` (the old page's, which the printed setup link still names)
send the browser to `/`, which keeps a link's `#code`.

## Your password

AgentRun Server is for one person, who signs in to the console with a password (`AGENTRUN_ACCOUNTS=0` turns this off). With
no `AGENTRUN_PUBLIC_URL`, the start prints `Set your password: <url>/setup`, and the first visit sets it, 12 characters or
more. With it, the start prints `Set up this server: <url>/setup#code=<code>`, and setup takes that code (or the token as
the Bearer). The server keeps a scrypt hash of the password, never the password, in `DIR/owner.json`, and signs its
session cookies with the key in `DIR/.session-secret`; both are 0600, and no run reaches either. A session lasts 30 days;
**Sign out everywhere** ends every session on every browser. Sign-in tries are limited per address, ten in 15 minutes, and the limit keeps up to 10,000 addresses: past that a
new address gets a 429 until older ones expire, and an address already limited stays limited. Forgot it: run
`agentrun-serve reset-password --data DIR` where the data directory is (`docker exec agentrun node
/opt/agentrun/packages/serve/dist/cli.js reset-password --data /data` in the image). It clears the password and signs every
browser out, and the next visit sets a new one. The token works for scripts and the CLI either way.

A browser's writes must come from the server's own origin. Serve the image on another address or port behind a proxy, and
set `AGENTRUN_PUBLIC_URL` to the address people open. Behind a proxy every sign-in comes from the proxy's address, so the
limit is one for everyone: ten wrong tries in 15 minutes, from anyone, keep the owner out until the window passes (the
token still works for scripts meanwhile). Serve it over https where you can: on plain http a browser sends the session
cookie to every server on the same host name, whatever its port, so another app on that host could read it.

## Importing your sessions

`agentrun-serve import --data DIR` reads the Claude Code, Codex and pi sessions in your own home (`~/.claude/projects`,
`~/.codex/sessions`, `~/.pi/agent/sessions`) into the data directory, once. Each project folder becomes an agent, with its
CLAUDE.md or AGENTS.md and its skill folders, and each session becomes a run you can read but not continue. Nothing leaves
this machine, and the values of key-shaped environment variables are cut out of what it writes. Run it again and it takes
only what it has not taken already. Sessions written in the last 10 minutes wait for the next import.

- `--dry-run` lists what it would import and writes nothing.
- `--from claude-code,codex,pi` picks the sources.
- `--include-deleted` also imports the sessions of project folders that no longer exist, such as a git worktree you
  deleted. Each such folder is still its own agent, with no instructions or skills to read.
- `--all` keeps those too, as well as sessions of temporary folders and sessions with no message of yours.
- `--verbose` lists each file it leaves out, and why.

The dry run and the import both end by counting what they left out, by why, with the flag that brings each kind in:

```
left out: 84 sessions from folders that no longer exist (--include-deleted imports them too)
left out: 2 sessions still being written: they come in next time
```

## A run's life

1. `POST /agents/{id}/runs` starts the run in the store (`startRun`, which pins the revision and seeds
   `DIR/disk/agents/<agent>/runs/<id>/`), then its process: `pi-durable-disk run --dir DIR/disk/agents/<agent>/runs/<id> --app <this package's app> --serve 0` on
   loopback, behind a token of its own (`DIR/.door-token`), with its stderr in `runs/<id>/process.log`. The run's input
   is in `runs/<id>/serve.json`.
2. The app reads the run's revision from the store.
   - An agentic revision runs as the root agent: its instructions and skills, its model, and the tools it names of the
     workspace's `read`, `write` and `edit`, and `ask_person`, which ends the turn; the timeline then shows a `waiting`
     row, and the run is `input_required` and `waiting` until a message answers it. `bash` is bound only in a
     [sandbox](#sandbox), where it and the file tools run in the run's box. The run is `queued` until its first message shows; while the process runs, the
     timeline comes from its door's events through `@parcha/pi-durable-agent/timeline`. Once the run is idle and its
     newest row is the agent's answer, the server sends the process SIGTERM. A model error ends it `failed`
     (`run_failed`). A run whose `max_cost_usd` cannot buy its next request is paused, `input_required` and `waiting`
     with `pending.kind` `budget`; one its cap refuses for a reason no cap fixes ends `failed` (`spend_cap_reached`,
     [below](#spend-cap)). A
     provider's content filter stopping the answer ends it `failed` with `moderated` on every harness, saying so in plain
     words ("The model provider stopped this answer (its content filter). Rephrase the request, or try another model.");
     the Timeline's error row keeps the harness's own words for the stop: pi-ai's on pi ("Response incomplete:
     content_filter", say), the kernel's on claude-agent and codex ("content_filter: the model provider stopped this
     answer"), never the provider's own. On claude-agent and codex the session's model proxy reads
     the provider's stop and ends the turn at once, so the CLI never asks for the refused answer again.
     A stop sent while the run still reads `queued` (a message sent to it not yet in its timeline) waits, up to a
     request's deadline, for that message to show, then stops the turn as it stops any working run.
     A stopped run can be continued: a follow-up starts a fresh turn on the whole history, and the turn the stop cut is
     not replayed. A cancelled run cannot: a message to it is `409 not_continuable`, and its `next_action` is to start a
     new run of the agent.
   - A workflow revision runs on agentrun-pi's durable workflow task, started by `startWorkflowRevision` of
     `@parcha/pi-durable-agent/workflow` (keyed by the run's id): its model nodes (`agent`, `decide`, `extract`,
     `report`) on the run's model, with the file tools each node names, and its typed questions on Jev or Parallel
     ([decision workflows](#decision-workflows)). A workflow that needs code or a tool call this host does not run is
     not saved here (`422`). The run is `queued` until its process serves, then `working`; when the workflow
     ends, the app writes the run's final status with the outcome and releases it. Nothing is carried back from inside
     the process, which holds the run's store until it exits.
3. When the process has exited, the run's rows are read from its released store (an agentic run's conversation, a
   workflow run's model nodes), and the server carries the run back, every run of both kinds: `carryBack` records its
   state, cost and a summary in the store (an agentic run's answer; a workflow run's `workflowCarry`, its completed
   nodes, then where it failed or escalated). Its last
   page says `final`. v2's `cancelled` is the store's `stopped`; a workflow that escalated ends `failed` with
   `error: {code: "escalated", message: <its summary>}`, in the run and in the lists.
4. When the server starts, it reads every run the store says is running. A run process an earlier server started and
   that still serves the run is supervised again, by the holder its row names (its pid, its start, its door); a run
   that already ended is carried
   back; a run whose process is gone before it ended is opened again on its directory and resumes from its store (an
   agentic run waiting for an answer waits without one, until a message). A carry back that finds the store held by
   another writer is tried again with backoff, and at the next start.

An `Idempotency-Key` answer is kept in `DATA/.idempotency.json` for `limits.idempotency_ttl_s` (a day), saved once the
work is done and before the answer is sent, so a retry after a restart gets the first answer; a server that goes down
between the work and the save loses it, and a save that fails still answers. A run create's key is also kept with its
run in the agent store, written with the run itself, so a retry after any restart, or after that day, gets that run (as
it is now, marked `Idempotent-Replayed: true`), and another body under the key is still `409 idempotency_mismatch`.

A completed agentic run's `result` is `{output: null, final_answer}`; a completed workflow run's is
`{output: <the workflow's output>, final_answer: null}`.

## Learning

Learning is off unless an agent's definition says `learning: true` (an agentic one: a workflow refuses the field). A
definition that sets it keeps it on its revision, `false` included, and an edit that leaves it out keeps the agent's; one
that never sets it stores nothing, so its revision id is the one it had before the switch. The server's `--learning off`
turns learning off for every run it starts, whatever the agent says.

An agent that learns has a learning folder, `learning/` in its folder on the disk (`DATA/disk/agents/<key>/learning/`), in Claude Code's
auto-memory format:

- `MEMORY.md`, the index a run reads, one line per active note: `- [name](file.md) — description`, built by the server;
- one file per note, `<slug>.md`: front matter with `name`, `description` and `type` (`user`, `feedback`, `project` or
  `reference`), and optionally `status: superseded` or `retired` with `superseded_by` (no status: active), then the
  note's text. The server parses it and builds the index with its own code, in [`src/learn/`](src/learn/SPEC.md),
  whose `SPEC.md` is the folder's contract.

The folder is plain git with `main` checked out. The agent's first run that learns makes it, with one commit on `main`
holding an empty `MEMORY.md`; an agent that does not learn never gets one. The server is its only writer. Every git
call the server makes there runs with the folder's hooks and fsmonitor off, no replace refs, no lazy fetch and no system
or global config, one at a time per agent.

Each run of an agent that learns starts from `main` as it is when the run is made, whatever its harness:

- `runs/<id>/learning.json` pins that commit (`seed`). It is written once: a resume or a follow-up reads the same
  commit, however `main` moves on.
- What the agent learned goes into the run's instructions after the agent's, under `# Learned`, so a run reads it
  whatever its tools: an agent with no `read` tool still follows its notes. Only active notes are served: a note with
  any other status is never there, whole or by its index line (one a hand edit left in `MEMORY.md` is dropped), and is
  not counted toward the budget. Each active note is there whole (its
  `## name (file.md)`, its description, then its text), the one changed last on `main` first (a merge or a person's
  edit; then by name), while they all fit the server's learning budget (`--learning-budget`, 8000 bytes by default).
  Past it, the run reads the first 200 lines of `MEMORY.md` (and no more than 25 KB, as Claude Code loads its own),
  then the notes changed last, whole, while they fit what is left; the rest are named only in the index, and an agent
  with the `read` tool is told they are in `.learning/`, to open one when it applies (one without is not). A line
  before them says to follow a note when it applies. `# Learned` opens, for every run that learns, notes or none, with
  what the run is told of learning: that only what it answers when it is asked at the end is kept, never a file it
  writes, so it tells the person it will keep what they ask it to remember, and that a secret is never kept. A run with
  nothing learned yet is told so. A run that does not learn (or whose seed failed) gets no `# Learned`. Every name, description, text and index line is cut of the server's secrets as they are when the run is made,
  as a person's reads are. That is pi's system prompt and claude-agent's and codex's instructions: the same channel
  `CLAUDE.md` and `AGENTS.md` travel in. No such file is written into the run's work (claude-agent keeps project
  settings off, so a `.claude/` in the work never loads). The pin keeps the section the run
  reads (`section`), so a resume or a follow-up reads the same; a pin an earlier server wrote, the index alone
  (`learned`), is read as that server gave it.
- `MEMORY.md` and the active notes are copied into the run's `work/.learning/`, made fresh and cut of the server's
  secrets the same way, for the run to read; a note that is not active is not, and neither is its line in the index.
- The skills the agent wrote, each a folder `skills/<name>/` on `main` with its `SKILL.md`, join the revision's own:
  each is copied, every file of it, into the run's `work/.agents/skills/<name>/`, and the run gets it as it gets the
  revision's (pi and codex read each `SKILL.md` in their prompt, claude-agent loads the ones its adapter takes through
  its Skill tool). A skill named like one of the revision's is the revision's, and only an active skill is served: one
  whose `SKILL.md` front matter says `status: pending` (held for its owner's OK), or any status but `active`, is not.
  The learned ones get 256 KiB, every file of each together, and never more than the revision's skills leave of the 1
  MiB an adapter takes of a run's skills in all, so they never push the revision's back into the prompt: the one
  changed last on `main` first, each whole while it fits. One that does not fit, or holds one of the server's secrets,
  is left out. The pin names the files of the ones laid (`skills`) and the ones left out (`skills_left_out`), and a
  follow-up gets them laid again, fresh, whatever the run wrote over them; one the work no longer holds whole when the
  run's process starts is left out of what its harness gets, and the run goes on. A skill whose name or files are out
  of shape is not read, and a symbolic link or a submodule at `skills/` or anywhere under it is a learning fault.
- The workflows the agent learned, each a folder `workflows/<name>/` on `main` with its `workflow.json` and its
  `README.md`, are the run's as one tool, `learned_workflow {name, input}`, on every harness (pi, claude-agent, codex),
  with no edit of the agent's definition. Only an active one is, by a skill's rule: its `README.md` sets no status, or
  `active`. Its description names each workflow with the line its README gives, 8 KiB of lines in all: by name, each
  while its line fits, and one that does not, or holds one of the server's secrets, is left out. A README whose front
  matter does not read one way (not closed, or a line that is no key at its left edge) is not read. The pin names the
  ones the run gets (`workflows`), each kept whole in the run's directory (`learned-workflows.json`), outside its work,
  and the ones left out (`workflows_left_out`). The list is fixed when the run starts: a workflow approved or retired
  while it runs is the next run's to get or not, as a note or a skill is. A call checks the workflow again against the
  agent's own tools as its run resolves them, as the merge did: one whose call node names a tool the agent was not
  granted (or one its run resolves unavailable), whose model node names any tool (a learned model node runs without
  tools, so the merge refuses one too), or that holds a code node or a shell or executor call, is refused before any of
  its nodes runs. It runs with the workflow DSL: each model node on the run's own model (the one the run was made with
  and handed the key of; a tier the run has no model of runs there too), in a session of its own with no tool of its
  own, each call node `via: "tool"` on a tool the agent has, its paid requests booked under
  the `learned_workflow` call, and web_search on the provider's own search where it resolves native, through the run's
  models. Its model requests are the run's, under its cap: on pi, side requests of the run's models labelled
  `learned_workflow` on its timeline; on claude-agent, codex and opencode, requests on the run's one route, the session's
  model proxy, under a key of the run's own: the same body rules, provider, key, price and cap as the harness's own
  requests, booked on the session's records labelled `learned_workflow`. So they go wherever the harness's go (the
  operator's gateway at ANTHROPIC_BASE_URL or AGENT_MODEL_BASE_URL, OpenRouter, the vendor's API), and every run is
  offered the workflows its pin names. A call a crash cut off is answered interrupted, never run again. The tool gate holds
  `learned_workflow` like any tool: its settings key is `learned_workflow`, allowed by default (the agent's own graded
  workflow, each node checked), and tool settings may set it to ask (the run parks until an owner answers) or deny.

The server reads the commit with git plumbing, never the working tree. What it holds that is not a regular UTF-8 file of
1 MiB or less, or a note out of shape, is not read, and the server's stderr names it. A learning fault never blocks a
run: when the folder cannot be made or read, or its notes copied, the run starts with nothing learned. A host without
git 2.32 or later (what learning's own git calls need) is one such fault, said once on stderr.

### What a run learns

When a run that learns answers or fails, the server asks the same session one more turn before it lets the run go,
whatever its harness and whatever tools its agent has: one message through the run's door under the fixed request id
`learn-reflect-<run id>`, so a server that restarts mid-turn asks again and the run takes it once. The server alone
sends it, with the origin `reflect`; no request field sets it. The message (`reflectPrompt`, in `src/learn/reflect.ts`)
asks the agent to look back over the whole conversation, what the user asked it to remember included, and to answer
with each note to keep as one ` ```note <file>.md ` block in the note format, and to use no tool: no `write` tool is
needed, and nothing the run wrote in `work/.learning/`, during the task or the turn, counts. It also says that a memory
is replaced by a new note with `supersedes: [old.md]` and never by reusing a name, how many index lines are left (200
less the active notes), that `No notes.` is a fine answer, and what not to keep. The turn runs under the run's own cap,
with no reserve, and within 5 minutes; its rows are labelled `learning`, and the run's answer stays the job's.

As the run settles, before it reads ended and before a follow-up can open it again, the server keeps what the turn
answered, the whole text of each of its messages, and what the user said in the run, in `runs/<id>/learning-turn.json`.
Once the run has ended, in the agent's queue, the server reads the notes from that answer alone (`parseReflection`, in
`src/learn/reflect.ts`): an answer with no note is `empty`, and one that gives notes out of format (a note outside a
block, a block with no file name, or one name given twice with other words) is `unparsed`, nothing kept. A block opens
with the fence asked for (```` ```note ```` or four backticks for a note, four for a skill or a draft) and runs to the
next line that is that fence; a shorter fence is text, a longer one an example, and an opening never closed is left out
alone. `checkProposal`
(`src/learn/check.ts`) then refuses, before anything is written anywhere, a note that reuses an existing note's name, a
path that is not a `.md` file at the top, a bad name, front matter out of shape or setting `status`, a `supersedes`
naming a note that is not active, more than 8 notes superseded, more than 8 new notes or a note over 4068 bytes (4096,
less the 28 the server's own `origin` and `status` lines may take once it merges the note), an
index past 200 lines, hidden characters, and text shaped like a secret or holding one of the server's own secrets (the
launcher's, the keys and tokens in its environment, its API and door tokens, each webhook trigger's signing secret as it
is now), in a note or its name. A `MEMORY.md` the
answer gives is ignored. What passes is kept as the run's proposal, `runs/<id>/learning-proposal.json`, with what the
user said, each message cut of the server's secrets.

Then one grader decides, one grade at a time per agent: `gradePrompt` (`src/learn/grade.ts`), which holds
`GRADE_RUBRIC`, the rubric's one statement, bounded (3 minutes), against `main` as it is then, and read by
`parseVerdict`, which fails closed. It runs on the model the server grades on: `--grade-model` (or
`AGENTRUN_SERVE_GRADE_MODEL`), else the strong tier (`AGENT_MODEL_STRONG`), named as the strong tier takes one; with
neither, on the agent's own model. `GET /capabilities` names it as `learning.grade_model` (null for each run's own). A
cheap model is a poor grader, so point the strong tier (or `--grade-model`) at a strong one. The grader reads each active
note's index line, the whole text only of the notes the proposal supersedes, what the user said in the run (cut of the
server's secrets, as the proposal keeps it), and the new notes, so its prompt stays under 200,000 characters however
many notes the folder holds. No injection screen runs before it: a page classifier cannot see where a note came
from, and read a preference the user stated as a planted instruction; the grader's Planted question decides. What the
grade spends is in no run's totals: it is kept on the run's learning, and counted once on `GET /usage` under the meter
`learning`, by agent and by day; a call cut off at its bound spent what nobody knows, so its cost is unknown, never $0.

A kept verdict merges as one commit on `main`, made with plumbing: the new notes added, each with its `origin` (`you`
for what the user asked in their own words, `run` for what the run worked out), each note they supersede marked
`status: superseded` with `superseded_by`, `MEMORY.md` rebuilt from the active notes, and the checked-out files brought
in line. A risky rule (to trust a site or a seller, skip or loosen an approval or a check, or send money or data to
an account), whether the user asked for it or the run worked it out, is merged as `status: pending`: in no `MEMORY.md`
and no run's copy, to wait for its owner's OK, and named on the run's learning (`pending: [{file, name}]`, detail
"Waiting for your OK: <name>.", after what it learned when it kept one too).
`GET /capabilities` says so (`learning.pending: true`). Its message is `learning: <run id>: merged`, the grader's reason and a `Run-Id` trailer; `main` moves only from
the commit the merge was made on (once more on a `main` that moved meanwhile), and a run a trailer already names is
merged, never twice. The merge's own questions are asked again of `main` first: a name another run added since is
refused as `exists`. A server that goes between steps picks the run up at its next start, once.

The run's `learning` (on `GET /runs/{run_id}`, and `{state, reason, detail}` in run lists, the detail cut to 140
characters and no time) says how it went: `seeded`, then
`reflecting` during the turn and until what it answered is checked, `proposed` while it is graded, and `merged`, or
`dropped` with a reason from a closed list (`seed_failed`, `no_budget`, `unknown_cost`, `cancelled`, `crashed`,
`reflect_timeout`, `reflect_failed`, `empty`, `unparsed`, `propose_failed`, `checker`, `grader`, `grade_failed`; a run
record or ledger line with any other reason is not counted). It is `null` for a
run that does not learn (its agent's `learning` is not true, the server's switch was off when it started, or it is a
workflow's or an imported run). Its `detail` says the same in a person's words, never the machine's: "Started from 2
notes.", "Looking back on this run…", "Checking 1 new note…", "Learned: Check units (replaces 1 older note)", "Learned:
Check units. Waiting for your OK: Buy from PaperDepot24 first.", "Nothing new to remember from this run.", "Not kept: <the
grader's reason, its first sentence>", "Not kept: it held something that must not be stored (one of this server's
secrets).", "Not kept: its notes weren't in the expected format.", "Not kept: learning stopped (looking back took too
long)." and so on (`learning-words.ts`); a client that acts on it reads `state` and `reason`. A note's name or the
grader's reason in it is said again at each read from what the run keeps (its `learned` and `pending` notes, the
grader's verdict), cut of the server's secrets as they are then before the words are cut short (300 characters, 140 in a
list), so a value that became a secret after the run is never shown in part. Once it is proposed, merged or dropped (`seed_failed` included), the run's
timeline has one row of kind `learning` whose summary is that detail.

Four more fields say what the run was given, read, learned and holds for the owner's OK (`learning/2`), on its read and
in run lists alike, each absent when it holds no note: `given`, `[{file, name}]`, the notes it started with (each its
`# Learned` section names, whole or as an index line naming its file, as it was seeded; absent when it started with
nothing learned); `read`, `[{file, name}]`, the notes its job read from `.learning/` (absent when it opened no note file),
found once as the run settles from its timeline (each `read` call on any harness whose result was a success, of a note
the run started from: never `MEMORY.md`, nor a read its end-of-run turn made, nor a note read through a command such as
`bash`'s `cat`) and kept in `serve.json`, so a list never reads a timeline; `learned`, `[{file, name, supersedes}]`, the
notes its merge added, once `merged`; and `pending`, `[{file, name}]`, the notes its merge holds for the owner's OK, once
`merged`, never among `learned`. A name and a file are cut of the server's secrets as they are now, a file holding one
`[redacted]`. Whether a run applied a note is not measured: `given` and `read` say what it had and what it opened. Each
note on the agent's learning view and notes page counts its runs of each, `runs: {given, read}`, over the runs the server
knows (held ones from memory, ended ones from the learning ledger).

Each run's learning end is written once to the learning ledger, `DATA/learning-usage.jsonl`, one line `{run, agent,
state, reason, at, cost, tokens, seed_notes, given, read, answered_at, job_cost_usd, look_back_usd}` (`cost` and
`tokens` the grade's, null when unknown, 0 when nothing was graded; `seed_notes` how many notes the run started from;
`given` and `read` the files of the notes it was given and read, each absent when there are none; once it looked back,
`answered_at` and `job_cost_usd`, when its job's answer was final and what it had cost then; `look_back_usd` what
looking back cost, 0 when it did not), after its `serve.json` holds it; a server that went between the two writes it at
its next start. A run's notes are the one part that moves after its end (a follow-up reads another note): a line
`{run, agent, notes: true, given, read}` then says them anew, the latest one winning, and counts neither the run nor its
costs again. `GET /stats` counts the runs that tried to learn under `learning`, over its `from`, `to` and
`agent`, from that ledger and from the runs the server holds (`in_progress`), never opening a run's files; the
`learning` meter on `GET /usage` reads the same lines.

An eval set of 20 runs and what each proposed, labelled keep or drop (`test/fixtures/learn-eval.json`: lessons the
agent worked out, user preferences and a "remember" during the task, one-shop facts, secrets, a tool's failure and four
injections), runs in CI through the parser, the checks and the grader's prompt on a faux grader that answers by label
(`test/learn-eval.test.mjs`). `scripts/learn-eval.mjs` runs the same set on real models, the grade and the end-of-run
turn both, and prints keep-precision, keep-recall and the injection-drop rate per model; it spends.

### What a person sees and controls

A person reads and changes an agent's learning through this server's own routes (`learning/1` in `/v2/openapi.json`),
with the token, an archived agent's too:

- `GET /agents/{agent_id}/learning`: `main`'s head, `MEMORY.md` as `index`, the first 50 notes (active first, then
  newest first) and the first 20 changes on `main` (newest first, each `by: {run}` from its `Run-Id` trailer or
  `{user: true}`, with its commit, time, reason and files), and how the agent's runs that tried to learn fared
  (`merged`, `dropped` by reason, `in_progress`), counted as `GET /stats` counts them: from the learning ledger and the
  runs the server holds, never a run's files; and `impact` (`learning/2`), what learning changed: the agent's completed
  runs that started from at least one active note against those that started before its first note (the earlier of its
  first merge and the start of its first run that started from a note, so a person's first note counts), each side's
  `runs`; `median_duration_s`, the time to the answer (the run's start to its job's end, before it looks back);
  `median_cost_usd`, the job's own cost without its look-back, over the `cost_runs` whose cost is known; and
  `median_learning_usd`, what learning itself cost a run (its look-back and its grade). From the same rows and ledger;
  null unless both sides count 2 runs. An agent with no folder answers `main: null`, empty pages and `impact: null`.
  `GET .../learning/notes?cursor=&limit=&status=` and `GET .../learning/log?cursor=&limit=` page on, up to 200 at a
  time; a cursor reads the same commit its first page did.
- `GET .../learning/files/{file}`: one note (or `MEMORY.md`) on `main` as `text/markdown`, with its `ETag`, the note's
  git blob id.
- `PUT .../learning/files/{file}` with the note's whole text (as `text/markdown` or `text/plain`, or as
  `application/json` `{text}`, the form the console's page sends under its session) edits it under `If-Match: <etag>`,
  or creates it under `If-None-Match: *` (201); `POST .../learning/files/{file}/retire` under `If-Match` sets `status: retired`,
  on an active or a pending note; `POST .../learning/files/{file}/approve` under `If-Match` makes a pending note active
  (see [Approving a note that waits](#approving-a-note-that-waits), below). An edit keeps it waiting: a `PUT` that
  drops or changes its status is 400 with the rule `status`, so a token holder cannot make a held rule active by
  writing it back. A note a person creates with `status: pending` waits the same way. A stale
  ETag, or a name already taken, is 412; neither header (or `If-Match: *`) is 428 `precondition_required`. The note
  passes the same structural checks as a run's (`checkNote`, in `src/learn/check.ts`), and no grader: a refusal is 400 with
  `problems`, and nothing is written. A retire is how a person revokes a note, so it checks the note's format alone:
  its front matter as retired, and the note cap with the status line on top. A secret shape or one of the server's
  values in its name or text never blocks it (its answer and the log are cut of them as any read is), and a leaking
  note is replaced by retiring it and creating a clean one. Each write is one commit on `main` in the agent's queue,
  `learning: <edited, created or retired> by a person: <file>` with a `Changed-By: user` trailer, with `MEMORY.md`
  rebuilt, `main` moved only from the commit it was made on, and the folder's files brought in line; it answers the
  note as it now is, with its new `ETag`. `MEMORY.md` itself is never written (400).
- `POST .../learning/files/{file}/restore` under `If-Match` makes a retired note active again, and gives a retired skill
  (its `SKILL.md`) or workflow draft (its `README.md`) to every later run again: one commit, `learning: restored by a
  person: <file>`, with `MEMORY.md` rebuilt and the notes it supersedes marked superseded, as an approval marks them.
  Unlike a retire, a restore checks the text again as a new note or skill is checked (secret shapes, the server's
  values, hidden characters, its format, and every file of a skill's or a draft's folder): a refusal is 400 with
  `problems`, and the item stays retired. Only a retired item is restored (else 400). It takes the owner's password
  session alone, as an approval does; one that waited for its owner's OK before its retire is recorded as their approval
  too (`Approved-Via: console`). The learning view gives each item `last_change` (`{kind, by, at}`: `approved`,
  `edited`, `created`, `retired` or `restored` by a `person`, or `learned` by a `run`) and each retired one `retired`
  (`{at, by}`, the time of its retire, which an edit since moves not).
- `GET /runs/{run_id}/learning`: the run's learning whole (its `given`, `read` and `learned` as on its read, its seed, its merge, the grader's verdict with its item for
  each new note, `{file, keep, question, why}`, `question` the rubric's question a dropped note failed, the checker's
  problems, what the grade cost), `null` for a run that does not learn; `verdict` is `null` until a grade ran.
  `GET /runs/{run_id}/learning/diff`: a merged run's merge commit against its parent, else its proposal against its
  seed, each file's patch as git writes it from the first `@@`, or `withheld` (`too_large`, `secret`).

Every read is git plumbing at one commit, with no optional lock, and every text it answers is cut of the server's
secrets as they are then; a file name holding one (a note named after a value made secret since, say) reads
`[redacted]` whole, in the notes (`file`, `superseded_by`), the log's `files` and a diff's `path`, and a write's
`Location` leaves it out, while its route still answers the real name to a caller who knows it. A commit's notes are
parsed once and kept, for the few commits last read, so the view and every page at that commit read no note again; a
log page reads only its own commits (`git log` from the cursor's offset, at most `limit`), and the log's `total` is
counted once a commit. A symbolic link at the agent's home, its learning folder or the folder's `.git` is never
followed: a read or a write there answers `500`, and nothing is written.

### Approving a note that waits

Who can approve: the owner, signed in with their password. No token approves, the server's own included, so a run that reaches this server only through its API (its MCP tools, a sandbox run) can't approve its own notes. Runs that use bash on the host run as you: they can read this server's files, its session key among them, so no route keeps them from approving. For untrusted tasks, use the sandbox.

`POST .../learning/files/{file}/approve` (and `.../restore`, which puts a retired item back into every run) takes the console's password session, sent from this server's own origin with
a JSON body as every page write is. Any token is 403: the server's own (what scripts and the MCP endpoint's tools
carry), a run's door token, and a token sent beside the session. So is every request on a server with accounts off
(`AGENTRUN_ACCOUNTS=0`), whose page cookie any token holder can mint. With no credential it is 401, as every route.
`capabilities.learning.approve` is true only for the owner's session; every other caller reads `approve: false` with
`approve_needs: "password"`. A note that is not pending is 400; a stale ETag is 412, none 428. The approval is one host
commit, `learning: approved by a person: <file>`, with the trailers `Changed-By: user` and `Approved-Via: console`; the
log shows `by: {user: true, via: "console"}` at the commit's time, never the note's text.

## Spend cap

A run may name `max_cost_usd`, an agentic run or a workflow run ([below](#a-workflow-run-under-its-cap)). A run that names none takes its agent's default,
the `max_cost_usd` of the revision it runs, kept with the revision; a run's own cap wins, since its caller chose it. A
definition's `max_cost_usd` above 0 sets that default, and 0 clears it (no default); anything else is `422`. An edit that
leaves the field out keeps the agent's default, as it keeps its harness and place: leaving a field out never removes a
spend limit. A workflow definition keeps one the same way. The cap is checked in the run's own process
before each model request, the agent's and a compaction's alike, on every harness: what the run has spent so far, plus
what each request still in flight is held at, plus what this request is expected to cost must stay within it, or the
request is not sent and the run pauses ([below](#a-run-paused-at-its-cap)). A request costs its input, plus the output it
is sent with at the output price, plus any fee its tokens do not show (below). How its input is priced is the run's
`cap_mode`: the run's own (`POST /agents/{id}/runs` with `cap_mode`), else its agent's (a definition's `cap_mode`, kept by
an edit that leaves it out), else `expected`; only a run with a cap takes one (`422 not_allowed` otherwise).

- `expected`: priced from the previous request of its conversation, as that request's usage reported it. The input it
  read from the cache or wrote to it (`cache_read_input_tokens` and `cache_creation_input_tokens` on Anthropic's API,
  `input_tokens_details.cached_tokens` on the Responses API) at the cache-read price, if that request ended less than 4
  minutes before (Anthropic keeps a cache 5); the rest (its input after the cache, plus what the conversation grew by
  since, one token per byte) at the higher of the input and cache-write prices. With no previous request in hand, or one
  older than 4 minutes, all of the input at that price. On claude-agent, codex and opencode the previous request is the
  session's last on the same model in the run's current process, so a run's first request after a restart is priced
  with nothing cached; on pi it is the conversation's last answer. Output never passes the cap (below); a request that
  misses the cache can, by at most its bound: its input at full price less its input expected. The run's
  `cost.overshoot_bound_usd` serves the bound of the requests in flight. A request's real cost is always booked, never
  clipped: a run that passed its cap so is not failed for it, its timeline says `Went $X over its cap on a cache miss (at
  most $Y).`, and its next request is refused, so it pauses at its cap as usual. A request whose cost never comes in (cut,
  stopped, lost) counts at what it was held at, its expected cost, in this process and after a restart alike.
- `strict`: every input token at the higher of the input and cache-write prices (the provider may bill any of the input as
  a cache write), the worst case: no request passes the cap, and a run whose requests read the cache pauses well before
  it has spent its cap.

Near its cap, a run's model is told once to finish: when what is left (the cap less what was spent and what requests
in flight are held at) is under three times the run's typical request, the next request of the run's own model carries
"About $X left of this run's budget: finish now with your answer." at its end, and the Timeline shows it as the server's
row ("AgentRun: About $X left …"). The typical request is the median of the run's own model's priced requests after the
first (the first writes the cache), else that one, else, while nothing is priced, the next request at its input and a
4,096-token answer (never its whole output allowance: a $1 run on Sonnet 4.5 is not told at its start); side calls on
another model and paid tools count in what is left, never in the typical request. Told while nothing is priced (a small
cap, due at the run's first request), the words say the budget instead, on every harness: "This run's budget is about
$X, enough for little work: answer as soon as you can." On pi the words go into that one request's context;
on claude-agent, codex and opencode the model proxy adds them to the body (after everything the CLI sent, so its cached
prefix is unchanged). Neither CLI nor pi keeps them in its transcript, and no message is queued, so nothing runs after
the model's answer. Once per cap, across restarts; a raise re-arms it.

Under a cap each request is limited to the
output tokens what is left of the cap can buy, thinking included, never more than it asks for or than the model's
ceiling (its max output tokens, else its context window, clamped to what the window leaves): on pi through the request's
own options (its max tokens, and on Anthropic's API its thinking budget), on claude-agent, codex and opencode written into its body
by the model proxy (`max_tokens` and `thinking.budget_tokens`, or `max_output_tokens`). The limit is what it is held at,
so the cap stays exact. A request is refused only when what is left cannot buy its least: 1,024
tokens for its answer (what it asks for, when that is fewer), and when it thinks, the provider's least thinking budget
where thinking takes one (Anthropic's, 1,024, the budget squeezed to it at the least) or else its thinking level's
budget, since its reasoning then shares the limit (minimal 1,024, low 2,048, medium 8,192, high 16,384). The input bound is one token per UTF-8 byte of what is sent (a byte-level tokenizer never makes
a token of less than one byte, and an image's base64 is far more bytes than its tokens), plus what the provider adds
server-side (a tool-use prompt, each image), from the same table the model proxy of claude-agent, codex and opencode uses; there
the proxy measures each request's body. A request in flight holds what it was admitted at until it answers, so requests
sent side by side cannot pass the cap together. Spent so far is read from the run's store each time its process starts, so it
survives a restart, plus each response since, and with them each charge a paid tool booked (`monid.run`, which is itself
refused once the spend reaches the cap; see [monid](#tools)).

The `browser` tool's session time is held the same way, before it runs, so no browser minute passes the cap. Its next
stretch is the most a session can run before the run can check again: the provider's minimum (what its release may top
it up to), pi-browser's idle window before it releases a session nobody calls (180 s), and 30 s for that release to be
confirmed at the provider; at Browserbase's price, 270 s or $0.009. Before each browser call, the call is held at what its
session ran since its last charge plus two stretches (one for the call's own time, one for a session it opens): spent, plus
every hold, plus that must stay within the cap. Otherwise the call is not made: the model gets the cap's words
(`spend_cap_reached: Not sent: this run has spent $X of its $C cap, and the next step, this browser call, could cost up to $0.018 ...`), and
the run's session is released.
A session's first charge moves one stretch of its call's hold to the session, held until its release is booked, which
covers its idle time, its top-up and its release; each call's charge comes out of the call's hold, which goes when the
call returns. So what the run spent plus what it holds stays within the cap through a session's create, its calls, the
idle time between them and its release. A session a create's lost answer left to a release after the create deadline is
held for that deadline and a stretch until its release is billed. Across a restart of the run's process, every session
custody still tracks (kept, unreached, still releasing) is held from the reopen, at a stretch beside what it ran since
its last charge, and one kept is released an idle window later unless a call uses it. Three
things can still pass the cap, each by what it ran over, booked and shown: a single browser call that runs longer than a
stretch, a release that takes longer than 30 s to be confirmed, and the time a run's process was down while it held a
session (spent before any process could hold it). A session whose release is never confirmed is billed in full
(what it ran and its minimum) when the run gives up on it. When the run is let go, its sessions are released and their
last charges booked before its process exits.

Under a cap, whatever cannot be priced is refused, never passed as $0, and the run ends `failed` with
`spend_cap_reached`, since no cap would send it:

- A model serve has no price for (a gateway id pi-ai's catalog does not know, with no `AGENT_MODEL_PRICE`): its first
  request is refused before anything is sent, and the run ends `spend_cap_reached` at $0. With no cap its run's cost
  reads `null`. A model the catalog lists at $0 is a known $0, and passes any cap.
- A model whose output is priced and that names no output ceiling (no max output tokens and no context window): nothing
  bounds a request. One whose output costs nothing at every price tier keeps a known worst case, and passes.
- An input that could not be measured.
- A spend no one knows: a cost that is not a number, a cost still pending, and on pi a request a stop or a crash cut
  with no held figure (below). Every later request of the run is refused. `claude-agent` and `codex` runs also continue
  after a cut, at the worst case the cap held, as pi does.

A request you stop counts what it streamed plus up to 1,024 output tokens the provider may have produced after the last
word we read; never more than it was held. That is its input bound and each byte of content it streamed (its text,
thinking and tool calls on pi; on `claude-agent`, `codex` and `opencode`, the text, reasoning and tool-argument deltas
the response sent, never the provider's framing around them, which runs to about 12 bytes a character on the Responses
API and 24 on the Messages API) as a token, plus 1,024 tokens of output (`STOP_ALLOWANCE_TOKENS`), at the model's price, and at most
the worst case the cap held for it. The cut stream's own usage is never read: it is not what the provider billed (the
Responses API reports none until the end, and Anthropic's output count comes at the end). The 1,024 tokens are a stated
bound, as the native search allowance is: a provider that went on producing for longer after the stop could bill past
what is counted. A request that ended on an error after its response began (an overload part way, a reset), or a summary
that failed, still counts at its worst case, and so does a request cut by a crash (its process gone mid-request). A
request stopped before the provider's first header counts its input and the 1,024 tokens, on every harness.

Reasoning the provider never streams counts too. A model whose reasoning streams only as a summary (the Responses API's
reasoning; Claude 4-class thinking, and redacted thinking) or not at all is billed for far more than the summary's
bytes, so a stopped request that reasons also counts the part of its reasoning budget that did not stream: input +
streamed + 1,024 + max(0, reasoning budget - reasoning streamed), never more than the hold. Reasoning streamed is its
thinking's bytes on pi, and on `claude-agent`, `codex` and `opencode` the bytes of the reasoning events the response
sent (a thinking delta, a reasoning summary delta); answer text never stands in for it. The budget is its effort's or thinking
level's (minimal 1,024, low 2,048, medium 8,192, high 16,384; on Anthropic's API, the `budget_tokens` it was sent with).
A Claude model whose thinking is adaptive (pi-ai sends every current one `thinking: {type: "adaptive"}`, no budget) thinks
within its output limit as it sees fit, so on pi it counts that limit less 1,024 tokens, as `claude-agent` counts
`max_tokens`, and is sent the limit it is held at. With no effort or level given, on an API whose model then reasons at
its own default (OpenAI's), it counts its whole output limit, the conservative side; with thinking off on Anthropic's
API, none, unless the model thinks adaptively at any level (pi-ai's models with mid-conversation effort). On
`claude-agent`, every request that thinks counts its budget, since Claude 4-class models stream only a summary of their
thinking; thinking that streamed is subtracted, so a stop after a budget's worth of visible thinking counts nothing on
top. The figure is an estimate: an effort's budget is not a limit the provider keeps, so a request can reason past it.
It is bounded by the request's hold, and its real usage replaces it when that comes.

So on a model whose thinking is adaptive (every current Claude model, on pi and on `claude-agent`), a stopped request
counts up to its hold: the provider is given no thinking budget, and what streamed says nothing of the thinking billed.
That whole budget is the safe figure, kept on purpose: the stream reports the thinking billed only on its final
`message_delta` (`usage.output_tokens_details.thinking_tokens`), which a stopped stream never receives, and the live
`thinking_delta.estimated_tokens` is a display hint that can under-count. Under a cap with little left beside that hold,
the request after the stop can be refused, and the run then pauses for a raise.

On pi the figure is written on the request's start mark (`agentrun.request_started`, its worst case) and on the end mark
of one stopped (`agentrun.request_ended`, what it counts at), as `heldUsd`; on `claude-agent` and `codex` on the
request's `runner.request` record (its worst case) and, for one stopped, on its `runner.turn`. A later process counts it
the same: a capped run stopped and sent another message, or opened again after its process died, goes on while its cap
allows. A cut request from a store written before serve kept the figure has none, and is a spend no one knows.

A refusal says so in plain words, with the numbers, on its timeline row and on the run's `pending` (or, for a refusal
no cap fixes, its error), as a person who has never seen a model request reads them: "Not sent: the next step needs at
least $0.03, and this run's cap is $0.01. Raise the cap to at least $0.03 to continue.", and once a run has spent:
"Not sent: this run has spent $0.45 of its $0.50 cap, and the next step needs at least $0.03. Raise the cap to at least
$0.48 to continue." What was spent, and what steps still running hold (named when it is a cent or more), read to the
nearest cent ($0.0237416 reads $0.02); the exact amounts are `pending.spent_usd`. The cap to raise to is what was
spent, what steps still running hold, and the next step's least, rounded up to the cent so that it is enough. The words
name no model. The refusal's timeline row is an `error` row with
`paused: true`: the request was not sent and the run waits on a raise, so it reads as a pause, never as a failure. The error's code is `spend_cap_reached (out of budget): ` before those words: pi-ai's
retry reads only an error's text, and takes "out of budget" as final whatever digits the words hold. A request the cap
refused was never sent: the run's usage counts no request for it, and a run whose only request was refused says "no model
request sent". A reply the limit cut short says so on the run's timeline: "The reply stopped at 1,500 tokens: all that
the $0.15 left of the run's $0.50 cap could buy."

### A run paused at its cap

A refusal for room (what is left of the cap cannot buy the next request's least) pauses the run instead of ending it: the
refused request was not sent, so the cap holds, and a higher cap would send it. The run is `input_required` and
`waiting`, `error` null, with `pending: {kind: "budget", cap_usd, spent_usd, needs_usd, least_cap_usd, suggested_cap_usd, said, at}`:
its cap, what the cap counted as taken (spent, and held for requests still answering) and the least the refused request
needs (a cap above their sum sends it), the least cap that sends it, the raise it is offered, the refusal's words above,
and when it came. `least_cap_usd` is the very figure the words name ("Raise the cap to at least $X"), in whole
cents and above the cap, carried from the refusal that wrote them, so a client shows it without parsing the sentence. The
offered raise, `suggested_cap_usd`, is `spent_usd` + 10 × `needs_usd` rounded up to a whole dollar, and always above the
cap, so a `PATCH` with it (below) resumes the run; it is absent with the other figures. The figures come from the refusal's own start mark, so a
server started again says them too, shown as `cost.usd` is (to a millionth of a dollar), except `spent_usd` once the paused process is gone: the refusal counted requests
still answering at what it held for them, so then it is the store's spend, when that is lower, and `suggested_cap_usd`
follows it. The refusal's words (`said`) keep its own figures. Its timeline shows the refusal's row, the server's `phase` row "Paused at the run's cap" (`origin` server, its id
ending `:note`, so it is no message) marked `paused` (never an `error` row; it stays once the cap is raised, as the
run's history), then a waiting row: "Waiting for you to raise the
cap", and no more: the words are `pending.said`'s, which a client shows once. The
webhook's `run.needs_input` says `pending.kind: "budget"`. Its process is let go while it waits (SIGTERM: it drains and
releases the run), so a paused run holds no place; a server started again reads it paused from its store. A paused
process that does not let go within the drain timeout (`--drain-timeout`, 30 s by default) is killed, and the run ends
`failed`, as any run whose process is killed does, unless its cap was raised meanwhile: it held nothing, so the raise's
follow-up goes (below). A message to a
paused run is `409 budget_reached`; a stop does nothing more, and a cancel ends it `cancelled`. Only a refusal for room
pauses a run: one no cap fixes (above) ends it `failed`, as does a cost found past the cap after a response.

A paid tool call (monid's run, a search or a fetch through Parallel, browser time) that the cap refuses for room pauses
the run the same way. The call is not sent, and its result says so in the cap's words. The model's next request is
refused in those words, so the turn ends there and the model gets no turn to work around it. The run's `pending`
holds what was taken (`spent_usd`), the call's hold as what it needs (`needs_usd`), and the raise it is offered. A
raise sends the run on, and the model makes the call again if it still needs it: each call the model makes is one
call, and nothing is retried for it. The refusal answers that turn's next request alone: a stop in between, then a
message, starts a turn that is judged as any other. A paid call refused because what the run has spent is unknown
still ends the run `failed`.

`PATCH /runs/{run_id}` with `{max_cost_usd}` raises the cap, and only raises it: the new cap is above the run's current
cap, its last raise included, by more than a float's tail (1e-9; `422` otherwise, and for a run with no cap;
`409 not_continuable` for an ended run). A workflow run's raise is [below](#a-workflow-run-under-its-cap). The same raise sent again (a retry), within that tail, changes nothing and
answers as the first did. The run's serve.json keeps the raise before any answer, with each raise in `cap_raised`, so its
next process opens under it, as does a server started again; a raise it could not keep is not taken (an error answers it),
and the same raise again is taken anew. A run paused at its cap goes on: the answer is `{run_id, max_cost_usd, resumed: true,
message_id, status, state}` at once, and the pause gets one follow-up turn, "The cap was raised to $2; continue the
task.", under that `message_id`, which the server sends once the process being let go is gone, and which runs under the
new cap. From the moment the raise is taken, the run reads `queued` (state `working`), in the answer's `status` and in
every read after it, until the follow-up's turn runs: nothing waits on a person, so it is never `input_required` with no
`pending` meanwhile. A second raise before it goes raises the cap it names and answers the same `message_id`. It is sent once: a
server stopped before it went, or between starting its process and sending it, sends it when it starts again. One that
cannot be sent is tried again (after 1 s, then 3 s); after 3 tries the run ends `failed`, saying the cap was raised but
the run could not be sent on. The follow-up shows in the run's timeline as the server's, "AgentRun: The cap was raised…", never as the
person's message (its submit names the server as its origin, `cap_raised`). A working run's
live process keeps the cap it was opened with until its next one, and the answer's `note` says so. The raise is keyed to
the refusal's own start mark, so a row shown after the refusal never reads the run paused again.

A request carrying a native web search tool reads pages into its input that its body does not hold (the provider bills
them as input): under a cap its input bound is its body's plus an allowance. Claude's own search, an explicit `native`
pick, does not run under a cap: each search has a per-use fee the cap cannot reserve yet, so a capped claude-agent run
picking it is refused, and on `auto` it searches through Parallel on the server's key (a paid call the cap holds) or else
keyless Exa, as a capped codex run does; pi's own search request is held at its context
plus 125,000 (5 searches) and its most fee, 5 searches at $0.01. What the request
cost, booked once it answers, stops the next request through the cap, and a run whose booked spend passes its cap shows
one timeline row saying by how much (`Spent $X, $Y over the run's cap of $Z`, in cents).

The server also checks the run's cost after each response, as a backstop, and stops a run whose cost passed its cap.
Either way the run keeps the answer it paid for: a run the cap stopped has `result: {output: null, final_answer}`, the
newest answer it received, beside its `error`; one stopped before any answer has `result: null`.

A run's `cost.usd` is $0 before its first model request (a run cancelled before one included), and `null` when a
response reported no price or a request was cut before its end (a stop, a cancel, a crash): no request costs nothing,
but a request of unknown price is unknown, never $0. A stopped request shows `null` whether or not its cap counted it at
its held worst case.

### A workflow run under its cap

A workflow run is capped by the same checks, in its own process, each before the paid step is sent:

| Step | Held at | Where |
|---|---|---|
| A model node's request | its expected cost, as an agentic run's request | the run's models (`cap.ts` capModels) |
| A call node's `llm` call | the same | the same, as a side request |
| A call node's paid tool call (Parallel's search or extract) | its fee | `paidCall`, as an agentic run's |
| A decision on Parallel | its list price for one request, $0.001 | before the driver admits it (`decision-cap.ts`) |
| A decision on Jev | TypeSafe's published price, $0.042 a million input tokens, one token a byte of its state and questions | the same |
| A decision on an OpenRouter Decisions model | its catalog price: per request, per image, per input token, and per output token for 256 a question (`expected`) or the catalog's most (`strict`) | the same |

What a decision charged is booked in the run's store as the cap counted it, so a run opened again counts it once. A step
the cap has no room for is not sent and waits where it stands: the run is `input_required`, state `waiting`, with
`pending.kind` budget and `pending.node` the node's label. A model node's request waits unsent; a call node's call
ends its effect held, sending nothing, and goes again as a new effect once raised, never as the tool's own failure, which
a map that collects failed items would take for an item's; a decision waits before the driver admits it, so it is never
a request asked and unanswered. What a call node waited is not counted against its deadline. A pause holds the run's
process for 10 minutes, then lets it go (nothing in flight but the waits): the run stays paused, and no process is
started for it. `PATCH /runs/{run_id}` raises the cap as for an agentic run, with no follow-up turn: a waiting process
judges its step again under the new cap, and a run whose process was let go is opened again under it, resuming from its
journal, so no completed node is sent again (`resumed: true`, no `message_id`). A capped start is refused before anything is sent, as an
agentic run's is, when a model one of its nodes or `llm` calls runs on has no price here, or a decision pins an
OpenRouter Decisions model the catalog lists no price for: `409 agent_not_runnable`, each in `error.fields` with the
node's label and its fix. A step no cap fixes all the same (a spend no one knows) ends the run `failed`,
`spend_cap_reached`, in the cap's words, after the node's label.

## The faux model

`--faux MODULE` loads `MODULE` in each run's process. Its default export is called for every model request with the
transcript (`context.messages`, pi's messages) and helpers, and returns pi's assistant message:

```js
export default function reply(context, faux) {
  const asked = context.messages.filter((m) => m.role === "user").length;
  if (asked === 1) return faux.message(faux.toolCall("ask_person", { question: "Which region?" }), { stopReason: "toolUse" });
  return faux.message([faux.thinking("They answered."), faux.text("Using that region.")]);
}
```

`startServe({ faux, fauxBrowser, fauxWeb })` (the tests', not the CLI's) also names modules whose default exports give
the `browser` tool's `{ provider, driver }` in place of Browserbase's or Kernel's (pi-browser's fake backend, told the
vendor the run's plane names and the saved sign-in the run was handed: `test/fixtures/faux-browser.mjs`), `web_fetch`'s direct fetch's `{ lookup, fetchImpl }` in place of the system's resolver and
undici (a table of names and pages, `test/fixtures/faux-web.mjs`), and, as `fauxMonid`, the fetch the monid tools send
through in place of monid's API (`test/fixtures/faux-monid.mjs`). Each is honored only with `faux`.

`faux.message`, `faux.text`, `faux.thinking` and `faux.toolCall` are pi-ai's faux helpers; `faux.signal` is aborted when
the turn is stopped. A workflow's model node offers the `submit` tool (in its system message's `toolsAdded`), and
delivers its record by calling it. A module may also export `cost` (`{input, output, cacheRead, cacheWrite}` in USD per
million tokens) to price the faux usage; unpriced, every run's estimate is $0, and with `cost = "unknown"` its usage
carries no cost at all, as from a provider that does not price the model. The tests' module is
`test/fixtures/faux-model.mjs`.

## Safety

- An import (`agentrun-serve import`, and setup's import) cuts secrets out of everything it writes: the values of the
  environment's key-shaped variables and the keys saved on this server, the secrets this server made and keeps (its API
  token, its door token, its sign-in secret, and its webhook's signing secret when the seal key opens it; when it does
  not, the CLI's import says so once, on stderr, and goes on), and the keys [secretlint](https://github.com/secretlint/secretlint)'s
  recommended rules find in what it reads (Anthropic, OpenAI, GitHub, Slack and Stripe keys, AWS secret keys beside their
  name, private keys, database URLs with a password, and more). Each becomes `[redacted]`, and the import says how many
  distinct values it removed. Known key formats are removed. Other secrets in your session history, like passwords in
  config files, are imported as they are. So are a key-shaped value this server did not make (a `whsec_` secret from
  another service) and a run's own door token.
- The decision keys (`TYPESAFE_API_KEY`, `PARALLEL_API_KEY`, `OPENROUTER_API_KEY` as Jev's or OpenRouter's) are never in
  a run's environment or files: a run's process gets on a pipe of their own only those it needs, for its decision
  providers ([decision workflows](#decision-workflows)) and its web tools: Jev's (by its route) for a node that names Jev
  or none, Parallel's for a node that names Parallel or for a `web_fetch` or `web_search` that resolves to Parallel
  ([search and fetch](#search-and-fetch)), OpenRouter's for a node that names OpenRouter. A run that needs none gets no
  pipe.
- `web_fetch`'s direct fetch dials public addresses only, each hop checked and pinned (see [Tools](#tools)): a run cannot reach this
  machine, its network or a cloud's metadata address through it.
- A `browser` session runs at Browserbase or Kernel, not on this machine: a page the model opens is reached from that
  vendor's network, so what the model may reach there is the operator's choice of vendor, keys and project. Its downloads and uploads stay
  in the run's `work/`. An agent's saved sign-in stays at the vendor; this server keeps a sealed pointer to it, which a
  run's process gets over its pipe and its tools and model never see. Anyone holding the vendor's key can open that
  context or profile there.
- A run's live browser view is a full-control credential for its session: once taken over, it drives the browser. Its
  token lives in the run's process, in one 0600 file in the run's directory (never `work/`) while the session is open, and in
  the owner's answer to `GET /runs/{id}/browser`, which takes the owner's password session alone, as the hand-back does. The
  viewer's WebSocket is taken only under the run's path, from this server's own origin, with the owner's session; its page is
  framed by this server's own origin alone; outside a take-over its input is dropped by the run before the browser; the
  vendors' own live-view links never leave the run's process.
- The viewer's code always comes from this server: its page, script and style are the files of the pi-browser this server has
  installed, served under `script-src 'self'`, never anything a run's port answers. A run's port only ever carries the
  viewer's WebSocket, which is data, so whatever answers on a run's port never runs script on the console's origin.
- The owner's time in a run's browser counts toward its cap and is held before it starts: a take-over, and an agent's ask,
  hold 15 minutes of session time at the provider's price (once per session, shared by a take-over and an ask on it),
  refused in the cap's words without room. A take-over that steady input keeps alive past 15 minutes is held again every
  15 minutes; with no room the browser goes back to the agent, in the cap's words.
- It binds 127.0.0.1 by default, and there refuses a request whose `Host` names something other than this machine
  (DNS rebinding): `localhost`, `127.0.0.1`, `[::1]`, the `AGENTRUN_PUBLIC_URL` name and each `--allow-host` name are
  served, on any port, so a tunnel (`ssh -L 8080:localhost:7340`) or a proxy in front works; any other name is `403`, a
  page in a browser and a JSON error for a script, each saying which names work. On another address (`--listen`, the
  container's `0.0.0.0`) it serves every `Host` name, and the token is its only lock.
  It sends no CORS headers, so a page on another origin cannot read an answer.
- Every route but `GET /capabilities` needs `Authorization: Bearer <the token>`, compared in constant time, or the
  browser's cookie under the rules of [the console](#the-console). The console's own files (its HTML, scripts, styles
  and fonts) hold no data; everything it shows comes through those routes. It loads nothing from the network, and its
  CSP allows this origin only.
- Each run's door listens on loopback and takes only that run's own door token (`DIR/disk/agents/<agent>/runs/<id>/door-token`, 0600, made
  at its first launch); a run's process an older server started keeps the server-wide one (`DIR/.door-token`).
- A run's process gets the server's environment (the `AGENT_MODEL` variables among it) without the server's token or any
  key: no `AGENTRUN_TOKEN`, no `AGENTRUN_API_KEY`, no variable whose value is the token, and no variable named like a key
  (one of its `_`-separated segments, in any case, is `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASS`, `PAT`,
  `CREDENTIAL`, `CREDENTIALS` or `DSN`, or its last is `PWD` after another: `SERVICE_KEY`, `GITHUB_TOKEN_RO`, `DB_PASS`,
  `SENTRY_DSN`, `DB_PWD`; never `PWD` or `OLDPWD`), whether the launcher's list names it or not. The rule is
  pi-durable-disk's (`@parcha/pi-durable-disk/secret-name`), which an import's cut and a harness's log take too. The keys it
  needs come over its pipe. It gets none of the boxes' keys ([Boxes](#boxes)). A tool key reaches it only when its
  revision names a tool the key unlocks (`MONID_API_KEY` a monid tool, `BROWSERBASE_API_KEY` and `KERNEL_API_KEY` `browser`; a workflow's
  tools are those its model and call nodes name), and a model key only when its model needs it ([Models](#models)), read
  from the revision at each launch, a relaunch or a resume after a restart included.
- A variable named like a key that is not on the launcher's list (`capabilities.secrets.names`) is left out of every
  run's environment, but the launcher does not take it out of the server's: it stays in the server's own environment
  (`/proc/<pid>/environ`), which any process of the same user can read. Set only the keys the server needs where it
  starts.
- A credential a provider's SDK finds through a variable named like a key is not supported for runs: no run's
  environment holds the variable, and the SDK reads it from there alone. For Amazon Bedrock that is a web identity token
  file (`AWS_WEB_IDENTITY_TOKEN_FILE`) and a container role (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`,
  `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN` or its `_FILE`); for Vertex,
  `GOOGLE_APPLICATION_CREDENTIALS`; for Anthropic's workload federation, `ANTHROPIC_IDENTITY_TOKEN_FILE`. Bedrock's access
  keys or bearer token (held, and handed to a run on Bedrock), an `AWS_PROFILE`, `GOOGLE_CLOUD_API_KEY` or the default
  application credentials file work. A credential file a provider reads by path (`AWS_PROFILE`'s `~/.aws` files, the
  default application credentials) is the host's: a run's process reads it for its model, and its file tools cannot.
- `TYPESAFE_API_KEY` is a decision key, handed to a workflow run's decision providers on a pipe of their own and never
  with a run's other secrets, so a pi run on a `typesafe/` model does not get it: its process finds no key for that
  model, and the run fails.
- A run's file tools (`read`, `write`, `edit`) reach its own `work/`, and two places of its own beside it: `read` also
  reaches the run's `tmp/` (next to `work/`, where a command's spilled output would go), and a write may also land in a
  temporary directory the run's environment made for a tool (`createTempDir`). Every other path, a link inside `work/`
  included, is resolved and refused (`outside the workspace`), so a run reads neither the server's token, the door
  token, `store.sqlite`, another run's files (its `work/` or its `tmp/`) nor `/proc`, and writes nowhere else. This is
  pi-durable-disk's confinement inside the run's process, not an operating-system boundary: the run and the server
  share a user (one uid in the container), so the confinement holds only because the run has no shell on this machine.
- No path offers a shell on this machine. On the runner `bash` is not bound: a definition that names it is not saved
  here (`422`), one saved before that check is not runnable (`409`), and a model that calls it anyway, as an agent or as
  a workflow's model node, is answered that the tool is not available and runs nothing. In a [sandbox](#sandbox) it runs
  in the run's box, which binds the run's `work/` alone, has no network, and holds no key or token.
- Files are served from a run's `work/` and an agent's home only. A path with an empty, `.` or `..` segment, a
  backslash or a NUL is `400 invalid_file_path`; a segment that starts with `.` (the run's skills under `.agents/`) is
  `403 system_file_forbidden`; a symlink on the way is `404` (a write or a delete in a home through one, `403`). Every
  answer is `nosniff`, and HTML carries a CSP with `sandbox` and `default-src 'none'`.
- The launcher hands the server every secret on its list that is set over one pipe, which holds 4,096 bytes for sure
  before the server reads it: each set secret costs its name, its value and two bytes. Past that it refuses to start,
  saying `the secrets come to N bytes, more than the 4096 a pipe is sure to hold`, and starts nothing. A long value adds up
  fast (an AWS session token is often over 1,000 bytes): set only the keys the server needs where it starts.

### Known gaps

- The provider keys are checked against pi-ai when this package is tested, not derived when the server starts: the
  launcher's list and `PROVIDER_KEYS` match the pi-ai this package is tested with (its peer range is `*`, as Pi's
  package guidance asks). The drift test fails, naming the provider and the key, on a pi-ai that reads a key neither
  names. A pi-ai installed past that test that reads a key neither
  names would leave it in the server's environment and out of every run's, and a run on that provider would fail at
  its start for want of the key.
- The cut is by name alone. A variable named like no key whose value is one reaches a run's environment and is not cut
  from what an import or a harness's log keeps: a URL with a user and password in it (`DATABASE_URL`, `HTTPS_PROXY`),
  headers that carry a token (`OTEL_EXPORTER_OTLP_HEADERS`), or a held key's
  value under another name.
- The 4,096-byte pipe limit stays until the launcher writes the pipe from a background subshell that blocks until the
  server has read it.

## Test

```sh
npm run build -w @parcha/agentrun-dsl -w @parcha/agentrun-pi -w @parcha/pi-durable-disk -w @parcha/pi-durable-agent -w @parcha/agentrun-serve
npm test -w @parcha/agentrun-serve
```

The tests start real run processes on the faux model, both kinds: no key, no network.
