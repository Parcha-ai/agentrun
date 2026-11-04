// What a tool's result row shows of its output goes through the host's `redact` before it is taken or cut: its label (a
// browser_read's page title, a fetch's title), its summary and its preview, on every path a result takes (in order, a
// result before its call, a nested call's), with one redaction per result. Its outcome (ok, or failed and why) is read
// from the output as it came, as its status is, so a redaction that swallows a whole failed output never reads as ok.
// The redactor here stands in for serve's (learning's redactSecrets over its held keys): it takes out a held value
// written plainly, base64-encoded or percent-encoded, and a whole output holding nothing but a percent-encoded key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, custom, inConv, result, user } from "./timeline-support.mjs";

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
