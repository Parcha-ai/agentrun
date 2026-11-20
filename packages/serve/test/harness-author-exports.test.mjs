// What a harness's author imports from serve by name (HARNESS.md): `@parcha/agentrun-serve/harness`, the types of a
// harness module, which loads nothing; and `@parcha/agentrun-serve/conformance`, the very suite and adapter loop this
// repository proves its own harnesses with, not a copy.
import assert from "node:assert/strict";
import test from "node:test";

test("the harness subpath is types alone, and the conformance subpath is the suite and the adapter loop the repository's own harnesses run on", async () => {
  const [harness, conformance, suite, loop, tools] = await Promise.all([
    import("@parcha/agentrun-serve/harness"),
    import("@parcha/agentrun-serve/conformance"),
    import("../dist/runner/conformance/harness.js"),
    import("../dist/runner/adapter-loop.js"),
    import("../dist/runner/conformance/host-tools.js"),
  ]);
  assert.deepEqual(Object.keys(harness), [], "a module that imports the harness types loads nothing of serve");
  assert.deepEqual(Object.keys(conformance).sort(), ["MAX_RESTARTS", "createAdapterLoop", "registerHarnessConformance", "suiteHostTools"]);
  assert.equal(conformance.registerHarnessConformance, suite.registerHarnessConformance);
  assert.equal(conformance.MAX_RESTARTS, suite.MAX_RESTARTS);
  assert.equal(conformance.createAdapterLoop, loop.createAdapterLoop);
  assert.equal(conformance.suiteHostTools, tools.suiteHostTools);
});
