# @parcha/pi-durable-agent

An agent home for pi agents. The home is one directory that keeps what makes an agent the same agent from one run to the
next: its definition, its skills, its saved sign-ins and every run it has made. A run starts from the home. When it ends,
the sign-ins it made go back to the home, so the agent's next run starts signed in. The home moves as that directory, or
as one file, a pack, which leaves the sign-ins behind.

Part of [AgentRun](https://github.com/Parcha-ai/agentrun). Node 22.19 or later. The agent store and each run's store are
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) stores, read and written with pi's own Session, so
there is no second format. This package opens its own at `synchronous = FULL`.

## What it does

- **Keeps the agent.** `agent.sqlite` holds the definition (name, instructions, and the names of its skills and tools),
  the skill files with their SHA-256, the saved sign-ins and an index of the runs.
- **Starts a run from the home.** `startRun` makes the run's directory, a
  [pi-durable-disk](https://github.com/Parcha-ai/agentrun/blob/main/packages/pi-durable-disk/README.md) run directory,
  with the agent's skills in its workspace and its saved sign-ins in its store. The host opens its own pi-durable
  Harness on that store.
- **Takes the run back.** `carryBack` copies the sign-ins the run made into the home and records how the run ended, so
  the next run starts signed in.
- **Moves the home.** `packHome` writes the home as one tar file, `readPack` judges one, and `importPack` writes one as a
  home. A pack and an export leave the saved sign-ins behind, so a new machine asks once.
- **Reads a run as a timeline.** `@parcha/pi-durable-agent/timeline` turns a run's entries or live events into plain rows
  that a page can draw.
- **Shows a home or a store.** `npx @parcha/pi-durable-agent serve <dir>` opens a local page over a home's files, read-only
  ([Looking at a home](#looking-at-a-home)), or over an agent store's agents, revisions and runs
  ([Looking at a store](#looking-at-a-store)).

It does not run the agent. The host keeps what a run needs from outside: the model, the thinking level, the tools, and
where each tool runs. The definition names tools; the host binds them. It does not drive a browser either:
[pi-browser](https://github.com/Parcha-ai/agentrun/blob/main/packages/pi-browser/README.md) does, through the
`ProfileStore` this package gives it.

## Install

```sh
npm install @parcha/pi-durable-agent@beta @earendil-works/pi-durable@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/chord@1.3.0
```

The package needs Node 22.19 or later, and `@earendil-works/pi-durable` and `@earendil-works/chord` as peers
([Requirements](#requirements)); `@earendil-works/pi-ai` gives the host's Harness its models. The pi packages are pinned
to 1.3.0, the newest its peer range takes. pi 1.4 is not supported yet; a later release widens the range. It does not
need a browser, a key or a network.

To try a version that is not on npm yet, `npm pack -w @parcha/pi-durable-agent` in a built checkout writes
`parcha-pi-durable-agent-<version>.tgz`: install that file's path in place of `@parcha/pi-durable-agent@beta`.

## Quickstart (no key, no network)

Two runs of one agent on this machine. The first signs in, using a stand-in for the provider, and the second finds that
sign-in already saved. The reference it prints, `ctx_1`, is a stand-in; a real one is secret.

In an empty directory, install the package and the pi packages it runs with (pinned to 1.3.0: pi 1.4 is not supported yet;
a later release widens the range), save this as `quickstart.mjs`, and run
`node --no-warnings=ExperimentalWarning quickstart.mjs` (Node's SQLite is marked experimental and says so):

```sh
npm install @parcha/pi-durable-agent@beta @earendil-works/pi-durable@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/chord@1.3.0
```

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

```text
run-1: signing in
run-1: profile ctx_1, save lease: false
run-1: carried back acme.example
run-2: profile ctx_1, save lease: true
run-2: carried back acme.example
{
  'acme.example': { provider: 'browserbase', ref: 'ctx_1', state: 'ready' }
}
```

Run 1 signs in once. It starts with no save lease, because the agent has no sign-in to lease yet; a new sign-in goes to
the first run that carries it back. Run 2 starts with the lease, finds the sign-in ready and never makes one.

## A runnable example

[`examples/web`](https://github.com/Parcha-ai/agentrun/tree/main/examples/web) is a small web server over an agent home:
a job history, each run's timeline, its files and its live browser. Its agent asks the person to sign in to a site
through the live view, and its next run starts signed in. A run needs a browser and a model endpoint. With neither,
the quickstart above is the keyless path.
[Its README](https://github.com/Parcha-ai/agentrun/tree/main/examples/web#run-it) says which browsers it takes and how
to run it from a checkout.

## A saved sign-in

A sign-in is kept as the provider's reference to a signed-in browser: a Browserbase context id, or, for a local Chrome,
the profile directory under `chrome/` in the home, which holds its cookies (the runs app does this). It sits in a
`browser.profiles` document in `agent.sqlite`, and in the store of each run that was given it. It is not encrypted. Treat
it like a password, because whoever holds it can open the signed-in session.

- **A run gets it from the host.** `startRun` copies the agent's sign-ins into the run's store, and
  `durableProfileStore` hands the reference to pi-browser. The model never sees it, and no tool reads or returns it.
  A sign-in another live run holds is copied without its reference.
- **One run saves it.** Only the run that holds a sign-in's save lease gets its reference, and only that run's changes
  go back ([The save lease](#a-run)).
- **A pack and an export leave it behind.** `SECRET_KINDS` names the kinds that never leave a home: `browser.profiles`
  among them. A pack's manifest lists the sign-ins the source had (their keys and providers), and `readPack` warns that
  they are to redo at the target. The first run on the new machine signs in again, and its carry back saves the new
  sign-in.
- **A copy of the directory takes it along.** Copy the home as a directory only to a place you would trust with its
  sign-ins. A pack is the way to move a home without them.

A signed-in browser session can also be kept in the session vault, as ciphertext that only the host's key opens, and it
never travels with a home ([Saved browser sessions](#saved-browser-sessions-the-vault)). Saved credentials, such as
passwords, are not built yet ([Not yet](#not-yet)).

## The agent home

```
acme/                        the agent home
  agent.sqlite               the agent store: identity, definition, skills, sign-ins, the runs index
  owner.lock                 the writer lock (below); never open, copy or move it with the home
  chrome/<key>/              a local Chrome's profile, made by a host such as the runs app, not by this package;
                             it holds a sign-in too, and a pack never reads it
  runs/<run id>/             a pi-durable-disk run directory
    store/run.sqlite         that run's pi-durable store; the host opens its Harness on it
    work/                    that run's files, with the agent's skills under .agents/skills/
    run.json, owner.lock,    written by pi-durable-disk when it runs the run (and commands/ on a local
    tmp/                     directory); carryBack reads only the store
```

`runPaths(home, runId)` gives a run's `dir`, `storePath` and `workspace`. To run it under pi-durable-disk, start it with
`startRun` first, then `pi-durable-disk run --dir <dir> --app MODULE` (the run id defaults to the directory's name), or
`openDurableRun(ref, { ...localRun(dir), harness })` from code, and call `carryBack` after the instance released it.

Every call on a home but `homeRevision` opens `agent.sqlite` as its only writer and closes it before it returns, so an
`AgentHome` handle holds nothing open. Writers queue in the process, then take `owner.lock`: an exclusive SQLite lock on
an empty file, which the kernel drops when its holder dies, so a writer that crashed never leaves it behind. A writer
waits up to 5 seconds for another process's, then fails with `AgentHomeError` (`busy`). On a disk that one machine claims
at a time, the host passes the claim as a `HomeAccess` and the lock is taken inside it
([An agent home on a disk](#an-agent-home-on-a-disk)).

## A run

1. `startRun(home, { host, runId?, prompt?, now?, leaseMs? })` creates `runs/<runId>/` (the id defaults to a UUIDv7), writes the
   skills into the workspace (each checked against its SHA-256), takes the save lease for each profile no live run
   holds, copies the agent's `browser.profiles` into the run store, and records the run in `agent.runs`. A profile
   another run holds the lease for is copied without its `ref` (`state: "held"`, `heldBy` naming that run). It returns
   `{ runId, dir, storePath, workspace, agent: { instructions, tools }, leases }`, where `leases` lists the profiles
   this run can write to. Seeding is this host step; nothing here is a tool, and the model never sees a sign-in.
   `prompt` is the [prompt variant](#prompt-variants) the host chose for the run, `{ id, reason, confidence? }`, recorded on
   its entry; an id that is not one of the agent's variants is refused, and so is a `confidence` that is not a number from 0 to 1.
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

## Prompt variants

An agent can keep prompt variants in its home: one `base`, one `generic`, `overlay`s, and at most one `question`. Each
overlay's `when` is the rule for picking it: the question's id, the option the overlay needs, and the least probability
for that option. The question's `text` is a Jev choice question, and its `criteria` describe options by name; every
question also has the option `other`, for an input no overlay fits.

`choosePrompt(prompts, input, { judge, lookup?, signal? })` picks one before a run starts. `judge` is a Jev runner
(`createJevRunner` from `@parcha/agentrun-jev`), or any function of that shape; this package imports no Jev. The judge
answers the question about `{ input }`, with the overlays' options and `other` as the choices. The overlay whose
option's probability is at least its threshold is chosen, the highest such probability winning. When none is and
`lookup` is given, the lookup runs once on the input's words, and the judge answers again about `{ input, lookup }`
(its text cut to `LOOKUP_TEXT_MAX`, 3,000 characters) by the same rule. Otherwise the run gets the generic. A judge or
lookup failure never throws: the run gets the generic, and `reason` says why. An answer whose choice is not one of the
options, that gives a probability for another option, or whose probability or confidence is not a number from 0 to 1
is a judge failure; the probabilities' sum is Jev's to check. An error's message is cut to 500 characters, so `reason`
stays within the 2,000 `startRun` takes.

```js
await setPrompts(home, [
  { id: "base", role: "base", label: "Company research", text: "Research the company in the input. Cite every claim." },
  { id: "kind", role: "question", label: "Kind of organization", text: "What kind of organization is this?",
    criteria: { public_company: "Its shares trade on a public exchange." } },
  { id: "public", role: "overlay", label: "Public company", text: "Start from its latest annual report.",
    when: { question: "kind", option: "public_company", threshold: 0.9 } },
  { id: "generic", role: "generic", label: "Not sure", text: "Say what kind of organization it seems to be, and why." },
]);
const { prompts } = await readAgentHome(home); // keyed by id
const choice = await choosePrompt(prompts, "Caterpillar Inc.", { judge, lookup });
// { variant: "public", instructions: base + "\n\n" + overlay, passes, lookup: { used, chars, sources }, reason }
await startRun(home, { host: "laptop", prompt: { id: choice.variant, reason: choice.reason } });
```

`instructions` is the base's text, a blank line, and the chosen variant's text: what the host gives the run's root
conversation. `passes` holds each answer (`choice`, `probabilities`, `confidence`, `model`, `cost_usd`, `latency_ms`).
`lookup` says whether one ran, how many characters the judge read and the sources it named, never the text. `lookup`
is `(query, { input, signal }) => text | { text, sources? } | null`, `query` being the input's words.

`setPrompts` replaces the whole set in one commit and refuses one that is not exactly one base and one generic, with
ids that are one URL segment and given once, a label of at most 200 characters, a text of at most 64 KiB, a threshold
from 0 to 1, and rules that name the set's question and an option no other overlay needs, never `other` (`invalid`);
`ifRevision` makes it a compare-and-swap on `homeRevision` (`stale`). `choosePrompt` refuses the same sets. Prompts are
exported and packed with the agent; they are not secrets.

## Saved browser sessions: the vault

A browser session the person signed in to can be kept for the agent's next run, as ciphertext only.
`sessionVault(home, { hostKey })` is the session vault a browser host uses (`SessionVaultPort`): `capture` at release,
`restore` at the next create, before the driver attaches, and `forget`. A session is a local Chrome's cookies and
localStorage (`kind: "cdp"`), or a provider's context id (`kind: "provider-context"`, Browserbase or Kernel, which keep
the state on their side).

```js
const vault = sessionVault(home, { hostKey: localHostKey("laptop-1", keyBytes) });
await vault.capture({ sessionKey: "acme", origins: ["https://app.acme.example"], state }); // at release
const saved = await vault.restore({ sessionKey: "acme", origins: ["https://app.acme.example"] }); // at create, or null
```

- **Ciphertext, under keys the home never holds in clear.** Each session is AES-256-GCM in `agent.vault` under its own
  item key. The item keys are wrapped by the home's vault key, and that key by the host's key (`HostKey`: `{ id, wrap,
  unwrap }`, a KMS key, an OS keychain item or a 1Password item; `localHostKey(id, bytes)` is one held in this process).
  The wrapped keys are in `vault.keys`, owner-only, beside `agent.sqlite`, and not in the store: a pi-durable store keeps
  every revision of a document, so a key kept there could never be destroyed. Each ciphertext is bound to its agent,
  session and kind, so it cannot be moved to another row. It also holds the session's origins and capture time, and a
  restore goes by those: a row whose clear `origins` or `capturedAt` differ from them was changed, and is refused
  (`format`).
- **One host key.** The first capture binds the vault to `hostKey.id`; another key, or the same id with other bytes,
  is refused (`AgentHomeError` `key`). A copy of the home opens on another machine with the same host key.
- **Revoke destroys the key.** `forget(sessionKey)` removes the session and its item key, so the session's earlier
  revisions, which the store keeps, can never be read. A capture mints a new item key and destroys the one before.
  `forgetAll()` destroys every key and the vault key itself.
- **What comes back.** A capture keeps only the cookies and localStorage of the origins it names. A restore returns
  what was captured for the origins asked for, never more. A cookie counts for an origin the browser would send it to:
  a host-only cookie (no leading dot in its domain) for its own host only, a domain cookie for its host and every host
  under it. A provider context cannot be cut down to fewer origins, so it comes back only to a restore that names every
  origin it was captured for; a restore for some of them gets `null`. A context's own `origins`, when the browser host
  records them, must lie within the capture's (a capture that records another is refused, `invalid`), are sealed with
  it, and are given back as they came; a restore must name them too. A persistent cookie keeps its own expiry; a session
  cookie comes back for at most 24 hours after its capture (`maxSessionCookieAgeMs` lowers it; it cannot go higher). A
  capture is dated by its state's `capturedAt` (a time still to come counts as now), and one older than the session
  already kept is ignored, so a late capture never replaces a newer one. With `runId`, a capture is refused (`busy`)
  while another live run holds that session's save lease.
- **Never anywhere else.** `agent.vault` is on `SECRET_KINDS`: never exported, packed or seeded into a run; a pack's
  manifest names the sessions (`vault`), never a value, and `vault.keys` never travels. No value is in an error or a
  log. `handedOut()` lists every value `restore` returned, for a redactor such as pi-browser's `redact.values`.

On a disk, `access` (a `HomeAccess`) claims the directory that holds `agent.sqlite`, and `vault.keys` is read and written
there, inside the claim.

## Stored kinds

Every document is session-scoped, version 1, in the store named. Times are ISO 8601 strings in UTC. The kinds and their
fields are the stored format.

| Kind | Store | Key | Value |
|---|---|---|---|
| `agent.identity` | agent | | `{ id, name, formatVersion }`. `id` is the definition's `id`, or a UUIDv7 minted at creation; never a host's id. A given id is one URL segment, `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `agent.source` | agent | | `{ sha, refreshedAt }`: the repo commit the definition and skills were read from, written in their commit; absent for a home not tied to a repo |
| `agent.definition` | agent | | `{ id, version, name, description?, instructions, skills, tools, input_schema?, output_schema?, workflow?, max_cost_usd? }`. `skills` and `tools` are names; `workflow` is an AgentRun workflow document. No model, no thinking level |
| `agent.skills` | agent | path under `.agents/skills/` | `{ content, sha256 }` |
| `agent.prompts` | agent | id | `{ role, label, text, when?, criteria? }`: `role` is `base`, `overlay`, `generic` or `question`, one base, one generic and at most one question per set; `when` (an overlay's only) is `{ question, option, threshold }`, the question's id, the option the variant needs and its least probability, 0 to 1; `criteria` (a question's only) describes options by name |
| `agent.aliases` | agent | host | `{ externalId }`: the agent's id in that host |
| `agent.bindings` | agent | host | `{ [tool]: target }`: where each tool runs in that host |
| `agent.runs` | agent | run id | `{ path, host, startedAt, sha?, prompt?, endedAt?, outcome?, finalAnswer?, cost? }`; `path` is relative to the home; `sha` is the home's `agent.source` when the run started; `prompt` is `{ id, reason, confidence? }`, the variant the host chose and how sure the choice was (0 to 1) |
| `agent.leases` | agent | profile key | `{ runId, expiresAt }` |
| `agent.vault` | agent | session key (1 to 128 of letters, digits, `_`, `.`, `:` and `-`, starting with a letter or digit, as pi-browser takes it) | `{ kind, origins, capturedAt, provider?, keyId, iv, ciphertext, alg, v }`: a saved browser session as AES-256-GCM ciphertext; `keyId` names its item key in `vault.keys`, beside the store ([the vault](#saved-browser-sessions-the-vault)) |
| `browser.profiles` | agent and run | profile key | `{ provider, ref, state, startUrl?, allowedOrigins?, verifiedAt?, heldBy? }`; `ref` is the provider's saved sign-in (a Browserbase context id, or a local Chrome's profile directory), `state` is `ready` once it names one, or `held` in a run store whose run has no lease on it (`ref` empty, `heldBy` the run that has) |

A profile's `ref` opens a signed-in session, so it is as secret as the password behind it: it reaches a run only
through the host, and no tool reads or returns a profile.

## Exporting a home

An exporter (a copy of a home for a viewer, or for someone else to run) copies only the kinds on `EXPORTABLE_KINDS`:
`agent.identity`, `agent.definition`, `agent.source`, `agent.skills`, `agent.prompts` and `agent.runs`. Every other kind is dropped, a kind this release
does not know included. `SECRET_KINDS` names what never leaves the home: `browser.profiles` (saved sign-ins), `agent.vault` (saved sessions),
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

A home moves as its directory or as a pack. Copying the directory takes everything with it, the saved sign-ins
included ([A saved sign-in](#a-saved-sign-in)). A pack takes the agent, the index of its runs and each finished run's
files, and a finished run's store only through the `exportRunStore` hook you give it. It leaves the sign-ins behind, and
it can be made while a run is live: that run travels as an index entry only.

One packer moves a home between a local server and a hosted one. `packHome(home, { out })` writes the pack,
`readPack(file)` judges one without writing a home, and `importPack(file, dir)` writes one as a home.

A pack is a tar (POSIX ustar, with pax headers for a name over 100 bytes or beyond ASCII), and it holds these members
and nothing else, in this order, sorted, owned by 0/0, mode 0644 or 0755, stamped with the manifest's `created_at`:

| Member | Holds |
|---|---|
| `manifest.json` | `format` `agentrun.home/1`, `agent_id`, `definition`, `source` (`sha`, `refreshed_at`, or `null`), `skills` (`path`, `sha256`, `size_bytes`), `sign_ins` (`key`, `provider`: what the source had, none travels), `vault` (`name`s: the saved sessions' keys, never a value; none travels), `runs` (`count`, `live`), `size_bytes` (the pack's own), `created_at` |
| `agent.sqlite` | A new agent store with only `EXPORTABLE_KINDS`, each through `projectForExport`, then `VACUUM INTO` one clean file: no `-wal`, no `-shm`, no free page with an old row. Nothing is copied from the live file |
| `runs/<id>/store/run.sqlite` | Only through `exportRunStore(storePath, outPath)`; without it no run store travels |
| `runs/<id>/work/...` | Regular files and directories whose names do not start with `.`. Whatever the reader would refuse is left out and listed in `skipped` with its reason: a link, a hard link, a device, a dotfile, a `*.sqlite-wal` side file, a text file named `*.sqlite` |

A run that was still live (no `endedAt`) travels as its `agent.runs` entry only: neither its store nor its work. The
home's `vault.keys`, `chrome/`, `repo/`, `owner.lock`, `tmp/` and everything else are never read. The packer refuses (`check`) a
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
pax header, at most one pax header of at most 64 fields before a member, nothing after the end, and prompts that are none
or a set `setPrompts` takes, so an import never leaves a home whose `choosePrompt` refuses its set), `definition` (the
definition is valid and is the one in `agent.sqlite`, the agent id is the same everywhere, each skill matches its
`sha256` and size), `sign_ins` (`warn` when the source had sign-ins: they are to redo at the target), `size` (the pack is
the size its manifest says, and within `maxBytes`) and `live_runs` (`warn` when runs travel as index entries only).
Tools, vault and quote are the host's to judge. It writes only temporary files.

`importPack` judges the pack and extracts it to a directory beside `dir`. A pack whose file is over `maxBytes` is refused
on its size, before a byte of it is parsed; one whose manifest says it is over is refused before anything is extracted. A
`dir` that is absent or empty becomes a new home: the extracted directory is renamed into place, after an empty `dir` is
removed with `rmdir`. The target is never deleted recursively: whatever another process has put there since the check
makes the import refuse (`exists` for a home, `invalid` otherwise) and leaves it as it is. A `dir` that is already a home needs `replace`, must hold the same agent, and must
have no live run (`check`, with `live_runs` failed); `ifRevision` must still be its `homeRevision` (`stale`).

A home is changed in place, under its own owner lock: the lock, `agent.sqlite`, `chrome/`, `repo/`, the home's
sign-ins, aliases and bindings, and its runs the pack does not have stay where they are. One store commit replaces the
definition, the skills, the prompts, the source and the pack's runs, so `homeRevision` only goes up (an import that
changes nothing leaves it as it is). A prompt variant the pack does not have is removed, and so is the whole set when
the pack carries none. A run id in both takes the pack's entry and directory. A run that was live at the source arrives
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
import { homeRevision, importPack, openAgentHome, packHome, readPack } from "@parcha/pi-durable-agent";

const home = await openAgentHome("./acme"); // the quickstart's home
const { manifest } = await packHome(home, { out: "acme.tar", maxBytes: 200 * 1024 * 1024 });
const { ok, checks } = await readPack("acme.tar");
console.log(manifest.format, ok, checks.map((check) => `${check.name} ${check.status}`).join(", "));
if (ok) await importPack("acme.tar", "./acme-copy"); // a fresh directory, or { replace: true, ifRevision: await homeRevision(home) } over a home
```

## The timeline

`@parcha/pi-durable-agent/timeline` turns a run into one human-readable timeline. It has no dependency and uses no Node
built-in, so a page, a viewer and a harness can import the same code. A row has Grep's `TimelineEvent` fields
(`kind`, `summary`, `tool_name`, `tool_use_id`, `tool_status`, the previews, `text`, with Grep's caps), plus optional
`seq`, `conversation_id`, `round`, `parent_tool_use_id`, `session`, `path` and `usage`, and the kinds `user_message`, `waiting`
and `usage`.

```js
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { groupTimeline, renderText, timelineOf, timelineReducer } from "@parcha/pi-durable-agent/timeline";

// A released run: the entries of its root conversation, in log order (here the quickstart's run-1).
const harness = await Harness.open(await SqliteStorage.open(await openNodeSqliteDatabase("./acme/runs/run-1/store/run.sqlite")), { models: createModels(), registry: createRegistry() }, ctx);
const { items: entries } = await (await harness.root(ctx)).entries({}, 1000, undefined, ctx);
console.log(renderText(timelineOf(entries, { settled: true })));
await harness.close(ctx);

// A live run: `events` are the `snapshot` event, then each batch of `watchEvents` (what pi-durable-disk serves on GET /events).
const reducer = timelineReducer();
const { rows, drop } = reducer.apply(events); // upsert rows by id, delete the drop ids, sort by seq
const groups = groupTimeline(reducer.rows()); // rounds, folds and nested calls for a page
```

Both paths read committed entries through one function, so live and replay give equal rows. A call and its result pair
by `tool_use_id`, never by time. A row is built from pi entries and events only: it never carries a live-view URL, a
browser context id or a cookie, and every summary, preview and text (a person's own message excepted) keeps a URL's
origin, path and query keys but drops its query values, fragment and userinfo. `registerLabel(tool, label)` adds the label of a host's own tool.

## Looking at a home

`pi-durable-agent serve <dir>` serves a page about the agent home in `<dir>` and prints its address. It opens nothing
itself, and it writes nothing to the home.

```sh
npx @parcha/pi-durable-agent serve ./agent-home
# http://127.0.0.1:41297/
```

`--port <n>` takes a port (the default is a free one). From code, `serveHome(home, { port?, signal? })` from
`@parcha/pi-durable-agent/serve` does the same and returns `{ url, close() }`.

The page shows the agent (its identity, definition, the repo commit it came from, its skills' names and sizes, and its
prompt variants), its runs (newest first, with the variant each loaded, why, and how sure the choice was), and each
run's timeline. A live run is polled. The files are read directly, with no lock, so a home can be watched while a run
writes it. Reads open the stores read-only; SQLite may create its shared-memory side files beside them. The agent store
is copied by SQLite's backup (a consistent snapshot) into a private temporary directory, read there with the package's
own reader, and the directory is removed; a run's store is read for its entries with one query. A store from a newer
pi-durable than this package reads (a schema version other than 1) is refused, not guessed at.

It sends only what an exporter may copy (`EXPORTABLE_KINDS`: identity, definition, source, skills, prompts and the runs
index without each run's `host`), so a saved sign-in, saved session, lease, binding or alias is never in an answer. It
sends no skill's text and no run's final answer. It listens on `127.0.0.1` only, and there is
no option to change that; it answers `421` to a request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, and
`405` to anything but `GET` and `HEAD`; it sends no CORS header, and the page's content security policy allows only its
own files. The data is JSON:

| Request | Answer |
|---|---|
| `GET /api/agent` | `{ identity, definition, source, skills: [{ path, sha256, size }], prompts, counts: { skills, prompts, questions, runs, live } }`; `prompts` are the variants and the question row, with their `id`, `role`, `label`, `text`, `when` and `criteria`, and `counts.prompts` counts the variants only |
| `GET /api/runs` | `[{ id, startedAt, endedAt?, outcome?, cost?, prompt?: { id, reason, confidence? }, live }]`, newest first; `live` is a run with no `endedAt` |
| `GET /api/runs/:id` | `{ run, rows }`: the run as above, and its entries as the [timeline](#the-timeline)'s rows (`settled` for a finished run, so a call with no result reads as interrupted, and open for a live one). `400` for an id that is not letters, digits, `.`, `_` or `-`, `404` for a run the index does not list |

An unreadable store is a `500` with `{ error }` that says what is wrong with it and not where it is.

## Agents in a folder: the agent store

One folder holds many agents. An agent has revisions, written once and never edited; a run says which revision it ran. **Copy the
FOLDER** (never `store.sqlite` alone: a writer killed mid-write leaves a journal beside it) and every agent, revision and run comes
with it. The agents are rows in `store.sqlite`, not one home each; the beta.24 home API above is unchanged, and `store.importHome(dir)`
turns a home into an agent.

```
my-agents/store.sqlite       agents, revisions, skills, runs, archive_changes
my-agents/runs/<run id>/     each run's own store and work directory
```

```sql
CREATE TABLE agents    (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, current_revision TEXT REFERENCES revisions(id));
CREATE TABLE revisions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), parent_id TEXT REFERENCES revisions(id),
                        kind TEXT NOT NULL CHECK (kind IN ('agentic', 'workflow')), body_json TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE skills    (sha256 TEXT PRIMARY KEY, content TEXT NOT NULL);
CREATE TABLE runs      (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), revision_id TEXT NOT NULL REFERENCES revisions(id),
                        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'stopped', 'escalated')),
                        started_at TEXT NOT NULL, ended_at TEXT, cost_usd REAL, summary TEXT);
CREATE TABLE archive_changes (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('agent', 'run')), id TEXT NOT NULL,
                        archived INTEGER NOT NULL CHECK (archived IN (0, 1)), at TEXT NOT NULL);
```

```js
const store = openStore("my-agents");
const agent = store.createAgent({ name: "Company researcher" });
await store.commitRevision(agent.id, { kind: "agentic", instructions: "Research the company." });                        // A
await store.commitRevision(agent.id, { kind: "agentic", instructions: "Research the company; cite sources." });         // B
await store.commitRevision(agent.id, { kind: "workflow", workflow }, { setCurrent: true });                              // C: the DSL's JSON
const run = await store.startRun({ agent: agent.id });                  // pinned to the current revision; { revision } picks another
store.carryBack(run.runId, { state: "completed", costUsd: 0.12, summary: "A housing charity" });
```

A revision's id is the SHA-256 of the canonical JSON of `{ agent, parent, kind, body }`; the database refuses an `UPDATE` of one. Every
run of every revision is one join:

```sql
SELECT runs.id, agents.name, revisions.id AS revision, revisions.kind, runs.state, runs.started_at, runs.cost_usd, runs.summary
FROM runs JOIN revisions ON revisions.id = runs.revision_id JOIN agents ON agents.id = runs.agent_id ORDER BY runs.started_at DESC;
```

An agent or a run is archived, never deleted: `store.setArchived("agent" | "run", id, archived)` appends one row to
`archive_changes` when its state changes (none when it does not) and returns when it was archived, or null. The rows are written
once, like revisions: the database refuses an `UPDATE` or a `DELETE`. An item's state is its newest row; the reads carry
`archivedAt` while it is archived, and a run's is its own, else its agent's. The table came without a new store version: a store an
earlier version wrote opens and reads with nothing archived, gets the table from the first `openStore`, and an earlier version still
opens a store that has it and ignores it.

A workflow revision whose call nodes name a tool that is not a `tool` call passes the commit check on purpose: whether it runs is the host's to decide. `openStoreReader(folder)` reads `store.sqlite` in place, read-only: it writes nothing and makes no copy. On a store a run was stopped in the middle of writing, it says so in one line and changes no file; open the store once with write access to roll the write back.

## Looking at a store

```sh
npx @parcha/pi-durable-agent serve ./my-agents
# http://127.0.0.1:41297/
```

On a folder holding a `store.sqlite`, the same command serves the store's page: its agents (archived ones behind Show
archived, and marked archived wherever they show); each agent's revisions, newest first, an agentic one's prompt diffed
line by line against its parent's and a workflow's graph with what changed; its runs across revisions, filtered by
revision; and each run, an agentic run's timeline or a workflow run's path lit on its graph. It reads `store.sqlite` and the runs' own stores in place, read-only, and never copies them. A run that
has ended is read as an immutable file, so serving adds no file beside it or to `store.sqlite`; a running run's store
is read the way SQLite reads a live file. From code, `serveStore({ dir }, { port?, signal? })` from
`@parcha/pi-durable-agent/serve` does the same.

## A workflow revision

A revision of an agent can be a DSL workflow instead of a prompt. Its run executes the workflow with agentrun-pi's
durable workflow task on the run's own store, not the agent loop. `@parcha/pi-durable-agent/workflow` holds the three
steps; the root never imports it, and only these functions load `@parcha/agentrun-dsl` and `@parcha/agentrun-pi`.

1. Before a store commits a workflow revision, `checkWorkflowBody(body)` checks it: the DSL's structural validation,
   what the durable runner refuses before any step, and that `tools` lists every tool a call node uses.
2. To run it, open a Harness on the run's `storePath` with agentrun-pi's `createWorkflowExtension` installed (it holds
   your tools), and call `runWorkflowRevision({ harness, workflows, context, run, input, tools })`. It returns the DSL's
   `outcome` and a `carry`, `{ state, summary }`, for the store's `carryBack`. Inside a `pi-durable-disk run`, whose
   process holds the store file until it exits, call `startWorkflowRevision` (the same options) in the app, and
   `workflowCarry(run, outcome)` on the host after the run releases and its process exits.
3. `readWorkflowRun(run)` reads the run back for a page, read-only: the workflow's graph, each node's state, and, once
   the run ended, how it ended, where it escalated and its output.
4. `revisionGraph(revision, parent?)` draws a revision's graph, and what changed from a parent that is a workflow too.

## Library

Four entry points: `@parcha/pi-durable-agent` (everything below but the timeline), `@parcha/pi-durable-agent/export`
`@parcha/pi-durable-agent/timeline` and `@parcha/pi-durable-agent/serve`. A function that opens a home can also fail with the home's own errors:
`missing` (the directory is not a home), `format` (a store this version does not read) and `busy` (another writer held
the home for more than 5 seconds). `busy` applies to everything that writes the home, and to `openAgentHome` and
`readAgentHome`, which take the writer lock to read. The Throws column does not repeat these except where a function
exists to check them. [Errors](#errors) says what each code means.

### `@parcha/pi-durable-agent`

| Export | Does | Throws |
|---|---|---|
| `createAgentHome(dir, { definition, skills?, sha?, now? })` | A new agent home in `dir`: the identity (the definition's `id`, or a new UUIDv7), the definition, the skill files and, with `sha`, `agent.source`, in one commit. Returns an `AgentHome`, `{ dir, identity }` | `invalid`: a definition with a field it does not keep (a model, for one) or with a bad field, an id that is not one URL segment, a skill path that is not relative, a `sha` that is not a commit sha. `exists`: `dir` already holds a home. Nothing is created on either |
| `openAgentHome(dir)` | The home in `dir`, checked to be this format | `missing`, `format` |
| `readAgentHome(home, { access? })` | Everything the home holds, read in one pass: an `AgentHomeState` | `missing`, `format` |
| `homeRevision(home, { access? })` | The agent store's head commit number: every write that changes the home moves it, reads do not. With the identity's id it is the home's version, an ETag. One read-only query, under no lock by default | `missing` (not a home, without `access`), `format` (no readable head commit) |
| `setAlias(home, host, externalId)` | The agent's id in a host | `invalid`: an empty `host` or `externalId` |
| `setBindings(home, host, bindings)` | Where each tool name runs in a host; replaces that host's bindings | `invalid`: an empty `host`, or bindings that are not tool names to non-empty targets |
| `setPrompts(home, variants, { ifRevision?, access? })` | The agent's prompt variants replaced by `variants` (each with its `id`), in one commit; an equal set writes nothing. Returns `{ changed }` ([Prompt variants](#prompt-variants)) | `invalid`: not exactly one base and one generic, more than one question, an id that is not one URL segment or is given twice, a label, text or rule over its limits, a rule that names no question row or an option another overlay needs, or a field a row does not keep. `stale`: the home is not at `ifRevision`. Nothing is written on either |
| `choosePrompt(prompts, input, { judge, lookup?, signal? })` | The variant a run starts with, by the set's Jev choice question and at most one lookup. Returns `{ variant, instructions, passes, lookup, reason }` ([Prompt variants](#prompt-variants)) | `invalid`: a set `setPrompts` would refuse. A judge or lookup failure never throws: the run gets the generic, and `reason` says why |
| `refreshAgentHome(home, { sha, from?, ifRevision?, definition, skills, now? })` | The cached definition and skills replaced by the ones at `sha`. Returns `{ changed }` ([Following the agent's repo](#following-the-agents-repo)) | `invalid`: a bad `sha`, `from`, `ifRevision`, definition or skill, a definition `id` that is not the agent's. `stale`: the home is not at `ifRevision`, or its cache is not at `from`. Nothing is written on either |
| `startRun(home, { host, runId?, sha?, prompt?, now?, leaseMs? })` | A run's start on this machine, above; `prompt` (`{ id, reason, confidence? }`) is the variant the host chose, recorded on the run. Returns a `RunStart`: `{ runId, dir, storePath, workspace, agent, leases, sha? }` | `invalid`: an empty `host`, a bad `leaseMs`, `sha` or run id, or a `prompt` that is not `{ id, reason, confidence? }` (a `confidence` outside 0 to 1 included) or names no variant of the agent. `exists`: the run id is taken. `stale`: `sha` is not the home's. `format`: a skill does not match its SHA-256. A start that fails part way is undone; when the undo fails too the error is an `AggregateError` with both |
| `prepareRun(home, { host, runId?, sha?, prompt?, now?, leaseMs?, access? })` | A start's home half: the lease and the record, as a `RunSeed` ([An agent home on a disk](#an-agent-home-on-a-disk)) | as `startRun`, but `exists` only for a run in the index |
| `seedRun({ storePath, workDir }, seed)` | A start's run half: the run's store and its skills. Safe to run again on a half-written directory | `invalid`: a seed that gives a run the reference of a sign-in it does not lease, or a bad skill path. Nothing is written |
| `undoPrepare(home, seed, { access? })` | Undoes a `prepareRun` whose seed never landed. Returns `{ undone }`, which is `false` when that start is no longer the run's | |
| `carryBack(home, run, { outcome, finalAnswer?, cost?, now?, access? })` | A run's end, above. Returns a `CarryBack`: `{ changed, profiles, released }`. A second call for the same run changes nothing | `invalid`: an empty `outcome`, a negative or non-finite `cost`. `missing`: the run is not the agent's, or its store is not there |
| `runPaths(home, runId)` | A run's `dir` (what `pi-durable-disk run --dir` takes), `storePath` (`store/run.sqlite`) and `workspace` (`work/`) | `invalid`: a run id that is not one URL segment |
| `durableProfileStore(target, { provider?, signal? })` | pi-browser's `ProfileStore` over a run store; `target` is the host's Harness or any Session on the file. `provider` names who made a profile that had none (default `browserbase`) | `resolve` rejects with `invalid` for an empty key, or when `make` returns no reference. An error from `make` passes through |
| `localAccess(home)`, `HomeAccess` | How a call reaches a home: a directory of this machine (the default), or a disk a host claims ([An agent home on a disk](#an-agent-home-on-a-disk)) | |
| `packHome(home, { out, maxBytes?, maxMembers?, exportRunStore?, now? })` | The pack of a home, above. Returns `{ manifest, skipped }`, `skipped` being `{ path, reason }` | `invalid`: a bad `out`, `maxBytes` or `maxMembers`. `too_large`: over `maxBytes` or `maxMembers`, or a manifest over its limit. `check`: a SQLite file that holds a sign-in kind or has a side file, a work directory or file that cannot be read, a file that changed while the pack was written, or a pack its own reader refuses (`checks` says which). `format`: a skill that does not match its SHA-256. No pack is written on any of them |
| `readPack(file, { maxBytes?, maxMembers? })` | Judges a pack without writing a home: `{ ok, manifest, checks }`. A pack that fails a check comes back with `ok: false`, including a pack over `maxBytes` (the `size` check) | `missing`: no such file. `invalid`: not a file |
| `importPack(file, dir, { replace?, ifRevision?, maxBytes?, maxMembers?, now? })` | The pack as the home in `dir`, in place. `ifRevision` is a `homeRevision`. Returns `{ home, report }`, `report` being `{ ok: true, agent_id, checks, written: true, replaces }` | `missing`: no such file. `invalid`: a bad `ifRevision`, a `dir` that is not a directory, is not empty and not a home, or holds another agent. `check`: the pack is refused, or the target has a live run (`checks` says which). `exists`: `dir` is a home and `replace` is not set. `stale`: `ifRevision` is not the home's. `format`: an import journal that cannot be settled. Every refusal before the import starts leaves the home as it was; a `format` from an unsettled journal keeps the journal and its staging directory for a person to read ([Moving a home](#moving-a-home)) |
| `AGENT_STORE_FILE`, `RUN_STORE_FILE`, `LOCK_FILE` | The file names: `agent.sqlite`, `run.sqlite` and `owner.lock` | |
| `PACK_FORMAT` | The pack's format name, `agentrun.home/1` | |
| `LOOKUP_TEXT_MAX` | The most characters of a lookup's text `choosePrompt`'s second pass carries: 3,000 | |
| `sessionVault(home, { hostKey, maxSessionCookieAgeMs?, runId?, access?, now? })` | The session vault: `capture`, `restore`, `forget`, `forgetAll`, `list` and `handedOut` ([Saved browser sessions](#saved-browser-sessions-the-vault)) | `invalid`: a host key that is not `{ id, wrap, unwrap }`, a cap that is not above 0 and at most 24 hours, an empty `runId`; its calls: a bad session key, origin, captured state or `capturedAt`. `key`: a host key that does not open the vault. `busy`: with `runId`, another live run holds the session's save lease. `format`: a key file or a saved session that does not read or decrypt, or a saved session whose row's origins or `capturedAt` were changed. A refused call writes nothing |
| `localHostKey(id, bytes)` | A `HostKey` held in this process: 32 bytes, AES-256-GCM | `invalid`: an id that is not letters, digits, `.`, `_`, `:` or `-`, or not 32 bytes |
| `VAULT_KEYS_FILE`, `MAX_SESSION_COOKIE_AGE_MS` | `vault.keys`, and 24 hours | |
| `openStore(dir, { busyTimeoutMs? })` | The agent store in `dir`, created if missing (`busyTimeoutMs`: how long a call waits synchronously for another connection to let go of the store before it throws SQLite's busy error, default 5000; opening it always waits up to 5 s): `createAgent({ name, description?, id? })`, `commitRevision(agent, revision, { setCurrent?, ifCurrent? })` (`ifCurrent`, the current revision the caller read or null, makes it a compare-and-swap), `setCurrent(agent, revision)`, `setArchived(kind, id, archived)`, `listAgents()`, `listRevisions(agent)`, `readRevision(id)`, `listRuns({ agent?, revision? })`, `startRun({ agent, revision? })`, `carryBack(runId, { state, costUsd?, summary? })`, `importHome(homeDir)`, `close()` ([above](#agents-in-a-folder-the-agent-store)) | `invalid`, `missing`, `exists`, `format`: a revision whose content does not match its id. `stale`: the agent's current revision is not `ifCurrent`, checked in the commit's own transaction; nothing is written |
| `openStoreReader(dir, { busyTimeoutMs? })` | The same reads on a read-only handle (`busyTimeoutMs` as `openStore`'s) (`store.sqlite` in place, no copy), plus `runStorePath(runId)`; it writes nothing | `missing`: no `store.sqlite` in `dir`; `busy`: a store with an unfinished write; `format`: a store a newer version wrote |
| `AgentStore`, `AgentStoreReader`, `STORE_FILE` | The two classes `openStore` and `openStoreReader` return, and `store.sqlite` | |
| `AgentHomeError` | The one error class of this package ([Errors](#errors)) | |
| `EXPORTABLE_KINDS`, `SECRET_KINDS`, `projectForExport(kind, value)` | What an exporter may copy, what never leaves the home, and one document as an exporter writes it ([Exporting a home](#exporting-a-home)). Also from `@parcha/pi-durable-agent/export` | |

The types the package exports:

- **Home.** `AgentHome` (`{ dir, identity }`), `AgentHomeState` (what `readAgentHome` returns: `identity`, `definition`,
  `source?`, `skills`, `prompts`, `aliases`, `bindings`, `runs`, `leases`, `profiles`), `AgentDefinitionInput` (a
  definition whose `id` is optional), and `HomeAccess`.
- **Stored kinds**, field for field as in [Stored kinds](#stored-kinds): `AgentIdentity`, `AgentDefinition`,
  `AgentSource`, `SkillFile`, `PromptVariant`, `PromptRule`, `AgentAlias`, `ToolBindings`, `RunRecord`, `ProfileLease`
  and `BrowserProfile`.
- **Prompts.** `PromptVariantInput` (a variant with its `id`, as `setPrompts` takes it), `RunPrompt`, and for
  `choosePrompt`: `PromptJudge`, `PromptQuestion`, `PromptLookup`, `PromptLookupSource`, `PromptPass` and `PromptChoice`.
- **Vault.** `HostKey`, `SessionVault` (the port plus `forgetAll`, `list` and `handedOut`), `SessionVaultPort`,
  `CapturedState`, `VaultCookie` and `VaultEntry`.
- **Runs.** `RunPaths`, `RunStart`, `RunSeed` (plain data, so a host can carry it to the run's side), `CarryBack`,
  `ProfileStore` and `ProfileTarget` (the host's Harness, or any Session on the run store).
- **Store.** `Agent`, `AgentRow`, `Revision`, `RevisionRow`, `RevisionKind`, `AgenticBody`, `WorkflowBody`, `NewRevision`, `StartedRun`, `RunRow`, `RunState` and `ArchiveKind` (`"agent" | "run"`).
- **Packs.** `PackOptions`, `Skipped`, `HomeManifest` (the manifest's fields, in [Moving a home](#moving-a-home)),
  `ImportOptions`, `ImportReport`, and `HomeCheck` (`{ name, status, message, detail? }`, `status` being `ok`, `warn`
  or `fail`). `ImportStep` and `ImportOptions.inject` belong to this package's tests and are not part of its contract.

### `@parcha/pi-durable-agent/export`

`EXPORTABLE_KINDS`, `SECRET_KINDS` and `projectForExport`, and nothing else. It loads no other module, so an exporter or
a site build needs neither pi-durable nor pi-ai. `projectForExport` throws nothing of its own.

### `@parcha/pi-durable-agent/timeline`

No dependency, no Node built-in, and no thrown error of its own: a page, a viewer and a harness can import it.

| Export | Does |
|---|---|
| `timelineOf(entries, options?)` | The rows of a stored conversation, in log order. The options (`TimelineOptions`) are `settled` (nothing is running: a call with no result is interrupted), `conversationId` (for entries and events that carry none), `agentLabel` (a row's `agent_label`, from its conversation id), `labels` (labels for this call only), `caps` (the cut lengths of `CAPS`), and `now`, the clock for retry and poll waits, which only live rows use |
| `timelineReducer(options?)` | Live rows, with the same options. `apply(events)` takes the `snapshot` event, then each batch from `watchEvents`, and returns `{ rows, drop }` (upsert the rows by id, delete the `drop` ids); `rows()` returns every row now, in log order |
| `groupTimeline(rows)` | Rows to groups, for a page: rounds of calls, folds and nested calls, each a `Group` |
| `foldCalls(calls)` | Adjacent calls of one tool, folded into `Fold`s. A call with inner rows keeps its own line |
| `failedCall(call)` | Whether a call's result has `tool_status` `failed` |
| `renderText(rowsOrGroups, { fold? })` | Plain text, one line per row or group; `fold: false` shows every call on its own line |
| `registerLabel(tool, label, fold?)` | The label of a host's own tool, in the past tense, for every later call; `fold` says how its calls fold into one line |
| `labelOf(tool, args, result?, extra?)` | The label of one call. An unknown tool gets `Using tool: <name>` |
| `foldLabel(tool, calls)` | One line for several calls of one tool, from their input and output previews |
| `inputPreview(args, max)` | The input worth showing, or `null`: a `description`, `command`, `query`, `file_path`, `url`, `path` or `code` argument, with a URL's query values dropped, cut to `max` |
| `CAPS` | The caps a row's `summary`, `preview`, `text` and `thinking` are cut to: 500, 500, 2000 and 100 |
| `REQUEST_STARTED`, `REQUEST_ENDED` | The entry kinds a host writes to mark a model request: as it leaves, and as it ends aborted. The usage row counts each marked request; one with no `pi.assistant` entry (cut before its first content) other than the latest still in flight makes the cost unknown. A conversation with no marks reads as before |

Its types: `TimelineEvent` (Grep's fields, plus the optional ones above) and `TimelineKind`, `TimelineOptions`,
`EntryLike` (a pi conversation entry as stored), `AgentEventLike` (a pi event), `Call`, `Fold`, `Group`, `LabelFn`,
`FoldSpec` and `ToolResultView`.

### `@parcha/pi-durable-agent/serve`

| Export | Does | Throws |
|---|---|---|
| `serveHome(home, { port?, signal? })` | Serves `home.dir` ([Looking at a home](#looking-at-a-home)) on `127.0.0.1` and resolves to `{ url, close() }` once it is listening; `close()` stops it, and so does aborting `signal`. It takes no lock and opens the home's stores read-only. `home` is anything with a `dir`, an `AgentHome` included | `missing`: the directory is not a home. `invalid`: a `port` that is not an integer from 0 to 65535 |
| `serveStore(store, { port?, signal? })` | Serves the agent store at `store.dir` ([Looking at a store](#looking-at-a-store)) as `serveHome` serves a home | `missing`: the directory has no `store.sqlite`. `invalid`: a `port` that is not an integer from 0 to 65535 |
| `storeApi(store)` | The read-only JSON behind the store's page, for a server of another package to answer its `/api/*` paths: a function of a path and its query that resolves to `{ status, value }`, opening `store.dir`'s reader for each read. A read that fails resolves to its status and `{ error }` | |
| `STORE_PAGE_FILES` | The store page's files by the path the page asks for each (`/`, `/page.css`, `/page.js`, `/graph.js`): `{ path, type }`, `path` absolute. A page that loads its own script before `page.js` can set `window.agentStoreHost(parts)`, which answers `{ name, route(hash, token), agent(agent, revisions), revision(agent, revision), run(run) }`: the page's name in the tab's title, the views it draws itself, and what it adds to an agent's card, to a revision's head and to a stored run's head | |

Its types: `ServeOptions`, `ServeHandle`, `Api` (what `storeApi` returns) and `Answer` (`{ status, value }`). The package's bin,
`pi-durable-agent serve <dir> [--port <n>]`, calls `serveStore` for a directory holding a `store.sqlite` and `serveHome`
otherwise, and prints `url`; it exits 1 for a directory that is neither and 2 for a command or port it does not know.

### `@parcha/pi-durable-agent/workflow`

It loads `@parcha/agentrun-dsl` and `@parcha/agentrun-pi` only when one of its functions runs.

| Export | Does |
|---|---|
| `checkWorkflowBody(body)` | Refuses, as `invalid`, a workflow revision's body a store must not commit, naming the node's path and never a value from the body |
| `runWorkflowRevision(options)` | Runs the revision's workflow as one durable workflow task on the run's store and waits: `{ outcome, carry }`, `startWorkflowRevision` then `workflowCarry` |
| `startWorkflowRevision(options)` | The first half: starts the run's workflow task and waits for its `outcome`, reading no file. A workflow that uses a tool the host does not register, or does not take the input, is refused with no task; the run reopened under another revision is refused (`RUN_STORE_BINDING_MISMATCH`); reopened as itself it resumes, or answers how it ended |
| `workflowCarry(run, outcome)` | The second half: `{ state, summary }` for the store's `carryBack`, read with `readWorkflowRun`. It fails while another connection holds the store file exclusively, as a `pi-durable-disk run` process does until it exits |
| `readWorkflowRun(run)` | The run as its store shows it, read-only: no write, no lock, no Harness. With `run.state` (the runs row's) ended and no write-ahead log beside the store, it opens the store as an immutable file and makes no file in the run's directory. Working means live: an ended run's interrupted nodes read `stopped`, or `failed` when the run failed. A run in the driver's keyed layout is refused as `format` |
| `revisionGraph(revision, parent?)` | The revision's graph (the DSL's `workflowGraph`), and the DSL's `graphDiff` from its parent when the parent is a workflow revision; an agentic parent, or none, gives no diff |

Its types: `WorkflowBody`, `WorkflowRunStart` (the part of a store's started run it reads), `WorkflowRunView`,
`RunState`, `RunNodeState` (the DSL's `NodeState` and `stopped`), and the DSL's `WorkflowGraph`, `GraphDiff`, `NodeState`
and `WorkflowOutcome`.

### Errors

`AgentHomeError` has a `code` and, for a `check`, the `checks` behind it (`HomeCheck[]`, the failed ones with status
`fail`). What the package refuses is an `AgentHomeError`. A failure of the file system or of SQLite passes through as it
is, and so does what a host's `make` throws through `durableProfileStore`. A start that fails and whose undo fails too
throws an `AggregateError` holding both.

| `code` | Means |
|---|---|
| `invalid` | An argument or a definition is wrong, or a target is not what the call needs |
| `exists` | A home or a run is already there |
| `missing` | A home, a run, a run's store or a pack file is not there |
| `busy` | Another writer held the home for more than 5 seconds. The lock is an exclusive SQLite lock the kernel drops when its holder dies, so a crashed writer never leaves it |
| `format` | A store or a skill this version cannot read: no identity or definition, another format version, no readable head commit, a store that does not accept `synchronous = FULL`, a skill that does not match its SHA-256, or an import journal that cannot be settled |
| `stale` | The home moved since the caller read it: `ifRevision`, `from`, or a `sha` that is not the cache's; or an agent store's agent has another current revision than a commit's `ifCurrent` |
| `too_large` | A pack over `maxBytes` or `maxMembers`, from `packHome` |
| `check` | A pack or an import failed a check: `checks` lists them all |
| `key` | A host key that does not open the session vault: another key id, or the right id with other bytes |

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
- Saved credentials in the vault (passwords, one-time-code seeds), filled by name in tools: the vault keeps browser
  sessions today. A session's IndexedDB, and a site's own logout calling `forget`.
- Tables whose rows commit inside pi's own commit, so a row and the turn that made it land together.
- The binding of a disk's claim and seed itself: this package takes their shape (`HomeAccess`, `seedRun`), and the
  host or pi-durable-disk supplies them. A reader of both stores for viewers in another process.

## Requirements

- Node 22.19 or later.
- `@earendil-works/pi-durable` and `@earendil-works/chord`, `>=1.1.0 <1.4.0`, as peer dependencies. The package is
  developed against 1.1.0, and CI runs its suite on 1.2.0 and 1.3.0 too.

## License

Apache-2.0
