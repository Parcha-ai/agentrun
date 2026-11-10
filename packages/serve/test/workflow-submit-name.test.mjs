// The runner names a workflow model node's submit tool itself (runner/workflow-spec.ts SUBMIT_TOOL) rather than import it
// from @parcha/agentrun-pi, whose root loads pi's runner and an optional peer an installed server lacks. The two names stay one.
import assert from "node:assert/strict";
import { test } from "node:test";

test("the runner's submit tool name is pi's", async () => {
  const { SUBMIT_TOOL: runners } = await import("../dist/runner/workflow-spec.js");
  const { SUBMIT_TOOL: pis } = await import("@parcha/agentrun-pi");
  assert.equal(runners, pis);
});
