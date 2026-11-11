// Whether a run's job gave nothing new to look back on (runner/learning-end.ts onlyLearnedWorkflows), read from its
// timeline's rows: it called tools, every one learned_workflow (by its own name, or claude-agent's host-tool alias), each
// answering; no tool result failed; no error, approval or wait; and one message, its first, came in. The end-of-run
// turn's own rows (labelled learning) are left out. Anything else is asked its end-of-run turn.
import assert from "node:assert/strict";
import { test } from "node:test";

const { onlyLearnedWorkflows } = await import("../dist/runner/learning-end.js");

const row = (kind, extra = {}) => ({ id: `${kind}-${Math.random()}`, kind, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, ...extra });
const asked = row("user_message");
const call = (name, id = "c1", extra = {}) => [row("tool_use", { tool_name: name, tool_use_id: id, ...extra }), row("tool_result", { tool_name: name, tool_use_id: id, tool_status: "success", ...extra })];
const answer = row("final_answer");

test("only learned workflows, each answering, after one message: nothing new", () => {
  assert.equal(onlyLearnedWorkflows([asked, ...call("learned_workflow"), answer]), true);
  assert.equal(onlyLearnedWorkflows([asked, ...call("learned_workflow", "c1"), ...call("learned_workflow", "c2"), answer]), true, "two calls");
  assert.equal(onlyLearnedWorkflows([asked, ...call("mcp__hands__learned_workflow"), answer]), true, "claude-agent's host-tool alias");
  // A workflow's own nested calls are its.
  assert.equal(onlyLearnedWorkflows([asked, ...call("learned_workflow"), ...call("web_fetch", "n1", { parent_tool_use_id: "c1" }), answer]), true, "a nested call node");
  // The end-of-run turn's own rows (a re-claim's) are left out.
  assert.equal(onlyLearnedWorkflows([asked, ...call("learned_workflow"), answer, row("user_message", { agent_label: "learning" }), row("text_block", { agent_label: "learning" })]), true, "the turn's own rows");
});

test("anything else is asked: no call, another tool, an MCP server's tool of the same name, a failed or unanswered call, a nested failure, a follow-up, an approval, a wait, an error", () => {
  const cases = {
    "no call": [asked, answer],
    "another tool": [asked, ...call("learned_workflow"), ...call("read", "c2"), answer],
    "another server's learned_workflow": [asked, ...call("mcp__other__learned_workflow"), answer],
    "a failed call": [asked, row("tool_use", { tool_name: "learned_workflow", tool_use_id: "c1" }), row("tool_result", { tool_name: "learned_workflow", tool_use_id: "c1", tool_status: "failed" }), answer],
    "a call with no result": [asked, row("tool_use", { tool_name: "learned_workflow", tool_use_id: "c1" }), answer],
    "a nested failure": [asked, ...call("learned_workflow"), ...call("web_fetch", "n1", { parent_tool_use_id: "c1", tool_status: "failed" }), answer],
    "a follow-up": [asked, ...call("learned_workflow"), answer, row("user_message"), answer],
    "a server's message (a raise's resume)": [asked, ...call("learned_workflow"), row("phase", { origin: "server" }), answer],
    "an approval": [asked, ...call("learned_workflow"), row("tool_approval_requested", { tool_name: "learned_workflow", tool_use_id: "c1" }), answer],
    "a wait": [asked, row("waiting"), ...call("learned_workflow"), answer],
    "an error": [asked, ...call("learned_workflow"), row("error")],
  };
  for (const [why, rows] of Object.entries(cases)) assert.equal(onlyLearnedWorkflows(rows), false, why);
});
