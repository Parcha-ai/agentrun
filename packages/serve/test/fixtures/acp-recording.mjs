// The ACP package (@parcha/agentrun-harness-acp) as a test hands it to serve's loader (acp-package.ts) in its place: every
// export the package's own, each adapter factory recording the debug option it is called with before it makes the real
// adapter, so a test reads what reached the adapter each entry builds. The records are in one array on globalThis
// (RECORDS), shared with the test that registered this module. Imported by its path, so the test's hook, which hands
// this module in place of the package's name, never hands it to itself.
import * as acp from "../../../run-adapters-acp/dist/index.js";

export * from "../../../run-adapters-acp/dist/index.js";

/** Where the records are kept: `{ factory, debug }` per call, in order. */
export const RECORDS = Symbol.for("agentrun.test.acp-adapter-calls");
const records = () => (globalThis[RECORDS] ??= []);
const recorded = (factory) => (options) => {
  records().push({ factory, debug: options?.debug });
  return acp[factory](options);
};

export const acpAdapter = recorded("acpAdapter");
export const gooseAdapter = recorded("gooseAdapter");
export const cursorAdapter = recorded("cursorAdapter");
