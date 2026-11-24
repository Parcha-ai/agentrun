// The server's reason at the end of an error message: one rule in this client and the Python one, from the same cases
// (reason-cases.json, which python/tests/test_reason.py reads too).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REASON_CHARS, said } from "../dist/errors.js";

const { cases } = JSON.parse(readFileSync(new URL("./reason-cases.json", import.meta.url), "utf8"));

test("a reason keeps one space for each whitespace run and drops every control, zero-width, bidi and BOM character", () => {
  for (const [message, end] of cases) assert.equal(said({ message }), end, JSON.stringify(message));
});

test("a reason is cut at REASON_CHARS code points after it is cleaned, the last a …", () => {
  assert.equal(said({ message: "x".repeat(400) }), `: ${"x".repeat(REASON_CHARS - 1)}…`);
  assert.equal(said({ message: "\u0000x".repeat(REASON_CHARS) }), `: ${"x".repeat(REASON_CHARS)}`, "dropped characters are not counted");
  assert.equal(said({ message: "😀".repeat(400) }), `: ${"😀".repeat(REASON_CHARS - 1)}…`, "a code point is one character");
  assert.equal(said({ code: "x" }), "");
  assert.equal(said(undefined), "");
});
