// The page's stop keeps the take's evidence before anything is torn down: the guard log, the strength record, the page's
// events and the run's transcript leave the box and the disk first; a step that fails is logged and the teardown goes on.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runStopSteps, stopSteps } from "../stop-steps.ts";
import { pullRunTree } from "../pull-run.ts";
import { runStep } from "../run-step.ts";

test("stop: the evidence is kept first, then the box, the sandboxes and the run's tree go", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-keep-"));
  const calls: string[] = [];
  const steps = stopSteps(
    {
      onBox: (cmd) => (calls.push(`box: ${cmd}`), JSON.stringify({ "guard.jsonl": '{"sentence":"I am the bridge."}\n', "strength.json": "{}", "served.json": "{}", "pick.json": null, "recipe-cats.json": '{"topic":"cats"}' })),
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
  assert.equal(calls.filter((c) => c.startsWith("box: ")).length, 1, "the box's files come off in one exec");
  for (const kept of ["guard.jsonl", "strength.json", "page events", "run transcript"]) {
    assert.ok(first(kept) >= 0, `${kept} is kept`);
    assert.ok(first(kept) < first("box down") && first(kept) < first("run tree"), `${kept} is kept before the teardown`);
  }
  assert.equal(readFileSync(join(dir, "guard.jsonl"), "utf8"), '{"sentence":"I am the bridge."}\n');
  assert.equal(readFileSync(join(dir, "recipe-cats.json"), "utf8"), '{"topic":"cats"}', "the recipes made on the box are kept with the take");
});

test("stop: the box's read is one root command that also lists the recipes the lab saved", () => {
  let cmd = "";
  const steps = stopSteps({ onBox: (c) => ((cmd = c), "{}"), pageEvents: () => "", pullRun: () => "", boxDown: () => "", terminateSandboxes: () => "", cleanRun: () => "" }, mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-keep-")));
  runStopSteps(steps, () => undefined);
  assert.match(cmd, /\/var\/tmp\/gg\/recipes/);
  // the command runs in a shell inside single quotes: the program itself has none
  assert.equal(cmd.slice("python3 -c '".length, -1).includes("'"), false);
  const recipes = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-recipes-"));
  writeFileSync(join(recipes, "pizza.json"), '{"topic":"pizza"}');
  writeFileSync(join(recipes, "notes.txt"), "x");
  const out = JSON.parse(runStep("python3", ["-c", cmd.slice("python3 -c '".length, -1).replace("/var/tmp/gg/recipes", recipes)]));
  assert.equal(out["recipe-pizza.json"], '{"topic":"pizza"}', "the program runs and prints one JSON object, the recipes in it");
  assert.equal(out["guard.jsonl"], null);
  assert.equal("recipe-notes.txt" in out, false);
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
  assert.ok(log.some((l) => l.event === "stop.failed" && l.step.includes("box's logs")));
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

test("stop: an evidence directory that cannot be made is logged, and the teardown still runs", () => {
  const blocker = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-keep-")), "a-file");
  writeFileSync(blocker, "");
  const calls: string[] = [];
  const steps = stopSteps(
    { onBox: () => "{}", pageEvents: () => "", pullRun: () => "", boxDown: () => (calls.push("box down"), ""), terminateSandboxes: () => (calls.push("sandboxes"), ""), cleanRun: () => (calls.push("run tree"), "") },
    join(blocker, "takes", "now"),
  );
  const log: string[] = [];
  runStopSteps(steps, (event) => void log.push(event));
  assert.deepEqual(calls, ["box down", "sandboxes", "run tree"]);
  assert.ok(log.includes("stop.failed"));
});

test("a step past its time limit fails instead of holding the stop", () => {
  const t = Date.now();
  assert.throws(() => runStep(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { timeout: 300 }), /exited SIGTERM/);
  assert.ok(Date.now() - t < 5000);
});

test("pull-run: every page of the object list", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-run-"));
  const pages: Record<string, { objects: { key: string }[]; isTruncated: boolean; nextContinuationToken?: string }> = {
    "": { objects: [{ key: "runs/r/a.txt" }], isTruncated: true, nextContinuationToken: "p2" },
    p2: { objects: [{ key: "runs/r/store/b.txt" }], isTruncated: false },
  };
  const control = {
    listObjects: async (_prefix: string, options?: { continuationToken?: string }) => pages[options?.continuationToken ?? ""]!,
    getObject: async (key: string) => new TextEncoder().encode(key),
  };
  const got = await pullRunTree(control, "r", dir, (id) => `runs/${id}`);
  assert.equal(got.files, 2);
  assert.equal(readFileSync(join(dir, "store/b.txt"), "utf8"), "runs/r/store/b.txt");
});
