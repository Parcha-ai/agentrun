// Which tool result ends a parked turn (tool-gate.ts endsTurn, read by harness-app.ts at each tool result): the parked
// call's own, by its id (claude-agent's and codex's host tools, and an MCP call whose id is the adapter's), or, where
// the caller cannot name the id (OpenCode's MCP calls carry none), the next result of the same tool with the same
// arguments, matched by argsDigest. Another tool's result never ends it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { argsDigest, endsTurn } from "../dist/tool-gate.js";
import { scratch } from "./support.mjs";

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

/** The tools named, each with its own execute recorded; a name in `marked` carries GATED_BY_GATEWAY, as the MCP gateway
 *  marks the registrations whose calls it gates itself. */
function toolsOf(names, marked, executed, GATED_BY_GATEWAY) {
  return names.map((name) => ({ name, description: name, parameters: {}, execute: async () => (executed.push(name), { output: [{ type: "text", text: "ok" }] }), ...(marked.includes(name) ? { [GATED_BY_GATEWAY]: true } : {}) }));
}
/** `extension(tools)` composed as the registry composes it (a wrap applies by name), then each tool executed once. */
async function executeEach(extension, tools) {
  const composed = tools.map((given) => extension.wraps.find((wrap) => wrap.tool === given.name)?.wrap(given) ?? given);
  const answers = [];
  for (const each of composed) answers.push(await each.execute({}, { callId: `c-${each.name}`, commit: async () => undefined }, {}));
  return answers;
}
/** A gate whose enter is recorded and lets each call run, over the tools named (those in `marked` marked as gated by the
 *  gateway): what it wrapped, what it entered for, and what ran. */
async function composedRun(names, marked = []) {
  const { RunGate, GATED_BY_GATEWAY } = await import("../dist/tool-gate.js");
  const gate = new RunGate({ root: "/nonexistent", work: "/nonexistent", data: "/nonexistent", runId: "r1" });
  const entered = [];
  gate.enter = async (tool) => void entered.push(tool);
  const executed = [];
  const tools = toolsOf(names, marked, executed, GATED_BY_GATEWAY);
  const extension = gate.extension(tools);
  await executeEach(extension, tools);
  return { wrapped: extension.wraps.map((wrap) => wrap.tool), entered, executed };
}

test("a registration the MCP gateway marks as gated by itself is not wrapped again: a call passes one gate, once", async () => {
  const { wrapped, entered, executed } = await composedRun(["read", "mcp__srv__echo"], ["mcp__srv__echo"]);
  assert.deepEqual(wrapped, ["read"], "only the unmarked tool is wrapped");
  assert.deepEqual(executed, ["read", "mcp__srv__echo"], "each tool's own execute, once");
  assert.deepEqual(entered, ["read"], "the gate entered for the host tool alone; the gateway enters for its own");
});

test("an unmarked mcp__-named tool is wrapped as any tool is: no name goes around the gate by its prefix", async () => {
  const { wrapped, entered } = await composedRun(["read", "mcp__srv__echo", "mcp__other__ping"], ["mcp__srv__echo"]);
  assert.deepEqual(wrapped, ["read", "mcp__other__ping"], "the unmarked mcp__ tool is wrapped");
  assert.deepEqual(entered, ["read", "mcp__other__ping"], "the gate is entered for it");
});

test("a FORGED gateway mark (the global Symbol.for key) is no mark: that tool is wrapped and gated; only the gateway's own export skips the gate", async () => {
  const { RunGate, GATED_BY_GATEWAY } = await import("../dist/tool-gate.js");
  const gate = new RunGate({ root: "/nonexistent", work: "/nonexistent", data: "/nonexistent", runId: "r1" });
  const entered = [];
  gate.enter = async (tool) => void entered.push(tool);
  const executed = [];
  const forged = Symbol.for("agentrun.gatedByGateway");
  const tool = (name, mark) => ({ name, description: name, parameters: {}, execute: async () => (executed.push(name), { output: [{ type: "text", text: "ok" }] }), ...(mark ? { [mark]: true } : {}) });
  const tools = [tool("mcp__evil__forged", forged), tool("mcp__srv__echo", GATED_BY_GATEWAY)];
  const extension = gate.extension(tools);
  await executeEach(extension, tools);
  assert.notEqual(GATED_BY_GATEWAY, forged, "the gateway's mark is not the global registry's symbol");
  assert.deepEqual(extension.wraps.map((wrap) => wrap.tool), ["mcp__evil__forged"], "the forged mark is wrapped");
  assert.deepEqual(entered, ["mcp__evil__forged"], "the gate is entered for it");
});

test("an unmarked mcp__ tool under its server's deny is refused at the gate, and its own execute never runs", async (t) => {
  const { RunGate, GATED_BY_GATEWAY } = await import("../dist/tool-gate.js");
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  await writeFile(join(data, "tool-settings.json"), JSON.stringify({ "mcp:srv/*": { permission: "deny" } }));
  const gate = new RunGate({ root, work, data, runId: "r1" });
  const executed = [];
  const tools = toolsOf(["mcp__srv__echo"], [], executed, GATED_BY_GATEWAY);
  const [answer] = await executeEach(gate.extension(tools), tools);
  assert.deepEqual(executed, [], "the tool's own execute never ran");
  assert.equal(answer.isError, true, "the call is answered refused");
  assert.match(JSON.stringify(answer.output), /Permission denied/, "under output, the key pi 1.5 gives the model");
});
