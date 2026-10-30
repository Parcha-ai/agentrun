# @parcha/agentrun-serve

AgentRun Server: the Agentrun v2 API on your own machine, or in one container. `agentrun-serve` serves the same `/v2` contract (`agentrun.v2/0`) as the hosted
API, over one agent store of [`@parcha/pi-durable-agent`](../pi-durable-agent/README.md) in a directory: many agents,
each with revisions written once (an agentic prompt, or an agentrun-dsl workflow), and every run pinned to the revision
it ran. Each run is a [`@parcha/pi-durable-disk`](../pi-durable-disk/README.md) run directory beside the store. An SDK
pointed at it works the way it works against the hosted API; the capabilities document says what this server does not
offer.

This package is held: it is built and tested in this repository and not published yet.

## Quick start (no key, no network)

Node 22.19 or later on 22, or 24.2 or later. In a checkout of this repository:

```sh
npm ci --ignore-scripts && npm run build
cat > faux.mjs <<'JS'
export default (context, faux) => faux.message("The answer is 42.");
JS
node packages/serve/dist/cli.js --faux faux.mjs
```

It prints where it listens and, at the start that made it, the token:

```
agentrun-serve on http://127.0.0.1:7340/v2 (agent store in ~/.local/share/agentrun/agents)
AGENTRUN_BASE_URL=http://127.0.0.1:7340/v2
AGENTRUN_API_KEY=ar_local_...
Open http://127.0.0.1:7340/
Set your password: http://127.0.0.1:7340/setup (the first visit sets it)
```

