# @parcha/agentrun-serve

The AgentRun server: the process you deploy to run AgentRun, the open-source platform that supercharges your agents. `agentrun-serve` serves the `/v2` API (`agentrun.v2/0`) and the console over one store (SQLite in its data
directory, or Postgres): many agents, each with revisions written once (an agentic prompt, or an agentrun-dsl
workflow), and every run pinned to the revision it ran. Runners claim runs from that store and run them; by default one
runner starts beside the server. The capabilities document (`GET /v2/capabilities`) says what this server offers.

`npx @parcha/agentrun` starts it, with its console, on your machine; the container image runs it on a server (below).

Already use Claude Code or Codex? Choose **Connect agent** in the console and select your coding agent from the
dropdown. Its skill asks whether to connect for future jobs, import past history, or both, then confirms the source
project and machine. No destination model key is needed for this connection: a live agent uses its existing native
sign-in and configuration. Turn **Self-improving** On separately to give later runs your owner-written
corrections. Eligible server-run and SDK agents can also compile checked workflows; CLI capture has no workflow
bridge. Imported history stays historical and does not automatically train the agent.

New source connections also keep their setup in sync by default. A supported complete setup can **Move to AgentRun**
from the same agent page, retaining its identity and history. Destination accounts and unsupported tools/settings
appear as prerequisites. See [source sync and Move](../../docs/source-sync.md) for scope, project continuity,
conflicts and current compatibility; `--no-sync` opts out when connecting.

For a source on a different laptop, VM or container, choose **Connection setup → Another machine** and use the
matching [Python source connector](../../connector/README.md). Remote execution currently needs the server and
connector from the same reviewed development checkout; the published observation-only CLI does not include it.
The source worker must stay online. See [Native agents](../../docs/native-agents.md) for setup, history scopes and
runtime limits. Connected agents use ordinary agent revisions; each connection declares whether it can launch runs
and execute checked workflows. The console shows server-run and source-connected agents in one inventory, with their
actual connection and activity state. A CLI capture profile linked to a source appears with that source; an unlinked
profile remains visible. A source session is not itself a recorded run. Managed adapter isolation is unchanged.

`GET /v2/observations` also reports `learning` for each observed session: `on`, `off`, `setup_required`,
`unknown` or `unsupported`, with a reason and verified profile IDs when available. Polling sources advertise
support through `cli_learning.session_association` in `/api/v2/control/connectors/capabilities`. A source may
attach `metadata.cli_learning` after matching the exact canonical project, runtime and server origin to an
existing private CLI learning connection. Its proof binds the connector, selected source, observed session,
runtime, connection, readiness, native-session hash and sequence using that connection's scoped credential.
The receiver stores verified identifiers, never the credential or proof, and returns no source paths or native
session hashes. On requires configured hooks and an accepted hook window for that exact native session;
configuration alone is `unknown` with `awaiting_activation`. Agent and server learning settings are read live.
Missing support, invalid proofs or revoked credentials do not interrupt activity or usage reporting. Delegated
subagents report `unsupported`. Observing a session never enrolls its project or changes its learning setting.

## Quick start (no key, no network)

Node 24.22.3 or later. In a checkout of this repository:

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
Starting http://127.0.0.1:7340/ (warming: health says so and the API answers 503 until the server is ready)
agentrun-serve on http://127.0.0.1:7340/v2 (agent store in ~/.local/share/agentrun/agents)
AGENTRUN_BASE_URL=http://127.0.0.1:7340/v2
AGENTRUN_API_KEY=ar_local_...
Open http://127.0.0.1:7340/
Boxes: docker (on by default; set AGENTRUN_BOXES to change).
Set your password: http://127.0.0.1:7340/setup (the first visit sets it)
```

The `Starting` line comes as soon as the port is bound, before the server loads the rest of itself; the lines after it
come once it is ready, and `Open ` still means ready. In between, `GET /v2/health` answers `503` with `status: "warming"`,
the API answers `503 unavailable` (retryable, with a `Retry-After`), and a browser gets a page that reloads itself. On a
cold, slow disk, loading the server's modules holds the process for most of that time: a request sent then is answered
once they have loaded. A port already taken at the start is left to the start's own listen, which waits for a server it
replaces, as it always has, and prints no `Starting` line.

A Docker box's image is built on its first run, which shows that on its timeline. `npx @parcha/agentrun` prints the
`Boxes:` line on stderr, after its own line on stdout. On a machine where Docker is not running, the `Boxes:` line says so instead (`Boxes: none, so new agents run on the
runner. Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart
AgentRun.`); see [Sandbox](#sandbox).

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
| `--data DIR` | `~/.local/share/agentrun/agents` | The agent store (`DIR/store.sqlite`) and its runs (`DIR/disk/agents/<agent>/runs/<id>/`). The token is `DIR/.token`, mode 0600, made once and kept, unless `AGENTRUN_TOKEN` gives it: then a `DIR/.token` from an earlier start is removed. |
| `--listen ADDR` | `127.0.0.1` | The address to listen on. On any other, every `Host` name is served and the token is the only lock: put TLS in front of it. |
| `--port N` | the first free port from `7340` | The port. `0` is any free port. |
| `--open` | off | Open the console in this machine's browser once the server listens; not in CI, nor on Linux with no display. While the server has no owner it opens the setup page instead, with the setup code filled in when setup takes one. |
| `--faux MODULE` | none | Answer every model request from the module's default export (below). |
| `--faux-browser MODULE` | none | With `--faux` only: the `browser` tool's provider and driver from the module's default export, a fake browser with no vendor and no key ([below](#the-faux-model)). The console's real-browser tests run on it. |
| `--allow-host NAME` | none | Another `Host` name to accept on a loopback address, on any port. Repeat it. |
| `--max-runs N` | `AGENTRUN_MAX_RUNS`, else as many pi runs as fit | The most runs the runner beside the server holds at once ([capacity](#capacity-and-health)); a run past that waits `queued` until one ends. Capabilities report the same number (`limits.max_concurrent_runs`), capped by each harness's memory. |
| `--documents DIR` | `AGENTRUN_SERVE_DOCUMENTS` | A read-only directory of documents a workflow's `pdf_pages` calls read by file name, confined to it. |
| `--allow-code-nodes` | off (`AGENTRUN_SERVE_CODE_NODES=1` turns it on) | Run workflows' `code` nodes. They run in the run's process through the DSL's `new Function` transform, which is no sandbox, so only turn it on for workflows you wrote. Off, a workflow with a code node saves with a `not_set_up_here` warning and its runs are `409 agent_not_runnable` with `details.code: true`. A call `via: "shell"` or `"executor"` is refused either way. |
| `--learning on\|off` | on (`AGENTRUN_SERVE_LEARNING`) | Whether runs [learn](#learning). On, a run of an agent whose definition says `learning: true` starts from what that agent learned and adds to it; off, no run does, whatever its agent says. Any other value refuses the start. Capabilities report it as `features.learning`. |
| `--drain-timeout D` | `30s` (the image: `6s`) | How long the runner beside the server lets each busy run finish its turn when the server stops (`8s`, `500ms`, `1m`): a turn that ends within it keeps its outcome, and its model request is never sent again. A run still busy at the bound is stopped where it can resume, and the next claim carries on from its journal (that turn's model request sent again). The stop says how long it waits and for how many runs. A runner of its own (`agentrun-serve runner`) takes `--drain-timeout` too, default `AGENTRUN_DRAIN_TIMEOUT`, else `6s`. |

`AGENTRUN_TOKEN`, when set, is the token (32 characters or more), and the server prints `$AGENTRUN_TOKEN` in its
place: a token from the environment stays out of the logs. `DIR/.token`'s token is printed only by the start that made
it; a later start prints `AGENTRUN_API_KEY=<in DIR/.token>`, to read it there. With `AGENTRUN_ACCOUNTS=0` the `Open`
link carries a launch code this start made at random (`?launch=<code>`), never the token. `AGENTRUN_PUBLIC_URL`, when set, is the
address people open (a container's published port, or a proxy's URL): the printed `Open` link and `AGENTRUN_BASE_URL`
use it, and on loopback its name is also an allowed `Host`. Started with `npx @parcha/agentrun`, or as its service, pass
`--public-url https://<name>/` instead; the launcher hands the server that address as `AGENTRUN_PUBLIC_URL`
([the launcher](../agentrun/README.md)). The server remembers the public address in its data directory (`DIR/.public-url`) once a start serves; a start
that fails remembers nothing. A start where it changed,
including set where there was none or unset where there was one, writes one warning line to the log
(`event=public_url_changed from=<old> to=<new>`). The owner signs in again at the new address, because the session
cookie belongs to the old host, and links in earlier webhook messages still name the old address. When the old name
still reaches this server and it has a new public address, a browser that opens the console at the old name gets a 308
redirect to the new address. The browser keeps the link's `#/runs/<id>` part across the redirect, and the redirect is
`no-store`, so a browser does not keep it if the address changes back. On a loopback listener, everything else under
the old name stays refused: the API and webhooks get a 403 `forbidden` that names the new address, and another browser
page gets a page that links to it. Every other name is refused as before. `AGENTRUN_FREE_MODEL_REQUESTS` (default 60) is the most requests on free models a run makes
([a limit on free requests](#a-limit-on-free-requests)).

`AGENTRUN_TOKENS`, when set, is a list of more tokens, each with an id: `id:secret` entries separated by commas or
whitespace (each secret follows the token's rules, and holds no comma). `AGENTRUN_TOKEN`'s token is the entry `default`;
set alone, the list takes `DIR/.token`'s place, and its first entry is the server's token. Any token on the list opens
every route the token opens (`/v2`, `/mcp`, the setup code's field), and each presented token is compared against every
entry in constant time. Each request line names the id of the token used (`token=<id>`), or `session=owner` or
`session=console` for the console's own requests, never a secret. The banner lists the ids when there is more than one.
An id or a secret given twice, or an entry that is not `id:secret`, stops the start. The list is a secret like the token:
the launcher hands it over its pipe, and no run's process or runner loop gets it. A rotation adds the new token, moves
callers, then removes the old one ([deploy/README.md](../../deploy/README.md#rotating-the-api-token)).

## Sandbox in 60 seconds

An agent with a shell, in a Docker container of its own: on a machine with Docker, in a checkout built as above, with
a model key. Start the server; the Docker box is on by default wherever Docker answers:

```sh
export AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5 OPENROUTER_API_KEY=...
node packages/serve/dist/cli.js
```

Its log says `event=boxes available=docker`, and its banner's last line reads `Boxes: docker (on by default; set
AGENTRUN_BOXES to change). docker boxes reach only pypi.org, files.pythonhosted.org, registry.npmjs.org, registry.yarnpkg.com,
github.com, and codeload.github.com.` on Linux; elsewhere it says why the box has no
network ([Sandbox](#sandbox)). The first sandbox run builds [the box's image](#the-boxs-image) (python 3.12, git, curl, node, npm and rg,
about 300 MB, a minute or two, the build alone on the network), with a row on its timeline saying so; a later run finds
it built. In a second shell, export the two `AGENTRUN_` lines it printed (a later start prints
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
`wrong_launch_code`, `wrong_password`, `sign_in_table_full`), never the token given nor any part of it. `AGENTRUN_LOG=quiet` leaves out the request lines; the
run and `auth_failed` lines stay. A run whose process failed at its start says why in its `error.message`, in words.
One line at start, `event=boxes`, says which boxes this server has ([Sandbox](#sandbox)); quiet keeps it too.
`event=harness_offers why=start ms=<n>` says how long the server took to check what each harness offers (each CLI's
package and pins; [harnesses](#harnesses)), the bulk of its start; quiet keeps it too. It is made at the start only: a
PUT of `/settings/tools` and a save or delete of a tool key change no harness's offer, so they remake capabilities at
once without checking again (a key some harness reads would, with `why=key`).
`event=cost_heal read=<n> healed=<n> failed=<n>` says, once after the start, what the start's sweep did: the ended runs
whose stored cost was unknown that it read, those whose priced booking it wrote back, and those it could not read (each
heals on its next read). The rest stay unknown: a charge of no known cost, or a booking with no request to read. It
names no run, and a store with no such run says nothing; quiet keeps it too.

## Anonymous usage counts

The server sends six anonymous events: `server_started`, a daily `heartbeat`, `first_run_completed`, and, for
suggested agents, `suggestions_scanned`, `suggestion_discarded` and `suggested_agent_created`. Each holds a random id
kept in the data directory (`.telemetry.json`), the version, the platform and how many runs ended as a range; never a
prompt, a file, a key, a name or a repository.
`AGENTRUN_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off, as do `CI`, a test runner (`node --test`) and `--faux`; `AGENTRUN_TELEMETRY=debug` prints each
event on stderr and sends none. The start that first could send prints one notice and sends nothing at that start.
[docs/telemetry.md](../../docs/telemetry.md) lists every field.

## In a container

The image is public: `ghcr.io/parcha-ai/agentrun-server` (`:beta`, or an exact version such as `:v0.1.0-beta.27`).
`compose.yaml` at the repository's root is the one way to run it: the server, its data on a named volume, and the host's
Docker socket, so each run's Docker sandbox is a container beside the server's, its run's folder mounted from that
volume ([in the published image](#in-the-published-image)). It takes Docker Engine 26 or later, which mounts a
volume's subpath.

1. Start it (below). It needs no model key.
2. Open the console and set your password.
3. Continue with ChatGPT (Settings → Model keys, or the first screen), then run your first agent. Or add a model key
   there instead ([on a ChatGPT plan](#on-a-chatgpt-plan)).
4. Sign in with your password on any browser; the token in the log stays for scripts and the CLI.

On a fresh server with no `AGENTRUN_PUBLIC_URL`, whoever reaches the console first sets the password, so set it right after
the start, before the port is reachable by anyone else. With `AGENTRUN_PUBLIC_URL` set, the setup code the server
prints still guards it.

On a Linux host with Docker Engine 26 or later, with no checkout:

```sh
curl -fsSLO https://raw.githubusercontent.com/Parcha-ai/agentrun/main/compose.yaml
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env
echo "AGENTRUN_SEAL_KEY=$(openssl rand -base64 32)" >> .env && chmod 600 .env   # once; keep it
docker compose up -d
docker compose logs agentrun | grep Open
```

For a model key as well, save it in the console, or export it before `docker compose up`:

```sh
export AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5 OPENROUTER_API_KEY=...
```

The `.env` beside `compose.yaml` keeps the socket's group (`DOCKER_GID`) for every later `docker compose` command, in any
shell: compose reads it each time, and `compose.yaml` needs it to be read at all.

This `compose.yaml` passes `AGENTRUN_SEAL_KEY` from the `.env` to the server and refuses to start without it, so the key that
seals every saved key, MCP credential and sign-in is kept outside the container and the data volume. Keep that `.env`
line. A store whose secrets were sealed with another key refuses to start, and the server never makes a new key over
sealed secrets, so a lost key is not replaced: recreating the container with the same key opens the store as before.

From a checkout, the same command in its root, with `--build` to build the image from it.
`packages/serve/docker/Dockerfile` builds that image: the server and the open packages it runs, on Node 24.22.3 and Debian 13
(trixie), with git 2.47 for an agent's learning folder and the Docker client. Everything it keeps is under `/data`: the agent store,
the runs and the token.

The image's default command, `server-and-runner --data /data --listen 0.0.0.0 --port 7340 --drain-timeout 6s`, starts
two processes in the container: the server with `--no-runner`, and one runner on the same `/data` once the server answers
`GET /v2/health`. Each has its own store connection, so a busy runner never holds up the API. If either exits, the other
stops and the container exits non-zero. Give the image other arguments and it runs that one command, as given:
`runner --data /data --name runner-1` is a runner, and server options alone (no `server-and-runner`) are a server with
its runner in its own process, which a [paired computer](#a-persons-own-computer) needs.

A computer provider whose machines dial the server (Fly Machines and Cloudflare; the computer package's `connectOf`,
which also says dial for E2B, Daytona or Modal made with `connect: "dial"`) works under a runner apart that knows the
server's public address, `AGENTRUN_PUBLIC_URL` (the image gives both processes the same environment). The machine dials
the server, and the server relays its socket to the runner that made it: the runner keeps its own attach hub on a
private listener (loopback; across hosts, its `AGENTRUN_RUNNER_LIVE_HOST`, which the server's `AGENTRUN_RUNNER_HOSTS`
must list; runners that are replicas with no host name of their own give both an IPv4 block instead, below), and the server reaches it only with a proof under the seal key for that machine's token, that runner and a
time within 10 seconds, taken once. A dial it cannot relay (its runner gone, not answering, or restarted since) is
answered 503 in words that name the run, `a dial for run <run> (machine <machine>)`, and never the machine's token. The
runner's create, waiting for that machine, ends at once in the same words and deletes it; the run makes a new machine at
its next claim. A runner apart with no public address refuses such a create, naming the fix above,
and the server says it sooner: in `GET /v2/computers`, each dial provider's row carries `runs_refused` with that fix,
and its Test connection in Settings → Computers fails in the same words. With a runner that relays, `runs_refused` is
null.

The token is in the log of the start that made it. A `docker stop` reaches both processes. The runner gives a busy run
6 s (`--drain-timeout 6s`) to finish its turn, so a busy `docker stop` ends in about 7.5 s, inside Docker's default 10 s
grace, and Compose's `stop_grace_period` is 15 s; a turn cut off resumes at the next start. Compose publishes the port
on this machine's loopback only (port 7340, or `AGENTRUN_PORT`; set `AGENTRUN_PUBLIC_URL` with it, so the printed link names that port), and
the volume `agentrun-data` keeps `/data` across `down` and `up`. In the container the server listens on `0.0.0.0`, so
setup takes the code the start prints (`Set up this server: <url>/setup#code=<code>`), and every route but `GET /v2/capabilities` and `GET /v2/health` still needs the token. Compose's `healthcheck` and
`render.yaml`'s `healthCheckPath` are `GET /v2/health`.

`render.yaml` at the repository's root is a Render blueprint for the same image: one web service on the 1 CPU / 2 GB plan with a 10 GB disk at
`/data`. Render generates `AGENTRUN_TOKEN`, which scripts and the CLI read in the service's Environment tab, and
`AGENTRUN_SEAL_KEY`, which seals the keys, MCP server credentials and webhook trigger secrets the server saves (keep a
copy: a service that loses it loses them). With no
`AGENTRUN_PUBLIC_URL` the server takes Render's own `RENDER_EXTERNAL_URL` as its public address, so setup takes
`AGENTRUN_TOKEN` from the Environment tab, or the code the start prints in the service's log (`Set up this server: ...`). On another host, set `AGENTRUN_PUBLIC_URL` to
the address people open before the first start; without it, whoever opens the console first sets the password. Set
`AGENT_MODEL` and the provider's key there too. Render waits 30 s after SIGTERM, above the image's 6 s drain; it does not
let a service with a disk change that. It sets `AGENTRUN_RUN_USER=same` (every run as the server's own user, each still
a process of its own), as Railway's template does: neither platform has been shown to keep the image helper's file
capabilities.

A runner that refuses to claim (its run isolation refused: an `AGENTRUN_RUN_USER` it does not know, or a helper that
can't switch users) stays up and says so in the store. While every runner there has refused, and one at least is there,
the server refuses a run's start, and a message to a run, with 503 `runner_refused` in the runner's words and their fix;
`GET /v2/capabilities` has them in `runner_refused` (null otherwise); `GET /v2/health` answers 200 `degraded`, its
`runner` check `refused` and the words in `runner_refused`, so a platform's health check never restarts the service over
a setting; and a run already queued ends `failed` with error code `runner_refused`. A run a runner claimed is left to it.
A server with `--no-runner` and no runner started yet refuses nothing: runs queue for the runner to come. Once a runner
that can claim is there, the refusal is gone.

## The disk, and earlier data directories

The data directory has two parts. Its own files, the control plane, hold the agent store (`DIR/store.sqlite`, where
each run's row keeps its claim: an epoch and its holder), the token and the server's settings; only the server and its
runners open them. Everything the agents make is on the disk, `DIR/disk/`: one folder per agent, `DIR/disk/agents/<agent>/` (its id
in lower case, a dash and 16 hex digits of its SHA-256), with its learning folder (`learning/`) and its runs
(`runs/<id>/`, each with `work/`, where its tools work). Nothing is copied in or out of a run's folder: where it
works, it works in that folder. A run's record is not in its folder: its row, its claim and its journal (what the run
did, in order) are rows of the store.

A data directory an earlier version wrote, with its runs under `DIR/runs/` (or a store of store version 1), is refused
at start, saying so: this version neither reads nor moves it. Keep it with that version, or start this one on a new data
directory (an empty folder, or a new volume).

When a run's folder is on the owner's Archil disk and the run has no computer, a command runs through Archil's
serverless exec, for at most 295 s. A known limit: a command, once sent, cannot be stopped. Stopping the call answers at
once, but the command runs on to its own deadline, and the run's next command, or a write to its folder, waits until it
has ended. A command not yet sent when the call is stopped is never sent.

## Upgrading from 0.1.0-beta.26

0.1.0-beta.27 keeps every agent in one store, `DIR/store.sqlite`, with its revisions (and this version also keeps each run
on the disk, above).
0.1.0-beta.26 and earlier kept one agent home per agent, `DIR/<agent>/agent.sqlite`, and this version does not read
those. So it refuses to start on a data directory that holds one, and names each home it found, instead of serving
it as if it had no agents.

To keep those agents and their runs, keep the earlier version on that data directory. To start this version, give it a
new data directory (a new volume), or move the old homes out of the one you have. Then create the agents again, here or
through `POST /v2/agents`. Their earlier runs stay readable where you moved them, with the earlier version.

## Capacity and health

A run is held by a runner, and how much memory it takes depends on its harness. Capabilities size what a host holds by
memory: each run reserves its harness's size out of the container's limit when it has one (cgroup), else the machine's,
less the server's own 128 MiB. The server does not refuse a start for memory: a start inserts a `queued` run, and a
runner claims it when it has a free loop (300 at once by default; `agentrun-serve runner --loops N` sets it for a
runner you start yourself).

| Harness | Reserved per run | Measured per run |
| --- | --- | --- |
| pi | 128 MiB | up to 106 MB |
| codex | 192 MiB | up to 143 MB |
| claude-agent | 288 MiB | up to 215 MB |
| opencode | 704 MiB | up to 524 MB |

The measure is a short task (write a file, read it back, answer) on a real server in a container of its own; the table
in `src/harness.ts` says how it was taken. So a 512 MB instance holds 3 pi runs, 2 codex runs or 1 claude-agent run at
once (or 1 codex and 1 pi), 1 GB holds 7, 4 or 3, and 8 GB 63, 42 or 28; an opencode run, OpenCode's own process with
it, needs a 1 GB instance for one and 2 GB for two. A runner holds runs by this memory and by `--max-runs` (below): it
claims a waiting run only while the runs it holds and that run's size fit the host's memory less the server's 128 MB,
oldest first, so a run that does not fit yet waits `queued`, the runs behind it too, until one ends. A run is never
refused for a place. A 2 GB host's default count is 15, as many pi runs as fit, but it holds 6 claude-agent runs at
once, not 15. A harness whose one run
needs more than all the memory for runs (claude-agent on a host under 416 MB, opencode under 832 MB) is unavailable:
capabilities say why in its `harnesses` entry. pi always has one place, however small the host.

`--max-runs N` or `AGENTRUN_MAX_RUNS` sets that count (by default, as many as pi runs fit): the runner beside the
server claims at most that many runs at once, of any harness, and the rest wait queued. A runner of its own
(`agentrun-serve runner`) holds `--loops N`, else the same default. Capabilities report it: pi's in
`limits.max_concurrent_runs`, and each harness's own, the lower of that and what its memory holds, in its `harnesses`
entry (`max_concurrent_runs`, beside `run_memory_mib`).

A data directory serves one AgentRun Server at a time: a second server on the same data root is refused at start
(`server.lock`).

`GET /v2/capacity`, with the token, says how much room the runners have, read from the store alone. A server with no
runner beside it (`--no-runner`, `AGENTRUN_API_ONLY=1`) answers it for every runner on its store. Read it to size the
runners by backlog, not by CPU. It gives:

- `runs.queued`: the runs waiting for a runner now. These are queued runs, runs handed back or whose claim ran out (past
  any backoff), and parked runs with something to wake them.
- `runs.executing`: the runs a live claim holds now, on any runner.
- `runners`: each runner that said it was there in the last 30 s, by name. Each has its build's `version`, its `slots`
  (the most runs it holds at once), what it holds (`executing`), its `free_slots` and whether it `refused` to claim.
  `version` and `slots` are null for a runner of an earlier build that is still running. (On Postgres, an earlier
  runner refuses to start once the server has applied `0024_runner_capacity.sql`, so upgrade runners with the server.)
  A runner also claims by its host's memory, so a free
  slot is the most it may take.
- `free_slots`: the sum of the live runners' free slots.
- `hand_backs`: how many runs a runner gave back still running within `?window=` minutes (1 to 1440, default 15). A
  drain, a loop that closed itself and a claim given back each count; a claim whose lease ran out does not.

It names no run, agent or address. Each runner also prints metric lines in the server's log format, which a log-based
metric counts: `runner_claimed` (`took_over=1` when it took over a run whose lease ran out), `runner_hand_back` with its
`cause` (`drain`, `interrupted`, `end_retry`, `give_back`, or `claim_lost` with its `why`), `runner_drained` once per close
that held a run (`ms`, `held`, `left`), and `runner_gauge` every minute (`active`, `slots`, `rss_mib`).

`GET /v2/health`, with no credential like capabilities, answers `200 {status: "ok", checks: {store: "ok", disk: "ok"}}`
when the agent store opens for a read and the data directory's disk has at least 64 MiB free (`AGENTRUN_MIN_FREE_MB`),
and `503` with `status: "failing"` and which check failed (`store: "does_not_open"`, `disk: "below_floor"`, or
`disk: "cannot_check"` when the free space cannot be read) otherwise. While the server is still starting it answers `503`
with `status: "warming"` and `store: "opening"`.
It names no path, size or version. One route serves as both liveness and readiness: any answer says the server is up,
and a 200 says it can work, and the platforms here take one path.

A run's runner renews its claim on the run every 10 s, for a claim of 30 s. A runner that stops, or cannot renew in
time, writes nothing more to the run, and the store refuses any write under a claim the run has moved past. Once the
claim lapses another runner claims the run and resumes it from its journal. A run's own computer doesn't survive a
runner loss, a crash, a server stop or a park (the claim that resumes the run starts a new one, and says so on the
timeline and, once, to the model as an "AgentRun server note"), and the agent's own computer, a persistent setting, does. `agentrun-serve runner --check --data DIR --name N`
(or `AGENTRUN_RUNNER_NAME=N` in place of `--name`) checks the runner's environment by name (its store, its seal key,
every run-facing name its server holds, a forwarder on loopback) and whether the runner named `N` has a fresh
heartbeat: it exits 0 when both hold, 1 when either does not, and 2 when no name is given. `--check --env` checks the
environment alone, and `--check --heartbeat` the heartbeat alone ([deploy/README.md](../../deploy/README.md#the-runners-environment-runner---check)). Name a runner you start yourself with
`agentrun-serve runner --data DIR --name N`.

## Start-time switches

Some of what the server reaches is set only by its operator, in its environment when it starts. No route and no console
page sets these, so no caller of the API can widen what the server reaches; each takes a restart. A refusal one of them
causes names the variable, the value that allows it and the restart (`restart the server with
AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1 to allow it, only on a machine you alone use`), with its usual error code.
`GET /v2/capabilities` lists them under `switches`, each with `on`, the `value` the server read and what it `allows`.

| Variable | What it allows | Default | Why at the start only |
| --- | --- | --- | --- |
| `AGENTRUN_MCP_ALLOW_LOOPBACK=1` | An MCP server on this machine's loopback ([MCP servers](#mcp-servers)) | off | Loopback is this machine's other services too: set it only on a machine you alone use |
| `AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` | The outbound webhook to a private network or this machine ([Webhooks](#webhooks)) | off | Whoever may set the webhook could make the server POST inside its network: only on a machine you alone use |
| `AGENTRUN_PRIVATE_HOSTS` | Bounds the private-network hosts an owner may allow an MCP server or a calendar on (Settings → MCP servers): `none` allows none (and only an empty list can be saved), or a comma list of address ranges (`10.20.0.0/16,fd12:3456::/32`) every listed host's address must also fall in. Loopback, link-local (cloud metadata) and this machine's addresses stay refused whatever it says. A value that is neither reads as `none` | unset: the owner's list holds | On a server or runner many customers share, an owner's list would reach the operator's own private network: set `none` there, on the server and on each runner (each process holds to its own) |
| `AGENTRUN_BOX_ALLOW` | The hosts a run's computer may reach: a comma list, or `none` ([A run in a Docker box](#a-run-in-a-docker-box)) | the package registries and GitHub | A run's network is the operator's policy, not a caller's |
| `AGENTRUN_BOX_CPUS`, `AGENTRUN_BOX_MEMORY`, `AGENTRUN_BOX_PIDS` | A Docker computer's size ([Computers](#computers)) | 2 CPUs, 4 GiB, 1,024 processes | The machine's capacity is the operator's |

On a server the installer runs as a service, `agentrun service install --env AGENTRUN_MCP_ALLOW_LOOPBACK=1 --env
AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` saves the two yes-or-no switches in the service and restarts it; `--env KEY=` takes
one off.

## Sandbox

A sandbox agent's `bash` runs in a box, a machine apart from this server. Docker is the default box and the only one offered
with no setup: a Docker container made for each run, which binds the run's `work/` and nothing else. A Daytona or Modal box
runs on a computer from that provider, offered once `AGENTRUN_BOXES` lists it and the keys its computer provider needs are
set (the environment, or Settings → Computers). No box holds a key. A Docker box on Linux reaches the package registries
and GitHub through a proxy, and nothing else; so does a Daytona or Modal box, through the egress proxy its computer's
init starts, and capabilities say so in its `places.boxes` entry. Its `read`, `write` and `edit` work on that same `work/`: on this server, where the box binds it and this server
holds directory handles (Docker on Linux), else in the box. The agent's loop, its log, its model calls and every key stay
on the server. An agent says so in its [place](#place); the server says which boxes it has (`places.boxes` in its capabilities); [a run in a Docker
box](#a-run-in-a-docker-box) is what the container gets; [the box's image](#the-boxs-image) is what it starts from.
[Sandbox in 60 seconds](#sandbox-in-60-seconds) is all of it
end to end. The [published image](#in-the-published-image) hosts Docker boxes through the host's Docker socket.

### Place

A definition may name where its runs execute: `{"mode": "runner"}` or `{"mode": "sandbox", "box": ...}`, the box one of
the providers under [Computers](#computers). `place` is the v2 view of the agent's computer setting: `runner` is kind
`none`, and `sandbox` a sandbox on that provider. On the runner a run has no shell where its folder is on this
server's disk (Mode 1), and `bash` on Archil's serverless exec where it is on Archil (Mode 2)
([where `bash` runs](#computers)). In a sandbox the agent's `bash` runs in the named box and its
file tools (`read`, `write`, `edit`) work on the `work/` the box has ([a run in a Docker box](#a-run-in-a-docker-box)),
while the agent's loop, its log and every key stay on the server, whatever its harness. Any other shape is `422 input_invalid` on `definition.place`, whose `fix` is the change to make: the field to
remove, or the place it most likely meant, to copy (`"place": {"mode": "sandbox", "box": "docker"}`). One that names a
place keeps it, `runner` included. An edit that names no place keeps the agent's.

The box is a new agent's default machine for a shell. A new agentic agent whose definition names no place and no `tools`
is saved in the Docker box (`{"mode": "sandbox", "box": "docker"}`) wherever this server has docker, with `["bash",
"bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]`, so the agent has a shell and can run a
command in the background ([background processes](#background-processes)). The place is written on the agent's first
revision, so its answers show it. A definition that names its tools keeps exactly those, an empty list included, and
gets the box only when one of them runs only there (`bash` or a background tool). One whose tools need no shell (`[]`,
or `read`, `write`, `web_fetch` and the like) is saved with no place and runs on the runner, so its first run starts at
once instead of waiting on a container. Where docker is unavailable, a new agent is saved with no place. So is one whose
tools name one the box refuses (`browser`, runner-only for now). A workflow is never given a box.

`capabilities.places.default_place` is the place a new agent with a shell gets here, and where a revision that names no
place and has a shell tool runs. It is worked out again at each run, the same way as at create: an agentic revision with
no place and a shell tool runs in the Docker box wherever this server has docker now, and on the runner where it does
not. A workflow, a revision whose tools need no shell, and one whose tools name one the box refuses run on the runner. A save checks a revision with no place against where it would run, so `bash`
with no place saves where docker is there and is `422` where it is not. When that is the runner,
`default_reason` says why in docker's own words, such as `new agents run on the runner, because the docker box is
unavailable here: Docker isn't running on this machine (no docker command on PATH): install or start Docker, then
restart AgentRun`. The console's new-agent form says docker's reason too, under its place picker. The console's new-agent form starts on `default_place`, with bash ticked when that place is a sandbox.
What a person picks or unticks there is what is sent.

A run runs in its revision's place, else where `default_place` says at that run (a workflow, a revision whose tools need
no shell, and one whose tools name one the box refuses, on the runner). A run request names no place: `POST /agents/{id}/runs`
with `place` is `422 input_invalid`, as with any field the body does not keep. The run keeps the place it resolved to,
and `GET /v2/runs/{id}` shows it as `place`. A harness's own tools in the box, when they come, will be an option of
`sandbox` (such as `native_tools: true`), never a third mode.

`bash` may be named only by an agentic definition whose place is a sandbox (`422` on a runner, named or by default, with
the sandbox place as its `fix`), or, in Mode 2, by one on the runner, where `bash` runs on Archil's serverless exec
([where `bash` runs](#computers)); the background tools run in a box alone, in either mode. A workflow's place is `runner`
or none (`422` on a sandbox, with the runner place as its `fix`). In `capabilities.tools`, `bash` is `available: false`
with a `reason` (`no box is set up on this server: …`, each box's own reason) when no box this server has can run it and
the server is in Mode 1.

`GET /v2/capabilities` lists `places`: the modes, the default, a new agent's place, and each box with `available`, its `state` (`ready` or
`unavailable`) and, when it is unavailable, the `reason`.
A definition naming a box this server does not have saves with a warning on `definition.place`, and a run of it is
`409 agent_not_runnable` with `details.box`. `GET /v2/openapi.json` marks `definition.place`, the run's `place` and
`capabilities.places` `x-agentrun-serve: "place/1"`, `default_reason` `"place/3"`, and `default_place` `"place/4"`
(it replaced `places.default`).

### A run in a Docker box

With docker on (by default, when `AGENTRUN_BOXES` is not set; or listed in it) and a Docker daemon this server's user
may use, a run whose place is
`{"mode": "sandbox", "box": "docker"}` gets one container, made when a runner takes the run, before its first model
request, whatever tools it calls. Those four tools are pi's own, on every harness. `bash` runs in the container. `read`, `write` and `edit`
run on this server, on the `work/` the container binds, because a `docker exec` costs half a second or more per call:
they follow no link anywhere on the way (one pointing inside `work/` included), take only a regular file with one hard
link, and write through a temporary file renamed over the old one, keeping its mode (a new file is `0644`). A refusal
says so and names the box's path; `bash`, in the container, can still reach the file. Where this server reaches
directories by path (no `/proc/self/fd`, as on macOS), or a box binds nothing, all four run in the container.
`web_fetch`, `web_search` and monid's endpoints stay on this server, and so do
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
  was: no proxy, no network at all ([start-time switches](#start-time-switches)). `*`, an address or a CIDR refuses the start.
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
    is `node:22.23.5-trixie-slim` pinned by digest, with the kernel's two proxy files and a short entry bound read-only from
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
  --cpu-quota 200000 --memory 4096m --memory-swap 4096m --pids-limit 1024`), so a runaway build or a fork bomb stops in
  the box. `AGENTRUN_BOX_CPUS`, `AGENTRUN_BOX_MEMORY` and `AGENTRUN_BOX_PIDS` change them, for Docker computers only
  ([a Docker computer's size](#computers); [start-time switches](#start-time-switches)). `AGENTRUN_BOX_CPUS` caps CPU
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

### The box's image

A Docker box's computer starts from the computer package's own image by default: python 3.12 (`python:3.12-slim`,
pinned by its digest) with git, curl, node and npm, rg and `socat` (the relay to the computer's egress proxy), about
360 MB. Its recipe is `DOCKER_RECIPE` in `packages/computer/src/docker/image.ts`. The Docker provider builds it on the
first run that needs it, tags it with the recipe's hash (`agentrun-computer:<12 hex>`) and labels it with the whole hash
(`agentrun.computer.recipe`), and builds again only when the recipe changes; the run waiting on the build shows it on its
timeline. Nothing is built or pulled at the server's start. Images of older recipes stay until you remove them:
`docker image ls --filter label=agentrun.computer.recipe` lists them. An `agentrun-box:*` image an earlier server built
is used by nothing: `docker image rm` it.

A box reaches its package registries, so `pip install` and `npm install` work in it, but not `apt-get`: the box runs as
this server's user, with no root. For other tools, name another image in `AGENTRUN_DOCKER_IMAGE`: the provider then pulls
it on the first run that needs it, and builds nothing. This image is the Docker box's alone: a box on another provider
starts from that provider's own.

```sh
AGENTRUN_DOCKER_IMAGE=python:3.12-bookworm AGENTRUN_BOXES=docker node packages/serve/dist/cli.js
```

`python:3.12-bookworm` adds compilers and the build tools of Debian's `buildpack-deps`. To bring your own, build one
`FROM` the base you want, tag it, and name the tag. An image based on Debian has what a box needs to run commands:
`sh`, `sleep` and `setsid`, and `bash` for the `bash` tool when there is one (else `sh`). The image's own entrypoint
never runs; the box's first process is a `sleep` of its lifetime.

**The media image.** For an agent that makes video, the computer package keeps a second recipe,
`packages/computer/media/Dockerfile`: the default image's base, by the same digest, and its programs, plus Node 24 from
its official tarball (each architecture's sha256 checked), Chromium (also on PATH as `chrome`), FFmpeg and FFprobe,
Noto (with CJK and colour emoji), Liberation and DejaVu fonts, and the [HyperFrames](https://github.com/heygen-com/hyperframes)
CLI at an exact version. On amd64 it also has the `chrome-headless-shell` build that CLI pins, by sha256, so a render
needs no download. The CLI's usage reports and update check are off unless a command turns them on. Nothing builds it for
you, and no agent setting picks it: build it, then name its tag in `AGENTRUN_DOCKER_IMAGE`. From the repository's root:

```sh
tag=agentrun-media:$(sha256sum packages/computer/media/Dockerfile | cut -c1-12)
docker build -t "$tag" - < packages/computer/media/Dockerfile
AGENTRUN_DOCKER_IMAGE=$tag AGENTRUN_BOXES=docker node packages/serve/dist/cli.js
```

The tag is the recipe's hash, so an edit to the recipe is a new tag, and a tag already on this machine is used as it is
(nothing is pulled). Its Debian packages come from snapshot.debian.org (over https) at one instant, and the CLI's npm
dependencies from the registry as it stood at that instant (by date, not by content), so two builds of one tag install
the same Debian packages. It is about 2.7 GB on disk. An agent that needs it says so with
[`computer.needs`](#computers), so a server on another image fails its runs in words instead of running them.

**The documents image.** For an agent that writes decks, documents and sheets, `packages/computer/documents` is the
default image plus the Python and Node libraries that write Office files (python-pptx, python-docx and openpyxl for
`python3`; pptxgenjs, docx and exceljs for `node`), pinned as its header says. The Node libraries are linked as
`/node_modules`, so a script in any folder requires or imports them. The libraries are the folder's
`documents.sh`, the one layer both builds run. Build it and name its tag in `AGENTRUN_DOCKER_IMAGE`:

```sh
tag=agentrun-documents:$(cat packages/computer/documents/Dockerfile packages/computer/documents/documents.sh | sha256sum | cut -c1-12)
docker build -t "$tag" packages/computer/documents
AGENTRUN_DOCKER_IMAGE=$tag AGENTRUN_BOXES=docker node packages/serve/dist/cli.js
```

On Daytona, `python3 packages/computer/box/build-daytona.py --documents` builds the box
image with the same layer on top as the snapshot `agentrun-documents-<hash>` (the box recipe's snapshot,
`agentrun-box-<hash>`, is unchanged); name it in `AGENTRUN_DAYTONA_SNAPSHOT`. An agent that needs them says so in
`computer.needs` (`["python-pptx", "pptxgenjs"]`), and a box without them ends its runs before any model request; on
Docker, the words name this image's build. Neither is published, and no agent setting picks one: a server's Docker image, or its
Daytona snapshot, is one for every agent.

### In the published image

The published image, `ghcr.io/parcha-ai/agentrun-server`, runs Docker sandboxes on the Docker of the host it runs on,
through that Docker's socket, as `compose.yaml` at the repository's root starts it ([in a container](#in-a-container)). The image
has the Docker client (Debian's `docker-cli`) and no daemon; `group_add` gives the image's `node` user the socket's group
(`DOCKER_GID`), so the server never runs as root.

- **The socket is root on the host.** Whatever can reach `/var/run/docker.sock` can start a privileged container and do
  anything on the host: the server, and every run's process it starts, since a run makes its own box. It is the same
  trust as a server on a host whose user is in the `docker` group. Give the server the socket only where you would give
  it root. A box never gets it.
- **A box is a container beside the server's.** It is made as on a Linux host (`--network none`, every capability dropped,
  no new privileges, the server's uid, the box limits).
- **Its files.** The daemon has none of the server's paths, only what it mounted into the server's container. At its
  start the server reads its own container's id from `/proc/self/mountinfo`, asks Docker for that container's mounts
  (`docker inspect`), and takes the named volume that holds the data directory. A run's sandbox mounts that run's folder
  from it, and the sandbox's own daemon (copied to `<volume mount>/.agentrun/computerd`, read-only), as the volume's
  subpaths (`--mount type=volume,...,volume-subpath=...`), never the rest. The run's files and the sandbox's are the same
  files, as on a host.
- **The host's own addresses.** A sandbox's egress proxy refuses the Docker host's own addresses, which the server in a
  container can't see on its interfaces. At its start it reads them once through the socket: one container on the
  host's network (`--network host`, with `host.docker.internal` added for Docker Desktop and OrbStack, whose listing is
  the VM's), from the proxy's own image, as nobody (`65534:65534`), every capability dropped, no new privileges, a
  read-only root, 64 MiB and 32 processes, removed at its exit, bounded to 60 s. To those it adds
  `AGENTRUN_DOCKER_HOST_ADDRESSES` (a comma list of IP addresses, checked at the start), for what no interface shows,
  such as a NAT'd or elastic public address. The union is in capabilities' docker entry (`host_addresses`) and the
  `event=docker_host_addresses` line. With none known under an allow-list (the read failed, nothing set), docker is
  unavailable at the start, saying so and naming the setting or `AGENTRUN_BOX_ALLOW=none`; under `none` nothing is read.
- **Any other layout** (the data directory not on a read-write named volume of the server's own container, the socket of
  another Docker than the one that runs the server, a container whose id `/proc/self/mountinfo` does not name) makes
  docker unavailable at the start, its reason in capabilities and the `event=box_paths` line: `run AgentRun in a
  container with docker compose up from compose.yaml (its named data volume is how boxes reach a run's files)`. On an
  older engine: `Docker Engine <26 can't mount a named volume's subpath: upgrade to Docker 26+`. A daemon of another
  machine makes it unavailable too, whether `DOCKER_HOST` names it or the current Docker context does (`DOCKER_CONTEXT`,
  else the saved current one, read once with `docker context inspect`): that daemon has none of this machine's paths.
  Another machine's is `ssh://`, or `tcp://` to a host that isn't loopback; `unix://`, `npipe://` (Docker Desktop on
  Windows) and `tcp://` to loopback are this machine's. An agent that
  names a Docker computer is refused at its run's start in those words, and one with no computer runs on the runner,
  with the file tools and no shell.
- On a host the server finds no container of its own and asks Docker nothing: a box binds this machine's paths and its
  proxy's directory is under `/tmp`, as before.
- **ffmpeg.** The image has an `ffmpeg` built for the screen recorder alone, which records an agent's screen where its
  computer says `record: true` ([A video of each run](#computers)): one static binary of about 6 MB that reads PNG and
  JPEG frames and writes H.264 in MP4, and nothing else. FFmpeg 9.0.2 with x264, so it is GPL, as Debian's ffmpeg is;
  the licence files are in `/usr/local/share/doc/ffmpeg`.

<a id="boxes"></a>

### Computers

An agent's computer is one setting, `computer: {kind, provider}` in its definition, set in the console under
Settings → Computers. The kind says what the agent is given, and the provider who runs it:

| Kind | What the agent gets | Providers |
|---|---|---|
| `none` | The run's folder alone: no computer, and no provider (`{"kind": "none"}`) | |
| `sandbox` | A Linux shell, with files and processes | `docker`, `daytona`, `modal`, `e2b`, `boxd`, `smolcloud`, `groundbox`, `cloudflare` (through a relay Worker you deploy) |
| `desktop` | The computer's tools (`computer_observe`, `computer_act`, `computer_screenshot`), the computer as `codemode`'s `computer`, and a shell where its provider mounts the run's folder | `docker` (with an image that has an X server), `e2b`, `orgo`, `boxd`, `groundbox`, or [a paired computer](#a-persons-own-computer) by its id |
| `phone` | A rented Android, through the same computer tools | `phone-harness` |
| `browser` | A hosted browser (the browser tools) | `browserbase`, `kernel` |

A desktop's and a phone's tools are one set over the computer's groups. With the `ui` group, `computer_observe` returns
the app window's elements as compact lines (`@e12 button "Save"`), and `computer_act` runs steps on them by ref (press,
set, click, type, key, scroll, drag, nav), each step saying its route and whether a readback verified it, and the answer
ending with the window's new state. Without it, observe is a screenshot and act's steps are raw input at its pixels.
Scripts are the host's `codemode` (no network, no keys): a known sequence of steps is one script, and it returns only
what the next decision needs. On a desktop or a phone its script has a typed `computer` object beside `tools`, whose
declarations codemode's description gives for the computer's groups (`spec/computer/computer.d.ts`, generated from
`packages/computer/src/surface/api.ts`). Every method of `computer` is a nested call of the script: observe, act and
the screenshot are the tools of those names, and the rest (apps, the shell, files, processes, raw input) is
`computer_op` (`{op, args}`), a tool bound for scripts alone. Each call is held to the run's gate and recorded on the
timeline like a tool's, and a crash rerun of the script answers a call that already ran from its record: a shell
command (`shell.run`) is held to the agent's `bash` setting, a started process to `bash_background`, a file written to
`write`, and a file read, listed or looked up to `read`, after the kind's own setting for `computer_op`. A script's call
of a computer tool answers the tool's value. Codex's code mode takes no binding of ours, so a Codex run is offered
`computer_op` beside the computer's tools and its scripts call them as nested calls, each answering the tool's value as
JSON. A run whose `codemode` is set to deny lists them the same way, so its computer stays in reach. `computerMcp` (`src/workspace/computer-mcp.ts`) serves the same tools to an MCP
client, each answer with its value as `structuredContent`.

A kind with no provider, a provider that does not serve the kind, or a provider whose required keys are not saved is
refused before anything starts, in words that name the fix in Settings → Computers. A Docker computer needs a Docker
daemon on this server: where none answers `docker version` (Render and most hosted services run none), Docker is not
ready and says to use a vendor's computer. The server asks again every 30 s, so a daemon that stops is seen. A daemon
started after the server is taken at the next restart, since the start's checks of Docker (its host, this server's
paths and addresses) ran without it.
`GET /v2/computers` lists each kind,
whether this server offers it now, the tools it brings, and each provider with its key names and whether each is saved
(never a value). `PUT /v2/computers/{provider}/keys` saves a provider's keys, sealed under the server's seal key, from
the owner's signed-in session only (the API token is 403), and `POST /v2/computers/{provider}/test` makes one read at
the provider with them and starts nothing. A key set in the server's environment wins over the saved one.
`GET /v2/computers/running` lists the computers up now: one row for each run still going (queued, working, paused or
waiting on its person) whose agent has a computer, with the run's id, agent, title, status and state and its `computer`
as `GET /v2/runs/{run_id}` carries it (`starting`, `ready`, or `taken_over` while its owner drives it, and a held
run's hold), newest first. The runs list carries no computer, so this is the one read for every running computer
across runs and agents; the console's Settings → Computers shows it as Running now. An agent's own computer kept
between runs is on the agent's read (`own_computer`), and a paired computer under `paired` in `GET /v2/computers`. The keys are
`DAYTONA_API_KEY` (with `DAYTONA_API_URL` and `DAYTONA_TARGET` optional), `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`,
`E2B_API_KEY`, `AGENT37_API_KEY` and `AGENT37_SSH_KEY`, `MORPH_API_KEY`, `ORGO_API_KEY`, `PHONE_HARNESS_API_KEY`,
`BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`, `KERNEL_API_KEY`, `BOXD_API_KEY` (with `BOXD_ORG` and
`BOXD_REGION` optional), `SMOLCLOUD_API_KEY`, `GROUNDBOX_API_KEY`, `CLOUDFLARE_RELAY_URL` and `CLOUDFLARE_RELAY_TOKEN` (the relay Worker's,
`packages/computer/relays/cloudflare`), and `FLY_API_TOKEN` and `FLY_APP`; Docker takes none.
`GET /v2/computers/running` lists every run still going (queued, working, paused or waiting on its person) whose agent
has a computer, newest first, each as `GET /v2/runs/{run_id}` answers it: its `computer` says the kind and provider,
`starting`, `ready` or `taken_over` while its owner drives it, and a held run's hold. The runs list carries no
computer, so this is the one read of the computers up across runs and agents; the console's Settings → Computers shows
it as Running now. An agent's own computer kept between runs is on the agent's read (`own_computer`), and a paired
computer under `paired` in `GET /v2/computers`.
The vendors bill their computers by time on their own pages: this server meters no
computer time. The older [`place`](#place) is this setting's v2 view: `{"mode": "runner"}` is kind `none`, and
`{"mode": "sandbox", "box": X}` is a sandbox on provider X. Writing either sets both.

**A Docker computer's size.** A Docker computer, a sandbox or a desktop, may use 2 CPUs' time, 4 GiB of memory with swap
included, and 1,024 processes and threads, unless the server's environment says otherwise: `AGENTRUN_BOX_CPUS` (at least
`0.01`, such as `1.5`), `AGENTRUN_BOX_MEMORY` (a size with its unit, `b`, `k`, `m` or `g`, such as `8g`: at least `6m`,
a fraction of a MiB dropped) and `AGENTRUN_BOX_PIDS` (from 1 to 4,194,304). The claim puts them on the computer's spec,
and the Docker provider runs the container with them (`--cpu-quota`, `--memory` and `--memory-swap`, `--pids-limit`).
They apply to Docker computers only: a vendor's computer (Daytona, Modal, E2B, Orgo, a phone, a hosted browser) is the
size its provider makes it, and is never given them. A value the Docker provider refuses stops the server's start, in
the provider's words.

**What a sandbox needs.** A sandbox may list the programs its agent's work needs on the box's PATH:
`"computer": {"kind": "sandbox", "provider": "docker", "needs": ["chrome", "ffmpeg", "ffprobe", "hyperframes"]}`, 1 to
32 names (letters, digits, `.`, `_`, `+` and `-`; no path), each once. A name may also be a library the agent's code
loads: a Python package by the name pip installs it by (`python-pptx`), which the box's `python3` has installed, or a
Node package (`pptxgenjs`), which a script of the box's `node` requires (from `node_modules` of the folder the check
runs in or any folder above it, up to `/node_modules`). A scoped npm package (`@scope/name`) can't be named. It says what the box must have, never which
image it is: a Docker box's image is still `AGENTRUN_DOCKER_IMAGE`'s, and another provider's is its own. Each run's
claim asks the box it started, before the run's first model request: one `sh` with the names as its arguments, which
prints those that are neither a program `command -v` finds nor such a library, searching the folders the agent's shell searches (`/usr/local/sbin`,
`/usr/local/bin`, `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`), never a PATH the image sets. A box that lacks one, or that cannot be asked, is let go and the run ends
`failed` (`run_failed`), its words naming what is missing and how to give the box an image that has it:

```text
This agent's sandbox on Docker lacks chrome, ffmpeg, ffprobe, and hyperframes, which the agent needs (computer.needs),
so nothing ran. Set AGENTRUN_DOCKER_IMAGE to an image that has them and restart the server. For video (chrome, ffmpeg,
ffprobe, hyperframes), build the media image: ...
```

Nothing is installed and nothing falls back. A provider whose image is a setting of its own (Daytona's
`AGENTRUN_DAYTONA_SNAPSHOT`) is named in the fix instead. Only a sandbox takes `needs` (422 `not_allowed` on another
kind; a stored setting or a launch's computer that has them on another kind fails the run at claim in words, nothing
started); an agent without it is checked for nothing, and its revision is as before. A template states them as `needs`
beside `computer: [shell]` ([templates](templates/README.md)), and apply writes them onto the sandbox it picks, or
refuses where the shell here is no sandbox.

**A lost sandbox.** A run's sandbox can be lost mid-run: its vendor deleted it (from its own console or API), or no
longer has it. The tool call in flight when the loss is confirmed fails with code `gone`: `the computer <name> was lost
while this call ran, and it was not run again: <the provider's words>. A new computer starts at the next call.` It is
never sent again, to the new sandbox or anywhere, so a command that is not safe to repeat runs at most once. Whatever it
wrote to the run's folder before the loss stays there. The run's next tool call starts a new
sandbox under the same claim and runs there, also when the lost one was kept through a park. A start that fails is
tried again at the next tool call, under the same request, and does not count. In Mode 2 the new sandbox mounts the run's folder again with a new mount
credential, and the lost one's credential is removed. The run's folder is kept; what was on the lost sandbox outside it
(its processes, `/tmp`) is gone. The timeline says `Its computer was lost; started a new one (<name>).` A claim starts
at most 2 new sandboxes. The loss after that fails the run at once, whichever call finds it with error code `computer_unavailable`, in the provider's
words. A provider error that does not show the sandbox gone (a 5xx, a timeout, its read of the machine failing) starts
nothing. A desktop, a phone, a paired computer and an agent's own computer are never started again this way.

**A phone's apps.** A phone has its stock apps. To give every phone more, the operator names APK files on the machine
that drives the phones (the server's, or its runner's) in that machine's environment, each pinned by its sha256:
`PHONE_HARNESS_APKS=/srv/apks/wikipedia.apk@sha256:<64 hex digits>`, a comma list. Only the operator sets it: no agent
setting, API or Settings page names an APK, and the server downloads nothing. Each phone installs them
(`pm install -r`) before the agent starts on it. A file that is not there, or whose bytes are not its pin, refuses the
claim in words before a phone is rented; a value that is not such a list refuses every phone, naming the entry.

**GPUs.** A sandbox may ask for GPUs: `computer: {"kind": "sandbox", "provider": "daytona", "gpu": {"type": "H100",
"count": 1}}`. `GET /v2/computers` shows each sandbox provider's `gpu`: the types it gives, by the vendor's own names, the
most one computer gets, and where a GPU computer differs from its others. A provider whose GPU computers cannot hold
this server's run folder says why there. The save checks the shape, and only a sandbox takes one. The run's start (409)
and the claim refuse a type or a count the provider does not give, in the computer package's `checkGpu` words, and the
computer is made with the GPUs asked.

- **Daytona** gives one `H100`, the GPU of its GPU snapshot `daytona-gpu` (the computer package's `DAYTONA_GPU`:
  `types: ["H100"]`, `max: 1`); another type or count needs a snapshot of its own, so it is refused. A GPU sandbox is
  made from that snapshot, with its 16 vCPUs, 100 GiB of memory and 400 GiB of disk, in region `earth`. Stopping it
  deletes it: it has no pause and no snapshot, so nothing on it outlives the run. A Daytona GPU may be preempted, so a
  run on one can be cut short. The Daytona org needs GPU credits. A Daytona GPU sandbox takes no Archil mount (its
  GPU host gives no `/dev/fuse`), so it can't hold the run's folder: Mode 2 refuses it, and in Mode 1 a sandbox runs
  on Docker only, so a Daytona GPU sandbox runs on neither mode's server today.
- **Modal** declares its GPUs, but a Modal GPU sandbox runs on gVisor, and the Archil mount the run's folder needs is not
  proven there. So this server refuses a Modal sandbox with a `gpu` for now. A Modal GPU is also preemptible.

**An agent's own computer.** `computer: {"kind": "desktop", "provider": "orgo", "persistent": true}` gives the agent
one computer that it keeps between runs, instead of a fresh one for each run:

- Its first run makes it. Each run's end detaches it rather than deleting it (an Orgo Linux desktop is suspended, with
  its memory and disk). The agent's next run attaches it again, with what was on it.
- The run's timeline says which happened. If the computer was deleted outside this server, the next run makes a new
  one and says so.
- One run at a time. A run that finds the computer held by another run that is still going is refused at its start,
  naming that run.
- Only where the provider keeps one for the kind and image (`GET /v2/computers`: the provider's `persistent`); anything
  else is 422. A computer that mounts the run's folder can't be kept, so a persistent computer never mounts it.
- `GET /v2/agents/{agent_id}` shows it as `own_computer`: its provider, id and name, and whether a run holds it, it is
  detached, or it is being deleted.
- Archiving the agent, turning `persistent` off, or moving the setting to another provider or image deletes it.
- The computer is owned by this server's id (kept in its store) and the agent's id, so two servers on one vendor
  account never take each other's. The janitor deletes an agent's computer only once its agent no longer wants it.

**A video of each run.** `computer: {"kind": "desktop", "provider": "e2b", "record": true}` records the computer's
screen during each of the agent's runs. Off by default; a desktop, a phone or a browser (a sandbox is 422). A browser's is
each session's page, one file per session (its computer), from the live view's own screencast of it, which the viewer
shares: frames come as the page changes. `GET /v2/computers` says per kind whether its runs can record here, in
`record` (`{"available": false, "why": "..."}` for a sandbox, for no computer, and for every kind on a server with no
`ffmpeg` on its PATH), and the console's Recording switch reads it.

- **It shows everything on the screen.** That includes what a person types while they have taken over the computer, and
  any password, key or private page shown on it. Pixels can't be redacted. Turn it on only for an agent whose screen
  you would be fine to keep and share.
- **What it records.** The screen while the run holds its computer: from the claim's attach until the computer's
  release or the run's end. A parked run's recording pauses and goes on in a new file when the run resumes. At most 10
  frames a second, 1280 pixels on the long side, no sound, H.264 in fragmented MP4, so a file cut short still plays.
  Each frame is stamped with the time it came, so the video plays at the screen's own pace. The recorder watches the screen on a connection of its own, so it
  records with no viewer open, and it never holds up the live view or the agent: a frame that comes while the encoder is
  still busy replaces the one waiting.
- **Where it goes.** `recordings/<computer>.mp4` in the run's folder on the machine that runs it
  (`<data>/disk/agents/<agent>/runs/<run>/recordings`, beside the run's `work/` folder, never in it, so the agent can't
  read or change it). It is kept with the run's files. A phone whose frames change from PNG to JPEG, and a resumed run,
  go on in `<computer>-2.mp4` and so on.
- **Reading it.** The run read (`GET /v2/runs/{run_id}`) lists them in `recordings`: each one's `path`, `computer`,
  `seconds`, `bytes` and whether it is `finished` (false while it is still being written; every file is finished a few
  seconds after the run ends, once its encoder has let go of it). A recording reaches the disk as it is made, a
  fragment every 2 seconds or so. `GET /v2/runs/{run_id}/files/recordings/<computer>.mp4` serves one as `video/mp4`, read-only, to
  whoever may read the run's other files, with byte ranges (`206`) so a `<video>` can seek, and `?download=1` for an
  attachment. One still being written is served as it stands: it plays up to its last whole fragment. The console's
  Screen tab says "Recording" while one is written and offers Export once it is finished. The server reads the folder
  on its own machine, where the runner beside it recorded. A folder the agent makes named `recordings` at the root of
  its `work/` is neither listed nor served: that path is its recordings. What the video can show is said above.
- **Its caps.** 500 MB across a run's files, a resumed run's included, and 2 hours of recording from its start or the
  run's resume, whichever comes first. At a cap the recording stops, and the run's timeline says so. So does an encoder that stops by itself (a crash, a full disk) or a screen that stops
  answering. The run itself never fails because of its recording.
- **It needs ffmpeg** on the server's `PATH` (the published image has it). A server without it refuses `record: true`
  when the agent is saved, with 422 `not_allowed` naming the fix.

#### A person's own computer

A computer of your own (a laptop, a desktop, a phone) can be an agent's computer. A driver on it dials this server and
holds the connection open, so the computer needs no open port and this server needs no address of its
([spec/computer/attach.md](../../spec/computer/attach.md)). This server knows no OS: a paired computer is what its
driver's hello says it is (its kind, os, device, screen, capability groups and features), and a driver on any OS that
passes the binding's conformance cases (below) needs no change here.

- **Pair it.** Settings → Computers → Pair a computer shows a code, such as `K7PD-W3QX` (`POST /v2/computers/pairings`),
  and this server's address. The code pairs one computer, once, within 10 minutes. Type both into the driver: it trades
  the code for its own token (`POST /v2/computers/pair`, which takes no token of this server's) and keeps that token in
  the OS's keychain. This server keeps only the token's SHA-256. A wrong, used or expired code is a 404, and each source
  address gets 10 tries a minute.
- **It attaches.** The driver dials `GET /v2/computers/attach`, a WebSocket with its token and the subprotocol
  `agentrun.computer.0.2`, and dials again when the connection drops. `GET /v2/computers` lists it under `paired` as its
  hello says, online or offline, with the run that holds it and the time that hold ends by, and as a provider, named by
  its name and os, of each kind its hello serves (`desktop`, `phone`), ready while it is online.
- **An agent uses it.** `computer: {"kind": "desktop", "provider": "cmp-8f2k3jq7m4xw9tnb"}` names it by its id. A run
  claims it at its start (one run at a time: another is refused while one holds it) and releases it at its end, or at
  its lifetime, released or not; it is never made, stopped or deleted. A run of an agent whose computer is offline is
  refused at its start, saying to open its driver. A run uses what the hello's groups and features allow.
- **Remove it.** Remove on its row (`DELETE /v2/computers/{computer_id}`) ends its token and closes its connection; a
  run holding it loses it. Pairing it again gives it a new id.
- **One process.** A computer's connection lands on one server process, and only a run in that process can use it:
  run `agentrun-serve start` with its runner beside the server (the default). A runner started apart
  (`agentrun-serve runner`, beside a server started with `--no-runner`) refuses a paired computer at the claim, saying
  so. Such a server says it sooner: its pairing code, the pair answer and each paired computer carry `runs_refused`,
  which the console shows with the code and on the computer's row. The image's default command starts its runner apart; give the image the server's options alone
  (`--data /data --listen 0.0.0.0 --port 7340 --drain-timeout 6s`) to keep the runner in the server's process. A
  second server on one store is already refused by the store's owner lock, on SQLite and Postgres alike.
- **Conformance.** `node dist/attach-conformance-cli.js [--port 7392] [--listen 127.0.0.1]` runs the binding's cases
  against whatever driver pairs with the code it prints: pair, a wrong or used code, ping, a quiet minute, a redial
  after each close it must redial after (4408, 1000, 1001, 4409) and after a drop, a binary frame (1003), a frame over
  1 MiB (1009), a second socket with the same token (4409 to the older), and revoke (4401, no redial). It runs a store
  of its own in a scratch directory, prints PASS or FAIL for each case, and exits 0 when all pass; it takes about five
  minutes. The revoke case leaves the driver unpaired. Serve's tests run the same cases against a test driver.

**Where the run's folder lives.** A server keeps its runs' folders in one of two modes:

- **Mode 1** (the default): on this server's own disk. Only a provider that binds a folder of this machine can hold
  it, so a sandbox runs on Docker only; a Daytona, Modal, E2B or Agent37 sandbox is refused ("Mode 1 runs a sandbox only on
  Docker").
- **Mode 2**: on Archil disks. `PUT /v2/workspace/archil` turns it on with the account key, `ARCHIL_API_KEY`, its
  region and that region's S3 URL (and an exec image pinned by digest, if you want one other than serve's default);
  `DELETE` turns it off. The default exec image is Docker's `buildpack-deps:trixie-scm` pinned by digest (git 2.47),
  because Archil's own has git 2.34 and a read-only bash policy runs git only at 2.43 or later. An image you name needs
  git 2.43 for that too, and GNU coreutils and perl, as Debian-family images have. A Modal, E2B or Agent37 sandbox
  mounts the run's folder from its disk, which needs Archil's image in your own vendor account. Agent37 puts it there
  itself: its descriptor says `prepareImage`, so a run's first claim registers our public box image as a template of the
  key's workspace (`agentrun-box-<recipe hash>`) and waits once, saying it is pulling. Its sandbox and desktop are
  ready once the keys work. Modal's descriptor says `prepareImage` too, and it answers our public box image by its
  registry tag, which Modal pulls at a computer's first create in a workspace, so a Modal sandbox is ready once the keys
  work. E2B's says `prepareImage` as well, and it answers our public box template by name
  (`<publisher>/agentrun-archil-<recipe hash>`, which the release builds and makes public), with no call, so an E2B
  sandbox and desktop are ready once the key works; the desktop mounts the folder too (it has files and exec). Docker's
  sandbox is refused, since it cannot mount the disk. Daytona's is refused on Daytona's hosted cloud, where Archil's
  client hangs on its sandboxes. On a self-hosted Daytona target whose sandboxes reach Archil through an Archil egress
  relay, save the relay's address as `DAYTONA_ARCHIL_EGRESS` (Settings → Computers, beside `DAYTONA_API_KEY`) and name
  a snapshot of `box/Dockerfile` in `AGENTRUN_DAYTONA_SNAPSHOT` (below): the Daytona sandbox then mounts the run's
  folder and is ready. With the relay but no snapshot named, it is refused, saying to name one. A boxd sandbox takes no
  mount yet, so it is refused in both modes; a boxd desktop runs in either. Which folder a provider's computer holds on
  this server now is on its row in `GET /v2/computers`, by the rule a run's claim picks it by: `folder` is `archil`
  (mounted from the disk), `sync` (a synced folder the runner keeps on the disk), `bind` (Mode 1's folder of this
  machine) or null (none).

  The PUT is a secret write, so it takes the owner's signed-in session. A server with none to give it (API only, or
  `AGENTRUN_ACCOUNTS=0` reached beyond loopback) is set where it is started instead: `AGENTRUN_ARCHIL_REGION` and
  `AGENTRUN_ARCHIL_S3_URL` together, and `AGENTRUN_ARCHIL_IMAGE` for a pinned exec image, with the account key in
  `ARCHIL_API_KEY`. Each agent's disk is then made on its first run, as with saved settings:

  ```sh
  AGENTRUN_ARCHIL_REGION=aws-us-east-1 AGENTRUN_ARCHIL_S3_URL=https://s3.example.com \
  ARCHIL_API_KEY=... node packages/serve/dist/cli.js
  ```

  Each value is checked as the PUT checks it. One of the region and S3 URL without the other, or a value the PUT would refuse,
  stops the start, in words naming each variable. Set, they win over saved settings, as `ARCHIL_API_KEY` wins over a
  saved key, and nothing is written to the store: `GET /v2/workspace/archil` says `source: "env"` (saved ones say
  `"console"`), and `PUT` and `DELETE` are `409 key_set_by_server`, since they are changed where the server is started.
  Unset, the saved settings, if any, hold again. A runner started on its own (`agentrun-serve runner`) reads them from its
  own environment, as it reads `ARCHIL_API_KEY`, so give it the same values.

**Archil disks: one per agent.** In Mode 2 every agent has its own disk. It is made on the agent's first run that uses
it, never when the agent is made, in the account key's region, named `agentrun-<server id>-i-<agent id>` (an id with
characters Archil doesn't take, or past 46 of them, is `h-` with its first 21 safe characters and 24 hex digits of its
SHA-256, so no agent's disk name is another's); making it is
idempotent by that name, and `GET /v2/agents/{agent_id}/archil` says which disk it is. A run's mount credential is minted
on its run's disk, so Archil refuses that token on every other disk: a run of one agent can't mount another agent's
files. This is the default, and it is enough for one owner: this server has no roles, and everything on it is its
owner's.

- **Isolating tenants.** A run's start may name another disk: `"archil_disk": {"disk_id": "dsk-…"}` on
  `POST /v2/agents/{agent_id}/runs` or `POST /v2/runs` (an agent given inline). The run then keeps its folder there, and
  its token is minted there, so a system that runs one agent for many customers (one expert, say) names a disk per
  customer. That disk is the caller's: agentrun never makes, renames or removes it. It takes the id Archil returned when
  the disk was made (`dsk-…`; Archil's API addresses disks by id, not owner/name), never a key or a region. The server
  reads the disk at Archil before the run is made: a disk in another region than the account key's, or none of that id,
  is a 422 naming the region, and no run is made; the claim reads it again, for a disk removed in between. The run's
  launch keeps the disk it used, and whether it was the launch's or the agent's, so every claim, revoke and reclaim of
  that run acts on that one disk, after a restart too. Any disk in the key's region may be named, by design: this
  server has one owner, and a backend that launches runs for its customers is a trusted caller. Isolation comes from a
  disk per boundary.
- **The plan's disk limit.** Archil's free plan allows 5 disks per region. When Archil refuses to make an agent's disk
  for its plan's limit, the run fails in words ("your Archil plan allows 5 disks; upgrade or delete an agent"); no run
  falls back to a shared disk.
- **Removing an agent's disk.** This server archives agents and never deletes one, and an archive keeps everything,
  its disk included. `DELETE /v2/agents/{agent_id}/archil` deletes the agent's own disk at Archil (its runs' folders,
  its home and its learning with it) and frees a disk of the plan, once no live run of any agent is on it (a run of
  another agent may name it in `archil_disk`). The agent must be archived, unless its source manages it: an inline
  run's agent is never archived here, and its caller decides when it is done. The disk is marked as being removed
  before the live runs are counted: from then a new run of the agent on it is `409 agent_not_runnable`, and a run
  launched just before is refused at its claim, so no run starts on a disk being deleted. A refusal leaves the disk the
  agent's. It never touches a disk a run's launch named.
- **Before you upgrade.** In Archil mode, an agent's files from before this release stay on the old server disk at
  Archil; the agent starts on a new disk of its own. `diskId` is no longer a setting: there is no server-wide disk, and
  no agent falls back to one.
- **Later, narrower tokens.** Archil's tokens reach a whole disk; nothing narrower exists today. If Archil ships
  path-scoped tokens, a run's token narrows from its disk to its own folder with no other change.

**A Daytona computer's snapshot.** `AGENTRUN_DAYTONA_SNAPSHOT` names the snapshot (its id or name) every Daytona
computer is made from, as `AGENTRUN_DOCKER_IMAGE` names Docker's image; unset, it is Daytona's default snapshot. One of
the computer package's `box/Dockerfile` is built in the organization of `DAYTONA_API_KEY` with Daytona's Python SDK
(`pip install daytona`), which prints its name, a hash of the recipe:

```sh
DAYTONA_API_KEY=... python3 packages/computer/box/build-daytona.py   # prints snapshot=agentrun-archil-<12 hex>
```

A Daytona computer mounts the run's folder only where `DAYTONA_ARCHIL_EGRESS` names a self-hosted target's Archil
egress relay (see Mode 2 above), and then it needs this snapshot. A changed recipe is a new name, so build again after
an upgrade that changes `box/`. A Daytona [box](#sandbox) never reads it.

**Before unsetting `DAYTONA_ARCHIL_EGRESS` on a server with open runs.** Each open run's folder moves from the Archil
mount to a synced folder at its next claim. The synced claim reads the folder through Archil's file API, which lists a
link an exec made (a venv, `node_modules/.bin`) as a file and won't read it. So it takes the folder's links from the
`sync.json` beside it (`agents/<agent>/runs/<run>/sync.json`), which an Archil computer writes at its park and release
from 0.1.0-beta.45 on. A run whose last Archil claim ran an earlier release, or never reached its park or release, has
no record. If its folder holds a link, its next synced claim is refused. New runs need nothing, and neither do runs
that take no more messages (cancelled, failed, a workflow's, an imported or a learning run). Before the switch, run
0.1.0-beta.45 or later with the variable still set and count the runs at risk. The count is read-only:

1. List the disk under `agents/*/runs/*/` through the file API. Keep each run with files under `work/` and no
   `sync.json`.
2. Keep only the runs that can take a message (`GET /runs`): one not ended, or an agentic run that completed or that a
   person stopped, since a follow-up opens it again on the same folder.
3. Probe every file the listing has under each kept run's `work/` with a one-byte ranged GET. A 501 answer means a
   link: that run is at risk. A run with a file not yet probed stays in the count.

Claim each run left once on the mount (a message, or a resume), so its park or release records it, or accept that it
won't continue where it syncs. Unset the variable once the count is 0.

A desktop, a phone and a browser run in either mode. The run's folder is at
`/workspace` in every computer that mounts it: a sandbox always, and a desktop whose provider mounts the mode's folder
(Docker's in Mode 1, Agent37's and E2B's in Mode 2). A phone and a browser never mount it. On a desktop that mounts it, the
`shell` group's commands and the programs `processes.start` opens start in `/workspace` too, as `bash` does.

**Where `bash` runs.** It follows the mount:

- A computer that mounts the run's folder runs `bash` and the background tools (`bash_background`, `bash_output`,
  `bash_input`, `bash_signal`, `bash_list`). A call with no timeout runs 120 s, and none runs past 600 s.
- With no computer that mounts it (kind `none`, a phone, a browser, or a desktop that does not mount), in **Mode 1** the
  run has no shell at all: the folder is one of this server's own, and a command there would run on the server, able
  to read its data and its keys. The run gets `read`, `write` and `edit`, confined to its folder; `bash` and the
  background tools are not offered, and a `bash` call answers "bash is not available in this run: it has no computer to
  run commands in, and commands never run on the server itself." So an agent with no computer on a server without
  Docker gets the file tools and no shell.
- With no computer that mounts it in **Mode 2**, `bash` runs on Archil's serverless exec: a fresh container that holds
  the run's folder alone, never a process of this server. Only `bash`: the background tools answer that background
  programs need a computer. `bash` is held to its own setting, as on a computer. Archil's limits hold for it: a command
  runs at most 295 s (Archil cuts a call at 300 s, and a longer timeout is refused, not cut); once sent it can't be
  stopped, so a cancel answers at once while the command runs on to its own deadline, holding the folder (later writes
  and commands wait for it); and its output comes back whole when it ends, not as it runs. Through Archil's file API a
  write does not keep a file's mode (a `0755` file is `0644` after a write), and a symbolic link a command made is never
  followed: reading one is refused, a write through a linked folder is refused, and `bash` refuses a working directory
  with a link on the way.

**The run's scratch.** `bash`'s `TMPDIR` is `.agentrun/tmp` in the run's folder, and a cut answer's full output is in
`.agentrun/output/`. The run's end removes both before its end commit: through the computer when it mounts the folder,
else through the folder itself. A computer that mounts the folder from Archil holds Archil's write delegation for it
until its release, so Archil refuses the server's own deletes there until then; the computer's deletes sync to the disk
before they answer. If that computer no longer answers, a Mode 2 run's scratch stays and the release logs why. A park
that keeps the computer removes neither.

**An agent with no setting.** With no `computer` and no `place`, the server decides at each run's start: in Mode 1, the
Docker sandbox where this server's Docker answers, else no computer; in Mode 2, no computer. A workflow always runs with
no computer.

**What a computer reaches.** A Docker sandbox reaches the hosts of `AGENTRUN_BOX_ALLOW` (by default the package
registries and GitHub) through its egress proxy, and nothing else; `AGENTRUN_BOX_ALLOW=none` gives it no network. From a
server in a container the proxy also refuses the Docker host's own addresses, which the server reads through the socket
([in the published image](#in-the-published-image)). A
Daytona, Modal, E2B or Agent37 sandbox reaches the same list through an egress proxy on the vendor's machine, outside its
programs' network. An Orgo desktop has no network of its own (loopback only). A desktop (Docker's, Agent37's, E2B's) and
Local Chrome are open to the public internet, through their egress proxy, unless this server sets `AGENTRUN_BOX_ALLOW`;
then only those hosts (the default list, a sandbox's package registries, is no browsing policy). Either way the proxy
refuses private, link-local and metadata addresses. A phone and a hosted browser are on their vendor's own network,
whatever the list says. Under
`AGENTRUN_BOX_ALLOW=none`, each of these is refused at the run's start, in words that name the setting.

**Docker.** A Docker computer runs where this server's Docker answers. With `AGENTRUN_BOXES` not set at all (a plain
`npx @parcha/agentrun`), the server probes `docker` at its start (within 5 s) and offers it when Docker answers
(`ready`); `AGENTRUN_BOXES`,
when set, lists what it probes, and `AGENTRUN_BOXES=none` probes nothing. One log line says what it found:

    event=boxes available=<ids or none> unavailable=<ids> <id>="<why>" ...

A missing `docker` command says `Docker isn't running on this machine (no docker command on PATH): install or start
Docker, then restart AgentRun`; a daemon that does not answer says to start Docker or add this user to the `docker`
group, then restart AgentRun, since the probe runs once. A run whose agent names a Docker computer here is then refused
at its start in those words. Every other provider needs only its keys. A Docker desktop has no default image: it needs
one with an X server, and `AGENTRUN_DOCKER_IMAGE` names the image of every Docker computer, sandbox and desktop alike.

The keys belong to the server alone. A provider is handed its declared keys only when a run's computer starts or its
connection is tested, and no run's process gets them, in its environment or on its pipe.

## Models

An agentic revision names its model as `provider/model-id` (`"model"` in its definition), or names none and runs on
this host's default, `AGENT_MODEL`. With no `AGENT_MODEL`, a model provider's key, the server's own or saved as a
[tool key](#tool-keys), gives the default, the first of: `anthropic/claude-sonnet-5-5` with `ANTHROPIC_API_KEY`,
`openai/gpt-6.1-sol` with `OPENAI_API_KEY`, `particle/particle-1` with `PARTICLE_API_KEY`, then
`openrouter/openai/gpt-6.1-sol` with `OPENROUTER_API_KEY`. Set `AGENT_MODEL` for another. Direct Particle runs on Pi;
claude-agent takes the Anthropic one and codex the OpenAI one. A workflow revision names no model: each model node names a tier (`fast`, `default`
or `strong`), and the host maps it, `fast` to `AGENT_MODEL_FAST` and `strong` to `AGENT_MODEL_STRONG`, each falling back
to `AGENT_MODEL`. Capabilities show the mapping in `models` (`{source, route_prefix, fast, default, strong}`):
`source` is `gateway`, `providers`, `chatgpt` or `faux` (the published document marks `gateway` and `providers` as
`models/2`, beyond the contract's `managed`, `chatgpt`, `env` and `faux`), and `route_prefix` is the routing prefix this server puts before a gateway's
model ids (`agent-model`), which a client takes off to show the gateway's own id, and null with any other source.
`models` also says `ready`, whether a revision that names no model runs here, and when it does not, `needs`: `key` (no
model provider's key and no [ChatGPT sign-in](#on-a-chatgpt-plan), or none for the default's provider) or `model` (`AGENT_MODEL` names one this server does not
know); and `priced`, whether that model has a price here, which a run's `max_cost_usd` needs (false for a gateway
model with no price set that the catalog does not list in any form; null while `ready` is false, with no model to price). Where the models come from:

- `--faux MODULE`: every model is the module's (below), with no key and no network: `faux-1`, or for a tier the model
  id its variable names.
- `AGENT_MODEL_BASE_URL`: every model id goes to that one gateway, with one trailing `/v1` taken off the base first, as
  for every harness (OpenRouter's is `https://openrouter.ai/api` or `https://openrouter.ai/api/v1`): a Claude model on
  Anthropic's Messages API at `<base>/v1/messages`, where pi marks its prompt for Anthropic's cache (the Responses API
  carries no cache mark, so a gateway's bridge from it reads none), and every other model on OpenAI's Responses API at
  `<base>/v1/responses`. A model is Claude's when its id names Anthropic as its vendor (`anthropic/claude-sonnet-5.5`)
  or names none and pi-ai's catalog lists it under Anthropic (`claude-opus-5-5`); the gateway serves both APIs, as
  LiteLLM's proxy and OpenRouter do, with `AGENT_MODEL_API_KEY` as a bearer token on either. A revision's `provider/model-id` is sent whole, as a gateway like OpenRouter names its
  models `vendor/model`, and `AGENT_MODEL`, `AGENT_MODEL_FAST` and `AGENT_MODEL_STRONG` are sent as they are. For a
  gateway that wants the id alone, `AGENT_MODEL_GATEWAY_IDS=bare` sends a revision's model without its provider. `AGENT_MODEL_API_KEY` is its key when it needs one. `AGENT_MODEL_PRICE` is `input,output,cacheRead[,cacheWrite]`
  in USD per million tokens, so a run's cost estimate has a price; `AGENT_MODEL_FAST_PRICE` and `AGENT_MODEL_STRONG_PRICE`
  price their tier's model, and default to it. With no price set, a model id pi-ai's catalog knows (`gpt-6-luna`, say)
  takes the catalog's list price; one it lists only with its version's separators written the other way (a gateway's
  `gpt-6-1-terra` for the catalog's `gpt-6.1-terra`, `claude-haiku-5.5` for `claude-haiku-5-5`) takes that entry's price,
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
- A model gateway saved in the console (Settings → Model keys → **Use a model gateway**), the same gateway kept in the
  store instead of the environment, for a LiteLLM or other OpenAI-compatible proxy the owner already runs: its address
  (the one rule `AGENT_MODEL_BASE_URL` follows), its key (optional; sealed under the seal key, never shown again, never in
  a run's environment), how it takes ids (`as_named`, or `bare` as `AGENT_MODEL_GATEWAY_IDS=bare`), and the default
  model of each tier (`AGENT_MODEL`, `AGENT_MODEL_FAST`, `AGENT_MODEL_STRONG`). **Test** asks the gateway's
  `GET <base>/v1/models` from the server, with no redirect followed, and lists the ids to pick from. A save or removal
  takes effect at once, with no restart: capabilities read it, and the runner reads it at each claim. Over the API:
  `GET`, `PUT` and `DELETE /v2/settings/model-gateway` and `POST /v2/settings/model-gateway/test`; every one but the GET
  takes the owner's signed-in session, never the API token. Which wins: `AGENT_MODEL_BASE_URL` set where AgentRun starts
  makes the environment's gateway the one in force, whole, and the saved one is not read (its `PUT` and `DELETE` are 409
  `key_set_by_server`); else the saved gateway is in force with its own key alone (never an `AGENT_MODEL_API_KEY` set
  without a base URL), and each of `AGENT_MODEL`, `AGENT_MODEL_FAST`, `AGENT_MODEL_STRONG` and
  `AGENT_MODEL_GATEWAY_IDS` set where AgentRun starts wins over its saved field. A saved key goes only to the origin it
  was saved for: changing the address to another origin asks for the key again (or `api_key: null`, no key). With no key
  saved, each run brings its own (`model_key`, below). Prices are read as for `AGENT_MODEL_BASE_URL`
  (`AGENT_MODEL_PRICE`, else the catalog). Removing it puts the provider keys back in force.
- A ChatGPT plan signed in here ([below](#on-a-chatgpt-plan)), with no provider's key: `source` is `chatgpt`, and pi
  and codex run on the plan's models (`chatgpt/<model-id>`) with no key.
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
  this host does not bind (`definition.tools[i]`), `bash` on an agent whose place is not a sandbox (in Mode 1), a model pi-ai does
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
`high`), else at its agentic revision's `thinking` (`low` to `max`), else at the host's `AGENT_THINKING` (one of those
levels exactly), else at its harness's own default; it is never off (pi never asks a model the catalog does not list,
such as a local one, to stop reasoning: it thinks at its lowest level, its reasoning kept out of the answer), and a model node that names its own thinking level
keeps it. The level is fixed in the run's launch when it starts, and its metrics name the level its harness ran at: one
above the harness's highest runs at that highest (Codex and OpenCode stop at `xhigh`). An agentic run whose level is
`low`, `medium` or `high` also gets a short note on how to work, right after its instructions, on every harness
(`src/effort-guidance.ts`): `low` answers directly, `medium` plans briefly and checks once, `high` plans each part, fills
the gaps and reviews. A run with no level, or one above `high`, gets no note.

### Per-run model keys (LiteLLM virtual keys)

A caller can hand each run its own model key, such as a [LiteLLM](https://docs.litellm.ai/docs/proxy/virtual_keys)
virtual key minted for that run, with `model_key` on `POST /v2/runs`, `POST /v2/agents/{agent_id}/runs` and
`POST /v2/runs/{run_id}/messages`. AgentRun uses that key for every model request tied to the run and never mints,
lists or revokes it: the caller owns the key's life.

**Run without a server key: callers pass a per-run key.** There is no setting. Point `AGENT_MODEL_BASE_URL` at the
gateway and give the server no model key of its own (no `AGENT_MODEL_API_KEY`, nothing saved in Settings → Model keys).
The server and its runners start, and capabilities read ready, with no standing key. Then:

- A run with `model_key` spends on that key alone.
- A run without one, whose model goes to the gateway, is 422 `model_key_required` at its start, before any model call.
- A message that would start a new turn (the run's last turn ended) without `model_key` is also 422
  `model_key_required`, and nothing is written.

A server that does hold a key spends it on a run that brings none, as before, and never on a run that brings its own.

Where the key goes: to the gateway at `AGENT_MODEL_BASE_URL` only, which every pi and codex model and every workflow
model node is sent to, and to Anthropic's Messages endpoint when `ANTHROPIC_BASE_URL` names the same origin (claude-agent
on the gateway). A key sent with a run whose model goes elsewhere (no gateway, a native run, a model routed to a
provider's own API) is 422 at `model_key`, never kept unused.

```sh
# Mint a virtual key for this run (LiteLLM's proxy, with its master key; your backend does this, never the agent).
KEY=$(curl -s https://litellm.example.com/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'content-type: application/json' \
  -d '{"duration": "1h", "max_budget": 2, "metadata": {"run": "ticket-4521"}}' | jq -r .key)

# Hand it to the run.
curl -s http://127.0.0.1:7340/v2/agents/support/runs -H "Authorization: Bearer $AGENTRUN_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"input\": {\"content\": \"Triage ticket 4521\"}, \"model_key\": \"$KEY\"}"

# A follow-up turn gets a key of its own.
curl -s http://127.0.0.1:7340/v2/runs/$RUN_ID/messages -H "Authorization: Bearer $AGENTRUN_TOKEN" \
  -H 'content-type: application/json' -d "{\"content\": \"And the refund?\", \"model_key\": \"$NEXT_KEY\"}"

# When the run's turn has ended (run.ended), revoke it.
curl -s https://litellm.example.com/key/delete -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'content-type: application/json' -d "{\"keys\": [\"$KEY\"]}"
```

Custody, as for a per_run MCP server's `mcp_auth`:

- The key is taken out of the body before anything reads it. It is never in the run's saved body, its timeline, its
  view, a log or an `Idempotency-Key`'s fingerprint. A retry with a new key answers the first request's run and keeps
  its first key.
- It is sealed with the run under the server's seal key, bound to the gateway's origin then. A runner opens it at each
  claim, a reclaim after a runner's crash included. A gateway moved since never receives it.
- Each model route reads it per request through the kernel model proxy. The harness, its tools and its sandbox never
  see it, and the run's redactor cuts it from anything the run writes.
- A message's `model_key` replaces the run's key from the next model request on: the runner reads it again when it
  takes the message, before the message reaches the session. That holds while the turn is still going, and for a run
  that started on the server's key and gets its first key from a message. If that read fails, it is tried again; if it
  keeps failing, the message waits untaken and is delivered again, never run on the key held before it or the
  server's. A stop or cancel sent after it still reaches the run. A message without one keeps the key the run holds.

**The revoke-at-turn-end contract.** The write that ends a run's turn erases its key from the store, and the run
reports the turn ended (`run.ended`, the run's `completed`, `failed` or `stopped` status) only after that write. Every model request
tied to the turn finishes before then: the job, its subagents, its learned workflows' nodes, its end-of-run compile
turn. So a caller may revoke the key as soon as it sees the turn end, and no request of that run will
answer 401 for it. Model spend that would run after the turn ends is never sent on the run's key or the server's:

| Spend | With the run's key | Server holds no key, run brought none |
| --- | --- | --- |
| A shadow audit, a learned workflow's replay check | Skipped, logged | Skipped, logged |
| A grade's feedback round (`PUT /runs/{id}/grade`) | A new turn with no key: the server's, else not opened | Not opened; the grade is kept |
| An owner's replay, an SDK run's compile turn | Tied to no run's key | 409 or skipped, in words |
| A trigger's firing | Starts a run with no key | 422 `model_key_required` for the firing |

Jev and the other decision providers run on their own keys (`TYPESAFE_API_KEY`, `PARALLEL_API_KEY`,
`OPENROUTER_API_KEY`), which are not model keys and which a run's key does not replace. On a run that brings its own
key, no model key is on the env its decision nodes run under, so Jev's route on an openrouter.ai gateway's key is off.

### Per-run tool keys

A caller can hand a run its own tool keys with `keys` on `POST /v2/runs`, `POST /v2/agents/{agent_id}/runs` and
`POST /v2/runs/{run_id}/messages`: `{"PARALLEL_API_KEY": "..."}`. The run's tools use each one in place of the server's
key of that name. The names a run can carry are the tool keys: `PARALLEL_API_KEY` (`web_search`, `web_fetch`, Parallel
decisions), `MONID_API_KEY`, `BROWSERBASE_API_KEY` with `BROWSERBASE_PROJECT_ID` or `KERNEL_API_KEY` (`browser`) and
`TYPESAFE_API_KEY` (Jev). A model key goes in `model_key`, above.

```sh
curl -s http://127.0.0.1:7340/v2/agents/searcher/runs -H "Authorization: Bearer $AGENTRUN_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"input\": {\"content\": \"Find the release notes\"}, \"keys\": {\"PARALLEL_API_KEY\": \"$CUSTOMER_PARALLEL_KEY\"}}"
```

- A name that is not a tool key, or one no tool of the run's revision reads (its tools, its workflow's nodes and
  decision providers, and the keys its template declares), is 422 at `keys.<NAME>`, the value never echoed. So is a
  value that is not 8 or more characters of visible ASCII (`invalid`), as a header carries it: the runner could
  not cut a shorter one from what the run writes.
- The keys are taken out of the body before anything reads it, as `model_key` is: never in the run's saved body, its
  timeline, its view, a log or an `Idempotency-Key`'s fingerprint. They are sealed with the run's launch, opened at
  each claim for its tools alone, and erased from the store by the write that ends its turn. Since no read after that
  could cut them, the runner cuts them from everything the run writes, as it writes it. To cut them, the runner's
  redactor keeps each value in memory for as long as the runner runs, as it does a run's `model_key`.
- A message's `keys` replace the run's in the message's own write, read from the run's next claim on; a turn still
  going keeps the keys it opened. `keys: {}` leaves the run none. A message without them keeps the run's, which are
  none once its last turn ended.

**Tool keys each run brings: `AGENTRUN_RUN_KEYS=1`.** Off, a template's apply refuses a tool key the server does not
hold (409, as before). With `1`, a template's apply makes its agent though a tool key it declares is not set here, with
a warning, and each run of that agent must bring the key in `keys`: without it, the run is 409 `agent_not_runnable` at
`keys.<NAME>` before anything is made, and so is a message that would start a turn. Keys the server holds are still
used by runs that bring none.

A trigger's firing brings no keys, so no trigger is made whose firings would start or message such runs without them.
The apply skips the template's triggers with a warning at `triggers.<N>` (`not_set_up_here`, the apply still 201),
unless the [launch hook](#launch-hook) is set, which hands each firing to your backend to start the run with its keys.
`POST /v2/triggers`, or a `PATCH` that moves a trigger, is 409 `agent_not_runnable` naming the keys for a trigger that
would start runs of the agent with no hook, or message one of its runs, hook or not. A `message_run` trigger made
before the setting was on, or while the server held the key, fails each firing with that 409 and sends nothing. An
update apply that skips a trigger leaves the agent's trigger of that name as it was; when that one is on, it still
fires, and the skip's warning names it and says how to turn it off.

`MONID_API_KEY` stays the server's even with the setting on: an agent's monid tools are checked with it when the agent
is saved, before any run, so a template that grants them is still refused at its apply (409 at
`secrets.MONID_API_KEY`) where the server has none. A run can still bring its own monid key to use in place of the
server's.

### Direct Particle-1

Save a Particle key in **Settings → Model keys → Particle**, then select `particle/particle-1` with the **Pi** harness.
Alternatively supply `PARTICLE_API_KEY` where AgentRun starts and set `AGENT_MODEL=particle/particle-1` (or a workflow's
`AGENT_MODEL_FAST` / `AGENT_MODEL_STRONG`). Get an inference-enabled key from [Particle's platform](https://platform.particle.ai/).
The key uses the existing sealed storage and provider-scoped handover; it is not placed in run environments. Saving
it checks `GET /v1/models`, which performs no generation. No OpenRouter key is required.

The provider sends native Chat Completions to `https://api.particle.ai/v1/chat/completions`, using request alias
`particle-1`. The [official catalog](https://docs.particle.ai/models) lists text/image input, a 1,048,576-token combined
context and a 131,072-token output ceiling (the API's omitted-limit default is 32,000). Strict schema guarantees are
not advertised. AgentRun sends native tools and `reasoning_effort`; it does not reuse OpenRouter's reasoning object or
its measured text-tools caching workaround. Existing `openrouter/particle-ai/particle-1` definitions and the code-review
template keep their OpenRouter route.

Supported scope is Pi agentic runs and workflow model nodes (including nested learned workflows) through Pi's
existing local proxy. Codex, Claude Agent and OpenCode do not support this direct provider. Particle's
[Responses API](https://docs.particle.ai/responses) is WebSocket-only; it does not implement HTTP `POST /v1/responses`.
Pointing `AGENT_MODEL_BASE_URL` at Particle's global or US API is therefore refused with setup instructions. This
integration currently uses the global endpoint and regular service only; it does not expose regional routing, Flex,
WebSocket steering, files or other Particle models.

The [reasoning levels](https://docs.particle.ai/reasoning) map low to low, medium/high/xhigh to high, and max to max.
Pi requests with thinking off explicitly send `none`, rather than inheriting the API's high default. Native tool
continuations retain the assistant's reasoning and tool-call IDs. Nested learned-workflow and `llm` side calls take
the model's limits and reasoning configuration from the live session port, preserving their requested effort.

An opaque hash of the Pi conversation ID becomes `prompt_cache_key`, within Particle's 256-byte limit. Side requests
without an ID share a key for the lifetime of their route. `cacheRetention: "none"` omits the explicit hint;
Particle may still derive affinity and cache the prompt. Read the returned cached-token count, since
[affinity does not guarantee a cache hit](https://docs.particle.ai/prompt-caching).

Usage keeps the provider's token counts: uncached input is prompt tokens minus cached input, and reasoning is a
breakdown of completion tokens, never added to them again. Cost is an **estimate at regular peak list prices**:
$0.25 uncached input, $0.03 cached input and $1 output per million tokens. The same rates reserve the run's cap.
[Off-peak discounts, Flex and account-specific pricing](https://docs.particle.ai/usage-billing) can change the bill;
Chat usage does not supply an authoritative dollar total. Missing or malformed usage, or a stream missing its terminal
`[DONE]`, fails the request with unknown cost rather than reporting a free completion. Cancellation aborts the provider
request, but does not undo tokens already generated or guarantee final usage.

Provider and session transports disable retries. A Pi claim using Particle, including one of its subagent tiers,
also disables automatic conversation retries for the whole claim. Errors are surfaced for the caller to decide;
even a pre-admission 429 is not retried automatically. This changes request retry configuration, not recovery
admission, dispatch, journal fencing, restart or cancellation behavior; the recovery models do not change.

Offline regressions cover streamed native tools, continuation, reasoning, cache accounting, missing usage, cancellation,
errors, credential scoping and actual Pi conversation retries. A live pass against Particle's API (2026-11-18, twelve
checks) saved a key, then completed a plain run, tool calls continued after the model's reasoning, a follow-up, a
cancel, a capped run and a workflow's model nodes. Replies reported cached input tokens and no cache writes, and each
priced run's cost equaled its tokens at list price. A later workflow run (2026-11-19, three requests) matched
Particle's usage page: the same cached, uncached and output token counts, and the same cost to the six decimals the
page shows. Not yet seen live: a rate limit or server error from Particle. The protocol fixtures alone are not
evidence of live compatibility.

### On a ChatGPT plan

A server needs no model key to start, on any of its deploys. With none, capabilities say `models.ready: false` and
`needs: "key"`, and each harness's `reason` names the keys it takes. Codex's and pi's add "or sign in with ChatGPT
(Settings → Model keys) to run it on your ChatGPT plan" (after an expiry: "your ChatGPT sign-in expired: sign in again
(Settings → Model keys)"), and their entries say `needs: ["key", "chatgpt"]`; Claude Agent's and OpenCode's say
`needs: ["key"]`. The console's first screen then offers **Continue with ChatGPT** beside **Add a key** (also under
Settings → Model keys), and its "What runs here" reads `needs`: Codex and pi "run after Continue with ChatGPT". The owner
signs in with their ChatGPT plan, and pi and codex run on it with no key. Claude Agent, OpenCode, Jev decisions and paid
tools still need their own keys.

The sign-in is the owner's alone, over the owner's signed-in session (the API token gets `403`, as for every secret):

- `POST /v2/settings/chatgpt/sign-in` answers `authorize_url`, OpenAI's sign-in page, and `expires_at`: one sign-in
  waits at a time, for 10 minutes, and starting again replaces it. Where the browser and the server share a computer
  (`npx @parcha/agentrun`), it finishes by itself. On a server that isn't this computer (Render, a container), the
  sign-in tab ends on a page that won't load: copy its whole address into the console, which sends it as
  `POST /v2/settings/chatgpt/sign-in/finish` `{"redirect_url": "..."}`.
- `GET /v2/settings/chatgpt` says `state`: `signed_out`, `pending` (with `authorize_url` and `expires_at`), `signed_in`
  (with `email`, `plan` and the plan's `models`) or `expired`.
- `DELETE /v2/settings/chatgpt` signs out: it removes the sign-in here and revokes it at OpenAI, and answers
  `{"revoked": true}` when OpenAI confirmed it (or nothing was signed in, as when it only cancels a waiting sign-in).
  When OpenAI didn't confirm it, the answer is `{"revoked": false, "message": "Signed out here. OpenAI didn't confirm
  the revocation: remove AgentRun in your ChatGPT settings."}`. Signing in again revokes the sign-in it replaces, and a
  renewal that finishes after a sign-out revokes the tokens it got.

A curl call with the owner's session (the console's cookie: `__Host-agentrun-session` on https) sends this server's own
`origin` and `content-type: application/json` on every write, a `DELETE` with no body too: without them the cookie
does not count, and the server answers `401` ([the console](#the-console)).

```sh
S=(-H "cookie: __Host-agentrun-session=$SESSION" -H "origin: $BASE" -H 'content-type: application/json')
curl -X POST "$BASE/v2/settings/chatgpt/sign-in" "${S[@]}"
curl -X POST "$BASE/v2/settings/chatgpt/sign-in/finish" "${S[@]}" -d '{"redirect_url":"<the address the sign-in tab ended on>"}'
curl "$BASE/v2/settings/chatgpt" "${S[@]}"
curl -X DELETE "$BASE/v2/settings/chatgpt" "${S[@]}"   # 200 {"revoked": true}, or {"revoked": false, "message": "..."}
```

The sign-in is sealed in the store under the seal key, like a saved key. Any process that holds the store and the seal
key (the server, each runner) renews the sign-in, so it is as trusted as the server; the seal key already opens every
sealed key. Signed in, with no provider's key, capabilities
say `models.source: "chatgpt"` and a revision that names no model runs on `chatgpt/gpt-6.1-sol` where the plan lists it.
A run on the plan books its tokens and no dollars (`cost.plan`). Eligible usage in this app uses your ChatGPT plan.
Manage usage in your ChatGPT settings. A sign-in is for the person who runs this server: don't share it or let others
run agents on it.

### On Claude Code's login on this machine

On a server one person runs on their own machine, Claude Agent can run on that person's Claude plan through the Claude
Code CLI's own login. The CLI holds the login and calls Anthropic itself. AgentRun never reads, copies, stores or relays
the login. It tells the CLI where the login is and asks it `claude auth status`, nothing else. Settings → Model keys
has the row **Use Claude Code's login on this machine**, over these routes:

- `PUT /v2/settings/claude-login` `{"only_me": true, "place": "agentrun"}` turns it on. `only_me` is the owner's word
  that they alone run agents on this server. `place` is where the login is: `agentrun` (the default) is AgentRun's own
  login directory in the data folder, which you sign in once; `machine` is this machine's own Claude Code login
  (`~/.claude`), which you opt into by name. A server where more than one person can start runs (more than one API
  token, the API-only profile) refuses it with `403` and one line saying why, and a turn-on saved before is dropped
  when such a server starts.
- `GET /v2/settings/claude-login` says `state`: `off`, `signed_in` (with the `account` the CLI names: method, email,
  organization, plan), `signed_out`, `no_cli` (claude-agent's first run installs the pinned CLI), `unknown`, or
  `other_machine`. `command` is the line that signs the CLI in at the login's place, for a terminal on the server's
  machine. Where the console is on that machine (a server on loopback with no public address), `can_start` is true and
  `POST /v2/settings/claude-login/login` starts the pinned CLI's own `auth login`, which opens a browser there.
- `DELETE /v2/settings/claude-login` turns it off. The login stays as the CLI keeps it.

While it is on, a claude-agent run on an `anthropic/<model>` model goes on the login: its CLI gets no
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or key, no model proxy runs, and the CLI's sandbox denies its commands
reads of the login. A model named on a gateway or OpenRouter keeps its key, and so does a run started with its own
`model_key`. With no key at all, claude-agent's default
model is `anthropic/claude-sonnet-5-5`. A run whose login is signed out fails at its start and says so. It never
switches to a key. The run books its tokens and no dollars (`cost.plan`, `on: "claude_code"`), and the plan's own limits
apply. Only a run in a runner place, on the machine the mode was turned on for, goes on the login. A run placed in a
sandbox, or on another machine, uses the keys. The login is the server's user's, so a run on it needs runs under that
user: where each run is a user of its own (the image, `run_isolation: "uid"`), a claude-agent run that would go on the
login fails at its claim and says so. Set `AGENTRUN_RUN_USER=same`, or give the run a `model_key`.

The mode exists only on a server that listens on loopback (a local install, or one behind a local proxy). A server
bound to any other address, such as all interfaces in a container or on a hosting service, has it off
with nothing to set. `AGENTRUN_CLAUDE_CODE_LOGIN` overrides the default. `off` turns the mode off anywhere. `on` makes
it available past loopback, but a server with more than one API token still refuses it, and so does the API-only
profile. While the mode is off, the row is gone and every route above answers `404` naming its operation. A turn-on
saved earlier is dropped when the server starts, and claude-agent runs on the model keys.

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
| `bash` | Run a shell command in the run's box, from its `work/`: pi's `{command, timeout?}`, 120 s when the call names no timeout and at most 600 s (a longer one runs at 600 s and says so; longer work is `bash_background`) | an agentic definition whose place is a sandbox ([Sandbox](#sandbox)), or one on the runner in Mode 2 (Archil's serverless exec, at most 295 s) | no, no |
| `bash_background` | Start a shell command in the background in the run's box, from its `work/`, and answer its id at once: `{command, tty?}` in, `tty: true` for a terminal. Its stdout and stderr go to `work/background/<id>/output.log`, the first 16 MiB; at most 8 run at once ([background processes](#background-processes)) | an agentic definition whose place is a sandbox | no, no |
| `bash_output` | Read a background process's output from a byte offset: `{id, offset?, max_bytes?}` in (at most 48 KiB a call), its state, exit code, the log's size and the next offset out | an agentic definition whose place is a sandbox | no, no |
| `bash_input` | Write to a running background process's stdin: `{id, text, close?}` (at most 64 KiB a call) | an agentic definition whose place is a sandbox | no, no |
| `bash_signal` | Send a background process's group `TERM`, `INT` or `KILL`: `{id, signal}` | an agentic definition whose place is a sandbox | no, no |
| `bash_list` | List the run's background processes: id, state or exit code, output size, start time and command | an agentic definition whose place is a sandbox | no, no |
| `ask_person` | Ask the person who started the run; the turn ends until a message answers | nothing | no, no |
| `web_fetch` | Read one web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked ([search and fetch](#search-and-fetch)), a part at a time: `{url, offset?, max_chars?}` in, a Page out, `{ok, url, status, title, text, chars, truncated?, original_chars?, beyond_read?, offset?, next_offset?, html_chars?, converted?, links, links_omitted?, via, parallel?, refused?, error?}` | nothing (`PARALLEL_API_KEY` for Parallel, one billed extract a page a run) | yes, yes |
| `web_search` | Search the web, natively where the harness or the model's provider can, else through Parallel where the server holds its key, else keyless through Exa, or through the provider picked ([search and fetch](#search-and-fetch)): `{query, n?}` in, `{provider, query, results: [{url, title, snippet, published?}], text?}` or `{error}` out | nothing (`PARALLEL_API_KEY` for Parallel) | yes, yes |
| `web_save` | Download one file from a public URL into the run's `work/` and keep it there, for a link that expires (a generated image, audio or video): `{url, path}` in, `path` relative to `work/` and a bare name under `media/`; `{ok: true, path, bytes, content_type, duration_s?, url}` or `{ok: false, url, refused \| error}` out, `duration_s` an mp3, wav, mp4 or m4a's length in seconds read from its bytes. Never overwrites | nothing | no, no |
| `browser` | A hosted browser, Browserbase's or Kernel's, on pi-browser's durable adapter: `snapshot`, `run`, `screenshot`, `browser_read`, `browser_release`, `browser_relaunch`, `browser_downloads` and `browser_upload` (into and from the run's `work/`); Kernel keeps no downloads, so a run on Kernel has no `browser_downloads` | `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`, or `KERNEL_API_KEY` | yes, no |
| `monid:<provider>/<endpoint>`, `monid:<provider>/*` | One monid endpoint, or every endpoint monid lists for a provider (at most 50), each pinned at the save and run as a tool of its own, paid per call from the monid wallet: `{body?, queryParams?, pathParams?}` in, the run's `output`, `price` and `cost` out ([monid](#monid)) | `MONID_API_KEY` | no, no |
| `pdf_pages` | A workflow call only: `{path, maxPages?, dpi?}` in, `{name, pageCount, dpi, pages: [{page, image}], text}` out. Draws a document's first pages (3 by default, at 110 dpi) as PNGs under the run's `work/pages/<stem>/<dpi>/` (`<stem>`: the document's path below its directory made one name, with a short hash, so two documents of one file name never share pages), the dpi lowered so a page's long side is at most 1568 px, with its text (`pdftotext`, cut at 20,000 characters). A PNG or JPEG passes through as one page, scaled down to 1568 px. `path` is under `--documents` or the run's `work/`, never outside | `pdftoppm`, `pdftotext` | no, yes |
| `llm` | A workflow call only: `{prompt, system?, maxTokens?, tier?}` in, `{text, model, usage, cost_usd}` out. One completion on the run's model of the tier (`default`; a tier the state fills in, such as `"{requestedTier}"`, may be any of the three, and a tier with no model fails the call), no tools and no loop; `cost_usd` is null when the model has no price, never 0 | a model | no, yes |
| `subagent` | pi only: `{prompt, tools?, model?, effort?}` in, the child's last text out, bounded like a host tool's result. Runs a fresh conversation whose whole task is `prompt`, with `tools` a subset of the agent's own (by catalog or session name, MCP tools and `bash` included; absent, none), on the agent's own model or the tier `model` names (`fast` or `strong`: the definition's `model_tiers`, else `AGENT_MODEL_FAST` / `AGENT_MODEL_STRONG`, else the agent's own model) ([subagents](#subagents)) | a pi run | no, no |

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
absolute http(s) only, each once without its fragment, are the page's link targets and the URLs written out in its
text (a JSON body's: those of its string values, so an API's `url` or `shortlink` field is one; an XML body's, an Atom
or RSS feed's, read with its entities undone, so an entry's `<link href>` is one); an HTML page fetched
directly gives its link targets alone. They come with the part at offset 0: at most 200, in 20,000 characters, with
`links_omitted` counting those left out. A page is fetched once a run, at the first call for its URL, through either provider, and the
run keeps what it read of its last 8 pages by the URL asked for: every later part of that URL comes from it, with no
request, so a page's parts are always one read's. Through Parallel that is one billed extract a page a run, asked for
its first 1,000,001 characters (the extract has no offset: its text always starts at the page's start). A refusal or a
failure is a Page with `ok: false` and `refused` or `error`, never a thrown error: an agent reads why, and a workflow
can branch on it. An agent gets the Page as JSON text; a workflow's `call` node `via: "tool", tool: "web_fetch"` gets
it as its output (`args: {url, offset?, max_chars?}`, 50,000 characters of text by default, `out` a schema of that
shape). A call node naming a tool the table cannot run that way is refused before the run starts (`409`).

`web_save {url, path}` downloads one public file through the same guard (pi-browser's `publicDownload`, the same hop
loop), at most 200 MiB in at most 10 minutes, into the run's Workspace (a bare name goes under `media/`), so `..`, an
absolute path and a link are refused, and a path already in use is refused, never overwritten. The file is written once,
after the whole download, so a failed one leaves nothing. An image, audio or video is saved only when its bytes, the
declared type and the path's extension agree (`media/card.png`, never `media/card`); any other type only to a path whose
extension names the declared type. A saved mp3, wav, mp4 or m4a answers its length in seconds, `duration_s`, read from
its bytes (`media-duration.ts`); other files answer none. It makes no paid request and is never run again after a crash.
Only an agent that names `web_save` has it; no workflow node or call node may name it.

On another harness, every host tool's result reaches the model within the host's bound of 120,000 characters
(`HOST_RESULT_MAX_CHARS`, `@parcha/agentrun-kernel`): the kernel's tool bridge cuts a longer one, its start with a line
saying where it was cut, and flags the call `truncated`. Each CLI adapter tells its CLI to pass a result that long to
the model whole: the Claude Agent CLI would otherwise save a result past 50,000 characters to a file and tell the model
to read it, which a run's confinement refuses, Codex keeps only the ends of a result past 10,000 tokens, and OpenCode
would cut one past 2,000 lines or 51,200 bytes and save the rest to a file the session has no tool to read. A
`web_search` answer past 100,000 characters leaves out its least relevant results, `omitted` counting them.

### Finding and calling the run's tools

A run lists every tool to the model in full until its catalog tools (an MCP server's, a monid one) pass 20
(`DEFER_CATALOG_OVER`, `defersCatalog` in the kernel). Then they are deferred: not listed, found with `tools_search` and
run with `tools_call` (built-ins and pi's own tools are always listed). Under 20, there is no search or call: they
would find tools the model already has, at about 640 tokens on every request. Claude Code defers MCP tools itself (its
ToolSearch), so it is offered neither of the two; Codex has them and keeps its own code mode. The server makes one
decision for every harness (`SessionSpec.deferCatalog`: past 20, with both `tools_search` and `tools_call` allowed), and
Claude Code's adapter turns its ToolSearch on exactly then (`ENABLE_TOOL_SEARCH`, `claudeToolSearch`). `codemode` is
offered on every run (not Codex). Each of the three has a tool-settings key of its own, allow by default: set to `deny`,
it is not offered at all, and a call to it is refused. A deny of `tools_search` or `tools_call` therefore lists every
tool in full, on Claude Code too, where its ToolSearch is off. Settings → Tools lists the three (in
`capabilities.tools` with `meta: true`), each allow or deny; no agent grants them, so the agent editor does not offer
them. None of them goes around the run's tool settings:

- `tools_search {query, limit?}` ranks the run's tools by what they do and answers each match's name, description and
  input schema (8 by default, at most 25). It finds only tools the run may call: never one set to deny, and never these
  three.
- `tools_call {name, args}` calls one of the run's tools by name. The call is the tool's own: it is asked about at the
  gate by that tool's name, and recorded and booked under `<callId>/call`. An ask parks the run, a deny refuses it in
  the gate's words, and a name the run has no tool by (or one of these three) is refused in words with nothing run.
- `codemode {script}` runs a JavaScript script (the body of an async function) in a QuickJS sandbox. Its
  `await tools.<name>(args)` calls are each the tool's own call, under `<callId>/s<n>`, answered one at a time. A tool is
  named as `ALL_TOOLS` gives it; the description shows the first three (`tools.<name>`) and says to leave off the prefix
  a harness shows in the model's own tool list (`hands_`, `mcp__hands__`). The
  sandbox has the tools and nothing else of the run: no environment, key, file, network or timer. A tool's image (a
  screenshot) reaches the script with its pixels: `image(shot)` shows it to the model, and a returned one is the
  answer's image, its data never in the answer's text. A script runs at most
  10 minutes in 256 MiB. A call that needs approval parks the run, and the script follows Codex's rule. Once a person
  answers, the script runs again from its start, and the calls it already made answer from their records. The parked
  call runs once (or is refused), its outcome is the script's answer, and the rest of the script does not run. The
  answer lists each call before it with its result as the script read it: a JSON value as itself, never quoted. A
  refused call ends the script with the refusal. A call cut off by a crash is told as possibly done and never run again.

A paid call made through `tools_call` or a script is held at its price before it is sent and settled once, as a direct
call is, so the cap holds it. A run with a desktop or a phone has this same `codemode`, its computer's tools among
the ones a script calls (see [Computers](#computers)).

### Subagents

`subagent` is one primitive: a prompt, a fresh context and a subset of the agent's own tools, on the agent's own model
unless the call names a tier. A child keeps the run's gate, so the agent's permissions and bash policy (`read-only`)
hold its tool calls too, and every request it makes books on the run's one cap. It goes one level deep (a child is never
given `subagent` or `ask_person`), and at most 4 children of a run work at once; more wait. The run's timeline nests each
child under its call, and the run's cost counts every child's requests. How to split work and merge answers is the
agent's own instructions, never the engine's.

A call may set its child's `effort` (`low`, `medium` or `high`), its thinking level; absent, the child thinks as the agent
does. So one template can run wide reviewers at `medium` and deep ones at `high`. The run's cap bounds every child's work.

A child is a conversation in the run's own journal, owned by its call, so it lives and ends with the run:

- **A restart or a moved claim** resumes it. The next claim finds the same child, which answers its call once. A request
  it had finished is never sent again, and one the stop cut is sent again. A child on a tier whose model changed in the
  meantime (the server's `AGENT_MODEL_STRONG`, say) resumes on the tier's model now.
- **A cancel** stops every child with the run: their requests are aborted, and nothing more is asked.
- **The cap.** When the run's cap refuses a child's request, the child stops and its call fails in the cap's words
  (`subagent: it stopped before it answered: ... spend_cap_reached`). The run's next request is refused the same way, so
  the run parks at its cap (`input_required`, a `budget` pending) and sends nothing more. A raise resumes the run, not
  the child: the agent reads the failed call on its next turn and may call `subagent` again, which starts a fresh child.
  On a capped run, a call on a tier whose model has no known price is refused before any child starts.

#### Patterns

**Sample K, merge, verify.** One pass misses what a second finds, and states things neither would confirm. A template's
skill can ask for K passes and check their union, with no engine support beyond the tool:

1. In one turn, make K `subagent` calls with the same prompt and tools (K of 3 or 4 run at once; more wait their turn).
   Each starts from a fresh context, so the answers vary the way independent samples do.
2. Merge the K answers: dedupe the items that say the same thing about the same place, and keep how many children found
   each.
3. Before acting on a kept item, re-check it with the parent's own tools: open the file, page or record it cites and
   confirm it says what the item claims. Drop what does not hold. Agreement between children orders the checks; it is
   never the check.

It fits any agent whose answer is a list:

- Research: children answer with `web_search` and `web_fetch`; the parent re-fetches each cited source before it writes.
- QA: children run one test plan with `browser`; the parent reproduces each finding before it files it.
- Extraction: children pull a document's fields with `read`; the parent reads the page again for any value they differ on.
- Code review: children read a diff with read-only `bash`; the parent re-reads each finding's lines before it posts.

Each child books on the run's cap, so size the cap for K passes, not one.

### Search and fetch

`web_search` and `web_fetch` work on every harness with only a model key. Each resolves, for a run, in one order: (1) the
provider the user picked, optional: the agent's own (`definition.tool_settings`) over the server's
(`PUT /settings/tools`); (2) the native tool, the harness's own or its model provider's hosted one (on claude-agent
only where it is picked: `auto` there skips Claude's own search, an explicit `native` pick); (3) for
`web_search`, Parallel, where the server holds a Parallel key (`PARALLEL_API_KEY` in its environment, or one saved on Tool
keys): `auto` then uses that key and bills it, each search booked as the run's cost ($0.001 a search); (4) the keyless
fallback, Firecrawl's public MCP endpoint (for `web_search` with Exa's behind it). A revision's `tools` (and a pack's grant) names the capability, never a provider. On codex, `auto` is
Codex's own search, except behind a gateway, on OpenRouter (which runs neither Codex's nor Claude's own search, and
counts no searches to price) or under a spend cap (its request has no input bound, which a cap cannot
admit), where it is Parallel on the server's key, else keyless Firecrawl. `off` turns `web_search` off: nothing is
searched, and an agent naming it is refused (`409`) until it is turned on again. A pick of `firecrawl-keyless` is keyless
Firecrawl with keyless Exa behind it, and a pick of `exa-keyless` is keyless Exa alone, the key held or not.
A workflow's model nodes may each run on another tier's model, so a workflow's `web_search` never searches natively:
it is Parallel on the server's key, else keyless Firecrawl, or the provider picked, and a pick of `native` alone is
unavailable for a workflow.

| | `claude-agent` | `codex` | pi |
| --- | --- | --- | --- |
| `web_search`, `auto` (the default) | Parallel on the server's key, else keyless Firecrawl: Claude's own WebSearch is the `native` pick | Codex's own search, each search booked; behind a gateway, on OpenRouter or under a spend cap, Parallel on the server's key, else keyless Firecrawl, a host tool | one request to the run's own model provider with its hosted search (Anthropic, OpenAI direct); behind a gateway (`AGENT_MODEL_BASE_URL`) or on another provider, Parallel on the server's key, else keyless Firecrawl |
| `web_search`, `native` | Claude's own WebSearch, unavailable on OpenRouter or under a spend cap | the same, unavailable behind a gateway, on OpenRouter or under a spend cap | the same, unavailable where there is none: never a keyless search |
| `web_search`, `off` | unavailable (`web_search is turned off in settings`): nothing is searched | the same | the same |
| `web_search`, `firecrawl-keyless` | Firecrawl's public MCP search, keyless Exa's behind it, a host tool | the same | the same |
| `web_search`, `exa-keyless` | Exa's public MCP search alone, a host tool | the same | the same |
| `web_fetch`, `auto` (the default) | the guarded direct fetch where the server holds a Parallel key, else keyless Firecrawl | the same | the same |
| `web_fetch`, `firecrawl-keyless` | Firecrawl's public MCP scrape, the guarded direct fetch behind it: Firecrawl is sent each URL | the same | the same |
| `web_fetch`, `kernel` | the guarded direct fetch | the same | the same |
| either, `parallel` | Parallel's search and extract, host tools | the same | the same |

`GET /settings/tools` answers the server's settings, `{web_search: {provider}, web_fetch: {provider}, browser: {provider}}`, the default
where none is set; `PUT /settings/tools` takes the same map and replaces it (a capability it leaves out takes its
default). An agent's `definition.tool_settings` has the same shape and is over the server's. A provider is one offered
for its capability (`auto`, `native`, `firecrawl-keyless`, `exa-keyless`, `parallel` or `off` for `web_search`; `auto`,
`firecrawl-keyless`, `kernel` or `parallel` for `web_fetch`;
`auto`, `browserbase`, `kernel` or `chrome` for `browser`, [below](#tools)); an
unknown capability or provider is `422`. Any tool's settings also take a `permission`, `allow`, `ask` or `deny`, which the
tool gate holds every call to (an ask parks the run for the owner's approval), and an MCP tool's a `pin`, the arguments
its calls must carry ([MCP servers](#mcp-servers), `422` for one that is not one); a workflow's call node, which cannot wait
for an approval, refuses its run when its tool is set to ask or deny (`409`, `details.asks` or `details.denied`). The
settings are kept in the data directory
(`tool-settings.json`, 0600, written whole and durably), not a secret, and read by every run launched from then on.
`GET /capabilities` is the one tool catalog: each of the three tools there gives the providers offered (`providers`), the
server's (`provider`, its default where it sets none), the built-in default (`default_provider`) and `resolves`, what it
resolves to on each harness under the server's settings and default model (`native`, `kernel`, `firecrawl-keyless`,
`exa-keyless`, `parallel`, or `unavailable: <reason>`), with `why`, keyed the same, one plain sentence for each (`Codex's own search`,
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
allowed by default; catalog (`monid:<provider>/<endpoint>`) and MCP tools, which ask by default, are no call node's tools here.

Upgrading: a server holding `PARALLEL_API_KEY` used to read every `web_fetch` page through Parallel's extract on its own.
Now `web_fetch` on `auto` is the guarded direct fetch on such a server (keyless Firecrawl on one with no Parallel key)
unless Parallel is picked; to keep the old behaviour, set
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

With no native search and no Parallel key, web_search falls back to Firecrawl's public keyless MCP endpoint, with Exa's
behind it. Both are third-party services with their own free limits and their own terms (https://www.firecrawl.dev/terms-of-service,
https://exa.ai/terms). To turn them off, set `web_search` to `native` (native only) for the server
(`PUT /v2/settings/tools`) or for an agent (`tool_settings`). To search with a key instead, save a Parallel key on Tool
keys (or set `PARALLEL_API_KEY`): `auto` then searches through Parallel and bills the key.

Keyless Firecrawl is one MCP exchange with Firecrawl's public endpoint (`https://mcp.firecrawl.dev/v2/mcp`), with no key,
no Authorization header and no header of our own: `firecrawl_search` with the query and the number of results asked for,
or `firecrawl_scrape` with the URL, for its markdown. A call ends at 30 s and is not retried: the backend behind Firecrawl
answers it in its place. A search's 60 s are one deadline for both keyless backends: Firecrawl's 30 s leave Exa the rest,
and no backend starts once the deadline is spent. A page Firecrawl read with a status that is not 2xx, or an answer past
the bound (1 MiB for a search, the guarded fetch's 5 MiB for a page), is no read: the call goes to the backend behind
Firecrawl, and where the guarded direct fetch then reads the page, the server logs why Firecrawl gave none
(`event=web_fetch_firecrawl_failed`, never the URL). Firecrawl refuses a keyless call it will not serve with a code, and
only the code is read, never its words or its sign-up link: `KEYLESS_QUOTA_EXHAUSTED` (its free daily limit spent), `KEYLESS_ACCESS_NOT_AVAILABLE` or
`KEYLESS_TOOL_NOT_AVAILABLE` turn Firecrawl off for the rest of the run, and the same call goes to the backend behind it
(keyless Exa for `web_search`, the guarded direct fetch for `web_fetch`); `KEYLESS_LIMIT_REACHED` or a `429` is a rate
limit, and Firecrawl is held for the wait it names (60 s where it names none), with no cutoff. With Firecrawl and Exa both
off for a run, `web_search` answers `search is unavailable for the rest of this run; answer from what you have`.

`web_fetch` through keyless Firecrawl sends Firecrawl each URL it reads: Firecrawl, a third party, fetches the page and
sees the URL, its query string included, so a token in a URL's query goes to Firecrawl with it. A URL first passes the
guard's own check, and one it refuses (a private, loopback, link-local or intranet address, a name that resolves to one,
or a URL holding a user name or password) is refused as the guarded direct fetch refuses it, and never sent to Firecrawl,
to Exa or to Parallel. To keep every URL on the server, pick `kernel` for `web_fetch`, or hold a Parallel key, where
`auto` is the guarded direct fetch. A server's pick is the default only: an agent's own `tool_settings` outrank it, so an
agent (an imported template's among them) that picks `firecrawl-keyless` or `auto` still sends its URLs to Firecrawl.
Only a server's `deny` is absolute: set `web_fetch` to `deny` to stop every agent's fetches.

A `web_fetch` through keyless Firecrawl takes at most about 95 s: up to 30 s for the guard's check of the URL, 30 s for
Firecrawl, then, where Firecrawl gives no page, the guarded fetch's 30 s and 5 s to read the page.

Keyless Exa is one exchange with Exa's public MCP endpoint (`https://mcp.exa.ai/mcp`, its `web_search_exa` tool, at most
8 results, no key), dialled over IPv4 alone: the server looks Exa's name up for IPv4 and connects to that address, since
Exa takes keyless use only over IPv4, straight to its endpoint (through a proxy it answers `403`, said by name). Past its
free limit Exa answers a `429` with a Retry-After, or a tool result it marks rate-limited (`ai.exa/rateLimited`); the
search is tried once more after a jittered 1 to 3 s, or the Retry-After Exa names when it is 5 s or less (a longer one, as
for its daily limit, is not waited out). Still limited, the tool answers `{error}` in our words: `Free web search is
rate-limited right now. Try again in a minute; add the free Parallel Search server in Settings → MCP servers and grant
the agent its web_search; or add a Parallel key in Settings → Tool keys to search with a key.` Any
other failure Exa answers reads `Free web search failed. Exa said: "<the first sentence of its text>"`, cut at 120
characters; Exa's own instructions (a key for its MCP URL) are never passed on.

Every provider answers one shape, `{provider, query, results: [{url, title, snippet, published?}], text?}`, `provider`
naming the one that served it (`native`, `firecrawl-keyless`, `exa-keyless`, `parallel`), each snippet cut at 3,000 characters; the answer
the model reads ends with one line asking it to cite the URL of each result it relies on.

`web_fetch` answers a Page with `via`, a part of the page at a time (`offset`, `max_chars`, as above). With Parallel
picked the page is read through Parallel's extract (`POST https://api.parallel.ai/v1/extract`, its full content as the
text, about $0.001 an extract, one a page a run) and `via` is
`"parallel"`, with status 200 and the absolute links of its markdown; when Parallel lists the URL in its errors, answers
with no content, a 5xx or not within 60 s, it is the guarded direct fetch, `via: "direct"`, with `parallel` saying why
Parallel gave no page (`refused the key (401)`, `answered 503`, `timed out`, `listed the URL in errors`, `not tried:
refused earlier in this run`), and the model reads a line saying so; a 401 or 403 stops Parallel for the rest of the
run. A fetch Parallel was not picked for says nothing of it. Through keyless Firecrawl the page is Firecrawl's markdown
and `via` is `"firecrawl-keyless"`; a refusal or failure there is the guarded direct fetch, `via: "direct"`. A URL passes the guard's own check before anything is sent to Parallel or Firecrawl: a URL the guard
refuses is refused and never leaves the machine. A call stopped before its page arrived answers `ok: false` with
`via: "stopped"`: no page came for it (the run's read of the URL goes on for its other calls).

`web_search` through Parallel uses its Search API (`POST https://api.parallel.ai/v1/search`, its `fast` mode, about
$0.001 a search). On every provider the query is cut at 200 characters and `n` is 1 to 25 (10 by default). A result is a lead: the agent reads the page with `web_fetch`. A failure answers
`{error}`, with nothing searched instead; a 401 or 403 to either web tool stops Parallel for both for the rest of the run.

Parallel's fees are the run's spend, booked as monid's are: each search and each page Parallel extracts is marked in the
run's records before it is sent (`agentrun.tool_started`, held at its price) and settled once Parallel answers
(`agentrun.tool_cost`: `tool` `web_search` or `web_fetch`, `charged_by` `"parallel"`, `usd`), shown on its timeline
(`Tool cost: parallel charged $0.0010 for web_search`), summed into its cost and under `/usage`'s `tools` meter. Parallel
answers what it used as counts, never an amount, so each is booked at Parallel's published price
([docs.parallel.ai/resources/pricing](https://docs.parallel.ai/resources/pricing), read 2026-11-20), an estimate: a
search by its mode, `turbo` or `fast` $0.001 and `basic` or `advanced` $0.005, each for up to 10 results, and $0.001 for
each result past them (`web_search` always searches `fast`); an extract $0.001 a URL. A search in a mode with no price
here, or naming none, is never sent, as an endpoint with no price is not; on a 4xx other than a 408 nothing (Parallel refused it), and on a 408, a 5xx, a timeout or a lost
connection its price (Parallel may have billed it). Under a [spend cap](#spend-cap) each is a paid call: sent only when
what the run has spent and holds, plus its price, fits the cap. Otherwise nothing reaches Parallel: a search answers the
cap's refusal (`spend_cap_reached: Not sent: this run has spent $0 of its $0.0009 cap, and the next step, Parallel's search, could cost up to $0.001 …`) and a page is the
guarded direct fetch, with `parallel` giving the same words. One sent holds its price until Parallel answers: a model
request checked meanwhile, from any branch, tool round or harness, counts it beside what the run has spent, so the two
never pass the cap together. A workflow's `call` node naming either tool is booked the same way, under the node's own
call (its execution path).

Keyless Exa, where `web_search` resolves to it or to keyless Firecrawl (behind it), searches through Exa's public MCP endpoint (`https://mcp.exa.ai/mcp`, its
`web_search_exa` tool), with no key. What leaves the server is
the search query (cut at 200 characters) and the number of results asked for (1 to 8, 5 by default), nothing else
from the run, and no key. It goes to Exa over IPv4, straight from the run's process. Exa is a third party: its free,
keyless use has a rate limit it does not publish, and its own terms. Past that limit the search is tried once more, and
then is a tool error in our words (above): the model reads why and answers without it, and the run's later searches
are held for the wait. Exa answers its daily count running out the same way, naming no wait, so a second limit naming no
wait after a wait has passed (a 429 with Retry-After is a timed limit, and only waits), in the same run and with no search succeeding since, turns search off for the rest of that run. A search ends at 60 s, its retry
included, so a call never hangs. The answer is the query and its results, each a URL, a title, a
snippet of at most 3,000 characters and its date when Exa knows it, then a line asking the model to cite the URLs it
relies on. Keyless Exa answers behind keyless Firecrawl, the default for a harness with no native search when the server
holds no Parallel key; `off` turns `web_search` off, both included.

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
reads at once included. No vendor records it; an agent whose browser computer says `record: true` gets its own video
of each session ([A video of each run](#computers)). The owner watches the browser live, takes it over and hands it back, and
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
tool plane's words, `a local Chrome is not set up on this server`, or for Kernel with no key, that it needs a Kernel key). The
same view is the computer family's too, one for every kind (`browser`, `desktop`, `phone`), read through the same code:
`GET /v2/runs/{id}/computer` answers `{state: "live", kind, viewer, hold}` (the link under `/v2/runs/{id}/computer/live/`),
`{state: "none", kind, hold}` or `{state: "off", hold, why}`; `hold` says who drives now (`agent`, `pending` or `person`). It takes the owner's
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
browser back", or that it went back to the agent after the idle or away window), each row at the time it happened, and a
browser call that waited for the hand-back reads "Waited for you 11 s, then opened …". The owner's time counts: Take over holds
the next 15 minutes of session time at the provider's price under the run's cap first, and with no room it is refused in
the cap's words, shown in the viewer. A take-over that input keeps alive is held again every 15 minutes, and with no room
the browser goes back to the agent at the cap ("The browser went back to the agent at the run's spend cap", in the viewer
and on the timeline, with the cap's words). A take-over and an ask on the same session share one hold; an ask that joins it holds the extra stretch its own expiry needs
(refused in the cap's words without room), and a re-hold the cap refuses ends both: the take-over goes back to the agent,
and the ask expires, the agent told the cap's words. When the
browser comes back, what was held up front goes, and the time the person had stays held, at the provider's price, until
the session's next charge books it: take-overs given back with no browser call between them still meet the cap.

**The run waits for you, its browser kept.** When the agent asks the person a question (`ask_person`) with its browser open,
the run waits for the answer with that browser kept open for them: its page, the live view and Take over stay there. The
browser's own idle release (a few minutes with no browser call) doesn't apply while it waits. It is kept for the person's
window, `AGENTRUN_BROWSER_PERSON_WAIT_MIN` (whole minutes, 1 to 360; 15 by default), the same setting that bounds a
take-over with no input and an agent's hand-over ask (above, 15 minutes each by default), so the three never drift apart.
The window's session time is held under the run's cap first, at the provider's price, like a take-over's: while the run
waits, its cost grows by the browser's session time only, never by model time, and with no room under the cap the run
parks at once. An answer inside the window goes back to the agent on the same page. At the window's end the run parks and
the browser is released ("The browser was released after 15 min waiting for you" on the timeline, and the Screen tab says
so, with when, until a browser opens again), so its billing stops there. An answer after that goes on with a new
browser, opened at the agent's next browser call. A browser its provider ends before the answer says so too ("The browser
session ended while the run waited for you"). A provider's own session timeout still applies: keep the window under it.

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
  agent and vendor, in its store. Capabilities say `sign_ins: true` with a browser vendor here. A local Chrome keeps
  none: its cookies would sit on this server's disk.
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

<a id="monid"></a>
An agent is granted [monid](https://monid.ai)'s data endpoints on one key, `MONID_API_KEY`, by name:
`monid:<provider>/<endpoint>` (one, such as `monid:apollo/people/match`) or `monid:<provider>/*` (every endpoint monid
lists for the provider, at most 50). Each grant is read against monid's listing when the agent is saved, and pinned on
that revision with the endpoint's description, its input schema (`pathParams`, `queryParams`, `body`) and its price; a
provider or endpoint monid does not list, or a grant saved with no monid key, is refused at the save in words. An
endpoint monid prices by usage (per result, per unit, metered, or a matrix or tier with a usage part) is pinned too,
named or from a wildcard, and the save's `warnings` name each one (`reason` `priced_by_usage`): "monid:<provider>/<endpoint>
is priced by usage: monid can't cap what it charges, so a call can cost more than its estimate and more than the run's
cap allows." What one such call costs is known only after it has run, and monid's `maxCost` checks only its estimate,
which such a call can pass. Which endpoints an agent may call is the control: grant them by name or by provider, and
set each to deny or ask in tool settings. An edit pins again. A workflow's nodes do not bind monid endpoints yet. Each pinned endpoint is a tool of its own on every
harness, named on the wire with `__` for `:` and `/` (`monid__apollo__people__match`), asked about by default, and set by
its own name or its provider's wildcard in tool settings.
Each run is paid per call from the monid workspace's wallet, and is sent once, never retried. An async provider's
run is read until it ends, about two minutes at most, and asked to stop at monid when the run stops or it outlasts that.
A refusal comes back as `{error, status?}` in words: the wallet too low (402), a workspace control such as its budget
(`BLOCKED`), `FAILED`, `TIMED_OUT`, the provider's own error (not charged). The model reads each answer as JSON cut at
60,000 characters, the whole of it then filed under the run's `work/evidence/monid/`. An answer carries what monid
charged (`cost`, in dollars), and that charge is the run's spend: booked once in the run's own records as a tool cost
(`agentrun.tool_cost`: `tool` the endpoint's name, `charged_by` `"monid"`, `usd`), shown in its timeline on a line of its
own (`Tool cost: monid charged $0.0260 for monid:apollo/people/match`) and summed into its cost, the total its
[spend cap](#spend-cap) reads, and `/usage` grouped by meter shows it as its own meter, `tools`, apart from `tokens`.
Each run is marked in the run's records before it is sent, held at its pinned price (a per-call price; the dearest
variant of a matrix; a tiered price's default and every tier), and its approval card shows that hold; its charge
settles the mark. It is sent with that hold as monid's `maxCost`, so an endpoint monid prices higher now than when the
agent was saved is refused by monid unrun and uncharged, never booked past its hold. Once the cap lets it go, its
price is read again from monid (an inspect, which monid does not charge). One monid has moved to usage pricing since
the save is still held and sent at its pinned price, so monid runs it only at an estimate within it; its charge can
pass it (below). A call of an endpoint pinned as priced by usage is held at monid's estimate for the call's own input
instead. Its approval card reads "Priced by usage: monid estimates the cost when the call runs, and can charge more."
(`pending.price` `"priced by usage"`), and monid is sent nothing while the call waits. Once the call may run (after
the person's allow, or at once when it needs no ask), the call is first sent with `maxCost` 0, which monid refuses unrun
and uncharged, naming its estimate; that estimate is the hold, and the call is sent with it as `maxCost`. That read is
itself a paid step of the call, marked at $0 on the run's ledger before it is sent (a crash while monid holds it leaves
its charge unknown, as any cut call's) and given back when monid refused it unrun; a read monid ran (an estimate of $0,
which `maxCost` 0 lets through) is the call, settled at its charge. Under a cap, a read that ends with its charge unknown
(no answer, or `FAILED` with no cost) stops the run at once, "monid may have charged for <name> and did not say how
much, so this run's cap can't be kept; the run stopped": its $0 hold bounds nothing. Its charge can pass the estimate: then it is booked
as charged and logged ("monid charged $X, more than the $Y held"), and the run goes on while its charges fit its cap; one
that takes them past it stops the run at once in the cap's words ([Spend cap](#spend-cap)). A mark a crash left unsettled leaves the run's cost unknown, as a
model request a crash cut does, and its cap counts it at its held figure, never $0. A run that may have charged and says
no cost (`FAILED`, `TIMED_OUT`, one stopped by the run or the wait, one whose sending failed) books an unknown charge,
never $0: the run's cost reads `null`, and under a cap it counts at its held figure, the bound the cap let it go at, as
a crash-cut mark does, so the run goes on while its cap allows, in its process and in one opened again from its store;
one monid says it did not charge (refused as sent, `BLOCKED`, `STOPPED`, the provider's error) books nothing. Under a
cap, each endpoint's call is held as a model request is: unless what the run has spent plus what the call is held at
fits its `max_cost_usd`, or when the spend is unknown, the call is refused with a `spend_cap_reached` error the model
reads, naming the endpoint, its hold and the cap, the run pauses on its cap, and the call is never sent (one priced by usage has had only its estimate read). Runs go one at a time under a cap, and on
claude-agent and codex the check holds each model request still in flight at its worst case. A run sent holds its
figure until its charge is in, on every harness: a model request checked meanwhile counts it beside what the run has
spent, and a run that fails without an answer counts at it. Every harness calls an endpoint as a host tool in the run's
process, where a call a crash cut off is answered interrupted, never sent again. The key is a secret like the model
keys: a run's process gets it over its pipe, never in its environment.

## Tool keys

A tool's key comes from one of two places. The server's own environment, through its launcher: `PARALLEL_API_KEY`,
`MONID_API_KEY`, `BROWSERBASE_API_KEY` and `KERNEL_API_KEY` are among the secrets it hands the server over its pipe. Or the page, by name:
`PUT /v2/settings/tool-keys/{id}` with `{values: {NAME: "..."}}` saves one, field by field (`parallel` takes
`PARALLEL_API_KEY`, `monid` `MONID_API_KEY`, `browserbase` `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`,
`kernel` `KERNEL_API_KEY`, `typesafe` `TYPESAFE_API_KEY`, which unlocks Jev's decisions, `decisions.jev`), and `DELETE` forgets it. A model
provider's key is saved the same way (`anthropic`, `openai`, `particle` and `openrouter`, each `kind: "model"`, the others
`"tool"`): a run gets only its model providers' keys, and with no `AGENT_MODEL` a key gives the
default model ([models](#models)); its `harnesses` are pi and the harnesses that talk to that provider's API (OpenAI's:
codex and opencode; Particle's, Pi only; OpenRouter's, all four), of
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

A saved key is kept only as ciphertext: AES-256-GCM in the server's store, each value bound to its field's name, under
the seal key `AGENTRUN_SEAL_KEY`, which only the server opens it with. A run's process never gets the seal
key. With `AGENTRUN_SEAL_KEY` not set, the server keeps it in `seal/seal.key` in its data directory, beside the store,
making it at the first start: 32 random bytes in base64, 0600 in a 0700 directory, and one another user can read is
refused, not changed. It lives and dies with the data (a disk, a volume): back it up with the data directory, and keep
the two together. The store records the key's fingerprint (an HMAC of a fixed label under the key, never the key), and
the server, every runner and `import` check the key they hold against it: a store whose secrets were sealed with another
key does not start ("this store's secrets were sealed with another key; hand the server the original
AGENTRUN_SEAL_KEY"), and no key is ever made over sealed secrets, so a lost `seal.key` is never replaced by a new one.
The same holds on Postgres: a second machine with another key refuses. Only the server's start makes the key; a runner
reads it from `AGENTRUN_SEAL_KEY` or the data directory, never makes one, and is refused without one. Set
`AGENTRUN_SEAL_KEY` explicitly, the same in every process, and keep it.

A stored value that does not open is never a reason not to start. It reads `set: false, stored_unreadable: true`, and
`reenter` names those fields with why: `seal_key_changed` (sealed under another key) or `file_unreadable`. The log says
so once, naming the condition and the file, never a value; a `PUT` of the value seals it again under the current key.

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
its tools calls it on pi and on claude-agent ([below](#agents-call-a-servers-tools)). Which kind of server to choose for a
service's CLI, and why its token never goes in the box: [Give an agent tools](../../docs/connect-tools.md).

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
`url` is `https`, or `http` on loopback; a loopback URL (either scheme) is taken only on a server started with
`AGENTRUN_MCP_ALLOW_LOOPBACK=1` ([start-time switches](#start-time-switches)).

A server advertising MCP resources also lists three AgentRun-generated read operations, including when it has no
tools: `agentrun_list_resources` (`resource: "list"`), `agentrun_list_resource_templates` (`resource: "templates"`)
and `agentrun_read_resource` (`resource: "read"`). The first two take `{}`; read takes `{uri}`. They are granted,
pinned and gated like tools, using the same destination credential, but dispatch MCP resource methods. URIs are
passed to that server rather than fetched directly. Resource lists include all pages within 500 entries, 1 MiB
and one call deadline; exceeding a bound fails without a partial list. Text uses the ordinary answer filing and
credential scrub. A binary resource containing a connection credential is withheld. These three names are reserved:
an upstream ordinary tool with one of them makes preview or save fail. A name alone never grants resource authority.

### Composio

Composio is an MCP server like any other, so it needs no adapter of its own. Settings → MCP servers has a Composio
preset: you give your Composio API key, a toolkit (`github`, `slack`...), the actions to grant (picked from the
toolkit's list) and a server name, and the server has Composio make a managed MCP server for them, then saves it as an
ordinary MCP server with the key sealed as an `x-api-key` header. `POST /v2/settings/mcp-servers/composio/tools`
`{api_key, toolkit}` lists the actions; `PUT /v2/settings/mcp-servers/{name}/composio` `{api_key, toolkit, tools,
user_id?, auth_config_id?, price_usd?}` makes and saves the server. In place of `api_key`, `"api_key_env":
"COMPOSIO_API_KEY"` reads the key from that variable, as the server and each runner were started with it, at each use and keeps no copy: the
way an [API-only](#api-only) server's token saves one. That key is only ever sent to Composio's own origin, fixed in
code, so a server saved so whose address is anywhere else is refused by name and sent nothing. The body names no
address or headers (`422 not_allowed`): Composio answers the address. When the toolkit needs your account and `user_id`
(default `agentrun`) has none active, the answer's `connect_url` is Composio's page to connect it; nothing here signs
in. The server and its connect link are made against the toolkit's Composio-managed auth config (found, else made), or
against `auth_config_id`, one you already have at Composio (your own OAuth app's, say): it is read first, and one
Composio doesn't know, of another toolkit, or disabled is `422` under `auth_config_id` before anything is made. From
that save on it is yours: no delete or later save removes it, even when AgentRun made it for this or another saved
server. `price_usd` (0 or more, as a `prices` value) is what each call costs you: every granted action is saved at that
price, so a call is held under its run's cap and booked as the run's tool cost (its trace span's `usd`, the run's
`cost.usd`), as any priced MCP tool's. A re-save that names no price keeps the server's prices for the actions it still
lists. Composio's server can leave out an action it was allowed (it did for `HACKERNEWS_GET_FRONTPAGE`), so the answer's
`not_served` names any chosen action the saved server doesn't list. Both routes are the owner's session alone, and a
saved Composio server is gated, approved and shown on the Timeline as any MCP server's tools are, "not metered" until
you price them (`price_usd`, or the server's `prices`). Composio's own meta tools stay refused, and the helper actions
that connect an account are left off the server's address. Deleting the server in Settings deletes what its save made in Composio too, with the saved key: the Composio MCP server, the connected account its connect link started (the link with it) and the auth config it made (Composio's "already gone" is fine). What another saved server uses is kept until the last of them goes, and what was there before the save (an auth config or account you had) is never deleted. The `DELETE` answers `200 {deleted: true, composio: {removed, note}}`: the note says what it removed, what it kept and why, and, when Composio refuses or does not answer, what is left to remove in Composio yourself (`removed: false`; the server is still forgotten here). The console shows it. A save that fails removes in Composio what it made there and never what it found, and its error names what is left when Composio refuses that too (a 422 on a field says it in `details.composio` as well). A save over a preset server removes, once it is saved, the Composio MCP server its earlier save made, and what that save made and the new one no longer stands on (the account of another `user_id`, the auth config of another toolkit), with the key it was made with, unless another saved server uses it, and answers `composio: {removed, note}` saying so. An ordinary `PUT` that moves a preset server to another address makes it another service's server: it removes what the preset made for it in Composio as its delete would, and answers `composio` too. While Composio triggers use the server, that move, and a preset save over it as another `user_id` or auth config, are refused as its delete is (`409 composio_in_use`, naming them). Preset saves and MCP server deletes run one at a time, so a delete never removes what a save in progress reuses; an ordinary save of a preset server lists its tools at once and takes its turn only to write the server and clean up.
[Connect Composio tools and triggers](../../docs/tutorials/composio.md) walks through the preset and a Composio
trigger in the console, with each step's API call.

#### One Composio server, an account per run

A preset server is saved for one Composio user. To let each run act as its own person's account instead, save it with
`user_id: "per_run"` (a word reserved for this, never a Composio user id): the server keeps no user and no connected
account in its address, looks up no account and makes no connect link. Composio refuses an address that names no user,
even to list its tools, so the save, a refresh, a preview and an agent's save list them as `agentrun~tool-listing`, a
user no save or run can name, never stored and never used for a call. Each run then names the account its calls of that
server run as, in `mcp_auth` on its start or on a message:

```sh
curl -X POST "$BASE/v2/agents/$AGENT/runs" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"input": {"content": "..."}, "mcp_auth": {"mail": {"composio_user_id": "user-1234", "connected_account_id": "ca_abc123"}}}'
```

`composio_user_id` is a Composio user id; `connected_account_id`, optional, is one of that user's connected accounts
(`ca_...`), and without it Composio picks the user's account for the toolkit. Each request to the server carries that
user and account, the Composio key staying the server's own. The binding is kept as a `per_run` server's headers are:
sealed into the run's launch, erased from the store by the write that ends the run, never on the server's row, the
run's view, its timeline, its trace or a log line, and its values are cut from whatever the run shows. A message's
binding replaces the run's for the turn it starts. A run that names no account has its calls of the server answered, unsent, that it was
handed none, so a per-run server never calls as a default account. A malformed user or account is `422 input_invalid` at
`mcp_auth.<server>.composio_user_id` or `.connected_account_id`, and so is a binding to the preset's default user
`agentrun` (`not_allowed`: the user single-user preset servers call as); headers for such a server, or a binding for any
other server, are `422` at `mcp_auth.<server>`, and no run starts. A per-run server makes no Composio trigger: a trigger
runs as one account. A server saved for one user before this mode keeps calling as that user.

With `user_id: "per_run"`, whoever can start a run chooses its Composio user, so the host owns which user each run
binds: it binds each run to its own person and never takes the ids from that person. Only `agentrun` is
refused, so a host must not bind a per-run server to a `user_id` that a single-user server calls as.

What can go wrong, told apart:

- `403 forbidden` with `details.console_url`: the API token sent, dropped or changed a credential, which only the
  owner's console saves, or saved over or deleted a server the token did not save (the owner's, sealing a credential or
  not), which only the owner's console changes or deletes. The link opens Settings → MCP servers with the form filled in
  (name, URL, kind of credential, toolkit; for a saved server, its Change form), never the credential. A URL that could
  hold one is left out.
- `412 precondition_failed`: the server changed while the save or delete ran (another save, a sign-in, a removal), so
  nothing was written over it: read it again and try again. An owner's save that lands while the token's save or delete
  of a server it saved is under way makes the server the owner's, and the token's is this `412`.
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
letter, at most 32, with no underscores, so `mcp__<server>__<tool>` splits one way. The credential is sealed like a
[tool key](#tool-keys): AES-256-GCM under `AGENTRUN_SEAL_KEY`, bound to the server's name and its URL's origin, in the
data directory's store, which holds no value in the clear. The server does not start without its seal key. A `PUT` that
sends no `token` (or no `headers`) keeps the sealed credential, as long as the auth type and the URL's origin stay the
same: a saved credential never goes to another origin unless you send it again.

Each saved server records where its tools come from, `source` and `toolkit`, which a template's `mcp` needs are matched
on at apply ([templates](templates/README.md#agentmd)). The source is what made the server, recorded when it is saved
and never read off its address or its name: the Composio preset records `composio` and its toolkit, a `github_app`
server is `github`/`github`, and any other is `url` with no toolkit until you set one (`toolkit` in the `PUT`, in
`POST .../oauth/start` for a server you sign in to, or Settings → MCP servers). A `PUT` with no `toolkit` keeps the
record, and `DELETE` removes it with the server. A record counts only for the server it was saved with: a server saved
again under the same name after a `DELETE` starts afresh.

`GET /v2/settings/mcp-servers` and `GET .../{name}` show each server with `credential`: `sealed`, `unreadable` (sealed
under another key, or damaged: a `PUT` with the credential seals it again) or `expired` (an OAuth sign-in whose refresh
its authorization server refused: sign in again), null for `auth.type` none. No read, log line or error shows a
credential; a server's error text is cut of the values sent before it is shown. `POST .../{name}/refresh` lists the
tools again with the saved URL and credential, keeps them, and answers `{added, removed, changed, server}`: `changed`
names a tool whose title, description, schemas or annotations differ. `DELETE .../{name}` forgets the server and its
credential. Capabilities' `features.mcp_client` says `transports: ["streamable-http"]`, the `auth` types and `at_rest:
"sealed"`.

### A credential handed with each run

Some servers take a credential made for one run (a token scoped to that run's job and its person) that no saved
server could hold. Save such a server with `auth: {type: "per_run", headers?}`: it keeps no credential, and `headers`,
when sent, are used only to list its tools now. Then hand each run its own as `mcp_auth` on the run's start
(`POST /v2/runs`, `POST /v2/agents/{agent_id}/runs`), one entry for each per_run server it calls:

```sh
curl -X PUT "$BASE/v2/settings/mcp-servers/gateway" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url": "https://gateway.example.com/mcp", "auth": {"type": "per_run", "headers": {"authorization": "Bearer <a token to list with>"}}}'
curl -X POST "$BASE/v2/agents/$AGENT/runs" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"input": {"content": "..."}, "mcp_auth": {"gateway": {"headers": {"authorization": "Bearer <this run'"'"'s token>"}}}}'
```

A per_run save keeps no secret, so the API token may make it, as it may preview a server with a credential: the
credentials such a server receives are the ones each run's own caller hands it. The run's calls of that server carry
those headers, and only to the origin the server had when the run was started. The
credential is sealed into the run's launch record under `AGENTRUN_SEAL_KEY` (bound to the run's id), read at each claim, so
a resume, a restart or a lost lease uses it again, and erased from the store by the write that ends the run. It is never
in the run's saved body, its timeline, its view, a log line or an `Idempotency-Key`'s fingerprint (a retry with a new
credential answers the first request's run), and its values are cut from whatever the run shows.
`POST /v2/runs/{run_id}/messages` takes `mcp_auth` too: it replaces the run's credentials in the message's own write, so the turn the message starts (a
steer into a working run from its next model request, or a follow-up that opens an ended run again) calls with them. A
name that is not a saved per_run server is `422` at `mcp_auth.<server>`, and no run starts. A run handed no credential
for a per_run server it calls has those calls answered, unsent, that it was handed none. `POST .../{name}/refresh` lists
a per_run server's tools with no credential: save it again with `headers` for a server that lists only to a caller it
knows. The tools are those it listed at its save, so a server whose tool list varies by caller shows each run the saved
list.

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
refresh is refused with words and nothing is sent. A loopback MCP server (a `127.0.0.1` or `localhost` URL) is taken only
by a server started with `AGENTRUN_MCP_ALLOW_LOOPBACK=1` ([start-time switches](#start-time-switches)), which says this is a local install: set it only on a machine you
alone use, since loopback is this machine's other services too. Without it such a URL is refused at the save, the preview
and the sign-in, in words naming the variable, and a runner never reaches one. The runner beside such a server reaches
one, never at that server's own ports (where it listens, and its public address when that is on loopback), which the
server tells it as it starts.

A runner in its own process (`agentrun-serve runner`, in the server's container or in a service of its own) takes the
variable from its own environment alone, never from the server, the store or the data directory. Started with
`AGENTRUN_MCP_ALLOW_LOOPBACK=1`, its runs reach an MCP server on its own loopback: the machine (or container) that runner
runs on, which is the server's only when they share one. So each such runner needs the variable and, at the MCP
server's address, a server or forwarder on its own loopback. Without the variable it is refused, whatever the server
says. Such a runner never reaches loopback at a server's own port: 7340 (where a server listens unless `--port` says
otherwise), its own `AGENTRUN_PUBLIC_URL`'s port when that address is on loopback, and the addresses the server keeps in
the store at each start (where it listens, whatever its port), read at each claim. Those addresses are all it reads of
the server; it says on stderr at its start that it takes the variable. For any runner, an MCP server, a refresh's endpoint or a calendar at a refused port is refused unsent, as at a
save.

An MCP server's URL is shown on every read as its origin and `/…`: its path and query are held as a secret, sent only to
the server itself, and sending the shown URL back for a saved server keeps the saved one. A loopback MCP server is a development-only exception: its
authorization server may name endpoints on the MCP server's own loopback host, exactly as its URL writes it (never
another loopback address, the IPv6 loopback, or a name for this machine in its place), on any port but this server's own; any other
loopback endpoint is refused the same way. The host is pinned, not the port, as a local authorization server listens on
its own port. What that leaves: such an authorization server can still have this server send its sign-in and refresh
requests to other ports on that same loopback host (a port Docker publishes there, say), blind, learning only the
endpoint and its status, never a body. That is why the allowance is for development only. A sign-in at Google's authorization endpoint
(`accounts.google.com`) asks for offline access (`access_type=offline` and `prompt=consent`), the one way Google gives a
refresh token; any other authorization server's page is opened as it was. The callback exchanges the code, seals the token set (access and refresh tokens, expiry,
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
(`"tools": ["mcp:github/list_issues"]`). A save lists each server it grants a tool of, once, and checks each grant
against that listing: a server that is not saved, or can't be listed right now, is `422` naming it ("save again once it
answers"; an edit that grants nothing new from it keeps the agent's current pin for it instead), a tool it does not list
is `422` naming the server's tools, and so is a tool whose `x-mcp-header` declaration cannot be sent (on a
property not reached through `properties` alone, not a string, integer or boolean, not a header name, or declared twice).
A harness calls a tool `mcp__<server>__<tool>`; one whose name is past the 52 characters every harness's tool names
share (Composio's `SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION` on a server `slack`) is called by that name cut to
fit with a hash of its catalog name after it, and its rows, settings and approvals still name it `mcp:<server>/<tool>`.
Two grants that would be called by one such name are `422`, naming both. pi, claude-agent and codex run them (`features.mcp_client.harnesses`); on
another harness the save warns that they are not bound there yet, and a run is refused. On claude-agent, a run with MCP
tools has the Claude CLI's own tool search on: the server's tools reach the model only once its ToolSearch finds them,
and the run's other tools load as they always do. A workflow's nodes bind no MCP
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
A saved server's read also gives each tool its `grant_problems` when a grant of it is refused where it would run, in the words the
save's `422` says, under a harness id when that harness's own MCP client would drop or retype its schema.

- **Pinned.** The save keeps each granted tool on the new revision as the server listed it then (its name,
  description, input schema, annotations and price) with the server's URL then, shown as the agent's `mcp_pin` (never
  the URL); each run of that revision calls those tools, and no run lists the server. A refresh never changes a
  revision's tools; saving the agent again re-pins (an unchanged definition whose server changed a granted
  tool is a new revision). A server that keeps no credential of its own (`per_run`), or an OAuth server, that refuses the
  save's listing for its credential is pinned as its last save or refresh listed it. If the server's URL has changed since, that run's calls answer "the server's
  address changed since this run started" and nothing is sent, the new credential least of all.
- **The credential.** A run whose revision grants a server's tool is handed that server's credential at each launch
  (so a new one counts at the next), over its secrets pipe, never its environment; a run that grants none of a
  server's tools gets none of it. It stays in the run's process: no harness's CLI, file or log holds it, and a run
  that writes it into a learned workflow is refused by the secret scan.
- **Every harness** gets each granted tool as a host tool, `mcp__<server>__<tool>`, with the pinned description and
  schema, on its own channel for host tools: pi binds it in the run's process, claude-agent serves it from its `hands`
  MCP server (`mcp__hands__mcp__<server>__<tool>`; the CLI's tool search is off in such a session, so the granted tools
  are offered whole), codex hands it to Codex as a dynamic tool named `mcp_<server>__<tool>` (Codex refuses a
  dynamic tool named `mcp__*`), and opencode serves it from its `hands` MCP server. No harness's own MCP client is
  handed a server. Each call passes the run's one tool gate before anything is sent, is booked and recorded like any
  host tool, and the runner calls the server with the credential: a call set to ask parks the run with nothing sent,
  and the claim that resumes it runs the call once on the person's allow, or refuses it in their words. A tool whose
  schema Codex would drop or retype (a `not`, `patternProperties`, ...) is `422` at the save, naming the place and why.
- **A call** goes to the pinned URL alone, the 2026-07-28 revision first and a 2025-era server through its
  `initialize`; on 2026-07-28 each `x-mcp-header` parameter of the pinned tool is sent as its `Mcp-Param-*` header. No
  redirect is followed, at most 4 MiB is read, and it may take 120 s. The
  model reads the text blocks and embedded text resources joined (GitHub's `get_file_contents` answers a file as one);
  past 60,000 characters it reads the answer's first lines, whole, and the rest is filed under the run's
  `evidence/mcp/<server>/` as lines (JSON laid out a value a line, its indent capped at 32 levels, and filed as
  written when the layout would pass twice its size and 64 KiB; a line past 10,000 characters broken), the text
  naming the file and the `read` offset that goes on, so a run with `read` and no shell pages through it. With blocks
  that are neither (an image, a blob), the whole answer is filed there as JSON and the text says where. On pi, every
  host tool's answer reaches the model whole within the host's result bound, as each CLI harness is told. A tool's own error (`isError`) reaches the
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
- **Pins.** An MCP tool's own key (`mcp:<server>/<tool>`, never the wildcard) may also carry `pin`, 1 to 8 of the
  tool's top-level arguments, each to the one JSON scalar its calls must carry (`null`: the argument left out), or a
  list of 1 to 16 of them, the argument one of the list, compared strictly:
  `{"mcp:slack/slack_send_message": {"permission": "allow", "pin": {"channel_id": "C0123"}}}`,
  `{"mcp:github/pull_request_review_write": {"pin": {"event": [null, "COMMENT"], "method": ["create", "delete_pending", "submit_pending"]}}}`
  (the `code-review` template's pin). An object argument may be pinned to its keys instead: `{"keys": [...]}`, 1 to 16
  key names, holds a call whose argument, when given, is an object of those keys alone, any values (left out or `null`
  holds too), so `{"mcp:hubspot/HUBSPOT_UPDATE_CONTACT": {"pin": {"properties": {"keys": ["hs_lead_score"]}}}}` lets a
  write set that one field and no other, and refuses one that sets another with "properties keys in (hs_lead_score)".
  Two layers' keys pins of one argument hold as the keys in both. A pinned tool takes only its listed arguments: a
  call of a tool with a pin in either layer may carry only the top-level arguments its listing declares under its
  inputSchema's `properties` (the listing the run pinned when it started, the one its model is offered), beside the
  pinned ones. So an alias a server takes for a pinned argument, one its listing does not declare (Gmail's `to` for
  `recipient_email`, Slack's `channel_id` for `channel`), is refused with "`to` is not an argument of
  GMAIL_SEND_EMAIL; a pinned tool takes only its listed arguments (recipient_email is pinned)", and a pin need not
  null aliases by hand. A listing with no `properties` object closes nothing, and a tool with no pin is not closed. The gate checks a pinned
  tool's call before it runs or asks anyone, whatever the permission (an allow, an ask, a grant): a call whose arguments
  are not as pinned is refused, never sent and never asked about, and the model reads "mcp:slack/slack_send_message may
  only be called with channel_id = C0123: its destination is fixed by the agent's settings". The run's process logs a
  line naming the tool, the call and the arguments that did not hold, and its Timeline row is a failed call, as any
  refusal's. A call approved under ask is checked again before it is sent. A pin adds to a setting and is never a
  permission: the agent's pin and the server's both hold (an argument both pin takes what holds both), and where
  nothing holds both every call is refused, saying so. A template pins its sends' destinations to its parameters ([Templates](#templates)). A pin in
  `tool-settings.json` that does not read refuses every call of its tool, and `GET /settings/tools` serves it as
  `pin_broken: true`. A `PUT` that keeps the tool's key and sets no valid pin (the mark sent back as served, or the pin
  left out) keeps it broken, so saving another tool's setting never lifts it; a valid pin repairs it, and leaving the
  key out removes the setting. An agent keeps a pin of its own in `definition.tool_settings.<tool>.pin`, and the gate
  holds its runs to it and to the server's.
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
or `https` address, with no user or password in it, on a public host: a loopback or private-network address is refused
unless the operator allows it (`AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1`, below; [start-time switches](#start-time-switches)). Two kinds of message are POSTed to it about runs: `run.needs_input` when a run comes to
need its person (`input_required`: a question, a call held for approval, a pause at its cap, an ask for its person in
its browser, desktop or phone, or a stopped turn) and `run.ended` when it ends
(completed, failed or cancelled, once the run's end is written). A [schedule](#schedules) whose firing fails sends a third,
`trigger.failed`; a server with no triggers never sends one.

The server follows the store's run-change feed: each run that reaches its end, or that its runner lets go waiting on a
person, is told once, in order, whichever runner wrote it, so a receiver that reads the run back on its message
(`GET /v2/runs/{id}`) reads it as the message says. The end's time is the store's, so the row's `ended_at` and the
message's `webhook-id` name one time. A wait's `webhook-id` comes from its ask (a question's, an approval's call, a
pause at the cap, a hand-over), so one ask sends one `run.needs_input`, however often the run is read and after its
answer too. Everything the webhook keeps is in the store: its messages, their tries, and which
end and which wait of each run it queued, written with each message in one transaction. While the store refuses that
write (a full disk, a busy store), nothing is sent and the log says so (`condition=outbox_unwritable`); the server tells
the notice again on its next read. A server that starts queues any end of the last day that the store holds and the
webhook has not, under the same `webhook-id` (one lost to a kill, or to a crash of the machine), and any wait a run
stands at that it has not told (one the run came to while no server was up), under its one `webhook-id`. An end before
the webhook was set is never sent.

```json
{ "type": "run.needs_input", "timestamp": "2026-11-01T12:00:00.000Z",
  "data": { "run_id": "…", "agent_id": "triage", "agent_name": "Triage", "status": "input_required", "title": "…",
            "url": "https://agents.example.com/#/runs/…", "pending": { "kind": "question" } } }
```

A message is thin: ids, the agent's name, the status, the title and a link to the run on the page; never a tool's
arguments, an output or an input, which the API reads (`GET /v2/runs/{id}`). `agent_name` is the agent's name as the
message is built (a rename after it is not sent again), or its id when it has none. The title is the run's own, as the store holds it: a trigger's
run is titled from its trigger, `<Source> <name>` and the event when its source names one ("Webhook reviews:
pull_request opened"), never from its input; a workflow run's from its agent's name and its input; any other run's
from its input. `pending.kind` is `question` (an `ask_person`),
`approval` (a tool call that waits for a person's approval), `stopped` (a stopped turn), `budget` (a run paused at its
cap) or `browser` (the agent asked for the owner in its browser). An agent's ask for the owner on its desktop or phone
(the run's `pending.kind` `computer`) is told as `question`.

Messages are signed by the [Standard Webhooks](https://www.standardwebhooks.com) spec, so a receiver verifies them
with any of its libraries: `webhook-id` (the same on every try of a message, so it is the receiver's idempotency key),
`webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">` under
the secret's bytes. A receiver checks the signature against the raw body and refuses a timestamp more than 5 minutes
from its clock, so a replay does not pass. The first `PUT` makes the secret, `whsec_` and 32 random bytes in base64,
and answers `201` with it, once; `GET /v2/settings/webhook` never shows it. It is kept like a [tool key](#tool-keys):
sealed under the server's seal key in the store, and a replaced or removed one is kept sealed too, so a run that echoes
it is still cut. A `PUT` that changes the URL makes a new secret and shows it once, as the first does; one that keeps the
URL keeps it. `GET` and the log show the URL's origin and its last four characters, never the whole URL (a chat
service's incoming-hook URL is a credential itself). The URL is refused when it is on a private network or this machine,
by address or by any address its name resolves to, and each try resolves the name again and dials the address it
checked; an operator who sends to an internal receiver sets `AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1` where the server starts
and restarts it, which the refusal says, at the `PUT` and in a try's log entry. A `DIR/webhook.json` an earlier build left is not read: the
server says so at its start (`condition=webhook_left_over`), and a `PUT` sets the webhook again. A new secret for the
same URL is `POST /v2/settings/webhook/secret` (Settings → Webhook → Rotate secret in the console), from the owner's
signed-in session alone, as every secret write is: it answers the new secret once, as `signing_secret`, and retires the
old one at once, so every try after it is signed with the new one, a message queued before it included. A `404` says no
webhook is set. A secret that no longer opens under the server's key (sealed under another) is replaced, and shown
once, by a rotation or the next `PUT`. The URL and its secret go live together: a `PUT` whose write the store
refuses leaves the webhook as it was, and the secret it made is never used.

A try that is not answered 2xx within 15 s fails; a redirect is not followed. A failed message is tried again on the
spec's schedule, with jitter: after about 5 s, 5 min, 30 min, 2 h, 5 h and 10 h, then logged as failed
(`event=webhook condition=delivery_failed`). Each message goes on its own tries, so two queued close together can
arrive in either order: a receiver orders them by `webhook-timestamp`, or reads the run (`GET /v2/runs/{id}`). A
`410 Gone` turns the webhook off (`disabled` in `GET`, and the log says why) until a `PUT` sets it again. Pending messages are kept in the store, so the next server goes on with them after a
restart; a message can then come twice, under the same `webhook-id`. `GET /v2/settings/webhook/deliveries`
lists the last 50 attempts (`webhook_id`, type, status code, latency, error, when, and the next try's time), and
`POST /v2/settings/webhook/deliveries/{webhook_id}/redeliver` sends one of those messages again, once, under the same
`webhook-id`. `POST /v2/settings/webhook/test` sends a `webhook.test` message once and answers how it went. A webhook a
410 turned off sends nothing, a test or a redelivery included (`409 webhook_off`), until a `PUT` sets it again.
`DELETE /v2/settings/webhook` removes the webhook and drops its pending messages.

### Post to Slack

Slack shows a message, not the webhook's signed JSON, so the server can post to a Slack channel itself. In Slack, add an
incoming webhook to the channel (an app with Incoming Webhooks turned on), then paste its URL in the console under
Settings → Slack, or `PUT /v2/settings/slack` with `{"url": "https://hooks.slack.com/services/..."}` from the owner's
signed-in session. The URL must be `https://hooks.slack.com/services/...`, with no port, query or user.

The URL is the credential: anyone who has it can post to the channel. So saving it is a secret write (the API token is
refused `403`, with `details.console_url` opening Settings → Slack, never the URL), it is sealed under the server's seal key like a [tool key](#tool-keys), and no answer, log line or
delivery shows more than its last four characters. A replaced or removed URL stays sealed in the store, so a run that
echoes it, or its token, is still cut.

Each event posts one message (Block Kit, with `text` for notifications):

| Event | The message |
| --- | --- |
| `run.ended` | The agent (its `agent_name`: its name, else its id), the status in a word (completed, failed, was cancelled), the run's title linked to the run in the console. |
| `run.needs_input` | The same, with "needs you" and what the run waits on: a question, an approval, a paused cap, a hand-over or a stopped turn. |
| `trigger.failed` | The trigger's name, linked to it, and the error's code and message; and whether it turned itself off. |

```json
{ "text": "Lead triage: run completed: Qualify ACME",
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Lead triage* · run completed\n<https://agents.example.com/#/runs/…|Qualify ACME>" } },
    { "type": "context", "elements": [{ "type": "mrkdwn", "text": "AgentRun · run.ended · run `…`" }] } ] }
```

A message never carries a run's input, its output or a tool's arguments, as the webhook's never does: open the run
from the link to read them. Every string in it (an agent's or a trigger's name, a run's title, an error) is cut of the
secrets the server holds before it is saved or posted: a key typed into a name reads `[redacted]`. Every event is on by default. `PUT /v2/settings/slack` with
`{"events": {"run.needs_input": false}}` turns one off; a body with `events` alone is no secret write.

Delivery is the webhook's: the same outbox in the store, retries on the same schedule, one message per run's end or
wait, deliveries at `GET /v2/settings/slack/deliveries`, a message posted again with
`POST /v2/settings/slack/deliveries/{webhook_id}/redeliver`, and a test message with `POST /v2/settings/slack/test`.
Slack answers `200 ok`. A `404` or `410` (`no_service`, `channel_not_found`, `channel_is_archived`) turns Slack off
(`disabled` in `GET`, with Slack's word) until a URL is saved again; a test or a redelivery is then `409 slack_off`.
`DELETE /v2/settings/slack` removes the URL and drops pending messages.

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
starts an uncapped run, a workflow agent's included ([workflow runs](#a-workflow-run-under-its-cap)). The one
exception is a connected agent ([native agents](../../docs/native-agents.md)): its own CLI keeps its own limits and
AgentRun cannot hold it to a dollar cap, so a trigger on one takes no `max_cost_usd` (on the target or as the agent's
default) and no `effort`, each `422 not_allowed`, and its runs start uncapped, as the ones a caller starts do. Each run's
input ends with a line naming the schedule and the time it fired for, in its zone, and the run's `trigger` names the
trigger and the firing, in the run's view and in the runs lists (`GET /v2/runs`, `GET /v2/agents/{id}/runs`) alike;
a run a caller started has `trigger: null`.

A firing starts its run once. Its key comes from the trigger and its nominal time, it is recorded `due` in
`DIR/triggers.json` (written whole and synced) before its run starts, and the run is started under that key, so a firing
a restart drives again finds its run. A firing's key stays bound to that run: when the server stopped while setting the
run up, the firing reads `failed` ("The server stopped while setting up the run.") with that run's id, it never fires
again, the next firing goes ahead, and `POST /v2/triggers/{id}/fire` is how a person tries it again. While the trigger's last run is active (working, or waiting on a person), a firing
is `skipped`, with why (a webhook trigger with `accept` or `max_active_runs` is the exception: [each event it
takes](#webhook-triggers) starts its own run); a firing over the run limit starts its run `queued`, and one the server can't take now (busy or unavailable) stays due and is tried again. Times missed while the server was down are
one `missed` firing with their count, and the schedule goes on from now; the latest of them still fires, once, when it is
no older than the trigger's `catchup_window_s` (default an hour; 0, never), marked `catch_up`. A
firing while the last run is active (working, or parked waiting on a person) is skipped with why, never queued,
because a firing queued behind a parked run would wait as long as the person does. A firing whose run is refused is `failed`, and a webhook set on this server
gets a `trigger.failed` message for it (`data: {trigger_id, name, agent_id, agent_name, firing_key, nominal_at, error,
auto_paused}`, its `webhook-id` made from the firing's key, so a restart never sends it twice). `agent_id` is the agent
the trigger runs as, which every trigger has: a `start_run` target's agent, or the agent of the run a `message_run`
target names; `agent_name` is that agent's name as the message is built, or its id when it has none. Five failed firings in a row turn the
trigger off (`disabled: {reason: "auto_paused"}`); a firing tried again (a busy server) counts once, when it fails,
however many tries it took. A firing that starts its run resets the count, and so does turning
it on again. Run now (below) works on an auto-paused trigger too, and counts toward the streak like any firing: one that
starts its run resets it, one that fails adds to it. A trigger whose cron line or zone no longer reads here (after an
upgrade of the cron library or of the time zone data), or whose `every_s` a hand edit of its row put out of range, is
turned off alone, at a start or when it comes due
(`disabled: {reason: "source_unreadable", detail}`), and every other schedule goes on firing; turning it on again takes a
new source. A trigger's firings are driven one at a time, in order, so a firing a crash left due settles to its run
before the next one's overlap is checked. `PATCH /v2/triggers/{id}` changes it, and
`{enabled: false}` pauses it: the time it was off is skipped, not caught up. `POST /v2/triggers/{id}/fire` runs it now,
once per `Idempotency-Key` (required): the same key within `limits.idempotency_ttl_s` answers its firing, after the
firing has left the history too, and later it is a new firing that a run the key started still answers. `GET /v2/triggers/{id}/firings` lists its last 200 firings.

### Webhook triggers

A trigger with `source: {kind: "webhook"}` fires on each request to `POST /v2/hooks/{trigger_id}`: this server's one
route with no token. Its view carries that address as `hook_url`, at the server's public URL when it has one
(`AGENTRUN_PUBLIC_URL`), else the path; a schedule has none. The request is signed by the trigger's own secret under the
[Standard Webhooks](https://www.standardwebhooks.com) spec, the one this server's outbound [webhooks](#webhooks) sign
with, so a sender uses any of its libraries: `webhook-id` (1 to 255 printable ASCII characters, no space), `webhook-timestamp` (Unix seconds, within 5 minutes of this
server's clock either way) and `webhook-signature: v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">` under the
secret's bytes (several, space-separated, and any one may match). The signature is checked on the raw body, as sent and whatever its content type, before
anything else. A bad signature, a stale timestamp, an unknown trigger, one that is off and one that is not a webhook's all
answer the same `401`, so no trigger id can be found by asking; a body past 256 KiB is `413`.

The secret, `whsec_` and 32 random bytes in base64, is made with the trigger and shown in the `201` once; no `GET`
shows it. It is kept sealed under `AGENTRUN_SEAL_KEY` in the server's store, with each trigger source's other sealed settings.
`POST /v2/triggers/{id}/secret` makes a new one, shown once, and the old one signs nothing from then on. Like every
secret this server keeps (its tokens, its outbound webhook's secret), it is cut from what a run shows, from what an
import keeps and from every learning text. A secret replaced by a rotation, or whose trigger is deleted, is kept too,
sealed in a retired row of its own (scope `retired:<trigger>:<n>`), never a setting and in no `GET`: a run that quoted it
before is still cut on every later server. Retired rows are kept for good for now; dropping one once no run older than
it is left is still to come. A secret that does not open under the seal key the server starts with is
said in its log (`condition=trigger_setting_unopened`, naming the trigger), and its trigger is refused until a new
secret is made.

The request's `webhook-id`, which its signature covers, is its firing's key: the first answers `202` once the firing is
recorded, and its run starts after; the same `webhook-id` again, for a day after, answers `200` with that firing and
starts nothing (`{"ok": "duplicate"}` once the firing has left the trigger's history of 200 and the 1,000 it keeps past
it). Each trigger keeps the keys of its last day's pushed firings in `triggers.json`, at most 5,000, the oldest let go
first past that, which the log says once (`condition=trigger_seen_full`). The agent gets the trigger's input,
then the body, cut at 16 KiB, inside `<trigger-payload source="webhook" scheme="standard" untrusted>...</trigger-payload>`:
whatever the sender wrote is data, not an instruction. The tag names the signature scheme, the event as that scheme
reads it (`event="..."`), the JSON body's top-level `action` (`action="..."`) and an unsigned delivery id
(`delivery="..."`, GitHub's `X-GitHub-Delivery`) and, for a GitHub delivery, its pull request or issue's `number="..."`
(`pull_request.number`, else `issue.number`) and a pull request's `head_sha="..."` and `base_sha="..."` (40 hex each; a
comment event has neither, so no `head_sha` or `base_sha` at all), read from the signed body so the payload's cut never loses them, each when there is one, so an
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

A webhook trigger takes no `composio` signature (`422`, pointing to the console's Triggers → New app trigger): Composio's
events start runs through a [Composio trigger](#composio-triggers), whose server makes and keeps the subscription.

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
run active or not, since the events it takes are each their own work (a review per pull request); the run limit still
holds on the runner: a run past it waits `queued`. A start the server can't take now keeps the firing due and tries it
again, and past 20 firings due a new delivery answers `429`. This holds for every firing of such a trigger, a run now
(`POST /v2/triggers/{id}/fire`) included. Runs start in the order their events came; while one firing waits to be
tried again, a later one can start first.

Such a trigger can fill the runner's places and the queue behind them, starving other triggers and the runs people
start. Give it `max_active_runs` (1 to 100; `null` clears it): past that many of its runs active, a firing waits due and
is tried again, and is never skipped. It counts the runs this trigger started while they work (with the launch hook,
also a firing its host took, until that firing's run starts or its `start_by` passes), kept apart
from its history (so a long run counts however many firings follow it) and read again at each check; a run a person
opens again after it ended is that person's follow-up, not counted. Any `start_run` trigger of a pushed source (a
webhook) takes it, with or without `accept`: set, each event starts its own run, never skipped behind the last, up to the
cap; past it a firing waits due, and past 20 due an event answers `429 rate_limited` with `Retry-After`. Without
`max_active_runs`, a trigger with no `accept` keeps the overlap skip: an event while its last run is active is
`skipped`. A schedule keeps the overlap skip and takes no cap, and nor does a `message_run` target, which starts no run
(`422` for either). On a public repository, a rule for `issue_comment` or `issues` events needs a condition on
`/comment/author_association` or `/issue/author_association` (`in: ["OWNER", "MEMBER", "COLLABORATOR"]`): without one,
anyone who can comment starts runs.

A trigger's input, a started run's first message or a firing's message, is the trigger's, never the person's: it carries
the origin `{kind: "trigger", trigger_id, source, owner}`, `owner` decided by the trigger's definition as it fires and
never by its payload (true for a schedule, fired on time or by hand; false for a webhook, its body empty or not). The
model reads the very text it did; the run's timeline shows it as a `phase` row that names its source and its trigger as
it is now, "Schedule utc-check: <its first line>" (the trigger's id once it is gone), with `origin: "trigger"` and
`trigger: {id, source, owner}` (so a client labels it by its source without reading the summary), never as "You: ...",
and what the run learns reads it as the trigger's. A trigger renamed renames the row; the name it had when it fired is
not kept yet.

A trigger's target may also be `{kind: "message_run", run_id, input: {content}}`, with a webhook or a schedule source:
each firing sends its input to that run as `POST /v2/runs/{id}/messages` would (a steer, or a follow-up that opens a
completed run again), under its own cap. The run must have a cap (`422` on `target.run_id` otherwise, and a firing to a
run that has none fails), and a firing never answers a run that waits on its person (a question, an approval, its
cap): it is `skipped`, "The run is waiting on a person.", and the run still waits. The firing's key is the message's id in the run's store, which takes
one message per id; a firing driven again after a restart first looks for it there, so it sends the message once and
never opens a completed run again for one it already has. A firing to a run that is working waits for it (tried every
5 s), and a trigger holds at most 20 firings due: past them a webhook event and a run now answer `429 rate_limited`
with `Retry-After: 30`, recording nothing, and a schedule's time is `skipped`.

### Composio triggers

A trigger with `source: {kind: "composio", server, event, config}` starts a run on an event in an app that a saved
[Composio](#composio) server connects: `server` names the saved server, `event` is one of its toolkit's events
(Composio's trigger slug, `GITHUB_ISSUE_CREATED_TRIGGER`), listed with each one's config schema by `GET
/v2/settings/mcp-servers/{name}/composio/events`, and `config` is that event's config (`{owner, repo}` for a GitHub
issue). The console makes one in Triggers → New app trigger. The create does the Composio side with the server's saved
key, in order, and undoes what it made when a later step fails:

- The Composio project's webhook subscription (one a project), at this server's address `/v2/hooks/composio/{hook}`,
  the first time a trigger needs one, and reused after. Composio's secret for it is sealed under the hook's scope and
  never answered, logged or put in an event.
- The event's trigger instance, by upsert, for the account the server is connected as. Triggers with the same server,
  event and config share Composio's one instance: it is turned off only when every trigger holding it is off, and
  deleted with the last.
- The trigger here. Its `source` names what was made: `instance_id` and `hook`.

A config field named like a credential is sealed at the create. That is a field whose value is a string (not empty) or
a number, and where a word of the name, read as its singular (`tokens` as `token`), is secret, password, passwd,
passphrase, passcode, pwd, pat, token, credential, apikey, hapikey, jwt, dsn, sig, authorization, bearer or cookie;
where connection is followed by string (`connection_string`); or where the last word is key (`api_key`, `api_keys`). A
credential word right next to a count word (max, min, num, number, count, limit, total, used, usage, budget, remaining,
per, length, size or quota) names a count, not a credential: `max_tokens`, `token_count`, `token_limit`, `tokens_used`
and `maxTokens` stay as they are, a number in one too, while `access_token`, `refresh_token` and `bot_token` are sealed.
A string that is an address carrying a credential, in any scheme (`https`, `postgres`, `redis`, `amqp`,
`mongodb+srv`...), is sealed whole, whatever its field's name and at any depth: one with a user part (`user:pass@`,
`:pass@`, or a token alone as in `https://TOKEN@host`), or with a query or fragment parameter named by the rule above
(`token`, `api_key`, `access_token`, `sig`) that has a value. An address with none stays as it is; one whose user part
holds no secret (`ssh://git@host`) is sealed all the same. A field the event's schema marks with `format: "password"` or
`writeOnly: true` is sealed whatever its name; the create reads the event's schema from Composio for this. A create with
such a value below the config's top level is refused `422`, naming it. Composio's trigger schemas rarely mark a field
secret, so the name mostly decides. A number is sealed as its decimal text and stays a number in what Composio gets; a
run's output is cut of that text when it is 8 characters or more, as a string's is. The value is kept in the composio
source's sealed settings, next to the subscription's secret. Composio gets it once, in the instance's upsert. Every
answer has `"[sealed]"` in its place, and `source.sealed_config` names the field. The events list names these fields per
event under `sealed`, and the console takes them as passwords. A PATCH that leaves a sealed field out or sends
`"[sealed]"` keeps it. Any other value is a change to the config and is refused, as every config change is: to change a
key, delete the trigger and make a new one.
The trigger's delete retires the value into a sealed row until the runs that saw it end. A trigger saved by an earlier server with such a value in plain text is answered
masked by the same rule at once, at any depth (one below the top level named in `sealed_config` by its JSON Pointer),
and sealed at the next start by the same rule. After that start, without holding it up, the server reads the schema of
each event such a trigger uses, once, and seals the fields it marks the same way, logging `composio_config_sealed` per
trigger. It writes a trigger only while the trigger is as it read it: one changed or deleted meanwhile is left (its
values sealed for it removed again, the log saying `composio_config_not_sealed`) for the next start. Being already
serving, it runs no `VACUUM`: the rewrite runs with `secure_delete` on, the marker below stays, the log says
`store_scrub_not_done` with `reason=deferred`, and the next start's scrub finishes it before it serves. When Composio
can't be reached, the log says `composio_config_schemas_unread` once with a code and the next start tries again. On SQLite that rewrite runs with
`secure_delete` on, then a `VACUUM` and a WAL checkpoint,
so the store's files keep no copy of the old row: neither the one rewritten nor one an earlier update of the row left in
free space. A marker beside the database (`store.sqlite.scrub`) is written before the rewrite and removed once the
checkpoint is done. A `VACUUM` held off by another connection's write past the store's busy wait is tried once more
after a short pause. A start that finds the marker (the server stopped mid-way, or another connection held the
`VACUUM` or the checkpoint back, logged as `store_scrub_not_done`) runs the scrub again. On Postgres the old row version
stays on disk as a purged row's does (Purging a run or an agent made here: on disk). The log line names the trigger and
the field, never the value.

The create is refused before Composio is asked anything with `409 composio_no_public_url` when the server has no public
address (`AGENTRUN_PUBLIC_URL`): Composio could not reach it. `features.triggers.public_url` on `GET /v2/capabilities`
says whether there is one, never the address, and the console turns New app trigger off without one, with the line
"App triggers need this server's public address: set AGENTRUN_PUBLIC_URL and restart." A subscription at another
address is `409 composio_subscription_elsewhere` with `details.webhook_url`, in the words "Composio sends this
project's events to <url> now. Moving them here stops them arriving there: anything listening at <url> (another
AgentRun server, or a tool of yours) gets no more events." The same create with `source.move_subscription: true` moves
it here. `409 composio_not_connected` (with `details.connect_url`, Composio's page to connect it) when the server's
Composio user has no connected account, `409 composio_account_ambiguous` (`details.accounts`) when it has several: a
trigger runs as one, never one picked.

Every event of the project comes to its one route, checked by the `composio` scheme: the Standard Webhooks headers
and message, keyed by the UTF-8 bytes of the subscription's whole secret string, with the same 5-minute window, and
`webhook-id` as the firing's key. The delivery fires each trigger whose instance is its `metadata.trigger_id` and whose
`accept` takes it, each its own run. Its event is the body's `metadata.trigger_slug`, and a rule's `where` pointers
read the payload under `/data`. The agent gets the body inside `<trigger-payload source="composio" scheme="composio"
event="..." trigger_id="..." user_id="..." untrusted>`. Pausing, resuming and deleting a trigger, and the server turning
one off itself, follow on Composio once the change holds here; what Composio could not do is said, with what to do by
hand. `GET /v2/settings/mcp-servers/{name}/composio/triggers` lists a server's Composio triggers with whether Composio
has each instance on, and the subscription's place.

### GitHub triggers (Connect GitHub)

A server has at most one GitHub App, made with GitHub's app-manifest flow, and every `github` trigger (and every
GitHub template) uses it. In the console, Connect GitHub calls `POST /v2/integrations/github/connect` (`{org?, contents?}`:
`org` makes the App under an organization; `contents: "write"` asks for Contents write too, which suggested agents' pull
requests need, below) and posts the form it answers to GitHub: `action`, GitHub's new-App page, and
`manifest`, which names a name GitHub lets the person edit, the server's public URL, its hook `/v2/hooks/github`, its
callback and setup URLs, the permissions (pull requests write; contents, metadata and issues read) and the events
(`pull_request`, `issue_comment`, `release`). It needs the address GitHub can reach, `AGENTRUN_PUBLIC_URL` (`409 github_no_public_url`,
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
when it moved again. A deletion or suspension that would leave none is confirmed with GitHub's own list first: only none there turns the
github triggers off, and its list as it comes (the one removed included, when GitHub holds it active again) becomes the
list. An installation event follows the same rule: GitHub's answer to its check is taken only when no write came meanwhile
(else it is asked once more), so an older suspend never undoes a newer unsuspend. A server that closes stops its repair
and its events' checks, which write nothing after (an event cut so answers `503`, to be sent again).
`GET /v2/integrations/github` always answers 200: `{connected: false}` with no App, else `{connected: true, app_id, slug,
installations}`, never a secret. Not connected is an answer, not a 404 a browser logs as an error. `DELETE` with nothing
connected is still 404.

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
and never an `Authorization`. Its tools are listed with a token narrowed to one repository, of the first of the App's
installations (in order) that covers one; an installation whose account has none selected is passed over. GitHub that
does not answer while that token is minted (a 429, a 5xx, a rate limit's 403, no answer) is `502 github_failed`, "GitHub didn't answer: try
again", retryable, and the preview, save or refresh changes nothing. At each launch of a run that
grants its tools (its start, every resume, a relaunch after a crash) the server mints an installation token for that
run, narrowed to the one repository the run is about, with the App's permissions: a GitHub event's run uses its
installation and repository (the server's own payload tag); any other names it in its input as
`https://github.com/<owner>/<repo>`, whose installation the server asks GitHub for with the App's JWT. The token goes to
the run's MCP calls with the static headers beside it, lives only in memory (handed to the run's process over its pipe,
never its environment, journal, a log line or an answer), and is cut from whatever a run shows while it may be in use.
A run whose repository the App does not cover, or that names none, has those calls answered in words ("The GitHub App
isn't installed on owner/repo"). A token lasts an hour, and the runner mints a new one for the run 5 minutes before it
expires, so a long run's calls never carry an expired token. When that mint fails, the token held keeps working until
it expires; then the run's calls of that server are answered, unsent, that its GitHub App token expired and a new one
could not be made, with GitHub's reason, and the next launch (a resume) mints a fresh one.

An agent whose definition says `checkout: pull_request` starts each run a GitHub event about a pull request started in a
checkout of it, made by the server at each claim before the first turn ([runner/pr-checkout.ts](src/runner/pr-checkout.ts)).
It reads the repository, number, head and base from the server's own payload tag, only on a run a github trigger started
(its launch's input origin) and never from anyone's words, and runs one
command on the run's folder (a process here in Mode 1, Archil's exec in Mode 2): `git init repo`, a fetch of the head and
the base 50 commits deep, deepened until their merge base is in (about 3,200 commits at most), then a detached checkout
of the head, with refs `pr/head`, `pr/base` and `pr/merge-base`. The fetch takes an installation token minted for that
one repository with `permissions: {contents: "read"}` alone, handed to the command on its stdin and turned there into an
`Authorization` header in git's environment, scoped to GitHub's site; it is never in argv, `.git/config`, the remote's
URL (`https://github.com/<owner>/<repo>.git`), the run's folder, the agent's environment or a log line, and it is revoked
once the fetch is done. Git there reads no system or global config and fetches no tags or submodules. With no App, or one
not installed on the repository, the fetch is anonymous, which a public repository answers. The run's system prompt
carries one line: the checkout's facts, or why there is none (no pull request named, a fetch that failed, with git's
last words), so its instructions can read the change through the GitHub MCP instead. The checkout is removed when the
claim ends, and the next claim of the run makes it again.

### Email (the server's own account)

Two ways to give an agent email: Email (IMAP/SMTP, runs on your server, no public URL) vs Composio Gmail (OAuth through
Composio, needs a public URL). Email is one account per server: the server signs in to its mail servers itself with the
account's app password, reads the mailbox on a timer and sends over SMTP, so nothing outside has to reach the server.
Composio Gmail connects the account through Composio's OAuth and calls Gmail through Composio's tools; its events start
runs through a [Composio trigger](#composio-triggers), which Composio reaches at the server's public URL.

**The account.** `PUT /v2/settings/email` saves it, from the owner's signed-in session only (the token is 403). A preset
fills the servers: `gmail`, `fastmail` or `icloud`; `other` takes `imap` and `smtp` (`{host, port}`) from the body.
`outlook` is refused in words ("Outlook needs Microsoft sign-in, which this server doesn't do yet."). The password is the
account's app password (Gmail, iCloud and Fastmail each make one in the account's security settings; the account's own
sign-in password is refused by most providers), at most 1,024 characters. It is sealed under the server's seal key
(`AGENTRUN_SEAL_KEY`) and is in no answer, event or log line. Every connection is TLS: 993 and 465 from the start, any
other port with STARTTLS required. Only `127.0.0.1` is reached in the clear. `POST /v2/settings/email/test` signs in to
both servers and sends nothing. A save signs in the same way first: an account either server refuses, or one a server
can't be reached for, is 424 `upstream_failed` in the test's words (`details.imap` and `details.smtp`), with nothing
saved and any account saved before kept as it was. `DELETE` forgets the account.

**The trigger.** `{kind: "email", mailbox?: "INBOX", every_s?: 60, accept?}` reads the mailbox every `every_s` seconds
and starts a run for each new message its `accept` takes (a rule's `where` reads `/from`, `/to`, `/subject`, `/text`).
It watches from when it is made or turned on: the messages already there, and any that came while it was off, start no
runs, and its note says so ("Watching INBOX from now: the 3 messages already there won't start runs."). A create or a
turn-on waits for its first check (10 seconds at most), so the answer carries `last_check`. When the first checks fail, the first that signs in says
"Couldn't check INBOX until now; watching from now: ...". An edit of its filter or `every_s` keeps its place. Mail this
server sent starts none. A mail server out of reach is said in `last_check` and tried at the next time; one that refuses the
sign-in 3 times in a row (its first check's among them) turns the trigger off (`sign_in_refused`) until the account is
fixed and it is turned on again.

**The tools.** `email_search`, `email_read`, `email_draft`, `email_send` and `email_file`, host tools on every harness.
Reading leaves mail unread, `email_draft` sends nothing, and `email_file` files under a label or folder and never deletes.
`email_send` asks a person by default; the others are allowed.

**Thread scope.** On a run an email trigger started, `email_search`, `email_read` and `email_file` reach only the thread
of the message that started it: that message, and every message whose References or In-Reply-To links it, in any
mailbox, that its sender took part in. Anything else is answered "outside this run's thread" and never fetched. So the
words of an email can't send the agent through the rest of the inbox. An agent's own tool setting `scope: "mailbox"` on
one of those three tools reaches the whole account; a run no email started reaches the whole account either way.
Composio Gmail tools on the same agent are not thread-scoped.

**What email_send asks, even on allow.** With `email_send` set to allow, a run's first 5 sends go unasked and each one
after asks, saying "this run has sent 5 emails" (the count is the run's own record, so a pause doesn't reset it). This
stops two auto-responders answering each other. On a run an email started whose `email_read` is thread-scoped (no
`scope: "mailbox"`), a send to anyone outside the thread's people
(the account's own address and every From, To and Cc of the thread's messages) asks too, naming them ("eve@example.com
is outside this email's thread"). The pending approval carries the reason as `asks_because`, which the console's card
says above the call's arguments ("Asks because ..."). With accounts off, where no one can
approve, such a send is refused in those words.

An agent whose definition says `checkout: repository` starts each run in a checkout of the repository the run names: its
start's `repo`, else the first `https://github.com/<owner>/<repo>` in its first message (a github trigger's run, its
payload's). The same command, token and rules as a pull request's checkout fetch the remote's `HEAD` (its default branch)
one commit deep and check it out detached in `repo/` (ref `repo/head`), and list its files one a line in
`repo/.git/agentrun-files`, so an agent with `read` and no shell can still find what to open. The run's system prompt
names the repository, the branch, the commit and the list, or why there is no checkout.

### Suggested agents

The console's Suggested agents page (`#/suggestions`) connects a GitHub repository, finds where its app needs an agent,
and lets a person create or discard each suggestion. Every write to GitHub is the server's, made when a person presses
Create; no run ever holds a token that can write.

1. **Connect.** Connect GitHub as above. The page asks for `contents: "write"` unless the person unticks it; a scan needs
   only what every App holds (metadata and contents read). `GET /v2/integrations/github/repositories` lists what the
   App's installations cover (a metadata-read token per installation, revoked after; at most 500; an installation GitHub
   did not list is in `unread`).
2. **Scan.** `POST /v2/suggestions/scans` with `{repo}` (`owner/name` or its github.com URL) runs the bundled `agent-scout`
   template's agent, applied here the first time and reused: a read-only checkout of the default branch (`checkout:
   repository`), read-only bash where there is a shell, and an answer of at most five suggestions against its schema.
   Its first message lists the suggestions already decided on that repository, so none comes back. 202 with the run;
   200 while one runs; what the apply or the start refuses is the answer (`409 agent_not_runnable` with no model key).
   A scan whose run stopped without ending (at its cost cap or asking for input, or paused) is listed as `waiting`: it is
   resumed or cancelled on its run's page, and a new scan starts a new run.
3. **List.** `GET /v2/suggestions` (`?repo=`, `?status=open|created|discarded|all`; open and created by default) answers
   GitHub's state, each repository's newest scan, and its suggestions. A scan that ended is read once: each suggestion is
   checked again field by field (paths inside the repository, a client path in its language's extension and outside
   `.github/`, `.git` and `.agentrun/agents/`, typed inputs and answer, answer labels that can't end a string or a
   comment), and one that fails is dropped and listed with why in `scan.dropped`. A suggestion's id comes from its
   repository and key, so a newer scan replaces the open ones of the scan before, and a decision outlives every rescan.
   Decisions are kept in the store's settings (`suggestions.item.<id>`, `suggestions.scan.<repo>`).
4. **Discard.** `POST /v2/suggestions/{id}/discard` hides it and keeps later scans from suggesting it again;
   `POST .../restore` brings it back (the page's Undo). A created one is `409 suggestion_decided`.
5. **Create.** `GET /v2/suggestions/{id}` shows the suggestion whole: the files a create adds, rendered now, whether its
   package checks, and whether the App can open its pull request now (read from GitHub: the installation that covers the
   repository and its permissions), with the App's permissions page and the installation's page when it can't.
   `POST /v2/suggestions/{id}/create` (`{name?}`) then:
   - claims the suggestion on its row in the store, which every server on that store shares: another create of it, a
     discard or a scan's answer meanwhile is `409 home_busy` or leaves the row alone, so one agent and one pull request
     are made. A claim older than 15 minutes (a server that stopped mid-create) is taken over. A scan is reserved the
     same way before its run starts;
   - refuses before anything is written: `409 github_not_connected`, `409 github_not_installed` (`details.install_url`),
     `409 github_permission_missing` when the installation lacks Contents or Pull requests write (`details.missing`,
     `permissions_url`, `installation_url`), or `409 github_file_exists` when the repository has a file it would add;
   - mints one installation token for that repository with `{contents: write, pull_requests: write, metadata: read}`,
     revoked at the end whatever happens;
   - commits, over the default branch's head on a new branch `agentrun/<key>` (GitHub's Git Data API, no clone), the
     agent's package (`.agentrun/agents/<key>/agent.md` and `output.schema.json`, rendered here from the checked fields)
     and a client at the suggestion's path (TypeScript or JavaScript over `fetch`, Python over `urllib` taking the input
     as one dict, or a Markdown page of the HTTP calls for any other language; no dependency). It only adds files;
   - keeps that package as the imported template `github:<owner>/<repo>/.agentrun/agents/<key>` at the pushed commit,
     then applies it here (an apply refused takes the package back, deletes the branch and makes nothing). The push is
     recorded on the suggestion first, so a create after a write that failed finds the agent made from that template at
     that commit and reuses it, never making a second one;
   - opens the pull request, naming the agent's id and the variables the client reads (`AGENTRUN_URL`,
     `AGENTRUN_API_KEY`, `AGENTRUN_AGENT_<KEY>`). A pull request GitHub refuses keeps the agent (`502 github_failed`,
     `details.agent_id`), and the next create opens the pull request alone. A created suggestion answers `200` as it is.

`--faux-github` (with `--faux`) serves the list, the checks and the create from its fake App: its installation holds
contents write, its one repository answers the Git Data API and pull requests, `GET /_faux/state` on its API shows what a
create wrote, and `POST /_faux/permissions` changes what the installation holds. Its repository is also a bare git
repository beside the data, which a test's own runner checks out from. The CLI's runner is never pointed at it (a
runner's GitHub API and site have one way in, a test runner's option), so a scan on a faux CLI server finds no repository
to check out and is told so.

## Templates

A template package makes a working agent in one call: its definition, its skills and rules, and its triggers, from a
folder the server ships. `GET /v2/templates` lists them; `GET /v2/templates/{name}` reads one whole (its instructions and
every skill file, as an import shows them); `POST /v2/templates/{name}/apply` with `{parameters, overrides?: {model}}`
makes one, or nothing when a check fails (a trigger refused archives the agent it made). A
package's `version` is SemVer and never `definition.version`, the agent's revision number. A package's `composio` trigger names its
need's toolkit as its `server` (`server: github` for a required `{source: composio, toolkit: github}` need), and apply makes it
on the saved Composio server that need maps to, its `config` filled from the parameters it names
(`repo: "${parameters.repo}"`); one this server can't set up yet (no public URL, say) is skipped with a
warning, as a github trigger is with GitHub not connected. The first package is `code-review`, a code review agent for one GitHub repository;
`agent-scout` finds where a repository's app needs an agent ([Suggested agents](#suggested-agents)). The format and the
rules of an apply are in [templates/README.md](https://github.com/Parcha-ai/agentrun/blob/main/packages/serve/templates/README.md);
`agentrun template validate DIR` checks a folder as the server does.

`agentrun template eval DIR` (`agentrun-serve eval-template DIR`) runs a package's eval cases as real runs of its agent
and grades each run with the case's graders: by default on a server of its own over a temp data directory, so it never
touches yours, with each case's fake MCP servers on loopback and its corrections seeded through the learning API. Real
models cost money: each run is capped at its case's `max_cost_usd`. It exits 0 when every case passed, 1 when one
failed, 2 when nothing ran. The runner, the graders and the report are in
[templates/README.md](https://github.com/Parcha-ai/agentrun/blob/main/packages/serve/templates/README.md#running-the-evals).

| `eval-template` flag | What |
| --- | --- |
| `--case NAME` | A case to run; repeat it. Without one, every case. |
| `--runs N` | Runs of each case, in place of each case's `runs`. |
| `--server URL` | Run on that server, its token in `AGENTRUN_API_KEY` (the launcher hands it over its pipe; never printed). The agents the eval makes are archived at the end. |
| `--grader-model PROVIDER/MODEL` | The `llm` graders' model; default the server's. |
| `--report FILE` | The whole report as JSON (per case, run and grader: pass, reason, cost); a summary goes to stdout, progress to stderr. |
| `--faux MODULE` | Answer every model request from the module, as the server's `--faux` does. Not with `--server`. |

## What it serves

| Route | Here |
| --- | --- |
| `GET /health` | Without a credential: whether the store reads and the disk has room ([capacity and health](#capacity-and-health)). |
| `GET /capacity` | This server's own (`capacity/1`): the runs waiting for a runner and held by one, each live runner's version, slots and free slots, and the hand-backs within `?window=` minutes, read from the store ([capacity and health](#capacity-and-health)). Served under `AGENTRUN_API_ONLY=1` too. |
| `GET /openapi.json` | Without a credential: this API as an OpenAPI 3.1 document, the `agentrun.v2/0` contract (vendored in `src/openapi/`, its source in `info`) with this server's own routes marked `x-agentrun-serve`, the operations it answers `501` marked `x-agentrun-serve-unsupported`, and a contract operation that takes more than the contract gives marked `x-agentrun-serve-changed` with each change named; `links.openapi` in capabilities points at it. |
| `GET /capabilities` | Without a credential. `backend: local`, every feature flag present and true only when it works; `tools`, the tools an agentic revision may name; `workflows`, what a workflow revision's model nodes get and, in `workflows.decisions.providers`, the decision providers its typed questions run on; `models`, where models come from and the model of each tier. |
| `POST /agents`, `GET /agents`, `GET /agents/{id}` | `POST` takes `{definition, skills?, note?}` and makes the agent with its first revision, current. A definition has `instructions` (an agentic revision) or `workflow` (a workflow revision, checked by the DSL first), and `name`, `description`, `model` and `thinking` (agentic only), `harness` ([harnesses](#harnesses)), `place` ([place](#place)), `tools`, `tool_settings` ([search and fetch](#search-and-fetch)), `skills` (names; each `<name>/SKILL.md` is in `skills`) and `version`, which is the number the revision gets, and `max_cost_usd`, the agent's default cap (an agentic agent's or a workflow's), kept by an edit that leaves it out and cleared only by 0 ([spend cap](#spend-cap)), and `output_schema` (agentic only, at most 64 KiB): the JSON Schema the final answer's last fenced json block meets, which a completed run's `result.output` then holds (null when the answer doesn't meet it), kept by an edit that leaves it out. A template's answer schema is set here at apply, and a run a schedule trigger starts is handed that trigger's last completed `result.output` after its message; no other source's runs are, since each of their firings is a different event. Over 32 KiB, a scheduled run is handed only the fields the producing run's schema names in `x-carried`; carried arrays lose entries from the front until they fit, and the run is told how many. A save refuses an `x-carried` that is not unique root property names. `checkout` (agentic only): `pull_request` has the server check out, before each run's first turn, the pull request the run's GitHub event names, in `repo/` at its head with its base and merge base, using a read-only token of its GitHub App that the agent never holds ([GitHub triggers](#github-triggers-connect-github)); `none` clears it, and an edit that leaves it out keeps it. A field the store does not keep (`input_schema`) is `422 input_invalid` by name, and so is a definition that can never run here; one this host cannot run yet saves with `warnings` ([models](#models)). The ETag (`home_etag`) is the current revision's id. `GET /agents/{id}` adds `tools`, the tools its current revision grants with each one's provider ([search and fetch](#search-and-fetch)). It also adds `run_blockers` (`x-agentrun-serve: "runblockers/1"`): `{message, fields}` as a start with no overrides would be refused now (`409 agent_not_runnable`), or null. It is always null for an archived, native or SDK agent and for a revision whose MCP tools its first run pins, and the read asks no other service, so under the agent's `max_cost_usd` an OpenRouter decision model's missing price is named only once a save or a start has read OpenRouter's catalog: null is no promise that a start is accepted. |
| `PUT /agents/{id}/definition` | The same body, checked [the same way](#models): a new revision, its parent the current one, made current. Without `skills` the current revision's skill files carry over. A definition that is the current revision already writes nothing, so a PUT sent twice makes one revision. An agent's id and name stay those it was made with (another name is `422` on `definition.name`). Its description is a label kept on the agent, not on a revision: a PUT that names a new one makes the next revision (even when nothing else changed) and writes the description with it in one commit, so a stale or refused edit changes neither; a PUT that leaves it out keeps it. `If-Match` that is not the current ETag is `412 precondition_failed`; the store compares it again inside the commit, so of two edits that read the same revision exactly one lands. The contract's body is taken too: the definition itself, with `If-Match` required (`412` without it) and `definition.version` greater than the current one (`422`). Any such version is taken, and always makes a new revision, the same definition included; the revision is numbered as this server numbers them, the next, and the answer says which; the route reads a body holding `definition` as this one, any other as the contract's. |
| `GET /agents/{id}/revisions` | The agent's revisions, newest first: `revision`, `version`, `parent`, `kind`, `current`, `note`, `created_at` and the `definition`. |
| `POST /agents/{id}/current` | `{revision}`: one of the agent's revisions becomes current again. |
| `POST /agents/{id}/archive`, `POST /agents/{id}/unarchive` | [Archiving](#archiving): hides the agent and its runs from the lists, or shows them again. Answers the agent, with `archived_at`. |
| `DELETE /agents/{id}` | This server's own route (`x-agentrun-serve: "agentdelete/1"`): [deletes an agent another system owns](#deleting-an-agent-another-system-owns) (one an inline run made) whole, and [purges](#purging-a-run-or-an-agent-made-here) an archived agent made here. `204`; an agent made here not archived is `409 agent_not_archived`. |
| `DELETE /runs/{id}` | This server's own route (`x-agentrun-serve: "purge/1"`): [purges](#purging-a-run-or-an-agent-made-here) a run that is not live, its cost kept in every total. `204`, again on a second `DELETE`; a live run is `409 run_not_final`, and every route of a purged run is `410 purged`. |
| `DELETE /agents/{id}/sign-ins/{key}` | This server's own route (`x-agentrun-serve: "signins/1"`): forgets one of the agent's [saved sign-ins](#saved-sign-ins), at its vendor and here. `409 sign_in_held` while a run holds its save lease, or while a run it was handed is still going. |
| `POST /agents/{id}/runs`, `GET /agents/{id}/runs` | A run of the current revision, or of `revision`. An agentic run's input is `{content: string}`; a workflow run's is what its workflow's input schema takes. `file_ids` names [uploaded](#uploads) files, copied into the run's `work/inputs/` before it starts and named in its first message. `labels` (this server's own, `runlabels/1`) is the caller's map of its own strings for the run: at most 16 keys, each 1 to 63 letters, digits, `.`, `_`, `-` or `/` starting with a letter or a digit, each value 1 to 256 characters with no control character; kept as given, served as `labels` on every read of the run (`{}` when none), never read by the server otherwise, so no place for a secret. The agent's runs, newest first; `label` filters them as `GET /runs` does. |
| `GET /runs` | Every agent's runs, newest first, a page of at most 100; `agent`, `revision` and `status` narrow it, `label=<key>:<value>` (`runlabels/1`, split at the first `:`, once per request) keeps the runs holding that label, and `archived=true` lists only archived ones. A failed run's summary carries its `error`, and a waiting run's its `pending`. |
| `GET /runs/{id}` | The run: its revision, kind, status, state, result, error, `pending` (this server's own, `pending/1`: what a waiting run waits on, by `kind`: `{kind: "question", question, asked_at}` for a question it asked a person; `approval` for a tool call held for a person's approval, with the tool, its arguments and its price; `budget` for a run paused at its cap ([a run paused at its cap](#a-run-paused-at-its-cap)); `{kind: "browser", instruction, completion_condition, asked_at, expires_at}` for its agent's ask for the owner in its browser; or `{kind: "computer", computer: "desktop" \| "phone", instruction, completion_condition, asked_at, expires_at}` for its agent's ask for the owner on its desktop or phone; else null, a stopped turn's included) and cost (`basis` `reported`, `estimate` or `unpriced`, with its model requests' `tokens`: [A run's cost](#a-runs-cost-its-tokens-and-its-basis); $0 before its first model request, a cancelled run's included). |
| `GET /runs/{id}/timeline` | JSON pages with the change-number cursor (`after`, `next_after`, `reset`, `drop`, `has_more`, `final`, `wait_ms` long poll, and this server's own `limit`, 1 to 500 rows a page, default 500), or server-sent events with `Accept: text/event-stream` (`id` is the cursor, `Last-Event-ID` resumes). Rows sort by `seq`; the usage row (`Cost so far`), the run's running total, is always the last row, and moves to the end when a row comes after it. |
| `POST /runs/{id}/messages` | To an agentic run: `steer` while the agent works, `answer` when it asked the person, `follow_up` after a stop or after it completed: a completed run opens again, the same run on its own session and store, takes a place under `--max-runs` (it waits for one when none is free), and completes again. A failed or cancelled run, an archived run and a run of an archived agent are `409 not_continuable` (a run of an agent [being deleted](#deleting-an-agent-another-system-owns), `409 agent_not_runnable`); a workflow run takes none (`501`). |
| `POST /runs/{id}/stop`, `POST /runs/{id}/cancel` | Stop ends an agentic run's turn and leaves the run `input_required` and idle. Cancel ends a run `cancelled` once its process has exited. |
| `POST /runs/{id}/archive`, `POST /runs/{id}/unarchive` | [Archiving](#archiving) one run. Answers the run, with `archived_at`. |
| `GET /runs/{id}/files`, `GET /runs/{id}/files/{path}` | The files under the run's `work/`, raw, one byte range at a time on asking (`Range`, `206`); and its screen recordings under `recordings/` ([A video of each run](#computers)). |
| `POST /files`, `PUT /files/{id}`, `GET /files`, `GET` and `DELETE /files/{id}` | [Uploads](#uploads): a file sent in one call (`POST /v2/files?path=...`, its bytes the body), or reserved and then sent (`PUT /v2/files/{id}`); the server's uploads listed, read and deleted. |
| `GET /agents/{id}/home/files`, and `GET`, `PUT`, `DELETE` on a file's path below it | The files in the agent's home, listed, read, written and deleted ([agent home](#agent-home)). This server's own routes (`x-agentrun-serve: "home/1"`). |
| `GET /stats` | This server's own route, outside the contract (`x-agentrun-serve: "stats/1"`): the agents, the runs (`total`, `active`, `needs_input`, `failed`, `needs_review`, `status_unknown`), each agent's run count, the cost and what is archived, read from the agent store's aggregates and verified source reports; source completion counters are read when needed to separate overlapping usage. Archived agents and runs are left out of every number but `archived`. A completed or cancelled run counts only in `runs.total`, but for an escalated one (completed, waiting for a person's review), which `needs_review` (`stats/3`) counts; `failed` never does. Each running run is in exactly one of `active` (queued or working) and `needs_input` (`input_required`), both from the runs this server holds, and `status_unknown`: a running run it does not hold, or holds as ended before its end is written. `cost.usd` sums the runs that ended with a cost and is null when none did, never $0, with `basis` (`reported`, `estimate` or `unpriced`: [A run's cost](#a-runs-cost-its-tokens-and-its-basis)), or null beside a null `usd`; `unknown_runs` counts the rest. `analytics` (`stats/2`) sums the runs' metrics over the runs not archived that the `from` and `to` query parameters (RFC 3339 date-times to the millisecond, an impossible one or a finer fraction refused; runs started in [`from`, `to`)) and `agent` pick, each optional, 400 when malformed: `filter` echoes them; `totals` (runs, completed, an escalated run included, `needs_review` (`stats/3`), failed, never an escalated run, `runs_with_metrics`, `runs_with_token_metrics`, tokens and each token kind, requests, unmetered, `cost_usd` and `unknown_cost_runs`), `time` (`wall_ms` over the ended runs, `active_ms` where metrics have it), `by_harness_effort`, `by_day` (UTC), `by_source` (`live` or the import source) and the top 20 `tools`. Token totals sum only runs with every token counter reported, counted by `runs_with_token_metrics`; other runs remain in `runs` but cannot hide the known partial total. If runs exist but none reports a complete count, `tokens` is null; an empty scope is zero. Individual token-kind totals remain null when a measured run reports that counter as unknown. `analytics.usage` combines recorded runs and connected source reports ([Unified token usage](#unified-token-usage)). `learning` (`learning/1`) counts the runs that tried to learn over the same filters, from the store ([Learning](#learning)). The query bounds `analytics` and `learning` alone. |
| `GET /runs/{id}/graph` | A workflow run drawn, live: its workflow, the DSL's `workflowGraph`, each node's state (a map's items with their labels and the branch each route took for them, a route's branch), every decision with its receipt (answers, evidence, the state the judge saw, image links), every call with its input and output, and the totals (cost, null when any part is unknown). While the run goes it reads the run process's `live.json`, rewritten every 300 ms, never the run's store, which the process holds; once it ended, its store is read lock-free, so a poll never waits on it and never answers `home_busy`. An agentic run has none (`404`). |
| `GET /runs/{id}/usage` | This server's own (`runusage/1`): what one run cost, line by line: its model requests by model and provider, its paid tool calls by who charged for them, its browser time by provider, its computers' time by provider and resource (`runusage/4`), each line by the attempt it was made in and whether that attempt is billable, with `infra_usd` beside them (`runusage/5`), joining to its `cost.usd` ([A run's cost, line by line](#a-runs-cost-line-by-line)); beside them its browser sessions (`runusage/2`) and the computers it made, each from its create to its proven delete (`runusage/3`). Lines once the run ended; `reason` says why there are none. |
| `GET /runs/{id}/trace` | A run's trace, for a person who debugs it: each model request that answered and each tool call as one span, in the order they started. A span has its `kind` (`model` or `tool`), its `name` (the model, or the tool), when it started and ended, how it ended (`status`), and the span it ran under (`parent_id`: the request that made a call, the call a subagent's request was started by). A model request also has its `tokens` (`input` not read from cache, `cache_read`, `cache_write`, `output`, and `reasoning` where reported), and its `usd`. A tool call also has the head of its arguments and of its output, as its Timeline rows show them, and what was charged under it (`usd`, `charged`, `not_metered`). A call that asked for approval ends as its approval did: `waiting` until it is answered, `refused` on a deny, `interrupted` when it was withdrawn with its run. Nothing is measured again or estimated: `model_requests` says what the run's record keeps. `priced`: each request is a span with its cost. `tokens_only`: a workflow run. Its model nodes' requests carry tokens and no cost, since the run's cost is its booking's; each of its decisions (a judge's, a route's, a verify's request) is a span too (`decision: true`), named by the model its provider answered with and labelled by its node, with its own cost. `not_recorded`: a CLI harness's record keeps no request, so its trace is its tool calls. A computer's own time is its provider's to bill and is in no span. Readable while the run goes; one read serves the run's first 2,000 spans and counts the rest in `dropped`. Its words are cut as the Timeline's are, and a run whose handed sign-in can't be read back is refused (`403`), as its graph is. The console's Dev tools tab reads it. |
| `POST /runs/{id}/pause`, `POST /runs/{id}/resume` | A workflow run: what is in flight finishes, and no node, model call or decision starts until it is resumed. Its status reads `paused`, and stays so across a server restart. An agentic run is `501`, an ended one `409`. |
| `POST /workflows/validate` | `{workflow, tools?}`: every issue a save would refuse (`[{path, code, message}]`, the DSL's validation with code not run) and what this host lacks as `warnings`. Writes nothing. A refused save's `422` carries each issue as a field under `definition.workflow`, with its `code`. |
| `GET /settings/tool-keys`, `PUT` and `DELETE /settings/tool-keys/{id}` | [Tool keys](#tool-keys), this server's own routes (`x-agentrun-serve: "toolkeys/1"`): each key's fields by name and where each is set, never a value; save one sealed, or forget it. |
| `GET /settings/mcp-server-names` | The saved MCP servers' names alone (`mcpservernames/1`), sorted, with the token, also [API-only](#api-only): no URL, auth type, header or tool. |
| `GET /settings/mcp-servers`, `POST /settings/mcp-servers/preview`, `GET`, `PUT` and `DELETE /settings/mcp-servers/{name}`, `POST .../{name}/refresh`, `POST .../{name}/oauth/start`, `GET /settings/mcp-servers/oauth/callback` and `GET .../oauth/client.json` | [MCP servers](#mcp-servers), this server's own routes (`x-agentrun-serve: "mcpservers/1"`): preview a remote MCP server's tools, save it with its credential sealed, read it back without the credential, refresh its tools, forget it, or [sign in to it with OAuth](#signing-in-with-oauth) (the callback and the client document take no token). |
| `GET /settings/tools`, `PUT /settings/tools` | This server's own: the providers of `web_search`, `web_fetch` and `browser` ([search and fetch](#search-and-fetch)). |
| `GET /runs/{id}/browser` | This server's own (`x-agentrun-serve: "liveview/1"`): the run's live browser view for the owner, `{state: "off", reason}`, `{state: "none"}` or `{state: "live", viewer}` ([the live view](#the-browsers-live-view)). |
| `POST /runs/{id}/browser/hand-back` | This server's own (`liveview/2`): the owner's answer to the agent's ask for them in its browser, `{outcome: "done" \| "cancelled"}`; the first answer wins, a different one is `409 handoff_answered` ([the live view](#the-browsers-live-view)). |
| `GET /runs/{id}/computer` | This server's own (`computer/1`): the run's live computer view for the owner, one family for every kind, `{state: "off", hold, why?}`, `{state: "none", kind, hold}` or `{state: "live", kind, viewer, hold}`, its viewer under `/runs/{id}/computer/live/`; the browser is kind `browser` here, beside its own route ([the live view](#the-browsers-live-view)). |
| `GET`, `PUT` and `DELETE /settings/webhook`, `POST /settings/webhook/test`, `GET /settings/webhook/deliveries` and `POST .../deliveries/{webhook_id}/redeliver` | [Webhooks](#webhooks), this server's own routes (`x-agentrun-serve: "webhook/1"`): the URL run notices are POSTed to, signed by the Standard Webhooks spec; never its secret but once. |
| `GET` and `POST /triggers`, `GET`, `PATCH` and `DELETE /triggers/{id}`, `POST /triggers/{id}/fire`, `GET /triggers/{id}/firings`, `POST /triggers/{id}/secret`, `POST /hooks/{id}` (no token: [signed](#webhook-triggers)) | [Schedules](#schedules), this server's own routes (`x-agentrun-serve: "trigger/1"`): schedules that start an agent's capped runs, each firing once, and their history. |
| `GET /templates`, `POST /templates/{name}/apply` | [Templates](#templates), this server's own routes (`x-agentrun-serve: "templates/1"`): the template packages it ships, and an apply that makes one's agent and triggers, all or nothing. |
| `POST /mcp` | This server's own route (`x-agentrun-serve: "mcp/1"`): the [MCP endpoint](#for-coding-agents), Streamable HTTP with one JSON-RPC message per POST (`initialize`, `ping`, `tools/list`, `tools/call`), answered as JSON, stateless. Its ten tools call these routes in process with the caller's token. The Bearer token only, never the page's cookie; a browser `Origin` other than this server's own is `403`; any other method is `405`. |
| `GET /usage` | The runs' costs, by meter, agent, key, day or region (`key` and `region` are one line, `local`). By meter, `tools` holds the runs' paid tool calls and the workflow decisions Parallel charged on its own API, as `cost.tools_usd` does. A run of unknown cost adds what it is known to have spent so far (its `so_far_usd`: each priced charge, browser time and paid tools included) and is counted in `unpriced_runs` (in the total and in each line it is unknown on), so no sum is ever null, it never passes as $0, and a total is never below a line of its own: with `unpriced_runs` above 0 the total is a lower bound. `basis` says how the costs were reached ([A run's cost](#a-runs-cost-its-tokens-and-its-basis)). |

Quotes answer `501 unsupported_here` naming the feature. Home export and import (`GET` and `PUT /agents/{id}/home`) and
`POST /runs/{id}/kill` are not served here: they answer `404`, and the served document leaves them out (its
`info.x-agentrun-serve.not_served` lists them). Capabilities declare each of the four false. No run waits out `input_wait_s` here (`null`). `limits.max_cost_usd` is the highest cap a run may name: `null` here, as any cap
above $0 is taken; it does not mean caps are unsupported ([spend cap](#spend-cap)).

### Unified token usage

`GET /stats` includes `analytics.usage`, the dashboard's single reported token total across recorded runs and
connected source sessions. It contains `tokens`, uncached `input`, `output`, `cache_read`, `cache_write`, `by_day`
and `by_harness`. A source's inclusive input plus output can establish its total even when its cache breakdown is
unavailable; the unavailable breakdown remains null. Run counts, outcomes, time and cost retain their existing
meaning and do not treat an observed session as a completed run.

`known_runs` counts usable run contributions; `unknown_runs` marks missing counters or unresolved overlap.
`observed_sessions` counts source identities with usable reports in scope, including when another view supplies
the selected total; `unknown_sessions` marks missing or
incomplete source coverage. Known and unknown counts can overlap: a selected aggregate can supply a lower bound
without proving complete coverage. A verified native session hash and runtime link observations to CLI prompt windows,
native runs, SDK runs or imported sessions. Same-source aggregates are added only when their windows prove they
do not overlap. When retained daily source reports and run counters may overlap without an exact intersection,
the result is a conservative lower bound and `unknown_runs` marks incomplete coverage, even when every source
reported its counters. Offline prompt captures may arrive on a later day, so server timestamps alone do not
prove their usage is separate from source day buckets. An imported root can include descendants with no retained
identity. When its journal exactly reconciles with its saved counters, the root’s own usage can be separated and
counted against source reports. Its full aggregate remains an alternative to the same runtime’s native total;
the larger coherent view is retained, never added to that total. An unavailable or inconsistent journal uses the
same conservative alternative. Unresolved descendant coverage stays in `unknown_runs`.
CLI/SDK run metrics may also contain reflection in a separate session. When both the full metrics and immutable
source completion counters are known, their nonnegative difference remains included. Historical CLI native
reflections can themselves appear in source observations; when that overlap is possible, their full run is a
runtime alternative too. Purged runs retain numeric counters but no private source identity: native counters
remain conservative alternatives to potentially overlapping source views. Otherwise an unproven remainder is
counted in `unknown_runs` coverage rather than silently discarded or guessed as zero.
Historical identity remains valid when learning is
disabled or revoked. Archiving a learning profile does not disconnect its observed source. Multiple collectors
reporting the same verified session use the copy with the largest reported total for each UTC day, then the freshest
receipt and stable session id. Disjoint days remain included; overlapping same-day copies are never added because
the server retains daily aggregates rather than request identities. This may leave unknown coverage when collectors
hold disjoint requests within the same day; their aggregate intersection cannot be inferred. The selected figure
is then a lower bound, not a complete count of that session.
Unbound observations have no native identity proof and remain distinct. Display names and project labels never
establish identity, so an unbound collector cannot deduplicate a separately recorded run.

Run tokens use the run's start date. Source tokens use the UTC day on which usage was observed, not a session's
lifetime total or an inferred request date. Only daily buckets fully inside `[from, to)` are counted; `partial_days`
reports boundary days excluded because their aggregate cannot be split exactly. With no `to`, today's reported
usage is included. Source history is retained for 90 days; `retention_limited` says the requested range extends
beyond it. These figures are reported coverage, not a claim that unobserved history cost zero.

`agent` may select a recorded agent and its associated sessions, or a connected session id (`os_...`) for only that
session's usage. The latter selects no recorded runs. It does not import or create an agent definition.

### Feed triggers

A feed trigger starts a run for each new or updated item in one or more feeds: RSS (2.0 and 1.0), Atom, JSON Feed, or a
plain JSON list such as GitHub's pulls API. It polls, as the email trigger does, so nothing outside has to reach the
server.

**The source.** `{kind: "feed", urls, every_s?: 900, items?, id?, accept?}`. `urls` is 1 to 20 `http` or `https` URLs,
no two alike, each read every `every_s` seconds (the schedules' bounds). `items` and `id` are JSON Pointers for a JSON
list: where its array is (`""`, the whole answer, by default) and where each item's id is (`/id` by default). A rule's
`accept` takes the event `item`; its `where` reads the payload.

**From the first poll.** A feed trigger starts watching at its first poll: making it, or turning it on again, polls at
once and answers when that poll has (10 s at most). The items already in its feeds start no run, and the check says so
(`Watching <feed> from now: the 25 items already there won't start runs.`). Turning it on again forgets what it read, so it
starts again from that poll; editing it keeps what it read. A URL added by an edit starts the same way at its own first
read.

**What fires.** Each item fires once, and again when its `updated` time moves past the one it fired on (an
incident that is updated); items with no id are told apart by link, then by title and date. Each URL keeps the keys of
the items it has seen, the larger of 1,000 and twice the feed's length, so an item that drops off and comes back stays seen.
One poll starts 20 runs at most across all its URLs, oldest first; the rest wait for the next poll, which the check says
(`Read <feed>: 26 new, 6 more at the next check.`). Each read is conditional on the last ETag and Last-Modified, and a
`304` reads nothing. A JSON list's item has no feed date of its own: it fires once, and again with `update: true` only when
the source names an `updated` pointer (`"/updated_at"`) and the date there moves on. An item first seen with no date there
does not fire when it gains one.

**When a feed fails.** A read that fails (no answer, an HTTP error, a body that isn't a feed) is said in the trigger's last
check and read again at the next poll; nothing it saw is lost. A `410`, or a `404` three checks running, stops that URL:
it is no longer read and the check names it. The trigger turns itself off (`source_unreadable`) only when every URL it
reads has stopped; edit its `urls`, then turn it on again.

**Where it may read.** The same address check as an [MCP server](#mcp-servers)'s requests: no private, link-local or
loopback address and no address of this machine, every address a name resolves to checked and the one dialled checked
again, each redirect (5 at most) checked as the first URL is. Plain `http` is read on a public address only; a private host
the owner allows for MCP sign-in is read over `https` only. A read takes 20 s at most and a body over 5 MB is refused.
A feed that declares an entity in a DTD is refused.

**The payload.** An RSS, Atom or JSON Feed item: `{id, link, title, published, updated, author, summary, categories,
feed: {title, url}, update}`, with `summary` as plain text of 4,000 characters at most and `update` true when the item
was seen before and has been updated since. A JSON list item: `{id, link, title, item, update}`, `item` the raw object (cut down,
with `item_truncated`, when it would pass 16 KB). A JSON list's source may name `fields`, 1 to 50 JSON Pointers into an
item (`["/number", "/title", "/html_url", "/user/login"]`): `item` then keeps only those, each at its own place, before the
16 KB cap, so a pull request that is large whole fires without `item_truncated`. A run it starts is titled `Feed <trigger name>: <item title>`, and its payload is marked untrusted.

### API only

`AGENTRUN_API_ONLY=1` is for a server that runs behind its caller's backend and is never opened in a browser. It
serves these routes alone:

- a run's launch (`POST /agents/{id}/runs`, `POST /runs`), read (`GET /runs/{id}`), lists (`GET /agents/{id}/runs`,
  `GET /runs`), timeline, messages, stop, cancel, kill (`501` here, as above), cap raise (`PATCH /runs/{id}`) and grade
  (`PUT /runs/{id}/grade`);
- a run's usage lines (`GET /runs/{id}/usage`): what its `cost.usd` joins, by meter, cut of the host's secrets as the
  run's read is;
- its files (`GET /runs/{id}/files`, `GET /runs/{id}/files/{path}`) and [uploads](#uploads) (`/files`);
- an agent's Archil disk (`GET` and `DELETE /agents/{id}/archil`);
- the [delete of an agent another system owns](#deleting-an-agent-another-system-owns) (`DELETE /agents/{id}`), for
  the backend whose inline runs made it;
- the [purge of a run](#purging-a-run-or-an-agent-made-here) (`DELETE /runs/{id}`) of such an agent, for that
  backend: it erases one user's runs where deleting the agent, which every user's runs share, would take them all. A
  run of an agent made here is refused, as every address not listed here is;
- the computer settings' two reads, for a backend to check before it launches: `GET /computers` (each provider, its
  key names and whether each is saved, and whether it is ready) and `GET /workspace/archil` (whether runs' folders are
  on Archil, and whether its account key is saved). Neither answers a key's value. Their writes, tests and key choices
  are the console's, refused here;
- what an agent learned, for the backend whose runs it learned from: the loop's compile turns
  (`GET /agents/{id}/learning/loop`), each learned workflow's promotion and what serves
  (`GET /agents/{id}/learning/promotions`), the cost per run (`GET /agents/{id}/learning/cost`) and a run's learning
  (`GET /runs/{id}/learning`), each cut of the host's secrets as the console's reads are; and its reset
  (`DELETE /agents/{id}/learning`, the agent and its runs kept), its one learning write served here;
- a run's hosted machine fetching this server's computerd build (`GET /computers/daemon`), with the token its create
  minted;
- `GET /capabilities`, `GET /health`, `GET /usage` and `GET /capacity`;
- the names of the MCP servers saved here (`GET /settings/mcp-server-names`, `{names}`), never a URL or a credential:
  a backend that builds runs from saved servers holds back a job whose server isn't saved, before its launch is refused;
- a deploy, for a backend that deploys agents here: a template's apply (`POST /templates/{id}/apply`, a redeploy with
  its `agent_id`), the agent's read (`GET /agents/{id}`), its revisions (`GET /agents/{id}/revisions`), a rollback
  (`POST /agents/{id}/current`), and its archive and unarchive (`POST /agents/{id}/archive`, `/unarchive`). The archive
  is what its delete (`DELETE /agents/{id}`) needs first. With the [launch hook](#launch-hook) set, the apply makes the
  package's schedule and feed triggers, and every firing that starts a run goes to the backend, which starts it through
  the API with the keys and budget it sends, a trigger the agent had before the profile included; the unarchive turns
  them on again, as no trigger route is served to. Without the hook it makes neither (`not_set_up_here`: set the hook,
  or start those runs through the API), and a trigger the agent already had stays as it was: an enabled one still fires
  here, on this server's keys, until the agent is archived, and the skip's warning says so. A webhook, GitHub, Composio or email trigger is never made here, hook
  or not, since this profile refuses the hook or setting each needs (`not_an_option`). Each skipped trigger is a warning
  under `warnings` (`triggers.<i>`), and the dry run (`dry_run: true`) plans it as `skip` in the same words;
- a Composio server's save (a new name, or a server the token saved) and the delete of a server the token saved, for a
  backend that grants its runs Composio tools. The token here never writes a secret, so the save keeps none:
  - a Composio server (`PUT /settings/mcp-servers/{name}/composio`) names its key with
    `"api_key_env": "COMPOSIO_API_KEY"`, never `api_key` (still `403`). The server keeps the variable's name, never its
    value, and reads the value it and each runner were started with at each use: the save's calls to Composio, each
    run's connection and the delete's. A new value takes effect once they start again with it. `COMPOSIO_API_KEY` is
    the one name taken (`422 invalid` for any other), and it must be set when the server is saved (`422 missing`). A
    run of a server whose variable is unset is refused before it starts (`409 agent_not_runnable`), naming it; it never
    runs without the server's tools. `toolkit`, `tools`, `auth_config_id`, `price_usd` and `user_id: "per_run"` work as
    they do on the full server;
  - `COMPOSIO_API_KEY` is a secret, so give it to the server and to each runner. The launcher hands it to each over a
    pipe, so neither process's environment holds it, and no run is handed it: the runner sends it only as the MCP
    header of a Composio server the run is granted a tool of, and a run granted none gets nothing of it;
  - the body names no address and no headers (`url` or `headers` is `422 not_allowed`): Composio answers the server's
    address, and the key read from the variable is only ever sent to Composio's own origin, fixed in code. A server
    whose saved address is anywhere else is refused by name wherever that key would be read (a refresh, a run's start),
    and nothing is sent;
  - a save over a saved name and a delete (`DELETE /settings/mcp-servers/{name}`) take only a server the token saved.
    One saved any other way (by the owner, sealing a credential or not) is `403` to both, it stays as it was, and
    nothing is sent to Composio. An owner's save over a server the token saved makes it the owner's once it lands (one
    refused with `412` leaves it the token's), and one that lands while the token's is under way wins: the token's is
    `412`.

  The names route above is the listing: there is no list or read of a server's address, auth or tools here, and no
  generic save (`PUT /settings/mcp-servers/{name}`), so the token saves no server at an address or with headers of its
  own. The preview, refresh, sign-in, Composio tool listing and every other MCP settings route stay refused. On the full
  server the token's `api_key_env` is `403`, as `api_key` is: the owner's session saves a Composio server there either
  way;
- a run's desktop or phone, for a backend that shows its user the live view and lets them take over: see below.

Here a run's computer routes take the server's token. `POST /runs/{id}/computer/viewer` mints a 5-minute link on
`AGENTRUN_PUBLIC_URL` that opens that run's live page and socket until the run ends (API doc).

Every other address is `404 not_found`, answered before the request is read further: the console at `/` and its
assets, sign-in and setup, every other `/settings` route, `POST /mcp`, triggers and their
`POST /hooks/{id}`, the agents list, an agent made or edited through `/agents`, the templates list and every other
template route, `/openapi.json`, `/llms.txt` and a browser's live view. It has no accounts: there is no page to sign in
to, so no setup code is printed. The token works as it does on every route served. Unset, `0` or `false` serve the
whole server, as before; any value other than these and `1` or `true` stops the start, in words.

So on an API-only server a run is launched inline (`POST /runs` with its definition), on an agent a template's apply
made, or on an agent made before the profile was turned on.

### Launch hook

For an install that hosts agents for other people, where the host decides who pays for each run and with which keys,
set `AGENTRUN_LAUNCH_HOOK_URL` to the host's address and `AGENTRUN_LAUNCH_HOOK_SECRET` to a Standard Webhooks secret
(`whsec_` and 32 random bytes in base64; it is one of the server's own secrets, never a run's). Each trigger firing that
would start a run (a schedule, a feed, a webhook, Composio, GitHub or email trigger, or Run now) is then POSTed to the
host, and this server starts no run for it:

```json
{ "firing_id": "fir_...", "trigger_id": "trg_...", "agent_id": "digest", "revision_id": "rev_...",
  "input": { "content": "Summarize yesterday's issues.\n\n(Started by the schedule ...)" },
  "fired_at": "2026-06-01T00:10:00Z" }
```

The POST carries `webhook-id` (the firing's id, the same if it is handed again), `webhook-timestamp` and
`webhook-signature` as [webhooks](#webhooks) do: check them with any Standard Webhooks library before reading the
body.

The host starts the run with `POST /v2/agents/{agent_id}/runs`, giving the input, its own `model_key`, `keys` and
`max_cost_usd`, and `"trigger_firing": { "trigger_id": ..., "firing_id": ... }` as it was sent, and answers 2xx within
10 s. That run is the firing's, as one this server started would be: it names the trigger and the firing, carries the
trigger's title and input origin, and the firing reads `started` with it, so the trigger's overlap check and
`max_active_runs` count it.

The run starts on the trigger's target, as the run this server would start for the firing:

- Its cap is the target's `max_cost_usd`, which the host's `max_cost_usd` may lower and never raise. A target capped at
  0.5 runs at 0.5 when the host sends 10, and at 0.2 when the host sends 0.2. A target with no cap takes the agent's
  default in its place, which the host's may lower the same way: on an agent with a $5 default, the host's 500 runs at
  5 and its 1 at 1.
- Its effort is the target's when the target sets one, else the host's `effort`, else the agent's.
- It runs on the agent's current revision and holds no computer: `revision`, `hold` or `hold_minutes` in the host's
  body is refused with 422 `not_allowed`, naming the field.
- The rest of the host's body is taken as on any start: its `model_key`, `keys` and `mcp_auth` are sealed for the run.
- Its input is the host's, followed by the trigger's last completed result when its source hands one on (a schedule
  does), as a run this server starts for it is.

The host can start the run before it answers or after. A firing it answered 2xx with no run yet reads `sent` with
`start_by`, 10 minutes after that answer, takes that one start until then, and is refused with 422 `not_due` after.
The 10 minutes run from the answer, not from `fired_at`, so a firing that reaches the host late (a catch-up, one that
waited on `max_active_runs`, one handed again after a restart) gets the same time. The server never hands a `sent`
firing over again. Until its run starts or its `start_by` passes, it holds its trigger's room as a run in progress
would: with `max_active_runs`, a later firing waits for that room, and without it the overlap check skips a later
firing, naming the held one. Once `start_by` passes it holds nothing, and a waiting firing is handed.

The firing is the run's key, so a second start for the same firing answers the same run, and the request takes no
`Idempotency-Key` (422 with one). A firing that is neither due nor taken by its host (failed, skipped, or one of
another agent's triggers) is refused with 422. A due firing takes its start only while its trigger has room for it,
by the overlap check and `max_active_runs` the server applies before it hands a firing over: one waiting on its retry
whose place another firing's run has taken since is refused with 422 `not_due`, which says why.

A hook that does not take the firing is a failed try of it, as a refused run is, unless the host started its run by
then. The firing's `error.code` is `hook_failed`, and its `reason` names the cause: the status the host answered,
`timeout` (no answer in 10 s) or `unreachable` (no connection). No answer, no connection, a 5xx or a 429 leaves the
firing due with `retry_at`, tried again on the trigger's backoff under the same `webhook-id`; any other answer, a
redirect included (it is not followed), fails it at once. A firing counts once toward the trigger's failure streak,
when it fails, however many tries it took: 5 failed firings in a row turn the trigger off, and a firing that fails
sends `trigger.failed`. A host whose start lands while its firing waits on a retry (it answered too late) has that run
made the firing's, `started`, while its trigger has room for it. A start that lands just as the server records the
hook's answer keeps the firing `started` with its run: the answer doesn't set it back to `sent`, fail it or count it.

A firing the server's stop cuts short stays due and is handed again at the next start, under the same `webhook-id`. A
`message_run` target starts no run and is unchanged.

The start prints the hook's origin, never its path or the secret. The hook is `https`: a firing's input can carry a
person's data, and the signature proves who sent it, not that no one else read it, so plain `http` is taken only for
127.0.0.0/8, `::1` or `localhost`. One of the two set without the other, a URL that is not https (or http to this
machine) or holds a user or password, or a secret that is not a `whsec_` one of 24 bytes or more stops the start, in
words.

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
`GET /v2/runs/{id}/files` lists them. A run's opening message is saved beside them as `inputs/message.md`, its
`content` byte for byte, so an agent can name it to a subagent instead of copying it (a run with no text `content` has
none; an upload at that path takes `message-2.md`); the files line never names it. An agentic run is told of them in its first message, on every harness: after the
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

With Archil on (Mode 2), uploads live on Archil, not in `DIR`, so a runner needs no disk of the server's. The server
keeps them on an Archil disk of its own, `agentrun-<server id>-files`, made by its first upload, at
`files/<file_id>/` (the same bytes and record). Listing, reading and deleting read that disk; the routes, limits and
answers are the ones above, but the bytes are held in the server's memory (up to 50 MiB a file) instead of streamed to
disk. When a run is started with `file_ids`, the server copies each file into the run's folder on its disk, at
`work/inputs/<path>` (the launch's `archil_disk`, else its agent's, made first when the agent has none), before the run
is queued, for at most 45 s. The server copies 2 files at a time across all the runs it is starting, because Archil
resets a connection carrying more large writes at once; 20 files of 10 MiB took 11 to 14 s. A copy that fails or takes
longer refuses the start with
`424 upstream_failed` ("The run's files could not be copied into its folder on Archil, so it was not started: ..."). No
run is made and what was copied is removed. The run's claim then finds its files in place and reads no upload. Files
uploaded while Archil was off stay in `DIR/files/` and are not seen while it is on, and the other way round.

In Mode 2, an uploaded file that no run names is deleted once it is older than `AGENTRUN_UPLOAD_RETENTION` (default
`7d`; a whole number with `ms`, `s`, `m`, `h` or `d`, or `off` to keep every file). The server sweeps its uploads disk
once an hour and logs `event=uploads_expired removed=N`. A file is kept while a run the store still has was started with
it, or while a run started with it in the last hour (whose row may not be written yet). A file kept by a run that has
since been deleted becomes unnamed and goes after the retention. Mode 1 keeps every upload, as before.

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
write safely by path, while the list and reads still work. `GET` and `PUT /agents/{id}/home`, the contract's packed home, are not served (`404`).

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
`claude-agent`, `codex`, `opencode`, or one of this server's harness modules adds (below). Any other is
`422 input_invalid` on `definition.harness`. Every answer names it. An edit
(`PUT /agents/{id}/definition`) that names no harness keeps the agent's, as it keeps its skill files; name `pi` to move it
back.
`GET /v2/capabilities` lists each in `harnesses`, with `available` and, when not, the `reason`, and `default_model`: the
model the harness runs when a definition names none (`provider/model-id`, as a save and a run resolve it), or null where
it runs none (the harness does not run here, or no default model here runs on it: claude-agent never takes a gateway's
model). A definition naming a
harness this server does not run yet saves with a warning on `definition.harness`, and a run of it is
`409 agent_not_runnable` with `details.harness`; it never runs on pi instead. This server runs pi always, and
`claude-agent`, `codex` and `opencode` when each adapter's package, pins and provider endpoint check out; the harness's
`reason` says what is missing. With a ChatGPT plan signed in, pi and codex need no key
([on a ChatGPT plan](#on-a-chatgpt-plan)); claude-agent and opencode still do. `claude-agent` and `codex` install themselves on first use: AgentRun never ships the
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
a tree that is not whole is installed again. Until it is installed, capabilities list the harness with `installs:
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
says its "Anthropic Skin … handles model mapping") and the run priced by OpenRouter's catalog entry; codex and opencode on its Responses API, with the model's whole id (`openai/gpt-6.1-sol`). On that key alone the defaults are
`openrouter/openai/gpt-6.1-sol` for pi (pi-ai's OpenRouter provider, on the bearer route), `anthropic/claude-sonnet-5.5` for
claude-agent and `openai/gpt-6.1-sol` for codex and opencode; a direct provider's key gives the default for its harnesses where it is
set. A model named `openrouter/<vendor>/<model>` (pi's name for it) goes through OpenRouter on every harness. An endpoint
the host names never gets OpenRouter's key: `ANTHROPIC_BASE_URL` without `ANTHROPIC_API_KEY` is refused. A model with more
than one segment after its provider (`anthropic/anthropic/claude-sonnet-5.5`) is refused, naming the form to use. A provider
that refuses the run's key (401) fails the run naming the key and where to set it ("OpenRouter refused
OPENROUTER_API_KEY (401: User not found): set it where AgentRun starts, or save it in Settings → Model keys."), on every
harness, with the provider's first sentence only.
Every request to OpenRouter carries AgentRun's app attribution (`HTTP-Referer: https://github.com/Parcha-ai/agentrun`, `X-OpenRouter-Title: AgentRun`), so a self-hosted server's usage on its own key counts toward AgentRun's listing on OpenRouter; `AGENTRUN_OPENROUTER_ATTRIBUTION=off` where AgentRun starts sends none.

**Claude Code through a gateway.** Set `ANTHROPIC_BASE_URL` to a gateway that speaks Anthropic Messages, such as
LiteLLM's `/v1/messages`, and `ANTHROPIC_API_KEY` to the key it wants, or any placeholder when it adds its own. No
Anthropic key is needed, and capabilities show claude-agent ready. The base follows `AGENT_MODEL_BASE_URL`'s rules: https,
or plain http to this machine only, with one trailing `/v1` dropped. The gateway must:

- take `POST <base>/v1/messages` (Claude Code adds `?beta=true`) with the key in `x-api-key`, never as a bearer token, and
  accept the `anthropic-version` and `anthropic-beta` headers the pinned CLI sends;
- accept Anthropic's own model ids (`claude-haiku-5-5`, with dashes);
- report each answer's usage: the run is booked from it at serve's catalog price for that id. When the gateway's
  response carries a positive `x-litellm-response-cost` (LiteLLM's), that figure is booked instead, with the catalog's
  kept beside it; a missing, malformed or zero figure (LiteLLM writes 0 on a streamed answer) leaves the catalog price.

AgentRun asks Anthropic's token count only on `api.anthropic.com`, so through a gateway a run's `max_cost_usd` holds each
request at a bound from its size instead. The same setting routes pi's Anthropic models (above). Contract test:
`test/gateway-contract.test.mjs` ("claude-agent through ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY").

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

### Harness modules

A harness is one entry in serve's harness table (`src/harness-table.ts`). Capabilities, a save's check, the runner and
the console all read that table. An owner adds harnesses with a harness module: start the server with
`--harness-module MODULE` (repeatable), or set `AGENTRUN_SERVE_HARNESS_MODULES=a,b`. A separate `agentrun-serve runner`
takes the same flag and setting, and needs them to run the module's harnesses. MODULE is a path, or a package installed
with `npm install --prefix <data>/harnesses <package>`.

A module exports `entries(builtins, kit)`, which returns new entries by id. [HARNESS.md](../../HARNESS.md) walks through
writing one, and [examples/harness-module](../../examples/harness-module/README.md) is a whole one.

An entry made without `kit` gives `label`, `steer`, `runMib`, `oneAlwaysFits`, `runs`, `onWire`, `model`, `priceModel`,
`refusal` and its `runner`, and may give `promises`; a run of it runs on its runner's `adapter(launch, extra)`. Every
harness is admitted by the `runMib` its entry declares. A module adds harnesses and never replaces one: the built-in
harnesses' facts, offers, key rows, default models and tool names are the same with any module loaded. The start of the
server, or of a separate runner, is refused, naming the module and the id, when a module:
- gives an id that does not match `^[a-z][a-z0-9-]{0,39}$`;
- takes a name serve reserves (listed in [HARNESS.md's `id` row](../../HARNESS.md#field-by-field));
- names a built-in harness;
- names an id another module adds;
- gives an entry that is missing a member;
- names in an entry's `ownKeys` a key a built-in harness owns (`HARNESS_KEY_OWNED`);
- does not resolve.

A module's entry that gives no adapter `facts` runs on the general spec, with pi's tools: capabilities list its id on
every tool pi runs (`tools[].harnesses`) and on MCP grants (`features.mcp_client.harnesses`), so an agent on it keeps
its tool choices. One that gives `facts` runs the host tools, as the other built-in harnesses do.

A module's author proves its harness with `@parcha/agentrun-serve/conformance`: the same suite (`registerHarnessConformance`),
adapter loop (`createAdapterLoop`) and host tools (`suiteHostTools`) this repository proves its own harnesses with. An ACP
agent's module runs it on `@parcha/agentrun-harness-acp/testing`'s fake ACP agent, which needs no binary, model or key.

The harnesses a module adds are listed in `capabilities.harnesses` after the built-in ones. Each offer there carries a
`label` and `promises`:
- `resume`: `exact`, `load` or `restart`.
- `tool_gate`: `every_call`, `permission` or `config`.
- `billing`: `proxy` or `plan`.

The built-in harnesses promise `exact`, `every_call` and `proxy`. These fields are marked
`x-agentrun-serve: "harness-table/1"`.

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

Archiving an agent made here or a run hides it and keeps everything of it; [purging](#purging-a-run-or-an-agent-made-here)
removes what it was given and did, its cost kept, and an agent made here is purged only once archived (an agent another
system owns is [deleted](#deleting-an-agent-another-system-owns), and is never archived here). These routes are this server's own, outside the `/v2` contract, like `GET /runs` and an agent's
revisions; capabilities list them in `features.archive`.

- `POST /v2/agents/{id}/archive` hides the agent and its runs from `GET /agents`, `GET /runs` and
  `GET /agents/{id}/runs`; `POST /v2/runs/{id}/archive` hides one run. `.../unarchive` shows them again. Each is
  idempotent (archiving again keeps the first time), takes no body, and answers what it changed.
- Archiving an agent turns off every trigger that runs as it (a `start_run` of it, a `message_run` to one of its
  runs) with the archive, in one write: `disabled: {reason: "agent_archived", detail}`, and the answer lists them in
  `triggers_off: [{id, name}]`. From then no firing starts a run of it: one that comes due anyway (waiting on its
  `max_active_runs`, or on a retry) is `skipped`, "The agent <name> is archived.". While it is archived, a trigger made
  on, turned on or aimed at it is `409 agent_archived`. Unarchiving turns none on: its answer lists those still off, and
  `PATCH /v2/triggers/{id}` `{enabled: true}` turns each on.
- Each list takes `archived=true` to list only archived ones (`false`, the default, lists the others).
- Every read by id still answers, with `archived_at` (null when it is not archived; a run's is its own, else its
  agent's): `GET /agents/{id}`, `GET /runs/{id}`, its timeline and its files. `/usage` still counts archived runs: the
  spend happened.
- A new run of an archived agent is `409 agent_not_runnable`, saying it is archived (`details.archived_at`); a run
  already going when its agent is archived keeps going.
- The store keeps an archive as `archived_at` on the agent's or the run's row, null when it is not archived.

## Purging a run or an agent made here

An owner must be able to delete what a run read. `DELETE /v2/runs/{id}` purges a run that is not live; what it cost
stays in every total.

| Purged | Kept |
| --- | --- |
| Its launch record (input, prompt), journal and timeline, messages and commands, outputs and files, the answers kept under its idempotency keys, its folders (here, and its own folder on an Archil disk; the disk is kept), its settings, its labels and summary, its agent's grades of it, and its kept learning's content | Its row, as its tombstone: id, agent, state, how it ended (a code), started and ended, `cost_usd` (an upper bound when that is all it has), its paid tools' cost, its purge time, how its learning ended (for `/stats`), and the spend figures `/usage` and a cap read from its journal, and the intervals of the computers it made (each a provider's id and its times). Its metrics keep their figures alone: counts by tool name, the effort and the cost basis, no grader's words, call arguments or results |
| Its kept learning's turn and proposal | Each kept learning row as a link alone (the run's and its learning run's ids, its state): `/usage`'s learning line reads it, and it keeps its learning run out of every run list |
| What a promotion record copied from it: a check's or an audit's disagreement's input, answers and the grader's words, and the words a hold's reason quoted from them | The record's decision, numbers and run ids, the run's among them |

- Every route of a purged run is `410 purged`, `details` its tombstone; no run list shows it. `/usage`, `/stats` and
  the spend a cap reads are as they were. A second `DELETE` is `204`; a run never here is `404`.
- The runs made from it are purged with it, each a tombstone: its audit's shadow run, the replay runs of its input,
  and a learning run its kept learning names. A replay or a shadow run a check or an audit starts while the `DELETE`
  runs holds it: `409 run_not_final` naming that run, the run not purged, and the next `DELETE` purges both. Once the
  run is purged, no replay or shadow run of it is started.
- A live run (queued, working, waiting on a person or an approval, or held by a runner), or a live run made from it,
  is `409 run_not_final` (`details.runs`), nothing purged: cancel it first. A run that ended and takes a follow-up
  (idle), or that a person stopped, is not live. Such a run reads idle a moment before its runner writes it ended: a
  `DELETE` then waits for that, up to 30 seconds, and purges it.
- A message, a trigger's message or a grade sent to the run while its `DELETE` runs waits for it, then is `410 purged`:
  nothing opens the run again or keeps a grade of it under its purge.
- `503 unavailable` while its folder on an Archil disk is not deleted there yet: the run is not purged, and the next
  `DELETE` finishes it, as it finishes a purge that stopped part way (its purge time is set last).
- On disk. On both stores the purge deletes or blanks the rows above; what the database files keep differs.
  - **SQLite:** every store connection writes with `secure_delete` on, which zeroes the bytes a write frees, and a run's
    or an agent's purge checkpoints the WAL once it commits. So the purged content is in neither `store.sqlite` nor
    its `-wal` after the `DELETE`. A checkpoint another connection holds back leaves the store's scrub marker
    (`store.sqlite.scrub`), and the next start's scrub truncates the log before it serves, a crash in between
    included. Copies outside the file are out of scope: backups, snapshots, the filesystem's own journal.
  - **PostgreSQL** (not closed): a purged row's old version stays in its table as a dead tuple. `VACUUM` (or
    autovacuum, on its schedule) only marks its space reusable; the bytes stay in the data file until a later write
    overwrites them. `VACUUM FULL` rewrites the table into a new file (under an exclusive lock), and the old file's
    blocks go back to the filesystem unwiped. Postgres's own WAL and its archived WAL keep the old values until they are
    recycled or expire, and backups keep them for their retention.
- Its agent's other runs and what the agent learned from it are kept. A promotion record keeps the run's id and the
  commits it names. A run's purge removes its diff file and its feedback line from the folder's current files, and the
  folder's history no longer serves its merge; the bytes stay in the folder's `.git` until a learning reset
  (`DELETE /v2/agents/{id}/learning`) or the agent's purge, which delete the folder whole. Each merge's feedback line goes in
  one commit by the host (none when nothing is left to remove), a line a person edited since stays, and another
  merge's diff that shows the line as context is written without it. The log and a workflow's revisions leave out its
  merges, known by the run the log names for each (its newest 200 changes). A purge takes off main only what the run
  put there, in one host commit: each learned workflow whose `workflow.json` it wrote last (over the whole history,
  past those 200; a host commit that puts a version back names that version's run) goes back, its whole folder, to
  the version before it that no purged run wrote, so another run's champion keeps serving; one it wrote new leaves
  main, its file reads `404`. No run lays its text, and a read at an older commit (a champion by its digest, an SDK
  receipt's pinned commit, a later merge's diff, which shows its files as added) never serves it. Each merge's scrub lands once, so a `DELETE` sent again
  after a stop takes no other run's same line, and a merge of the run made since is scrubbed by it. A second `DELETE`
  does this again. It covers the learning folder on this
  server; a Mode 2 agent's folder on an Archil disk keeps the run's text until a learning reset or the agent's purge.
- It takes the owner's session (the password sign-in, or the console on a server bound to loopback) or the API token;
  any other console session is `403 forbidden`, no credential `401`. An [API-only](#api-only) server purges a run of
  an agent another system owns alone; a run of an agent made here is its profile's `404` there.

An agent made here is purged the same way once archived: `DELETE /v2/agents/{id}`. Its revisions' content, name and
description, learning, triggers, saved sign-ins, own computer, disk and folders go, and each of its runs is purged.
Its row stays as its tombstone (id, archive and purge times): every route of it is `410 purged`, and no list shows it.
Not archived: `409 agent_not_archived`. A live run of it: `409 run_not_final`. Purging one agent touches no other.
An unarchive or a write to it sent while its `DELETE` runs waits for it, then is `410 purged`; after a purge stopped
part way, each is `409 agent_not_runnable` until a `DELETE` finishes it.

## Deleting an agent another system owns

An agent made by an inline run (`POST /v2/runs` with `external`) belongs to the system that sent it, which may have to
delete what it sent. `DELETE /v2/agents/{id}` deletes such an agent whole, in three steps, each done before the next:

1. The agent refuses new runs: its `archived_at` is set (only this delete sets it on such an agent, whose archive route
   is refused) and its triggers are turned off in the same write, so the refusal outlives a restart. From then a run of
   it, an inline run of its reference, a trigger's firing, an SDK run and a message that would open one of its finished
   runs again are `409 agent_not_runnable`, saying it is being deleted; so is a new trigger of it (off too), a trigger
   moved to it or one of its turned on, and a write to its home or its learning (a home file's write or delete, a
   corrections.md edit, a learned workflow's approve, retire or restore, a run's grade, a replay). Such a write sent
   while a `DELETE` runs waits for it, then finds the agent gone (`404`), so none lands after its learning went. Each of
   its runs still going, its learning runs included, is cancelled as `POST /runs/{id}/cancel` cancels it, and the
   delete waits until every one has ended.
2. Its learning is deleted by the learning module: every file of its learning folder, then its promotions and grades.
   It refuses while learning work of the agent is in flight: `409 learning_busy`, naming
   that work in `details.runs`.
3. The rest: its triggers (and what each registered at its source), its saved sign-ins (and each object at its vendor),
   its own computer, its Archil disk, each run with everything kept of it (its journal, launch record, messages, origin,
   live view, channel posts, kept learning, files and scratch folders, and the answers kept under its idempotency keys;
   a request still at work under a key when its run went keeps no answer, so a key never replays a deleted run),
   its revisions and the agent. A run whose launch named an Archil disk (`archil_disk`, the caller's) kept its folder
   there, under the agent's own folder: that folder is deleted on the disk, and the disk and everything else on it are
   kept; a disk Archil says is gone has nothing left to delete. Shared things are kept: MCP servers, keys, paired computers and uploads. What the agent owns elsewhere is
   deleted there before the record here that names it (a trigger's registration and its settings before its row, a
   sign-in's object at its vendor before its tombstone, the disk at Archil before it is forgotten, a run's folder on a
   disk its launch named before its launch record), so a failure or a crash never leaves one with nothing here to reach
   it.

`204` once it is gone; a second `DELETE`, or one of an unknown agent, is `404`. `409 runs_in_flight` (a run did not end
within 30 s, or only its application ends it, as an SDK run), `409 learning_busy` and `503 unavailable` leave the agent
refusing runs: send the `DELETE` again. `503` says which thing it owns elsewhere is not deleted there yet: a trigger's
registration (Composio failed), a saved sign-in (its vendor failed), its own computer (its provider has not deleted it),
its Archil disk (Archil failed or was not reached, a run of another agent is on it, or Archil is off on this server
with a disk still stored on the agent: turn Archil on again first), or a run's folder on a disk its launch named
(Archil failed, a computer still holds the folder, or Archil is off), or a trigger that reached the agent after the
delete removed its triggers (the next `DELETE` removes it, its registration upstream first). A delete stopped
part way (a crash) is finished the same way: every step is safe to do again.

## The console

Open the link the server prints, once, in a browser. `/` is the console (`apps/console` in the repository), on the
server's own origin, under a CSP that allows that origin only, but for the provider icons on the Keys page (below):

- **Mission Control**: the store's counts, imported history, analytics and the latest runs, available before the first
  server-run agent and without a model-provider key. Its introduction is dismissible. Connect agent and Query use
  the coding-agent selector; the page refreshes when you return from your coding agent.
- **Agents**: **Build** opens a description composer and local starter templates; **Connected agents** lists definitions,
  with archived ones behind **Archived**. Build, edit and run actions share the remembered coding-agent dropdown,
  including **API playground**. Choosing a template prepares its full definition without creating or running it.
  Each agent opens an overview beside its runs, versions and supported workflow, learning and analytics tabs.
- **Learning Dojo** (`#/dojo`): learning across connected agents, read from this server. It shows each agent's
  corrections and learned workflows, workflows waiting for review, and recent changes with their source runs. Open an agent's
  Learning tab to inspect its knowledge, enable learning, or review a pending change. Counts say when a read is
  incomplete; missing results are not shown as zero.
- **API playground**: create an agent with `POST /v2/agents`, edit its definition with
  `PUT /v2/agents/{id}/definition`, query runs with `GET /v2/runs` (or one agent's runs), or start a run on the revision
  you pick and follow it live. Query links retain the agent, state and archive filters. Build descriptions and
  templates carry into the editable create request. Edits preserve other configuration and use `If-Match` (412 when
  another revision came first). Definition management does not require a model-provider key. The existing detailed
  editor remains available at `#/agents/{id}/edit`, including making an older revision current.
- **Runs**: every run, newest first, filtered by agent and by state, archived runs behind **Archived**; the address
  keeps the filters. A run's page follows `GET /v2/runs/{id}/timeline` with a long poll, sends messages (an answer while
  it waits on `ask_person`), stops or cancels the run, shows its files and a workflow's graph, and has **Archive** or
  **Unarchive**.
- **Settings → MCP servers**: add a remote MCP server (its name, address and credential: none, a bearer token, headers,
  or **Sign in** with OAuth), **Preview** its tools and protocol, then **Save**; each saved one with its tool count and
  its credential's state, **Refresh**, **Change** (a credential left empty keeps the saved one) and **Delete**. An
  agent's Tools step lists each saved server's tools; a box ticked grants `mcp:<server>/<tool>`.

A run that reports learning also has a **Learning result** panel: the outcome, the corrections and workflow it kept,
the checks' problems, and the seed and merge revisions. Its changed
files remain available beside the result. The agent's Learning tab refreshes after returning to the console and
while visible, without replacing an open edit or review.

Its files (`index.html`, and Vite's hashed files under `/assets/`) are public and hold no data: everything it shows
comes through `/v2`. With accounts on (the default) the console asks for the owner's password
([your password](#your-password)) and the browser holds the owner's session cookie; a `?token=` link sets no cookie: the
token is for scripts and the CLI. With `AGENTRUN_ACCOUNTS=0`, the printed link (`/?launch=<code>`, a code each start
makes at random) gives the browser a console session: a cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure`
when `X-Forwarded-Proto` says https) whose value is an id made at random and kept by the server, and sends the browser
to the same address without the code. Nothing about it is derived from the API token, and a `?token=` link sets no
cookie there either, so the token alone never holds a console session (and so never writes a secret, below). The
session lasts until the browser closes or the server stops; the next start prints its own link. Without it, the console
says to open the link. Either cookie takes the place of `Authorization: Bearer` on
`/v2`: for a `GET`, and for any other method only when the request's `Origin` is the server's own origin
and its body is `application/json`, or, on a `PUT` or `POST` to a route that takes bytes (`PUT /v2/files/{id}`,
`POST /v2/files`), of any content type. A request that sends an `Authorization` header is checked on that header alone.

The repository's `npm ci && npm run build` builds the console (`apps/console`) first, and the server's build copies it
into `dist/console`; the image always carries it. A server built without it answers `/` with a 404 that says so. `/console/`
(the console's address before) and `/setup` and `/sign-in` (the old page's, which the printed setup link still names)
send the browser to `/`, which keeps a link's `#code`.

## Your password

AgentRun Server is for one person, who signs in to the console with a password (`AGENTRUN_ACCOUNTS=0` turns this off). With
no `AGENTRUN_PUBLIC_URL`, listening on loopback (the default), the start prints `Set your password: <url>/setup`, and the
first visit sets it, 12 characters or more. With a public address, or listening on any other address (`0.0.0.0` in the
image, a LAN address), the start prints `Set up this server: <url>/setup#code=<code>`, and setup takes that code (or the
token, in the code field or as the Bearer): anyone who reaches the port could otherwise set the password first. A code
works once and lasts 30 minutes. `POST /v2/setup/code`, with no credential (the console's **Get a new code**), prints a
new one to the log when the last is expired or spent and keeps one still good, so this request never voids a link
someone holds; it answers `{printed, expires_at}`, never the code, and 403 once the password is set, while it is being set, or where setup
takes no code. A restart prints a new code too. The server keeps a scrypt hash of the password, never the password, in `DIR/owner.json`, and signs its
session cookies with the key in `DIR/.session-secret`; both are 0600, and no run reaches either. A session lasts 30 days.
**Sign out** (`POST /v2/auth/sign-out`) signs out this browser: its session is revoked on the server (a copy of its
cookie stops working too) and its cookie cleared, and every other browser stays signed in. **Sign out everywhere** (`POST /v2/auth/sign-out-everywhere`) ends every session on every browser and phone,
this one too.

Sign-in tries are limited, and never for good. Each address (an IPv6 one by its /64) has ten tries in 15 minutes; past
them each next try waits a second after the last, twice that the time after, never more than a minute. The whole server
takes 100 wrong passwords in 15 minutes; past them every try, from any address, waits the same way after the last wrong
one. A refused try is a 429 that says how long (`retry-after`, `retry_after_ms`). The limit counts up to 10,000 addresses
at once; a new one past that is held by the server's budget only, and no address counted is ever dropped to make room.
Behind a proxy every visitor would be the proxy's address, so one guesser would hold the owner too: set
`AGENTRUN_TRUSTED_PROXIES` to the proxy's addresses or ranges (comma-separated, or `loopback`, `linklocal`,
`uniquelocal`), and a request from one of them counts under the client its `X-Forwarded-For` names (the nearest address
that is not itself a trusted proxy). Unset, that header is never read. A trusted proxy only changes which address a
sign-in try counts against, never who the request is: `X-Forwarded-For` signs no one in, and the whole server's 100
wrong passwords still hold. So with a wide setting such as `uniquelocal` (10/8, 172.16/12, 192.168/16 and fc00::/7; the
VPS installer's tailnet mode sets it, since `tailscale serve` reaches the server through Docker's private bridge),
anything on those ranges that fakes the header, an agent's Docker box among them, can only spread its tries over more
addresses. The owner's first sign-in of a start (the
right password) that comes with `X-Forwarded-For` from an address the server doesn't trust is logged once, with that
address (`event=forwarded_untrusted peer=<address>`; a server from a release after 0.1.0-beta.32). Only the right
password logs it, so the address is the one that carried the owner's own request: behind a proxy, the proxy's.
`render.yaml` leaves it unset, as Render publishes no address for its proxy: after a deploy, sign in, read the
`forwarded_untrusted` line in the service's Logs, and set `AGENTRUN_TRUSTED_PROXIES` to that address (or its range,
when Render's proxy reaches the service from more than one; sign in again after a redeploy to see whether it moved).

Forgot it: run
`agentrun-serve reset-password --data DIR` where the data directory is (`docker exec agentrun node
/opt/agentrun/packages/serve/dist/cli.js reset-password --data /data` in the image). It clears the password and signs every
browser out, and the next visit sets a new one. The token works for scripts and the CLI either way.

A browser's writes must come from the server's own origin. Serve the image on another address or port behind a proxy, and
set `AGENTRUN_PUBLIC_URL` to the address people open. Behind a proxy every sign-in comes from the proxy's address, so the
limit is one for everyone: ten wrong tries in 15 minutes, from anyone, keep the owner out until the window passes (the
token still works for scripts meanwhile). Serve it over https where you can: on plain http a browser sends the session
cookie to every server on the same host name, whatever its port, so another app on that host could read it.

## Importing your sessions

For completed history on another machine, use **Connect agent → Another machine** with **History only** scope.
The matching source connector previews the selected project and runtime, then uploads only with the source
operator's approval and a destination owner grant that permits history. It starts no execution worker or paid task.
See [the remote history guide](../../docs/native-agents.md#import-selected-history). Imports remain history, not live
connections or automatic learning.

The separate local-store CLI importer below requires an approved maintenance window. Verify the source machine,
this server's actual data directory, store configuration, seal key and supervisor without exposing credentials.
Preview the scope with a dry run and inspect active work before stopping the existing server and runners through
their supervisor. Import into the same store, then restart and verify that service, including after an import failure.
Never bypass the store lock. This local-store operation has no server endpoint that reads sessions from the browser's
machine; importing into a different local store does not populate a remote console. Build, edit, run, query and
connection handoffs use the shared coding-agent selector and target this server's matching skill, MCP endpoint and API.

`agentrun-serve import --data DIR` reads the Claude Code, Codex and pi sessions in your own home (`~/.claude/projects`,
`~/.codex/sessions`, `~/.pi/agent/sessions`) into the data directory, once. Each project folder becomes an agent, with its
CLAUDE.md or AGENTS.md and its skill folders, and each session becomes a run you can read but not continue. Nothing leaves
this machine, and the values of key-shaped environment variables are cut out of what it writes. Run it again and it takes
only what it has not taken already. Sessions written in the last 10 minutes wait for the next import.

A run's cost is what its source recorded (Claude Code's and pi's). A session its source did not price, such as a Codex
session, keeps the model catalog's estimate for its tokens beside an unknown cost, and every place that shows a run's
cost reads that estimate, as an estimate: the run (`cost.usd`, basis `estimate`), its usage row, `GET /stats` and its
analytics, and `GET /usage`. A session on a model the catalog does not price stays unknown.

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

1. `POST /agents/{id}/runs` starts the run in the store (`startRun`): one transaction writes a `queued` run, pinned to the
   agent's revision, with its launch record (the request, checked and resolved once, its model included). No process
   starts for it.
2. A runner (by default the one beside the server) claims the `queued` run for 30 s and renews the claim every 10 s. At
   the claim it opens the run's folder (`DIR/disk/agents/<agent>/runs/<id>/work`), reads the launch record and picks
   the run's loop: a workflow revision runs on the workflow loop, a learning run on the learning loop, and every
   other harness (pi, claude-agent, codex, opencode) on the adapter loop. Each loop writes the run's journal in the
   store, behind the claim's fence: a write under a claim the run has moved past is refused. A message, stop, cancel,
   raise or approval is a command row in the store, which the run's runner reads and applies.
   - An agentic revision runs as the root agent: its instructions and skills, its model, and the tools it names of the
     workspace's `read`, `write` and `edit`, and `ask_person`, which ends the turn; the timeline then shows a `waiting`
     row, and the run is `input_required` and `waiting`, with no runner holding it, until a message answers it. `bash`
     is bound only where the run has a shell ([computers](#computers)): in a computer that mounts the run's folder, or
     on Archil's serverless exec in Mode 2; in Mode 1 a run with no such computer has the file tools alone. The run is
     `queued` until its first message shows. The timeline is read from the run's journal. When the turn ends on the
     agent's answer, the loop writes the run's end and the runner releases the claim. A model error ends it `failed`
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
   - A workflow revision runs on the workflow loop, which drives the server's durable workflow task (src/workflow/task.ts) on the run's journal
     (keyed by the run's id): its model nodes (`agent`, `decide`, `extract`, `report`) on the run's model, with the file
     tools each node names, and its typed questions on Jev or Parallel ([decision workflows](#decision-workflows)). A
     workflow that needs code or a tool call this host does not run is not saved here (`422`). The run is `queued`
     until a runner claims it, then `working`. When the workflow ends, the loop writes the run's end from its outcome:
     a complete run ends `ended`, an escalated one `ended` with the outcome `escalated`, a refused or failed one
     `failed`, a cancelled one `stopped`.
3. The run's end is one commit: the run's state, its cost and a summary (an agentic run's answer; a workflow run's
   completed nodes, then where it failed or escalated) are written with the journal's end entry, so there is nothing to
   carry back afterwards. Its last page says `final`. v2's `cancelled` is the store's `stopped`; a workflow that
   escalated ends `completed`, its work done and waiting for a person's review: `error` is null and `review` is
   `{kind, node, reason, at}`, in the run and in the lists. In this release `kind` and `node` are always null: the
   store keeps only the escalation's summary (`reason`) and the run's end (`at`). Every other run's `review` is null.
   `GET /v2/stats` counts it in `needs_review`, never in `failed`.
4. A server that starts again adopts nothing: runs are claimed, not supervised. A run whose runner stopped or lost its
   claim writes nothing more; once the claim lapses another runner claims the run and resumes it from its journal,
   and a model request the stop cut is sent again. A run waiting for an answer has no claim and waits until a message.

An `Idempotency-Key` answer is kept in `DATA/.idempotency.json` for `limits.idempotency_ttl_s` (a day), saved once the
work is done and before the answer is sent, so a retry after a restart gets the first answer; a server that goes down
between the work and the save loses it, and a save that fails still answers. A run create's key is also kept with its
run in the agent store, written with the run itself, so a retry after any restart, or after that day, gets that run (as
it is now, marked `Idempotent-Replayed: true`), and another body under the key is still `409 idempotency_mismatch`.
The file keeps no request body. A key's fingerprint is an HMAC of the body under a key derived from the seal key. A
trigger create's answer is kept as a read answers it (a composio trigger's sealed config as `"[sealed]"`); every other
answer, a run's input among them, is kept and replayed as it was. A record an earlier server wrote with the body itself
is rewritten at the start, and the log says how many.

A completed agentic run's `result` is `{output: null, final_answer}`; a completed workflow run's is
`{output: <the workflow's output>, final_answer: null}`.

## Learning

Learning is off unless an agent's definition says `learning: true` (an agentic one: a workflow refuses the field). A
definition that sets it keeps it on its revision, `false` included, and an edit that leaves it out keeps the agent's; one
that never sets it stores nothing, so its revision id is the one it had before the switch. The server's `--learning off`
turns learning off for every run it starts, whatever the agent says.

An agent learns two things. Its owner's corrections: the words they give after a run (a grade's, or a message after
the job's first) become one line of the agent's `corrections.md`, and every later run reads the file whole. And its
job, once it repeats: after `learning.compile_after` completed runs (20 by default) the run's end asks one compile turn
for the whole job as one workflow, which is checked in code, replayed on the agent's own past inputs, and served as one
tool once it agrees with the agent's own answers. The console reads `GET /v2/agents/{id}/learning` for the agent's
corrections, workflows and history, and `GET /v2/runs/{id}/learning` and its `/diff` for an individual result.
Observation requires no model key. Creating workflow drafts requires an agentic run executed or reported through this
server with learning enabled and access to its configured compile model. For a connected SDK agent, compilation runs
on this server; shadow execution and tool access remain in the original application, as described below.

Set up **Settings → API Keys → Model keys** with a provider key that matches the learning model, such as OpenRouter,
Anthropic or OpenAI, or a supported server sign-in. An unrelated provider key, tool API key, AgentRun connection key or
decision-provider key does not supply compiler access. Background compilation cannot borrow a caller's per-request
gateway key. The new SDK shadow comparison is deterministic and needs no separate Jev key. Native project connections
use their original runtime's sign-in for corrections; learned workflows are not available on that connection.

The agent's Learning tab and Learning Dojo show missing setup for that agent's actual model. `learning_model` in
`GET /v2/agents/{id}/learning` describes that route; the same field in capabilities describes the server default.
`ready` means the route and credentials are configured, not that quota or provider availability has been verified.
These reads make no paid request, and saving a matching key refreshes the setup guidance.

Importing Claude Code, Codex or pi session history does not replay learning or connect a live learning stream.
Before/after cost and duration are observations, not an accuracy evaluation.

**Existing CLI capture.** A project enrolled with `cli_learning` keeps running in its original Codex CLI or Claude
Code process. Its hooks record normal prompt windows and provide the agent's explicit owner-written corrections
on later prompts when learning is enabled. Capturing a prompt does not turn its content or answer into a correction.
CLI capture starts no extra source prompt, native grading turn or automatic note/skill extraction. It has no
approved workflow tool bridge, so it neither compiles nor executes learned workflows. The Learning tab edits
corrections and shows captured runs; new captures begin with the next normal prompt after hooks are ready.
Historical learning files remain stored and are not converted into owner corrections or deleted. Older stored
CLI `learning: "notes"` settings read publicly as `true`; that compatibility read does not rewrite the revision.

An agent that learns has a learning folder, `learning/` in its folder on the disk (`DATA/disk/agents/<key>/learning/`):

- `corrections.md`, its owner's standing corrections, one `- ` line each, at most 2048 bytes;
- one folder per learned workflow, `workflows/<name>/`, with its `workflow.json` and its `README.md` (front matter with
  `name` and `description`, and `status: pending` while it waits for its owner's OK).

The server reads and writes it with its own code, in [`src/learn/`](src/learn/SPEC.md), whose `SPEC.md` is the
folder's contract. The folder is plain git with `main` checked out. The agent's first run that learns makes it, with
one empty commit on `main`; an agent that does not learn never gets one. The server is its only writer. Every git
call the server makes there runs with the folder's hooks and fsmonitor off, no replace refs, no lazy fetch and no system
or global config, one at a time per agent.

Each run of an agent that learns starts from `main` as it is when the run is made, whatever its harness:

- `runs/<id>/learning.json` pins that commit (`seed`). It is written once: a resume or a follow-up reads the same
  commit, however `main` moves on.
- The agent's corrections go into the run's instructions after the agent's, under `# Learned`, so a run reads them
  whatever its tools: `corrections.md` whole, after one line that says they are its owner's standing corrections, to
  follow each one that applies. Nothing picks, ranks or summarizes them: the file's cap keeps it whole. A run with no
  corrections yet reads "Nothing learned yet." there; a run that does not learn gets no `# Learned`. The text is cut of the server's secrets as they are when the run is made, as a person's reads are. That is
  pi's system prompt and claude-agent's and codex's instructions: the same channel `CLAUDE.md` and `AGENTS.md` travel
  in. No file is written into the run's work. The pin keeps the section the run reads (`section`), so a resume or a
  follow-up reads the same.
- The workflows the agent learned, each a folder `workflows/<name>/` on `main` with its `workflow.json` and its
  `README.md`, are the run's as one tool, `learned_workflow {name, input}`, on every harness (pi, claude-agent, codex),
  with no edit of the agent's definition. Only an active, promoted revision is: its `README.md` sets no status, or `active`,
  and its promotion record names the checked champion. A compiled draft without that record is withheld; front
  matter that does not read one way (not closed, a key indented under another, a key set twice, a status over more
  than one line) reads as retired, so no run is given it. Its description names each workflow with the line its README gives, 8 KiB of lines in all: by name, each
  while its line fits, and one that does not, or holds one of the server's secrets, is left out. A README whose front
  matter does not read one way (not closed, or a line that is no key at its left edge) is not read. The pin names the
  ones the run gets (`workflows`), each kept whole in the run's directory (`learned-workflows.json`), outside its work,
  and the ones left out (`workflows_left_out`). The list is fixed when the run starts: a workflow approved or retired
  while it runs is the next run's to get or not. A call checks the workflow again against the agent's own tools as its
  run resolves them, as the commit's checks did: one whose call node names a tool the agent was not
  granted (or one its run resolves unavailable), whose model node names any tool (a learned model node runs without
  tools, so the checks refuse one too), or that holds a code node or a shell or executor call, is refused before any of
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
  `learned_workflow` like any tool: its settings key is `learned_workflow`, allowed by default (the agent's own checked
  and replayed workflow), and tool settings may set it to ask (the run parks until an owner answers) or deny.
  When a run's learned workflows name decision providers (Jev, Parallel, OpenRouter), the runner opens those providers'
  keys as it opens the run's own, from the server's environment first and then its saved keys, for the run's tools alone:
  never for its model or a CLI harness's own environment. A provider the run's tool gate denies gets no key.
  A learned workflow's call node can run an MCP tool the agent grants (`mcp:<server>/<tool>`) through the run's own MCP,
  under the run's tool gate: allowed, it runs at the run's tool cost; denied, the workflow is refused before any node
  runs; set to ask, the `learned_workflow` call asks once, naming every such tool, and the run parks. A run's own draft
  can't call one yet: the checks admitting it are coming.

The server reads the commit with git plumbing, never the working tree. What it holds that is not a regular UTF-8 file of
1 MiB or less, or a workflow out of shape, is not read, and the server's stderr names it. A learning fault never blocks
a run: when the folder cannot be made or read, the run starts with nothing learned. A host without
git 2.32 or later (what learning's own git calls need) is one such fault, said once on stderr.

### What a run learns

When a run that learns answers or fails, its end step (`src/runner/reflect-hook.ts`) keeps two things, one commit a
round on the agent's `main`, whatever its harness:

- Its owner's words. A grade's words, or a message they sent after the job's first, become one line of
  `corrections.md`, with no model turn: `- ` and the words, whitespace folded. A line that holds one of the server's
  secrets, text shaped like a secret or a hidden character, or that would take the file past 2048 bytes, is refused
  whole, nothing of it written, and the run's learning says why (`problems`).
- Its job, when a compile is due: once the agent has its `learning.compile_after` completed runs (20 by default) and no
  learned workflow, or once per hold of one its promotion held, the server asks the same session one more turn, under
  the fixed request id `learn-reflect-<run id>` and the origin `reflect`, so a server that restarts mid-turn asks again
  and the run takes it once. The turn (`compilePrompt`, in `src/learn/compile.ts`) gives the agent's last runs (each
  input, its tool calls, its answer and what the person said after it), the workflow language and one worked example,
  and asks for the whole job as one workflow draft. The draft is checked in code and dry-run; what the checks refuse
  goes back to the model, as data, up to 3 times. A draft that passes is committed directly, with no grader: its
  promotion check (below) decides whether it serves. A compile whose drafts all failed is recorded as the compile's
  attempt (compile once), and its errors are on the run's learning (`draft_errors`), never silent.
  [`src/learn/SPEC.md`](src/learn/SPEC.md) has the rules.
- Its answer's quote re-pick, with `learning.repick: true` (off by default): a workflow whose answer quotes the pages
  its run fetched re-picks once when a quote is in none of them. Off, the re-pick reads its compact notes and its failed
  draft. On, the server rewrites the passing draft before it commits it, so the re-pick reads the pages themselves,
  sent as untrusted data (the model is told never to follow anything written in them, and the step has no tools), at
  most `learning.repick_max_chars` characters of them (150000 by default, 1 to 400000; past it the longest pages are
  cut first). Its request is the served run's, under the run's cost cap. The setting is read at each compile: turning
  it on or off changes only the workflows compiled after that, never one already kept. An agent whose workflows run
  through an SDK bridge ignores it.

The turn runs under the run's own cap, with no reserve, and within 10 minutes; its rows are labelled `learning`, and the
run's answer stays the job's. While it runs, the run reads `reflecting` on every harness. A run with no words from its
owner and no compile due spends nothing on learning, and its learning ends `dropped` (`empty`). A run whose only tool
work was its learned workflows, each answering, with nothing said after its first message and no compile due, ends
`dropped` (`empty`) too: "Nothing new: the run only ran a learned workflow."

The round's commit is made with plumbing: the passing draft's files added or changed (its `README.md` with
`status: pending` when a step calls a tool with no price, to wait for its owner's OK) and the owner's line appended to
`corrections.md`. Its message is `learning: <run id>: merged`, the reason and a `Run-Id` trailer; `main` moves only from
the commit the change was made on (once more on a `main` that moved meanwhile), and a run a trailer already names is
merged, never twice. A draft file that is not on `main` as it was on the run's seed is a conflict, never written over.

A new workflow revision serves only once its promotion check passes. For a server-run agent, the first run that lays it replays it on the
inputs of the agent's last `compile_after` completed runs, one replay run each at workflow cost, and scores each against
the agent's own recorded answer. It is promoted when it agrees on at least `learning.agree_min` (0.8) of them and
answers at least `learning.alone_min` (0.7) alone; under either bar it is held, and the next run asks one revision with
the inputs it disagreed on. Held again, it stops, and nothing compiles again until its owner acts. A promotion by
check is never moved by grades. `GET /agents/{agent_id}/learning/promotions` reads every record.

Connected SDK agents (Claude Agent SDK, Codex SDK and Eve) check where their original tools live. When an application
starts an SDK run with a workflow bridge, `learning.workflows` contains only compatible promoted revisions. If a
compiled draft needs a check, the server instead reserves one candidate in
`learning.check: {id, revision, digest, workflow}` and returns an empty `learning.workflows` list. The candidate is
not a tool for the model. The application completes its ordinary native turn first, then the bridge executes the
candidate in shadow using that turn's recorded tool results. It makes no fresh tool calls by default and never repeats
a write. A host can explicitly enable `shadowReadFallback` for its declared read-only callbacks under its original
policy. Missing or changed evidence, an input that cannot be bound to the workflow, and unsupported adapters fail the
check closed.

The bridge posts one `workflow_check` event with the reservation's `id` and `digest`, its execution `outcome`
(`answered`, `handed_back`, `failed` or `skipped_write`), and its answer or reason. It does not choose whether the
workflow passes. The server compares the answer with the immutable native completion and applies the same
`agree_min` and `alone_min` promotion policy on the same evidence bar: the check decides once, on `compile_after`
**independent native turns**, as a server check decides once on that many of the agent's inputs. Each turn is one row,
kept on the promotion record (`check.turns`) while the check waits for the next turn the draft takes; the turn that
makes `compile_after` decides on all of them. Agreement is whole-answer equality (JSON values or trimmed text), or equality of the owner's
configured `agree_on` fields; there is no semantic model grader on this path. A paraphrase can therefore be held even
when a person would consider it equivalent.

A start reserves a check only on a turn that can be its baseline: a JSON object task must pass the draft's input
schema (a prose task's input is resolved by the bridge), and a start whose task or instructions held a protected value
reserves nothing. A reserved turn that still cannot be the baseline (cancelled or failed, incomplete, redacted or
workflow-assisted evidence, no `workflow_check` report, or a shadow that `failed` or `skipped_write`) gives the
reservation back: the record stays `replaying` with no `runs`, counts it in `check.released` (a cancel is never
counted), and the next turn the draft takes is checked. A turn that lands starts the count again; five counted
give-backs in a row hold the draft, never promoted and never stopped for good: the agent's next compile, after
`compile_after` more runs, revises it, and the revision is checked afresh. A turn the
backend never completes within an hour is decided as one failed input through the same check, so its hold asks the
one recompile and a recompile's check that ends the same way stops. Connected checks' records say `via: "sdk"`;
`check.fresh_reads` counts the shadow's `shadowReadFallback` reads.

Concurrent starts reserve at most one check per workflow; retries keep the same reservation, and a late report cannot
replace a recorded decision.
An older checked champion can still serve while a newer revision is checking or held, except on the independent
check turn itself. Learning Off returns neither workflows nor a check. Without a workflow bridge the application gets
no workflow to execute. The application's tools, model callbacks and credentials stay in its process; the server receives
evidence and the shadow result through the run-scoped SDK credential.

The run's `learning` (on `GET /runs/{run_id}`, and `{state, reason, detail}` in run lists, the detail cut to 140
characters and no time) says how it went: `seeded`, then `reflecting` during its end step, and `merged`, or `dropped`
with a reason from a closed list (`seed_failed`, `no_budget`, `unknown_cost`, `cancelled`, `crashed`, `reflect_failed`,
`empty`, `checker`, `use`; a run record with any other reason is not counted). It is `null` for a run that does not
learn (its agent's `learning` is not true, the server's switch was off when it started, or it is a workflow's or an
imported run). Its `detail` says the same in a person's words, never the machine's: "Started from 2 corrections.",
"Keeping what this run learned…", "Learned the workflow sort-invoice. Kept your correction.", "Nothing new to keep from
this run.", "Not kept: it held something that must not be stored (one of this server's secrets).", "Not kept: learning
stopped (…)." and so on (`learning-words.ts`); a client that acts on it reads `state` and `reason`. A workflow's name in
it is said again at each read from what the run keeps, cut of the server's secrets as they are then before the words
are cut short (300 characters, 140 in a list), so a value that became a secret after the run is never shown in part.
Once it is merged or dropped (`seed_failed` included), the run's timeline has one row of kind `learning` whose summary
is that detail. Its read also says how many lines its merge added to `corrections.md` (`corrections`) and the workflow
it wrote (`workflows`, each `pending` while it waits for the owner's OK).

`GET /stats` counts the runs that tried to learn under `learning`, over its `from`, `to` and `agent`, from the store
(each run's kept learning; `in_progress` while its end step runs), never opening a run's files.

The learning bench, `node scripts/learn-bench.mjs`, runs repeated jobs with learning off and on, on pi and
claude-agent, and reports the follow rate on repeat steps, the work cost per run and its trend, how often workflows are
proposed and reused, staleness after a rule changes, and wrong keeps after a planted request. Six jobs ship with it, in
[`learn-bench/`](learn-bench/README.md); it calls real models and spends, so it runs on demand or nightly.

### Coming

- A learned workflow's node of a tier runs on the server's model of that tier, at its own price (#2408).
- A run's workflow draft may call a granted MCP tool: the checks admit it, and one that writes waits for the owner's OK.

### What a person sees and controls

A person reads and changes an agent's learning through this server's own routes (`learning/1` in `/v2/openapi.json`),
with the token, an archived agent's too:

- `GET /agents/{agent_id}/learning`: `main`'s head, `corrections.md` as `corrections`, the learned workflows (each its
  name, files, description, status and `etag`; `status` is one word: `pending` or `retired` as its `README.md` says,
  else where it stands as `.../learning/promotions` says it: `serving`, `checking`, `held` or `stopped`, a champion
  the cost rule stopped included), the first 20 changes on `main` (newest first, each `by: {run}` from its
  `Run-Id` trailer or `{user: true}`, with its commit, time, reason and files), how the agent's runs that tried to learn
  fared (`merged`, `dropped` by reason, `in_progress`), counted as `GET /stats` counts them, and `impact`, what
  learning changed: the agent's completed runs that started from at least one learned item (a correction, or a learned
  workflow) against those that started before its first, each side's `runs`; `median_duration_s`, the time to the
  answer (the run's start to its job's end, before its end-of-run step). What a run costs, learning included, and what
  learning itself cost are `.../learning/cost`'s (`summary.before`/`after`, the bill's `learning_usd`).
  Null unless both sides count 2 runs. An agent with no folder answers `main: null`, empty lists and `impact: null`.
  `GET .../learning/log?cursor=&limit=` pages on, up to 200 at a time; a cursor reads the same commit its first page
  did.
- `GET .../learning/corrections`: `corrections.md` on `main` as `{text, etag, cap_bytes}` (empty text when there is
  none). `PUT .../learning/corrections` with `{text}` replaces it whole under `If-Match: <etag>`: a stale ETag is 412,
  none (or `If-Match: *`) 428 `precondition_required`. A text that holds one of the server's secrets, a secret's shape or
  a hidden character, or passes 2048 bytes, is 422 with the problems, and nothing is written. A text read cut of a
  secret and sent back keeps the cut: a person's write never puts a secret back. One commit on `main` in the agent's
  queue, `learning: edited by a person: corrections.md` with a `Changed-By: user` trailer.
- `GET .../learning/files/{file}`: `corrections.md` or a workflow's file on `main`, with its `ETag`, the file's git blob
  id. `POST .../learning/files/{file}/retire` under `If-Match`, on a workflow's `README.md`, sets `status: retired`: no
  later run is given it. `POST .../learning/files/{file}/approve` makes a pending workflow active (see
  [Approving a workflow that waits](#approving-a-workflow-that-waits), below). `POST .../learning/files/{file}/restore`
  under `If-Match` gives a retired workflow to every later run again, after checking its files again as a run's draft
  is checked (a refusal is 400 with `problems`, and it stays retired); it takes the owner's password session alone, as
  an approval does. The learning view gives each workflow `last_change` (`{kind, by, at}`: `approved`, `edited`,
  `created`, `retired` or `restored` by a `person`, or `learned` by a `run`) and each retired one `retired` (`{at, by}`).
- `GET .../learning/workflows/{name}/revisions` lists a learned workflow's revisions on `main`;
  `GET .../learning/promotions` its promotion records; `GET .../learning/loop` each compile turn; and
  `GET .../learning/cost` the agent's cost per run, run after run.
- `DELETE /agents/{agent_id}/learning` resets the agent's learning: its learning folder whole (`corrections.md`, its
  workflows, their history and the audit ledger), here and on every Archil disk its runs used (`503` while one can't be
  reached), then its promotion records and grades. The agent and its runs stay,
  with their files, costs and each run's own learning, so the run list, `GET /stats` and `GET /usage` read the same (a
  served run keeps its share of its revision's compile and check); a run's learning diff goes with the folder (404);
  the next run takes the agent path, given nothing learned. It cancels the runs that exist only for learning (replays,
  audit shadows) and waits for them; while a run of the agent's own is still going it is `409 learning_busy` (each named
  in `details.runs`), and nothing is deleted. `204`, a second call and an agent that never learned included. The
  API-only profile serves it too.
- `GET /runs/{run_id}/learning`: the run's learning whole (its seed, its merge, the corrections it added, the workflow it
  wrote, its compile turn's attempts and the checks' problems), `null` for a run that does not learn.
  `GET /runs/{run_id}/learning/diff`: a merged run's merge commit against its parent, each file's patch as git writes it
  from the first `@@`, or `withheld` (`too_large`, `secret`).

Every read is the folder's snapshot (`.agentrun/snapshot.json`, written last by the same exec as each commit to
`main`), the files it names, each checked against its blob id (a file that is not, read twice, is a write in flight:
`503`), and a merge's `.agentrun/diffs/<run>.json`, through the folder's file API: no git and no exec. Every text it
answers is cut of the server's secrets as they are then; a file name holding one (a workflow named after a value made
secret since, say) reads `[redacted]` whole, in the workflows, the log's `files` and a diff's `path`, while its route
still answers the real name to a caller who knows it. A log page reads the snapshot alone (it keeps the newest 200
changes). A cursor reads at the main it names while this server still holds that snapshot, else as the first page of
`main` now. Every write to `main` (a run's merge, a person's corrections, retire, approve or restore) is one exec of the learning
script, a compare and swap on `main`. A symbolic link at the agent's home, its learning folder or the folder's `.git` is never
followed: a read or a write there answers `500`, and nothing is written.

### Approving a workflow that waits

A learned workflow whose step calls a tool with no price is committed with `status: pending` in its `README.md` and
given to no run until its owner approves it.

Who can approve: the owner, signed in with their password. No token approves, the server's own included, so a run that reaches this server only through its API (its MCP tools, a sandbox run) can't approve its own workflows. Runs that use bash on the host run as you: they can read this server's files, its session key among them, so no route keeps them from approving. For untrusted tasks, use the sandbox.

`POST .../learning/files/{file}/approve` (and `.../restore`, which puts a retired item back into every run) takes the console's password session, sent from this server's own origin with
a JSON body as every page write is. Any token is 403: the server's own (what scripts and the MCP endpoint's tools
carry) and a token sent beside the session. So is every request on a server with accounts off
(`AGENTRUN_ACCOUNTS=0`), which has no password session: its console session comes from the launch code, never the token. With no credential it is 401, as every route.
`capabilities.learning.approve` is true only for the owner's session; every other caller reads `approve: false` with
`approve_needs: "password"`. A workflow that is not pending is 400; a stale ETag is 412, none 428. The approval is one
host commit, `learning: approved by a person: <file>`, with the trailers `Changed-By: user` and `Approved-Via: console`;
the log shows `by: {user: true, via: "console"}` at the commit's time.

## A run's cost: its tokens and its basis

A run's `cost` (on `GET /runs/{id}` and on each row of `GET /runs`, `costbasis/1`) carries its model requests' tokens
and says how its figure was reached.

- `tokens`: `input` (cached input left out: the whole input is `input + cache_read + cache_write`), `output`,
  `cache_read`, `cache_write`, `requests` (every model request the run's model proxy booked: its turns, its subagents,
  its side calls) and `unmetered` (those that reported no tokens: refused, cut or never answered). Read from each
  answer's usage as the provider or gateway reported it: OpenAI's Responses `usage.input_tokens` and `output_tokens`,
  Anthropic's Messages `usage` with its cache reads and writes, streamed or whole. Absent while the run has booked no
  model request and stored none; a native or SDK run reports its whole task's tokens at its end, with no request
  count, and none while any count is unknown. The model proxy forwards only those two APIs (`/v1/responses`,
  `/v1/messages`); no harness here sends Chat Completions through it.
- `basis`: `reported` when every request priced had its provider's or gateway's own figure (LiteLLM's
  `x-litellm-response-cost` header, OpenRouter's usage `cost`); `estimate` when any was priced from a price table (the
  model catalog, `AGENT_MODEL_PRICE`, a cut request counted at its hold); `unpriced` when no request was priced (none sent,
  every one refused at $0, or none with a known figure). Paid tool calls and decisions are charged at their own figures
  and do not change it. A native, SDK or imported run's figure is its harness's own, an `estimate`; so is an imported
  session's catalog estimate where its source priced none ([importing your sessions](#importing-your-sessions)). LiteLLM writes no
  cost into a streamed answer's headers, so a run whose answers stream through LiteLLM reads `estimate`.
- `tools_usd` (on `GET /runs/{id}` alone, `toolsusd/1`; Parallel's decisions in it since `toolsusd/2`): the part of `usd` its paid tool calls cost (monid's endpoints,
  MCP tools with a saved price, Parallel behind `web_search` and `web_fetch`, browser time, and a workflow decision
  Parallel answered on its own API, on `PARALLEL_API_KEY`, at Parallel's list price), as the run's ledger booked them,
  rounded as `usd` is. It is inside `usd`, never added to it: `usd` less `tools_usd` is what its model requests and its
  other decisions cost (Jev's, an OpenRouter model's, Parallel's model reached through OpenRouter). A paid call in a learning run's end-of-run turn is learning's (in `learning_usd`), never in
  `tools_usd`. 0 when it made no paid call. Null while a paid call's charge is unknown (as `usd` is then); while the run
  is at work (until it ended, stopped or failed); for a learning run a follow-up opened again, whose `usd` is what its
  first round had cost; and for an imported, native or SDK run, whose `usd` is its import's or its harness's own figure
  and whose tool calls the server never books. Each call's own charge is its span's `usd` on `GET /runs/{id}/trace`.
- `GET /stats` (`cost.basis`) and `GET /usage` (`basis`) say the same words over the runs they sum: `estimate` when any
  run's is, else `reported` when any run's is, else `unpriced`. A run whose end stored no basis (one that ended before
  this, or a workflow run: its run read still says its basis from its booking) counts as `estimate` when it cost anything.

The console shows the tokens beside the run's cost, and the figure says its basis: `$0.0042 est.`, `$0.0042 reported`.

## A run's cost, line by line

`GET /runs/{id}/usage` (`runusage/1`) says what one run cost and where each part goes: its model requests by model, its
paid tool calls by who charged for them, its browser time by browser provider. It answers "what did this run cost, and
whose invoice does each part land on?" for every run that books its cost: a pi run, a run on a CLI harness that sends
its model requests through this server, and a workflow run with its decisions. The console's Dev tools tab shows it
under "Cost by line". Each line has its quantity as measured, its dollars as the run's booking holds them, and how those
were reached. Nothing is priced here, and nothing is rounded to a billing increment or topped up to a minimum.

```json
{ "run_id": "run_…", "ended_at": "2026-11-19T10:01:30.000Z", "currency": "USD", "total": { "usd": 0.0566 }, "reason": null,
  "lines": [
    { "meter": "tokens", "model": "claude-sonnet-5-5", "provider": "anthropic", "charged_by": null, "quantity": 3300, "unit": "token",
      "basis": "reported", "usd": 0.0036, "requests": 3, "tokens": { "input": 3000, "output": 300, "cache_read": 0, "cache_write": 0 },
      "unmetered_requests": 0 },
    { "meter": "tools", "model": null, "provider": "monid", "charged_by": "monid", "quantity": 1, "unit": "call", "basis": "reported", "usd": 0.003 },
    { "meter": "tools", "model": null, "provider": "docs", "charged_by": "docs", "quantity": 1, "unit": "call", "basis": "estimate", "usd": 0.05,
      "not_metered_calls": 2 } ],
  "browser_sessions": [],
  "computer_intervals": [
    { "provider": "daytona", "provider_id": "5f0c…", "kind": "sandbox", "gpu": null, "cpus": null, "memory_mb": null,
      "started_at": "2026-11-19T10:00:04.000Z", "ended_at": "2026-11-19T10:01:31.000Z", "kept": false } ] }
```

- `tokens`: one line per model the requests were sent on (`model`; a workflow decision on the model its provider
  answered with, except a decision Parallel charged for, which is on Parallel's `tools` line). `provider` is where the requests went, named only when this server sent them there itself: the run's
  own model on a provider's key, or a decision's provider. Behind a model gateway it is null, since the gateway picks the
  upstream. A model reached two ways is two lines, one per provider. `quantity` is the input, cache read, cache write and
  output tokens as each request reported them (a decision's as its receipt does), with the split beside it; `basis` is the run's `cost.basis` rule over that model's requests alone.
- `tools`: one line per charger (`charged_by`: `monid`, an MCP server's name, `parallel`), the vendor whose invoice the
  calls land on. `provider` names the same vendor: the one that charges for a call is its provider. `quantity` is the charges booked, one per paid call. `basis` is `reported` when every charge is the
  vendor's own figure (monid's answer says what it charged), `estimate` when any is a price this server holds (an MCP
  tool's saved price, Parallel's). A workflow decision Parallel answered on its own API (`PARALLEL_API_KEY`) is a paid
  call on the `parallel` line, beside `web_search` and `web_fetch`, at Parallel's list price for one decision request
  (`estimate`), and on no `tokens` line. A `parallel` decision sent through OpenRouter (no `PARALLEL_API_KEY`, the
  OpenRouter key) is OpenRouter's to charge, at the cost OpenRouter reported: a `tokens` line, as any decision model's. Calls of a tool with no price set ran outside the run's cost, as `GET /usage` counts
  them: `not_metered_calls`, in neither `quantity` nor `usd`.
- `browser_time`: one line per browser provider (`provider`). `quantity` is the seconds this server's clock charged the
  provider's sessions for, the provider's minimum per session included as the browser charged it; `basis` is
  `estimate`, the provider's price per hour on this server's clock, never its invoice.
- A field a meter does not use is null, and so is a name the record does not keep: never `""`.
- A charge of unknown cost makes its line's `usd` null, with `so_far_usd` and `unpriced` beside it, never $0. `total`
  joins the lines by the rule `cost.usd` is, so `total.usd` is the run's `cost.usd`, with the same `so_far_usd`,
  `unpriced` and `upper_bound` beside it; the `tools` lines sum to `cost.tools_usd`.
- Learning is not on the lines. A learning run's end-of-run turn is this server's work for the agent, not the run's
  task, and `cost.usd` leaves it out too; its spend is `learning_usd` on the run read.
- When the lines can change: only while the run works. A follow-up opens an ended run again (a trigger's often does),
  and it ends again later. `ended_at` is the end the lines cover: keep it with them, and read again at `run.ended`, which
  fires at each end. A later read with another `ended_at`, or null, means the run moved since.
- `lines` and `total` are null, with `reason`, while the run is at work (`running`), for a run whose figure is not its
  booking's (`not_booked`: an imported, native or SDK run, or a CLI run whose model requests went past its proxy), and
  for a learning run a follow-up opened again (`reopened`, whose booking can't be split by round).
- `compute_time` (`runusage/4`): one line per computer provider and resource (`resource`: `vcpu`, `memory`, `gpu` with
  its `gpu_type`, `disk`), for the computers the run made. Sum a provider's lines for its one compute figure. `quantity`
  is every second of each such computer at its figure (`vcpu_second`, `gib_second`, `gpu_second`, or `gb_month` of disk
  over a 730-hour month); a computer still open is counted up to `measured_to` (`open_computers` says how many). `usd` is
  what the run's ledger booked for it while a claim held the computer, at the operator's price ([Computer
  time](#computer-time)), so `total` stays the run's `cost.usd`. The part no claim held (`unheld_quantity`: a computer
  kept past its claim for a follow-up, one deleted after its run, one whose delete failed) is in no cost. A resource with
  no price set, or whose figure no one said, is `unpriced`, its `usd` null; a provider that bills nothing (`docker`) is
  $0. A `compute_time` line that is `unpriced` and any `unheld_quantity` are outside `total`.
  ```json
  { "meter": "compute_time", "model": null, "provider": "daytona", "charged_by": "daytona", "resource": "vcpu", "gpu_type": null,
    "quantity": 348, "unit": "vcpu_second", "basis": "estimate", "usd": 0.004872, "unheld_quantity": 0, "open_computers": 0 }
  ```
- `browser_sessions` (`runusage/2`) holds one record per browser session the run opened, in the order it opened them.
  With it you can see how long each session ran, spot one that ended late or was lost, and find each on the provider's
  own dashboard and invoice by its id: the provider's id for the session (`provider_session_id`), when
  this server opened it and let it go (`started_at`, `ended_at`), why it ended (`release_reason`), the seconds charged
  for it (`charged_seconds`, what the line sums), and the provider's own record of it, read once when it was let go
  (`provider_record`: its `started_at`, `ended_at` and `proxy_bytes`). Browserbase keeps such a record; a provider that
  keeps none says `provider_record_status: "not_offered"`, and a read that failed says `failed`, with `provider_record`
  null, never zeros. A session whose end was never recorded (its run's process lost first) has `ended_at` null.
  `charged_seconds` are the seconds charged for the session, its provider's minimum included where the browser charged
  one at the release, as on the `browser_time` line; how long it ran is `ended_at` less `started_at`.
- `computer_intervals` (`runusage/3`) holds one record per computer the run made through its provider (a sandbox, a
  desktop or a phone), by when each was made. With it you can see how long each of the run's computers lived, find one
  left running after its run, and match the provider's invoice by its own id: the provider (`provider`, this server's
  name for it, as the agent's computer setting names it), the provider's id for the computer (`provider_id`), its
  `kind`, what it was made with (`gpu` with its `type` and `count`, `cpus`, `memory_mb`, `disk_gb`: the provider's own
  figures where its answer gave them, as Daytona's, E2B's and Fly's do, else what its create asked for; null where neither
  says, and none is guessed), how much of its time a claim held and booked (`booked_seconds`), when the create answered
  (`started_at`), and when the provider's delete of it answered ok (`ended_at`). `ended_at` is written only on that ok:
  null means no delete was proven (the computer may still be running, or its delete failed or never answered), never a
  guessed end. `kept` is true once the run's park kept the computer past its claim, for the person's answer. A computer
  is ended wherever this server deletes it: the claim's release, a later claim letting an earlier one's go, the run's
  end, a kept computer's end at its time, and the janitor's sweeps. The agent's own persistent computer (it outlives
  every run), a paired computer and `--faux`'s are not the run's and have no record; a browser's sessions are in
  `browser_sessions`. A run's computers made before this server kept them have none either. The records are kept in the
  store's `computer_intervals` table (keyed by provider and the provider's id), and a purge of the run keeps them.

### Attempts: what the infrastructure redid

A run's turn can be worked more than once. A runner that drains for a deploy hands its runs back mid-turn, a runner that
dies leaves its claims to lapse, a runner that can't renew loses its claim, and a turn whose loop ended on its own is
tried again. In each case another claim works the same turn again. It resumes from what the cut claim saved: requests
already answered and calls already finished are reused, not sent again. What it does send again is each model request
the cut claim sent and never finished, cut in flight or cut off by a crash. Those requests are the infrastructure's
cost, not the task's.

The read says which is which (`runusage/5`). It does not change what anything costs: `total` and `cost.usd` still hold
every line.

- Each line, browser session and computer interval has `attempt`: the attempt at its turn it was made in (1 for the
  turn's first, 2 for its first redo, and so on). A turn's charges are split into one line per attempt.
- Each also has `billable`. It is false only for the model requests an attempt never finished when a later attempt
  worked its turn again. Everything else is billable: answered requests, paid calls, browser and computer time.
- `infra_usd` is the sum of the lines that are not billable. It is 0 for a run with no such request. A request cut in
  flight never got an answer, so its cost is unknown, and `infra_usd` reads null for a run that has one, as `total`
  does. It is also null with no lines.
- A run from before this server kept attempts reads `attempt: null` and `billable: true` on every line.

The attempts live in the store's `run_attempts` table: one row per claim, written in the claim's own transaction. Each
row holds the claim's turn and attempt, and `cause`, which says why the attempt before it was cut:

| `cause` | What cut the attempt before |
| --- | --- |
| `drain` | Its runner closed (SIGTERM) and handed the run back. |
| `crash` | Its lease ran out and nobody said why (its runner died). |
| `lease_lapse` | Its runner was still there but could not renew the claim in time. |
| `retry` | Its loop ended interrupted on its own, and the run was released to be tried again. A stopped run whose end was refused is no cut: the claim that retries the end runs no turn, so it starts a new one and redoes nothing. |

A turn is the work one claim starts afresh: the run's first, a follow-up's, or a resume after a park. A claim is a redo
only of the claim it takes over, and only when that claim wrote its row. A runner of an earlier build, running beside
this server through an upgrade, writes none. When the claim after it takes over, it starts a new turn, so no earlier
recorded turn is read as redone.

Each part of the usage is matched to its claim this way:

- **Journal entries:** a claim's entries start at the run's next entry id at the moment it claimed. Anything written
  before the run's first recorded claim belongs to no attempt and stays billable, unless that claim was the run's first.
- **Browser charges:** a charge whose booking a later claim recovered is the attempt's that wrote the charge, matched
  by its ref.
- **Computer time:** a computer's time is split across the claims that held it, by each claim's window on the store's
  clock. A computer kept across a park is billed by the claim that resumed it. Its `unheld_quantity` is spread over those
  windows by their share of its life.
- **Computer intervals:** each record's own `attempt` is the claim that made the computer.

Each model request a claim sends to this server's model gateway carries the run, turn and attempt as LiteLLM's
spend-logs metadata, in the header `x-litellm-spend-logs-metadata` (LiteLLM v1.110.0 and later). For example:
`{"agentrun_run_id":"run_…","agentrun_turn":1,"agentrun_attempt":2}`. A gateway's spend logs can then be matched to the
run's lines call by call. "This server's model gateway" means `AGENT_MODEL_BASE_URL`, or `ANTHROPIC_BASE_URL` on its
origin. The header is sent on pi's routes and Claude Code's; Codex's adapter takes no extra headers yet. It is never
sent to a vendor's own endpoint.

### Computer time

A computer's time is priced the way providers bill it: by what the computer holds (its vCPUs, its memory, its GPUs, its
disk), for as long as it holds them. There are no sizes. Copy your provider's per-resource rates from its price sheet
into these settings on the server, each in US dollars, `<PROVIDER>` being the provider as the agent's computer setting
names it and `<GPU_TYPE>` the provider's own GPU name, both in capitals with every other character an underscore:

| Setting | Price of |
| --- | --- |
| `AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_<PROVIDER>` | one vCPU for one second |
| `AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_<PROVIDER>` | one GiB of memory for one second |
| `AGENTRUN_COMPUTE_USD_PER_GPU_SECOND_<PROVIDER>_<GPU_TYPE>` | one GPU of that type for one second (`..._DAYTONA_H100`) |
| `AGENTRUN_COMPUTE_USD_PER_DISK_GB_MONTH_<PROVIDER>` | one GB of disk for a month of 730 hours |

A price sheet that quotes by the hour divides by 3,600 (a vCPU at $0.0504 an hour is `0.000014`). What a computer holds
is its provider's own figure where the provider's answer gives one (Daytona: vCPUs, memory, disk and GPUs; E2B and Fly:
vCPUs and memory), else what its create asked for. Nothing is built in: a provider that bills nothing (`docker`) is $0,
a resource set to `0` is $0 (its time booked at $0, its line `estimate` with `usd` 0), and with no setting a resource
is unpriced.

- **Priced:** the run's ledger holds the computer's time under the run's `max_cost_usd`, one stretch of 5 minutes ahead,
  as a browser's time is held. A claim's computer is made while the run is set up, before its cap can judge anything:
  its first stretch is held as soon as the cap can, so the run's first model request is judged beside it, and a cap
  with no room parks the run there for a raise. A computer made later in the run (a new sandbox in place of a lost one)
  has one stretch at what its create asks for held first, and a cap with no room for it makes nothing: the run fails in
  the cap's words. Each stretch the computer ran is booked (its provider is owed it, so it is never refused) and the
  next one held, the booked stretch's hold given back first so the cap never counts a stretch twice; a cap with no room
  for the next pauses the run, as a paid tool call's refusal does, and a raise lets it go on. Before the run's end or park is written, the time since is booked and the hold let go, so the end's `cost.usd`
  holds all of it. The booked time is in the run's `cost.usd` and on its `compute_time` lines.
- **Unpriced** (no setting, or a figure no one said): nothing is held or booked, and nothing is refused. The computer
  runs outside the cap, as a tool call with no price does, and its `compute_time` lines say `unpriced`. An operator who
  sets no compute price keeps exactly the behavior before these settings.
- **Not held by any claim:** a computer kept past its claim for a follow-up, one deleted after its run ended (the
  seconds between the end's booking and its delete included), and one whose delete failed run on with no claim to hold
  them. Their time is on the usage read (`unheld_quantity`, and the
  interval's `booked_seconds` beside its life) but in no cap and no cost: check `computer_intervals` for such a computer.
  A computer a later claim takes back is held again from then on.
- A run whose process keeps no ledger here (a runner of its own with no run ledger) holds and books nothing, as if
  unpriced.

## Spend cap

A run may name `max_cost_usd`, an agentic run or a workflow run ([below](#a-workflow-run-under-its-cap)). A run that names none takes its agent's default,
the `max_cost_usd` of the revision it runs, kept with the revision; a run's own cap wins, since its caller chose it. A
definition's `max_cost_usd` above 0 sets that default, and 0 clears it (no default); anything else is `422`. An edit that
leaves the field out keeps the agent's default, as it keeps its harness and place: leaving a field out never removes a
spend limit. A workflow definition keeps one the same way. The cap is checked in the run's own process
before each model request, the agent's and a compaction's alike, on every harness: what the run has spent so far, plus
what each request still in flight is held at, plus the most this request can cost must stay within it, or the
request is not sent and the run pauses ([below](#a-run-paused-at-its-cap)). The cap is a hard stop for everything but
two charges that can pass what they were held at: a monid call priced by usage, which can pass monid's estimate
([monid](#monid)), and a fal job, booked at the units its output states, which can pass those its input asked for. Either
is booked as charged; when that takes the run past its cap, the run stops at once in the cap's words, nothing run after
it, and below the cap the run goes on. An MCP tool counts only at the price saved for it (its server's `prices`); one with none is
not metered and bills its own account outside the cap. fal is counted: a job sent to a fal server (one saved with the
toolkit `fal`, or at `mcp.fal.ai`) through `run_model`, `submit_job` or `submit_jobs` is priced before it is sent, at
fal's unit price for its endpoint (the server's own `get_pricing`, read with the run's credential and kept five
minutes) times the units the job's input states: its images, their megapixels, its text's characters, the seconds it
names, or, for dubbing, lip-sync, voice isolation and speech-to-text, which fal bills by the length of the media they
are given, that length, read from the file first. That price is held under the cap, a
job the cap can't take is refused before it is submitted, and the job is booked as the run's tool cost, charged by the
server, with the price and the count it came from. It is an estimate at fal's list price, not fal's invoice: fal
reports no cost for a job, and a minimum charge, a discount or a rate that depends on a setting `get_pricing` does not
list are not in it. A job whose units can't be known before it runs (one billed by compute time or tokens, one that
names no size or length, media whose length can't be read, an endpoint with no listed price) is refused under a cap,
in words that say why; with no cap it runs, booked as an unknown charge. A price saved for a fal tool takes the place
of this. A request costs its input, plus the output it
is sent with at the output price, plus any fee its tokens do not show (below). Its input is priced at its worst case:
every input token at the higher of the input and cache-write prices, since the provider may bill any of it as a cache
write and a cache can miss at any request. So no request passes the cap, a cache miss included: a request costs at most
what it was held at. A request whose cost never comes in (cut, stopped, lost) counts at that hold, in this process and
after a restart alike. A run whose requests read the cache spends less than its holds, so it pauses before it has
spent its whole cap; output is clamped to what is left after the input (below), so a run is parked only when what is
left cannot pay its next request's whole input and a least answer.

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
the model's answer. Once per cap, across restarts; a raise re-arms it. The note also comes due, if it has not already,
on the request whose tool call would be refused now (the wrap-up below: what is left no longer covers what the run keeps
back to answer), so the note tells the model what is left no later than its tools stop.

A capped run also stops calling tools before its cap stops it. It keeps back enough to answer: one typical step (its own
answers' typical cost) and one final answer at its least, as the cap prices the main model's next request. Once what it
has spent, plus what its requests and paid steps still out are held at (their worst case, as the cap counts them, a
browser session's open reserve included), leaves less than that, the run's tool gate
refuses every call a model makes, in every conversation of the run, on every harness, before any setting or approval
is read, with one fixed text: "Budget nearly spent: stop calling tools and answer now from what you have." A call that
would open a child conversation is refused the same way, so no new one starts. Nothing in flight is cut: a child still
working gets the same refusal on its next call and answers, a call a running tool makes is that tool's and runs, and
model requests are judged by the cap as before, so the run's final answer still lands. The cap stays the last line: a
request that does not fit what is left is refused as above. The figure is read from the run's booking records at each
call, never kept in memory, so a restart or a claim moved to another runner holds the same line, and a raise moves it.
Several requests out at once hold far more than they cost, which is why a fan-out of children used to end a small cap
with no answer at all: their holds count as taken, so the run stops calling tools while each of them, and the parent,
still has room to answer. A simple run, with nothing else out, uses its cap up to its last step and answer. The run is
told what is left (its wrap-up note, above) no later than its first refused call. Its one known miss: a request that
writes to its max output can still leave no room for the answer; then the run pauses for a raise rather than overspend.

Under a cap each request is limited to the
output tokens what is left of the cap can buy, thinking included, never more than it asks for or than the model's
ceiling (its max output tokens, else its context window, clamped to what the window leaves): on pi through the request's
own options (its max tokens, and on Anthropic's API its thinking budget), on claude-agent, codex and opencode written into its body
by the model proxy (`max_tokens` and `thinking.budget_tokens`, or `max_output_tokens`). The limit is what it is held at,
so the cap stays exact. A request is refused only when what is left cannot buy its least: 1,024
tokens for its answer (what it asks for, when that is fewer), and when it thinks, the provider's least thinking budget
where thinking takes one (Anthropic's, 1,024, the budget squeezed to it at the least) or else its thinking level's
budget, since its reasoning then shares the limit (minimal 1,024, low 2,048, medium 8,192, high 16,384). The input bound is one token per UTF-8 byte of what is sent (a byte-level tokenizer never makes
a token of less than one byte), each image counted at what its model's provider bills it by its size in place of its
base64's bytes, plus what the provider adds server-side (a tool-use prompt), from the same table the model proxy of
claude-agent, codex and opencode uses; there the proxy measures each request's body. On codex and opencode (the
Responses API) the text the model reads as it is (a message, a call's arguments, a tool's output, a reasoning summary)
counts at its own bytes, not the JSON escapes around it (`\"`, `\n`), which no token is billed for; tool definitions and
encrypted reasoning keep every byte. For a model whose tokenizer is o200k_base (gpt-4o and later, the o-series, on
codex and opencode, and on pi and claude-agent through serve's translation), each request is also counted on the host
with that vocabulary, plus a stated margin (10% of the count, 16 tokens an item, 256 a request), on every route and with
nothing asked of the provider, and its bound is that count when it is below the byte bound. On a route straight to Anthropic
(`https://api.anthropic.com`, on pi and claude-agent), each answer request is also counted by Anthropic's own free
token count (`POST /v1/messages/count_tokens`, with only the credential and version headers, and never through a
gateway or any other base), and its bound is that count plus the tool-use prompt when that is below its bytes. A count
that fails or takes over 3 seconds leaves the byte bound; the request is never held up or refused for it. On any route
with no count (a Claude model through a gateway), a Messages request on pi or claude-agent that carries the session's
last answered request unchanged, apart from the messages it adds, is bounded by what the provider billed that request's
whole input at (its answer's input, cache read and cache write tokens) plus the bytes of the messages it adds, each
image among them at what it is billed as, when that is below its byte bound: the earlier request's system prompt, tools
and messages bill alike in the later one, and what it adds is bounded as the byte bound bounds any body. A request that
differs in anything else, or adds a document, keeps its other bounds.

**The smallest cap that works.** The byte bound reads text as about two to three times the tokens it is billed as, and a
step is sent only when the run's spend plus that step's least (its whole input bound at the cache-write price, and a
1,024-token answer) fits. So a small cap pauses a run well before it has spent it. Measured on a pi desktop run on Sonnet
($3 / $15, cache write $3.75, cache read $0.30 a million) through the dispatch's own system prompt and tools (read,
write, edit, the desktop's and `codemode`, with the desktop skill named in the system prompt), five requests (four
screenshots, then the answer), spending about $0.04 in all. Through a gateway the first request's byte bound is 9,772
tokens, so it needs $0.052; each later request is bounded by the last one's bill and the bytes it adds, so the whole run
needs $0.082;
straight to Anthropic the count is one recorded from a real desktop run on Sonnet (3,146 tokens at first), so it needs
$0.030 and $0.083:

| Route | First request needs | Five-step run needs | Each further step |
| --- | --- | --- | --- |
| Through a gateway (OpenRouter): the byte bound, then the last bill | $0.06 | $0.09 | about $0.012 |
| Straight to Anthropic: Anthropic's count | $0.03 | $0.09 | about $0.012 |

A claude-agent run's first request is of the same size (the pinned
CLI's measured 6,926 bytes with five tools: $0.04 for its first request through a gateway). A cap below these pauses at
once with `Not sent: ... the next step needs at least $X`, and a raise to that figure sends it on. A run a cent under the
five-step figure does not get every step: straight to Anthropic it parks before its last step, its words naming that
figure; through a gateway ($0.08) the wrap-up refuses its last screenshot, the answer's request carries the refusal in
place of a screenshot and fits, and it answers.
`packages/serve/test/cap-minimum.test.mjs` holds these figures to what the cap does. A request in flight holds what it was admitted at until it answers, so requests
sent side by side cannot pass the cap together. Spent so far is read from the run's store each time its process starts, so it
survives a restart, plus each response since, and with them each charge a paid tool booked (a monid endpoint's call, which is itself
refused once the spend reaches the cap; see [monid](#monid)).

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

A computer's minutes (a sandbox's, a desktop's or a phone's) are billed by its provider to your own account there, and
AgentRun does not count them yet: they are in no run's cost and are not held against its cap.

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
nearest cent ($0.0237416 reads $0.02); a spend above $0 that rounds to $0 reads "less than a cent" ("this run has spent
less than a cent of its $0.105 cap"), never "$0"; the exact amounts are `pending.spent_usd`. The cap to raise to is what was
spent, what steps still running hold, and the next step's least, rounded up to the cent so that it is enough. The words
name no model. The refusal's timeline row is an `error` row with
`paused: true`: the request was not sent and the run waits on a raise, so it reads as a pause, never as a failure. The error's code is `spend_cap_reached (out of budget): ` before those words: pi-ai's
retry reads only an error's text, and takes "out of budget" as final whatever digits the words hold. A request the cap
refused was never sent: the run's usage counts no request for it, and a run whose only request was refused says "no model
request sent". A reply the limit cut short says so on the run's timeline: "The reply stopped at 1,500 tokens: all that
the $0.15 left of the run's $0.50 cap could buy."

### A limit on free requests

A request on a free model costs $0, so no dollar cap can stop one: a free model is one whose catalog price is all zeros
(an OpenRouter `:free` model and the like, as `harnesses[].free_models` lists them; an OpenRouter router is none, since
it bills the model it picks), with no fee beside the request. Its provider's shared daily quota is what a looping run
burns. So a run has a limit on those requests: 60, or `AGENTRUN_FREE_MODEL_REQUESTS` (a whole number above 0; anything
else refuses the server's start and the runner's). ChatGPT-plan requests don't count. Capabilities'
`limits.free_model_requests` says it, and the console says "free model: up to 60 requests" beside the cap of an agent
on a free model. A run may make that many; the next is not sent, and the run ends `failed` as one its
cap ends, its error `spend_cap_reached`: "Not sent: this run reached its 60-request limit for free models." (the number
is the limit). No raise lifts it, and it holds capped or not, on every harness: pi, claude-agent, codex, opencode and a
workflow's agent nodes. Every such request of the run counts, its own model's, its subagents', its side calls' (a
compaction, a title), and one a crash cut, which is booked at $0, a known cost; a paid request, a paid tool call and a
workflow's decision never count, and are never refused by it. The count is read from the run's booking records at each
request, so a restart or a claim moved to another runner keeps it.

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
webhook's `run.needs_input` says `pending.kind: "budget"`. The run is parked while it waits: no runner holds it,
so a paused run holds no place, and a server started again reads it paused from its store. A message to a
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
answers as the first did. The raise is a command row in the store, which the run's runner reads. A run paused at its cap goes on: the answer is
`{run_id, max_cost_usd, resumed: true, status, state}` at once, and a runner claims the run again and resumes it from its
journal under the new cap. A raise for a run a runner holds now takes effect from the run's next step: a step already
under way keeps the cap it was admitted at, and the answer's `note` says so. A run a person stopped takes no raise
(`409 not_continuable`): send it a message to go on, then raise its cap.

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

A workflow run is capped by the same checks, on the run's one ledger (the kernel cap), each before the paid step is sent:

| Step | Held at | Where |
|---|---|---|
| A model node's request | its worst case, as an agentic run's request | the run's ledger |
| A call node's `llm` call | the same | the same, as a side request |
| A call node's paid tool call (Parallel's search or extract) | its fee | the run's ledger, as an agentic run's |
| A decision on Parallel | its list price for one request, $0.001 | before the driver admits it (`decision-cap.ts`) |
| A decision on Jev | TypeSafe's published price, $0.042 a million input tokens, one token a byte of its state and questions | the same |
| A decision on an OpenRouter Decisions model | its catalog price: per request, per image, per input token, and per output token for the catalog's most | the same |

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

`startServe({ faux, fauxBrowser, fauxWeb })` also names modules whose default exports give
the `browser` tool's `{ provider, driver }` (`fauxBrowser`, which the CLI takes as `--faux-browser MODULE`; the others are the tests' alone) in place of Browserbase's or Kernel's (pi-browser's fake backend, told the
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
  token, its sign-in secret, and its webhook's signing secret when the seal key opens it; when it does
  not, the CLI's import says so once, on stderr, and goes on), and the keys [secretlint](https://github.com/secretlint/secretlint)'s
  recommended rules find in what it reads (Anthropic, OpenAI, GitHub, Slack and Stripe keys, AWS secret keys beside their
  name, private keys, database URLs with a password, and more). Each becomes `[redacted]`, and the import says how many
  distinct values it removed. Known key formats are removed. Other secrets in your session history, like passwords in
  config files, are imported as they are. So is a key-shaped value this server did not make (a `whsec_` secret from
  another service).
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
  and fonts) hold no data; everything it shows comes through those routes. It loads one thing from the network: on
  Settings → Keys, each provider's icon, from Google's favicon service (`www.google.com/s2/favicons`, which redirects
  to `t0`-`t3.gstatic.com`). The request names the provider's public site (`chatgpt.com`) and carries no referrer,
  no cookie of this server's and nothing of yours; Google sees the browser's address and which providers the page
  lists. Offline, or with those hosts blocked, the page shows a key icon instead. The CSP's `img-src` allows those
  five hosts; everything else is this origin only.
- A run has no door of its own. The server and a run's runner meet in the store: a message, stop or approval is a
  command row the runner reads, so no port a run listens on takes a token.
- A run's tools run under the runner's environment (the `AGENT_MODEL` variables among it) without the server's token or
  any key: no `AGENTRUN_TOKEN`, no `AGENTRUN_TOKENS`, no `AGENTRUN_API_KEY`, no variable whose value is a token, and no variable named like a key
  (one of its `_`-separated segments, in any case, is `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASS`, `PAT`,
  `CREDENTIAL`, `CREDENTIALS` or `DSN`, or its last is `PWD` after another: `SERVICE_KEY`, `GITHUB_TOKEN_RO`, `DB_PASS`,
  `SENTRY_DSN`, `DB_PWD`; never `PWD` or `OLDPWD`), whether the launcher's list names it or not. The rule is
  `keyShaped` (`src/secret-cut.ts`), which an import's cut and a harness's log take too. The keys a
  run needs are read from the store at its claim, opened with the seal key, and are put on that run's environment alone.
  It gets none of the computer providers' account keys ([Sandbox](#sandbox)), not the Archil account key
  (`ARCHIL_API_KEY`), from which the claim mints the run's own mount credential, and not the Composio account key
  (`COMPOSIO_API_KEY`), which the runner sends only as a granted Composio server's MCP header. A tool key reaches it only when its
  revision names a tool the key unlocks (`MONID_API_KEY` a monid tool, `BROWSERBASE_API_KEY` and `KERNEL_API_KEY` `browser`; a workflow's
  tools are those its model and call nodes name), and a model key only when its model needs it ([Models](#models)), read
  from the revision at each claim, a resume after a restart included.
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
- `TYPESAFE_API_KEY` is a decision key, given to a workflow run's decision providers alone and never
  with a run's other secrets, so a pi run on a `typesafe/` model does not get it: it finds no key for that model, and
  the run fails.
- A run's file tools (`read`, `write`, `edit`) reach its own `work/`, and two places of its own beside it: `read` also
  reaches the run's `tmp/` (next to `work/`, where a command's spilled output would go), and a write may also land in a
  temporary directory the run's environment made for a tool (`createTempDir`). Every other path, a link inside `work/`
  included, is resolved and refused (`outside the workspace`), so a run reads neither the server's token,
  `store.sqlite`, another run's files (its `work/` or its `tmp/`) nor `/proc`, and writes nowhere else. This is the
  Workspace's confinement inside the run's process; in the image the operating system holds the same line (below).
- Each run is a process of its own, started by its runner at the claim. It is handed its own keys on a pipe (read and
  closed as it loads) and a channel to its runner, over which it reads and writes what its loop needs: its journal,
  under the runner's fence, and the store's rows of its own run and agent, each call checked against its claim (another
  run's journal or row, another agent's revision, and any call off the list are refused). What the seal key opens for
  the run, the runner opens and hands over; the seal key, the API token and the store's URL stay in the runner. A frame
  on the channel past 32 MiB, or one that is no message of it, fails the run. The runner keeps the claim and its end: at
  the end, or on a stop the run does not take in its grace, the run's process group is killed (in the image, every
  process of its uid).
- In the image, each run's process also runs as a user of its own: slot `s` of its runner is uid and gid `1001 + s`
  (256 slots), started through `agentrun-runas`, a helper installed root:node `0750` with the file capabilities
  `cap_chown`, `cap_setuid`, `cap_setgid` and `cap_setpcap`. The helper reaches only that range and refuses uid and gid 0; it sets
  the run's uid, gid and groups (its slot's group alone: not node's, not the Docker socket's group compose gives the
  server), empties every capability set, sets `no_new_privs` and keeps only the run's two descriptors open. So one run
  reads neither another live run's folder nor its process's memory, environment or descriptors, and none reads the data
  directory (`0711`: crossed to its own folders, never listed), the store's files (`0600`), the seal key or the
  server's memory. The server's user (node) is in one group, its own (1000), and in no slot's; no slot is in node's.
  Before a run starts, its folders and everything in them are given to its slot: the slot's uid, node's group, folders
  `2770` with the setgid bit (`agentrun-runas own <slot>`, keeping `cap_chown` alone and changing each entry through a
  descriptor it opened without following a link). The run reaches them as their owner and the server reads them through
  its one group; no other slot can enter them. A folder the run itself shuts (`chmod 700`, which drops the setgid bit,
  since node's group is not the run's) the server cannot read until the run ends. At the run's end every process of its
  uid is killed, one in a session of its own included, its files in `/tmp`, `/var/tmp`, `/dev/shm`, `/run/lock`
  (`/var/lock`) and `/dev/mqueue` are removed, and its folders and everything in them go back to node
  (`agentrun-runas own runner`), which the slot's next run cannot enter. A give-back that fails retires the slot, as a
  reap that does not hold does. SysV IPC objects (`ipcs`) a run leaves are not removed.
  `GET /v2/capabilities` says `run_isolation: "uid"`. A runner shared by many customers: see the threat model,
  [docs/multi-tenant-runners.md](../../docs/multi-tenant-runners.md).
- A platform that strips the image's file capabilities, or starts it with `no-new-privileges` (Docker's
  `security_opt: no-new-privileges:true`, Kubernetes' `allowPrivilegeEscalation: false`), leaves the helper unable to
  switch, or unable to start (a spawn `EPERM`): the runner then refuses to claim, saying so and naming the setting, and
  stays up claiming nothing, with no heartbeat (`runner --check` says it is not alive), until it is stopped, so the
  container keeps running. The server still serves its console and API (`GET /v2/health` reads the store and the disk,
  not a runner, and `GET /v2/capabilities` says `run_isolation: "process"`), and its runs wait queued until the setting
  is fixed and the server restarts. `AGENTRUN_RUN_USER=same` runs every run as
  the runner's own user instead, still each in a process of its own, said on the runner's log at its start. Runners in
  containers of their own on one `/data` volume each take slots from an `AGENTRUN_RUN_SLOT_FIRST` of their own
  (`deploy/compose.yaml`: 0 and 128). A runner told to hold more runs (`--loops`, `AGENTRUN_MAX_RUNS`) than the slots
  from its first to the last (255) refuses to start, in words; with no number told, it holds those slots. Each run's
  slot is also locked on the volume (`/data/run-slots`, util-linux `flock`) from before its run starts until after its
  reap, so runners whose ranges overlap never run two runs as one user: a slot another runner holds is skipped, and a
  run that finds every free slot held is handed back unstarted, said on the runner's log.
- A local install (`npx`, `node dist/cli.js`) has no helper: each run is a process of its own as the user who started
  the server, and `run_isolation` is `"process"`. Its runs, and a program one starts, can read what that user reads,
  another run's folder and the data directory included, as before; keep a local server to agents you trust as you trust
  that user.
- A host that starts the server as root could run each run's process as a user of its own with no file capability: a
  small spawner, kept as root, that starts the server as an unprivileged user and each run as its slot's uid. The image
  does not ship one: it never runs anything as root, so it needs the helper's capabilities or `AGENTRUN_RUN_USER=same`.
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
  fast (an AWS session token is often over 1,000 bytes, an RSA `AGENT37_SSH_KEY` over 3,000): set only the keys the
  server needs where it starts, and save a long one in Settings instead.

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
- The browser's evidence is numbered from the highest number the run's `evidence/` holds when its browser first files
  there, through the run's Workspace, which has no exclusive create. One browser per run files there, so two never pick
  one number; two filing into one run's `evidence/` at the same moment could.

## Test

```sh
npm run build
npm test -w @parcha/agentrun-serve
```

The tests start a real runner on the faux model, both kinds of run: no key, no network.
