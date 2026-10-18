# seed-a-run: what a new run starts with

`seed` writes what a new run starts with before anything can see it: its store file (a SQLite database the Harness then
opens, saved sign-in profiles for example) and files in its workspace (`work/`). It runs once, on the open that finds no
`run.json`, and never again, so what the agent changed since stays. This example seeds a table and a notes file, lets the
run change the file, opens the run a second time, and checks that the seed did not run again and the change is still there.

No disk, no key: `localRun` is a directory of this machine. It needs `@parcha/pi-durable-disk` 0.1.0-beta.15 or later (`seed`
and `readLocalRunStatus` first shipped in it), on Linux with Node 22.19 or later.

## The code

It is `main.ts`, below, and a test keeps this copy identical to the file:

```ts
// Seed a run: what a new run starts with, written before anything sees it. `seed` writes the run's store file (a SQLite
// database the Harness then opens) and files in its workspace, once, on the open that finds no run.json. The next open
// does not seed again, so what the agent changed since stays. No disk, no key: `localRun` is a directory of this machine.
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { localRun, openDurableRun, readLocalRunStatus } from "@parcha/pi-durable-disk";

const root = join(process.cwd(), "seed-a-run-run");
rmSync(root, { recursive: true, force: true });
console.log(`the run is ${root}`);

let seeded = 0;
const open = () =>
  openDurableRun(
    { disk: "local", region: "local", id: "seeded" },
    {
      ...localRun(root),
      harness: { models: createModels(), registry: createRegistry() },
      async seed({ storePath, workDir }) {
        seeded++;
        const db = new DatabaseSync(storePath);
        db.exec("CREATE TABLE IF NOT EXISTS x_profiles (name TEXT PRIMARY KEY, profile TEXT)");
        db.prepare("INSERT OR REPLACE INTO x_profiles VALUES (?, ?)").run("acme", "signed in");
        db.close(); // closed before it returns: the store opens this file next
        await writeFile(join(workDir, "NOTES.md"), "Start here: cite every claim.\n");
      },
    },
  );

const first = await open();
console.log(`generation ${first.generation} opened a new run: seeded ${seeded} time`);
await first.setStatus("paused");
await first.release();

const store = new DatabaseSync(join(root, "store", "run.sqlite"), { readOnly: true });
const profile = (store.prepare("SELECT profile FROM x_profiles WHERE name = ?").get("acme") as { profile: string } | undefined)?.profile;
store.close();
console.log(`  the store holds the seeded profile: ${profile}`);
console.log(`  the workspace holds NOTES.md: ${JSON.stringify(readFileSync(join(root, "work", "NOTES.md"), "utf8"))}`);
appendFileSync(join(root, "work", "NOTES.md"), "The agent added a line.\n"); // what a run does to its workspace

const second = await open();
console.log(`generation ${second.generation} opened the same run: seeded ${seeded} time in all`);
await second.setStatus("done");
await second.release();

const notes = readFileSync(join(root, "work", "NOTES.md"), "utf8");
const status = await readLocalRunStatus(root);
if (seeded !== 1 || profile !== "signed in" || notes !== "Start here: cite every claim.\nThe agent added a line.\n" || status?.status !== "done" || status.generation !== 2) {
  console.error(`not ok: seeded ${seeded}, profile ${profile}, notes ${JSON.stringify(notes)}, status ${JSON.stringify(status && [status.status, status.generation])}`);
  process.exit(1);
}
console.log("ok: the seed ran once, on the new run: the store and the workspace started with it, and the next open kept what the run had changed");
```

## Run it

**From an install** (an empty directory; the npm package does not ship `examples/`, so save `main.ts` from GitHub at the tag
of the version you installed):

```sh
npm init -y && npm pkg set type=module
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
# save main.ts here, then
node main.ts
```

**From a checkout:**

```sh
npm ci --ignore-scripts && npm run build   # once, from the repository root; builds dist/
cd packages/pi-durable-disk
node examples/seed-a-run/main.ts           # about a second
```

It writes `seed-a-run-run/` under the current directory and prints:

```
the run is <this directory>/seed-a-run-run
generation 1 opened a new run: seeded 1 time
  the store holds the seeded profile: signed in
  the workspace holds NOTES.md: "Start here: cite every claim.\n"
generation 2 opened the same run: seeded 1 time in all
ok: the seed ran once, on the new run: the store and the workspace started with it, and the next open kept what the run had changed
```

## How it works

- `seed({ storePath, workDir })` is an option of `openDurableRun`. It runs inside the run's first claim, with the owner lock
  held, after `store/` and `work/` exist and before `run.json` is written and the store opens. A connection it opens on
  `storePath` is closed before it returns, because the store opens that file next.
- What it wrote is durable before `run.json` publishes the run. A seed that throws fails the open and publishes nothing, so the
  next open seeds again: a seed overwrites what an earlier attempt wrote.
- It never runs for a run that has a `run.json`, whatever its generation, which is why the second open does not seed.
- The example reads the store with `node:sqlite` after the first release, the workspace with `fs`, and the run's record with
  `readLocalRunStatus`.

## What it does not show

A seed on an Archil disk is the same call with `mountToken` instead of `localRun`; a factory that runs on the claimed directory
can also give the run its seed (`afterClaim` returning `seed`). pi-durable-agent seeds a run with an agent's definition and
sign-ins this way. The [README](../../docs/reference.md#seeding-a-new-run) describes the timing and the supervisor's start grace for a
long seed.
