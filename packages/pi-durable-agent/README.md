# @parcha/pi-durable-agent

An agent you can carry. Its definition, its sign-ins and its runs live in one directory, the **agent home**, as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) stores: `agent.sqlite` for the agent, and one
`run.sqlite` per run. Each run is a `@parcha/pi-durable-disk` run directory, so `pi-durable-disk run --dir` can run it.
Copy the directory and the agent goes with it. A run starts from the agent's definition and its saved sign-ins, and
when it ends, the sign-ins it made go back to the agent, so the next run starts signed in.

Both files are ordinary pi-durable stores at `synchronous = FULL`, read and written with pi's own Session: no second
format and no second durability layer. The host keeps everything a run needs from outside: the model, the thinking
level, the tools, and where each tool runs. The definition names tools; the host binds them.

This package is held: it is built and tested in this repository and not published yet.

## Quickstart (no key, no network)

Node 22.19 or later. In a checkout of this repository, run `npm ci --ignore-scripts` and
`npm run build -w @parcha/pi-durable-agent`, save this as `quickstart.mjs` at the repository root, and run
`node quickstart.mjs`:

```js
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { carryBack, createAgentHome, durableProfileStore, readAgentHome, startRun } from "@parcha/pi-durable-agent";

const home = await createAgentHome("./acme", {
  definition: { version: 1, name: "Acme researcher", instructions: "Cite every claim.", skills: ["cite"], tools: ["browser"] },
  skills: { "cite/SKILL.md": "# Cite\n\nQuote the page you read.\n" },
});

async function oneRun(runId) {
  const run = await startRun(home, { runId, host: "laptop" });
  // The host's own Harness on the run store: its models, its registry, its tools.
  const database = await openNodeSqliteDatabase(run.storePath);
  await database.exec("PRAGMA synchronous = FULL");
  const harness = await Harness.open(await SqliteStorage.open(database), { models: createModels(), registry: createRegistry() }, ctx);
  await harness.root(ctx, { agent: { instructions: run.agent.instructions } });
  // pi-browser takes this as its ProfileStore; here a stand-in makes the sign-in.
  const profiles = durableProfileStore(harness);
  const ref = await profiles.resolve("acme.example", async () => { console.log(`${runId}: signing in`); return "ctx_1"; });
  console.log(`${runId}: profile ${ref}, save lease: ${run.leases.includes("acme.example")}`);
  await harness.close(ctx);
  const back = await carryBack(home, run, { outcome: "completed" });
  console.log(`${runId}: carried back ${back.profiles.join(", ") || "nothing"}`);
}

await oneRun("run-1");
await oneRun("run-2");
console.log((await readAgentHome(home)).profiles);
```

```
run-1: signing in
run-1: profile ctx_1, save lease: false
run-1: carried back acme.example
run-2: profile ctx_1, save lease: true
run-2: carried back acme.example
{
  'acme.example': { provider: 'browserbase', ref: 'ctx_1', state: 'ready' }
}
```

Run 1 signs in once. Run 2 finds the sign-in ready and never makes one.

## The agent home

```
acme/                        the agent home
  agent.sqlite               the agent store: identity, definition, skills, sign-ins, the runs index
  owner.lock                 the writer lock (below); never open, copy or move it with the home
  runs/<run id>/             a pi-durable-disk run directory
    store/run.sqlite         that run's pi-durable store; the host opens its Harness on it
    work/                    that run's files, with the agent's skills under .agents/skills/
    run.json, owner.lock,    written by pi-durable-disk when it runs the run (and commands/ on a local
    tmp/                     directory); carryBack reads only the store
```

