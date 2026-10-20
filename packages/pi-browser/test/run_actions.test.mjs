import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_TOOLS } from "@parcha/pi-browser";
import { RUN_ACTION_OPS } from "./types/run-action-ops.mjs";

test("the run actions the types name are exactly the ones the contract's schema admits", () => {
  const run = BROWSER_TOOLS.find((tool) => tool.name === "run");
  const ops = run.parameters.properties.actions.items.oneOf.map((schema) => schema.properties.op.const);
  assert.deepEqual([...ops].sort(), [...RUN_ACTION_OPS].sort());
});
