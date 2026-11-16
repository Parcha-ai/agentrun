// The runner makes the run's Workspace folder at the claim: the server's start made it before (design 2.1), so a pi run
// claimed on the runner must have its work folder there before its tools are built over it, else its first turn fails
// "the run's .../work folder is not there". A fresh, never-run run's spec builds, and its folder is there afterward.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";

test("a fresh, never-run run's spec builds and the runner has made its work folder", async (t) => {
  const { workFolder } = await specFor(t, { body: { tools: [] } });
  assert.equal(existsSync(workFolder), true, "the run's work folder is there after the spec is built");
});

test("the runner copies the run's uploaded files into work/inputs/ before the first turn", async (t) => {
  const { workFolder } = await specFor(t, { uploads: [{ path: "notes.txt", text: "the brief" }, { path: "docs/plan.md", text: "# plan" }] });
  assert.equal(readFileSync(join(workFolder, "inputs", "notes.txt"), "utf8"), "the brief");
  assert.equal(readFileSync(join(workFolder, "inputs", "docs", "plan.md"), "utf8"), "# plan");
});

// The run's opening message is a file of its inputs/ too, so a long one (a pasted diff) can be named to a subagent by its
// path and never copied into a call: inputs/message.md, byte for byte the start's `content`.
const PASTED = "Review this diff.\r\n\n```diff\n--- a/src/é.ts\n+++ b/src/é.ts\n@@ -1 +1 @@\n-const a = 1;  \n+const a = 2;\t\n```\n\n";

test("the runner saves the run's opening message as work/inputs/message.md, byte for byte, before the first turn", async (t) => {
  const { workFolder, spec } = await specFor(t, { launch: { input: { content: PASTED } } });
  assert.deepEqual(readFileSync(join(workFolder, "inputs", "message.md")), Buffer.from(PASTED, "utf8"));
  // The first message is the content as sent: the file is the message itself, never named in the run's files line.
  assert.equal(spec.input, PASTED);
});

test("a run with no text message gets no inputs/message.md", async (t) => {
  for (const input of [{}, { content: "" }, { topic: "a typed field, no content" }]) {
    const { workFolder } = await specFor(t, { launch: { input } });
    assert.equal(existsSync(join(workFolder, "inputs", "message.md")), false, JSON.stringify(input));
  }
});

test("inputs/message.md is the message's alone: an upload by that name takes the next free one, with a message or without", async (t) => {
  const withMessage = await specFor(t, { launch: { input: { content: "Read the notes." } }, uploads: [{ path: "message.md", text: "an upload" }] });
  assert.equal(readFileSync(join(withMessage.workFolder, "inputs", "message.md"), "utf8"), "Read the notes.");
  assert.equal(readFileSync(join(withMessage.workFolder, "inputs", "message-2.md"), "utf8"), "an upload");
  assert.equal(withMessage.spec.input, 'Read the notes.\n\nFiles for this run: "inputs/message-2.md" (9 B).');
  const without = await specFor(t, { launch: { input: { topic: "x" } }, uploads: [{ path: "message.md", text: "an upload" }] });
  assert.equal(existsSync(join(without.workFolder, "inputs", "message.md")), false);
  assert.equal(readFileSync(join(without.workFolder, "inputs", "message-2.md"), "utf8"), "an upload");
});
