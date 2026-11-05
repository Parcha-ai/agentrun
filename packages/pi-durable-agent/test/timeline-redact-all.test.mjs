// No key on the Timeline anywhere: the rows a model writes go through the host's `redact` before anything is taken or
// cut from them, as an error's and a tool result's already do. A tool call's arguments (its label, its input preview,
// what a submit's answer or a subagent's task shows), a thinking block and a text block (settled, and live while they
// stream, a key split across two deltas included), and the URLs a browser `run` says it sent.
// The redactor stands in for serve's (learning's redactSecrets over its held keys): it takes out the held value written
// plainly or base64-encoded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, inConv, result, user } from "./timeline-support.mjs";

/** A held key, made at runtime: no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "held-model-key", "0123456789ab"].join("-");
const B64 = Buffer.from(KEY).toString("base64");
const redact = (text) => text.split(KEY).join("[redacted]").split(B64).join("[redacted]");
/** Whether `text` holds any 8-character run of `secret`. */
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};
const leaks = (rows) => [KEY, B64].filter((form) => holdsRun(JSON.stringify(rows), form));
const shown = (rows) => JSON.stringify(rows.map((r) => [r.kind, r.summary, r.tool_input_preview, r.text]));

test("a tool call whose arguments hold a held key, plainly and base64-encoded: no form of it on the call's row or its result's", () => {
  const args = { command: `curl -H "Authorization: Bearer ${KEY}" https://api.example/v1/items`, description: `auth ${B64}` };
  const rows = timelineOf([user("Call the API."), assistant([call("b1", "bash", args)]), result("b1", "bash", "200 OK")], { redact });
  assert.deepEqual(leaks(rows), [], shown(rows));
});

test("the same arguments when the result comes before its call: no form of the key once the call's row names it", () => {
  const args = { command: `curl -H "Authorization: Bearer ${KEY}" https://api.example/v1/items` };
  const rows = timelineOf([user("Call the API."), result("b1", "bash", "200 OK"), assistant([call("b1", "bash", args)])], { redact });
  assert.deepEqual(leaks(rows), [], shown(rows));
});

test("a nested call's arguments (a subagent's), live: no form of the key on its rows", () => {
  const reducer = timelineReducer({ redact });
  const entries = [
    user("Delegate it."),
    assistant([call("t1", "task", { description: `use ${KEY}`, prompt: `Call the API with ${B64}.` })]),
    inConv(user("Call the API."), 2),
    inConv(assistant([call("b1", "bash", { command: `echo ${KEY}` })]), 2),
    inConv(result("b1", "bash", "ok"), 2),
    result("t1", "task", "done", 0, { details: { conversationId: 2 } }),
  ];
  reducer.apply(entries.map((entry) => ({ type: "entry_appended", entry })));
  const rows = reducer.rows();
  assert.ok(rows.some((r) => r.kind === "tool_use" && r.tool_name === "bash"), JSON.stringify(rows.map((r) => r.kind)));
  assert.deepEqual(leaks(rows), [], shown(rows));
});

test("a submit whose answer quotes a held key: the final answer row holds no form of it", () => {
  const rows = timelineOf([user("Answer."), assistant([call("s1", "submit", { answer: `The key is ${KEY}.` })]), result("s1", "submit", "ok")], { redact });
  assert.ok(rows.some((r) => r.kind === "final_answer"), JSON.stringify(rows.map((r) => r.kind)));
  assert.deepEqual(leaks(rows), [], shown(rows));
});

test("a thinking block and a text block quoting a held key, settled: no form of it on either row", () => {
  const rows = timelineOf([user("Think."), assistant([{ type: "thinking", thinking: `I will use ${KEY} now.` }, { type: "text", text: `The key is ${B64}.` }])], { redact });
  assert.ok(rows.some((r) => r.kind === "thinking") && rows.some((r) => r.kind === "final_answer"), JSON.stringify(rows.map((r) => r.kind)));
  assert.deepEqual(leaks(rows), [], shown(rows));
});

