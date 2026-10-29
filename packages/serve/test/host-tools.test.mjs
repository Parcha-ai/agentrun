// The file tools a run on another harness gets are pi's, each with the replay the kernel keeps: read may run again
// after a crash, write and edit never (the faux harness does not consult it, so it is checked here, where it is set).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fileTools } from "../dist/host-tools.js";

test("read is replay-safe; write and edit never replay; a name pi has no tool for, or ask_person, gives none", () => {
  const tools = fileTools({}, ["read", "write", "edit", "ask_person", "bash"], ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"]]);
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object", `${tool.name} keeps pi's parameters`);
});
