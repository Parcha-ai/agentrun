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
