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
