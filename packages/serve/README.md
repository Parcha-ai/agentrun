# @parcha/agentrun-serve

The Agentrun v2 API on your own machine. `agentrun-serve` serves the same `/v2` contract (`agentrun.v2/0`) as the hosted
API, over one agent store of [`@parcha/pi-durable-agent`](../pi-durable-agent/README.md) in a directory: many agents,
each with revisions written once (an agentic prompt, or an agentrun-dsl workflow), and every run pinned to the revision
it ran. Each run is a [`@parcha/pi-durable-disk`](../pi-durable-disk/README.md) run directory beside the store. An SDK
pointed at it works the way it works against the hosted API; the capabilities document says what this server does not
offer.

This package is held: it is built and tested in this repository and not published yet.

## Quick start (no key, no network)

Node 22.19 or later. In a checkout of this repository:

```sh
npm ci --ignore-scripts && npm run build
cat > faux.mjs <<'JS'
export default (context, faux) => faux.message("The answer is 42.");
JS
node packages/serve/dist/cli.js --faux faux.mjs
```

It prints where it listens and the token:

```
agentrun-serve on http://127.0.0.1:7340/v2 (agent store in ~/.local/share/agentrun/agents)
AGENTRUN_BASE_URL=http://127.0.0.1:7340/v2
AGENTRUN_API_KEY=ar_local_...
Open http://127.0.0.1:7340/?token=ar_local_...
```

The last line opens [the page](#the-page). For a client, export the two lines before it, then make an agent, start a
run, and read its timeline until a page says `final`:

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
| `--data DIR` | `~/.local/share/agentrun/agents` | The agent store (`DIR/store.sqlite`) and its runs (`DIR/runs/<id>/`). The token is `DIR/.token`, mode 0600, made once and kept. |
| `--port N` | `7340` | The port on 127.0.0.1. `0` is any free port. |
| `--faux MODULE` | none | Answer every model request from the module's default export (below). |
| `--allow-host NAME` | none | Another `Host` name to accept. Repeat it. |

## Models

An agentic revision names its model as `provider/model-id` (`"model"` in its definition), or names none and runs on
this host's default, `AGENT_MODEL`. A workflow revision names no model: each model node names a tier (`fast`, `default`
or `strong`), and the host maps it, `fast` to `AGENT_MODEL_FAST` and `strong` to `AGENT_MODEL_STRONG`, each falling back
to `AGENT_MODEL`. Capabilities show the mapping in `models` (`{source, fast, default, strong}`). Where the models come
from:

- `--faux MODULE`: every model is the module's (below), with no key and no network: `faux-1`, or for a tier the model
  id its variable names.
- `AGENT_MODEL_BASE_URL`: every model id goes to that one OpenAI Responses endpoint, a gateway: a revision's
  `provider/model-id` is sent as `model-id`, and `AGENT_MODEL`, `AGENT_MODEL_FAST` and `AGENT_MODEL_STRONG` are sent as
  they are. `AGENT_MODEL_API_KEY` is its key when it needs one. `AGENT_MODEL_PRICE` is `input,output,cacheRead[,cacheWrite]`
  in USD per million tokens, so a run's cost estimate has a price; `AGENT_MODEL_FAST_PRICE` and `AGENT_MODEL_STRONG_PRICE`
  price their tier's model, and default to it.
- Otherwise pi-ai's providers serve them, each with its key from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  ...), and its catalog prices the run. The `AGENT_MODEL` variables are then `provider/model-id` too.

A run whose model cannot be reached here (no model for the revision or for a tier its workflow's nodes name, a model
pi-ai does not know, no key for its provider) is refused before it starts, `409 agent_not_runnable`, saying which. A run
thinks at its `effort` (`low`, `medium`, `high`), else at its agentic revision's `thinking` (`low` to `max`), else at the
host's `AGENT_THINKING`, else at medium; it is never off, and a model node that names its own thinking level keeps it.

## What it serves

