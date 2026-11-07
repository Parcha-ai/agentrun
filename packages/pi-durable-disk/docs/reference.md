# @parcha/pi-durable-disk: reference

The reference for [`@parcha/pi-durable-disk`](../README.md): requirements, the app, the CLI, serve and parking, the
failure table, security, the layout of a run, and the library. The [README](../README.md) is the overview: what it is, a
keyless example, and the install lines.

- [Requirements](#requirements)
- [The app](#the-app)
- [The CLI](#the-cli)
- [Serve and parking](#serve-and-parking)
- [The failure table](#the-failure-table)
- [Security](#security)
- [Layout of a run](#layout-of-a-run)
- [Library](#library)
- [Tests](#tests)

## Requirements

- Linux with `setpriv` (util-linux), or macOS for development ([On macOS](#on-macos)). Windows is not supported.
- Node 22.19 or later, to run the package and its unit tests.
- `@earendil-works/pi-durable` and `@earendil-works/chord`, `>=1.0.4 <1.4.0`, as peer dependencies. The package is developed against 1.1.0, and CI runs its whole suite on 1.0.4 too, the lowest version the range accepts, and on 1.2 and 1.3.

A run lives on a directory of one machine ([A run on a local directory](#a-run-on-a-local-directory)). Placing a run on
an Archil disk, or in a remote box, is agentrun-serve's job, not this package's.

## The app

An instance is `pi-durable-disk run --app <module> ...`: `openDurableRun` with the app's options. The module is an ES
module whose default export is a function of where the run lives and returns pi's Harness options without `env` (the run
builds `env` on its claim: the workspace is `<root>/work`), plus an optional `beforeResume` and an optional `onOpen`.

The factory runs once the claim is held: the run's directory is held open, its store found free, `store/`, `work/` and
`tmp/` made, and the commands a killed incarnation left running ended (`openDurableRun`'s `afterClaim`). The store opens
after it. So `where.root` is the live directory whenever app code runs, and a factory may
write under it (a recorder's spool, a `signals/` directory). The Harness opens after the factory, with what it returns. A module that does not load, or a factory that throws, fails the open with `APP_FAILED`
(exit 1), and the claim is let go. Such a start publishes nothing: a new run still has no record in its store, and a
resumed run keeps its previous one.

```ts
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry } from "@earendil-works/pi-durable";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";

export default async function app(where: AppContext): Promise<AppOptions> {
  // where = { ref: { disk, region, id }, root, work, store }: the claim is held, so root is the live run directory.
  const models = createModels();
  models.setProvider(openaiProvider());       // reads OPENAI_API_KEY from the instance's environment
  const registry = createRegistry();          // every extension the run's tasks need
  registry.install(ArchilCodingTools);        // pi's read, write, edit and bash, with `read` declared replay-safe
  return {
    models,
    registry,
    async beforeResume({ harness, context, generation, previous }) {
      // Awaited once per incarnation, after the Harness is open and before it resumes: no resumed task takes a step
      // until this settles, and what it admits commits before their steps do. Reconcile here what a resumed tool depends on.
      // previous is the record the run was left with (null on a first open): `sleeping` with its wakeAt after a park,
      // `paused` with its detail after a planned stop, `running` with the dead holder after a crash.
    },
    async onOpen(run) {
      // Called once per incarnation, after the run is open and resumed. run.generation is 1 on a first start and
      // higher on every resume. run.harness is pi-durable's Harness.
      const agent = { model: { provider: "openai", modelId: "gpt-6-sol" } };
      const root = await run.harness.root(ctx, { agent });
      await root.submit({ type: "input", content: "Summarize work/notes.md", requestId: "job-1" }, ctx); // a retry is a no-op
    },
  };
}
```

`openDurableRun` installs the registry before `Harness.open`, because a recovered task resumes only when an extension
of its name is installed. A tool that only reads can be marked `replay: "safe"` (`markReadOnlySafe`): after a crash it is
rerun. Any other tool is an effect: its intent is committed before it starts, and after a crash the model is told the call
was `interrupted`, never run again. `run.setStatus("done" | "failed" | "paused" | "sleeping", detail)` records the run's
status in its record, in the store; `done` and `failed` run the durability barrier first. `run.release()` closes the Harness, kills the
run's commands and runs the barrier; its record (a run still `running` is `paused`) is written in the store first. Closing
the Harness closes the store, so close the Harness only through `run.release()`: after an app closes the Harness itself,
`setStatus()` and `release()` refuse with `RunError` `RELEASE_ORDER` ("release() before closing the Harness: …", exit 1),
nothing is fenced, and the record stays as the open wrote it, as after a crash. The instance ends after its release: returning from `onOpen` after `await run.release()` is enough (the examples call `process.exit(0)`, which is fine too). A module that is missing
or throws, or an `onOpen` that rejects, is `AppError` (exit 1; a module that fails lets the claim go first). A `beforeResume` that rejects
fails the open (its step is `before-resume`) and releases the claim. Besides the Harness, the hook gets `storage`, the
store the Harness was opened over as four reads (`scanConversations`, `scanTasks`, `scanDocuments`, `document`) with no
way to a write, and `head`, the store's last committed sequence: a recorder snapshots every document at `head` there.
Until the hook commits, the current state is the state at `head`, which is how a document that keeps no history reads.

## The CLI

`pi-durable-disk` is on the PATH after an npm install (`node dist/cli.js` in a checkout).

| Command | What it does |
|---|---|
| `run --dir PATH --epoch N --app MODULE [--id ID]` | The instance on a local directory (`localRun`): claim the run, open it, resume it. `--epoch N` is required: the host that starts a run holds its claim and hands it its epoch, the record's generation (without it: exit 2, `--epoch is required`). Exit 76 when another process holds the run's store, or when a process its last incarnation left will not die; 75 when fenced. `--on-sigterm resume` (default) or `pause`. `--serve PORT`, `--park-threshold`, `--park-idle`, `--drain-timeout` (below). `--run-as USER` runs the agent's commands as USER when the instance runs as root (in a container). `--id` defaults to the directory's name |
| `status --dir PATH` | The run's record, read from its store once no process holds it, and whether its holder is still the process that claimed it: `running` (this boot, its pid alive with the start ticks `run` recorded), `stopped`, `gone` (another boot), or `unknown` when this machine's boot or processes cannot be read. While a process holds the store: `record` null, `holderStatus` `running` |

A duration flag takes a number and its unit: `ms`, `s`, `m` or `h`, decimals allowed (`500ms`, `30s`, `1.5m`, `1h`). A
bare number is refused with exit 2 and a hint (`not a duration: "90": give a unit, e.g. 90s or 90ms`), so `90` is never
silently 90 milliseconds. Every duration flag is checked before the command acts. One exception: a bare `0` turns
parking off (`--park-threshold 0`). Anywhere else, `0` takes a unit (`0s`).

An instance's exit code tells its host what to do:

| Exit | Meaning | Start it again? |
|---|---|---|
| 0 | Drained on SIGTERM: recorded `sleeping` (due now, the default) or `paused` | at its wake, if sleeping |
| 1 | The app module failed to load or `onOpen` rejected | yes |
| 2 | Usage error, `run` without `--epoch` among them | no |
| 65 | Data error: the run's record is unreadable | never |
| 70 | The store's head cannot be read (pi's schema moved) | never |
| 75 | Fenced: a store commit or a write of the run's own files failed, or its root is no longer the directory it opened (`CLAIM_UNMOUNTED`) | yes, once the process is gone |
| 76 | Held: another process on this machine holds the run's store, or a process a killed incarnation's commands left will not die | not while that process lives |

## Serve and parking

`pi-durable-disk run --serve PORT` (0: any free port; `--serve-host`, default 127.0.0.1; any other address needs
`--serve-token-file`, see Security, and a wildcard such as 0.0.0.0 also needs `--serve-url`, the address clients reach) puts
a small HTTP front on the open run:

| Request | What it does |
|---|---|
| `POST /submit {requestId, content, conversationId?, whenBusy?, wait?}` | pi's `submit`. pi deduplicates `requestId` per conversation in the run's store, so a retry that reaches the next incarnation, even on another host, gets the same submission, and with `wait: true` its answer. The same `requestId` on another conversation is a new submission there |
| `POST /abort {submissionId? \| conversationId?}` | pi's abort |
| `GET /events` | pi's agent events as server-sent events |
| `GET /status` | the run's status |

The instance writes its address into its record's holder (`holder.serve`), prints it to its host as the first line on
stdout, and answers 503 (`OPENING`, `PARKING`, `RELEASED`) while it
opens, parks or is gone. The app module may add `root` (the options for pi's `root()`, which the serve root conversation
gets) and `wake`. A client that meets a 503 tries again; starting a released run again is its host's job.

**Parking.** With `--park-threshold` (0 turns it off) the instance
classifies pi's tasks after every commit. When everything that could run only sleeps in a retry or a deferred-poll wait longer
than the threshold, it records `sleeping` with `wakeAt` (the deadline), releases the claim and exits 0, and its
host starts it again at `wakeAt`. With `--serve`, a run with no live work also parks after `--park-idle` (default: the
threshold) with `wakeAt` null, so only a request wakes it. Open requests and event streams keep the instance up; a blocked task
(one no definition can run) does not. An app's `wake` hook replaces how the wake is recorded: a refusal keeps the instance up
through the wait (pi's own timer ends it), while a failed write of the record is a fence (exit 75; its host starts it again). On
SIGTERM the instance stops taking submissions and drains for up to `--drain-timeout`, then writes its wake (now, the wait's deadline, or null when idle) and releases. Work cut
at the deadline resumes on the next open: safe tools rerun, unsafe ones report the interruption. The parking follows the
lifecycle of Rivet's pi-durable host (rivet-dev/agents, Apache-2.0); no code was copied.

## The failure table

A run on a local directory has nothing mounted and nothing delegated; its host starts it again when it should run.

| Failure | What happens | Effects |
|---|---|---|
| The instance crashes or is SIGKILLed | Its hold on the store goes with the process. The next open of the directory (by the app, or whatever restarts it) takes the run, ends the commands the killed incarnation left running (its `commands` step, before any code of the new incarnation runs), and `resume()`s from the last commit | running tasks go back to pending; effects in flight are `interrupted`, never rerun; no command of the killed incarnation still runs once the run resumes. pi makes each command the leader of its own process group, so the SIGKILL does not reach them and a local run has no unit cgroup: the instance records each command's group under `commands/` (by pid, start ticks and boot) and the next open kills what still matches. A command started within about 0.1 s before the kill can be missed |
| A process the killed incarnation's commands started does not die at the next open (an uninterruptible wait, or one the run's user may not signal) | The open is refused: `HeldError` `COMMANDS_ALIVE`, exit 76, with the message below; the records stay | none: the run does not resume beside it. End those processes and open the run again |
| Power loss or an OS crash | The store's commits are durable (SQLite at `synchronous = FULL`); `work/` is the operating system's to flush, since the claim's barrier syncs nothing | the store resumes from its last commit; files the agent wrote in `work/` can be older than what the store recorded |
| A second process opens the run on this machine | The open probes the store's lock before it reaps anything and is refused while another process holds the store (`HeldError` `store`, exit 76). The lock is probed, not held: from the probe to the store's own open (the layout, the commands reap, `afterClaim` and a new run's seed) nothing holds it, so two openers with no host (two library callers at once) can both pass the probe, and the store's own open then refuses one of them. `localPlace`'s release probes the lock and then reaps in the same way | none while the other process holds the store. Two host-less openers at once: the one refused at the store's open may already have killed commands the other started, or run the seed over its files. agentrun-serve starts one run process per run, so it never opens a run twice |
| A process on another machine reaches the directory (a network share) | Nothing stops it: a local directory has no fence | unsupported, since two writers can corrupt the store |

The refusal names each process, as the open writes it (here one, in a run at `<root>`):

```
1 process(es) a killed incarnation's commands started are still alive after SIGKILL: pid 4242 (tar -xf /mnt/slow/archive.tar). The run does not resume beside them. End them (kill -9 4242, as their owner, or wait for them) and open the run again; they stay recorded in <root>/commands until then.
```

No fence reaches a third party. A paid API that already has a request has it. The package
guarantees that this runtime does not start an effect twice; an effect your model decides to retry is a new call, so give a
paid API an idempotency key from your own business key.

## Security

- **No privilege for the agent.** The instance, pi's tools and the agent's commands run as an unprivileged user. Every
  command starts under `setpriv --no-new-privs` (on Linux; macOS has no equivalent, see [On macOS](#on-macos)), so a
  command cannot use the run user's sudo rule (sudo refuses: "The no new privileges flag is set"). An app that turns
  this off (`archilEnv(claim, { noNewPrivs: false })`) or runs commands another way must confine them itself. If the
  agent is not trusted with the machine, sandbox its commands (for example with bubblewrap).
- **The file tools stay inside `work/`.** pi's `read`, `write` and `edit` run in the loop's process, not in a command
  sandbox, so every file operation of the environment resolves its path to the file the kernel would reach (`..`,
  absolute paths, symlinks, dangling links, a missing tail) and refuses it unless it lies in `work/` (reads may also use
  `tmp/`, where the bash tool tells the model its long output went, and `readRoots` the app names; writes may also go
  inside a directory the environment's `createTempDir` returned, for the tool it was handed to). An agent cannot `write
  ../store/run.sqlite` or `../commands`: the call fails with a `PathOutsideWorkError` the model sees as
  a failed tool result. Its message names no path (`outside the workspace`): pi's tools resolve a path against the
  workspace before they ask for it, so the path, the workspace and a link's target would all be the host's own. An app
  that shows the refusal names the path its caller gave, telling the error by its type and its `reason`. A path is
  opened one component at a time from a held handle of `work/`, without following links, so a link a command swaps in
  after the check is refused too (on Linux; on macOS the walk is by path, see [On macOS](#on-macos)). This covers the
  file tools only; a command still runs as the run user and can reach anything that user can, which is what an app's own
  command sandbox is for. `archilEnv(claim, { confineFiles: false })` turns it off where `/proc/self/fd` is unavailable.
- **`--serve` authenticates only with a bearer token.** On 127.0.0.1 (the default) the token is optional. A non-loopback
  `--serve-host` requires `--serve-token-file`, a file of mode 0600 holding the token (never argv or the environment); every
  request must send `authorization: Bearer <token>`, and it is compared in constant time. The file is readable by the run
  user, so by the agent's own commands: it guards the network, not the agent. Put TLS in front of anything that leaves the
  machine.

## Layout of a run

```
<root>/                    the run's directory (localRun's root)
  store/run.sqlite         pi's store (exclusive profile: no -shm file), with the run's record (status, generation, holder)
  work/                    the workspace the tools write
  tmp/                     pi's temp files and long-output spills
  commands/                the process groups of the commands its instance started, which the next open ends first
```

To remove a run, let its instance release (or stop it), then delete its directory.

## Library

`openDurableRun(ref, options)` is what `run` calls: take the claim (`localRun`'s), try the store's lock, make `store/`,
`work/` and `tmp/`, end a killed incarnation's commands, open the store, open the Harness, write this incarnation's
record in the store, and resume. Its `afterClaim(claim)` is awaited once the claim is held and before the store opens,
with the claim's `ref`, `root`, `work` and `store`. What it returns (`harness`, `beforeResume`, `seed`) goes into the
open, so `harness` may come from there instead of the options, and a factory can give a new run its seed (over the
options' `seed`); the seed runs right after `afterClaim`, on a new run only. A rejection fails the open with the store as
the open found it and lets the claim go.

`epoch` is the record's generation: a host that holds the run's claim on a record of its own (agentrun-serve's run row)
hands it. Without it, the generation is the previous record's plus 1, read from the store once the open holds its lock:
for a caller on one machine with no host epoch. Either way the store's own exclusive lock keeps a second writer out. The
open probes it before it reaps anything and is refused while a process holds the store (`HeldError` `store`, exit 76).
The probe holds nothing: the lock is free from the probe until the store opens, so two host-less openers at once can both
pass it (the failure table says what that costs). An open also refuses a record that names another run, or a malformed
one (`RunRecordError`, exit 65), before it resumes anything.

`archilEnv` and the typed errors (`FencedError`, `HeldError`) are exported for apps that compose their own lifecycle, and
so are serve (`serveRun`) and parking (`watchParking`, `drain`, `busyState`). `src/index.ts` lists every export; the
`.d.ts` files in `dist/` are the reference.

`@parcha/pi-durable-disk/internals` holds the plumbing this repository's examples and demos use (`runPath`, and what
agentrun-serve reads of a run: `RUN_STATUS_TABLE`, `processTable`, `profilePragmas`, the door's proof). It carries no
compatibility promise: a name there can change or go in any release.

### Seeding a new run

`seed` (in `openDurableRun`'s options) writes what a new run starts with before anything sees the
run: its store file, a SQLite database the Harness then opens (saved sign-in profiles, say), and files in its
workspace (`work/.agents/skills/`). `beforeResume` runs after the store is open, too late for that.

```ts
await openDurableRun(ref, {
  ...localRun("/var/runs/run-1"),
  harness: { models, registry },
  async seed({ storePath, workDir }) {      // also root: the claim's root
    const db = new DatabaseSync(storePath);
    db.exec("CREATE TABLE IF NOT EXISTS x_agent_profiles (name TEXT PRIMARY KEY, profile BLOB)");
    db.close();                             // closed before it returns: the store opens it next
    await cp(skillsDir, join(workDir, ".agents/skills"), { recursive: true });
  },
});
```

- **When it runs.** On the open that finds no record in the store: inside the run's first claim, with the store free,
  after `store/`, `work/` and `tmp/` exist, a killed incarnation's commands are ended and `afterClaim` has run, before
  the store opens. Its step is `seed`. What it wrote is made durable (the claim's barrier) before the store opens and
  the record publishes the run.
- **From the app.** `afterClaim` may return `seed` (as `AfterClaim`), over the options' one, so a factory that runs on the
  claimed directory can give the run its starting state.
- **When it doesn't.** Never for a run that has a record, whatever its generation.
- **When it fails.** A seed that throws fails the open with its own error. A process killed while it seeds leaves the run
  unpublished in the same way: no record, the claim let go. The next open seeds again, so a seed overwrites what an
  earlier attempt wrote.
- **Durability.** As with `work/`, the files it writes are the operating system's to flush; a SQLite database it commits with `synchronous = FULL` is durable when the commit returns.

### A run on a local directory

`localRun(root)` returns the `acquire` and `claimDir` that put a run on a plain directory of this machine:

```ts
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";

const run = await openDurableRun({ disk: "local", region: "local", id: "run-1" }, {
  ...localRun("/var/runs/run-1"),          // made when it is missing; work/ and store/ inside it
  harness: { models, registry },
});
```

The run's status is its record, in its store, and `readLocalRunStatus(root)` (the directory `localRun` takes) reads it
once no process holds the run: the `RunRecord` (`status`, `generation`, `wakeAt`, `holder`, `detail`), `null` when the run
has no record yet, and `RunRecordError` (`RUN_JSON_INVALID`) when it is malformed. While a process holds the run it
refuses with `HeldError` `store` (exit 76), with nothing read, written or removed. It opens the store as the run's process
does, read-write in its exclusive locking mode, for one read, so two things follow:
- on a store nobody holds, the read's close checkpoints what the WAL committed into the database file, as the next
  open's would;
- while the read holds the lock (its own duration), a run that starts on that store is refused as held and retries as
  any held store would.

So it is for a read after the fact, not for polling a run that is about to start.

```ts
const status = await readLocalRunStatus("/var/runs/run-1");   // { status: "sleeping", wakeAt: "...", ... } or null
```

It is for one machine (a laptop, a CI job, a test), and says so: the claim is the directory itself, so nothing but the
store's own lock keeps a second process off the run (a second open while one holds it is refused), and nothing at
all keeps out a process on another machine that can reach the directory. Its barrier refuses once the run is fenced,
but syncs nothing: the store's commits are made durable by SQLite, and the files the agent wrote in
`work/` are the operating system's to flush, so a power loss can lose what it had not written yet. Without `localRun`'s
`acquire`, the open is refused (`INVALID_ARGUMENT`) before anything is claimed.

#### On macOS

A local run works on macOS for development, and is weaker there than on Linux in four ways. Use Linux when the agent is
not trusted.

- **Commands keep your rights: `no_new_privs` has no macOS equivalent.** On Linux every command starts under
  `setpriv --no-new-privs`, so it cannot use `sudo` or gain privilege from a setuid program. macOS has no such flag and nothing
  that does its job (`sandbox-exec` is deprecated), so `noNewPrivs` defaults to false there and no `setpriv` runs. That
  leaves open: a command can use `sudo` wherever sudo asks it for no password (a `NOPASSWD` rule, for one), and setuid
  programs keep their privilege. `runAs` is not available either (it needs `setpriv`). As on Linux, a command runs as
  you and can reach anything you can.
- **The file tools' confinement is path-based.** On Linux it walks a path through `/proc/self/fd`, one held directory at
  a time, so no component can be swapped once it was checked; macOS has no `/proc/self/fd`. There it resolves the path
  (`realpath`) and refuses it unless it lies in `work/` or another root the file tools may use, as on Linux, opens each
  component by its full path with `O_NOFOLLOW`, then checks that the path still resolves to itself and names the
  directory it opened (same device and inode). It refuses `../store/run.sqlite`, absolute paths and links out of
  `work/`, a link already in place included. That leaves open: a command that swaps a directory above the target for a
  link between that check and the operation can win, and the file tool then acts where the link points.
- **The run's root is addressed by its path.** On Linux, the run's directories are made through the
  directory opened at acquire. On macOS each write is checked first against that directory, and a root renamed and
  replaced between the check and the write gets the write.
- **Commands are recorded from `ps`.** With no `/proc`, the instance reads one `ps` listing every 0.5 s while commands run,
  `ps -E` for a command's mark and `sysctl kern.bootsessionuuid` for the boot. A command started within about 0.5 s
  before a kill can be missed, and a process is told from a later one with the same pid by the second it started.

`fsync` on macOS does not flush the drive's cache, so the store also sets SQLite's `fullfsync` and
`checkpoint_fullfsync` there (SQLite then syncs with `F_FULLFSYNC`), and refuses to open unless they read back. CI runs
the no-key quickstart, the local run's tests (its command records, `run --dir` and `status --dir`, the file tools'
confinement) and the keyless examples on macOS.

### Places: where a run's instance starts and ends

A place is where one run lives and how its instance starts, ends and comes back, for a supervisor of your own (the
reference demo's). Each factory takes its options and returns `(ctx) => Place`; `ctx.paths` is the run's
id and directory as the supervisor computed them.

- `localPlace({ app, root? })` runs `pi-durable-disk run --dir <root> --id <id> --app <app>` as a child in its own
  process group, with `{ PATH, ...order.env }` and nothing else of the caller's environment. It needs no disk, no key and
  no token. A process kill is SIGKILL to the group, and the next runner resumes the run from the directory. A box kill
  also calls `ctx.destroyBoxes` (a deletion that failed is tried again by the next kill or recover). `release()` kills
  what still runs, then, while no process holds the run's store, ends the commands the run recorded (pi starts each in a process
  group of its own, which the instance's kill does not reach). While another process holds the run, they are its own,
  and release leaves them. With `ctx.requestFile`, `signals(attempt)` yields the kill request the runner writes
  there when it parks at its planned crossing, and `requestFile` is that same file. `return()` ends a pending `next()`.
- `place.readRunFile(path)` and `place.listRunFiles(dir)` read the run's own files on this machine: the bytes of a file
  (`null` when there is none yet), and the names directly under a directory (`""` for the run's root), sorted. They never
  write and never take the claim. A path that is empty, absolute, has a `.` or `..` segment, or a character outside
  `[A-Za-z0-9._-]` in a segment is `INVALID_PATH` (`RunFileError`), named by its fault, never the path. A missing run is
  `RUN_MISSING`, and a directory, or a symlink anywhere on the way, is `NOT_A_FILE`, never followed. A place never parses
  what it reads.

A runner's `exited` says how it ended. Locally that is the exit code or signal, and the outcome is the instance's
`{"outcome":{...}}` line on stdout. Without that line, the outcome is the record's, with its generation, and `code`, `message`, `record` and `storeSha256` from the detail of the last status
the app set. Its `status` is the run's word, not the record's, so a supervisor needs no package vocabulary: `complete`
when the run is `done` and that detail carries a record, `failed` for anything else (done with no record, failed, or a
run its instance left `running`, `paused` or `sleeping`).

Either way the outcome may carry `models`, the role-to-model ids the run's live parts chose (`lead`, `eyes`, ...), on any
status, a failed run's too: from the outcome line's `models`, or from the final detail's (`setStatus("done", { record,
models })`). Both places keep it only when it is a plain object whose values are all strings; a missing or malformed one
is left out, never replaced by `{}`.

## Tests

```sh
npm test            # unit tests: no disk, no network, no model
npm run typecheck
```

The package and its unit tests run on Node 22.19 or later.
