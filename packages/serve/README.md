# @parcha/agentrun-serve

The Agentrun v2 API on your own machine. `agentrun-serve` serves the same `/v2` contract (`agentrun.v2/0`) as the hosted
API, over agents you keep in a directory: each agent is an agent home of
[`@parcha/pi-durable-agent`](../pi-durable-agent/README.md) (its definition, its skills, its runs index), and each run is
a [`@parcha/pi-durable-disk`](../pi-durable-disk/README.md) run directory inside it. An SDK pointed at it works the way
it works against the hosted API; the capabilities document says what this server does not offer.

This package is held: it is built and tested in this repository and not published yet.

## Quick start (no key, no network)

Node 22.19 or later. In a checkout of this repository:

```sh
npm ci --ignore-scripts && npm run build
cat > faux.mjs <<'JS'
export default (context, faux) => faux.message("The answer is 42.");
JS
node packages/agentrun-serve/dist/cli.js --faux faux.mjs
```

It prints where it listens and the token:

```
agentrun-serve on http://127.0.0.1:7340/v2 (agent homes in ~/.local/share/agentrun/agents)
AGENTRUN_BASE_URL=http://127.0.0.1:7340/v2
AGENTRUN_API_KEY=ar_local_...
```

Export those two lines and make an agent, start a run, and read its timeline until a page says `final`:

```sh
H="authorization: Bearer $AGENTRUN_API_KEY"
curl -s "$AGENTRUN_BASE_URL/agents" -H "$H" -H 'content-type: application/json' \
  -d '{"definition":{"id":"calc","version":1,"name":"Calc","instructions":"Answer the question.","skills":[],"tools":[]}}'
run=$(curl -s "$AGENTRUN_BASE_URL/agents/calc/runs" -H "$H" -H 'content-type: application/json' \
  -d '{"input":{"content":"What is six times seven?"}}' | node -p 'JSON.parse(require("fs").readFileSync(0)).run_id')
curl -s "$AGENTRUN_BASE_URL/runs/$run/timeline?wait_ms=5000" -H "$H"
curl -s "$AGENTRUN_BASE_URL/runs/$run" -H "$H"
```

