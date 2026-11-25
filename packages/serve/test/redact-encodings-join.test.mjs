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
