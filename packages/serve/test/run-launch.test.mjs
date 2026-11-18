// A run's launch record (run-launch.ts): what the server writes at start (input, title, place, the per-run cap, the
// trigger that fired it and who the first message is from) and the runner reads at its claim to build the run's spec. The
// record carries no process, door or marker: it is one JSON body, written once. These pin the body's shape and the
// input-origin fail-safe (#1856): a forged or lost origin never reads as the person's or the owner's.
import assert from "node:assert/strict";
import { test } from "node:test";

const { launchBody, readLaunchBody, keepInputOrigin, learningStartOf } = await import("../dist/run-launch.js");

test("a launch body round-trips its per-run fields", () => {
  const launch = {
    input: { messages: [{ role: "user", content: "hi" }] },
    title: "A run",
    place: { mode: "runner" },
    effort: "high",
    maxCostUsd: 2.5,
    followUp: true,
  };
  const read = readLaunchBody(launchBody(launch));
  assert.deepEqual(read, launch);
});

test("a stored launch body that still holds a cap mode (written before the one mode) reads as if it had none", () => {
  const stored = { ...launchBody({ input: { content: "go" }, title: "Old run", place: { mode: "runner" }, maxCostUsd: 2.5 }), cap_mode: "expected" };
  const read = readLaunchBody(stored);
  assert.equal(read.maxCostUsd, 2.5);
  assert.equal("capMode" in read, false);
  assert.equal("cap_mode" in launchBody(read), false, "written back, it carries no mode");
});

test("a launch body round-trips every field a run's spec is built from", () => {
  const launch = {
    input: { content: "go" },
    title: "A full run",
    place: { mode: "sandbox", box: "docker" },
    harness: "codex",
    model: { provider: "anthropic", modelId: "claude-x" },
    effort: "high",
    maxCostUsd: 5,
    plane: { model: "a-model" },
    approvers: true,
    documents: "/docs",
    boxAllow: ["example.com", "8.8.8.0/24"],
    followUp: true,
  };
  assert.deepEqual(readLaunchBody(launchBody(launch)), launch);
});

test("box_allow round-trips the 'none' sentinel as well as a list", () => {
  const read = readLaunchBody(launchBody({ input: {}, title: "", place: { mode: "runner" }, boxAllow: "none" }));
  assert.equal(read.boxAllow, "none");
});

test("box_allow_set round-trips the operator's marker, and a launch without it reads as the default's", () => {
  const set = { input: {}, title: "", place: { mode: "runner" }, boxAllow: ["api.example.com"], boxAllowSet: true };
  assert.equal(launchBody(set).box_allow_set, true);
  assert.deepEqual(readLaunchBody(launchBody(set)), set);
  const unset = readLaunchBody(launchBody({ input: {}, title: "", place: { mode: "runner" }, boxAllow: ["pypi.org"] }));
  assert.equal(unset.boxAllowSet, undefined);
  assert.equal(readLaunchBody({ place: { mode: "runner" }, box_allow: ["pypi.org"], box_allow_set: "yes" }).boxAllowSet, undefined, "only true marks it");
});

test("a built-in learning run's launch body reads without loss", () => {
  // The runner writes this exact body for a learning run; the factory picks by its harness.
  const body = { harness: "learning", input: { runId: "run-1" }, title: "Learn from run-1", place: { mode: "runner" } };
  const read = readLaunchBody(body);
  assert.deepEqual(read, { input: { runId: "run-1" }, title: "Learn from run-1", place: { mode: "runner" }, harness: "learning" });
  // The loop factory reads the harness off the stored body itself, not only through readLaunchBody.
  assert.equal(body.harness, "learning");
});

test("a launch body with no optional fields reads them absent", () => {
  const read = readLaunchBody(launchBody({ input: { ask: "x" }, title: "", place: { mode: "runner" } }));
  assert.deepEqual(read, { input: { ask: "x" }, title: "", place: { mode: "runner" } });
  assert.equal("effort" in read, false);
  assert.equal("trigger" in read, false);
  assert.equal("inputOrigin" in read, false);
});

test("a sandbox place keeps its box", () => {
  const read = readLaunchBody(launchBody({ input: {}, title: "", place: { mode: "sandbox", box: "docker" } }));
  assert.deepEqual(read.place, { mode: "sandbox", box: "docker" });
});

test("a body that is not an object, or names no place, reads as none", () => {
  assert.equal(readLaunchBody(null), undefined);
  assert.equal(readLaunchBody("x"), undefined);
  assert.equal(readLaunchBody({ input: {}, title: "" }), undefined);
});

