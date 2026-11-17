// learning's redaction (learn/secrets.ts redactSecrets, valueMatcher) keeps what it derives of a set of held values (each
// value's spellings, its base64, hex and folded forms, its matchers) and reads them again for the next text under the
// same set: a run's view redacts every field and number it serves under one set. What a text is cut to never depends on
// that: a set met again cuts as it did, and a set that differs, by a value added, taken out or changed in place in the
// caller's array, or by the fold asked for, is read anew.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, valueMatcher } from "../dist/learn/secrets.js";

/** Test values, never real ones. */
const FIRST = "first-held-value-0123456789";
const SECOND = "second-held-value-9876543210";
const UUID = "c2e85e3f-ae11-4df6-aae7-2930a7ba4f19";
const TEXT = `one ${FIRST} and two ${SECOND} and ${Buffer.from(SECOND).toString("base64")}`;

test("a set of values met again cuts a text as it did the first time", () => {
  const values = [FIRST, SECOND];
  const once = redactSecrets(TEXT, values);
  assert.equal(once, "one [redacted] and two [redacted] and [redacted]A==", "the base64's last characters hold padding, not the value");
  assert.equal(redactSecrets(TEXT, [...values]), once, "the same values in a new array");
  assert.equal(redactSecrets(TEXT, values), once, "the same array");
});

test("a set that differs is read anew: a value added, one taken out, one changed in the caller's array", () => {
  assert.equal(redactSecrets(TEXT, [FIRST]), `one [redacted] and two ${SECOND} and ${Buffer.from(SECOND).toString("base64")}`);
  assert.equal(redactSecrets(TEXT, [FIRST, SECOND]), "one [redacted] and two [redacted] and [redacted]A==", "a value added");
  assert.equal(redactSecrets(TEXT, [SECOND]), `one ${FIRST} and two [redacted] and [redacted]A==`, "a value taken out");
  const values = [FIRST];
  assert.equal(redactSecrets(TEXT, values), `one [redacted] and two ${SECOND} and ${Buffer.from(SECOND).toString("base64")}`);
  values[0] = SECOND;
  assert.equal(redactSecrets(TEXT, values), `one ${FIRST} and two [redacted] and [redacted]A==`, "changed in place");
});

test("valueMatcher keeps each fold apart: a set read without folding, then with it, finds the folded form only then", () => {
  const folded = `open ${UUID.replaceAll("-", "").toUpperCase()} now`;
  assert.equal(valueMatcher([UUID], { fold: false })(folded), false);
  assert.equal(valueMatcher([UUID])(folded), true);
  assert.equal(valueMatcher([UUID], { fold: false })(folded), false, "the unfolded matcher again");
  assert.equal(valueMatcher([FIRST])(folded), false, "another set");
});
