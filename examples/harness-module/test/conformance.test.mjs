// The harness conformance suite on this module's harness (HARNESS.md "Prove it"): the same suite serve proves its
// built-in harnesses with. A case the harness rules out by its facts is skipped with the reason; every other must pass.
import { after, test } from "node:test";
import { registerHarnessConformance } from "@parcha/agentrun-serve/conformance";
import { closeAll, subject } from "./subject.mjs";

registerHarnessConformance(subject, { test });
after(closeAll);
