// A pin (tool-gate.ts pinRefusal): an MCP tool's setting may fix top-level arguments, and the gate refuses a call whose
// arguments are not as pinned before it runs or asks anyone, whatever the permission. The agent's pin and the server's
// both hold; two that fix one argument differently refuse every call. Settings validate a pin (an MCP tool's own key,
// 1 to 8 arguments, JSON scalars), the server keeps it, and a pin in its file that does not read fails closed.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pinRefusal, RunGate } from "../dist/tool-gate.js";
import { canonicalToolSettings, pinIssues, readToolSettings, settingsIssues, sortedPin, ToolSettings, withDefaults } from "../dist/tool-plane.js";
import { scratch } from "./support.mjs";

const SEND = "mcp:slack/slack_send_message";

test("the gate's decision: a call carrying every pinned argument as pinned passes; any other is refused in words the model reads", () => {
  const agent = { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } };
  assert.equal(pinRefusal(SEND, { channel_id: "C0123", message: "hi" }, {}, agent), undefined);
  const refused = pinRefusal(SEND, { channel_id: "C0EVIL", message: "hi" }, {}, agent);
  assert.match(refused.text, /^mcp:slack\/slack_send_message may only be called with channel_id = C0123: its destination is fixed by the agent's settings\. It was not run: nothing was sent and nothing was charged\.$/);
  assert.deepEqual(refused.mismatched, ["channel_id"]);
  // Left out, the wrong type, or no arguments at all: refused.
  for (const args of [{ message: "hi" }, { channel_id: ["C0123"] }, null, undefined, "C0123"]) assert.ok(pinRefusal(SEND, args, {}, agent), JSON.stringify(args));
  // A scalar is matched as the JSON value it is: 5 is not "5".
  const limit = { "mcp:x/list": { pin: { limit: 5, html: false } } };
  assert.equal(pinRefusal("mcp:x/list", { limit: 5, html: false }, {}, limit), undefined);
  assert.ok(pinRefusal("mcp:x/list", { limit: "5", html: false }, {}, limit));
  // null pins an argument out: absent or null holds, anything else (an empty list too) is refused, and said so.
  const mail = { "mcp:gmail/GMAIL_SEND_EMAIL": { pin: { recipient_email: "owner@example.com", bcc: null } } };
  assert.equal(pinRefusal("mcp:gmail/GMAIL_SEND_EMAIL", { recipient_email: "owner@example.com", body: "x" }, {}, mail), undefined);
  assert.equal(pinRefusal("mcp:gmail/GMAIL_SEND_EMAIL", { recipient_email: "owner@example.com", bcc: null }, {}, mail), undefined);
  const bcc = pinRefusal("mcp:gmail/GMAIL_SEND_EMAIL", { recipient_email: "owner@example.com", bcc: ["thief@example.net"] }, {}, mail);
  assert.match(bcc.text, /may only be called with recipient_email = owner@example\.com, bcc absent:/);
  assert.ok(pinRefusal("mcp:gmail/GMAIL_SEND_EMAIL", { recipient_email: "owner@example.com", bcc: [] }, {}, mail));
  // No pin, another tool, or a tool that is no MCP tool: nothing to refuse.
  assert.equal(pinRefusal("mcp:slack/slack_search", { channel_id: "C0EVIL" }, {}, agent), undefined);
  assert.equal(pinRefusal("bash", { channel_id: "C0EVIL" }, {}, { bash: { pin: { channel_id: "C0123" } } }), undefined);
});

