// A held value written in an encoding a writer emits, or split across strings with one: the whole-text check
// (redact/match.ts holds, through key-refusal.ts withheldWhole) withholds each, and the control written plainly elsewhere
// stays shown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redacted, withheldWhole } from "../dist/key-refusal.js";

test("a \"+\" after a held value's head, with a character reference or JSON written in a string, split across two strings, is withheld", () => {
  const held = ["abcdefgh"];
  for (const text of [
    '{"x":"abc&#100;+","y":"efgh"}',
    '{"body":"{\\"a\\":\\"abcd+\\",\\"b\\":\\"efgh\\"}"}',
  ]) assert.equal(withheldWhole(text, held), true, text);
  // Control: a visible separator between the halves is no spelling of the value.
  assert.equal(withheldWhole('{"x":"abc&#100;.","y":"efgh"}', held), false);
});

test("a numeric character reference with leading zeros, or with no closing \";\" (both read as the character by a browser), is read as its character", () => {
  const held = ["Azqwrtyp"];
  for (const spelled of ["&#00000000065;zqwrtyp", "&#x0000041;zqwrtyp", "&#65zqwrtyp", "&#x41zqwrtyp", "&#0065zqwrtyp"]) {
    assert.equal(withheldWhole(spelled, held), true, spelled);
    assert.equal(redacted(`see ${spelled} here`, held).includes("zqwrtyp"), false, spelled);
  }
  // Control: a reference past U+10FFFF stands for no character, so what follows it is no spelling of the value.
  assert.equal(withheldWhole("&#1114112zqwrtyp", held), false);
});

test("a held value an HTML escape wrote (&amp;, &lt;, &gt;, &quot;, &apos;) is read as written", () => {
  for (const [value, spelled] of [
    ["p&ss1234word", "p&amp;ss1234word"],
    ["a<b>c\"d'e1234", "a&lt;b&gt;c&quot;d&apos;e1234"],
    ["a<b>c\"d'e1234", "a&lt;b&gt;c&quot;d&#39;e1234"],
  ]) {
    assert.equal(withheldWhole(`see ${spelled} here`, [value]), true, spelled);
    assert.equal(redacted(`see ${spelled} here`, [value]).includes(spelled.slice(-6)), false, spelled);
  }
  // Control: an "&" before a word no escape writes (a URL's query) stays as it is.
  assert.equal(withheldWhole("see p&ampss1234word here", ["p&ss1234word"]), false);
});

test("a single-quoted dict (Python's repr) gets the join view: a held login reads across its name and value, a held value across two of its strings", () => {
  for (const [text, value] of [
    ["{'alice': 'secretpw'}", "alice:secretpw"],
    ["{'title': 'see abcd', 'snippet': 'efgh more'}", "abcdefgh"],
    [`{'a': 'say "hi" abcd', 'b': 'efgh'}`, "abcdefgh"],
  ]) {
    assert.equal(withheldWhole(text, [value]), true, text);
    assert.equal(redacted(text, [value]), "[redacted]", text);
  }
  // JSON's rules hold as they did: an apostrophe inside a "..." string is text, and one outside any string still reads
  // as part of the value beside it.
  assert.equal(withheldWhole(`{"a":"don't abcd","b":"efgh"}`, ["abcdefgh"]), true);
  assert.equal(withheldWhole(`"abcd" e'fgh`, ["abcde'fgh"]), true);
  // Control: another value under the held login's name is no spelling of it.
  assert.equal(withheldWhole("{'alice': 'other'}", ["alice:secretpw"]), false);
});

test("a single-quoted dict's strings read through Python's escapes: a held value with both quotes, its \\' escaped, split across two of them, is withheld", () => {
  for (const [text, value] of [
    [String.raw`{'a': 'ab\'cd"', 'b': 'efgh'}`, `ab'cd"efgh`],
    [String.raw`{'a': 'see ab\x27cd', 'b': 'efgh more'}`, "ab'cdefgh"],
    [String.raw`{'a': 'see a\\b\'cd', 'b': 'efgh'}`, String.raw`a\b'cdefgh`],
  ]) {
    assert.equal(withheldWhole(text, [value]), true, text);
    assert.equal(redacted(text, [value]), "[redacted]", text);
  }
  // Control: a single-quoted dict with an escaped apostrophe that holds no spelling of the value stays shown.
  assert.equal(withheldWhole(String.raw`{'a': 'it\'s ab', 'b': 'cd"efgh'}`, [`ab'cd"efgh`]), false);
});

test("a single-quoted dict written in a call's arguments (a JSON string's text) gets the quoted joins too, Python's escapes one level down", () => {
  // A call's arguments are read as JSON.stringify writes them, so a dict a model wrote in an argument is a JSON string's
  // text: its apostrophes as they are, its backslashes doubled.
  const [HEAD, REST] = [["Zq8V", "bN3x", "LmT6", "pR2w"].join(""), ["Yk9H", "sD4f", "Gj7A", "c5Ue"].join("")];
  for (const [args, value] of [
    [{ note: "{'alice': 'secretpw'}" }, "alice:secretpw"],
    [{ code: `d = {'a': 'see ${HEAD}', 'b': '${REST} more'}` }, `${HEAD}${REST}`],
    [{ code: String.raw`d = {'a': 'ab\'cd"', 'b': 'efgh'}` }, `ab'cd"efgh`],
    [{ code: String.raw`d = {'a': 'see ab\x41cd', 'b': 'efgh more'}` }, "abAcdefgh"],
  ]) assert.equal(withheldWhole(JSON.stringify(args), [value]), true, JSON.stringify(args));
  // Control: another value under the held login's name, in an argument, is no spelling of it.
  assert.equal(withheldWhole(JSON.stringify({ note: "{'alice': 'other'}" }), ["alice:secretpw"]), false);
});

test("a JSON string's text read again for a dict written in it is closed off from the text's own parts: no held value reads across the seam", () => {
  // Greptile's case: the values read again come after the values as they are, "abcd efgh" then "abcd efgh", and
  // "efgh abcd" is no spelling the text holds. And one string read again whose own end and first part read again
  // would join as "abcd efgh", where the text holds efgh before abcd.
  for (const text of ['{"don\'t":"abcd","x":"efgh"}', `{"x":"{'a': 'efgh'} abcd"}`]) {
    assert.equal(withheldWhole(text, [text.startsWith('{"don') ? "efghabcd" : "abcdefgh"]), false, text);
  }
});
