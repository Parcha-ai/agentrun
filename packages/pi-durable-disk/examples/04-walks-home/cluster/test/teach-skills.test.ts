// teach_skills end to end over a real Harness on SQLite, with fake GPU boxes and a scripted model: each case runs
// spike/spike.ts, which SIGKILLs the first host while the parent waits on its threads and finishes in a second one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { foldText, type ThreadResult } from "../teach-skills.ts";

const spike = join(dirname(fileURLToPath(import.meta.url)), "..", "spike", "spike.ts");

function runSpike(capacity: number) {
  const dir = mkdtempSync(join(tmpdir(), `teach-skills-${capacity}-`));
  const r = spawnSync(process.execPath, [spike, "--dir", dir, "--tick", "150", "--capacity", String(capacity)], { encoding: "utf8", timeout: 120_000 });
  const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  return { status: r.status, verdict };
}

test("eight threads survive a SIGKILL of the host while the parent waits allSettled, and GPU 3 reads back", () => {
  const { status, verdict } = runSpike(8);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.equal(verdict.peak_boxes, 8);
  assert.match(verdict.ask, /GPU 3 \(backwards\)/);
  // Threads cut off by the kill reran through pi-run, which stopped the earlier run first; finished ones did not rerun.
  const reran = verdict.reruns.filter((r: { runs: string[] }) => r.runs.includes("pi-run.stopped-previous"));
  assert.ok(reran.length >= 1);
  for (const r of reran) assert.deepEqual(r.runs.slice(-2), ["pi-run.stopped-previous", "train.start"]);
});

test("a pool of two boxes queues the threads in acquire and still joins all eight", () => {
  const { status, verdict } = runSpike(2);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.equal(verdict.peak_boxes, 2);
});

test("the fold names every thread, passed or not, in its own words", () => {
  const threads: ThreadResult[] = [
    { skill: "walk", gpu: 1, conversationId: 3, boxId: "sb-1", status: "passed", checkpoint: 3, seconds: 21, summary: "walk passed at checkpoint 3." },
    { skill: "wave", gpu: 7, conversationId: 9, boxId: "sb-7", status: "never-passed", summary: "wave never passed its test." },
  ];
  assert.equal(
    foldText(threads),
    [
      "2 threads finished: 1 passed, 1 did not.",
      "- GPU 1 · walk: passed at checkpoint 3 in 21 s. walk passed at checkpoint 3.",
      "- GPU 7 · wave: never passed. wave never passed its test.",
      "Each thread's own conversation: read_thread with its skill or GPU number.",
    ].join("\n"),
  );
});
