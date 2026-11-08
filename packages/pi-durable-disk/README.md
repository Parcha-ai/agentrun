# @parcha/pi-durable-disk

A durable run journal and CLI for one host, with places served by agentrun-serve. A run is one directory of this machine:
its conversation, its tasks and its files live together there, and whatever process opens the directory next carries on
where the last one released it. It runs [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) agents, on
Linux (macOS is for development; Windows is not supported). This is a beta (`0.1.0-beta.N`): a change that breaks a caller
is listed in [CHANGELOG.md](CHANGELOG.md) when it ships.

## What it is

- **A run is one directory.** It holds pi's SQLite store (`store/run.sqlite`: the conversation and every task), the agent's
  workspace (`work/`); the store also keeps the run's record (its status, generation and holder). [Layout of a
  run](docs/reference.md#layout-of-a-run).
- **One process at a time holds it.** The store's own lock refuses a second open on this machine, and a process whose
  store or claim fails is fenced and cannot write any more.
- **Release and open.** `release()` records where the run stands, and the instance ends: returning from `onOpen` after `await run.release()` is
  enough (the examples call `process.exit(0)`, which is fine too). The next process to open the directory is the next generation: it reopens
  the store, and pi-durable resumes the conversation and its tasks from the last commit.
- **One machine.** The directory is the claim, so it keeps a second process on this machine off the run and nothing else.
  Placing a run on an Archil disk, or in a remote box, is the job of agentrun-serve (`@parcha/agentrun-serve`).

## When to use it

- **Your process dies or is replaced.** A crash, a `kill -9` or a deploy: the next process to open the directory carries on
  from the last commit, and an effect whose intent was committed is never started twice.
- **The agent waits.** A run whose work only sleeps in a retry or a long poll (longer than the park threshold) is released,
  holds no process, and its host starts it again at its deadline. With `--serve`, a run with no work at all is released too
  ([serve and parking](docs/reference.md#serve-and-parking)).
- **You want to look at a run from outside.** Its record is a file: `readLocalRunStatus(dir)`.

It is not for a one-shot script with no state to keep (pi-durable's in-memory storage does that).

## Try it: no disk, no key

On Linux with Node 22.19 or later (or on macOS [for development](docs/reference.md#on-macos)). In an empty directory:

```sh
npm install @parcha/pi-durable-disk@latest @earendil-works/pi-durable@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/chord@1.3.0
```

pi 1.4 is not supported yet; a later release widens the range.

Save this as `pick-up.mts` (Node 22.19 or later runs the types away; `.mts` makes it an ES module whatever your
`package.json` says). It is [examples/pick-up-a-run/main.ts](examples/pick-up-a-run/main.ts). It starts three processes, one after another, on
one directory. Each opens the run, answers one question of the same chat, and releases it. pi-ai's faux model answers, so it
needs no key:

```ts
// Pick up a run: a run is a directory, and whatever process opens it carries on where the last one released it. No disk, no
// key (pi-ai's faux model answers). Three processes, one after another, each open the same run, answer one question of the
// same chat and release it; the last still knows the first question, because the chat is in the directory, not in a process.
// One machine: the directory is the claim.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { localRun, openDurableRun, readLocalRunStatus } from "@parcha/pi-durable-disk";

const QUESTIONS = ["Where does your transcript live?", "Who had this run before you?", "Do you remember my first question?"];
const root = join(process.cwd(), "pick-up-a-run-run");
const text = (message: { content: unknown }): string =>
  typeof message.content === "string" ? message.content : (message.content as { text?: string }[]).map((part) => part.text ?? "").join("");

if (process.argv[2] === "instance") {
  let generation = 0;
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => (context) => {
    const asked = context.messages.filter((message) => message.role === "user");
    return fauxAssistantMessage(`Answer ${asked.length}, by generation ${generation}. You first asked: "${text(asked[0]!)}"`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const run = await openDurableRun({ disk: "local", region: "local", id: "chat" }, { ...localRun(root), harness: { models, registry: createRegistry() } });
  generation = run.generation;
  const model = faux.getModel();
  const chat = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const answers = async (): Promise<EntryRecord[]> => [...(await chat.entries({}, 100, undefined, ctx)).items].reverse().filter((entry) => entry.kind === "pi.assistant");
  const n = (await answers()).length + 1; // the next question: this process answers one and lets go
  console.log(`generation ${generation} opened the run (${n - 1} answered before)`);
  await (await chat.submit({ type: "input", content: QUESTIONS[n - 1], requestId: `question-${n}` }, ctx)).wait(ctx);
  console.log(`  ${QUESTIONS[n - 1]}\n  ${text((await answers()).at(-1)!.model![0]!)}`);
  await run.setStatus(n === QUESTIONS.length ? "done" : "paused");
  await run.release();
  process.exit(0);
}

// The supervisor: one process per question, one after another, on the same directory. It reads whole lines, and waits for
// `close` (the process gone and all its output read), not `exit`.
rmSync(root, { recursive: true, force: true });
console.log(`the run is ${root}`);
const output: string[] = [];
for (const [i] of QUESTIONS.entries()) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "instance"], { stdio: ["ignore", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).on("line", (line) => {
    console.log(line);
    output.push(line);
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (code !== 0) {
    console.error(`not ok: the process for question ${i + 1} exited ${code}`);
    process.exit(1);
  }
}
const opened = output.flatMap((line) => /^generation (\d+) opened the run \((\d+) answered before\)$/.exec(line)?.slice(1).map(Number) ?? []);
const status = await readLocalRunStatus(root); // the run's record, read from outside, with no process running
const remembered = output.at(-1)?.includes(`You first asked: "${QUESTIONS[0]}"`);
if (opened.join() !== "1,0,2,1,3,2" || !remembered || status?.status !== "done" || status.generation !== 3) {
  console.error(`not ok: opened ${JSON.stringify(opened)}, remembered ${remembered}, status ${JSON.stringify(status && [status.status, status.generation])}`);
  process.exit(1);
}
console.log(`ok: three processes, one run: each picked up where the last released it, the last still knew the first question, and the run reads done at generation 3 (${root})`);
```

Run it (about two seconds; it writes the run under `./pick-up-a-run-run/`):

```sh
node pick-up.mts
```

It ends with:

```
generation 3 opened the run (2 answered before)
  Do you remember my first question?
  Answer 3, by generation 3. You first asked: "Where does your transcript live?"
ok: three processes, one run: each picked up where the last released it, the last still knew the first question, and the run reads done at generation 3 (<this directory>/pick-up-a-run-run)
```

Nothing but the directory carried the conversation from one process to the next, so the third process knew the first
question. The directory is the claim here, which guards one machine only.

## What you can do with it

- **Park a run while it waits**, and start it again at its deadline ([serve-and-park](examples/serve-and-park/)).
- **Serve a run over HTTP**: `POST /submit` with a `requestId` that is deduplicated in the run's store, so a retry that reaches
  the next incarnation gets the same submission ([Serve and parking](docs/reference.md#serve-and-parking)).
- **Seed a new run** with a store and files before anything sees it ([Seeding a new run](docs/reference.md#seeding-a-new-run)).
- **Keep what was committed.** Every commit is on the disk before anything is shown, and an effect whose intent was committed is never started twice.

[examples/](examples/README.md) lists every example, one property each, with what each needs and the first version that has
what it imports.

## What it costs

A run costs nothing but its directory: no account and no key. The model is yours: the examples use a scripted one, so the
first run spends nothing; the package adds no model calls of its own. A run whose work only waits longer than the park
threshold is released and holds no process; an instance with no work at all parks only with `--serve` or `--park-idle`
([parking](docs/reference.md#serve-and-parking)). Otherwise it stays up.

## What it does not do

- **Guard a run against another machine.** The directory is the claim, so it keeps a second process on this machine off the
  run and nothing else.
- **Sandbox an agent.** Commands run as the run user, with `no_new_privs` and the file tools confined to `work/`, and a command
  can reach anything that user can. Run an agent you do not trust in your own sandbox ([Security](docs/reference.md#security)).
- **Make a third party idempotent.** The package never starts the same effect twice, but a call your model decides to retry is
  a new call: give a paid API an idempotency key from your own business key.
- **Choose your model or hold its keys.** You bring the provider and the key; they stay in your app.
- **Run on every platform.** Linux is supported. macOS is for development ([On macOS](docs/reference.md#on-macos)) and Windows is
  not supported.

## Install

```sh
npm install @parcha/pi-durable-disk@latest @earendil-works/pi-durable@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/chord@1.3.0
```

`@earendil-works/pi-durable` and `@earendil-works/chord` are peer dependencies, `>=1.0.4 <1.4.0`: pi 1.4 is not supported yet; a
later release widens the range. Node 22.19 or later; Linux, or macOS for development.

`@earendil-works/pi-coding-agent` pins undici 8.10.2 exactly. To install undici 8.12.2 under them, add this
override to your own `package.json` (npm applies overrides only in the project that runs the install):

```json
"overrides": { "undici@8.10.2": "8.12.2" }
```

From a checkout (this package is `packages/pi-durable-disk` of the repository; the root build compiles `dist/`):

```sh
git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun && npm ci --ignore-scripts && npm run build
cd packages/pi-durable-disk
```

## The door hook (`AppOptions.door`)

By default `serve`'s door (`POST /submit`, `POST /abort`, `GET /status`, `GET /events`) is pi's root conversation. An
app with a harness of its own (a child process, another agent loop) hands the door to it with `door`, an `AppOptions`
field. Without `door`, the door answers byte for byte as it did before the field existed
([`test/door-exchange.test.ts`](test/door-exchange.test.ts) holds the recorded exchange).

```ts
interface DoorHook {
  /** Resolves when the input is TAKEN, not when the turn ends; the turn runs after, reported through ctx.emit and the conversation's entries. */
  submit(input: { requestId: string; content: UserInput; whenBusy: "steer" | "followUp" | "reject" }, ctx: DoorContext): Promise<{ accepted: true } | { accepted: false; reason: "busy" }>;
  abort(ctx: DoorContext): Promise<"aborted" | "idle">;
  busy(): boolean;
}
type DoorContext = { run: DurableRun; signal: AbortSignal; emit(event: { type: "run_start" } | { type: "run_end" }): void; adopt(pid: number): void };
```

A submit with `answers: false` and `asks` (tool names) may not answer a question the conversation waits on: pi's root
refuses it with 409 `WAITING` when its last model message is the result of a tool in `asks`, and both pi and a hook admit
it only as `whenBusy: "reject"`, so a busy run refuses it (409 `BUSY`) and it is never queued behind a turn that may end on
such a tool.
With `parks` (entry kinds), it is refused with 409 `WAITING` too, by pi and a hook alike, while a call waits in a park
of one of those kinds: an entry saying `{phase: "requested", id}` with no `{phase: "resolved", id}` after it, read back
to the turn's last user message (a hook's conversation has none: back to its start). A tool call waiting on its owner's
approval parks so on every harness. The park is read in one transaction: for a hook, the commit that admits the input;
for pi, the one just before pi's own admission. Only a new admission is read for: a requestId the door or pi took already
answers its record, whatever has parked since.

With a hook, `POST /submit` (whose `whenBusy` defaults to `followUp`, as pi's) goes through, in this order: the bearer
token (401); the run's state (503 `OPENING`, `PARKING`, `RELEASED`), so nothing reaches the hook once the run is fenced; the
admission, one `door.input` entry in the root conversation holding the requestId, the content and its status, written
through the run's fenced commit (a fence before it lands fails it, and the hook is not called); then `hook.submit`,
once per requestId, bounded at `doorTimeouts.submitMs` (30 s). Each status change is a `door.status` entry on the same
requestId, and the last one is the record's status. A requestId already admitted answers its status and never calls the
hook again, in this process or the next: the record is in the store, and a lookup is one indexed read per entry.

A busy refusal is not an outcome. A `whenBusy: "reject"` input is refused (409 `BUSY`) with nothing written while the
hook is busy, or a call in this instance is about to make it so. One the hook refuses as busy after its admission is
written `REJECTED_BUSY`, and the same requestId, sent again, is admitted again (a new `door.input` on its record) and
reaches the hook. `doorKey(requestId, n)` names the record's entries in turn, and `doorTook(requestId, statusAt)` reads
whether the door took a request, or may have: its last status, unless that is `REJECTED_BUSY`. A host reads it in the
store when the run has no live door.

| Status | Means | A submit of that requestId answers |
|---|---|---|
| `ADMITTED` | only: the hook is running in this instance, on a record this instance admitted | 202 `{ status: "ADMITTED" }` |
| `ACCEPTED` | the hook took the input | 200 `{ status: "ACCEPTED" }`; never submitted again |
| `REJECTED_BUSY` | the hook refused it as busy | 409 `BUSY`, `status: "REJECTED_BUSY"`; sent again, it is admitted again |
| `REJECTED_WAITING` | an input with `answers: false` came while a call waits in a park it names; never written | 409 `WAITING`; sent again, it is read again |
| `FAILED` | `hook.submit` threw, before taking the input | 500 `FAILED`, `status: "FAILED"` |
| `UNKNOWN` | the bound passed: the door aborted `ctx.signal`, called `hook.abort` (bounded at `doorTimeouts.abortMs`, 5 s) and stopped waiting; or the record was admitted by an earlier instance, or before the run was fenced, and no call here carries it | 504 `UNKNOWN`, `status: "UNKNOWN"`; never submitted again |

A late answer to an `UNKNOWN` submit is never dropped: the door writes the real outcome (`ACCEPTED`, `REJECTED_BUSY`, or
`FAILED` if it threw) on the same requestId, unless the run is fenced by then (the fenced commit fails, and the record
stays `UNKNOWN`). An abort that loses the race to delivery so ends `ACCEPTED`.

A record whose instance died, or was fenced, between the admission and the hook's outcome was dispatched or not,
nobody knows: it is `UNKNOWN`, and final, since no later outcome can come from a dead or fenced instance. A retry
answers it `UNKNOWN` ("admitted by an earlier instance, or before the run was fenced: whether the hook took it is
unknown") as soon as no call in this instance carries it, and each open writes a `door.status` `UNKNOWN` for every such
record through the fenced commit, so the store and the events say it too. A fence between the admission and the
call writes it at once when the commit can still land. No incarnation submits an `ADMITTED` or `UNKNOWN` record again.

`POST /abort` calls `hook.abort` (bounded) and answers `{ result: "aborted" | "idle" }`. `GET /status`'s `busy` is
`hook.busy()`. `GET /events` keeps its contract (a snapshot, then batches of events, then `end`) on the root
conversation: entries come from pi's `watchEvents`, the hook's `ctx.emit` run events (`{ type: "run_start" | "run_end",
inputs: [] }`) are merged in order, and `snapshot.run` is present while `hook.busy()`. There is no `Last-Event-ID`:
resume = a fresh snapshot, as today.

A `run_end` pairs every `run_start`, and that is the hook's duty first: it emits `run_end` when its turn ends in any
way, above all the ways the door cannot see (its harness child dies, its turn errors inside the harness). The door
pairs a `run_start` itself only at the points it controls: when `hook.submit` throws after it, when a second
`run_start` comes first, when an abort leaves the hook idle, when the door stops, and before a stream's `end`.

The door stops when the instance ends: a drain on SIGTERM, a fence (another instance may take
the run) and a park. It aborts the hook, bounded, kills the process group of every harness child the hook registered
with `ctx.adopt(pid)` (start the child `detached`) and still alive, and pairs an open `run_start`, so the instance
never exits with one of those children alive, and a fenced run's child never acts on after the fence.

The admission is the journal of [`spec/receipts/Receipts.tla`](../../spec/receipts/Receipts.tla) for one effect per
requestId, with the same invariants: Admit is the `door.input` commit (`I1_AdmitBeforeDispatch`), Dispatch is the one
`hook.submit` per requestId (`I3_OneDispatchPerKey`), Settle is the outcome on the same record
(`I7_ReceiptsNeverErased`), and `UNKNOWN` is an outcome nobody knows, never dispatched again.
[`spec/receipts/Door.tla`](../../spec/receipts/Door.tla) checks the door's journal itself, across restarts, a fence
and a late resolve.

## The low-level API

What the package exports for a host of your own. `src/index.ts` lists every export, and the `.d.ts` files in `dist/` are the
reference. [Library](docs/reference.md#library) describes each in full.

| Name | What it is | Example |
|---|---|---|
| `openDurableRun(ref, options)` | Open a run: take the claim, probe the store's lock, open the store and the Harness, write the run's record in the store, resume. `run.release()` records where it stands and lets the claim go | [pick-up-a-run](examples/pick-up-a-run/main.ts) |
| `localRun(root)` | The `acquire` and `claimDir` that put a run on a plain directory of this machine | [pick-up-a-run](examples/pick-up-a-run/main.ts) |
| `seed` (an option of `openDurableRun`) | Write what a new run starts with, its store file and workspace files, once, before anything sees the run ([Seeding a new run](docs/reference.md#seeding-a-new-run)) | [seed-a-run](examples/seed-a-run/) |
| `localPlace({ app })` | Where one run lives and how its instance starts and ends, for a supervisor of your own ([Places](docs/reference.md#places-where-a-runs-instance-starts-and-ends)) | [place-outcome](examples/place-outcome/) |
| `PlaceOutcome` | How a runner ended: the run's `status` (`complete` or `failed`), its `generation`, and the app's `record` or `code` and `message`, and the `models` it used | [place-outcome](examples/place-outcome/) |

Also exported: `serveRun`, parking, `readLocalRunStatus` (a run's record, once no process holds it), and the typed
errors. `@parcha/pi-durable-disk/internals` has no compatibility promise.

## Reference

[docs/reference.md](docs/reference.md) has the rest: [requirements](docs/reference.md#requirements), [the app](docs/reference.md#the-app), [the CLI](docs/reference.md#the-cli), [serve and parking](docs/reference.md#serve-and-parking), [the failure table](docs/reference.md#the-failure-table), [security](docs/reference.md#security), [the layout of a run](docs/reference.md#layout-of-a-run) and [the library](docs/reference.md#library).

## License

Apache-2.0, Parcha Labs, Inc. See `LICENSE` and `NOTICE`.
