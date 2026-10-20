# @parcha/pi-durable-disk

Run a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) agent from a directory or a network disk, so any process or host can open the run and carry on where the last one released it.

An agent's home and its runs live on the disk, not on a machine: the conversation, the agent's files and what it was waiting
for are all in the run's directory, so a process is somewhere a run visits, not where it lives. This is a beta
(`0.1.0-beta.N`): a change that breaks a caller is listed in [CHANGELOG.md](CHANGELOG.md) when it ships.

## What it is

- **A run is one directory.** It holds pi's SQLite store (`store/run.sqlite`: the conversation and every task), the agent's
  workspace (`work/`) and `run.json` (its status, generation and holder). [Layout on the disk](docs/reference.md#layout-on-the-disk).
- **One process at a time holds it.** A second claim is refused. The process that opens a run keeps a lease on it, and a
  holder that lost the claim cannot write any more.
- **Release and open.** `release()` seals the run, and the instance ends: returning from `onOpen` after `await run.release()` is
  enough (the examples call `process.exit(0)`, which is fine too). The next process to open the directory is the next generation: it reopens
  the store, and pi-durable resumes the conversation and its tasks from the last commit.
- **Two places a run can live.** On a plain directory of this machine (`localRun`: no disk, no key, one machine), or on an
  [Archil](https://archil.com) disk that a Linux host or a container can mount (your own disk: [below](#bring-your-own-disk)).
  The app code is the same.

## When to use it

Use it when a run should not be tied to the machine it started on:

- **Your compute is disposable or changes.** Containers, sandboxes, VMs, deploys: whichever host opens the run next carries
  on, with no state to copy first. Hosts: systemd units on this machine, Docker containers, Daytona sandboxes (a driver for
  another compute is [three calls](docs/reference.md#host-drivers-and-the-supervisor)).
- **The agent waits.** A run whose work only sleeps in a retry or a long poll (longer than the park threshold, 60 s with the local
  and Docker drivers) is released, holds no process, and is started again at its deadline. With `--serve`, a run with no work at
  all is released too and a request starts it ([serve and parking](docs/reference.md#serve-parking-and-fork)).
- **You move or branch a run.** Hand it to another host at a step boundary, or fork a sealed run into many, each continuing
  on its own.
- **You want to look at a run from outside.** Its record is a file: `readLocalRunStatus(dir)` on a directory,
  `readRunStatus(control, id)` on a disk.

It is not for a one-shot script with no state to keep (pi-durable's in-memory storage does that), and a disk other than
Archil is not supported: the package needs the disk to give an exclusive claim and a fence, and Archil is the one that does.

## Try it: no disk, no key

On Linux with Node 22.19 or later (or on macOS [for development](docs/reference.md#on-macos)). In an empty directory:

```sh
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

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
question. The directory is the claim here, which guards one machine only; the next section puts the run on a disk that hosts
can mount.

## Bring your own disk

The run's directory moves to an Archil disk, and the same app module runs on it (`run --disk` where `run --dir` was). You need an Archil account, a disk in the region nearest your hosts, and an API key from the Archil console. The key stays with the supervisor:
hosts and instances never hold it. The supervisor is a function you call (`ensureRunning`) or `pi-durable-disk supervise`, which starts an
instance where a run has none and hands each instance a mount token for its own start. On a Linux host set up as in
[Requirements](docs/reference.md#requirements) (add `--host docker --image IMAGE` to start each instance in a container instead):

```sh
export ARCHIL_API_KEY=...            # Archil console, API keys; only the supervisor reads it
npx pi-durable-disk supervise --disk dsk-0123456789abcdef --region aws-us-east-1 --id my-run --create --app ./my-app.ts --every 30s
```

`./my-app.ts` is [an app module](docs/reference.md#the-app): a function that returns pi's Harness options. Start from one of these, by what
you have:

- **Docker, any operating system, and an Archil account:** [Quickstart with Docker](docs/reference.md#quickstart-with-docker). No root, no
  FUSE, no archil client on your machine: each instance is a container.
- **A Linux host with FUSE and the archil client:** [Quickstart on a Linux host](docs/reference.md#quickstart-on-a-linux-host-two-hosts-one-run),
  then [Setting up a host for production](docs/reference.md#setting-up-a-host-for-production).
- **Requirements, in full:** [Requirements](docs/reference.md#requirements).

**The disk.** The package needs two things from the disk: an exclusive claim on a run's directory, so that a second mount is
refused, and a fence, so that revoking the claim makes the old holder's writes fail. [Archil](https://archil.com) gives both,
which makes it the supported disk and the only one in this release. A disk without both cannot carry the package's
guarantees. This release names no other backend and promises none.

## What you can do with it

- **Hand a run to another host** at a step boundary: the old host records where the run is going and releases it, the new
  one opens the next generation and tells the agent ([planned-move](examples/planned-move/)).
- **Park a run while it waits**, and wake it at its deadline or on a request ([serve-and-park](examples/serve-and-park/)).
- **Serve a run over HTTP**: `POST /submit` with a `requestId` that is deduplicated in the run's store, so a retry that reaches
  another host gets the same submission ([Serve, parking and fork](docs/reference.md#serve-parking-and-fork)).
- **Fork a sealed run into many**, each fork a run of its own ([fork-into-many](examples/fork-into-many/)).
- **Seed a new run** with a store and files before anything sees it ([Seeding a new run](docs/reference.md#seeding-a-new-run)).
- **Run it supervised** on systemd units, Docker containers or Daytona sandboxes ([Host drivers and the
  supervisor](docs/reference.md#host-drivers-and-the-supervisor)).
- **Keep what was committed.** Every commit is on the disk before anything is shown, and an effect whose intent was committed is never started twice.

[examples/](examples/README.md) lists every example, one property each, with what each needs and the first version that has
what it imports.

## What it costs

- **A local run costs nothing:** a directory of this machine, no account and no key. The model is yours: the examples use a
  scripted one, so the first run spends nothing; the package adds no model calls of its own.
- **On a disk:** an [Archil](https://archil.com) account and the disk's storage. A
  run is one directory (a SQLite store, a workspace and `run.json`), removed with `deleteRunTree`. Every commit is one round
  trip to the disk's region, 3 to 6 ms p50 from a host next to it (measured), so run hosts near the disk. Claiming a run
  takes about 0.2 s and releasing one about 0.15 s, from the live suites on a VM next to the disk's region ([where the figures
  come from](docs/reference.md#the-failure-table)).
- **Hosts:** whatever you run them on, a machine you own, Docker, or a [Daytona](https://www.daytona.io) sandbox, which Daytona
  bills; a sandbox's list price per second is in its receipt (`daytonaUsdPerSecond`). A run whose work only waits longer
  than the park threshold (60 s by default with the local and Docker drivers) is released and holds no process; an instance with
  no work at all parks only with `--serve` or `--park-idle` ([parking](docs/reference.md#serve-parking-and-fork)). Otherwise it
  stays up, and so does its host.
- **A supervisor** is a function you call or `pi-durable-disk supervise`; it needs the Archil API key, and no instance ever
  holds it.

## What it does not do

- **Other disks.** Archil is the only disk in this release: the package needs an exclusive claim and a fence from it. No other
  backend is named or promised.
- **Guard a run on a plain directory against another machine.** `localRun` has no fence: the directory is the claim, so it
  keeps a second process on this machine off the run and nothing else. Use it for one machine; use a disk to share a run.
- **Sandbox an agent.** Commands run as the run user, with `no_new_privs` and the file tools confined to `work/`, and a command
  can reach anything that user can. Run an agent you do not trust in your own sandbox ([Security](docs/reference.md#security)).
- **Make a third party idempotent.** The package never starts the same effect twice, but a call your model decides to retry is
  a new call: give a paid API an idempotency key from your own business key.
- **Choose your model or hold its keys.** You bring the provider and the key; they stay in your app.
- **Run on every platform.** Linux is supported. macOS is for development ([On macOS](docs/reference.md#on-macos)) and Windows is
  not supported. A Kubernetes host driver is not written (a driver is [three calls](docs/reference.md#host-drivers-and-the-supervisor)).

## Install

```sh
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

`@earendil-works/pi-durable` and `@earendil-works/chord` are peer dependencies, `>=1.0.4 <1.4.0`. Node 22.19 or later;
Linux, or macOS for development.

From a checkout (this package is `packages/pi-durable-disk` of the repository; the root build compiles `dist/`):

```sh
git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun && npm ci --ignore-scripts && npm run build
cd packages/pi-durable-disk
```

## The low-level API

What the package exports for a host of your own. `src/index.ts` lists every export, and the `.d.ts` files in `dist/` are the
reference. [Library](docs/reference.md#library) describes each in full.

| Name | What it is | Example |
|---|---|---|
| `openDurableRun(ref, options)` | Open a run: take the claim and the owner lock, open the store and the Harness, resume, keep the lease. `run.release()` seals it | [pick-up-a-run](examples/pick-up-a-run/main.ts) |
| `localRun(root)` | The `acquire` and `claimDir` that put a run on a plain directory of this machine, with no disk and no key | [pick-up-a-run](examples/pick-up-a-run/main.ts) |
| `seed` (an option of `openDurableRun`) | Write what a new run starts with, its store file and workspace files, once, before anything sees the run ([Seeding a new run](docs/reference.md#seeding-a-new-run)) | [seed-a-run](examples/seed-a-run/) |
| `localPlace({ app })` and `archilPlace({ disk, region, control, host })` | Where one run lives and how its instance starts and ends, for a supervisor of your own ([Places](docs/reference.md#places-where-a-runs-instance-starts-and-ends)) | [place-outcome](examples/place-outcome/) (`localPlace`, no key); `archilPlace` needs Archil: [`test/place.test.ts`](test/place.test.ts) |
| `PlaceOutcome` | How a runner ended: the run's `status` (`complete` or `failed`), its `generation`, and the app's `record` or `code` and `message`, and the `models` it used | [place-outcome](examples/place-outcome/) |
| `withClaim(where, fn)` and `readReleased(where, file)` | Hold one path of a disk exclusively for a moment, outside any run; read what it released over S3, with no mount ([A short claim](docs/reference.md#a-short-claim-on-any-path-and-a-read-of-what-it-released)) | Archil only: [`test/with-claim.test.ts`](test/with-claim.test.ts) (fakes) and [`test/live/with-claim.live.test.ts`](test/live/with-claim.live.test.ts) |
| `recordHome` (a field of a `Place`) | The directory an attempt's runner records into, and `bringHome(into, { final })`, which reads it back over the control with no claim ([Places](docs/reference.md#places-where-a-runs-instance-starts-and-ends)) | Archil only: [`test/place.test.ts`](test/place.test.ts), [`test/live/record-home.live.test.ts`](test/live/record-home.live.test.ts) |

Also exported: `ensureRunning` and the host drivers (`localHost`, `dockerHost`, `daytonaHost`), `serveRun` and `requestRun`,
parking, `fork` and `forkLocal`, `readLocalRunStatus` and `readRunStatus`, `archilControl`, and the typed errors.
`@parcha/pi-durable-disk/lease` is the narrow entry for a host that owns its Harness; `@parcha/pi-durable-disk/internals` has
no compatibility promise.

## Reference

[docs/reference.md](docs/reference.md) has the rest: [requirements](docs/reference.md#requirements), the quickstarts on a disk ([Docker](docs/reference.md#quickstart-with-docker), [a Linux host](docs/reference.md#quickstart-on-a-linux-host-two-hosts-one-run)), [the app](docs/reference.md#the-app), [the CLI](docs/reference.md#the-cli), [host drivers and the supervisor](docs/reference.md#host-drivers-and-the-supervisor), [the failure table](docs/reference.md#the-failure-table), [security](docs/reference.md#security), [the layout on the disk](docs/reference.md#layout-on-the-disk) and [the library](docs/reference.md#library).

## License

Apache-2.0, Parcha Labs, Inc. See `LICENSE` and `NOTICE`.
