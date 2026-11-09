// The harness conformance suite over the WORKFLOW subject (the runner's workflow loop). The workflow appears in the
// suite's "conformance on every subject through the runner" gate: stop ends the run stopped; the crash, fault and person
// cases are skipped with the subject's declared reason (the DSL engine admits before dispatch and has no person turn), and
// the engine's own durability (a crashed workflow resumes) is proven in runner-workflow-loop.test.mjs.
import { test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { workflowSubject } from "./conformance-workflow.mjs";

registerHarnessConformance(workflowSubject(), { test });
