// The harness conformance suite over the reference loop (conformance-reference.mjs): the suite's own proof, before a real
// harness (pi, then the CLI adapters) plugs in. CONFORMANCE_MUTANT names a mutant of the reference that breaks one case.
import { test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { referenceSubject } from "./conformance-reference.mjs";

registerHarnessConformance(referenceSubject, { test });
