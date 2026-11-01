// The host tools a run on another harness gets are pi's, each with the replay the kernel keeps: read, fetch_page,
// web_fetch and web_search may run again after a crash, write and edit never (the faux harness does not consult it, so
// it is checked here, where it is set).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hostTools } from "../dist/host-tools.js";

test("read, fetch_page, web_fetch and web_search are replay-safe; write and edit never replay; a name pi has no tool for, ask_person or browser, gives none", () => {
  const tools = hostTools({}, ["read", "write", "edit", "fetch_page", "web_fetch", "web_search", "ask_person", "browser", "bash"], ctx, new Map());
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["edit", "never"], ["fetch_page", "safe"], ["web_fetch", "safe"], ["web_search", "safe"]]);
  for (const tool of tools) assert.equal(tool.inputSchema.type, "object", `${tool.name} keeps pi's parameters`);
});
