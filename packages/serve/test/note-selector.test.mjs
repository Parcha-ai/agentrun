// Which of an agent's notes a run gets is one port (learning.ts NoteSelector), behind learnedParts. byRecency, and the
// default (byRelevance) on an input no note bears on, give exactly what the server gave before the port: the golden
// (fixtures/note-selector-golden.json) is the section and the given notes as main answered them over
// note-selector-cases.mjs. Another selector chooses alone: the section and the given notes are its one choice, cut of
// the host's secrets as ever, and it reads the run's input.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CASES, OPTIONS, SECRET } from "./note-selector-cases.mjs";

const { byRecency, learnedParts, secretsShown } = await import("../dist/learning.js");
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/note-selector-golden.json", import.meta.url), "utf8"));

test("the default selector, by recency, gives every case exactly what the server gave before the port: the section and the given notes", () => {
  assert.equal(Object.keys(GOLDEN).length, CASES.length * OPTIONS.length);
  for (const [name, seed] of CASES) for (const [label, opts] of OPTIONS) {
    const key = `${name} | ${label}`;
    for (const options of [{ ...opts, shown: secretsShown([SECRET]) }, { ...opts, shown: secretsShown([SECRET]), select: byRecency, run: { input: { content: "anything" } } }]) {
      assert.equal(learnedParts(seed, options).section ?? null, GOLDEN[key].section, `${key}: the section`);
      assert.deepEqual(learnedParts(seed, options).given.map(({ file, name }) => ({ file, name })), GOLDEN[key].given, `${key}: the given notes`);
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
    assert.equal(learnedParts(seed, options).section ?? null, GOLDEN[`${name} | ${label}`].section, `${name} | ${label}`);
  }
});

test("an input with no word any note holds, or none at all, reads by recency past the budget too", () => {
  for (const [name, seed] of CASES) for (const [label, opts] of OPTIONS) {
    for (const input of [undefined, { content: "" }, { content: "zzzz qqqq" }]) {
      const options = { ...opts, shown, ...(input ? { run: { input } } : {}) };
      assert.equal(learnedParts(seed, options).section ?? null, GOLDEN[`${name} | ${label}`].section, `${name} | ${label} | ${JSON.stringify(input)}`);
      assert.deepEqual(learnedParts(seed, options).given.map(({ file, name }) => ({ file, name })), GOLDEN[`${name} | ${label}`].given);
    }
  }
  assert.deepEqual(byRelevance({ notes: [], indexBytes: 0, indexComplete: true, budget: 0 }, {}), { whole: [], index: false });
});

const REFUNDS = "What is our refund window for annual plans? Quote the policy page.";
const MIGRATION_DIFF = ["Review this PR.", "diff --git a/db/migrations/0042.sql b/db/migrations/0042.sql", "--- a/db/migrations/0042.sql", "+++ b/db/migrations/0042.sql"].join("\n");

test("the section by relevance fits the budget whole, its intro, blank lines and read-tool line counted, for a prose input and a diff, with the read tool and without", () => {
  for (const n of [40, 50]) for (const content of [REFUNDS, MIGRATION_DIFF]) for (const read of [true, false]) {
    const { section, given } = learnedParts(topical(n), { budget: 8000, read, shown, run: { input: { content } } });
    assert.ok(Buffer.byteLength(section) <= 8000, `${n} notes, ${content.slice(0, 20)}, read ${read}: ${Buffer.byteLength(section)} bytes`);
    assert.ok(wholeFiles(section).length >= 1, "still some notes whole");
    assert.equal(given.length, n, "every note given, whole or as a line");
  }
});

test("notes that score the same are read newest first, as recency orders them: refunds-46 before refunds-06", () => {
  const whole = wholeFiles(learnedParts(topical(50), { budget: 8000, read: true, shown, run: { input: { content: REFUNDS } } }).section);
  assert.ok(whole.every((file) => file.startsWith("refunds-")), whole.join(", "));
  assert.deepEqual(whole, [...whole].sort((a, b) => Number(b.slice(-5, -3)) - Number(a.slice(-5, -3))), `newest first: ${whole.join(", ")}`);
  assert.equal(whole[0], "refunds-46.md");
});

test("past 25 KB of budget, the room kept for the rest's lines is only what is served of them (200 lines, 25 KB): with 150 notes and 32 KB, the notes that bear on the run are picked whole (#2274 review)", () => {
  const { INDEX_BYTES } = { INDEX_BYTES: 25_000 };
  // 150 notes: each line 250 bytes (37.5 KB of lines in all, past what is served of them), each note 600 bytes whole.
  const notes = Array.from({ length: 150 }, (_, i) => {
    const topic = i < 5 ? "refund" : `topic${i}`;
    return { note: { file: `n-${i}.md`, name: `${topic} ${i}`, description: `About ${topic}`, body: `${topic} ${topic} rule ${i}.` }, bytes: 600, lineBytes: 250 };
  });
  const budget = 32_000;
  const choice = byRelevance({ notes, indexBytes: 0, indexComplete: true, budget }, { input: { content: "A refund request came in." } });
  assert.ok(choice.whole.length > 0, `notes that bear on the run are picked whole: ${choice.whole.length}`);
  assert.ok(choice.whole.every((note) => note.name.startsWith("refund")), JSON.stringify(choice.whole.map((note) => note.name)));
  // What is served fits the budget: the whole notes and the lines served of the rest, at most 25 KB of them.
  const served = choice.whole.length * 600 + choice.lines.length * 250;
  assert.ok(choice.lines.length * 250 <= INDEX_BYTES && served <= budget, JSON.stringify({ whole: choice.whole.length, lines: choice.lines.length, served }));
});
