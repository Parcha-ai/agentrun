# @parcha/pi-transport

**Experimental.** The API changes without notice between releases.

Run a [pi-durable](https://github.com/earendil-works/pi) session's tools in another machine, or move the session
there. This release holds the first layers: the `Box` interface with two providers and a conformance suite, `boxEnv`,
which runs a session's tools in a box, and `transport()`, which sends each conversation's tools to the box its
config names.

## A box

A `Box` is one running machine: a directory on this machine, a container, a sandbox, a VM. A `BoxProvider` creates
boxes, finds them again by id and lists them by label.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { finish } from "@parcha/pi-transport";
import { dockerBoxes } from "@parcha/pi-transport/box/docker";

const provider = dockerBoxes();
const created = await provider.create({ maxLifetimeMs: 10 * 60_000 }, BACKGROUND_CONTEXT);
if (!created.ok) throw created.error;
const box = created.value;

const started = await box.exec(["uname", "-a"], undefined, BACKGROUND_CONTEXT);
if (started.ok) console.log(await finish(started.value));
await box.destroy(BACKGROUND_CONTEXT);
```

Expected failures are returned as `Result` values with a `BoxError` and a code. Every box has a maximum lifetime
that its provider enforces with no call from the host, so a host that dies does not leave boxes behind. A program in
a box never receives the host process's environment. A provider refuses a spec field it cannot honour instead of
ignoring it.

| Provider | Import | Isolation |
| --- | --- | --- |
| This machine | `@parcha/pi-transport/box/local` | none: for development and tests |
| Docker | `@parcha/pi-transport/box/docker` | a container per box |

`localBoxes` gives a program a fixed `PATH` (`/usr/local/bin:/usr/bin:/bin`, or the `path` option), a private `HOME`
and `TMPDIR`, and the spec's `env`. A detached watchdog ends a box when its lifetime has passed. On Linux, `destroy`
and the watchdog end every program of the box, also one that went to the background or left its process group. Where
`/proc` is missing they end only the programs the calling process started, and the watchdog removes the directory only.
It refuses `image`, `snapshot`, `cpus`, `memoryMb`, `gpu`, `region` and any `isolation` but `none`.

`dockerBoxes` runs `sleep` for the lifetime in place of the image's own entrypoint, so Docker ends the box. It refuses
`snapshot`, `region` and any `isolation` but `container`. Docker cannot choose a GPU model: any `gpu` gives the
container every GPU of the host.

## Hands: tools run in a box

`boxEnv(box)` is pi's `ExecutionEnv` over a box. Hand it to a pi-durable Harness and the session's `read`, `write`,
`edit` and `bash` tools run in the box, while the session, its store and its model calls stay with the host.

```ts
import { boxEnv } from "@parcha/pi-transport/hands";

const env = boxEnv(box);
const written = await env.writeFile("notes/a.txt", "hello", BACKGROUND_CONTEXT);
const ran = await env.exec("wc -c notes/a.txt", { timeout: 10 }, BACKGROUND_CONTEXT);
```

- Every file operation and every command is one `Box.exec` of a fixed script. Paths are arguments, never part of the
  script.
- Every file operation has a deadline, and so has the start of a command. A box that ended or stopped answering is
  a tool error on that call and on every later one, with the reason in the message. A command runs as long as its
  caller's timeout allows; with none it has no deadline, as in pi's local environment, unless `maxExecMs` sets one.
- A command runs as a process group of its own. A timeout or an abort kills the whole group with a second exec, also
  on a box whose provider cannot stop a program it started.
- The variables a caller asks for, `PATH` included, reach the command alone. The environment's own scripts keep the
  box's search path, so a `PATH` with no shell in it still runs a program named by its path.
- Results match pi's `NodeExecutionEnv` on the same files: the same values and the same error codes. Messages differ.
  The suite checks this with pi's own environment conformance cases and with random operation sequences run against
  both.
- The environment's id is `pi-transport:<provider>:<box id>`. `~` is the box's home directory.

What a box must have: a POSIX `sh`, and the GNU versions of `dd`, `find`, `mv`, `mktemp`, `realpath`, `sleep` and
`truncate` with `setsid` (coreutils, findutils and util-linux, as in Debian and Ubuntu images). An image built on
BusyBox does not have them. A string command runs in `bash` when the box has it, else in `sh`. The environment keeps its
commands' process groups in `.pi-transport` under the box's temporary directory (`TMPDIR`, else `/tmp`).

Where it differs from `NodeExecutionEnv`, on purpose:

- A command that is stopped is asked to end first and killed a second later. Node kills at once.
- With `inheritEnv: false` a command still has a default `PATH`.
- A rename across file systems succeeds, because `mv` copies.
- `listDir` returns a name that is not UTF-8 with the replacement character. Node fails the whole listing.
- A watcher polls, so its `mode` is `polling`.
- `openBinaryReader` and `openTextLineReader` read the file whole when they open it, in one round trip to the box, and
  serve every later read from that copy on the host. A file above `maxReaderBytes` (64 MiB by default) is refused with
  `not_supported` before a byte of it leaves the box; a command (`head`, `tail`, `sed`) reads such a file in parts.
  Node reads the ranges it is asked for. `readTextLines` with `maxLines` brings only those lines out of the box.

Not covered by hands: MCP servers, code mode and model calls stay with the Harness.

### Where tools run is a line of config

`transport(config, host)` is a Harness's `env`. It reads the `transport` block of an agent's config and runs each
conversation's tools in the environment the block's `hands` names.

```ts
import { Harness } from "@earendil-works/pi-durable";
import { parseTransportConfig } from "@parcha/pi-transport";
import { dockerBoxes } from "@parcha/pi-transport/box/docker";
import { transport } from "@parcha/pi-transport/hands";

const config = parseTransportConfig({
	environments: { sandbox: { provider: "docker", maxLifetime: "6h" } },
	hands: "sandbox",
});
if (!config.ok) throw config.error;

// The transport is the Harness's `env`, so it is built first and reaches the Harness through this binding.
let harness: Harness;
const hands = transport(config.value, {
	providers: { docker: dockerBoxes() },
	commit: (change, context) => harness.commit(change, context),
});
harness = await Harness.open(storage, { models, registry, env: hands.env }, BACKGROUND_CONTEXT);
```

- **A box is created at the first file operation or command, not before.** pi asks for a conversation's environment
  at every prompt it prepares as well as at every tool call, so `env` returns a lazy environment. Until its box
  exists its `cwd` is `.` and its id ends in `:unopened`. A run that calls no tool creates no box.
- **A host that opens the session again finds its boxes.** A box's id is written to a session document
  (`transport.boxes`) before a tool runs in it, and the next `transport()` on the same store asks the provider for
  that box. Concurrent first uses share one creation.
- **One box for the session, or one for each conversation.** `scope: "session"` is the default; with
  `scope: "conversation"` every conversation gets its own.
- **Roles.** `hands: { default: "sandbox", build: "gpu" }` names a role. `hands.assign(conversation, "build", context)`
  points a conversation's tools at it, or at any declared environment, from its next tool call. The assignment is a
  conversation document (`transport.hands`). A fork starts without one, on the default.
- **A box that is gone is one failed tool call.** A box that cannot be created, or that ended behind the session's
  back, is that call's error result with the provider's code in the message. The next call asks for a box again.
- **Two ways to let boxes go.** `release()` forgets them and leaves them running, for a host that will open the
  session again; a box nobody comes back to ends at its lifetime. `destroy()` ends every box of the session,
  including those only the session's documents still name.
- **Labels are the host's.** `labels` in the host go on every box the transport creates, for example a session
  id, so the host can list what it left behind. The transport adds none of its own: `pi-transport` and the keys
  under it belong to providers, which mark their own boxes.
- **`undefined` means the host's own environment.** `env` returns `undefined` when the config names no `hands`, or
  names a `local` environment and the host passed no `local` provider. A host puts its own environment behind it:
  `(await hands.env(target, context)) ?? new NodeExecutionEnv({ cwd })`.

`transport()` throws a `TransportError` at start for a config it cannot serve: an environment whose provider the
host did not pass, `hands: "auto"`, and `expose`.

`expose` is not available yet: no secret is passed into a box. When it is, a secret will travel with each command
over the exec's input and be set in the box by the environment's launcher. It will never be in `BoxSpec.env`, which
a provider may store and return, and never in a command line.

`examples/01-hands.ts` runs one scripted session whose tools go where a config file says:

```sh
node --experimental-strip-types examples/01-hands.ts examples/hands.docker.json 'hostname; pwd'
```
## Moving a home: a store and a workspace

`@parcha/pi-transport/home` holds the two movers a session needs when there is no disk the boxes share. They know
nothing of sessions beyond "a SQLite file and a directory". Node only.

- **A store.** `sealStore(path)` returns a `Seal` (head, SHA-256, size) of a store its owner has closed; a store with a
  write-ahead log that holds content is refused with `not_sealed`. `checkpointStore(path, to)` takes a consistent copy
  of a store that is still open, with `VACUUM INTO` through a second read-only connection; the copy appears whole or
  not at all. `verifyStore(path, seal)` checks size, hash, SQLite's quick check and the head, in that order. The head is
  one read of `durable_metadata.next_seq`, the only knowledge of pi's schema here.
- **A file.** `moveFile(from, path, to, path, seal)` copies one file between boxes through this process and checks it by
  hash on the way and on the target; it appears at its path whole or not at all.
- **A directory.** `manifestOf(box, root, { exclude })` lists a directory in the box: every path with its kind, size,
  mode, link target and, for files, SHA-256. `moveWorkspace(from, to, { fromRoot, toRoot, exclude, maxBytes })` copies it
  as a `tar` stream, relayed a chunk at a time with no temporary file, then checks the target against the source:
  `too_large` and `unsupported_entry` (a socket, device or pipe, named) are decided from the listing before a byte
  moves; `changed` says the source changed during the copy; `mismatch` names the first path where the target differs.
  The receipt has bytes, files, the time of each part, MB per second and which side the relay waited on more.

Kept: file contents, permission bits, symbolic links as links, empty directories, modification times in whole
seconds, names with any bytes. Not kept: owners and groups, extended attributes, ACLs, and the access times. A target
that already holds other files fails the check. The boxes need `tar`, `find`, `xargs`, `split` and `sha256sum` from GNU
coreutils and findutils, as `boxEnv` does.

**How the bytes travel.** Each side of a move decides for itself by its box's `facts().bulk`: `stream` moves the
archive through the streams of `exec`, and is what `localBoxes` and `dockerBoxes` say; anything else, including a box
that says nothing, moves it as files through `upload` and `download`, because a remote provider's streams can be far
slower than its file calls (measured: Daytona's at 0.1 to 2.8 MB/s against 25 to 40 MB/s for files, a Modal sandbox's
at 2 MB/s against 31 to 35). Out of Docker into Daytona the archive streams out and arrives as files. A host can
override either side in the options (`fromPipe`, `toPipe`) and set the size of the parts (`chunkBytes`, default
32 MiB). With files, the archive is cut into parts in a directory of its own under the box's temporary directory
(`TMPDIR`, else `/tmp`); every part is hashed where it is made and checked where it lands, so a part that is missing,
short or flipped is `mismatch`; the directories are removed on success, on failure and on abort.

**Disk a move needs.** A side that moves files holds the archive once more: the source box needs free space for the
archive next to the tree it is packing (about the size of the files), and the target box for the archive next to the
tree it unpacks (the same again). A side that streams needs none. The host holds one part in memory at a time.

## A home: the session runs somewhere, and can stop without a cut

`openHome(options)` is one place a session can run: its store, its workspace and pi's Harness over them. It does
nothing by itself. A host gives it orders, in its own process today and over a link later:

```ts
import { openHome } from "@parcha/pi-transport/home";

const home = await openHome({ app, session, store, workspace, where, models });
if (!home.ok) throw home.error;
await home.value.resume({ epoch: 1 }, BACKGROUND_CONTEXT); // a session that starts here
// ... later, to move it:
const drained = await home.value.drain({ timeoutMs: 60_000 }, BACKGROUND_CONTEXT);
const seal = drained.ok ? await home.value.seal(BACKGROUND_CONTEXT) : undefined;
```

- **The app.** `app` is `(ctx) => options`: pi's Harness options without `env` and without `models`, plus `root` (how
  the root conversation is made) and `onOpen`. The home adds the store, the models it was given and the environment,
  the same way wherever it runs, so one module serves every place. `ctx.workspace` is the only absolute path an app
  may build on. `loadApp(path)` takes the default export of a module file.
- **The gate.** A drain holds new work at three hooks of the home's own extension (installed as `transport`): a tool
  call before its intent is written, a model request before it is sent, a compaction before it selects. A held task
  has written nothing, so the close leaves no outcome for it and the next home runs it from the start. Work of a
  conversation whose owner task is running is let through: a tool that waits for its child conversation can only
  finish when the child does. The drain is done when two reads in a row find every running task held.
- **Never a cut.** A drain that does not complete in `timeoutMs` opens the gate again, the session works on where it
  is, and the `DrainError` names what held it: the kinds and counts of the tasks that were running and not held.
- **Tasks of your own that never end** can never be held. By default the drain waits for them, so it times out.
  `closeable: ["my.kind"]` leaves a kind out: the close stops such a task as a crash would and the next home resumes
  it from its checkpoint, so it must make its own effect safe to repeat.
- **A store is opened only when a seal vouches for it.** `resume({ epoch, seal, move })` verifies the store against
  the seal, writes a marker beside it, opens it, points every conversation at this home's workspace, admits the
  move's notice (a `transport.move` entry, request id `transport.move:<move id>`) and resumes. Each step is safe to
  repeat after a crash: the marker lets a home open again the store it already opened in this epoch, the rewrite is
  recorded with the move's id, and pi admits a request id once.
- **A home that sealed stays closed.** After `seal()` it takes only `reopen({ epoch })`, when the move was given up
  and the lease still names it, or `retire({ epoch })`, when a later epoch names another home: it then stops what
  runs, if anything, and deletes its copy. It never reopens by itself, in the same process or a new one: it cannot
  tell a host that went away before the session was taken elsewhere from one that went away after. If no host
  returns, the session stays sealed and safe, not running.
- An order for an epoch the home has left behind is refused with `stale_epoch`.
- **Where a home's tools run.** A home on this machine may send its tools to any environment (`hands`). A home in a
  box runs its tools in its own box in this release: `checkHomeHands(config, home)` refuses a config whose `hands`
  names another environment with `unsupported`. Tools in another box than a boxed home's come later.

Not covered: a tool call that sleeps between retries inside pi has no hook, so a drain waits for it or times out;
programs the agent left running in the background do not move.

### A home in a box: the link

A home in a box is a runner program, driven by the host over the box's own `exec`: frames are JSON lines on the
runner's input and output. Nothing listens in the box and nothing dials in. The customer bundles the runner with
their app into one file:

```ts
import { runMain } from "@parcha/pi-transport/home";
import app from "./app.ts";

await runMain(app);
```

The host starts it with `Box.exec` and holds it with `connectHome(processLink(process), { models, epoch })`, which
says hello with the host's model catalog, gives orders (`resume`, `drain`, `seal`, `reopen`, `retire`, `submit`,
`idle`, `status`) and answers the runner's model requests. `createRunner` and `connectHome` over `linkPair()` do the
same in one process.

- **No key in the box.** The runner's models mirror the host's catalog without `headers` or `baseUrl`, with an auth
  that holds nothing. A model request is one frame; the host makes the call with its own credentials and sends the
  answer back as pi-ai's compact frames, which the runner turns into the same events. A request's `apiKey`, `env`,
  functions and signal never cross; an abort is a frame of its own.
- **A link that drops in the middle of an answer.** The runner keeps the request open for `resumeWithinMs` (30 s by
  default) and asks for the frames it missed when a host comes back; the host kept them, so the answer goes on and the
  host pays once. A request still open after that ends with an error pi retries.
- **Writes are coalesced.** One write to the runner's input is in flight at a time and every frame sent meanwhile goes
  in the next one, so a box whose input is a slow buffered call carries an answer at the pace it is made.
- **The fence.** Every frame from the runner carries the epoch it runs at. The host refuses a model request from any
  epoch but the lease's; the runner then closes its session without sealing and exits with `75` (`EXIT_REFUSED`), and
  its launcher must not start it again. A home the lease left behind has no model. This does not stop a command that
  was already running in a box that was cut off and is still alive: its effects outside the box are not fenced.
- **A lost link** gives up a drain that was under way: held work goes on. A home that sealed stays sealed. The runner
  program speaks over the `exec` that started it, so when that link closes it closes its session in order and exits;
  a runner started again opens nothing until a host says so. `runMain` writes nothing but frames on its output: the
  app's `console.log` goes to the error output. It refuses a Node below 22.19.

Not covered: in this release a home in a box runs its tools in its own box, and there are no box frames on the link.

### Moving a home

`moveHome(options)` moves a session's home from one box to another with no disk the two share, in seven steps:

1. **Prepare.** Start the runner in the target box: check its Node (none, or one below 22.19, is `no_runtime`),
   upload the runner file by its SHA-256 unless the box holds it (`boxRunner({ program: { file } })`), start it with
   `Box.exec`. The session keeps working.
2. **Drain** the source: the gate holds it still. A drain that does not complete gives the move up (`drain`, with
   what held it) and the session works on.
3. **Seal** the source's store.
4. **Ship** the store and the workspace (`moveFile`, `moveWorkspace`), each checked on the target, one retry.
5. **Take** the lease (`Ownership`): one conditional write, from epoch `e` to `e + 1`, with the seal and the move in
   the record. **The point of no return.** It is tried only with a target that still answers.
6. **Resume** the target at `e + 1`: it verifies the copy, rewrites the conversations' directories and admits the
   notice once.
7. **Retire** the source: it stops and deletes its copy. A source that does not answer is fenced by the epoch.

Before the take, a failure leaves the session where it was: a sealed source is told to open its store again
(`seal`, `ship`, `target`). A lost take (`lost`) means another host acted: this host does nothing more. After the
take, a failure is the target's to finish: `recoverHome(options)` reads the lease, starts the runner where it says
and makes that home run (a sealed home is told to reopen, a target that never resumed is told to resume with the
lease's seal and move). A host that starts again calls it.

`registerMoveConformance(runner, name, withPair)` runs the handoff on two places of a provider: a move with nothing
cut, a move given up, and a kill of the host, the source or the target just before each of the seven steps, each
followed by a recovery. The runner it needs is `runMain(moveConformanceApp)` bundled into one file.

What a kill loses, in these words: a host, a source or a target process that dies loses nothing; the session
finishes with every effect once when the kill came after the drain held it, and at most once when it came while
the session ran. A box that dies with its disk loses the work since the last checkpoint: that needs the checkpoint
of a later release, or a disk that outlives the box.

## Writing a provider

Fill `BoxProvider` and `Box`, then run the conformance suite against real boxes:

```ts
import { describe, expect, it } from "vitest";
import { registerBoxConformance } from "@parcha/pi-transport/testing";

registerBoxConformance({ describe, expect, it }, "my boxes", (use) => use(myBoxes()), {
	// One box is left alone for its lifetime. `ended` must ask the vendor's own API, never the provider under test.
	lifetime: { maxLifetimeMs: 60_000, graceMs: 120_000, ended: (box) => myVendorSaysGone(box.id) },
});
```

A box whose `exec` carries input and streams output can take `uploadByExec` and `downloadByExec` as its file calls.
