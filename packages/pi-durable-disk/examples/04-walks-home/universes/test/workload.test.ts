// The train workload against a stub of D2's train.py with the same file contract: every state.json rename (one per
// finished checkpoint) runs the barrier; the progress the orchestrator reads over S3 names the machine, the step and the
// score; a stop is a SIGTERM that leaves state.json paused; the same command on the same work directory resumes at the
// next generation, from where the last one was.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Control } from "../multiverse.ts";
import { readTrainProgress } from "../train-progress.ts";
import { startWorkload } from "../workload.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("train.py as the workload: a barrier per checkpoint, progress by machine, stop and resume", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "universes-train-"));
  try {
    const run = { disk: "dsk-local", region: "local", id: "u-train" };
    const work = join(root, "runs", run.id, "work");
    mkdirSync(join(work, "creature"), { recursive: true });
    writeFileSync(join(work, "creature", "creature.xml"), "<mujoco/>");
    writeFileSync(join(work, "creature", "body.json"), "{}");
    // The disk's S3 view of this directory.
    const control = {
      getObject: async (key: string) => new Uint8Array(readFileSync(join(root, key))),
    } as unknown as Control;
    // The stub is JavaScript: node stands in for python, the file contract is train.py's.
    const env = { UNIVERSE_WORKLOAD: "train", UNIVERSE_PYTHON: process.execPath, UNIVERSE_TRAIN_PY: join(here, "fixtures", "fake-train.mjs"), UNIVERSE_ID: "u3", UNIVERSE_SCALES: '{"feet_air_time":1}' };
    const logs: string[] = [];
    let barriers = 0;
    const start = (host: string) =>
      startWorkload({ work, env, generation: 1, host, checkpointed: async () => void barriers++, log: (e) => void logs.push(e) });

    const a = start("machine A");
    let onA = null;
    for (let i = 0; i < 200 && !(onA && onA.step >= 9_000); i++) {
      await sleep(50);
      onA = await readTrainProgress(control, run, "u3");
    }
    assert.ok(onA, "progress appeared");
    assert.equal(onA.host, "machine A");
    assert.equal(onA.generation, 1);
    assert.ok(onA.score > 0, "the score is the last progress line's");
    assert.ok(barriers >= 2, `a barrier per checkpoint (${barriers})`);
    assert.deepEqual(JSON.parse(readFileSync(join(work, "train", "u3", "universe.json"), "utf8")).reward_scales, { feet_air_time: 1 });

    await a.stop();
    const paused = JSON.parse(readFileSync(join(work, "train", "u3", "state.json"), "utf8"));
    assert.equal(paused.status, "paused");
    const afterStop = barriers;
    assert.ok(logs.includes("train.end"));

    const b = start("machine B");
    let onB = null;
    for (let i = 0; i < 200 && !(onB && onB.host === "machine B" && onB.step > paused.steps_done); i++) {
      await sleep(50);
      onB = await readTrainProgress(control, run, "u3");
    }
    assert.ok(onB && onB.host === "machine B", "the resumed run names its machine");
    assert.equal(onB.generation, 2, "resumed at the next generation");
    assert.ok(onB.step > paused.steps_done, "from where the last one stopped, not from 0");
    assert.ok(barriers > afterStop);
    await b.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
