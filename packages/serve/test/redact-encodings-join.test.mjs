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
