// B1 (learn-loop SPEC): past the learning budget a run reads the notes that bear most on it WHOLE, and its log names the
// notes its # Learned section leaves out. Run B (MCC, 11-12) reproduced: once the agent held ~50 notes, their one-line
// descriptions alone took the 8,000-byte budget, so from then on every run got one-liners only (s1 end: 170 lines,
// 0 bodies), and an MCC job has no read tool to open the rest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";

const { learnedParts, secretsShown, LEARNING_BUDGET } = await import("../dist/learning.js");
const { notesLeftOutLine, LEFT_OUT_NAMED } = await import("../dist/runner/learning-seed.js");
const { readLaunchBody, launchBody } = await import("../dist/run-launch.js");

const shown = secretsShown([]);
const wholeFiles = (section) => [...(section ?? "").matchAll(/^## .* \(([^)]+)\)$/gm)].map((m) => m[1]);
const lineFiles = (section) => [...(section ?? "").matchAll(/^- .* \(([^)]+)\): /gm)].map((m) => m[1]);

/** `n` notes as Run B's MCC agent kept them: one per merchant, a long one-line description, a short body; and every
 *  `general`-th one a general method. The newest first, with an index naming each. */
function mccSeed(n, general = 10) {
  const files = Array.from({ length: n }, (_, i) => (i % general === 0 ? `method-${String(i).padStart(3, "0")}.md` : `merchant-${String(i).padStart(3, "0")}-mcc.md`));
  const notes = Object.fromEntries(files.map((file, i) => [file, i % general === 0
    ? note(`Descriptor method ${i}`, "Classify a card descriptor by the merchant's website: read what it sells, then pick the four-digit code for that line of business", "When the descriptor names a website, open it and read what the merchant sells before picking a code.\nPrefer the code for the main line of business over a side product.\n")
    : note(`Merchant ${i} code`, `Merchant ${i} trading as Shop${i} Holdings Ltd is a reseller of assorted goods; its reference code is ${5000 + i} per the review`, `Shop${i} Holdings Ltd: answer ${5000 + i}.\n`)]));
  const index = files.map((file) => `- [${file}](${file}) — a note`).join("\n");
  return { sha: "m".repeat(40), index, notes, files: [...files, "MEMORY.md"], skipped: [], recent: [...files].reverse() };
}

const MCC_INPUT = { content: "Card descriptor: SQ *BLUEBIRD BAKERY. Website: bluebird.example. Classify the merchant's line of business with its four-digit code." };

test("past ~50 notes a run still reads the notes that bear on it whole, not one line for every note (Run B: 0 bodies from 45 notes on)", () => {
  for (const n of [50, 120, 200]) {
    const { section, given, left } = learnedParts(mccSeed(n), { budget: LEARNING_BUDGET, read: false, shown, run: { input: MCC_INPUT } });
    const whole = wholeFiles(section);
    assert.ok(whole.length >= 3, `${n} notes: ${whole.length} given whole`);
    assert.ok(whole.slice(0, 3).every((file) => file.startsWith("method-")), `${n} notes: the general methods bear most on it and come first whole: ${whole.join(", ")}`);
    assert.ok(Buffer.byteLength(section) <= LEARNING_BUDGET, `${n} notes: the section fits the budget: ${Buffer.byteLength(section)}`);
    // Every note is given (whole or as a line) or left out, never both, and the left-out ones are named.
    assert.deepEqual([...given.map(({ file }) => file), ...left.map(({ file }) => file)].sort(), Object.keys(mccSeed(n).notes).sort());
    assert.deepEqual(given.map(({ file }) => file).sort(), [...whole, ...lineFiles(section)].sort());
    assert.ok(left.length > 0, `${n} notes: some are left out`);
  }
});

test("an input no note shares a word with reads the newest notes whole past the budget, never one line each", () => {
  const { section, left } = learnedParts(mccSeed(120), { budget: LEARNING_BUDGET, read: true, shown, run: { input: { content: "zzzz qqqq" } } });
  const whole = wholeFiles(section);
  assert.ok(whole.length >= 3, `${whole.length} given whole`);
  assert.equal(whole[0], "merchant-119-mcc.md", "the newest first");
  assert.ok(Buffer.byteLength(section) <= LEARNING_BUDGET, `${Buffer.byteLength(section)} bytes`);
  assert.ok(section.includes("open one with the read tool"), "an agent with the read tool is told where the rest are");
  assert.ok(left.length > 0);
});

test("within the budget nothing is left out", () => {
  const { left, given } = learnedParts(mccSeed(5), { budget: LEARNING_BUDGET, read: false, shown, run: { input: MCC_INPUT } });
  assert.deepEqual(left, []);
  assert.equal(given.length, 5);
});

test("the run's log names the notes its # Learned section leaves out, at most LEFT_OUT_NAMED of them, and how many more", () => {
  assert.equal(notesLeftOutLine(undefined), undefined);
  assert.equal(notesLeftOutLine([]), undefined);
  const line = notesLeftOutLine(["a.md", "b.md"]);
  assert.match(line, /^starts without 2 of the notes its agent learned in its # Learned section, over the learning budget/);
  assert.match(line, /: a\.md, b\.md$/);
  const many = Array.from({ length: LEFT_OUT_NAMED + 7 }, (_, i) => `n-${i}.md`);
  const long = notesLeftOutLine(many);
  assert.match(long, /, and 7 more$/);
  assert.ok(long.includes(`n-${LEFT_OUT_NAMED - 1}.md`) && !long.includes(`n-${LEFT_OUT_NAMED}.md,`));
});

test("the launch keeps the left-out notes for the claim: written and read back", () => {
  const launch = { input: {}, title: "", place: { mode: "runner" }, learning: { given: [], seed: "s", section: "x", notesLeftOut: ["a.md", "b.md"] } };
  const body = launchBody(launch);
  const read = readLaunchBody(JSON.parse(JSON.stringify(body)));
  assert.deepEqual(read.learning.notesLeftOut, ["a.md", "b.md"]);
});
