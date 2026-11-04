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
