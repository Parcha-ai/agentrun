# @parcha/agentrun-client

A typed TypeScript client for an AgentRun server you host yourself, the open platform's server: one method per operation of
its API, typed from the OpenAPI document it serves, plus waiting for a run and following its timeline. The base API client has no dependencies: it
uses `fetch`, on Node.js 24.22.3 or newer. Optional workflow helpers use the peers documented below.

## Install

```sh
npm install @parcha/agentrun-client
```

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

With `{ stream: true }` a download resolves to a `Response` of the client's own: the server's status and headers on it
(its `url` is empty), its body unread. A read of that body that fails (the call's `timeoutMs` passes before the body
ends, or the body is cut before its length) rejects with `AgentRunUnreachable` and the failure's code, or with your
`signal`'s reason once you aborted, never the platform's own error. Nothing is tried again: what was read is yours.

`runs.follow` reads the route's event stream and resumes a dropped connection with `Last-Event-ID`, so no page comes twice.
Only the server's silence counts as a dropped connection (`idleMs`, default 45000), never the time your loop spends on a
page.

## Learning for existing backend SDK agents

The development build includes `withClaudeAgentLearning` from `@parcha/agentrun-client/claude` and
`withCodexAgentLearning` from `@parcha/agentrun-client/codex`. Use the client and server from the same reviewed
checkout; these new exports are not a guarantee about the current npm release.

| Existing backend | Cookbook |
| --- | --- |
| Claude Agent SDK `query` and custom tools | [Preserve the native query, add checked learning](../../docs/tutorials/claude-sdk-learning.md) |
| Codex SDK client, project and tools | [Preserve native threads, add checked learning](../../docs/tutorials/codex-sdk-learning.md) |

Your backend still starts and cancels tasks. The wrapper records original source policy/input, assistant text,
tool names/status and usage. With an explicit workflow bridge, bounded arguments/results for its registered tools also supply compilation evidence; other raw tool payloads and SDK credentials are not sent. AgentRun supplies the
owner's corrections (`corrections.md`, whole) to the next fresh task, and compiles a workflow once the agent has
enough completed runs. A compiled draft is checked on a separate native task before the server promotes it: the client checks it against that task's recorded tool evidence (missing reads are refused unless the host enables `shadowReadFallback` for explicitly read-only callbacks), and the server compares its result with the native answer. Drafts are not offered as executable workflows to the native model.
`learning: true` opts in on first registration only; existing agents keep their console setting.

Both wrappers expose `flushLearning()`. Await it before shutdown or before testing a fresh run's use of newly
accepted learning. Errors in persistence or learning surface there without replacing the original SDK result/error.
The first integration supports fresh, single-task sessions/threads only. See the cookbooks for cancellation,
policy snapshots and multimodal limits, or run the [opt-in live examples](../../examples/sdk-learning/README.md).

For executable workflow learning, explicitly configure `createWorkflowMcpBridge` from
`@parcha/agentrun-client/workflows` with your existing backend tool callbacks, live permission policy and an explicit `engine` object containing
`inspectWorkflow`, `runWorkflow` and `resolveSchemaForWorkflow`. Your backend imports and supplies its interpreter
(for example, `import * as engine from "@parcha/agentrun-dsl"`); the client imports no workflow engine.
The workflow entry point requires `ajv` and `ajv-formats`; the MCP bridge additionally requires `@modelcontextprotocol/sdk`. Install these optional peers explicitly when using the bridge:

```sh
npm install @modelcontextprotocol/sdk@1.32.2 ajv@8.18.0 ajv-formats@3.0.1
```

The in-process executor uses the same validators without loading the MCP SDK.
Set the bridge's optional `nativeMcpServerName` to the exact name you configure for its endpoint in the native SDK.
Only a native envelope matching one actual bridge completion's capability, arguments, status and result is correlated;
without that binding, native tool evidence is retained and the cost path can read `handed_back`.
The [workflow cookbook](../../docs/tutorials/sdk-workflow-learning.md) covers native MCP setup, checked promotion,
run-scoped access, cancellation, and tests proving the next task reuses a workflow with fresh inputs.

## Durable host integrations

The `BackendLearningClient` export from `@parcha/agentrun-client/learning` is the shared lifecycle beneath the wrappers and Eve extension. A durable host can admit a turn with `client.begin(source, signal, { idempotencyKey })`, keep `session.checkpoint()`, then restore it with `client.resume(checkpoint)` after a restart. Resume validates the server, agent and runtime and reuses the original admission. The checkpoint includes a scoped credential: persist it as private host state, never in a model prompt, tool result or log.

For a finite recorded turn, call:

```ts
await session.submit(events, outcome, {
  evidenceComplete: true,
  nativeEvents, // Original tool arguments/results, retained locally for the shadow check.
  waitForLearning: false,
  onCheckpoint: async checkpoint => {
    await savePrivateCheckpoint(checkpoint);
  },
});
```

`events` is the bounded transcript sent to the server; `nativeEvents` is separate local evidence and is not uploaded by this argument. `onCheckpoint` must durably save each shadow `started` or `complete` marker before returning. A restored completed check reuses its result without calling tools again. A restored started check with no result records an unknown failure rather than repeat uncertain host work. Retry delivery with the same events and outcome through a restored session; this does not open another native task. `waitForLearning: false` waits for evidence submission only, while the server finishes learning independently.

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
backoff and never sooner than the server's `Retry-After`. Any other request is sent once. A server no connection reaches
(refused, unknown name, unreachable host) and a certificate the client refuses are unreachable at once.

The methods and types are generated from the server's OpenAPI document by `node scripts/generate-clients.mjs`, from the
same projection and resource map as the CLI's commands.
