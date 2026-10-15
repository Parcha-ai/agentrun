# @parcha/pi-durable-agent

An agent you can carry. Its definition, its sign-ins and its runs live in one directory, the **agent home**, as
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) stores: `agent.sqlite` for the agent, and one
`run.sqlite` per run. Copy the directory and the agent goes with it. A run starts from the agent's definition and its
saved sign-ins, and when it ends, the sign-ins it made go back to the agent, so the next run starts signed in.

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
  runs/<run id>/
    run.sqlite               that run's pi-durable store; the host opens its Harness on it
    workspace/               that run's files, with the agent's skills under .agents/skills/
```

Every call opens `agent.sqlite` as its only writer and closes it before it returns, so an `AgentHome` handle holds
nothing open. Writers queue in the process, then take `owner.lock`: an exclusive SQLite lock on an empty file, which
the kernel drops when its holder dies, so a writer that crashed never leaves it behind. A writer waits up to 5 seconds
for another process's, then fails with `AgentHomeError` (`busy`). A home lives on one machine's file system; a network
disk needs its own claim around the writer, which this release does not take.

## A run

1. `startRun(home, { host, runId?, now?, leaseMs? })` creates `runs/<runId>/` (the id defaults to a UUIDv7), writes the
   skills into the workspace (each checked against its SHA-256), copies the agent's `browser.profiles` into the run
   store, takes the save lease for each profile no live run holds, and records the run in `agent.runs`. It returns
   `{ runId, storePath, workspace, agent: { instructions, tools }, leases }`. Seeding is this host step; nothing here is
   a tool, and the model never sees a sign-in.
2. The host opens its own Harness on `storePath` and creates the root conversation with `agent.instructions`, its
   chosen model and thinking level, and its tools for the names in `agent.tools`.
3. `durableProfileStore(harness)` is pi-browser's `ProfileStore` over the run store's `browser.profiles`: `resolve(key,
   make)` returns a ready profile's `ref`, or calls `make` once (one caller at a time per key, outside any commit) and
   commits the new `ref` as `ready`. A run opens a profile it does not hold the lease for without saving to it.
4. After the host's Harness closes, `carryBack(home, run, { outcome, finalAnswer?, cost?, now? })` copies back, in one
   commit, each profile the run holds the lease for and each profile new to the agent that no live run holds, releases
   the run's leases, and completes its `agent.runs` entry. A second call for the same run changes nothing.

**The save lease.** Two runs of one agent can run at once, and neither Browserbase nor Kernel locks a saved context:
the last writer wins. So one run at a time holds a profile's save lease, and only that run's changes go back. A new
profile goes to the first run that carries it back. A lease expires after `leaseMs` (default 6 hours), so a run that
died does not hold a profile forever; a run whose lease passed to another saves nothing back.

## Stored kinds

Every document is session-scoped, version 1, in the store named. Times are ISO 8601 strings in UTC. The kinds and their
fields are the stored format.

| Kind | Store | Key | Value |
|---|---|---|---|
| `agent.identity` | agent | | `{ id, name, formatVersion }`. `id` is the definition's `id`, or a UUIDv7 minted at creation; never a host's id |
| `agent.definition` | agent | | `{ id, version, name, description?, instructions, skills, tools, input_schema?, output_schema?, workflow?, max_cost_usd? }`. `skills` and `tools` are names; `workflow` is an AgentRun workflow document. No model, no thinking level |
| `agent.skills` | agent | path under `.agents/skills/` | `{ content, sha256 }` |
| `agent.aliases` | agent | host | `{ externalId }`: the agent's id in that host |
| `agent.bindings` | agent | host | `{ [tool]: target }`: where each tool runs in that host |
| `agent.runs` | agent | run id | `{ path, host, startedAt, endedAt?, outcome?, finalAnswer?, cost? }`; `path` is relative to the home |
| `agent.leases` | agent | profile key | `{ runId, expiresAt }` |
| `browser.profiles` | agent and run | profile key | `{ provider, ref, state, startUrl?, allowedOrigins?, verifiedAt? }`; `ref` is the provider's saved sign-in, `state` is `ready` once it names one |

A profile's `ref` opens a signed-in session, so it is as secret as the password behind it: it reaches a run only
through the host, never through a tool.

## Library

| Export | Does |
|---|---|
| `createAgentHome(dir, { definition, skills? })` | A new agent home. A definition with a field it does not keep (a model, for one) is refused, and nothing is created |
| `openAgentHome(dir)` | The home in `dir`, checked to be this format |
| `readAgentHome(home)` | Everything the home holds, read in one pass |
| `setAlias(home, host, externalId)`, `setBindings(home, host, bindings)` | A host's id for the agent, and where its tools run there |
| `startRun`, `carryBack` | A run's start and end, above |
| `durableProfileStore(target, { provider?, signal? })` | pi-browser's `ProfileStore` over a run store; `target` is the host's Harness or any Session on the file |
| `AgentHomeError` | `code` is `invalid`, `exists`, `missing`, `busy` or `format` |

## Not yet

- Agent SQL: read-only queries over a whitelist of this run's and the agent's tables, and tables of the agent's own.
- A vault: credentials kept as ciphertext that only the host decrypts, used by name in tools.
- Tables whose rows commit inside pi's own commit, so a row and the turn that made it land together.
- An agent home on a network disk, and a reader of both stores for viewers in another process.

## Requirements

- Node 22.19 or later.
- `@earendil-works/pi-durable` and `@earendil-works/chord`, `>=1.1.0 <1.3.0`, as peer dependencies. The package is
  developed against 1.1.0, and CI runs its suite on 1.2.0 too.

## License

Apache-2.0
