# @parcha/agentrun-client

A typed TypeScript client for an AgentRun server you host yourself, the open platform's server: one method per operation of
its API, typed from the OpenAPI document it serves, plus waiting for a run and following its timeline. No dependencies: it
uses `fetch`, on Node.js 22.19 or newer.

## Install

```sh
npm install @parcha/agentrun-client
```

The package is held in this repository until its first release.

## Construct

```ts
import { AgentRun } from "@parcha/agentrun-client";

const client = new AgentRun({ baseUrl: "https://agentrun.example.com/v2", apiKey: process.env.AGENTRUN_API_KEY });
```

`baseUrl` defaults to `AGENTRUN_BASE_URL` and `apiKey` to `AGENTRUN_API_KEY`. The base URL must be http or https with no
query, fragment, user or password, and the key must be a valid header value; both are checked here, before any request. The
client reads no file: finding the server started on this machine (its data directory and the address it records there) is
the CLI's job (`npx @parcha/agentrun`), not this package's. Other options: `timeoutMs` for one try of a request (default
60000), `maxRetries` (default 4) and `fetch`.

Methods are grouped as the CLI's commands are: `agents create` is `client.agents.create(body)`, `runs start AGENT` is
`client.runs.start(agentId, body)`. Path parameters come first, then the body, then query and header parameters as one
object, then `{ signal, timeoutMs }`. An operation whose answer carries an ETag (`agents.get`, `learning.read`) resolves
to `{ body, etag }`: pass `etag` as the next write's `If-Match`.

## Examples

Create an agent, start a run with a spend cap and wait for it:

```ts
await client.agents.create({ definition: { id: "notes", version: 1, name: "Notes", instructions: "Write what you are asked to a file.", skills: [], tools: ["write", "ask_person"] } });
const started = await client.runs.start("notes", { input: { content: "Write notes.md about the Moon." }, max_cost_usd: 0.5 });
const run = await client.runs.wait(started.run_id, { timeoutMs: 120_000 });
console.log(run.status, run.cost.usd);
```

`runs.wait` resolves once the run ends (`completed`, `failed`, `cancelled`) or waits on a person (`input_required`,
`paused`). Answer a question, or raise the cap of a run stopped at it, then wait again:

```ts
if (run.pending?.kind === "question") await client.runs.message(run.run_id, { content: "Europe" });
if (run.pending?.kind === "budget") await client.runs.raiseCap(run.run_id, { max_cost_usd: 1 });
const done = await client.runs.wait(run.run_id);
```

Follow the timeline as it changes, then read a file the run wrote:

```ts
for await (const page of client.runs.follow(done.run_id)) {
  for (const row of page.rows) console.log(row.kind);
}
const bytes = await client.runs.readFile(done.run_id, "notes.md"); // a Uint8Array, byte for byte
const response = await client.runs.readFile(done.run_id, "notes.md", undefined, { stream: true }); // the Response, unread
```

`runs.follow` reads the route's event stream and resumes a dropped connection with `Last-Event-ID`, so no page comes twice.
Only the server's silence counts as a dropped connection (`idleMs`, default 45000), never the time your loop spends on a
page.

## Errors

Every error is an `AgentRunError`, and its `kind` says which one:

| Class | `kind` | When | Fields |
|---|---|---|---|
| `AgentRunRefused` | `refused` | The server refused (4xx, 5xx); a redirect away from the base URL's origin (`code` `redirect`); an answer the client cannot read (`code` `bad_answer`) | `status`, `code`, `error` (the server's error object) |
| `AgentRunAuthError` | `auth` | No key (`reason` `no_token`), a key that is not a valid header value (`bad_header`), or a key the server refused, 401 or 403 (`refused`) | `reason`, `status`, `code`, `error` |
| `AgentRunUnsupported` | `unsupported` | The server does not offer the operation here (501) | `capability` |
| `AgentRunUnreachable` | `unreachable` | No answer: the server is down, or the connection dropped | `cause`, the failure's code |
| `AgentRunUsage` | `usage` | A bad argument, before anything was sent: a path argument with a `.` or `..` segment, a header value with a line break | `reason` |
| `AgentRunTimeout` | `late` | `runs.wait` passed its `timeoutMs`; the run goes on | `runId`, `run` as last read |

No message holds the API key or the server's own message text: a message names the route, the status and the server's
error code. The key goes only to the base URL's origin. A redirect is followed only for a GET within that origin. A secret
body (a tool key, an MCP server's credentials) has each of its values cut from the answer, as JSON values, and a refusal of
it keeps only its code.

A GET, or a request that carries an `Idempotency-Key`, is tried again after a 429, a 5xx or a dropped connection, with
backoff and never sooner than the server's `Retry-After`. Any other request is sent once.

The methods and types are generated from the server's OpenAPI document by `node scripts/generate-clients.mjs`, from the
same projection and resource map as the CLI's commands.
