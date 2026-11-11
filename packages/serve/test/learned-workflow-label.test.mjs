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

test("a text output is summed up line by line, each line whole or only as its size, never cut, within the one line (#2412)", () => {
  assert.equal(outputLine("| Category | Count | Total |\n|---|---|---|\n\nFlagged: none\nGrand total: $2.00"), "| Category | Count | Total | / |---|---|---| / Flagged: none / Grand total: $2.00");
  const secret = `sk-${"A".repeat(150)}`;
  for (const pad of [0, 50, 100, 116, 117, 118, 119]) {
    const line = outputLine(`${"x".repeat(Math.min(pad, 60))}\n${secret}\nGrand total: $2.00`);
    assert.ok(line !== undefined);
    for (let n = 4; n < secret.length; n++) assert.ok(!line.includes(secret.slice(0, n)) || line.includes(secret), `no prefix of the value (pad ${pad}): ${line}`);
    assert.match(line, /\(153 characters\)/, line);
  }
  const many = Array.from({ length: 20 }, (_, i) => `Line ${i} of the report`).join("\n");
  const said = outputLine(many);
  assert.ok(said.length <= 125 && said.endsWith(" / …"), said);
  assert.equal(outputLine("   \n  "), undefined, "no words, no line");
});

test("a held value a text output breaks across two lines is on no row, in either half: the row's words come from the whole text as redacted, before any line is taken (#2452)", async () => {
  const { timelineOf } = await import("../dist/timeline/index.js");
  const { redacted } = await import("../dist/key-refusal.js");
  const { assistant, call, result, user } = await import("./timeline-lib-support.mjs");
  const held = ["not-a-secret", "held-workflow-key", "0123456789abcdef"].join("-");
  const cut = 24;
  const text = `| Category | Count | Total |\n|---|---|---|\nKey: ${held.slice(0, cut)}\n${held.slice(cut)}\nGrand total: $2.00`;
  const rows = timelineOf([user("Run it."), assistant([call("w1", "learned_workflow", { name: "card-report", input: { text: "x" } })]), result("w1", "learned_workflow", text)], { redact: (t) => redacted(t, [held]) });
  const row = rows.find((r) => r.kind === "tool_result" && r.tool_name === "learned_workflow");
  assert.ok(row, JSON.stringify(rows.map((r) => r.kind)));
  const all = JSON.stringify(rows);
  for (let i = 0; i + 8 <= held.length; i++) assert.ok(!all.includes(held.slice(i, i + 8)), `a run of the held value at ${i}: ${row.summary}`);
  assert.match(row.summary, /^Ran the learned workflow card-report: /, row.summary);
});
