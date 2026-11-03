// A call by an MCP name of a registered tool (the Claude CLI's `mcp__hands__web_fetch`, or a model's own
// `mcp__hands://web_fetch`) reads as that tool wherever a person reads it: its name, its label, its fold and its outcome.
// An MCP tool no one registered keeps the name it was called by.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as timeline from "../dist/timeline/index.js";

const { callFailed, foldLabel, labelOf, nameOf, registerLabel } = timeline;
const refused = JSON.stringify({ ok: false, url: "http://127.0.0.1/", refused: "refused: 127.0.0.1 is not a public host" });
const args = { url: "https://example.com/pricing" };
const calls = [{ input: "https://example.com/a", output: null }, { input: "https://example.org/b", output: null }];

test("an MCP name of a registered tool is that tool's: its name, its label, its fold and its outcome", () => {
  for (const wrapped of ["mcp__hands__web_fetch", "mcp__hands://web_fetch"]) {
    assert.equal(timeline.toolOf?.(wrapped), "web_fetch", wrapped);
    assert.equal(nameOf(wrapped), "Fetch web pages", wrapped);
    assert.equal(labelOf(wrapped, args), labelOf("web_fetch", args), wrapped);
    assert.equal(foldLabel(wrapped, calls), foldLabel("web_fetch", calls), wrapped);
    assert.equal(callFailed(wrapped, { text: refused, isError: false }), true, `${wrapped}: a refused fetch fails`);
  }
});

test("an MCP tool no one registered keeps the name it was called by", () => {
  for (const name of ["mcp__github__create_issue", "mcp__hands__no_such_tool"]) {
    assert.equal(timeline.toolOf?.(name), name);
    assert.equal(nameOf(name), name);
    assert.equal(labelOf(name, {}), `Using tool: ${name}`);
  }
});

test("a registered tool with no display name is named by itself, never by its MCP wrapping", () => {
  registerLabel("probe_tool", () => "Probed");
  assert.equal(nameOf("mcp__hands__probe_tool"), "probe_tool");
  assert.equal(labelOf("mcp__hands__probe_tool", {}), "Probed");
});
