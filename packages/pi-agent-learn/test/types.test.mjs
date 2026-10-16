import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTRY_TYPES, LEARN_TYPES } from "../dist/index.js";

test("the learn types and entry types are fixed lists", () => {
  assert.deepEqual([...LEARN_TYPES], ["lesson", "fact", "correction", "used"]);
  assert.deepEqual([...ENTRY_TYPES], ["lesson", "fact", "correction"]);
  assert.throws(() => LEARN_TYPES.push("note"), TypeError);
  assert.throws(() => ENTRY_TYPES.push("used"), TypeError);
});
