// openDurableRun's `seed`: what a new run starts with (its store file, files in work/), written inside its first claim
// before run.json publishes it and before the Harness opens the store. Never on a later open; a seed that throws or is
// killed leaves the run unpublished, and the next open seeds again.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { localRun } from "../src/local-run.ts";
import { openDurableRun, STORE_FILE, type RunSeed } from "../src/run.ts";
import { RUN_JSON } from "../src/status.ts";
import { fakeClaim, localClaimDir, localRef, scratchRoot, scriptedHarness } from "./_run-support.ts";

const CHILD = fileURLToPath(new URL("./fixtures/seed-child.ts", import.meta.url));

/** A seed that writes a table of its own into the store file and a skill into work/, and records what it saw. */
function seeding(seen: { calls: number; runJsonThen?: boolean; dir?: Parameters<RunSeed>[0] }, root: string): RunSeed {
  return async (dir) => {
    seen.calls++;
    seen.dir = dir;
    seen.runJsonThen = existsSync(join(root, RUN_JSON));
    const db = new DatabaseSync(dir.storePath);
    db.exec("CREATE TABLE IF NOT EXISTS x_seed (k TEXT PRIMARY KEY); INSERT OR REPLACE INTO x_seed (k) VALUES ('profile-1')");
    db.close();
    mkdirSync(join(dir.workDir, ".agents", "skills"), { recursive: true });
    writeFileSync(join(dir.workDir, ".agents", "skills", "sign-in.md"), "how to sign in\n");
  };
}

function opener(root: string, seed?: RunSeed) {
  const ref = localRef("r1");
  const claim = fakeClaim(root, ref);
  const steps: string[] = [];
  const scripted = scriptedHarness();
  const open = () =>
    openDurableRun(ref, {
      mountToken: "unused",
      acquire: async () => {
        claim.log.push("acquire");
        return claim;
      },
      claimDir: localClaimDir,
      harness: { models: scripted.models, registry: scripted.registry },
      onStep: (step) => void steps.push(step),
      ...(seed ? { seed } : {}),
    });
  return { claim, steps, open };
}

describe("seed", () => {
  it("runs once on a new run, after the owner lock and before run.json, and what it wrote is in the store the run opens", async () => {
    const dir = scratchRoot("seed-new");
    try {
      const seen: { calls: number; runJsonThen?: boolean; dir?: Parameters<RunSeed>[0] } = { calls: 0 };
      const t = opener(dir.root, seeding(seen, dir.root));
      const run = await t.open();
      assert.equal(seen.calls, 1);
      assert.equal(seen.runJsonThen, false, "no run.json yet while it seeds");
      assert.deepEqual(seen.dir, { root: dir.root, storePath: join(dir.root, "store", STORE_FILE), workDir: join(dir.root, "work") });
      assert.deepEqual(t.steps.slice(0, 4), ["acquire", "owner-lock", "seed", "run.json"]);
      assert.ok(t.claim.log.indexOf("barrier") >= 0, "what it wrote is made durable (the claim's barrier) before run.json publishes the run");
      const rows = await run.store.database.all<{ k: string }>("SELECT k FROM x_seed");
      assert.deepEqual(rows.map((row) => row.k), ["profile-1"], "the seeded table is in the opened store");
      assert.equal(readFileSync(join(dir.root, "work", ".agents", "skills", "sign-in.md"), "utf8"), "how to sign in\n");
      assert.equal(run.generation, 1);
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("never runs on a later open: run.json is there", async () => {
    const dir = scratchRoot("seed-later");
    try {
      const seen = { calls: 0 };
      await (await opener(dir.root, seeding(seen, dir.root)).open()).release();
      const again = opener(dir.root, seeding(seen, dir.root));
      const run = await again.open();
      assert.equal(seen.calls, 1, "seeded once, by the first open");
      assert.ok(!again.steps.includes("seed"));
      assert.equal(run.generation, 2);
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("a seed that throws fails the open with its error and publishes nothing; the next open seeds again", async () => {
    const dir = scratchRoot("seed-throws");
    try {
      const refused = new Error("no profile to seed from");
      const t = opener(dir.root, async () => {
        throw refused;
      });
      await assert.rejects(t.open(), (error: unknown) => error === refused);
      assert.equal(existsSync(join(dir.root, RUN_JSON)), false, "no run.json: the run is not published");
      assert.ok(t.claim.log.includes("release"), "the claim was let go");
      const seen = { calls: 0 };
      const retry = opener(dir.root, seeding(seen, dir.root));
      const run = await retry.open();
      assert.equal(seen.calls, 1, "the next open seeds again");
      assert.equal(run.generation, 1, "the first published generation");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("a process killed during its seed leaves the run unpublished, and the next open (localRun) seeds again", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("seed-killed");
    const root = join(dir.root, "run");
    const marker = join(dir.root, "seeding");
    const child = spawn(process.execPath, [CHILD, root, marker], { stdio: ["ignore", "ignore", "inherit"] });
    try {
      for (const t0 = Date.now(); !existsSync(marker) && Date.now() - t0 < 30_000; ) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(marker), "the child is seeding");
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
      assert.equal(existsSync(join(root, RUN_JSON)), false, "the run was never published");
      const seen = { calls: 0 };
      const scripted = scriptedHarness();
      const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "seeded" }, { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry }, seed: seeding(seen, root) });
      assert.equal(seen.calls, 1);
      assert.equal(run.generation, 1);
      assert.deepEqual((await run.store.database.all<{ k: string }>("SELECT k FROM x_seed")).map((row) => row.k), ["profile-1"]);
      await run.release();
    } finally {
      child.kill("SIGKILL");
      dir.remove();
    }
  });
});