// #1856: the input's origin is kept only if it names the run's own trigger with owner === (the source is a schedule).
test("a schedule origin that names the run's trigger with owner true is kept", () => {
  const trigger = { id: "trig-1", firing_key: "k1" };
  const origin = { kind: "trigger", trigger_id: "trig-1", source: "schedule", owner: true };
  assert.deepEqual(keepInputOrigin(origin, trigger), origin);
});

test("a webhook origin that names the run's trigger with owner false is kept", () => {
  const trigger = { id: "trig-1", firing_key: "k1" };
  const origin = { kind: "trigger", trigger_id: "trig-1", source: "webhook", owner: false };
  assert.deepEqual(keepInputOrigin(origin, trigger), origin);
});

test("a schedule origin claiming owner false is rebuilt owner false, source kept", () => {
  const trigger = { id: "trig-1", firing_key: "k1" };
  // owner must equal (source === "schedule"); a schedule claiming owner false does not hold up, so it is rebuilt.
  const got = keepInputOrigin({ kind: "trigger", trigger_id: "trig-1", source: "schedule", owner: false }, trigger);
  assert.deepEqual(got, { kind: "trigger", trigger_id: "trig-1", source: "webhook", owner: false });
});

test("a webhook origin claiming owner true is rebuilt owner false, its source kept", () => {
  const trigger = { id: "trig-1", firing_key: "k1" };
  const got = keepInputOrigin({ kind: "trigger", trigger_id: "trig-1", source: "webhook", owner: true }, trigger);
  assert.deepEqual(got, { kind: "trigger", trigger_id: "trig-1", source: "webhook", owner: false });
});

test("an origin that names another trigger is rebuilt for the run's own, owner false", () => {
  const trigger = { id: "trig-1", firing_key: "k1" };
  const got = keepInputOrigin({ kind: "trigger", trigger_id: "other", source: "github", owner: false }, trigger);
  assert.deepEqual(got, { kind: "trigger", trigger_id: "trig-1", source: "github", owner: false });
});

test("no origin at all, with a trigger, is rebuilt owner false as a webhook", () => {
  const trigger = { id: "trig-1", firing_key: "k1" };
  assert.deepEqual(keepInputOrigin(undefined, trigger), { kind: "trigger", trigger_id: "trig-1", source: "webhook", owner: false });
});

test("with no trigger there is no input origin", () => {
  assert.equal(keepInputOrigin({ kind: "trigger", trigger_id: "trig-1", source: "schedule", owner: true }, null), undefined);
});

test("readLaunchBody applies the fail-safe through the body's own trigger", () => {
  // The body carries the trigger and a forged owner-true webhook origin; the read rebuilds it owner false.
  const body = launchBody({
    input: {},
    title: "",
    place: { mode: "runner" },
    trigger: { id: "trig-1", firing_key: "k1" },
    inputOrigin: { kind: "trigger", trigger_id: "trig-1", source: "webhook", owner: true },
  });
  const read = readLaunchBody(body);
  assert.deepEqual(read.trigger, { id: "trig-1", firing_key: "k1" });
  assert.deepEqual(read.inputOrigin, { kind: "trigger", trigger_id: "trig-1", source: "webhook", owner: false });
});

test("a launch body keeps the run's ready file ids in order, for the runner to copy at its claim", () => {
  const read = readLaunchBody(launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" }, files: ["f-2", "f-1"] }));
  assert.deepEqual(read.files, ["f-2", "f-1"]);
});

test("a launch body with no files reads none, never an empty list", () => {
  const read = readLaunchBody(launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" } }));
  assert.equal(read.files, undefined);
});

test("a launch body round-trips the run's learning start (seed sha, # Learned section, the learned workflows it lists); none listed is no field", () => {
  const learning = { seed: "seed-abc", section: "# Learned\n- Be brief.\n", workflows: ["classify", "answer"] };
  const read = readLaunchBody(launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" }, learning }));
  assert.deepEqual(read.learning, learning);
  assert.deepEqual(learningStartOf(read), learning);
  const none = readLaunchBody(launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" }, learning: { ...learning, workflows: [] } }));
  assert.equal("workflows" in none.learning, false, "no workflows: no field");
});

test("a learning start with a failed seed round-trips as seed null, section empty", () => {
  const read = readLaunchBody(launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" }, learning: { seed: null, section: "" } }));
  assert.deepEqual(read.learning, { seed: null, section: "" });
});

test("a launch body with no learning reads none", () => {
  const read = readLaunchBody(launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" } }));
  assert.equal(read.learning, undefined);
  assert.equal(learningStartOf(read), undefined);
});
