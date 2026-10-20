# @parcha/agentrun-serve

The Agentrun v2 API on your own machine. `agentrun-serve` serves the same `/v2` contract (`agentrun.v2/0`) as the hosted
API, over agents you keep in a directory: each agent is an agent home of
[`@parcha/pi-durable-agent`](../pi-durable-agent/README.md) (its definition, its skills, its runs index), and each run is
a [`@parcha/pi-durable-disk`](../pi-durable-disk/README.md) run directory inside it. An SDK pointed at it works the way
it works against the hosted API; the capabilities document says what this server does not offer.

This package is held: it is built and tested in this repository and not published yet.

## Quick start (no key, no network)

Node 22.19 or later. The package is not on npm yet: install it from the tarballs `npm pack` makes in a checkout of
this repository (it and the `@parcha` packages it uses), or build the checkout (`npm ci --ignore-scripts && npm run
build`) and write `node packages/serve/dist/cli.js` where the script below says `node_modules/.bin/agentrun-serve`.

Save a faux model as `faux.mjs`. It stands in for the model, with no key and no network: the agent runs one command
with `bash`, then answers.

```js
export default function reply(context, faux) {
  if (context.messages.at(-1)?.role !== "toolResult") return faux.message(faux.toolCall("bash", { command: "echo hello > hi.txt" }), { stopReason: "toolUse" });
  return faux.message("I wrote hello into hi.txt.");
}
```

Save this as `walk.mjs`. With plain `fetch`, it makes an agent that names `bash`, starts a run, reads the timeline
until a page says `final`, and prints the run's status, its answer and the file the command wrote:

```js
const base = process.env.AGENTRUN_BASE_URL;
const headers = { authorization: `Bearer ${process.env.AGENTRUN_API_KEY}`, "content-type": "application/json" };
async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : text;
}

const { agent_id } = await api("POST", "/agents", {
  definition: { version: 1, name: "Shell", instructions: "Do what the person asks.", skills: [], tools: ["bash"] },
});
const { run_id } = await api("POST", `/agents/${agent_id}/runs`, { input: { content: "Write hello into hi.txt." } });
for (let after = 0, page; !page?.final; after = page.next_after) {
  page = await api("GET", `/runs/${run_id}/timeline?after=${after}&wait_ms=5000`);
}
const run = await api("GET", `/runs/${run_id}`);
const file = await api("GET", `/runs/${run_id}/files/hi.txt`);
console.log(`${run.status}: ${run.result.final_answer} hi.txt: ${file.trim()}`);
```

Save this as `walk.sh` and run `sh walk.sh`. It starts the server on a free port, exports the two lines it prints
(`AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY`, the token), runs the walk, and stops the server:

```sh
node_modules/.bin/agentrun-serve --faux faux.mjs --port 0 > serve.log 2>&1 &
trap 'kill $!; wait $!' EXIT
until grep -q '^AGENTRUN_API_KEY=' serve.log; do kill -0 $! || exit 1; sleep 0.2; done
export $(grep '^AGENTRUN_' serve.log)
node walk.mjs
```

It prints one line:

```text
completed: I wrote hello into hi.txt. hi.txt: hello
```

Started on its own with no `--port`, the server listens on port 7340 and prints where, and the token:

```text
agentrun-serve on http://127.0.0.1:7340/v2 (agent homes in ~/.local/share/agentrun/agents)
AGENTRUN_BASE_URL=http://127.0.0.1:7340/v2
AGENTRUN_API_KEY=ar_local_...
```

The agent's home is in that data directory, and the run's files are in its `runs/<run_id>/work/`.

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

## Tools

An agent's tools come from [`@parcha/agentrun-harness`](../harness/README.md#serve-uses-this): a definition may name
any tool of the harness's vocabulary that this server's host offers, and `ask_person`, which is serve's own.

| Name | What | Needs |
| --- | --- | --- |
| `read`, `write`, `edit`, `bash` | files and commands in the run's `work/` | nothing |
| `code` | code mode: a script with `tools.bash`, `vision.see` and `vision.judge` | nothing; `vision.judge` answers only with `TYPESAFE_API_KEY` |
| `snapshot`, `run`, `screenshot`, `browser_read`, `browser_release`, `browser_relaunch` | a browser | `CHROME_PATH` (a Chrome on this machine) or both `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` |
| `ask_person` | a question to the person who started the run; the turn ends until they answer | nothing |

The server reads what its host offers once, when it starts, from its own environment, and each run's app builds the
same host from the same environment. Capabilities say which browser it is (`features.browser`: `chrome`,
`browserbase` or `none`). A definition may name a tool this server does not offer: the agent is created, since a
definition moves between backends, and a run of it is refused before it starts with `409 agent_not_runnable`, the
harness's reason, and `details: {bound, unbound}`.

A command the agent runs, through `bash` or `code`, runs with your user's rights; there is no command sandbox yet. It
gets only `PATH`, `HOME`, `TMPDIR` and `LANG` from the server's environment, so none of its keys.

## A run's life

1. `POST /agents/{id}/runs` starts the run in the home (`startRun`, host `agentrun-serve`), then its process:
   `pi-durable-disk run --dir <home>/runs/<id> --app <this package's app> --serve 0` on loopback, behind a token of its
   own (`DIR/.door-token`), with its stderr in `runs/<id>/process.log`. The run is `queued` until its first message shows.
2. The app builds the run on the harness (`agentApp` on the host `hostFromEnv` makes from the environment, see
   [Tools](#tools)): the definition's instructions and skills, the model this server binds, and exactly the tools the
   definition names. `ask_person` ends the turn; the timeline then shows a `waiting` row, and the run is
   `input_required` and `waiting` until a message answers it.
3. While the process runs, the timeline comes from its door's events through `@parcha/pi-durable-agent/timeline`.
4. Once the run is idle and its newest row is the agent's answer, the server sends the process SIGTERM. When it has
   exited, the run's rows are read from its released store, and `carryBack` records its outcome, answer and cost in the
   home. The run is `completed` and its last page says `final`. A model error ends it `failed` (`run_failed`), and a
   run whose cost estimate passes its `max_cost_usd` ends `failed` (`spend_cap_reached`).

5. When the server starts, it reads every run of every agent that is not carried back yet. A run process an earlier
   server started and that still serves the run is supervised again, by its `run.json` and its pid; a run that already
   ended is carried back. A carry back that finds the home held by another writer is tried again with backoff, and at
   the next start.

An `Idempotency-Key` answer is kept in `DATA/.idempotency.json` for `limits.idempotency_ttl_s` (a day), written before
the answer is sent, so a retry after a restart gets the first answer.

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