| Route | Here |
| --- | --- |
| `GET /capabilities` | Without a credential. `backend: local`, every feature flag present and true only when it works; `tools`, the tools an agentic revision may name; `workflows`, what a workflow revision's model nodes get; `models`, where models come from and the model of each tier. |
| `POST /agents`, `GET /agents`, `GET /agents/{id}` | `POST` takes `{definition, skills?, note?}` and makes the agent with its first revision, current. A definition has `instructions` (an agentic revision) or `workflow` (a workflow revision, checked by the DSL first), and `name`, `description`, `model` and `thinking` (agentic only), `tools`, `skills` (names; each `<name>/SKILL.md` is in `skills`) and `version`, which is the number the revision gets. A field the store does not keep (`input_schema`, `output_schema`, `max_cost_usd`) is `422 input_invalid` by name. The ETag (`home_etag`) is the current revision's id. |
| `PUT /agents/{id}/definition` | The same body: a new revision, its parent the current one, made current. Without `skills` the current revision's skill files carry over. A definition that is the current revision already writes nothing, so a PUT sent twice makes one revision. An agent's id, name and description stay those it was made with. `If-Match` that is not the current ETag is `412 precondition_failed`. |
| `GET /agents/{id}/revisions` | The agent's revisions, newest first: `revision`, `version`, `parent`, `kind`, `current`, `note`, `created_at` and the `definition`. |
| `POST /agents/{id}/current` | `{revision}`: one of the agent's revisions becomes current again. |
| `POST /agents/{id}/runs`, `GET /agents/{id}/runs` | A run of the current revision, or of `revision`. An agentic run's input is `{content: string}`; a workflow run's is what its workflow's input schema takes. The agent's runs, newest first. |
| `GET /runs` | Every agent's runs, newest first, a page of at most 100; `agent`, `revision` and `status` narrow it. A failed run's summary carries its `error`. |
| `GET /runs/{id}` | The run: its revision, kind, status, state, result, error and cost (`basis: estimate`). |
| `GET /runs/{id}/timeline` | JSON pages with the change-number cursor (`after`, `next_after`, `reset`, `drop`, `has_more`, `final`, `wait_ms` long poll), or server-sent events with `Accept: text/event-stream` (`id` is the cursor, `Last-Event-ID` resumes). |
| `POST /runs/{id}/messages` | To an agentic run: `steer` while the agent works, `answer` when it asked the person, `follow_up` after a stop. A finished run is `409 not_continuable`; a workflow run takes none (`501`). |
| `POST /runs/{id}/stop`, `POST /runs/{id}/cancel` | Stop ends an agentic run's turn and leaves the run `input_required` and idle. Cancel ends a run `cancelled` once its process has exited. |
| `GET /runs/{id}/files`, `GET /runs/{id}/files/{path}` | The files under the run's `work/`, raw. |
| `GET /usage` | The runs' cost estimates, by meter, agent, day or region. |

Home export and import, uploads (`/files`), quotes and `POST /runs/{id}/kill` answer `501 unsupported_here` naming the
feature, and capabilities declare each one false. No run waits out `input_wait_s` here (`null`), and runs carry no
browser sign-ins (`sign_ins: false`).

## The page