test("a key streamed across two deltas, live: no row holds any part of it, before or after the second delta", () => {
  // The host holds back a streaming block's tail (redactLive, below), as serve does.
  const reducer = timelineReducer({ conversationId: 1, redact, redactLive });
  reducer.apply([{ type: "message_start", message: { role: "assistant", content: [] } }]);
  const [head, tail] = [KEY.slice(0, 20), KEY.slice(20)];
  const first = reducer.apply([{ type: "message_update", usage: {}, changes: [
    { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
    { type: "thinking_delta", contentIndex: 0, delta: `Using ${head}` },
    { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 1, delta: `The key is ${head}` },
  ] }]);
  assert.deepEqual(leaks(first.rows), [], shown(first.rows));
  const second = reducer.apply([{ type: "message_update", usage: {}, changes: [
    { type: "thinking_delta", contentIndex: 0, delta: `${tail} now.` },
    { type: "text_delta", contentIndex: 1, delta: `${tail}, done.` },
  ] }]);
  assert.deepEqual(leaks(second.rows), [], shown(second.rows));
  assert.deepEqual(leaks(reducer.rows()), [], shown(reducer.rows()));
  const done = reducer.apply([{ type: "message_end", entry: assistant([{ type: "thinking", thinking: `Using ${KEY} now.` }, { type: "text", text: `The key is ${KEY}, done.` }]) }]);
  assert.deepEqual(leaks(done.rows), [], shown(done.rows));
  assert.deepEqual(leaks(reducer.rows()), [], shown(reducer.rows()));
});

test("a browser run whose sent URL holds a held key in its path and its query: the run's label shows no form of it", () => {
  const sent = [{ method: "GET", url: `https://api.example/v1/${KEY}/items?token=${KEY}&b=${B64}` }];
  const rows = timelineOf([user("Act on the page."), assistant([call("r1", "run", { code: "await page.click('#go')" })]), result("r1", "run", "ok", 0, { details: { sent } })], { redact });
  assert.ok(rows.some((r) => r.kind === "tool_result" && /request sent/.test(r.summary ?? "")), shown(rows));
  assert.deepEqual(leaks(rows), [], shown(rows));
});

// A key a stream wraps (its head in one delta, a line break and its tail in the next) is found only when the redactor
// sees the whole stream, and one whose tail has not streamed yet cannot be found at all. So a live block shows what the
// host's `redactLive` returns of its whole stream: the stream redacted whole, then held back by a fixed tail, the most a
// held value can take in its widest form. The stand-ins below find the key split by whitespace, and hold back HOLD.
const SPLIT = new RegExp([...KEY].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "g");
const redactWs = (text) => text.replace(SPLIT, "[redacted]");
const HOLD = 6 * KEY.length + 16;
const redactLive = (text) => {
  const visible = text.length - HOLD;
  if (visible <= 0) return "";
  const out = redactWs(text);
  const shift = text.length - out.length + 2 * (out.split("[redacted]").length - 1);
  const keep = visible - shift;
  return keep <= 0 ? "" : out.slice(0, keep);
};
const PAD = "Working through the request, step by step, with care. ".repeat(12);

for (const [how, kind, start, delta] of [["thinking", "thinking", "thinking_start", "thinking_delta"], ["text", "text", "text_start", "text_delta"]]) {
  test(`a live ${how} block whose key is wrapped across two deltas (head, then a line break and the tail): no update shows any part of it`, () => {
    const reducer = timelineReducer({ conversationId: 1, redact: redactWs, redactLive });
    reducer.apply([{ type: "message_start", message: { role: "assistant", content: [] } }]);
    const [head, tail] = [KEY.slice(0, 20), KEY.slice(20)];
    const updates = [
      reducer.apply([{ type: "message_update", usage: {}, changes: [{ type: start, contentIndex: 0, block: { type: kind, [kind]: "" } }, { type: delta, contentIndex: 0, delta: `${PAD}Using ${head}` }] }]),
      // The stream ends on the tail: as its last word, a holdback of the last word would drop it and leave the head.
      reducer.apply([{ type: "message_update", usage: {}, changes: [{ type: delta, contentIndex: 0, delta: `\n${tail}` }] }]),
      reducer.apply([{ type: "message_update", usage: {}, changes: [{ type: delta, contentIndex: 0, delta: ` now. ${PAD}` }] }]),
    ];
    for (const update of updates) assert.deepEqual(leaks(update.rows), [], shown(update.rows));
    assert.deepEqual(leaks(reducer.rows()), [], shown(reducer.rows()));
  });

  test(`a live ${how} block where only a key's head has streamed: no update shows any part of it`, () => {
    const reducer = timelineReducer({ conversationId: 1, redact: redactWs, redactLive });
    reducer.apply([{ type: "message_start", message: { role: "assistant", content: [] } }]);
    const update = reducer.apply([{ type: "message_update", usage: {}, changes: [{ type: start, contentIndex: 0, block: { type: kind, [kind]: "" } }, { type: delta, contentIndex: 0, delta: `${PAD}Using ${KEY.slice(0, 20)}` }] }]);
    assert.deepEqual(leaks(update.rows), [], shown(update.rows));
    assert.deepEqual(leaks(reducer.rows()), [], shown(reducer.rows()));
  });
}

// A host that passes only `redact` (no redactLive): a key whose tail has not streamed yet cannot be found, so the live
// block holds back its trailing word until whitespace follows it or the block ends.
for (const [how, kind, start, delta] of [["thinking", "thinking", "thinking_start", "thinking_delta"], ["text", "text", "text_start", "text_delta"]]) {
  test(`with only redact, a live ${how} block where a key's head has streamed and then its tail: no update shows any part of it`, () => {
    const reducer = timelineReducer({ conversationId: 1, redact });
    reducer.apply([{ type: "message_start", message: { role: "assistant", content: [] } }]);
    const updates = [
      reducer.apply([{ type: "message_update", usage: {}, changes: [{ type: start, contentIndex: 0, block: { type: kind, [kind]: "" } }, { type: delta, contentIndex: 0, delta: `Using ${KEY.slice(0, 20)}` }] }]),
      reducer.apply([{ type: "message_update", usage: {}, changes: [{ type: delta, contentIndex: 0, delta: `${KEY.slice(20)} now. Done` }] }]),
    ];
    for (const update of updates) assert.deepEqual(leaks(update.rows), [], shown(update.rows));
    assert.deepEqual(leaks(reducer.rows()), [], shown(reducer.rows()));
    assert.ok(reducer.rows().some((r) => /\[redacted\] now\./.test(r.text ?? "")), shown(reducer.rows()));
  });
}

test("a person's message that holds a held key: its row's summary and text hold no form of it, settled and live", () => {
  const entries = [user(`Use ${KEY} for the call, or ${B64}.`), assistant([{ type: "text", text: "Done." }])];
  const rows = timelineOf(entries, { redact });
  const own = rows.filter((r) => r.kind === "user_message");
  assert.equal(own.length, 1, JSON.stringify(rows.map((r) => r.kind)));
  assert.deepEqual(leaks(own), [], shown(own));
  assert.equal(own[0].text, "Use [redacted] for the call, or [redacted].");
  const reducer = timelineReducer({ redact });
  reducer.apply(entries.map((entry) => ({ type: "entry_appended", entry })));
  assert.deepEqual(leaks(reducer.rows().filter((r) => r.kind === "user_message")), [], shown(reducer.rows()));
});
