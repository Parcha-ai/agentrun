// What a run waiting on an ACP agent's own call serves as its `pending` card (store-view.ts), in its view and in its list
// row: the agent's own arguments (the gate call's `input`), never the gate's wrapper around them ({ title, kind, input,
// toolCallId }), and what the call does in words (its command, else its title) as the card's summary. Both go through
// the run's one redactor first, so a key this server keeps, inside the agent's input, is served masked.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { viewOverStore, summaryOverStore } = await import("../dist/store-view.js");

const ROOT = 1;
/** A key this server keeps: built at run time, never a literal. */
const KEY = ["not-a-secret", "acp-key", randomBytes(8).toString("hex")].join("-");
const deps = { origin: "https://run.test", serverSecrets: () => [KEY] };

/** run-1, whose turn ended on the ACP gate's call `args` (run-adapters-acp's permissionGateCall), parked on its ask. */
async function waitingOn(t, tool, args) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "alpha", name: "Alpha" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "alpha", revisionId: "rev-1" }, { body: { input: { message: "Help me." } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const entries = [
    { kind: "pi.user", model: [{ role: "user", content: "Help me.", timestamp: T0 }] },
    { kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: tool, arguments: args }], timestamp: T0 + 1_000 }] },
    { kind: "agentrun.ask", data: { callId: "c1", tool, args, requestedAt: new Date(T0 + 1_500).toISOString() } },
  ];
  const writes = [{ type: "conversation", value: { id: ROOT } }];
  for (const entry of entries) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, ...entry } });
  await commitWrites(journal, writes, context);
  await store.runs.update(claim, { state: "parked" });
  await store.release(claim);
  return store;
}

async function pendings(store) {
  return { view: (await viewOverStore(store, "run-1", deps)).pending, summary: (await summaryOverStore(store, "run-1", deps)).pending };
}

const GATE_WORDS = /toolCallId|toolu_|"title"|"kind"|"input"/;

test("an ACP agent's call with a command serves the agent's own input as its arguments and the command as its summary, a kept key masked in both", async (t) => {
  const command = `curl -H 'Authorization: Bearer ${KEY}' https://example.test/a\nls -la`;
  const store = await waitingOn(t, "acp_execute", { title: "Fetch a", kind: "execute", input: { CommandLine: command, WaitMsBeforeAsync: 500 }, toolCallId: "toolu_01abcdef" });
  const { view, summary } = await pendings(store);
  for (const [where, pending] of Object.entries({ view, summary })) {
    assert.equal(pending?.kind, "approval", `${where}: ${JSON.stringify(pending)}`);
    assert.doesNotMatch(JSON.stringify(pending), new RegExp(KEY), `${where}: the kept key is masked`);
    assert.deepEqual(JSON.parse(pending.args_preview), { CommandLine: "curl -H 'Authorization: Bearer [redacted]' https://example.test/a\nls -la", WaitMsBeforeAsync: 500 }, `${where}: the agent's own input, redacted`);
    assert.doesNotMatch(pending.args_preview, GATE_WORDS, `${where}: none of the gate's wrapper`);
    assert.equal(pending.summary, "curl -H 'Authorization: Bearer [redacted]' https://example.test/a\nls -la", `${where}: its command, newlines kept`);
  }
});

test("an ACP agent's call with no input (Cursor's) serves empty arguments and its title as its summary", async (t) => {
  const store = await waitingOn(t, "acp_execute", { title: "python3 fib.py", kind: "execute", input: null, toolCallId: "toolu_02abcdef" });
  const { view, summary } = await pendings(store);
  for (const [where, pending] of Object.entries({ view, summary })) {
    assert.equal(pending?.args_preview, "{}", `${where}: ${JSON.stringify(pending)}`);
    assert.equal(pending.summary, "python3 fib.py", where);
  }
});

test("an ACP agent's call whose input names no command and no title serves that input, redacted, with no summary", async (t) => {
  const store = await waitingOn(t, "acp_edit", { kind: "edit", input: { path: "notes.txt", content: `token ${KEY}` }, toolCallId: "toolu_03abcdef" });
  const { view } = await pendings(store);
  assert.deepEqual(JSON.parse(view.args_preview), { path: "notes.txt", content: "token [redacted]" });
  assert.equal(view.summary, undefined);
});

test("an ACP agent's call to another MCP server names that server first in its summary, the one the adapter recorded, though its input is empty", async (t) => {
  // Cursor asks with input {} and a title of its own making; the adapter records the server the call belongs to beside it
  // (permissionGateCall's `server`). Dropping the wrapper must not drop that server: a person approves knowing whose call it is.
  const store = await waitingOn(t, "acp_other", { title: "agentrun-look_up: look_up", kind: "other", input: {}, toolCallId: "toolu_04abcdef", server: "other-mcp" });
  const { view, summary } = await pendings(store);
  for (const [where, pending] of Object.entries({ view, summary })) {
    assert.equal(pending?.args_preview, "{}", `${where}: ${JSON.stringify(pending)}`);
    assert.equal(pending.summary, 'Calls MCP server "other-mcp": agentrun-look_up: look_up', where);
  }
  const named = await waitingOn(t, "acp_other", { kind: "other", input: { q: 1 }, toolCallId: "toolu_05abcdef", server: "other-mcp" });
  const { view: alone } = await pendings(named);
  assert.equal(alone.summary, 'Calls MCP server "other-mcp"', "a call naming neither command nor title still names its server");
  assert.deepEqual(JSON.parse(alone.args_preview), { q: 1 });
});

test("any other tool's call keeps its whole arguments, even ones shaped like the gate's", async (t) => {
  const args = { title: "t", kind: "k", input: { q: 1 }, toolCallId: "x" };
  const store = await waitingOn(t, "web_fetch", args);
  const { view } = await pendings(store);
  assert.deepEqual(JSON.parse(view.args_preview), args);
  assert.equal(view.summary, undefined);
});
