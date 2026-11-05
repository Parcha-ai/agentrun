// Which tool result ends a parked turn (tool-gate.ts endsTurn, read by harness-app.ts at each tool result): the parked
// call's own, by its id (claude-agent's and codex's host tools, and an MCP call whose id is the adapter's), or, where
// the caller cannot name the id (OpenCode's MCP calls carry none), the next result of the same tool with the same
// arguments, matched by argsDigest. Another tool's result never ends it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { argsDigest, endsTurn } from "../dist/tool-gate.js";

const ARGS = { url: "http://public.example/", depth: { pages: 2, follow: false } };

test("argsDigest is the sha256 of the arguments' canonical JSON: the same however their keys are ordered", () => {
  const canonical = '{"depth":{"follow":false,"pages":2},"url":"http://public.example/"}';
  assert.equal(argsDigest(ARGS), createHash("sha256").update(canonical).digest("hex"));
  assert.equal(argsDigest({ depth: { pages: 2, follow: false }, url: "http://public.example/" }), argsDigest(ARGS));
  assert.notEqual(argsDigest({ ...ARGS, url: "http://other.example/" }), argsDigest(ARGS));
});

test("the parked call's own result ends the turn, by its id", () => {
  assert.equal(endsTurn({ callId: "toolu_1" }, { callId: "toolu_1", tool: "mcp__hands__srv_echo", args: ARGS }), true);
  assert.equal(endsTurn({ callId: "toolu_1" }, { callId: "toolu_2", tool: "mcp__hands__srv_echo", args: ARGS }), false, "another call's result does not");
  assert.equal(endsTurn(undefined, { callId: "toolu_1", tool: "read", args: {} }), false, "nothing parked");
});

test("a park named by its tool and arguments ends the turn at the next result of that tool with those arguments", () => {
  const parked = { tool: "srv_echo", argsDigest: argsDigest(ARGS) };
  assert.equal(endsTurn(parked, { callId: "call_9", tool: "srv_echo", args: { depth: { follow: false, pages: 2 }, url: "http://public.example/" } }), true);
});

test("a park named by its tool and arguments is not ended by another tool's result, nor by the same tool with other arguments", () => {
  const parked = { tool: "srv_echo", argsDigest: argsDigest(ARGS) };
  assert.equal(endsTurn(parked, { callId: "call_8", tool: "read", args: ARGS }), false, "another tool, the same arguments");
  assert.equal(endsTurn(parked, { callId: "call_8", tool: "srv_echo", args: { url: "http://other.example/" } }), false, "the same tool, other arguments");
});

/** A gate whose enter is recorded and lets each call run, the tools it is given, and what ran: `extension(tools, ...rest)`
 *  composed as the registry composes it (a wrap applies by name), then each tool executed once. */
async function composedRun(names, ...rest) {
  const { RunGate } = await import("../dist/tool-gate.js");
  const gate = new RunGate({ root: "/nonexistent", work: "/nonexistent", data: "/nonexistent", runId: "r1" });
  const entered = [];
  gate.enter = async (tool) => void entered.push(tool);
  const executed = [];
  const tool = (name) => ({ name, description: name, parameters: {}, execute: async () => (executed.push(name), { content: [{ type: "text", text: "ok" }] }) });
  const tools = names.map(tool);
  const extension = gate.extension(tools, ...rest);
  const composed = tools.map((given) => extension.wraps.find((wrap) => wrap.tool === given.name)?.wrap(given) ?? given);
  for (const each of composed) await each.execute({}, { callId: `c-${each.name}`, commit: async () => undefined }, {});
  return { wrapped: extension.wraps.map((wrap) => wrap.tool), entered, executed };
}

test("a tool the MCP gateway registers and gates itself is not wrapped again: a call passes one gate, once", async () => {
  const { wrapped, entered, executed } = await composedRun(["read", "mcp__srv__echo"], new Set(["mcp__srv__echo"]));
  assert.deepEqual(wrapped, ["read"], "only the tool not gated elsewhere is wrapped");
  assert.deepEqual(executed, ["read", "mcp__srv__echo"], "each tool's own execute, once");
  assert.deepEqual(entered, ["read"], "the gate entered for the host tool alone; the gateway enters for its own");
});

test("an mcp__-named tool the gateway does not gate is wrapped as any tool is: no name goes around the gate by its prefix", async () => {
  const { wrapped, entered } = await composedRun(["read", "mcp__srv__echo", "mcp__other__ping"], new Set(["mcp__srv__echo"]));
  assert.deepEqual(wrapped, ["read", "mcp__other__ping"], "the tool not named as gated elsewhere is wrapped");
  assert.deepEqual(entered, ["read", "mcp__other__ping"], "the gate is entered for it");
});

test("with no tool named as gated elsewhere, every mcp__ tool is wrapped and passes the gate", async () => {
  const { wrapped, entered } = await composedRun(["read", "mcp__srv__echo"]);
  assert.deepEqual(wrapped, ["read", "mcp__srv__echo"]);
  assert.deepEqual(entered, ["read", "mcp__srv__echo"]);
});
