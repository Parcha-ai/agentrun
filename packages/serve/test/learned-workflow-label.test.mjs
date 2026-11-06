// A learned workflow's result line on the timeline: the output's fields as `name value`, a value whole or not at all (the
// timeline's redactor matches a held value only whole, so no value is ever cut into the line), on one line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { learnedText, outputLine } from "../dist/learned-workflow.js";

test("a value is in the line whole or only as its size, never cut: a held value can never leave a prefix the redactor misses", () => {
  const secret = `sk-${"A".repeat(150)}`;
  for (const pad of [0, 50, 100, 116, 117, 118, 119]) {
    const line = outputLine(JSON.stringify({ lead: "x".repeat(Math.min(pad, 60)), token: secret, total: 42 }));
    assert.ok(line !== undefined);
    for (let n = 4; n < secret.length; n++) assert.ok(!line.includes(secret.slice(0, n)) || line.includes(secret), `no prefix of the value (pad ${pad}): ${line}`);
    assert.match(line, /token \(153 characters\)/, line);
  }
  assert.equal(outputLine(JSON.stringify({ total: 49.75 })), "total 49.75");
});

test("a value's newlines are flattened, so every field fits on the one line the timeline shows", () => {
  assert.equal(outputLine(JSON.stringify({ note: "first\nsecond", total: 42 })), "note first second, total 42");
});

test("an output cut for the model says it was cut, not ok", () => {
  const long = learnedText(JSON.stringify({ text: "y".repeat(70_000) }));
  assert.match(outputLine(long) ?? "", /^its output is long, cut at \d+ of \d+ characters$/);
});
