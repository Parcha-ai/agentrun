// Two forms of a held value the redactor missed: a key written with JSON's \uXXXX escapes (every character or some),
// and a key split across two strings of a web call's JSON, each string redacted on its own. Both withhold the text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, valueMatcher } from "../dist/learn/secrets.js";
import { redactedAnswer, redactedCall, withheldWhole } from "../dist/key-refusal.js";
import { CALL_RESULT_CHARS, scrubUrls, timelineOf, webShownOf, webWithin } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

// A held value of 32 characters in no secret's shape, made at runtime, and its two halves.
const [HEAD, REST] = [["Zq8V", "bN3x", "LmT6", "pR2w"].join(""), ["Yk9H", "sD4f", "Gj7A", "c5Ue"].join("")];
const KEY = `${HEAD}${REST}`;

/** `text` as JSON writes it with every character escaped, its hex digits in lower or upper case. */
const escaped = (text, upper = false) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")[upper ? "toUpperCase" : "toLowerCase"]()}`).join("");

test("a held value written as JSON \\uXXXX escapes, every character or some, withholds the text", () => {
  const all = `{"note":"${escaped(KEY)}"}`;
  assert.equal(valueMatcher([KEY])(all), true);
  assert.equal(redactSecrets(all, [KEY]), "[redacted]");
  assert.equal(redactSecrets(`{"note":"${escaped(KEY, true)}"}`, [KEY]), "[redacted]");
  const some = `{"note":"${HEAD}${escaped(REST.slice(0, 3))}${REST.slice(3)}"}`;
  assert.equal(redactSecrets(some, [KEY]), "[redacted]");
  assert.equal(redactedAnswer(`the result: ${all} done`, [KEY]), "[redacted]");
  assert.equal(redactedCall(`the result: ${all} done`, [KEY], CALL_RESULT_CHARS), "[redacted]");
  // Other escapes, and a held value's escapes cut short, are text.
  const other = `{"note":"\\u00e9t\\u00e9 ${escaped(KEY.slice(0, 7))}"}`;
  assert.equal(redactSecrets(other, [KEY]), other);
});

test("valueLeft maps each \\uXXXX escape to its six raw characters: a value escaped wholly inside a cut is not left, one split by the cut's edge is", async () => {
  const { valueLeft } = await import("../dist/learn/secrets.js");
  const text = `see ${escaped(KEY)} ok`;
  const [start, end] = [4, 4 + escaped(KEY).length];
  assert.equal(valueLeft(text, [KEY], []), true);
  assert.equal(valueLeft(text, [KEY], [[start, end]]), false);
  // The cut ends three raw characters into the last escape: that character's source is not all inside it.
  assert.equal(valueLeft(text, [KEY], [[start, end - 3]]), true);
  // It ends on the last escape's edge before it: the value's last character is outside.
  assert.equal(valueLeft(text, [KEY], [[start, end - 6]]), true);
});

/** A call's tool_result_text as a served calls read shows it: redactedCall per string, and the strings' join read. */
const resultTextOf = (text, secrets, tool) => {
  const calls = { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, secrets, CALL_RESULT_CHARS, scrubUrls), holds: (joined) => withheldWhole(joined, secrets) };
  const rows = timelineOf([user("Run it."), assistant([call("c1", tool, { query: "q" })]), result("c1", tool, text)], { calls });
  return rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c1").tool_result_text;
};

test("a held value split across two strings of a web call's JSON withholds the call's result; one whole in a string is cut in place", () => {
  const search = (title, snippet) => JSON.stringify({ query: "q", results: [{ url: "https://h.example/a", title, snippet }] });
  const split = search(`see ${HEAD}`, `${REST} more`);
  assert.equal(resultTextOf(split, [KEY], "web_search"), "[redacted]");
  const page = JSON.stringify({ ok: true, url: "https://h.example/page", title: `A page ${HEAD}`, text: `${REST} and on` });
  assert.equal(resultTextOf(page, [KEY], "web_fetch"), "[redacted]");
  // Across the JSON and the lines after it too.
  assert.equal(resultTextOf(`${search("t", `the end ${HEAD}`)}\n${REST} after`, [KEY], "web_search"), "[redacted]");
  // Whole in one string, cut in place: the result is still its JSON, every url whole.
  const whole = resultTextOf(search(`see ${KEY}`, `${REST} more`), [KEY], "web_search");
  assert.deepEqual(JSON.parse(whole).results, [{ url: "https://h.example/a", title: "see [redacted]", snippet: `${REST} more` }]);
  // webShownOf without `holds` reads each string alone, as before.
  assert.ok(webWithin(webShownOf("web_search", split), 1000).includes(HEAD));
  assert.equal(webWithin(webShownOf("web_search", split, (part) => part, (joined) => withheldWhole(joined, [KEY])), 1000), "[redacted]");
});