test("the agent's pin and the server's both hold: the server's alone binds too, and two that disagree refuse every call", () => {
  const server = { [SEND]: { pin: { channel_id: "C0123" } } };
  assert.match(pinRefusal(SEND, { channel_id: "C0EVIL" }, server, {}).text, /fixed by this server's settings/);
  // Different arguments pinned in each layer: a call holds both.
  const agent = { [SEND]: { permission: "allow", pin: { thread_ts: "1.2" } } };
  assert.equal(pinRefusal(SEND, { channel_id: "C0123", thread_ts: "1.2" }, server, agent), undefined);
  assert.match(pinRefusal(SEND, { channel_id: "C0123" }, server, agent).text, /may only be called with channel_id = C0123, thread_ts = 1\.2: its destination is fixed by the agent's and this server's settings/);
  // The same argument to different values: no call can satisfy both, whatever it carries.
  const clash = { [SEND]: { pin: { channel_id: "C0999" } } };
  for (const channel of ["C0123", "C0999", "C0EVIL"]) {
    const refused = pinRefusal(SEND, { channel_id: channel }, server, clash);
    assert.match(refused.text, /^mcp:slack\/slack_send_message can't be called: this agent's settings fix channel_id = C0999 and this server's fix channel_id = C0123, so no call can satisfy both\./, channel);
  }
  // A server pin wildcard keys never carry (refused at the door) is not read: only the tool's own key binds.
  assert.equal(pinRefusal(SEND, { channel_id: "C0EVIL" }, { "mcp:slack/*": { pin: { channel_id: "C0123" } } }, {}), undefined);
});

test("settings validate a pin: on an MCP tool's own key only, 1 to 8 top-level arguments, each a JSON scalar or a list of them", () => {
  assert.deepEqual(settingsIssues({ [SEND]: { permission: "allow", pin: { channel_id: "C0123", unfurl: false, n: 1, cc: null } } }), []);
  assert.deepEqual(settingsIssues({ [SEND]: { pin: { channel_id: "C0123" } } }), [], "a pin with no permission of its own");
  const reasons = (value) => settingsIssues(value).map((issue) => [issue.field, issue.reason]);
  assert.deepEqual(reasons({ bash: { pin: { command: "ls" } } }), [["bash.pin", "not_allowed"]]);
  assert.deepEqual(reasons({ "monid.run": { pin: { query: "x" } } }), [["monid.run.pin", "not_allowed"]]);
  assert.deepEqual(reasons({ "mcp:slack/*": { pin: { channel_id: "C0123" } } }), [["mcp:slack/*.pin", "not_allowed"]]);
  assert.deepEqual(reasons({ [SEND]: { pin: {} } }), [[`${SEND}.pin`, "wrong_type"]]);
  assert.deepEqual(reasons({ [SEND]: { pin: ["channel_id"] } }), [[`${SEND}.pin`, "wrong_type"]]);
  assert.deepEqual(reasons({ [SEND]: { pin: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`a${i}`, i])) } }), [[`${SEND}.pin`, "wrong_type"]]);
  assert.deepEqual(reasons({ [SEND]: { pin: { channel_id: [["C0123"]] } } }), [[`${SEND}.pin.channel_id`, "wrong_type"]]);
  assert.deepEqual(reasons({ [SEND]: { pin: { channel_id: ["C0123", "C0456"] } } }), [], "a one-of list");
  assert.deepEqual(reasons({ [SEND]: { pin: { channel_id: { id: "C0123" } } } }), [[`${SEND}.pin.channel_id`, "wrong_type"]]);
  assert.deepEqual(reasons({ [SEND]: { pin: { "channel.id": "x", "a b": "C0123" } } }), [[`${SEND}.pin.a b`, "bad_format"]]);
  assert.deepEqual(reasons({ [SEND]: { pin: { channel_id: "x".repeat(1025) } } }), [[`${SEND}.pin.channel_id`, "wrong_type"]]);
  assert.match(settingsIssues({ "mcp:slack/*": { pin: { channel_id: "C0123" } } })[0].message, /one MCP tool's own key/);
});

