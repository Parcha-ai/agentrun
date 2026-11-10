// Which of an agent's notes a run gets is one port (learning.ts NoteSelector), behind learnedOf and givenOf. Its default,
// byRecency, gives exactly what the server gave before the port: the golden (fixtures/note-selector-golden.json) is
// learnedOf and givenOf as main answered them over note-selector-cases.mjs. Another selector chooses alone: the section and
// the given notes are its one choice, cut of the host's secrets as ever, and it reads the run's input.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CASES, OPTIONS, SECRET } from "./note-selector-cases.mjs";

const { byRecency, givenOf, learnedOf, learnedParts, secretsShown } = await import("../dist/learning.js");
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/note-selector-golden.json", import.meta.url), "utf8"));

test("the default selector, by recency, gives every case exactly what the server gave before the port: the section and the given notes", () => {
  assert.equal(Object.keys(GOLDEN).length, CASES.length * OPTIONS.length);
  for (const [name, seed] of CASES) for (const [label, opts] of OPTIONS) {
    const key = `${name} | ${label}`;
    for (const options of [{ ...opts, shown: secretsShown([SECRET]) }, { ...opts, shown: secretsShown([SECRET]), select: byRecency, run: { input: { content: "anything" } } }]) {
      assert.equal(learnedOf(seed, options) ?? null, GOLDEN[key].section, `${key}: the section`);
      assert.deepEqual(givenOf(seed, options), GOLDEN[key].given, `${key}: the given notes`);
    }
  }
});

test("another selector chooses alone: the run reads the notes it picks whole, with or without the index, and is given just those; it reads the run's input and the candidates' sizes", () => {
  const [, seed] = CASES.find(([name]) => name === "forty past the budget");
  const asked = [];
  // Picks the one note whose rule the input names, and no index.
  const byInput = (candidates, run) => {
    asked.push({ run, count: candidates.notes.length, sized: candidates.notes.every(({ bytes }) => bytes > 0), budget: candidates.budget });
    const wanted = /note (\d+)/.exec(run.input.content)?.[1];
    return { whole: candidates.notes.filter(({ note }) => note.name === `Note ${wanted}`).map(({ note }) => note), index: false };
  };
  const options = { budget: 8000, read: true, shown: secretsShown([SECRET]), select: byInput, run: { input: { content: "use note 7" } } };
  const { section, given } = learnedParts(seed, options);
  assert.deepEqual(given.map(({ file }) => file), ["note-07.md"]);
  assert.ok(section.startsWith("What you learned in earlier runs: each note whole") && section.includes("## Note 7 (note-07.md)") && !section.includes("note-08.md"), section.slice(0, 200));
  assert.deepEqual(asked, [{ run: { input: { content: "use note 7" } }, count: 40, sized: true, budget: 8000 }]);
  // With the index: the index first, then its pick; given is what the index names and what it picked.
  const withIndex = learnedParts(seed, { ...options, select: (candidates) => ({ whole: [candidates.notes[5].note], index: true }) });
  assert.ok(withIndex.section.includes("- [Note 0](note-00.md)") && withIndex.section.includes("## Note 34 (note-34.md)"), withIndex.section.slice(0, 200));
  assert.equal(withIndex.given.length, 40);
});

test("a selector never undoes the cut: a note holding a value the host keeps secret reads [redacted] whatever picks it", () => {
  const [, seed] = CASES.find(([name]) => name === "a note holding a secret");
  const all = (candidates) => ({ whole: candidates.notes.map(({ note }) => note), index: true });
  const { section } = learnedParts(seed, { budget: 8000, read: true, shown: secretsShown([SECRET]), select: all });
  assert.ok(!section.includes(SECRET) && section.includes("[redacted]"), section);
});

