// A loop or a run's spec given no redactor that holds keys throws before it reads or opens anything: none runs with the
// keys it opens unheld, and none skips the holding.
import assert from "node:assert/strict";
import { test } from "node:test";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");

const UNHELD = /was given no redactor that holds keys/;
/** A store whose every read fails the test in its own words: a spec refused for its missing redactor reads nothing first. */
const untouched = new Proxy({}, { get: (_, name) => { throw new Error(`the store was read (${String(name)}) before the redactor was checked`); } });
const claim = { runId: "run-unheld", epoch: 1, runner: "runner-unheld" };
const launch = { plane: { tools: [] }, model: "not-a-model" };
const plain = (text) => text;

for (const [name, redact] of [["none", undefined], ["a plain function that holds nothing", plain]]) {
  test(`an adapter loop given ${name} as its redactor throws at its making, before it reads its deps`, () => {
    assert.throws(() => createAdapterLoop(() => assert.fail("the spec was asked for"))(loopDepsWith(redact)), UNHELD);
  });

  test(`a workflow loop given ${name} as its redactor throws at its making, before it reads its deps`, () => {
    assert.throws(() => createWorkflowLoop(() => assert.fail("the spec was asked for"))(loopDepsWith(redact)), UNHELD);
  });

  test(`a workflow run's spec given ${name} as its redactor rejects before it reads the store`, async () => {
    await assert.rejects(async () => workflowSpecOf({ store: untouched, sealKey: Buffer.alloc(32), env: {} })(claim, redact === undefined ? {} : { redact }), UNHELD);
  });

  test(`a CLI run's spec given ${name} as its redactor rejects before it reads the store`, async () => {
    await assert.rejects(async () => cliRunSpecFromLaunch(launch, redact === undefined ? {} : { redact }, { store: untouched, sealKey: Buffer.alloc(32), env: {}, data: "/nonexistent" }, claim), UNHELD);
  });

  test(`a pi run's spec given ${name} as its redactor rejects before it reads the store`, async () => {
    await assert.rejects(async () => adapterRunSpecFromLaunch(launch, redact === undefined ? {} : { redact }, { store: untouched, sealKey: Buffer.alloc(32), env: {}, data: "/nonexistent" }, claim), UNHELD);
  });
}

/** loopDeps with `redact` set (or left out), as a plain object whose other fields fail the test when read. */
function loopDepsWith(redact) {
  const deps = {};
  for (const key of ["store", "claim", "signal", "log", "onEvent", "live", "now"]) Object.defineProperty(deps, key, { enumerable: true, get: () => assert.fail(`the loop read ${key} before the redactor was checked`) });
  if (redact !== undefined) deps.redact = redact;
  return deps;
}
