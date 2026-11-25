// The ACP package (@parcha/agentrun-harness-acp) as a test hands it to serve's loader (acp-package.ts) in its place: every
// export the package's own but two, each adapter factory recording the debug option it is called with before it makes
// the real adapter, so a test reads what reached the adapter each entry builds. The records are in one array on
// globalThis (RECORDS), shared with the test that registered this module. Imported by its path, so the test's hook,
// which hands this module in place of the package's name, never hands it to itself.
// The two: Goose's and Cursor's pins (GOOSE_PIN, CURSOR_PIN), each with no release until the test pins a stand-in it
// installed (archives[platform]), so their built-in entries are built where no real release is. Serve's checks of an
// install are its own and run unchanged: the stand-in's sha256 (Goose's) or tree digest (Cursor's) against the pin.
import * as acp from "../../../run-adapters-acp/dist/index.js";

export * from "../../../run-adapters-acp/dist/index.js";

/** Where the records are kept: `{ factory, debug }` per call, in order. */
export const RECORDS = Symbol.for("agentrun.test.acp-adapter-calls");
const records = () => (globalThis[RECORDS] ??= []);
const recorded = (factory) => (options) => {
  records().push({ factory, debug: options?.debug });
  return acp[factory](options);
};

/** Goose's and Cursor's pins as the package's, with no release: a test adds its stand-in's at archives[platform]. */
export const GOOSE_PIN = { ...acp.GOOSE_PIN, archives: {} };
export const CURSOR_PIN = { ...acp.CURSOR_PIN, archives: {} };

export const acpAdapter = recorded("acpAdapter");
export const gooseAdapter = recorded("gooseAdapter");
export const cursorAdapter = recorded("cursorAdapter");
