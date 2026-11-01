// The ordered mandate a run's profile puts in its system prompt: which skills, in which order, the run's writer skill
// last, and the file the deliverable goes to. One function, one wording, for every harness: how a skill is loaded is the
// harness's to say.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mandateOf, withMandate } from "../dist/mandate.js";

const report = { name: "default", effort: "high", skills: ["effort-high", "report-writer"], output: { type: "report", file: "report.md", skills: ["report-writer"] } };

test("the skills in order, the writer right before the deliverable, and its file", () => {
  assert.equal(mandateOf(report), [
    "This run's profile (default) uses these skills, in this order: first `effort-high`, then `report-writer`. Each is listed to you as a skill or written out below.",
    "Use `report-writer`, the writer for this run's output (report), right before you write the deliverable.",
    "Write the deliverable to `report.md` in your workspace.",
  ].join("\n"));
});

test("one skill, more than two, an output with no file or no writer, two writers, and no output", () => {
  assert.equal(mandateOf({ name: "p", effort: "low", skills: ["effort-low"] }), "This run's profile (p) uses this skill: `effort-low`. It is listed to you as a skill or written out below.");
  assert.match(mandateOf({ name: "p", effort: "high", skills: ["a", "b", "c"] }), /first `a`, then `b`, then `c`\./);
  const answer = mandateOf({ name: "p", effort: "low", skills: ["effort-low"], output: { type: "answer", skills: [] } });
  assert.match(answer, /\nThis run's output \(answer\) is your final message: write no deliverable file\.$/);
  assert.doesNotMatch(answer, /writer/);
  assert.match(mandateOf({ name: "p", effort: "low", skills: ["effort-low"], output: { type: "notes", file: "notes.md", skills: [] } }), /\nWrite the deliverable to `notes\.md` in your workspace\.$/);
  const writers = mandateOf({ name: "p", effort: "low", skills: ["a", "w1", "w2"], output: { type: "site", file: "index.html", skills: ["w1", "w2"] } });
  assert.match(writers, /\nUse `w1` and `w2`, the writers for this run's output \(site\), right before you write the deliverable\.\n/);
});

test("withMandate puts the mandate after the instructions, and leaves them as they are without a profile", () => {
  assert.equal(withMandate("Answer.", undefined), "Answer.");
  assert.equal(withMandate("Answer.\n", report), `Answer.\n\n${mandateOf(report)}`);
});