`runPaths(home, runId)` gives a run's `dir`, `storePath` and `workspace`. To run it under pi-durable-disk, start it with
`startRun` first, then `pi-durable-disk run --dir <dir> --app MODULE` (the run id defaults to the directory's name), or
`openDurableRun(ref, { ...localRun(dir), harness })` from code, and call `carryBack` after the instance released it.

Every call opens `agent.sqlite` as its only writer and closes it before it returns, so an `AgentHome` handle holds
nothing open. Writers queue in the process, then take `owner.lock`: an exclusive SQLite lock on an empty file, which
the kernel drops when its holder dies, so a writer that crashed never leaves it behind. A writer waits up to 5 seconds
for another process's, then fails with `AgentHomeError` (`busy`). On a disk that one machine claims at a time, the host
passes the claim as a `HomeAccess` and the lock is taken inside it ([An agent home on a disk](#an-agent-home-on-a-disk)).

## A run

1. `startRun(home, { host, runId?, now?, leaseMs? })` creates `runs/<runId>/` (the id defaults to a UUIDv7), writes the
   skills into the workspace (each checked against its SHA-256), takes the save lease for each profile no live run
   holds, copies the agent's `browser.profiles` into the run store, and records the run in `agent.runs`. A profile
   another run holds the lease for is copied without its `ref` (`state: "held"`, `heldBy` naming that run). It returns
   `{ runId, dir, storePath, workspace, agent: { instructions, tools }, leases }`, where `leases` lists the profiles
   this run can write to. Seeding is this host step; nothing here is a tool, and the model never sees a sign-in.
2. The host opens its own Harness on `storePath`, itself or through pi-durable-disk on `dir`, and creates the root
   conversation with `agent.instructions`, its chosen model and thinking level, and its tools for the names in
   `agent.tools`.
3. `durableProfileStore(harness)` is pi-browser's `ProfileStore` over the run store's `browser.profiles`: `resolve(key,
   make)` returns a ready profile's `ref`, or calls `make` once (one caller at a time per key, outside any commit) and
   commits the new `ref` as `ready`. A `held` profile has no `ref`, so the run starts signed out of that site and
   `make` gives it a context of its own, which is never carried back.
4. After the run's Harness closes, `carryBack(home, run, { outcome, finalAnswer?, cost?, now? })` copies back, in one
   commit, each profile the run holds the lease for and each profile new to the agent that no live run holds, releases
   the run's leases, and completes its `agent.runs` entry. A second call for the same run changes nothing.

**The save lease.** Two runs of one agent can run at once, and neither Browserbase nor Kernel locks a saved context:
the last writer wins. So one run at a time holds a profile's save lease: only that run gets the saved sign-in, and only
its changes go back. pi-browser's Browserbase provider opens every saved context it is handed with saving on, so a run
without the lease never gets the `ref`; reusing a sign-in read-only waits for pi-browser to let the host open a saved context without saving.
A new profile goes to the first run that carries it back. A lease expires after `leaseMs` (default 6 hours), so a run that
died does not hold a profile forever; a run whose lease passed to another saves nothing back.

## Following the agent's repo

An agent's definition and skills can live in a git repo, with the agent home as their cache. The package does not
read git: the host reads the definition and the skill files at a commit and passes them in with its sha (40 or 64
lowercase hex digits, a SHA-1 or a SHA-256 commit).

- `createAgentHome(dir, { definition, skills, sha })` and `refreshAgentHome(home, { sha, definition, skills })` write
  the files and `agent.source` (`{ sha, refreshedAt }`) in one commit, so the sha always names the cached files. A
  refresh replaces the definition and the skill set: a skill path not in the new set is removed. The definition's
  `id`, when given, must be the agent's, and `identity.name` follows its `name`. A refresh at the sha the home already
  has changes nothing (`{ changed: false }`): a sha names one content.
- `refreshAgentHome(home, { sha, from, ... })` is a compare-and-swap: the home must be at `from` (`null`: no sha yet),
  or the refresh is refused (`stale`) before anything is written. A host that read an older commit then cannot move
  the cache back over a newer one; whether one commit follows another is for the host to judge, from git.
- `refreshAgentHome(home, { ..., ifRevision })` is a compare-and-swap on `homeRevision`: a home whose head commit is
  not `ifRevision` is refused (`stale`) before anything is written. An API checks an `If-Match` this way, under the
  home's lock, instead of racing a separate read. The order is: the input, `ifRevision`, `from`, the same-sha no-op.
- `startRun` records the home's sha on the run (`agent.runs`, and `sha` on what it returns), read under the same lock
  as the skills it copies into the workspace. A run already started keeps its sha and its copy of the skills when the
  home is refreshed.
- `startRun(home, { host, sha })` refuses with `AgentHomeError` (`stale`) when the home's cache is at another commit,
  or at none, so a run never starts on skills older than the host asked for: refresh first.

A home with no `agent.source` (every home made before this) is not tied to a repo, and its runs record no sha.

## Stored kinds

Every document is session-scoped, version 1, in the store named. Times are ISO 8601 strings in UTC. The kinds and their
fields are the stored format.

| Kind | Store | Key | Value |
|---|---|---|---|
| `agent.identity` | agent | | `{ id, name, formatVersion }`. `id` is the definition's `id`, or a UUIDv7 minted at creation; never a host's id. A given id is one URL segment, `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `agent.source` | agent | | `{ sha, refreshedAt }`: the repo commit the definition and skills were read from, written in their commit; absent for a home not tied to a repo |
| `agent.definition` | agent | | `{ id, version, name, description?, instructions, skills, tools, input_schema?, output_schema?, workflow?, max_cost_usd? }`. `skills` and `tools` are names; `workflow` is an AgentRun workflow document. No model, no thinking level |
| `agent.skills` | agent | path under `.agents/skills/` | `{ content, sha256 }` |
| `agent.aliases` | agent | host | `{ externalId }`: the agent's id in that host |
| `agent.bindings` | agent | host | `{ [tool]: target }`: where each tool runs in that host |
| `agent.runs` | agent | run id | `{ path, host, startedAt, sha?, endedAt?, outcome?, finalAnswer?, cost? }`; `path` is relative to the home; `sha` is the home's `agent.source` when the run started |
| `agent.leases` | agent | profile key | `{ runId, expiresAt }` |
| `browser.profiles` | agent and run | profile key | `{ provider, ref, state, startUrl?, allowedOrigins?, verifiedAt?, heldBy? }`; `ref` is the provider's saved sign-in, `state` is `ready` once it names one, or `held` in a run store whose run has no lease on it (`ref` empty, `heldBy` the run that has) |

A profile's `ref` opens a signed-in session, so it is as secret as the password behind it: it reaches a run only
through the host, and no tool reads or returns a profile.

## Exporting a home

An exporter (a copy of a home for a viewer, or for someone else to run) copies only the kinds on `EXPORTABLE_KINDS`:
`agent.identity`, `agent.definition`, `agent.source`, `agent.skills` and `agent.runs`. Every other kind is dropped, a kind this release
does not know included. `SECRET_KINDS` names what never leaves the home: `browser.profiles` (saved sign-ins),
`agent.leases`, and `agent.bindings` and `agent.aliases` (each host's own names for where the tools run and for the
agent). Every kind this package defines is on exactly one of the two lists, and a test fails on a kind added to
neither.

`projectForExport(kind, value)` is what an exporter writes for one stored document: a deep copy, with `host` removed
from an `agent.runs` record (it is the caller's own name for itself), or `undefined` when the kind is not on
`EXPORTABLE_KINDS`. Kinds this package does not define, pi's own documents and another extension's, are not on the
list, so they are dropped too.

The three are also the subpath `@parcha/pi-durable-agent/export`, which imports no module: a writer that only filters
kinds (a replay of exported stores, for one) loads them with `node:sqlite` alone, not the root, which loads
pi-durable, chord and pi-ai.

## Moving a home

One packer moves a home between a local server and a hosted one. `packHome(home, { out })` writes the pack,
`readPack(file)` judges one without writing a home, and `importPack(file, dir)` writes one as a home.

A pack is a tar (POSIX ustar, with pax headers for a name over 100 bytes or beyond ASCII), and it holds these members
and nothing else, in this order, sorted, owned by 0/0, mode 0644 or 0755, stamped with the manifest's `created_at`:

| Member | Holds |
|---|---|
| `manifest.json` | `format` `agentrun.home/1`, `agent_id`, `definition`, `source` (`sha`, `refreshed_at`, or `null`), `skills` (`path`, `sha256`, `size_bytes`), `sign_ins` (`key`, `provider`: what the source had, none travels), `vault` (`name`s, empty today), `runs` (`count`, `live`), `size_bytes` (the pack's own), `created_at` |
| `agent.sqlite` | A new agent store with only `EXPORTABLE_KINDS`, each through `projectForExport`, then `VACUUM INTO` one clean file: no `-wal`, no `-shm`, no free page with an old row. Nothing is copied from the live file |
| `runs/<id>/store/run.sqlite` | Only through `exportRunStore(storePath, outPath)`; without it no run store travels |
| `runs/<id>/work/...` | Regular files and directories whose names do not start with `.`. Whatever the reader would refuse is left out and listed in `skipped` with its reason: a link, a hard link, a device, a dotfile, a `*.sqlite-wal` side file, a text file named `*.sqlite` |

A run that was still live (no `endedAt`) travels as its `agent.runs` entry only: neither its store nor its work. The
home's `chrome/`, `repo/`, `owner.lock`, `tmp/` and everything else are never read. The packer refuses (`check`) a
SQLite file that holds a `SECRET_KINDS` document or has a `-wal`, `-shm` or `-journal` file beside it, whatever its name:
it looks at the bytes, so a store hiding in `work/` is found. A work directory it cannot read fails the pack, naming it,
rather than packing less than the run has. Each work file is opened without following a link and must be the file that
was listed (device, inode, size), alone, and inside the run's work directory, so a file or a parent directory swapped
for a link while the pack is made is left out (or stops the pack, if it happens while it is written). `maxBytes` and
`maxMembers` refuse (`too_large`) before anything is written. The home is read under its owner lock, the pack is written
to a `.part` file, read back with `readPack`, and renamed into place only when its own reader accepts it.

`readPack` returns `{ ok, manifest, checks }`. The checks use the contract's names for what the package can judge:
`format` (the manifest first, `agentrun.home/N` with N at most this version's, every member on the allowlist and none
inside a file, no `..`, no absolute path, no link or device, no store with a sign-in kind, at most `maxMembers`, no global
pax header, at most one pax header of at most 64 fields before a member, nothing after the end), `definition` (the definition
is valid and is the one in `agent.sqlite`, the agent id is the same everywhere, each skill matches its `sha256` and
size), `sign_ins` (`warn` when the source had sign-ins: they are to redo at the target), `size` (the pack is the size its
manifest says, and within `maxBytes`) and `live_runs` (`warn` when runs travel as index entries only). Tools, vault and
quote are the host's to judge. It writes only temporary files.

`importPack` judges the pack and extracts it to a directory beside `dir`. A pack whose file is over `maxBytes` is refused
on its size, before a byte of it is parsed; one whose manifest says it is over is refused before anything is extracted. A
`dir` that is absent or empty becomes a new home: the extracted directory is renamed into place, after an empty `dir` is
removed with `rmdir`. The target is never deleted recursively: whatever another process has put there since the check
makes the import refuse (`exists` for a home, `invalid` otherwise) and leaves it as it is. A `dir` that is already a home needs `replace`, must hold the same agent, and must
have no live run (`check`, with `live_runs` failed); `ifRevision` must still be its `homeRevision` (`stale`).

A home is changed in place, under its own owner lock: the lock, `agent.sqlite`, `chrome/`, `repo/`, the home's
sign-ins, aliases and bindings, and its runs the pack does not have stay where they are. One store commit replaces the
definition, the skills, the source and the pack's runs, so `homeRevision` only goes up (an import that changes nothing
leaves it as it is). A run id in both takes the pack's entry and directory. A run that was live at the source arrives
as an ended entry with outcome `not_carried_back`.

The pack's run directories move into place before the commit, each old one set aside first in the staging directory
beside the home, in the order of a journal, `.import-journal` (mode 0600), written first. A failure puts every one back.
The journal has three phases, `moving`, then `committed` or `rolled-back`, and a settled one is written (beside the
journal, synced, renamed over it, the directory synced) before any evidence is removed. As soon as the store's commit
returns, the import writes `committed`; recovery writes `rolled-back` after every run directory is back, and `committed`
for a journal that was still `moving` when the store's head had moved. A crash leaves the journal for the next process
that takes the home's lock, which settles it before anything else. A `committed` or `rolled-back` journal is never
judged again: only what is left of its evidence is removed, the staging directory first and the journal last, so
recovery can be stopped at any point and run any number of times. Only a `moving` journal is judged, once: a store head
past the journal's means the commit landed (a commit that changes nothing in the store does not move it, which is why the
import writes `committed` itself, at once, and does not leave that to the head); otherwise every directory goes back. Recovery never deletes a run directory it cannot account for: when one it would
restore, or one that should have arrived, is in neither of its places, it changes and removes nothing, keeps the journal
and the staging directory, and says so; the import that failed does not remove them either. So a home is the old one or
the new one, never a mix, and no old directory is deleted before the commit. Every refusal leaves the home, and the
directory beside it, as they were.

```js
import { importPack, packHome, readPack } from "@parcha/pi-durable-agent";

const { manifest } = await packHome(home, { out: "acme.tar", maxBytes: 200 * 1024 * 1024 });
const { ok, checks } = await readPack("acme.tar");
if (ok) await importPack("acme.tar", "./acme-copy"); // a fresh directory, or { replace: true, ifRevision: await homeRevision(home) } over a home
```

## The timeline

`@parcha/pi-durable-agent/timeline` turns a run into one human-readable timeline. It has no dependency and uses no Node
built-in, so a page, a viewer and a harness can import the same code. A row has Grep's `TimelineEvent` fields
(`kind`, `summary`, `tool_name`, `tool_use_id`, `tool_status`, the previews, `text`, with Grep's caps), plus optional
`seq`, `conversation_id`, `round`, `parent_tool_use_id`, `session`, `path` and `usage`, and the kinds `user_message`, `waiting`
and `usage`.

```js
import { groupTimeline, renderText, timelineOf, timelineReducer } from "@parcha/pi-durable-agent/timeline";

// A released run: the entries of its conversation, in log order.
console.log(renderText(timelineOf(entries, { settled: true })));

// A live run: the `snapshot` event, then each batch of `watchEvents` (what pi-durable-disk serves on GET /events).
const reducer = timelineReducer();
const { rows, drop } = reducer.apply(events); // upsert rows by id, delete the drop ids, sort by seq
const groups = groupTimeline(reducer.rows()); // rounds, folds and nested calls for a page
```

Both paths read committed entries through one function, so live and replay give equal rows. A call and its result pair
by `tool_use_id`, never by time. A row is built from pi entries and events only: it never carries a live-view URL, a
browser context id or a cookie, and every summary, preview and text (a person's own message excepted) keeps a URL's
origin, path and query keys but drops its query values, fragment and userinfo. `registerLabel(tool, label)` adds the label of a host's own tool.

## Library

| Export | Does |
|---|---|
| `createAgentHome(dir, { definition, skills? })` | A new agent home. A definition with a field it does not keep (a model, for one) is refused, and nothing is created |
| `openAgentHome(dir)` | The home in `dir`, checked to be this format |
| `readAgentHome(home, { access? })` | Everything the home holds, read in one pass |
| `homeRevision(home, { access? })` | The agent store's head commit number: every write that changes the home moves it, reads do not. With the identity's id it is the home's version, an ETag |
| `setAlias(home, host, externalId)`, `setBindings(home, host, bindings)` | A host's id for the agent, and where its tools run there |
| `startRun`, `carryBack` | A run's start and end, above; `carryBack` takes `{ access? }` |
| `prepareRun`, `seedRun`, `undoPrepare`, `HomeAccess`, `localAccess` | A start as its home and run halves, and how a host reaches a home on a disk ([An agent home on a disk](#an-agent-home-on-a-disk)) |
| `refreshAgentHome(home, { sha, from?, ifRevision?, definition, skills })` | The cached definition and skills replaced by the ones at `sha` ([Following the agent's repo](#following-the-agents-repo)) |
| `runPaths(home, runId)` | A run's `dir` (what `pi-durable-disk run --dir` takes), `storePath` (`store/run.sqlite`) and `workspace` (`work/`) |
| `durableProfileStore(target, { provider?, signal? })` | pi-browser's `ProfileStore` over a run store; `target` is the host's Harness or any Session on the file |
| `EXPORTABLE_KINDS`, `SECRET_KINDS`, `projectForExport(kind, value)` | What an exporter may copy, what never leaves the home, and one document as an exporter writes it ([Exporting a home](#exporting-a-home)). Also from `@parcha/pi-durable-agent/export`, which loads no other module, so an exporter or a site build needs neither pi-durable nor pi-ai |
| `timelineOf`, `timelineReducer`, `groupTimeline`, `renderText` | The timeline above, from `@parcha/pi-durable-agent/timeline` |
| `packHome(home, { out, maxBytes?, maxMembers?, exportRunStore?, now? })` | The pack of a home, above; returns `{ manifest, skipped }`, `skipped` being `{ path, reason }` |
| `readPack(file, { maxBytes?, maxMembers? })` | `{ ok, manifest, checks }`, without writing a home |
| `importPack(file, dir, { replace?, ifRevision?, maxBytes?, maxMembers?, now? })` | The pack as the home in `dir`, in place; `ifRevision` is a `homeRevision`; returns `{ home, report }` |
| `AgentHomeError` | `code` is `invalid`, `exists`, `missing`, `busy`, `format`, `stale`, `too_large` or `check` (`checks` lists the home checks behind it) |

The package does not import pi-browser at run time: `ProfileStore` is declared here by shape. `npm run typecheck`
(after the workspace build) checks that the declaration is exactly pi-browser's type, read from the return of
pi-browser's `fileProfileStore` once `@parcha/pi-browser/providers/browserbase` exports it, and from a copy of
pi-browser's declaration until then.

## An agent home on a disk

A host can keep an agent home on a disk that one machine claims at a time (pi-durable-disk on Archil, for one). There
the home's own files live under `agent/` (`agent/agent.sqlite`, `agent/owner.lock`) and each run is `runs/<id>`, the
pi-durable-disk run directory. The package takes no dependency on the disk and holds no key: the host passes a
`HomeAccess`, `{ claim(fn), runStore(run) }`.

- `claim(fn)` runs `fn(agentDir)` while the host holds `agentDir` alone. The package also takes `owner.lock` there,
  inside the claim, and commits to `agentDir/agent.sqlite`.
- `runStore(run)` gives a local, closed copy of the released run's `run.sqlite` (`run` is `{ runId, path }`, the path
  as `agent.runs` records it). The package reads it from a copy of its own and never writes it.
- `carryBack`, `readAgentHome`, `homeRevision` and `prepareRun` take `{ access }`. Without it, the access is
  `localAccess(home)`: the home is the local directory `home.dir` with its runs under it, as above.

A start is two halves. `prepareRun(home, { host, runId?, sha?, access })` is the home's: in one commit inside the claim it
checks the sha (`stale`), takes the save leases and records the run, and returns a `RunSeed` (the profiles, a leased
one with its `ref` and every other `held`, the skill files, the root agent, the sha and the leases). It touches nothing
under `runs/`. `seedRun({ storePath, workDir }, seed)` is the run's: it writes the run's store and its skills, and can run
again on a half-written directory. `startRun` is the two in a row on this machine, under one hold of the home: a start
whose seeding fails is undone under the same hold, with no run directory, no record, and each lease it took back as it
was (another run's expired lease included). When the undo fails too, the error is an `AggregateError` with both.
`undoPrepare(home, seed, { access })` is that undo for a host's own start: the seed keeps what `prepareRun` wrote and
replaced (`seed.prior`). It acts only while that start is still the run's (its record there, unfinished, as written) and
touches only leases exactly as it set them, so an undo retried after the run id was prepared again, or after the run went
on, changes nothing and returns `{ undone: false }`.

Binding the access and the seed to pi-durable-disk looks like this (a host's code, not part of this package):

```js
import { openDurableRun, readReleased, withClaim } from "@parcha/pi-durable-disk";
import { carryBack, prepareRun, seedRun } from "@parcha/pi-durable-agent";

const access = {
  claim: (fn) => withClaim({ control, disk, region, path: "agent" }, ({ root }) => fn(root)),
  runStore: async (run) => {
    const { bytes } = await readReleased({ control, path: run.path }, "store/run.sqlite", { sqlite: true });
    const file = join(tmp, `${run.runId}.sqlite`);
    await writeFile(file, bytes);
    return file;
  },
};

const seed = await prepareRun(home, { host: "worker-1", sha, access });
const run = await openDurableRun({ disk, region, id: seed.runId }, { harness, seed: (dir) => seedRun(dir, seed) });
// (a run that will never start: await undoPrepare(home, seed, { access }) gives its leases back)
// ... the run works, then:
await run.release();
await carryBack(home, { runId: seed.runId }, { outcome: "completed", access });
```

`seed` runs inside the first claim of a new run, before its Harness opens the store; a throw fails the open with
nothing published, and the next open seeds again. A claim that fails leaves the home as it was, and the run can be
carried back later.

## Not yet

- Agent SQL: read-only queries over a whitelist of this run's and the agent's tables, and tables of the agent's own.
- A vault: credentials kept as ciphertext that only the host decrypts, used by name in tools.
- Tables whose rows commit inside pi's own commit, so a row and the turn that made it land together.
- The binding of a disk's claim and seed itself: this package takes their shape (`HomeAccess`, `seedRun`), and the
  host or pi-durable-disk supplies them. A reader of both stores for viewers in another process.

## Requirements

- Node 22.19 or later.
- `@earendil-works/pi-durable` and `@earendil-works/chord`, `>=1.1.0 <1.4.0`, as peer dependencies. The package is
  developed against 1.1.0, and CI runs its suite on 1.2.0 and 1.3.0 too.

## License

Apache-2.0
