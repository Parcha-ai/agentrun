// The runner's end-of-run turn refuses what the server's gate refused, in the same words: a write or edit under
// work/.learning/ (tool-gate.ts NOTE_ONLY_TEXT, underLearning), and keeps the server's request id for the turn
// (turns.ts REFLECT_REQUEST), so a run's timeline tells its rows apart as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_ONLY_TEXT, underLearning as gateUnderLearning } from "../dist/tool-gate.js";
import { REFLECT_REQUEST } from "../dist/turns.js";
import { REFLECT_NOTE_ONLY, reflectRequestId, underLearning } from "../dist/runner/end-of-run.js";

test("the refusal's words are the gate's", () => {
  assert.equal(REFLECT_NOTE_ONLY, NOTE_ONLY_TEXT);
});

test("the turn's request id is the server's", () => {
  assert.equal(reflectRequestId("run-1"), `${REFLECT_REQUEST}run-1`);
});

test("which paths are under work/.learning/ is the gate's rule", () => {
  const work = "/data/runs/run-1/work";
  const paths = [
    ".learning/note.md", ".learning", "./.learning/x/y.md", "@.learning/a.md", ".learning /a.md", "notes/.learning/a.md",
    ".learningx/a.md", "../work/.learning/a.md", `${work}/.learning/a.md`, `${work}/other.md`, "/workspace/.learning/a.md",
    "/workspace/a.md", "a.md", "", "..", ".learning/../a.md",
  ];
  for (const path of paths) assert.equal(underLearning(work, { path }), gateUnderLearning(work, { path }), `path ${JSON.stringify(path)}`);
  assert.equal(underLearning(work, {}), gateUnderLearning(work, {}));
  assert.equal(underLearning(undefined, { path: ".learning/a.md" }), true, "with no work folder known, a relative path still counts");
});
