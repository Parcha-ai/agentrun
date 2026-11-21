// The runner's own spec builder supplies a run's end-of-run step (adapter-run-spec.ts adapterRunSpecFromLaunch endOfRun):
// a run that learns gets one, a run that does not gets none. Its learning folder is the server's data directory's in
// either mode (runner-mode2-learning-local.test.mjs runs a Mode 2 one through it).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { specFor } = await import("./runner-spec-support.mjs");

after(closeOpenSessions);

test("a run supplies its end-of-run step from the spec builder only when it learns", async (t) => {
  const learns = await specFor(t, { body: { learning: true }, launch: { learning: { seed: "0".repeat(40), section: "" } } });
  assert.equal(typeof learns.spec.endOfRun, "function", "a run that learns gets the end-of-run step from its spec");
  const plain = await specFor(t, {});
  assert.equal(plain.spec.endOfRun, undefined, "a run that does not learn gets none");
});
