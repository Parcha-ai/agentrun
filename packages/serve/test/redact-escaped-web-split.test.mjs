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

test("a held value split where a call's read stops, its rest past JSON's one-character escapes of whitespace or quotes (one level and two) or past characters that render as nothing, shows none of it; escaped backslashes count as one character each", () => {
  // The JSON view decodes "\n", "\t", "\r" (and "\\n", JSON in JSON) to whitespace, and an escaped quote ("\"", or
  // "\\\"" in JSON in JSON) to nothing, where a string in a string ends: the value reads whole across them, and the read
  // past the stop counts each as what the views keep of it, nothing. Counted as their raw characters (2 or 4 each), 300
  // of them are more than the read past the stop reads, and the rest is never read. The views drop characters that
  // render as nothing too: a zero-width space or a soft hyphen, written as it is, counts as nothing, so 500 of them
  // (more than the read reads at one each) never hide the rest either. Nor do 400 of them percent-encoded (%E2%80%8B):
  // the percent view decodes each to a zero-width space and drops it.
  const B = String.fromCharCode(92);
  const [ZWSP, SHY] = [0x200b, 0xad].map((code) => String.fromCharCode(code));
  for (const pad of [`${B}n`.repeat(300), `${B}t`.repeat(300), `${B}r`.repeat(300), `${B}r${B}n`.repeat(150), `${B}${B}n`.repeat(300), `${B}${B}t${B}${B}r`.repeat(150), `${B}"`.repeat(300), `${B}${B}${B}"`.repeat(300), ZWSP.repeat(500), SHY.repeat(500), "%E2%80%8B".repeat(400)]) {
    const text = `${"y ".repeat(59_940)}${HEAD}\n${pad}${REST}${"z".repeat(9000)} end`;
    const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
    assert.ok(!shown.includes(HEAD.slice(0, 8)), `${pad.slice(0, 6)}: ${shown.slice(-60)}`);
  }
  // Control: an escaped backslash decodes to a character the view keeps, so 300 of them stand between the head and the
  // rest, no held value reads across them, and the text is served, the head in it as written.
  for (const pad of [`${B}${B}`.repeat(300)]) {
    const text = `${"y ".repeat(59_940)}${HEAD}\n${pad}${REST}${"z".repeat(9000)} end`;
    const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
    assert.ok(shown.startsWith("y y ") && shown.includes(HEAD), `${pad.slice(0, 4)}: ${shown.slice(-60)}`);
  }
});

test("a held hex identifier split where a call's read stops, its rest past dots or dashes, shows none of it: the read past the stop counts separators as nothing when a held value folds", () => {
  // The fold view drops "-", "_", ":" and "." however many stand in a row, so a held UUID reads whole across 300 dots
  // (the #3626 review's text). Counted as one each, they were more than the read past the stop reads (hold, 232 for a
  // UUID), the rest was never read, and the head showed while withheldWhole withheld the same text.
  const U = ["3f9a1c2e", "7b4d", "4e8f", "9a01", "b2c3d4e5f607"].join("-");
  for (const pad of [".".repeat(300), "-".repeat(300)]) {
    const text = `${"y ".repeat(59_940)}${U.slice(0, 18)}\n${pad}${U.slice(18)}${"z".repeat(9000)} end`;
    assert.equal(withheldWhole(text, [U]), true);
    const shown = redactedCall(text, [U], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
    assert.ok(!shown.includes(U.slice(0, 8)), `${pad[0]}: ${shown.slice(-60)}`);
  }
  // Control: a held value with no hex identifier in it folds nowhere, so no view reads it across the dashes; they count
  // one each, and the text is served, the head in it as written.
  const text = `${"y ".repeat(59_940)}${HEAD}\n${"-".repeat(300)}${REST}${"z".repeat(9000)} end`;
  const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
  assert.ok(shown.startsWith("y y ") && shown.includes(HEAD), shown.slice(-60));
});

test("a held value split where a call's read stops, its rest past character references to a space, shows none of it: the read past the stop counts a reference as the character it stands for", () => {
  // The views decode "&#32;" and "&#x20;" to a space, which they drop. Counted as their five or six raw characters, 300
  // of them were more than the read past the stop reads, and the rest was never read.
  for (const pad of ["&#32;".repeat(300), "&#x20;".repeat(300)]) {
    const text = `${"y ".repeat(59_940)}${HEAD}\n${pad}${REST}${"z".repeat(9000)} end`;
    const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
    assert.ok(!shown.includes(HEAD.slice(0, 8)), `${pad.slice(0, 6)}: ${shown.slice(-60)}`);
  }
});

test("a held value split across two strings where a call's read stops, empty strings between, shows none of it: the read past the stop counts quotes and JSON's punctuation as nothing", () => {
  // The join view reads a JSON text's strings joined and drops its quotes and punctuation, so ["<H>", "", "", ..., "<R>"]
  // reads the value whole. The read stops right after the head's string; counted as one each, 900 characters of empty
  // strings were more than the read past the stop reads, and the rest was never read.
  const text = `${"y ".repeat(59_990)}["${HEAD}",\n${'"",'.repeat(300)}"${REST}"]${"z".repeat(9000)} end`;
  const shown = redactedCall(text, [KEY], CALL_RESULT_CHARS).slice(0, CALL_RESULT_CHARS);
  assert.ok(!shown.includes(HEAD.slice(0, 8)), shown.slice(-60));
});
