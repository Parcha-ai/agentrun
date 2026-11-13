// A pin (tool-gate.ts pinRefusal): an MCP tool's setting may fix top-level arguments, and the gate refuses a call whose
// arguments are not as pinned before it runs or asks anyone, whatever the permission. The agent's pin and the server's
// both hold; two that fix one argument differently refuse every call. Settings validate a pin (an MCP tool's own key,
// 1 to 8 arguments, JSON scalars), the server keeps it in the one store, and a stored pin that does not read fails
// closed. The gate is the runner's (RunGate.decide), on the settings it read from the store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pinRefusal } from "../dist/tool-gate.js";
import { canonicalToolSettings, loadToolSettings, pinIssues, saveToolSettings, settingsIssues, sortedPin, TOOL_SETTINGS_KEY, withDefaults } from "../dist/tool-plane.js";
import { runnerGate } from "./gate-support.mjs";

/** The one store's settings rows, as loadToolSettings and saveToolSettings reach them. */
const settingsStore = () => {
  const rows = new Map();
  return { settings: { get: async (key) => structuredClone(rows.get(key)), put: async (key, value) => void rows.set(key, structuredClone(value)) } };
};

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
  assert.match(bcc.text, /may only be called with bcc absent, recipient_email = owner@example\.com:/);
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

