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

test("a held value split where a call's read stops, its rest past \\uXXXX escapes of whitespace, shows none of it; other escapes count as one character each", () => {
  // The matcher decodes each escape, so the value reads whole across escaped whitespace: the read past the stop counts
  // an escape as the character it decodes to, so padding of them up to a piece never hides the rest.
  for (const pad of ["\\u0020".repeat(100), "\\u000a".repeat(100), "\\u3000".repeat(100), `${" ".repeat(3000)}${"\\u0020".repeat(100)}`]) {
    const text = `${"y ".repeat(59_940)}${HEAD}\n${pad}${REST}${"z".repeat(9000)} end`;
    const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
    assert.ok(!shown.includes(HEAD.slice(0, 8)), `${pad.slice(0, 7)}: ${shown.slice(-60)}`);
  }
  // A value written as escapes after the stop is read as its 32 characters, not its 192 raw ones.
  const written = `${"y ".repeat(59_940)}${HEAD}\n${"\\u0020".repeat(30)}${escaped(REST)}${"z".repeat(9000)} end`;
  assert.ok(!redactedCall(written, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS).includes(HEAD.slice(0, 8)));
  // Padding of escapes longer than a piece is more than the read past the stop reads: the text is withheld.
  assert.equal(redactedCall(`${"y ".repeat(59_940)}${HEAD}${"\\u0020".repeat(1400)}${REST} end`, [KEY], CALL_RESULT_CHARS), "[redacted]");
  // The same text with no held value split there is served, cut where the read stopped.
  const plain = `${"y ".repeat(59_940)}${"q".repeat(16)}\n${"\\u0020".repeat(100)}${"z".repeat(9000)} end`;
  assert.ok(redactedCall(plain, [KEY], CALL_RESULT_CHARS).startsWith("y y "));
});

test("a held value split where a call's read stops, its rest past JSON's one-character escapes of whitespace (one level and two) or past characters that render as nothing, shows none of it; escaped quotes and backslashes count as one character each", () => {
  // The JSON view decodes "\n", "\t", "\r" (and "\\n", JSON in JSON) to whitespace, so the value reads whole across
  // them: the read past the stop counts each as the character it decodes to, whitespace as nothing. Counted as their
  // raw characters (2 or 3 each), 300 of them are more than the read past the stop reads, and the rest is never read.
  // The views drop characters that render as nothing too: a zero-width space or a soft hyphen, written as it is, counts
  // as nothing, so 500 of them (more than the read reads at one each) never hide the rest either. Nor do 400 of them
  // percent-encoded (%E2%80%8B): the percent view decodes each to a zero-width space and drops it.
  const B = String.fromCharCode(92);
  const [ZWSP, SHY] = [0x200b, 0xad].map((code) => String.fromCharCode(code));
  for (const pad of [`${B}n`.repeat(300), `${B}t`.repeat(300), `${B}r`.repeat(300), `${B}r${B}n`.repeat(150), `${B}${B}n`.repeat(300), `${B}${B}t${B}${B}r`.repeat(150), ZWSP.repeat(500), SHY.repeat(500), "%E2%80%8B".repeat(400)]) {
    const text = `${"y ".repeat(59_940)}${HEAD}\n${pad}${REST}${"z".repeat(9000)} end`;
    const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
    assert.ok(!shown.includes(HEAD.slice(0, 8)), `${pad.slice(0, 6)}: ${shown.slice(-60)}`);
  }
  // Control: an escaped quote or backslash decodes to a character the view keeps, so 300 of them stand between the
  // head and the rest, no held value reads across them, and the text is served, the head in it as written.
  for (const pad of [`${B}"`.repeat(300), `${B}${B}`.repeat(300)]) {
    const text = `${"y ".repeat(59_940)}${HEAD}\n${pad}${REST}${"z".repeat(9000)} end`;
    const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
    assert.ok(shown.startsWith("y y ") && shown.includes(HEAD), `${pad.slice(0, 4)}: ${shown.slice(-60)}`);
  }
});
