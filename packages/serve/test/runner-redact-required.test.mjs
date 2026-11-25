// A loop or a run's spec given no redactor that holds keys throws before it reads or opens anything: none runs with the
// keys it opens unheld, and none skips the holding.
import assert from "node:assert/strict";
import { test } from "node:test";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { createSdkLoop } = await import("../dist/runner/sdk-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { createNativeLoop } = await import("../dist/runner/native-loop.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { withLiveTicker } = await import("../dist/runner/live-ticker.js");
const { childLoop } = await import("../dist/runner/run-child-host.js");
const { holdingGatewayKey } = await import("../dist/runner/harness-loops.js");
const { savedGatewayMarked } = await import("../dist/model-gateway.js");

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

  test(`an SDK loop given ${name} as its redactor throws at its making, before it reads its deps`, () => {
    assert.throws(() => createSdkLoop({ sdk: {} }, {}, () => assert.fail("the route was asked for"))(loopDepsWith(redact)), UNHELD);
  });

  test(`a pi session's adapter given ${name} as its redactor throws at its making, before any session opens`, () => {
    assert.throws(() => piAdapter({ run: "run-unheld", model: "not-a-model", provider: { api: "anthropic-messages", origin: "http://model.invalid", credential: () => "not-a-secret" }, ...(redact === undefined ? {} : { redact }) }), UNHELD);
  });

  test(`a native loop given ${name} as its redactor throws at its making, before it reads its deps`, () => {
    assert.throws(() => createNativeLoop(launch, { store: untouched, sealKey: Buffer.alloc(32), env: {}, data: "/nonexistent" })(loopDepsWith(redact)), UNHELD);
  });

  test(`a dispatch loop given ${name} as its redactor throws at its making, before it reads a launch`, () => {
    assert.throws(() => createDispatchLoop({ launchOf: () => assert.fail("the launch was read"), resolve: () => assert.fail("a harness's loop was chosen") })(loopDepsWith(redact)), UNHELD);
  });

  test(`a loop the live ticker wraps, given ${name} as its redactor, throws at its making, before it reads its deps`, (t) => {
    const ticker = withLiveTicker(untouched, () => assert.fail("the wrapped loop was made"), { tickMs: 60_000 });
    t.after(() => ticker.stop());
    assert.throws(() => ticker.createLoop(loopDepsWith(redact)), UNHELD);
  });

  test(`a run's own process's loop given ${name} as its redactor throws at its making, before it reads its deps`, () => {
    const options = { deps: untouched, isolation: { kind: "process", why: "a test's runner" }, log: () => assert.fail("the loop logged") };
    assert.throws(() => childLoop(options, undefined, loopDepsWith(redact), undefined), UNHELD);
  });

  test(`a loop over the saved gateway given ${name} as its redactor throws at its making, before the loop it wraps is made`, () => {
    const env = savedGatewayMarked({ AGENTRUN_MODEL_GATEWAY_SAVED: "1", AGENT_MODEL_API_KEY: "a-saved-gateway-key-0123456789" });
    assert.throws(() => holdingGatewayKey(() => assert.fail("the wrapped loop was made"), env)(loopDepsWith(redact)), UNHELD);
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