test("the server keeps a pin: written whole, read back, served; a stored pin that does not read refuses the tool's every call", async () => {
  const store = settingsStore();
  const put = await saveToolSettings(store, { [SEND]: { permission: "allow", pin: { channel_id: "C0123" } }, "mcp:slack/*": { permission: "ask" } });
  assert.deepEqual(put[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
  assert.deepEqual((await store.settings.get(TOOL_SETTINGS_KEY))[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
  assert.deepEqual((await loadToolSettings(store)).settings[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
  assert.deepEqual(withDefaults(put)[SEND], { permission: "allow", pin: { channel_id: "C0123" } }, "as served");

  // Stored as something no save writes: never dropped to no pin, which would let every call through.
  await store.settings.put(TOOL_SETTINGS_KEY, { [SEND]: { permission: "allow", pin: { channel_id: { any: true } } } });
  const read = await loadToolSettings(store);
  assert.equal(read.settings[SEND].permission, "allow");
  assert.equal(read.settings[SEND].brokenPin, true);
  assert.equal(read.problems.length, 1);
  assert.equal(withDefaults(read.settings)[SEND].brokenPin, undefined, "never served");
  const answer = await runnerGate({ settings: () => read }).decide(SEND, { channel_id: "C0123" });
  assert.match(answer.deny, /its pin in this server's tool settings does not read/);
});
/** A run's gate with `agent` the revision's own settings and `server` the server's stored ones. */
const gateOf = (agent, server) => runnerGate({ overrides: agent, settings: server });

test("the gate's decision: an allowed pinned call runs only as pinned; under ask a call not as pinned is refused and never asks", async () => {
  {
    const gate = gateOf({ [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } });
    assert.equal(await gate.decide(SEND, { channel_id: "C0123", message: "hi" }), "allow", "as pinned: it runs");
    const refused = await gate.decide(SEND, { channel_id: "C0EVIL", message: "hi" });
    assert.match(refused.deny, /may only be called with channel_id = C0123: its destination is fixed by the agent's settings/);
  }
  {
    // The MCP default, ask: a call not as pinned is refused at once (no approval waits), one as pinned asks.
    const gate = gateOf({ [SEND]: { pin: { channel_id: "C0123" } } });
    assert.ok((await gate.decide(SEND, { channel_id: "C0EVIL" })).deny, "refused, never asked");
    assert.equal(await gate.decide(SEND, { channel_id: "C0123" }), "ask", "the pinned call asks");
  }
  {
    // A deny is a deny first: its own refusal, whatever the arguments.
    const gate = gateOf({ [SEND]: { permission: "deny", pin: { channel_id: "C0123" } } });
    assert.match((await gate.decide(SEND, { channel_id: "C0EVIL" })).deny, /^Permission denied: mcp:slack\/slack_send_message is set to deny for this agent/);
  }
  {
    // The server's pin binds a run the agent allowed, read at each call; the agent's pin and the server's both hold.
    const gate = gateOf({ [SEND]: { permission: "allow" } }, { [SEND]: { pin: { channel_id: "C0SERVER" } } });
    assert.match((await gate.decide(SEND, { channel_id: "C0123" })).deny, /channel_id = C0SERVER: its destination is fixed by this server's settings/);
    assert.equal(await gate.decide(SEND, { channel_id: "C0SERVER" }), "allow");
  }
});
const REVIEW = "mcp:github/pull_request_review_write";

test("a one-of pin: the argument must equal one of its list (null: left out), said in the list's order", () => {
  const agent = { [REVIEW]: { permission: "allow", pin: { method: ["create", "submit_pending", "delete_pending"], event: [null, "COMMENT"] } } };
  for (const args of [{ method: "create", commitID: "abc" }, { method: "submit_pending", event: "COMMENT", body: "x" }, { method: "delete_pending", event: null }]) assert.equal(pinRefusal(REVIEW, args, {}, agent), undefined, JSON.stringify(args));
  const approve = pinRefusal(REVIEW, { method: "submit_pending", event: "APPROVE" }, {}, agent);
  assert.equal(approve.text, "mcp:github/pull_request_review_write may only be called with event in (absent | COMMENT), method in (create | delete_pending | submit_pending): its destination is fixed by the agent's settings. It was not run: nothing was sent and nothing was charged.");
  // The words are the pin's one form, whatever order it was written in, a value given twice said once.
  const shuffled = { [REVIEW]: { pin: { method: ["submit_pending", "delete_pending", "create", "create"], event: ["COMMENT", null] } } };
  assert.equal(pinRefusal(REVIEW, { method: "submit_pending", event: "APPROVE" }, {}, shuffled).text, approve.text);
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
  assert.equal(clash.text, "mcp:github/pull_request_review_write can't be called: this agent's settings fix method in (create | delete_pending | submit_pending) and this server's fix method in (merge | resolve_thread), so no call can satisfy both. It was not run: nothing was sent and nothing was charged. Don't retry it: the owner makes the two agree.");
  assert.ok(pinRefusal(REVIEW, { method: "create" }, { [REVIEW]: { pin: { method: "merge" } } }, agent).text.includes("so no call can satisfy both"));
});

test("the one pin rule (pinIssues) and its one form (sortedPin): a one-of list is 1 to 16 scalars, each once, null first, then by its JSON text", () => {
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
  // Arguments sorted; a list once each, null first, then by JSON text (so "2" and 2 are two values, and "2" sorts first, its quote before any digit).
  assert.equal(JSON.stringify(sortedPin({ method: ["submit_pending", "create", "submit_pending"], event: ["COMMENT", null] })), JSON.stringify({ event: [null, "COMMENT"], method: ["create", "submit_pending"] }));
  assert.equal(JSON.stringify(sortedPin({ page: ["2", 10, 2, null, true, null] })), JSON.stringify({ page: [null, "2", 10, 2, true] }));
  const a = canonicalToolSettings({ [REVIEW]: { pin: { method: ["submit_pending", "create"], event: ["COMMENT", null] } } });
  const b = canonicalToolSettings({ [REVIEW]: { pin: { event: [null, "COMMENT", "COMMENT"], method: ["create", "submit_pending"] } } });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "equal meanings, one text");
  assert.equal(JSON.stringify(a), JSON.stringify({ [REVIEW]: { pin: { event: [null, "COMMENT"], method: ["create", "submit_pending"] } } }));
});

test("a broken pin survives a save of other keys and keeps refusing, until the owner sets a valid pin or removes the setting", async () => {
  const store = settingsStore();
  const broken = { channel_id: { any: true } };
  await store.settings.put(TOOL_SETTINGS_KEY, { [SEND]: { permission: "allow", pin: broken }, web_search: { provider: "auto" } });
  // The gate reads the settings at each call, as the runner loaded them; a reload after each save stands for the next claim.
  let current = await loadToolSettings(store);
  const gate = runnerGate({ settings: () => current });
  const call = (channel = "C0123") => gate.decide(SEND, { channel_id: channel });
  const save = async (map) => { await saveToolSettings(store, map); current = await loadToolSettings(store); };
  // The answer says the tool's pin is broken, so the console can show it; the whole map it saves back carries that.
  const served = withDefaults(current.settings);
  assert.deepEqual(served[SEND], { permission: "allow", pin_broken: true });
  assert.deepEqual(settingsIssues(served), [], "a save of the answer as served is taken");

  // A console's whole-map save that changes another tool: still broken, as stored and at the gate.
  await save({ ...served, web_search: { provider: "exa-keyless" } });
  assert.deepEqual((await store.settings.get(TOOL_SETTINGS_KEY))[SEND], { permission: "allow", pin: broken }, "the broken value is kept as written");
  assert.match((await call()).deny, /its pin in this server's tool settings does not read/);
  // The key kept with its pin left out (no mark either): still broken.
  await save({ [SEND]: { permission: "allow" }, web_search: { provider: "exa-keyless" } });
  assert.deepEqual(withDefaults(current.settings)[SEND], { permission: "allow", pin_broken: true });
  assert.match((await call()).deny, /does not read/);
  // A later read finds it broken still.
  assert.equal((await loadToolSettings(store)).settings[SEND].brokenPin, true);

  // Repaired with a valid pin: the call as pinned goes, another is refused by that pin.
  await save({ [SEND]: { permission: "allow", pin: { channel_id: "C0123" } } });
  assert.deepEqual(withDefaults(current.settings)[SEND], { permission: "allow", pin: { channel_id: "C0123" } });
  assert.equal(await call("C0123"), "allow");
  assert.match((await call("C0EVIL")).deny, /may only be called with channel_id = C0123/);

  // Broken again, then the setting removed on purpose (its key left out): cleared, the tool takes its default.
  await store.settings.put(TOOL_SETTINGS_KEY, { [SEND]: { permission: "allow", pin: broken } });
  await save({});
  assert.deepEqual(await store.settings.get(TOOL_SETTINGS_KEY), {});
  assert.equal(gate.policy(SEND), "ask", "the default, no pin");
});
test("pin_broken is the server's mark: only `true` on an MCP tool's own key of the server's settings, never in an agent's", () => {
  assert.deepEqual(settingsIssues({ [SEND]: { permission: "allow", pin_broken: true } }), []);
  assert.deepEqual(settingsIssues({ [SEND]: { pin_broken: false } }).map((i) => [i.field, i.reason]), [[`${SEND}.pin_broken`, "not_an_option"]]);
  assert.deepEqual(settingsIssues({ read: { pin_broken: true } }).map((i) => [i.field, i.reason]), [["read.pin_broken", "not_allowed"]]);
  assert.deepEqual(settingsIssues({ [SEND]: { pin_broken: true } }, "definition.tool_settings", "agent").map((i) => [i.field, i.reason]), [[`definition.tool_settings.${SEND}.pin_broken`, "not_allowed"]]);
});