For a real model, leave out `--faux` and name an OpenAI Responses endpoint: `AGENT_MODEL_BASE_URL`, `AGENT_MODEL`, and
`AGENT_MODEL_API_KEY` when it needs a key (`AGENT_MODEL_PRICE` is `input,output,cacheRead[,cacheWrite]` in USD per
million tokens, so a run's cost estimate has a price). A run's `effort` (`low`, `medium`, `high`) is its thinking level.
Without a model, capabilities name none and a run is refused with `409 agent_not_runnable`.

| Flag | Default | What |
| --- | --- | --- |
| `--data DIR` | `~/.local/share/agentrun/agents` | The agent homes, one directory per agent id. The token is `DIR/.token`, mode 0600, made once and kept. |
| `--port N` | `7340` | The port on 127.0.0.1. `0` is any free port. |
| `--faux MODULE` | none | Answer every model request from the module's default export (below). |
| `--allow-host NAME` | none | Another `Host` name to accept. Repeat it. |
| `--verbose` | off | Forward each run process's stderr. |

## What it serves

| Route | Here |
| --- | --- |
| `GET /capabilities` | Without a credential. `backend: local`, every feature flag present and true only when it works. |
| `POST /agents`, `GET /agents`, `GET /agents/{id}` | A home per agent, from a definition and its skill files. A field the home does not keep (a model, for one) is `422 input_invalid` by name. `GET` answers the home's ETag. |
| `POST /agents/{id}/runs`, `GET /agents/{id}/runs` | A run from the agent's home, its input checked against the definition's `input_schema` (top level) or `{content: string}`. The runs index, newest first. |
| `GET /runs/{id}` | The run: status, state, result, error, cost (`basis: estimate`). |
| `GET /runs/{id}/timeline` | JSON pages with the change-number cursor (`after`, `next_after`, `reset`, `drop`, `has_more`, `final`, `wait_ms` long poll), or server-sent events with `Accept: text/event-stream` (`id` is the cursor, `Last-Event-ID` resumes). |
| `POST /runs/{id}/messages` | `steer` while the agent works, `answer` when it asked the person, `follow_up` after a stop. A finished run is `409 not_continuable`. |
| `POST /runs/{id}/stop`, `POST /runs/{id}/cancel` | Stop ends the turn and leaves the run `input_required` and idle. Cancel ends the run `cancelled` once its process has exited. |
| `GET /runs/{id}/files`, `GET /runs/{id}/files/{path}` | The files under the run's `work/`, raw. |
| `GET /usage` | The runs' cost estimates, by meter, agent, day or region. |

Home export and import, `PUT .../definition`, uploads (`/files`), quotes and `POST /runs/{id}/kill` answer
`501 unsupported_here` naming the feature, and capabilities declare each one false. No run waits out `input_wait_s`
here (`null`), and runs carry no browser sign-ins (`sign_ins: false`).

## A run's life

1. `POST /agents/{id}/runs` starts the run in the home (`startRun`, host `agentrun-serve`), then its process:
   `pi-durable-disk run --dir <home>/runs/<id> --app <this package's app> --serve 0` on loopback, behind a token of its
   own (`DIR/.door-token`). The run is `queued` until its first message shows.
2. The app gives the agent its definition's instructions and skills, the model this server binds, and the tools the
   definition names: the workspace's `read`, `write` and `edit`, and `ask_person`, which ends the turn; the timeline
   then shows a `waiting` row, and the run is `input_required` and `waiting` until a message answers it. `bash` is not
   bound, so a definition that names it is not runnable here.
3. While the process runs, the timeline comes from its door's events through `@parcha/pi-durable-agent/timeline`.
4. Once the run is idle and its newest row is the agent's answer, the server sends the process SIGTERM. When it has
   exited, the run's rows are read from its released store, and `carryBack` records its outcome, answer and cost in the
   home. The run is `completed` and its last page says `final`. A model error ends it `failed` (`run_failed`), and a
   run whose cost estimate passes its `max_cost_usd` ends `failed` (`spend_cap_reached`).

A run's `result.output` is null when the definition has no `output_schema`. With one, it is the final answer parsed as
a JSON object (the whole answer, or one fenced `json` block), checked at the schema's top level (required properties and
their types); an answer that is not such an object ends the run `failed` (`output_invalid`).

An agent's ETag (`home_etag`) is its home's revision, the agent store's head commit number, which every write moves.

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
the turn is stopped. A module may also export `cost` (`{input, output, cacheRead, cacheWrite}` in USD per million
tokens) to price the faux usage; unpriced, every run's estimate is $0. The tests' module is
`test/fixtures/faux-model.mjs`.

## Safety

- It binds 127.0.0.1 only, and refuses a request whose `Host` is not a loopback name (DNS rebinding). It sends no CORS
  headers, so a page on another origin cannot read an answer.
- Every route but `GET /capabilities` needs `Authorization: Bearer <DIR/.token>`, compared in constant time.
- Each run's door listens on loopback and takes only the server's door token.
- Files are served from `work/` only. A path with an empty, `.` or `..` segment, a backslash or a NUL is
  `400 invalid_file_path`; a segment that starts with `.` (the run's skills under `.agents/`) is
  `403 system_file_forbidden`; a symlink on the way is `404`. Every answer is `nosniff`, and HTML carries a CSP with
  `sandbox` and `default-src 'none'`.

## Test

```sh
npm run build -w @parcha/pi-durable-disk -w @parcha/pi-durable-agent -w @parcha/agentrun-serve
npm test -w @parcha/agentrun-serve
```

The tests start real run processes on the faux model: no key, no network.