`Open` is [the page](#the-page), which takes [your password](#your-password). For a client, export the two lines before
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
| `--data DIR` | `~/.local/share/agentrun/agents` | The agent store (`DIR/store.sqlite`) and its runs (`DIR/runs/<id>/`). The token is `DIR/.token`, mode 0600, made once and kept, unless `AGENTRUN_TOKEN` gives it. |
| `--listen ADDR` | `127.0.0.1` | The address to listen on. On any other, every `Host` name is served and the token is the only lock: put TLS in front of it. |
| `--port N` | `7340` | The port. `0` is any free port. |
| `--faux MODULE` | none | Answer every model request from the module's default export (below). |
| `--allow-host NAME` | none | Another `Host` name to accept. Repeat it. |
| `--max-runs N` | `AGENTRUN_MAX_RUNS`, else from memory | The most runs at once ([capacity](#capacity-and-health)). Over it, a new run is `429 rate_limited`. |
| `--drain-timeout D` | `30s` (the image: `6s`) | How long a busy run may finish its turn when the server stops (`8s`, `500ms`, `1m`). A turn cut off resumes at the next start; its model request is sent again. |

`AGENTRUN_TOKEN`, when set, is the token (32 characters or more), and the server prints `$AGENTRUN_TOKEN` in its
place: a token from the environment stays out of the logs. `DIR/.token`'s token is printed only by the start that made
it; a later start prints `AGENTRUN_API_KEY=<in DIR/.token>`, to read it there. With `AGENTRUN_ACCOUNTS=0` the `Open`
link carries the token (`?token=<in DIR/.token>` on a later start); it encodes the token, and the page also takes one
whose `+` arrived as a space. `AGENTRUN_PUBLIC_URL`, when set, is the
address people open (a container's published port, or a proxy's URL): the printed `Open` link and `AGENTRUN_BASE_URL`
use it.

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

## In a container

The image is public: `ghcr.io/parcha-ai/agentrun-server` (`:beta`, or an exact version such as `:v0.1.0-beta.27`).

1. `docker run` it (below).
2. Open the page and set your password.
3. Sign in with it on any browser; the token in the log stays for scripts and the CLI.

On a fresh server with no `AGENTRUN_PUBLIC_URL`, whoever reaches the page first sets the password, so set it right after
`docker run`, before the port is reachable by anyone else. With `AGENTRUN_PUBLIC_URL` set, the setup code the server
prints still guards it.

With no checkout:

```sh
export OPENROUTER_API_KEY=...
docker run -d --name agentrun -p 127.0.0.1:7340:7340 -v agentrun:/data \
  -e AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5 -e OPENROUTER_API_KEY \
  ghcr.io/parcha-ai/agentrun-server:beta
docker logs agentrun | grep Open
```

On another port, publish it there and pass the address you open, so the printed link names it:
`-p 127.0.0.1:<port>:7340 -e AGENTRUN_PUBLIC_URL=<that address>`.

`packages/serve/docker/Dockerfile` builds that image: the server and the open packages it runs, on Node 22 and Debian 13
(trixie), with git 2.47 for `pi-git-remote`. Everything it keeps is under `/data`: the agent store, the runs and the
token. From a checkout, with compose:

```sh
export AGENT_MODEL=openrouter/anthropic/claude-sonnet-5.5 OPENROUTER_API_KEY=...
docker compose -f packages/serve/docker/compose.yaml up --build -d
docker compose -f packages/serve/docker/compose.yaml logs agentrun
```

The token is in the log of the start that made it. On a stop the server gives a busy run 6 s
(`--drain-timeout 6s`) to finish its turn, so a busy `docker stop` ends in about 7.5 s, inside Docker's default 10 s
grace, and Compose's `stop_grace_period` is 15 s; a turn cut off resumes at the next start. Compose publishes the port
on this machine's loopback only (`127.0.0.1:7340`, or `AGENTRUN_PORT`, which the printed link follows), and
the volume `agentrun-data` keeps `/data` across `down` and `up`. In the container the server listens on `0.0.0.0`, and
every route but `GET /v2/capabilities` and `GET /v2/health` still needs the token. Compose's `healthcheck` and
`render.yaml`'s `healthCheckPath` are `GET /v2/health`.

`render.yaml` at the repository's root is a Render blueprint for the same image: one web service with a 1 GB disk at
`/data`. Render generates `AGENTRUN_TOKEN`, which scripts and the CLI read in the service's Environment tab. With no
`AGENTRUN_PUBLIC_URL` the server takes Render's own `RENDER_EXTERNAL_URL` as its public address, so setup takes the
code the start prints in the service's log (`Set up this server: ...`). On another host, set `AGENTRUN_PUBLIC_URL` to
the address people open before the first start; without it, whoever opens the page first sets the password. Set
`AGENT_MODEL` and the provider's key there too. Render waits 30 s after SIGTERM, above the image's 6 s drain; it does not
let a service with a disk change that.

## Upgrading from 0.1.0-beta.26

0.1.0-beta.27 keeps every agent in one store, `DIR/store.sqlite`, with its revisions, and each run under `DIR/runs/<id>/`.
0.1.0-beta.26 and earlier kept one agent home per agent, `DIR/<agent>/agent.sqlite`, and this version does not read
those. So it refuses to start on a data directory that holds one, and names each home it found, instead of serving
it as if it had no agents.

To keep those agents and their runs, keep the earlier version on that data directory. To start this version, give it a
new data directory (a new volume), or move the old homes out of the one you have. Then create the agents again, here or
through `POST /v2/agents`. Their earlier runs stay readable where you moved them, with the earlier version.

## Capacity and health

Each run is a process of its own, about 67 MiB of private memory (measured with the faux model; an independent test of
the image measured 20 runs at 1.22 GiB), beside the server's own 100 MiB or so. So the server caps the runs it holds at
once (each run with a live process: working, or waiting for an answer), by default

    max_concurrent_runs = max(1, floor((memory − 128 MiB) / 72 MiB))

where memory is the container's limit when it has one (cgroup), else the machine's: 5 runs on a 512 MB instance, 12 on
1 GB, 112 on 8 GB. `--max-runs N` or `AGENTRUN_MAX_RUNS` sets it instead; capabilities report it in
`limits.max_concurrent_runs`. Over it, `POST /agents/{id}/runs` is `429 rate_limited` with `retry-after` and nothing
starts: there is no queue, so the client tries again once a run ends. A message to a run already going is never
refused. A data directory serves one AgentRun Server at a time: two servers on a shared disk are not supported (each
counts only its own runs, and a run could be relaunched twice).

`GET /v2/health`, with no credential like capabilities, answers `200 {status: "ok", checks: {store: "ok", disk: "ok"}}`
when the agent store opens for a read and the data directory's disk has at least 64 MiB free (`AGENTRUN_MIN_FREE_MB`),
and `503` with `status: "failing"` and which check failed (`store: "does_not_open"`, `disk: "below_floor"`, or
`disk: "cannot_check"` when the free space cannot be read) otherwise.
It names no path, size or version. One route serves as both liveness and readiness: any answer says the server is up,
and a 200 says it can work, and the platforms here take one path.

A run whose end the agent store cannot take (a full disk) still ends: a cancel makes it `cancelled`, with its cost from
its rows, and the server writes the end to the store again every 30 s until it lands; a restart before then reads the
run as the store last had it. A run whose process was killed is opened again on its next message at once: a heartbeat
of a process that is gone is not trusted.

## Models

An agentic revision names its model as `provider/model-id` (`"model"` in its definition), or names none and runs on
this host's default, `AGENT_MODEL`. A workflow revision names no model: each model node names a tier (`fast`, `default`
or `strong`), and the host maps it, `fast` to `AGENT_MODEL_FAST` and `strong` to `AGENT_MODEL_STRONG`, each falling back
to `AGENT_MODEL`. Capabilities show the mapping in `models` (`{source, fast, default, strong}`). Where the models come
from:

- `--faux MODULE`: every model is the module's (below), with no key and no network: `faux-1`, or for a tier the model
  id its variable names.
- `AGENT_MODEL_BASE_URL`: every model id goes to that one OpenAI Responses endpoint, a gateway (OpenRouter's is
  `https://openrouter.ai/api/v1`): a revision's `provider/model-id` is sent whole, as a gateway like OpenRouter names its
  models `vendor/model`, and `AGENT_MODEL`, `AGENT_MODEL_FAST` and `AGENT_MODEL_STRONG` are sent as they are. For a
  gateway that wants the id alone, `AGENT_MODEL_GATEWAY_IDS=bare` sends a revision's model without its provider. `AGENT_MODEL_API_KEY` is its key when it needs one. `AGENT_MODEL_PRICE` is `input,output,cacheRead[,cacheWrite]`
  in USD per million tokens, so a run's cost estimate has a price; `AGENT_MODEL_FAST_PRICE` and `AGENT_MODEL_STRONG_PRICE`
  price their tier's model, and default to it. With no price set, a model id pi-ai's catalog knows (`gpt-6-luna`, say)
  takes the catalog's list price, and any other is priced at $0. A revision's `provider/model-id` takes that provider's
  entry when it is paid; a bare id, a provider the catalog does not list for it, or one it lists at $0 takes the highest
  price any provider lists (one entry's whole price, the most input plus output; a $0 entry never wins over a paid one),
  as the gateway does not say whose model answers. A run's `max_cost_usd` therefore now stops a gateway run on such a model with
  `spend_cap_reached`; at $0 it never did.
- Otherwise pi-ai's providers serve them, each with its key from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  ...), and its catalog prices the run. The `AGENT_MODEL` variables are then `provider/model-id` too.

A definition is checked for what keeps it from running here when it is saved, with the same checks a run makes before
it starts:

- What no setting of this host fixes refuses the save, `422 input_invalid` by field, and nothing is written: a tool
  this host does not bind (`definition.tools[i]`, `bash` among them), a model pi-ai does not know when no gateway is
  set (`definition.model`, saying why), empty instructions (`definition.instructions`), and a workflow that needs a tool
  call, a judge, code, or a node tool other than `read`, `write` and `edit` (`definition.workflow`, one field per need).
- What a setting of this host fixes saves, and the `201` or `200` carries it in `warnings` (`[{field, reason:
  "not_set_up_here", message}]`, empty when there is none): no key for the model's provider, no default model for a
  revision that names none, no model for a tier a workflow's nodes name. The page shows them before it leaves the form.

A run is refused before it starts, `409 agent_not_runnable`, saying which, for any of these: a warning the host has not
fixed yet, or a revision saved before these checks. A run needs only the tiers it uses: an agentic one its model or the default, a workflow the tiers its nodes name, so a
workflow of fast nodes runs with `AGENT_MODEL_FAST` and no `AGENT_MODEL`. A run thinks at its `effort` (`low`, `medium`,
`high`), else at its agentic revision's `thinking` (`low` to `max`), else at the host's `AGENT_THINKING`, else at medium;
it is never off, and a model node that names its own thinking level keeps it.

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
| `read` | Read a file in the run's `work/` | nothing | yes, no |
| `write` | Write a file in the run's `work/` | nothing | yes, no |
| `edit` | Edit a file in the run's `work/` | nothing | yes, no |
| `ask_person` | Ask the person who started the run; the turn ends until a message answers | nothing | no, no |
| `fetch_page` | Fetch one web page from a public host: `{url}` in, a Page out, `{ok, url, status, title, text, links, refused?, error?}` | nothing | yes, yes |
| `browser` | A Browserbase browser on pi-browser's durable adapter: `snapshot`, `run`, `screenshot`, `browser_read`, `browser_release`, `browser_relaunch`, `browser_downloads` and `browser_upload` (into and from the run's `work/`) | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | yes, no |

There is no `bash`: a run gets no shell (see [Safety](#safety)).

`fetch_page` reaches public hosts only, through pi-browser's guard (`publicFetch`): each redirect hop is resolved,
every address it resolves to is checked, and the connection is dialled at the address checked, so a loopback, private,
link-local, carrier-grade or metadata address (`127.0.0.1`, `10.x`, `169.254.169.254`, `fc00::`, `::ffff:127.0.0.1`
and the like), a name such as `localhost`, a public name that resolves to one of them and a redirect to one are all
refused, as is any scheme but http(s). A URL on a port other than 80 or 443 is refused before the guard is asked. A
body is at most 5 MiB, a fetch at most 30 s, the text is cut at 60,000 characters and the links at 200, absolute
http(s) only. A refusal or a failure is a Page with `ok: false` and `refused` or `error`, never a thrown error: an agent
reads why, and a workflow can branch on it. An agent gets the Page as JSON text; a workflow's `call` node `via: "tool",
tool: "fetch_page"` gets it as its output (`args: {url}`, `out` a schema of that shape). A call node naming a tool the
table cannot run that way is refused before the run starts (`409`).

The `browser` tool runs Browserbase sessions, never a Chrome on this machine. The keys come from the server's
environment and reach the run's process as the rest of it does. A session's custody (its lease, its tag, what it was
doing) is kept in the run's own store, so a run opened again on its directory reconciles the sessions it held. Each
page it reads is filed under the run's `work/evidence/`, each read in a file of its own (`0001-browser_read.md`, ...),
reads at once included. There is no recording and no live view. When the run is let go (its work done, or a SIGTERM)
the sessions it still holds are released at Browserbase.

## What it serves

| Route | Here |
| --- | --- |
| `GET /health` | Without a credential: whether the store reads and the disk has room ([capacity and health](#capacity-and-health)). |
| `GET /openapi.json` | Without a credential: this API as an OpenAPI 3.1 document, the `agentrun.v2/0` contract (vendored in `src/openapi/`, its source in `info`) with this server's own routes marked `x-agentrun-serve` and the operations it answers `501` marked `x-agentrun-serve-unsupported`; `links.openapi` in capabilities points at it. |
| `GET /capabilities` | Without a credential. `backend: local`, every feature flag present and true only when it works; `tools`, the tools an agentic revision may name; `workflows`, what a workflow revision's model nodes get; `models`, where models come from and the model of each tier. |
| `POST /agents`, `GET /agents`, `GET /agents/{id}` | `POST` takes `{definition, skills?, note?}` and makes the agent with its first revision, current. A definition has `instructions` (an agentic revision) or `workflow` (a workflow revision, checked by the DSL first), and `name`, `description`, `model`, `thinking` and `learning` (agentic only; `learning` is this server's own, and an edit without it keeps it: [learning](#learning)), `harness` ([harnesses](#harnesses)), `tools`, `skills` (names; each `<name>/SKILL.md` is in `skills`) and `version`, which is the number the revision gets. A field the store does not keep (`input_schema`, `output_schema`, `max_cost_usd`) is `422 input_invalid` by name, and so is a definition that can never run here; one this host cannot run yet saves with `warnings` ([models](#models)). The ETag (`home_etag`) is the current revision's id. |
| `PUT /agents/{id}/definition` | The same body, checked [the same way](#models): a new revision, its parent the current one, made current. Without `skills` the current revision's skill files carry over. A definition that is the current revision already writes nothing, so a PUT sent twice makes one revision. An agent's id, name and description stay those it was made with. `If-Match` that is not the current ETag is `412 precondition_failed`; the store compares it again inside the commit, so of two edits that read the same revision exactly one lands. |
| `GET /agents/{id}/revisions` | The agent's revisions, newest first: `revision`, `version`, `parent`, `kind`, `current`, `note`, `created_at` and the `definition`. |
| `POST /agents/{id}/current` | `{revision}`: one of the agent's revisions becomes current again. |
| `POST /agents/{id}/archive`, `POST /agents/{id}/unarchive` | [Archiving](#archiving): hides the agent and its runs from the lists, or shows them again. Answers the agent, with `archived_at`. |
| `POST /agents/{id}/runs`, `GET /agents/{id}/runs` | A run of the current revision, or of `revision`. An agentic run's input is `{content: string}`; a workflow run's is what its workflow's input schema takes. The agent's runs, newest first. |
| `GET /runs` | Every agent's runs, newest first, a page of at most 100; `agent`, `revision` and `status` narrow it, and `archived=true` lists only archived ones. A failed run's summary carries its `error`. |
| `GET /runs/{id}` | The run: its revision, kind, status, state, result, error and cost (`basis: estimate`; $0 before its first model request, a cancelled run's included). |
| `GET /runs/{id}/timeline` | JSON pages with the change-number cursor (`after`, `next_after`, `reset`, `drop`, `has_more`, `final`, `wait_ms` long poll), or server-sent events with `Accept: text/event-stream` (`id` is the cursor, `Last-Event-ID` resumes). |
| `POST /runs/{id}/messages` | To an agentic run: `steer` while the agent works, `answer` when it asked the person, `follow_up` after a stop or after it completed: a completed run opens again, the same run on its own session and store, takes a place under `--max-runs` (`429` when none is free), and completes again. A failed or cancelled run, an archived run and a run of an archived agent are `409 not_continuable`; a workflow run takes none (`501`). |
| `POST /runs/{id}/stop`, `POST /runs/{id}/cancel` | Stop ends an agentic run's turn and leaves the run `input_required` and idle. Cancel ends a run `cancelled` once its process has exited. |
| `POST /runs/{id}/archive`, `POST /runs/{id}/unarchive` | [Archiving](#archiving) one run. Answers the run, with `archived_at`. |
| `GET /runs/{id}/files`, `GET /runs/{id}/files/{path}` | The files under the run's `work/`, raw. |
| `GET /usage` | The runs' cost estimates, by meter, agent, key, day or region (`key` and `region` are one line, `local`). A run of unknown cost adds no dollars, so no sum is ever null, and is counted in `unpriced_runs` (in the total and in each line) so it never passes as $0. |

Home export and import, uploads (`/files`), quotes and `POST /runs/{id}/kill` answer `501 unsupported_here` naming the
feature, and capabilities declare each one false. No run waits out `input_wait_s` here (`null`), and runs carry no
browser sign-ins (`sign_ins: false`). `limits.max_cost_usd` is the highest cap a run may name: `null` here, as any cap
above $0 is taken; it does not mean caps are unsupported ([spend cap](#spend-cap)).

## Harnesses

A definition names the harness that runs it: `pi` (the default, and what a definition that names none gets),
`claude-agent` or `codex`; any other is `422 input_invalid` on `definition.harness`. Every answer names it. An edit
(`PUT /agents/{id}/definition`) that names no harness keeps the agent's, as it keeps its skill files; name `pi` to move it
back.
`GET /v2/capabilities` lists each in `harnesses`, with `available` and, when not, the `reason`. A definition naming a
harness this server does not run yet saves with a warning on `definition.harness`, and a run of it is
`409 agent_not_runnable` with `details.harness`; it never runs on pi instead. Today this server runs pi.

`definition.harness` and `capabilities.harnesses` are this server's, outside the `agentrun.v2/0` contract:
`GET /v2/openapi.json` marks each `x-agentrun-serve: "harness/1"`, beside the other properties it adds (`model/1`,
`serve/1`), and lists them in `info.x-agentrun-serve.fields`.

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

## The page

Open the link the server prints, once, in a browser. The page at `/`, AgentRun Server, is
[`@parcha/pi-durable-agent`](../pi-durable-agent/README.md#looking-at-a-store)'s store page over the agent store in the
data directory, with this server's own views beside it:

- **Agents**: each agent with its current revision's kind and its runs, archived ones behind **Show archived**; an
  agent's revisions, newest first, an agentic one's prompt diffed against its parent's and a workflow's graph; its runs,
  filtered by revision. **Archive** (or **Unarchive**) on an agent's page and a run's page.
- **All runs**: every run of every agent, newest first, with its agent, revision, kind, state, cost and start, filtered by
  agent and by state; archived runs behind **Show archived**. A row opens the run. A run `/v2` reports as `failed` with `error.code` `escalated` reads escalated,
  here and on its live page, as the store's page draws it.
- **New agent** and **Edit**: a name, a description, a prompt or a workflow's JSON, for a prompt a model
  (`provider/model-id`, or none for the server's own) and a thinking level, and the tools capabilities list. Creating sends `POST /v2/agents`; an edit starts from the
  current definition, keeps the agent's name and description, and sends `PUT /v2/agents/{id}/definition` with
  `If-Match` set to the revision it started from, which commits a revision and makes it current (or answers 412 when
  another revision came first). **Make current** on an older revision sends `POST /v2/agents/{id}/current`.
- **Start a run**: an input (for a workflow revision, a JSON object its input schema takes), on the current revision or
  another one, sent to `POST /v2/agents/{id}/runs` with that revision's id, so a revision made current elsewhere in the
  meantime does not change what runs. A run the page opens while it is not final follows
  `GET /v2/runs/{id}/timeline` with a long poll; while it waits on `ask_person`, an answer box sends
  `POST /v2/runs/{id}/messages`. The live view leaves out the run's own start and end rows, as the stored view does.
  Once it is final, the page reads it from the store.

With accounts on (the default) the page takes the owner's session cookie ([your password](#your-password)), and a
`?token=` link sets no cookie: the token is for scripts and the CLI. With `AGENTRUN_ACCOUNTS=0`, the link sets a cookie
(`HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` when `X-Forwarded-Proto` says https)
and sends the browser to the same address without the token. The cookie's value is derived from the token, never the
token itself, and it lasts until the browser closes. Without it, `/` is a page that says to open the link. The page's
data (`/api/*` and `/v2`) takes the cookie in place of `Authorization: Bearer`: for a `GET`, and for any other method
only when the request's `Origin` is the page's own origin and its body is `application/json`. A request that sends an
`Authorization` header is checked on that header alone.

## Your password

AgentRun Server is for one person, who signs in to the page with a password (`AGENTRUN_ACCOUNTS=0` turns this off). With
no `AGENTRUN_PUBLIC_URL`, the start prints `Set your password: <url>/setup`, and the first visit sets it, 12 characters or
more. With it, the start prints `Set up this server: <url>/setup#code=<code>`, and setup takes that code (or the token as
the Bearer). The server keeps a scrypt hash of the password, never the password, in `DIR/owner.json`, and signs its
session cookies with the key in `DIR/.session-secret`; both are 0600, and no run reaches either. A session lasts 30 days;
**Sign out everywhere** ends every session on every browser. Sign-in tries are limited per address, ten in 15 minutes, and the limit keeps up to 10,000 addresses: past that a
new address gets a 429 until older ones expire, and an address already limited stays limited. Forgot it: run
`agentrun-serve reset-password --data DIR` where the data directory is (`docker exec agentrun node
/opt/agentrun/packages/serve/dist/cli.js reset-password --data /data` in the image). It clears the password and signs every
browser out, and the next visit sets a new one. The token works for scripts and the CLI either way.

A browser's writes must come from the page's own origin. Serve the image on another address or port behind a proxy, and
set `AGENTRUN_PUBLIC_URL` to the address people open. Behind a proxy every sign-in comes from the proxy's address, so the
limit is one for everyone: ten wrong tries in 15 minutes, from anyone, keep the owner out until the window passes (the
token still works for scripts meanwhile). Serve it over https where you can: on plain http a browser sends the session
cookie to every server on the same host name, whatever its port, so another app on that host could read it.

## A run's life

1. `POST /agents/{id}/runs` starts the run in the store (`startRun`, which pins the revision and seeds
   `DIR/runs/<id>/`), then its process: `pi-durable-disk run --dir DIR/runs/<id> --app <this package's app> --serve 0` on
   loopback, behind a token of its own (`DIR/.door-token`), with its stderr in `runs/<id>/process.log`. The run's input
   is in `runs/<id>/serve.json`.
2. The app reads the run's revision from the store.
   - An agentic revision runs as the root agent: its instructions and skills, its model, and the tools it names of the
     workspace's `read`, `write` and `edit`, and `ask_person`, which ends the turn; the timeline then shows a `waiting`
     row, and the run is `input_required` and `waiting` until a message answers it. `bash` is not bound, so a
     definition that names it is not saved here. The run is `queued` until its first message shows; while the process runs, the
     timeline comes from its door's events through `@parcha/pi-durable-agent/timeline`. Once the run is idle and its
     newest row is the agent's answer, the server sends the process SIGTERM. A model error ends it `failed`
     (`run_failed`), and a run its `max_cost_usd` stops ends `failed` (`spend_cap_reached`, [below](#spend-cap)).
   - A workflow revision runs on agentrun-pi's durable workflow task, started by `startWorkflowRevision` of
     `@parcha/pi-durable-agent/workflow` (keyed by the run's id): its model nodes (`agent`, `decide`, `extract`,
     `report`) on the run's model, with the file tools each node names. A workflow that needs a tool call, a judge or
     code is not saved here (`422`). The run is `queued` until its process serves, then `working`; when the workflow
     ends, the app writes the run's final status with the outcome and releases it. Nothing is carried back from inside
     the process, which holds the run's store until it exits.
3. When the process has exited, the run's rows are read from its released store (an agentic run's conversation, a
   workflow run's model nodes), and the server carries the run back, every run of both kinds: `carryBack` records its
   state, cost and a summary in the store (an agentic run's answer; a workflow run's `workflowCarry`, its completed
   nodes, then where it failed or escalated). Its last
   page says `final`. v2's `cancelled` is the store's `stopped`; a workflow that escalated ends `failed` with
   `error: {code: "escalated", message: <its summary>}`, in the run and in the lists.
4. When the server starts, it reads every run the store says is running. A run process an earlier server started and
   that still serves the run is supervised again, by its `run.json` and its pid; a run that already ended is carried
   back; a run whose process is gone before it ended is opened again on its directory and resumes from its store (an
   agentic run waiting for an answer waits without one, until a message). A carry back that finds the store held by
   another writer is tried again with backoff, and at the next start.

An `Idempotency-Key` answer is kept in `DATA/.idempotency.json` for `limits.idempotency_ttl_s` (a day), written before
the answer is sent, so a retry after a restart gets the first answer.

A completed agentic run's `result` is `{output: null, final_answer}`; a completed workflow run's is
`{output: <the workflow's output>, final_answer: null}`.

## Learning

`learning` is this server's own field on an agentic definition, as `model` is: `auto` or `approve`, and absent when the
agent does not learn.

- A new agentic agent gets `auto`, stored in its revision.
- Unlike every other field, an edit that leaves `learning` out keeps the current revision's value. `learning: null`
  turns it off.
- A revision saved before the field existed does not learn.
- A workflow definition does not take it (`422 not_an_option`).
- The `learn` tool comes with learning. Naming `learn` in `tools` while learning is off is `422` on `definition.tools[i]`,
  and the fix is to set `learning` to `auto` or `approve`.

Learning needs git 2.40 or later on `PATH`. The container image is on Debian bookworm, which has git 2.39. On a host
without it, a new agent does not learn. A definition that asks for learning saves with a `not_set_up_here` warning, and
its runs are refused with `409 agent_not_runnable` until git is there.

- An agent that learns has one bare git repository, `DATA/agents/<id>/learning.git`, beside the store. The revision
  holds what a person wrote, and the repository holds what the agent learned, in `@parcha/agentrun-learn`'s layout:
  notes in `learnings/` with their `INDEX.md`, skills the agent wrote in `.agents/skills/`, workflow drafts, and memos.
- Its `main` carries `AGENTS.md` (the current revision's instructions) and `agent.json` (its definition). The server
  writes them as one commit, with a `Revision` trailer, whenever the current revision changes: a create, an edit, or
  `POST .../current`. A run's start makes that commit too, so one that failed is made then. A failed host commit is
  logged and never fails the save.
- Every write to an agent's repository goes through one queue per agent in the server: the host commit, the
  proposals, and the review that merges them.
- A run starts from `main` at one commit. Its process resolves `main` once and journals the commit in the run's own
  store (`learn.seed`), and a process that opens the run again reads it back, so the run's base never moves. The
  notes active at that commit are copied to `work/.agent/learnings/`, and their index is the `<learned>` section of
  the prompt. The skills the agent wrote at that commit join the revision's own; a revision skill of the same name
  wins. The run gets the `learn` tool, which notes a lesson, a fact or a correction in its store. The run's process
  reads the repository through a clone of its own, `runs/<id>/learning.git`. That clone is outside `work/`, so no tool
  of the run reaches it or the repository, and the process never pushes.
- Once the run's end is carried back, the server proposes what the run learned as the branch `runs/<run id>` from that
  commit. It reads the outcome and the cost from the carry back. The branch holds the memo `memos/<run id>.md`, a note
  for each lesson and the index. The memo's front matter is the server's: `run`, `base`, `harness: pi`, `outcome`
  (`completed`, `failed`, or `stopped` for a cancelled run), `untrusted` and `cost_usd`. `untrusted` is true when the
  run called an external tool, meaning any tool but `read`, `write`, `edit`, `ask_person` and `learn`.
- The server records each proposal in `DATA/agents/<id>/learning/runs/<run id>.json` (`proposed`, `empty` or
  `refused`). At start it proposes every ended run of a learning agent that has no record yet, so a server that stopped
  between a carry back and its proposal loses nothing. That pass waits for an agent store another writer holds, and
  says so in the log; if the store stays busy, the next start proposes what is left. The commit's `Run-Id` trailer makes a second proposal of the
  same run add nothing. A proposal that fails (a push the repository refuses) is logged; the run has ended as it would
  have, and the next start proposes it. A run that learned nothing leaves no branch.
- The guard refuses a note that holds a value of one of the server's secrets: the variables whose names end in `KEY`,
  `TOKEN`, `SECRET` or `PASSWORD`. A credential inside a variable named otherwise (a `..._URL` such as
  `postgres://user:password@host/db`) is not among them.
- Nothing merges into `main` yet. A run's branch stays a proposal until review and merge exist, and those wait for an
  injection screen on this server.

## Spend cap

An agentic run may name `max_cost_usd` (a workflow run may not: `422`). The cap is checked in the run's own process
before each model request, the agent's and a compaction's alike: what the run has spent so far plus the request's worst
case must stay within it, or the request is not sent and the run ends `failed` with `spend_cap_reached`. The worst
case is the request's input tokens at the input price plus its max output tokens at the output price, the max output
tokens being the ones the request sends (the model's, clamped to what its context window leaves). The input is priced
at the higher of the model's input and cache-write prices, since the provider may bill any of it as a cache write. The
input tokens are pi-ai's estimate (`estimateContextTokens`: the tokens the last response reported, plus about one token
per 3.5 characters after it), which may run low on code or non-English text; the server's check after each response
catches what it misses. Spent so far is read from the run's store each time its process starts, so it survives a
restart, plus each response since; a request in flight holds its worst case until it answers. A model priced at $0 (a
gateway id pi-ai's catalog does not know, with no `AGENT_MODEL_PRICE`) never reaches a cap. Pricing the whole output
ceiling is strict: on a model with 64,000 max output tokens at $15 per million, one request's worst case is about $0.96,
so any cap under about $1 refuses the first request; set a cap above one request's ceiling.

The server also checks the run's cost after each response, as a backstop, and stops a run whose cost passed its cap.
Either way the run keeps the answer it paid for: a run the cap stopped has `result: {output: null, final_answer}`, the
newest answer it received, beside its `error`; one stopped before any answer has `result: null`.

A run's `cost.usd` is $0 before its first model request (a run cancelled before one included), and `null` when a
response reported no price: no request costs nothing, but a request of unknown price is unknown, never $0.

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
the `browser` tool's `{ provider, driver }` in place of Browserbase's (pi-browser's fake backend,
`test/fixtures/faux-browser.mjs`), and `fetch_page`'s `{ lookup, fetchImpl }` in place of the system's resolver and
undici (a table of names and pages, `test/fixtures/faux-web.mjs`). Each is honored only with `faux`.

`faux.message`, `faux.text`, `faux.thinking` and `faux.toolCall` are pi-ai's faux helpers; `faux.signal` is aborted when
the turn is stopped. A workflow's model node offers the `submit` tool (in its system message's `toolsAdded`), and
delivers its record by calling it. A module may also export `cost` (`{input, output, cacheRead, cacheWrite}` in USD per
million tokens) to price the faux usage; unpriced, every run's estimate is $0, and with `cost = "unknown"` its usage
carries no cost at all, as from a provider that does not price the model. The tests' module is
`test/fixtures/faux-model.mjs`.

## Safety

- `fetch_page` dials public addresses only, each hop checked and pinned (see [Tools](#tools)): a run cannot reach this
  machine, its network or a cloud's metadata address through it.
- A `browser` session runs at Browserbase, not on this machine: a page the model opens is reached from Browserbase's
  network, so what the model may reach there is the operator's choice of keys and project. Its downloads and uploads stay
  in the run's `work/`.
- It binds 127.0.0.1 by default, and there refuses a request whose `Host` is not a loopback name (DNS rebinding). On
  another address (`--listen`, the container's `0.0.0.0`) it serves every `Host` name, and the token is its only lock.
  It sends no CORS headers, so a page on another origin cannot read an answer.
- Every route but `GET /capabilities` needs `Authorization: Bearer <the token>`, compared in constant time, or the
  page's cookie under the rules of [the page](#the-page). The page's own files (its HTML, scripts and styles) hold no
  data; everything it shows comes through those routes. It loads nothing from the network, and its CSP allows this
  origin only.
- Each run's door listens on loopback and takes only the server's door token.
- A run's process gets the server's environment (model keys and the `AGENT_MODEL` variables among it) without the
  server's token: no `AGENTRUN_TOKEN`, no `AGENTRUN_API_KEY`, and no variable whose value is the token.
- A run's file tools (`read`, `write`, `edit`) reach its own `work/`, and two places of its own beside it: `read` also
  reaches the run's `tmp/` (next to `work/`, where a command's spilled output would go), and a write may also land in a
  temporary directory the run's environment made for a tool (`createTempDir`). Every other path, a link inside `work/`
  included, is resolved and refused (`outside the workspace`), so a run reads neither the server's token, the door
  token, `store.sqlite`, another run's files (its `work/` or its `tmp/`) nor `/proc`, and writes nowhere else. This is
  pi-durable-disk's confinement inside the run's process, not an operating-system boundary: the run and the server
  share a user (one uid in the container), so the confinement holds only because the run has no shell.
- No path offers a shell. `bash` is not bound: a definition that names it is not saved here (`422`), one saved before
  that check is not runnable (`409`), and a model that
  calls it anyway, as an agent or as a workflow's model node, is answered that the tool is not available and runs
  nothing. There is no sandbox box in this phase, so shell stays off.
- Files are served from `work/` only. A path with an empty, `.` or `..` segment, a backslash or a NUL is
  `400 invalid_file_path`; a segment that starts with `.` (the run's skills under `.agents/`) is
  `403 system_file_forbidden`; a symlink on the way is `404`. Every answer is `nosniff`, and HTML carries a CSP with
  `sandbox` and `default-src 'none'`.

## Test

```sh
npm run build -w @parcha/agentrun-dsl -w @parcha/agentrun-pi -w @parcha/pi-durable-disk -w @parcha/pi-durable-agent -w @parcha/agentrun-serve
npm test -w @parcha/agentrun-serve
```

The tests start real run processes on the faux model, both kinds: no key, no network.
