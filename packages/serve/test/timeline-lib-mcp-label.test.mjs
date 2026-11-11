// A remote MCP server's tool call reads `<server> · <tool>` on the timeline and where calls are counted, whichever
// harness made it; a harness's own tools (`mcp__hands__`) and an unknown tool keep their own words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { labelOf, nameOf, timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

test("an MCP tool's call reads <server> · <tool>; mcp__hands__ and an unknown tool do not", () => {
  assert.equal(labelOf("mcp__fake__add", { a: 2, b: 3 }), "fake · add");
  assert.equal(labelOf("mcp__git-hub__create_issue", {}), "git-hub · create_issue");
  assert.equal(nameOf("mcp__fake__add"), "fake · add");
  assert.equal(labelOf("mcp__hands__read", {}), "Using tool: mcp__hands__read");
  assert.equal(labelOf("mcp__Bad__x", {}), "Using tool: mcp__Bad__x", "a server's name is lowercase");
  const rows = timelineOf([user("Add."), assistant([call("c1", "mcp__fake__add", { a: 2, b: 3 })]), result("c1", "mcp__fake__add", "5")], { settled: true });
  assert.equal(rows.find((row) => row.kind === "tool_use")?.summary, "fake · add");
});
