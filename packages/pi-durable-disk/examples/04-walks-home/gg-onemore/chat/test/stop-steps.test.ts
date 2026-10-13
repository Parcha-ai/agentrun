// The page's stop keeps the take's evidence before anything is torn down: the guard log, the strength record, the page's
// events and the run's transcript leave the box and the disk first; a step that fails is logged and the teardown goes on.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runStopSteps, stopSteps } from "../stop-steps.ts";
import { pullRunTree } from "../pull-run.ts";

test("stop: the evidence is kept first, then the box, the sandboxes and the run's tree go", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-keep-"));
  const calls: string[] = [];
  const steps = stopSteps(
    {
      onBox: (cmd) => (calls.push(`box: ${cmd}`), cmd.includes("guard.jsonl") ? '{"sentence":"I am the bridge."}\n' : "{}"),
      pageEvents: (to) => (calls.push("page events"), to),
      pullRun: (to) => (calls.push("run transcript"), to),
      boxDown: () => (calls.push("box down"), "terminated"),
      terminateSandboxes: () => (calls.push("sandboxes"), "0"),
      cleanRun: () => (calls.push("run tree"), "deleted"),
    },
    dir,
  );
  const log: { event: string; step: string }[] = [];
  runStopSteps(steps, (event, data) => void log.push({ event, step: String(data.step) }));
  const first = (s: string) => calls.findIndex((c) => c.includes(s));
  for (const kept of ["guard.jsonl", "strength.json", "page events", "run transcript"]) {
    assert.ok(first(kept) >= 0, `${kept} is kept`);
    assert.ok(first(kept) < first("box down") && first(kept) < first("run tree"), `${kept} is kept before the teardown`);
  }
  assert.equal(readFileSync(join(dir, "guard.jsonl"), "utf8"), '{"sentence":"I am the bridge."}\n');
});

test("stop: a keep step that fails is logged, and the teardown still runs", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-keep-"));
  const calls: string[] = [];
  const steps = stopSteps(
    {
      onBox: () => {
        throw new Error("the box is gone");
      },
      pageEvents: () => "",
      pullRun: () => {
        throw new Error("no disk");
      },
      boxDown: () => (calls.push("box down"), ""),
      terminateSandboxes: () => (calls.push("sandboxes"), ""),
      cleanRun: () => (calls.push("run tree"), ""),
    },
    dir,
  );
  const log: { event: string; step: string }[] = [];
  runStopSteps(steps, (event, data) => void log.push({ event, step: String(data.step) }));
  assert.deepEqual(calls, ["box down", "sandboxes", "run tree"]);
  assert.ok(log.some((l) => l.event === "stop.failed" && l.step.includes("guard")));
  assert.ok(log.some((l) => l.event === "stop.failed" && l.step.includes("transcript")));
});

test("pull-run: the run's work and store come off the disk, its own paths kept", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-run-"));
  const objects: Record<string, string> = {
    "runs/golden-gate/": "",
    "runs/golden-gate/work/gg/requests.jsonl": '{"messages":[]}\n',
    "runs/golden-gate/store/session.db": "db",
    "runs/golden-gate/run.json": "{}",
  };
  const control = {
    listObjects: async (prefix: string) => ({ objects: Object.keys(objects).filter((k) => k.startsWith(prefix)).map((key) => ({ key })), commonPrefixes: [] }),
    getObject: async (key: string) => new TextEncoder().encode(objects[key]),
  };
  const got = await pullRunTree(control, "golden-gate", dir, (id) => `runs/${id}`);
  assert.equal(readFileSync(join(dir, "work/gg/requests.jsonl"), "utf8"), '{"messages":[]}\n');
  assert.equal(readFileSync(join(dir, "store/session.db"), "utf8"), "db");
  assert.equal(readFileSync(join(dir, "run.json"), "utf8"), "{}");
  assert.equal(got.files, 3);
});
