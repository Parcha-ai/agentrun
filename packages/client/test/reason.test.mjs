// The server's reason at the end of an error message: one rule in this client and the Python one, from the same cases
// (reason-cases.json, which python/tests/test_reason.py reads too).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REASON_CHARS, said } from "../dist/errors.js";

const { cases } = JSON.parse(readFileSync(new URL("./reason-cases.json", import.meta.url), "utf8"));

test("a reason keeps one space for each whitespace run, drops every control, zero-width, bidi and BOM character, and is cut at REASON_CHARS code points after", () => {
  assert.equal(REASON_CHARS, 300, "the cases' length");
  for (const [message, end] of cases) {
    if (message === null) for (const error of [{ code: "x" }, undefined]) assert.equal(said(error), end, JSON.stringify(error));
    else assert.equal(said({ message }), end, JSON.stringify(message).slice(0, 80));
  }
});