const { byRelevance } = await import("../dist/learning.js");
const { topical } = await import("./note-selector-cases.mjs");
const shown = secretsShown([SECRET]);
const wholeFiles = (section) => [...section.matchAll(/^## .* \(([^)]+)\)$/gm)].map((m) => m[1]);
const lineFiles = (section) => [...section.matchAll(/^- .* \(([^)]+)\): /gm)].map((m) => m[1]);

test("past the budget, a run about one topic reads that topic's notes whole, best first, and one rule line for each of the rest in place of the index; by recency it read the newest", () => {
  const seed = topical(40);
  const run = { input: { content: "Reconcile this month's invoices against the ledger; two are in a different currency." } };
  const relevant = learnedParts(seed, { budget: 8000, read: true, shown, run });
  const whole = wholeFiles(relevant.section);
  assert.ok(whole.length >= 3 && whole.every((file) => file.startsWith("invoices-")), `the invoice notes whole: ${whole.join(", ")}`);
  assert.ok(relevant.section.startsWith("What you learned in earlier runs: the notes that bear most on this run whole"), relevant.section.slice(0, 120));
  // Every other note as one line, none twice, and the read tool told of the files.
  const lines = lineFiles(relevant.section);
  assert.deepEqual([...lines, ...whole].sort(), Object.keys(seed.notes).sort());
  assert.ok(relevant.section.includes("open one with the read tool"), "the read tool is told of the rest");
  assert.ok(!relevant.section.includes("- [Reconcile invoices"), "no index line: the rule lines take its place");
  assert.deepEqual(relevant.given.map(({ file }) => file).sort(), Object.keys(seed.notes).sort(), "given: every note, whole or as a line");
  assert.ok(Buffer.byteLength(relevant.section) < 8000 + 2_000, `about the budget: ${Buffer.byteLength(relevant.section)} bytes`);
  // By recency the same run read the newest notes, whatever their topic.
  const recent = learnedParts(seed, { budget: 8000, read: true, shown, run, select: byRecency });
  assert.ok(wholeFiles(recent.section).some((file) => !file.startsWith("invoices-")), wholeFiles(recent.section).join(", "));
});

test("a code review's changed paths count: a diff touching the migrations reads the migration notes whole", () => {
  const seed = topical(40);
  const diff = ["Review this change.", "diff --git a/db/migrations/0042_add_index.sql b/db/migrations/0042_add_index.sql", "--- a/db/migrations/0042_add_index.sql", "+++ b/db/migrations/0042_add_index.sql", "@@ -0,0 +1 @@", "+CREATE INDEX ix ON t (a);"].join("\n");
  const whole = wholeFiles(learnedParts(seed, { budget: 8000, read: false, shown, run: { input: { content: diff } } }).section);
  assert.ok(whole.length && whole.every((file) => file.startsWith("migrations-")), whole.join(", "));
});

test("within the budget nothing changes, whatever the input: the default reads every case as recency did", () => {
  for (const [name, seed] of CASES) for (const [label, opts] of OPTIONS) {
    const options = { ...opts, shown, run: { input: { content: "Note 1 applies: the rule about note 2." } } };
    const fits = Object.values(seed.notes).reduce((sum, text) => sum + Buffer.byteLength(text), 0) < opts.budget / 2;
    if (!fits) continue;
    assert.equal(learnedOf(seed, options) ?? null, GOLDEN[`${name} | ${label}`].section, `${name} | ${label}`);
  }
});

test("an input with no word any note holds, or none at all, reads by recency past the budget too", () => {
  for (const [name, seed] of CASES) for (const [label, opts] of OPTIONS) {
    for (const input of [undefined, { content: "" }, { content: "zzzz qqqq" }]) {
      const options = { ...opts, shown, ...(input ? { run: { input } } : {}) };
      assert.equal(learnedOf(seed, options) ?? null, GOLDEN[`${name} | ${label}`].section, `${name} | ${label} | ${JSON.stringify(input)}`);
      assert.deepEqual(givenOf(seed, options), GOLDEN[`${name} | ${label}`].given);
    }
  }
  assert.deepEqual(byRelevance({ notes: [], indexBytes: 0, indexComplete: true, budget: 0 }, {}), { whole: [], index: false });
});
