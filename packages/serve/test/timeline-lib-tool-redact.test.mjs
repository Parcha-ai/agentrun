// What a tool's result row shows of its output goes through the host's `redact` before it is taken or cut: its label (a
// browser_read's page title, a fetch's title), its summary and its preview, on every path a result takes (in order, a
// result before its call, a nested call's), with one redaction per result. Its outcome (ok, or failed and why) is read
// from the output as it came, as its status is, so a redaction that swallows a whole failed output never reads as ok.
// The redactor here stands in for serve's (learning's redactSecrets over its held keys): it takes out a held value
// written plainly, base64-encoded or percent-encoded, and a whole output holding nothing but a percent-encoded key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, inConv, result, user } from "./timeline-lib-support.mjs";

/** A held key, made at runtime: no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "held-tool-key", "0123456789ab"].join("-");
const B64 = Buffer.from(KEY).toString("base64");
const PCT = [...Buffer.from(KEY)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
/** Serve's rule, as far as these cases need: each form of the held key becomes [redacted]; text whose only content
 *  is a percent-encoded key is redacted whole, as redactSecrets does when what is left still looks like a secret. */
const redact = (text) => {
  if (text.includes(PCT) && !text.replace(PCT, "").replace(/[\s{}":,a-z]/gi, "").length) return "[redacted]";
  return text.split(KEY).join("[redacted]").split(B64).join("[redacted]").split(PCT).join("[redacted]");
};
/** Whether `text` holds any 8-character run of `secret`. */
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};
const leaks = (rows) => [KEY, B64, PCT].filter((form) => holdsRun(JSON.stringify(rows), form));

const TITLED = `title: Results for ${B64}\nurl: https://site.example/page\n\nBody text.`;

test("a browser_read whose page title holds a base64 copy of a held key: no form of it on the call's summary or the result's", () => {
  const rows = timelineOf([user("Read the page."), assistant([call("c1", "browser_read", {})]), result("c1", "browser_read", TITLED)], { redact });
  assert.deepEqual(leaks(rows), [], JSON.stringify(rows.filter((r) => r.tool_use_id === "c1").map((r) => [r.kind, r.summary, r.tool_result_preview])));
});

test("the same title when the result comes before its call: no form of the key once the call's row names it", () => {
  const rows = timelineOf([user("Read the page."), result("c1", "browser_read", TITLED), assistant([call("c1", "browser_read", {})])], { redact });
  assert.deepEqual(leaks(rows), [], JSON.stringify(rows.filter((r) => r.tool_use_id === "c1").map((r) => [r.kind, r.summary, r.tool_result_preview])));
});

test("the same title on a nested call's result (a subagent's), live: no form of the key on its rows", () => {
  const reducer = timelineReducer({ redact });
  const entries = [
    user("Delegate the read."),
    assistant([call("t1", "task", { description: "read", prompt: "Read the page." })]),
    inConv(user("Read the page."), 2),
    inConv(assistant([call("c1", "browser_read", {})]), 2),
    inConv(result("c1", "browser_read", TITLED), 2),
    result("t1", "task", TITLED, 0, { details: { conversationId: 2 } }),
  ];
  reducer.apply(entries.map((entry) => ({ type: "entry_appended", entry })));
  const rows = reducer.rows();
  assert.ok(rows.some((r) => r.kind === "tool_result" && r.tool_name === "browser_read"), JSON.stringify(rows.map((r) => r.kind)));
  assert.deepEqual(leaks(rows), [], JSON.stringify(rows.map((r) => [r.kind, r.summary, r.tool_result_preview])));
});

test("a web_search that failed with a message holding a percent-encoded held key: its summary says it failed, never ok", () => {
  const failed = JSON.stringify({ error: PCT });
  const rows = timelineOf([user("Search."), assistant([call("s1", "web_search", { query: "widgets" })]), result("s1", "web_search", failed)], { redact });
  const row = rows.find((r) => r.kind === "tool_result" && r.tool_use_id === "s1");
  assert.equal(row.tool_status, "failed");
  assert.match(row.summary, /failed/, row.summary);
  assert.doesNotMatch(row.summary, /: ok$/, row.summary);
  assert.deepEqual(leaks(rows), []);
});

test("a calls read's tool_input withholds a number that shows a held all-digit key, by serve's own rule (heldNumber)", async () => {
  const { heldNumber, redacted } = await import("../dist/key-refusal.js");
  // Two held keys that are all digits: one a call quotes as it is, one with a leading zero a JSON number drops.
  const digits = ["7319", "4628", "501"].join("");
  const zeroed = ["00", "4815", "162342"].join("");
  const held = [digits, zeroed];
  const calls = { result: 8000, redact: (text) => redacted(text, held, 8000), held: (value) => heldNumber(value, held) };
  const args = { account: Number(digits), pin: Number(zeroed), nested: [{ id: Number(digits) }], max_chars: 8000 };
  const rows = timelineOf([user("Look it up."), assistant([call("n1", "lookup", args)]), result("n1", "lookup", "found")], { redact: (text) => redacted(text, held), calls });
  const row = rows.find((r) => r.kind === "tool_use" && r.tool_use_id === "n1");
  assert.deepEqual(row.tool_input, { account: "[redacted]", pin: "[redacted]", nested: [{ id: "[redacted]" }], max_chars: 8000 });
  for (const value of held) assert.doesNotMatch(JSON.stringify(rows), new RegExp(String(Number(value))));
});

test("a calls read's tool_input carries each string argument whole to calls.result, as its output is, through the same redaction: a grader reads a long write's tail", async () => {
  const { CAPS } = await import("../dist/timeline/index.js");
  // A body past CAPS.text (2,000) with a held key in its tail. The description is the argument a tool_use row previews
  // (labels.ts inputPreview): whole in tool_input, cut at CAPS.preview in the preview.
  const body = `${"## Fixed\n".repeat(400)}tail ${KEY} end`;
  assert.ok(body.length > CAPS.text);
  const calls = { result: 8000, redact };
  const rows = timelineOf([user("Draft it."), assistant([call("w1", "issue_write", { description: body, body })]), result("w1", "issue_write", "drafted")], { redact, calls });
  const row = rows.find((r) => r.kind === "tool_use" && r.tool_use_id === "w1");
  assert.equal(row.tool_input.body, `${"## Fixed\n".repeat(400)}tail [redacted] end`, "whole, the held key redacted");
  assert.equal(row.tool_input.description, row.tool_input.body, "the previewed argument whole in tool_input too");
  assert.deepEqual([row.tool_input_preview.length, row.tool_input_preview.endsWith("...")], [CAPS.preview, true], "the preview keeps its own bound");
  assert.deepEqual(leaks(rows), []);
});

test("with serve's own redactors, as the served route passes them, a calls read's tool_input carries a long argument whole: the rows' redactor cuts at CAPS.text, the arguments' reads them raw to calls.result", async () => {
  const { CALL_RESULT_CHARS, CAPS } = await import("../dist/timeline/index.js");
  const { heldNumber, redacted, redactedCall } = await import("../dist/key-refusal.js");
  const held = [KEY];
  // 5,000 characters, the held key near character 4,000, so the rows' own redactor (redacted, CAPS.text) cuts before it.
  const body = `${"line ".repeat(800)}${KEY} ${"tail ".repeat(190)}end`;
  assert.ok(body.length > 4900 && body.indexOf(KEY) > 3900);
  const calls = { result: CALL_RESULT_CHARS, redact: (text) => redactedCall(text, held, CALL_RESULT_CHARS), input: (text, shown) => redactedCall(text, held, shown), held: (value) => heldNumber(value, held) };
  const rows = timelineOf([user("Draft it."), assistant([call("w1", "issue_write", { description: body, body })]), result("w1", "issue_write", "drafted")], { redact: (text) => redacted(text, held), calls });
  const row = rows.find((r) => r.kind === "tool_use" && r.tool_use_id === "w1");
  assert.equal(row.tool_input.body, body.replace(KEY, "[redacted]"), "whole, the held key redacted");
  assert.equal(row.tool_input.description, row.tool_input.body);
  assert.ok(row.tool_input_preview.length <= CAPS.preview && row.summary.length <= CAPS.preview, "the preview and the summary keep their bounds");
  assert.deepEqual(leaks(rows), []);
});

test("a calls read's tool_input has one budget of calls.result characters a row, over its strings in order: the string that reaches it is cut there, each one after shows as ...", async () => {
  const { redactedCall } = await import("../dist/key-refusal.js");
  const held = [KEY];
  const [a, b, c] = ["a", "b", "c"].map((letter) => letter.repeat(5000));
  const args = { a, b, nested: { c, list: ["p".repeat(100), ""] }, count: 7, tail: `${KEY}` };
  const calls = { result: 12000, redact, input: (text, shown) => redactedCall(text, held, shown) };
  const rows = timelineOf([user("Go."), assistant([call("b1", "bulk_write", args)]), result("b1", "bulk_write", "done")], { redact, calls });
  const input = rows.find((r) => r.kind === "tool_use" && r.tool_use_id === "b1").tool_input;
  assert.equal(input.a, a, "first, whole");
  assert.equal(input.b, b, "second, whole");
  assert.deepEqual([input.nested.c.length, input.nested.c.endsWith("..."), input.nested.c.startsWith("ccc")], [2000, true, true], "third, cut where the budget ends");
  assert.deepEqual(input.nested.list, ["...", ""], "past the budget: ..., an empty string as it is");
  assert.equal(input.count, 7, "a number is no string");
  assert.equal(input.tail, "...", "past the budget, never read");
  const strings = (value) => (typeof value === "string" ? value.length : Array.isArray(value) ? value.reduce((n, v) => n + strings(v), 0) : value && typeof value === "object" ? Object.values(value).reduce((n, v) => n + strings(v), 0) : 0);
  assert.ok(strings(input) <= calls.result + 3 * 2, `${strings(input)} characters`);
  assert.deepEqual(leaks(rows), []);
});
