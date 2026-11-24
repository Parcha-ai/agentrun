// Two forms of a held value the redactor missed: a key written with JSON's \uXXXX escapes (every character or some),
// and a key split across two strings of a web call's JSON (a property name among them), each string redacted on its own.
// Both withhold the text: in a calls read's result, the row's preview, and the answer the runner stores.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, valueMatcher } from "../dist/learn/secrets.js";
import { redacted, redactedAnswer, redactedCall, withheldWhole } from "../dist/key-refusal.js";
import { answersCut } from "../dist/runner/adapter-run-spec.js";
import { secretRedactor } from "../dist/runner/redact.js";
import { CALL_RESULT_CHARS, scrubUrls, timelineOf, webShownOf, webWithin } from "../dist/timeline/index.js";
import { webHeld } from "../dist/timeline/web-calls.js";
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

/** A call's tool_result row as a served read shows it (run-timeline-served.ts): the rows' redactor, the strings' join read
 *  (`holds`), and with `calls` redactedCall per string. */
const resultRowOf = (text, secrets, tool, calls = true) => {
  const options = { redact: (part) => redacted(part, secrets), holds: (joined) => withheldWhole(joined, secrets), ...(calls ? { calls: { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, secrets, CALL_RESULT_CHARS, scrubUrls) } } : {}) };
  const rows = timelineOf([user("Run it."), assistant([call("c1", tool, { query: "q" })]), result("c1", tool, text)], options);
  return rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c1");
};
const resultTextOf = (text, secrets, tool) => resultRowOf(text, secrets, tool).tool_result_text;
const search = (title, snippet, url = "https://h.example/a") => JSON.stringify({ query: "q", results: [{ url, title, snippet }] });
/** A calls read's per-string redaction, as the served one makes it. */
const callEach = (secrets) => (part) => scrubUrls(redactedCall(part, secrets, CALL_RESULT_CHARS, scrubUrls));

test("a held value split across two strings of a web call's JSON withholds the call's result; one whole in a string is cut in place", () => {
  const split = search(`see ${HEAD}`, `${REST} more`);
  assert.equal(resultTextOf(split, [KEY], "web_search"), "[redacted]");
  const page = JSON.stringify({ ok: true, url: "https://h.example/page", title: `A page ${HEAD}`, text: `${REST} and on` });
  assert.equal(resultTextOf(page, [KEY], "web_fetch"), "[redacted]");
  // Across the JSON and the lines after it too.
  assert.equal(resultTextOf(`${search("t", `the end ${HEAD}`)}\n${REST} after`, [KEY], "web_search"), "[redacted]");
  // Whole in one string, cut in place: the result is still its JSON, every url whole.
  const whole = resultTextOf(search(`see ${KEY}`, `${REST} more`), [KEY], "web_search");
  assert.deepEqual(JSON.parse(whole).results, [{ url: "https://h.example/a", title: "see [redacted]", snippet: `${REST} more` }]);
  // webShownOf reads each string alone; webHeld reads them joined.
  assert.ok(webWithin(webShownOf("web_search", split), 1000).includes(HEAD));
  assert.equal(webHeld("web_search", split, (joined) => withheldWhole(joined, [KEY])), true);
});

