// The pieces of consolidation in the loop (learn/consolidate.ts), before any model call: which active notes cluster as
// one rule (a lexical match, body against body, at most CLUSTER_NOTES a cluster and CLUSTERS a run), which skill and
// workflow draft of a job drifted apart (one changed, its partner not), when a consolidation is due (after
// CONSOLIDATE_MERGES merges past the serve budget, or on a drifted pair), how notes rank by evidence (read and given),
// and the code check behind the grader's "keeps every rule": a replacement supersedes only its cluster's notes, and a
// cluster note no replacement names stays active.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";

const consolidate = await import("../dist/learn/consolidate.js");
const { CLUSTER_NOTES, CLUSTERS, CONSOLIDATE_BUDGET, CONSOLIDATE_MERGES, clustersOf, consolidationDue, driftedPairs, rankOf, ranked, replacementProblems } = consolidate;
const { parseNoteFile } = await import("../dist/learn/notes.js");

const parsed = (file, name, description, body) => parseNoteFile(file, note(name, description, `${body}\n`));
const INVOICES = [
  parsed("invoice-currency.md", "Invoice currency", "Check each invoice's currency", "Before reconciling invoices, check each invoice's currency against the ledger currency."),
  parsed("invoice-ledger.md", "Invoice ledger match", "Match invoices to the ledger", "Reconcile each invoice total against its ledger entry and flag invoices in another currency."),
  parsed("invoice-totals.md", "Invoice totals", "Ledger totals per invoice", "When reconciling, match every invoice total to the ledger entry; a currency mismatch is flagged."),
];
const OTHERS = [
  parsed("tables.md", "Answer with tables", "Compare options in a table", "When comparing options, answer with a table, one row per option."),
  parsed("migrations.md", "Down migrations", "Every migration gets a down", "Every schema migration gets a down migration and runs inside one transaction."),
];

test("the constants are named in one place: 5 merges, the 8 KB serve budget, 6 clusters of at most 6 notes", () => {
  assert.deepEqual([CONSOLIDATE_MERGES, CONSOLIDATE_BUDGET, CLUSTERS, CLUSTER_NOTES], [5, 8000, 6, 6]);
});

test("notes of one rule cluster, body against body; unrelated notes are in no cluster; a cluster seeds on its best-ranked note", () => {
  const clusters = clustersOf([...OTHERS, ...INVOICES]);
  assert.deepEqual(clusters.map((cluster) => cluster.map(({ file }) => file).sort()), [["invoice-currency.md", "invoice-ledger.md", "invoice-totals.md"]]);
  // Ranked first by evidence: the cluster's head is the note read most.
  const rank = new Map([["invoice-totals.md", 9], ["invoice-ledger.md", 1]]);
  assert.equal(clustersOf(INVOICES, (n) => rank.get(n.file) ?? 0)[0][0].file, "invoice-totals.md");
  assert.deepEqual(clustersOf(OTHERS), [], "no two notes of one rule");
});

test("a cluster holds at most CLUSTER_NOTES notes, and a run at most CLUSTERS clusters", () => {
  const many = Array.from({ length: 9 }, (_, i) => parsed(`refund-${i}.md`, `Refund window ${i}`, "Quote the refund window", "Refund policies live under /help/refunds; quote the refund window in days."));
  const clusters = clustersOf(many);
  assert.ok(clusters.every((cluster) => cluster.length <= CLUSTER_NOTES), clusters.map((c) => c.length).join(","));
  assert.equal(clusters.flat().length, 9, "the rest form a second cluster");
  const topics = Array.from({ length: 8 }, (_, t) => Array.from({ length: 2 }, (_, i) => parsed(`t${t}-${i}.md`, `Topic ${t}`, `About subject${t}`, `Rule about subject${t} widget${t} gadget${t} always.`))).flat();
  assert.equal(clustersOf(topics).length, CLUSTERS);
});

test("a skill and its workflow draft drift apart when a merge changes one and not the other: partners by name, or a draft whose README names the skill", () => {
  const skills = [{ name: "weekly-summary", description: "The weekly summary" }, { name: "expenses", description: "File expenses" }];
  const workflows = [{ name: "weekly-summary", readme: "Writes the weekly summary." }, { name: "expense-run", readme: "Runs the expenses skill's steps as a workflow." }, { name: "lonely", readme: "No partner." }];
  assert.deepEqual(driftedPairs({ skills, workflows }, ["skills/weekly-summary/SKILL.md"]), [{ skill: "weekly-summary", workflow: "weekly-summary", changed: "skill" }]);
  assert.deepEqual(driftedPairs({ skills, workflows }, ["workflows/expense-run/workflow.json"]), [{ skill: "expenses", workflow: "expense-run", changed: "workflow" }]);
  assert.deepEqual(driftedPairs({ skills, workflows }, ["skills/weekly-summary/SKILL.md", "workflows/weekly-summary/workflow.json"]), [], "both changed: in step");
  assert.deepEqual(driftedPairs({ skills, workflows }, ["workflows/lonely/workflow.json", "notes.md"]), [], "no partner, no pair");
});

test("a consolidation is due after 5 merges past the serve budget, or on a drifted pair; never while one is queued", () => {
  const base = { mergesSince: 5, activeBytes: 9000, drifted: 0, queued: false };
  assert.equal(consolidationDue(base), "growth");
  assert.equal(consolidationDue({ ...base, mergesSince: 4 }), undefined, "too few merges");
  assert.equal(consolidationDue({ ...base, activeBytes: 8000 }), undefined, "within the budget");
  assert.equal(consolidationDue({ ...base, mergesSince: 0, activeBytes: 0, drifted: 1 }), "drift");
  assert.equal(consolidationDue({ ...base, drifted: 1, queued: true }), undefined, "one at a time");
});

test("rank: read·3 + min(given, 10)·0.1; ties go to the newer note", () => {
  assert.equal(rankOf({ read: 2, given: 30 }), 7);
  assert.equal(rankOf({ read: 0, given: 4 }), 0.4);
  const runs = new Map([["a.md", { read: 1, given: 3 }], ["b.md", { read: 1, given: 3 }], ["c.md", { read: 0, given: 50 }]]);
  // Newest first: c, b, a.
  assert.deepEqual(ranked(["c.md", "b.md", "a.md"], runs), ["b.md", "a.md", "c.md"]);
});

test("the code check behind the grader: a replacement supersedes only its cluster's notes; a cluster note no replacement names stays active", () => {
  const cluster = ["invoice-currency.md", "invoice-ledger.md", "invoice-totals.md"];
  const merged = parsed("invoice-reconcile.md", "Reconcile invoices", "Invoices against the ledger", "Match totals, check currency.");
  const ok = replacementProblems(cluster, [{ ...merged, supersedes: cluster }]);
  assert.deepEqual([ok.problems, ok.stayActive], [[], []]);
  const partial = replacementProblems(cluster, [{ ...merged, supersedes: ["invoice-currency.md", "invoice-ledger.md"] }]);
  assert.deepEqual([partial.problems, partial.stayActive], [[], ["invoice-totals.md"]], "left out: stays active, never dropped");
  const outside = replacementProblems(cluster, [{ ...merged, supersedes: ["invoice-currency.md", "tables.md"] }]);
  assert.deepEqual(outside.problems.map((p) => [p.rule, p.path]), [["consolidate", "invoice-reconcile.md"]], "it supersedes a note outside its cluster");
  const none = replacementProblems(cluster, [{ ...merged, supersedes: [] }]);
  assert.deepEqual(none.problems.map((p) => p.rule), ["consolidate"], "a replacement that supersedes nothing is no consolidation");
});