test("the server keeps a pin: written whole, read back, served; a pin in its file that does not read refuses the tool's every call", async (t) => {
  const data = await scratch(t);
  const settings = new ToolSettings(data, () => undefined);
  const put = settings.put({ [SEND]: { permission: "allow", pin: { channel_id: "C0123" } }, "mcp:slack/*": { permission: "ask" } });
  assert.deepEqual(put[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
  assert.deepEqual(JSON.parse(await readFile(join(data, "tool-settings.json"), "utf8"))[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
  assert.deepEqual(new ToolSettings(data, () => undefined).get()[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
  assert.deepEqual(withDefaults(put)[SEND], { permission: "allow", pin: { channel_id: "C0123" } }, "as served");

  // Hand-edited into something no save writes: never dropped to no pin, which would let every call through.
  await writeFile(join(data, "tool-settings.json"), JSON.stringify({ [SEND]: { permission: "allow", pin: { channel_id: { any: true } } } }));
  const read = readToolSettings(data);
  assert.equal(read.settings[SEND].permission, "allow");
  assert.equal(read.settings[SEND].brokenPin, true);
  assert.equal(read.problems.length, 1);
  assert.equal(withDefaults(read.settings)[SEND].brokenPin, undefined, "never served");
  const gate = new RunGate({ root: await scratch(t), work: await scratch(t), data, runId: "r1" });
  const answer = await gate.enter(SEND, { channel_id: "C0123" }, "c1", { commit: () => assert.fail("nothing parks") });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /its pin in this server's tool settings does not read/);
});

/** A gate on its own data directory, with `agent` the revision's own settings, and a park that records what it commits. */
async function gateOf(t, agent, server) {
  const data = await scratch(t);
  if (server) await writeFile(join(data, "tool-settings.json"), JSON.stringify(server));
  const gate = new RunGate({ root: await scratch(t), work: await scratch(t), data, runId: "r1" }, agent);
  const committed = [];
  const park = { commit: (change) => change({ appendEntry: async (_, entry) => void committed.push(entry) }), parked: () => undefined };
  return { gate, park, committed };
}

test("RunGate.enter: an allowed pinned call runs only as pinned; under ask a call not as pinned is refused and never asks", async (t) => {
  {
    const { gate, park, committed } = await gateOf(t, { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } });
    assert.equal(await gate.enter(SEND, { channel_id: "C0123", message: "hi" }, "c1", park), undefined, "as pinned: it runs");
    const refused = await gate.enter(SEND, { channel_id: "C0EVIL", message: "hi" }, "c2", park);
    assert.deepEqual([refused.isError, refused.parked], [true, undefined]);
    assert.match(refused.text, /may only be called with channel_id = C0123: its destination is fixed by the agent's settings/);
    assert.deepEqual(committed, [], "nothing parked");
  }
  {
    // The MCP default, ask: a call not as pinned is refused at once (no approval waits), one as pinned asks.
    const { gate, park, committed } = await gateOf(t, { [SEND]: { pin: { channel_id: "C0123" } } });
    const refused = await gate.enter(SEND, { channel_id: "C0EVIL" }, "c1", park);
    assert.deepEqual([refused.isError, refused.parked], [true, undefined]);
    assert.equal(gate.waiting(), false);
    assert.deepEqual(committed, []);
    const asked = await gate.enter(SEND, { channel_id: "C0123" }, "c2", park);
    assert.deepEqual([asked.isError, asked.parked], [false, true]);
    assert.equal(committed.length, 1, "the pinned call's request");
  }
  {
    // A deny is a deny first: its own refusal, whatever the arguments.
    const { gate, park } = await gateOf(t, { [SEND]: { permission: "deny", pin: { channel_id: "C0123" } } });
    assert.match((await gate.enter(SEND, { channel_id: "C0EVIL" }, "c1", park)).text, /^Permission denied: mcp:slack\/slack_send_message is set to deny for this agent/);
  }
  {
    // The server's pin binds a run the agent allowed, read at each call; the agent's pin and the server's both hold.
    const { gate, park } = await gateOf(t, { [SEND]: { permission: "allow" } }, { [SEND]: { pin: { channel_id: "C0SERVER" } } });
    assert.match((await gate.enter(SEND, { channel_id: "C0123" }, "c1", park)).text, /channel_id = C0SERVER: its destination is fixed by this server's settings/);
    assert.equal(await gate.enter(SEND, { channel_id: "C0SERVER" }, "c2", park), undefined);
  }
});

const REVIEW = "mcp:github/pull_request_review_write";

test("a one-of pin: the argument must equal one of its list (null: left out), said in the list's order", () => {
  const agent = { [REVIEW]: { permission: "allow", pin: { method: ["create", "submit_pending", "delete_pending"], event: [null, "COMMENT"] } } };
  for (const args of [{ method: "create", commitID: "abc" }, { method: "submit_pending", event: "COMMENT", body: "x" }, { method: "delete_pending", event: null }]) assert.equal(pinRefusal(REVIEW, args, {}, agent), undefined, JSON.stringify(args));
  const approve = pinRefusal(REVIEW, { method: "submit_pending", event: "APPROVE" }, {}, agent);
  assert.equal(approve.text, "mcp:github/pull_request_review_write may only be called with method in (create | submit_pending | delete_pending), event in (absent | COMMENT): its destination is fixed by the agent's settings. It was not run: nothing was sent and nothing was charged.");
  assert.deepEqual(approve.mismatched, ["event"]);
  assert.deepEqual(pinRefusal(REVIEW, { method: "resolve_thread", threadId: "t1" }, {}, agent).mismatched, ["method"]);
  assert.deepEqual(pinRefusal(REVIEW, { method: "submit_pending", event: "comment" }, {}, agent).mismatched, ["event"], "strict equality per item");
  // A list of numbers is matched as JSON values: 2 is not "2".
  assert.ok(pinRefusal("mcp:x/list", { page: "2" }, {}, { "mcp:x/list": { pin: { page: [1, 2] } } }));
  assert.equal(pinRefusal("mcp:x/list", { page: 2 }, {}, { "mcp:x/list": { pin: { page: [1, 2] } } }), undefined);
});

test("two layers' pins of one argument both hold: what holds both, and the clash text where nothing does", () => {
  const agent = { [REVIEW]: { pin: { method: ["create", "submit_pending", "delete_pending"] } } };
  // List and list: what is in both, in the agent's order.
  const server = { [REVIEW]: { pin: { method: ["submit_pending", "create"] } } };
  assert.equal(pinRefusal(REVIEW, { method: "create" }, server, agent), undefined);
  assert.equal(pinRefusal(REVIEW, { method: "delete_pending" }, server, agent).text, "mcp:github/pull_request_review_write may only be called with method in (create | submit_pending): its destination is fixed by the agent's and this server's settings. It was not run: nothing was sent and nothing was charged.");
  // A list and a scalar it holds: the scalar.
  assert.match(pinRefusal(REVIEW, { method: "create" }, { [REVIEW]: { pin: { method: "submit_pending" } } }, agent).text, /may only be called with method = submit_pending:/);
  assert.match(pinRefusal(REVIEW, { method: "create" }, agent, { [REVIEW]: { pin: { method: "submit_pending" } } }).text, /may only be called with method = submit_pending:/, "either layer's scalar");
  // Nothing in both: every call is refused, with the clash text.
  const clash = pinRefusal(REVIEW, { method: "create" }, { [REVIEW]: { pin: { method: ["merge", "resolve_thread"] } } }, agent);
  assert.equal(clash.text, "mcp:github/pull_request_review_write can't be called: this agent's settings fix method in (create | submit_pending | delete_pending) and this server's fix method in (merge | resolve_thread), so no call can satisfy both. It was not run: nothing was sent and nothing was charged. Don't retry it: the owner makes the two agree.");
  assert.ok(pinRefusal(REVIEW, { method: "create" }, { [REVIEW]: { pin: { method: "merge" } } }, agent).text.includes("so no call can satisfy both"));
});

test("the one pin rule (pinIssues) and its one form (sortedPin): a one-of list is 1 to 16 scalars, kept in its order", () => {
  assert.deepEqual(pinIssues({ method: ["create", "submit_pending"], event: [null, "COMMENT"], n: 1 }, "pin"), []);
  assert.deepEqual(pinIssues({ method: ["create"] }, "pin", "mcp:github/pull_request_review_write"), []);
  const reasons = (pin, key) => pinIssues(pin, "pin", key).map((issue) => [issue.field, issue.reason]);
  assert.deepEqual(reasons({ method: [] }), [["pin.method", "wrong_type"]]);
  assert.deepEqual(reasons({ method: Array.from({ length: 17 }, (_, i) => `m${i}`) }), [["pin.method", "wrong_type"]]);
  assert.deepEqual(reasons({ method: Array.from({ length: 16 }, (_, i) => `m${i}`) }), []);
  assert.deepEqual(reasons({ method: ["create", ["submit_pending"]] }), [["pin.method", "wrong_type"]]);
  assert.deepEqual(reasons({ method: ["create", { m: 1 }] }), [["pin.method", "wrong_type"]]);
  assert.deepEqual(reasons({ method: ["x".repeat(1025)] }), [["pin.method", "wrong_type"]]);
  assert.deepEqual(reasons({ method: "create" }, "mcp:github/*"), [["pin", "not_allowed"]]);
  assert.deepEqual(reasons({ method: "create" }, "read"), [["pin", "not_allowed"]]);
  // Through the settings' check, the same rule, under the tool's key.
  assert.deepEqual(settingsIssues({ [REVIEW]: { pin: { method: [] } } }).map((issue) => [issue.field, issue.reason]), [[`${REVIEW}.pin.method`, "wrong_type"]]);
  // Arguments sorted, a list's order the author's.
  assert.equal(JSON.stringify(sortedPin({ method: ["submit_pending", "create"], event: [null, "COMMENT"] })), JSON.stringify({ event: [null, "COMMENT"], method: ["submit_pending", "create"] }));
  assert.equal(JSON.stringify(canonicalToolSettings({ [REVIEW]: { pin: { method: ["submit_pending", "create"], event: ["COMMENT", null] } } })), JSON.stringify({ [REVIEW]: { pin: { event: ["COMMENT", null], method: ["submit_pending", "create"] } } }));
});