test("a held value split where a call's read stops, its rest past \\uXXXX escapes of whitespace, shows none of it; other escapes count as one character each", () => {
  // The matcher decodes each escape, so the value reads whole across escaped whitespace: the read past the stop counts
  // an escape as the character it decodes to, so padding of them up to a piece never hides the rest.
  // 300 escapes, past the 208 characters (6 * 32 + 16) the read holds: counted as one character each, they would hide it.
  for (const pad of ["\\u0020".repeat(300), "\\u000a".repeat(300), "\\u3000".repeat(300), `${" ".repeat(3000)}${"\\u0020".repeat(300)}`]) {
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
  const plain = `${"y ".repeat(59_940)}${"q".repeat(16)}\n${"\\u0020".repeat(300)}${"z".repeat(9000)} end`;
  assert.ok(redactedCall(plain, [KEY], CALL_RESULT_CHARS).startsWith("y y "));
});

test("a held value split across two strings of a web call's JSON withholds the row's preview too, with or without calls", () => {
  const split = search(`see ${HEAD}`, `${REST} more`);
  for (const calls of [true, false]) {
    const row = resultRowOf(split, [KEY], "web_search", calls);
    assert.equal(row.tool_result_preview, "[redacted]", `calls ${calls}: ${row.tool_result_preview}`);
    assert.ok(!row.summary.includes(HEAD) && !row.summary.includes(REST), row.summary);
  }
  const page = JSON.stringify({ ok: true, url: "https://h.example/page", title: `A page ${HEAD}`, text: `${REST} and on` });
  assert.equal(resultRowOf(page, [KEY], "web_fetch", false).tool_result_preview, "[redacted]");
  // A value whole in one string is cut in place: the preview is its JSON, the value cut.
  const whole = resultRowOf(search(`see ${KEY}`, `${REST} more`), [KEY], "web_search", false).tool_result_preview;
  assert.ok(whole.startsWith('{"query":"q"') && whole.includes("[redacted]") && !whole.includes(HEAD), whole);
});

test("the runner stores a web answer with a held value split across two of its strings as \"[redacted]\"; one whole in a string is cut in place", async () => {
  const context = { callId: "c1", signal: new AbortController().signal };
  const tool = (text, name = "web_search") => ({ name, description: "", inputSchema: {}, replay: "safe", call: async () => ({ text }) });
  const split = search(`see ${HEAD}`, `${REST} more`);
  assert.equal((await answersCut(tool(split), secretRedactor([KEY])).call({}, context)).text, "[redacted]");
  const page = JSON.stringify({ ok: true, url: "https://h.example/page", title: `A page ${HEAD}`, text: `${REST} and on` });
  assert.equal((await answersCut(tool(page, "web_fetch"), secretRedactor([KEY])).call({}, context)).text, "[redacted]");
  // A redactor that does not know its values: the join is read through it, withheld when it withholds the join whole.
  const plain = (text) => redactedAnswer(text, [KEY]);
  assert.equal((await answersCut(tool(split), plain).call({}, context)).text, "[redacted]");
  const whole = (await answersCut(tool(search(`see ${KEY}`, `${REST} more`)), secretRedactor([KEY])).call({}, context)).text;
  assert.deepEqual(JSON.parse(whole).results[0], { url: "https://h.example/a", title: "see [redacted]", snippet: `${REST} more` });
});

test("a web call's join is read as it came: one string's cut taking the value's head in place still withholds its rest's neighbour", () => {
  // The url's cut (its query value elided, the head redacted in place) takes the head; read as shown, the join no longer
  // holds it and the title's rest would show.
  const text = search(`${REST} more`, "s", `https://h.example/a?token=${HEAD}`);
  assert.equal(webHeld("web_search", text, (joined) => withheldWhole(joined, [KEY])), true);
  assert.equal(resultTextOf(text, [KEY], "web_search"), "[redacted]");
});

test("a web call's property names are read: a held value in one is cut (two cut to one name both kept, the later numbered), one split across a name and its value withholds the result", () => {
  const holds = (joined) => withheldWhole(joined, [KEY]);
  const named = JSON.stringify({ query: "q", results: [{ url: "https://h.example/a", title: "t", [KEY]: "x", [Buffer.from(KEY).toString("hex")]: "y" }] });
  assert.equal(webHeld("web_search", named, holds), false);
  const shown = JSON.parse(webWithin(webShownOf("web_search", named, callEach([KEY])), 1000));
  assert.deepEqual(shown.results[0], { url: "https://h.example/a", title: "t", "[redacted]": "x", "[redacted] (2)": "y" });
  const split = JSON.stringify({ query: "q", results: [{ url: "https://h.example/a", [`n ${HEAD}`]: `${REST} v` }] });
  assert.equal(webHeld("web_search", split, holds), true);
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
