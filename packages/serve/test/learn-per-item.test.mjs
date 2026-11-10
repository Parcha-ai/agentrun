// A count or size cap broken by some items of a run's answer leaves those items out and keeps the rest (propose.ts over
// learn/check.ts): a ninth new note, a note over its size, a second skill, and a note that takes the notes superseded past
// the cap are each left out, named in `left`, and the other items go on to the grader. Only what no one item is past (the
// index's total) still refuses the whole answer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CAPS } from "../dist/learn/check.js";
import { learningCommit } from "../dist/learn/commit.js";
import { seedOf } from "../dist/learning.js";
import { proposeRun } from "../dist/propose.js";
import { learningWorkspace } from "../dist/workspace/index.js";
import { note } from "./learn-format-support.mjs";

const AGENT = "agent-1";
const block = (file, text) => `\`\`\`note ${file}\n${text}\`\`\``;
const skillBlock = (name) => `\`\`\`\`skill ${name}\n---\nname: ${name}\ndescription: Do ${name}\n---\nStep one.\n\`\`\`\``;
const notes = (n, from = 0) => Array.from({ length: n }, (_, i) => block(`n${from + i}.md`, note({ name: `N${from + i}`, description: `D${from + i}` })));

/** A learning folder whose main holds `seed` (file to text), and proposeRun over `answer` against it. */
async function proposed(t, answer, seed = {}) {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-per-item-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const landing = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    for (const [file, text] of Object.entries(seed)) {
      const made = await learningCommit(landing.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
      assert.equal(made.ok, true, JSON.stringify(made));
    }
  } finally {
    await landing.end();
  }
  const { sha } = await seedOf(data, AGENT);
  const runDir = mkdtempSync(join(data, "run-"));
  const folder = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    return await proposeRun({ folder: folder.workspace, runDir, seed: sha, turn: { answer, asked: [] }, refuse: [], outcome: "completed" });
  } finally {
    await folder.end();
  }
}

const leftOf = (result) => (result.left ?? []).map(({ rule, path }) => [rule, path]);

test("a ninth new note is left out and the eight before it are kept", async (t) => {
  const result = await proposed(t, notes(CAPS.newNotes + 1).join("\n\n"));
  assert.equal(result.state, "proposed", JSON.stringify(result));
  assert.equal(result.notes, CAPS.newNotes);
  assert.deepEqual(leftOf(result), [["too_many_notes", `n${CAPS.newNotes}.md`]]);
});

test("a note over the size cap is left out and the others are kept", async (t) => {
  const big = note({ name: "Big", description: "Too big", body: `${"x".repeat(CAPS.runNote)}\n` });
  const result = await proposed(t, [...notes(2), block("big.md", big)].join("\n\n"));
  assert.equal(result.state, "proposed", JSON.stringify(result));
  assert.equal(result.notes, 2);
  assert.deepEqual(leftOf(result), [["too_large", "big.md"]]);
});

test("a second skill is left out and the first skill and the notes are kept", async (t) => {
  const result = await proposed(t, [...notes(1), skillBlock("check-refunds"), skillBlock("check-shipping")].join("\n\n"));
  assert.equal(result.state, "proposed", JSON.stringify(result));
  assert.deepEqual([result.notes, result.skills], [1, 1]);
  assert.deepEqual(leftOf(result), [["too_many_skills", "skills/check-shipping/SKILL.md"]]);
});

test("a note that takes the notes superseded past the cap is left out, after a first pass that left out another", async (t) => {
  // Twelve active notes; a.md supersedes eight of them, b.md a ninth (past the cap), and c.md is over the size cap: the
  // first pass names c.md alone (the supersedes count is asked only of a rest with no other problem), the second b.md.
  const seed = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`old${i}.md`, note({ name: `Old${i}`, description: `Old ${i}` })]));
  const olds = (from, n) => Array.from({ length: n }, (_, i) => `old${from + i}.md`).join(", ");
  const answer = [
    block("a.md", note({ name: "A", description: "A", extra: `supersedes: [${olds(0, CAPS.supersedes)}]\n` })),
    block("b.md", note({ name: "B", description: "B", extra: `supersedes: [${olds(CAPS.supersedes, 1)}]\n` })),
    block("c.md", note({ name: "C", description: "C", body: `${"x".repeat(CAPS.runNote)}\n` })),
  ].join("\n\n");
  const result = await proposed(t, answer, seed);
  assert.equal(result.state, "proposed", JSON.stringify(result));
  assert.equal(result.notes, 1);
  assert.deepEqual(leftOf(result), [["too_large", "c.md"], ["supersedes", "b.md"]]);
});
