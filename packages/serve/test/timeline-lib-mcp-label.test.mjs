// A remote MCP server's tool call reads `<server> · <tool>` on the timeline and where calls are counted, whichever
// harness made it; a harness's own tools (`mcp__hands__`) and an unknown tool keep their own words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CALL_REFUSED, labelOf, nameOf, timelineOf } from "../dist/timeline/index.js";
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

test("a long MCP tool's hashed wire name is labelled by its catalog name (options.catalog), on its call, its result and its refusal", () => {
  const LONG = "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION";
  const wire = "mcp__slack__SLACK_FETCH_MESSAGE_THREAD_FROM-6f55cda1";
  assert.equal(labelOf(`mcp:slack/${LONG}`, {}), `slack · ${LONG}`, "a catalog name reads <server> · <tool>");
  assert.equal(labelOf("mcp:hands/read", {}), "Using tool: mcp:hands/read");
  const catalog = new Map([[wire, `mcp:slack/${LONG}`]]);
  const refused = { isError: true, details: { [CALL_REFUSED]: true } };
  const rows = timelineOf([user("Fetch."), assistant([call("c1", wire, { channel: "C1" }), call("c2", wire, { channel: "C2" })]), result("c1", wire, "3 replies"), result("c2", wire, "Permission denied.", 1, refused)], { settled: true, catalog });
  assert.deepEqual(rows.filter((row) => row.kind.startsWith("tool")).map((row) => [row.tool_use_id, row.kind, row.summary]), [
    ["c1", "tool_use", `slack · ${LONG}`],
    ["c2", "tool_use", `Refused: slack · ${LONG}`],
    ["c1", "tool_result", `slack · ${LONG}: ok`],
    ["c2", "tool_result", `Refused: slack · ${LONG}: Permission denied.`],
  ]);
  // Without the run's catalog the hashed name reads as what it is, never as a tool of that name.
  assert.notEqual(timelineOf([user("Fetch."), assistant([call("c1", wire, {})]), result("c1", wire, "3 replies")], { settled: true }).find((row) => row.kind === "tool_use")?.summary, `slack · ${LONG}`);
});