Open the link the server prints, once, in a browser. The page at `/`, AgentRun Server, is
[`@parcha/pi-durable-agent`](../pi-durable-agent/README.md#looking-at-a-store)'s store page over the agent store in the
data directory, with this server's own views beside it:

- **Agents**: each agent with its current revision's kind and its runs; an agent's revisions, newest first, an agentic
  one's prompt diffed against its parent's and a workflow's graph; its runs, filtered by revision.
- **All runs**: every run of every agent, newest first, with its agent, revision, kind, state, cost and start, filtered by
  agent and by state. A row opens the run. A run `/v2` reports as `failed` with `error.code` `escalated` reads escalated,
  here and on its live page, as the store's page draws it.
- **New agent** and **Edit**: a name, a description, a prompt or a workflow's JSON, for a prompt a model
  (`provider/model-id`, or none for the server's own) and a thinking level, and the tools capabilities list. Creating sends `POST /v2/agents`; an edit starts from the
  current definition, keeps the agent's name and description, and sends `PUT /v2/agents/{id}/definition` with
  `If-Match` set to the revision it started from, which commits a revision and makes it current (or answers 412 when
  another revision came first). **Make current** on an older revision sends `POST /v2/agents/{id}/current`.
- **Start a run**: an input (for a workflow revision, a JSON object its input schema takes), on the current revision or
  another one, sent to `POST /v2/agents/{id}/runs`. A run the page opens while it is not final follows
  `GET /v2/runs/{id}/timeline` with a long poll; while it waits on `ask_person`, an answer box sends
  `POST /v2/runs/{id}/messages`. The live view leaves out the run's own start and end rows, as the stored view does.
  Once it is final, the page reads it from the store.

The link sets a cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` when `X-Forwarded-Proto` says https)
and sends the browser to the same address without the token. The cookie's value is derived from the token, never the
token itself, and it lasts until the browser closes. Without it, `/` is a page that says to open the link. The page's
data (`/api/*` and `/v2`) takes the cookie in place of `Authorization: Bearer`: for a `GET`, and for any other method
only when the request's `Origin` is the page's own origin and its body is `application/json`. A request that sends an
`Authorization` header is checked on that header alone.

## A run's life

1. `POST /agents/{id}/runs` starts the run in the store (`startRun`, which pins the revision and seeds
   `DIR/runs/<id>/`), then its process: `pi-durable-disk run --dir DIR/runs/<id> --app <this package's app> --serve 0` on
   loopback, behind a token of its own (`DIR/.door-token`), with its stderr in `runs/<id>/process.log`. The run's input
   is in `runs/<id>/serve.json`.
2. The app reads the run's revision from the store.
   - An agentic revision runs as the root agent: its instructions and skills, its model, and the tools it names of the
     workspace's `read`, `write` and `edit`, and `ask_person`, which ends the turn; the timeline then shows a `waiting`
     row, and the run is `input_required` and `waiting` until a message answers it. `bash` is not bound, so a revision
     that names it is not runnable here. The run is `queued` until its first message shows; while the process runs, the
     timeline comes from its door's events through `@parcha/pi-durable-agent/timeline`. Once the run is idle and its
     newest row is the agent's answer, the server sends the process SIGTERM. A model error ends it `failed`
     (`run_failed`), and a run whose cost estimate passes its `max_cost_usd` ends `failed` (`spend_cap_reached`).
   - A workflow revision runs on agentrun-pi's durable workflow task, started by `startWorkflowRevision` of
     `@parcha/pi-durable-agent/workflow` (keyed by the run's id): its model nodes (`agent`, `decide`, `extract`,
     `report`) on the run's model, with the file tools each node names. A workflow that needs a tool call, a judge or
     code is not runnable here (`409`). The run is `queued` until its process serves, then `working`; when the workflow
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

`faux.message`, `faux.text`, `faux.thinking` and `faux.toolCall` are pi-ai's faux helpers; `faux.signal` is aborted when
the turn is stopped. A workflow's model node offers the `submit` tool (in its system message's `toolsAdded`), and
delivers its record by calling it. A module may also export `cost` (`{input, output, cacheRead, cacheWrite}` in USD per
million tokens) to price the faux usage; unpriced, every run's estimate is $0. The tests' module is
`test/fixtures/faux-model.mjs`.

## Safety

- It binds 127.0.0.1 only, and refuses a request whose `Host` is not a loopback name (DNS rebinding). It sends no CORS
  headers, so a page on another origin cannot read an answer.
- Every route but `GET /capabilities` needs `Authorization: Bearer <DIR/.token>`, compared in constant time, or the
  page's cookie under the rules of [the page](#the-page). The page's own files (its HTML, scripts and styles) hold no
  data; everything it shows comes through those routes. It loads nothing from the network, and its CSP allows this
  origin only.
- Each run's door listens on loopback and takes only the server's door token.
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
