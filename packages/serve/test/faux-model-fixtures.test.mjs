// The gate tests' fake models (fixtures/faux-gate.mjs, fixtures/faux-mcp.mjs) answer what a request's history says, not
// what its very last message happens to be. A request whose last message carries no text (an assistant message holding
// only a tool call, an empty tool result, an empty user message) still reads the last thing the model was told; a request
// made after the call's result is in never makes the call again. Under CI load an extra or reordered model request
// otherwise read a bare "Saw:" (F39, F40) or made a third MCP call where two were expected; a real extra request is the
// tests' request-count assertions' to catch, not the fixtures' to trip on.
import assert from "node:assert/strict";
import { test } from "node:test";
import gate from "./fixtures/faux-gate.mjs";
import mcp from "./fixtures/faux-mcp.mjs";

/** pi's faux helpers, as the fixtures use them: a message from its content, and a tool call. */
const faux = {
  message: (content, options = {}) => ({ content, ...options }),
  toolCall: (name, args) => ({ type: "toolCall", name, arguments: args }),
  text: (text) => ({ type: "text", text }),
};
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const said = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const called = (name, args) => ({ role: "assistant", content: [{ type: "toolCall", name, arguments: args }] });
const result = (toolName, text) => ({ role: "toolResult", toolName, content: [{ type: "text", text }] });

const ASK = "Fetch http://public.example/ once.";
const RESUME = "[tool approval] This answers your web_fetch call c1 (arguments {}), which waited for a person's approval.";
const fetched = [user(ASK), called("web_fetch", { url: "http://public.example/" }), result("web_fetch", "the call waits for a person's approval")];

test("faux-gate answers \"Saw: \" and the last message that has text, whatever empty message follows it", () => {
  for (const [what, tail] of [
    ["an assistant message holding only a tool call", called("web_fetch", { url: "http://public.example/" })],
    ["an empty tool result", result("web_fetch", "")],
    ["an empty user message", user("")],
  ]) {
    const reply = gate({ systemPrompt: ASK, messages: [...fetched, user(RESUME), tail] }, faux);
    assert.equal(reply.content, `Saw: ${RESUME}`, `after ${what}`);
  }
  // As before: the resume itself last.
  assert.equal(gate({ systemPrompt: ASK, messages: [...fetched, user(RESUME)] }, faux).content, `Saw: ${RESUME}`);
});

test("faux-mcp answers with the call's result once it is in, and never makes the call again on a later request", () => {
  const ask = 'Call add with {"a":2,"b":3}';
  const done = [user(ask), called("add", { a: 2, b: 3 }), result("add", "5")];
  // As before: the result last.
  assert.equal(mcp({ messages: done }, faux).content, "The tool said: 5");
  // A request after its own answer (an extra request): the same answer, no second call.
  const again = mcp({ messages: [...done, said("The tool said: 5")] }, faux);
  assert.equal(again.stopReason, undefined, `no tool call: ${JSON.stringify(again)}`);
  assert.equal(again.content, "The tool said: 5");
  // A new message after the result is a new ask: it calls again.
  const next = mcp({ messages: [...done, said("The tool said: 5"), user(ask)] }, faux);
  assert.equal(next.stopReason, "toolUse", "a new message calls again");
});
