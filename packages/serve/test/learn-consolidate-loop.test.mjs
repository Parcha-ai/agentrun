// A consolidation run in the loop (runner/learning-loop.ts consolidateOn, learn/consolidate.ts): the agent's active notes
// clustered by what they say, one ask for the replacements, the usual checks, the hold to the clusters, the usual grade
// and one merge through learningCommit's mergeOf, the old notes superseded. A replacement the grader drops merges nothing;
// a replacement that reaches past its cluster is left out and its cluster stays; a cluster note no replacement names
// stays active; retired notes are never touched; nothing to consolidate asks nothing. A skill and its draft out of step
// are written back in step in the same commit. The run is no listed run, and its cost is on its row. After the 5th merge
// past the budget, a run's merge queues one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { note } from "./fixtures/faux-learn.mjs";

const { learningLoopFactory, consolidationLaunchOf, consolidationRunId } = await import("../dist/runner/learning-factory.js");
const { learningWorkspace, readSnapshot } = await import("../dist/learn/folder.js");
const { learningCommit, mainTexts } = await import("../dist/learn/commit.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");
const { seedOf } = await import("../dist/learning.js");
const { retire } = await import("../dist/learn/notes.js");
const { readLearning } = await import("../dist/learn/folder.js");

/** Three rules, each said by four notes in other words. */
const RULES = {
  invoice: ["Match each invoice total to its ledger entry before reconciling", "Reconcile invoices: every invoice total matches its ledger entry", "Before reconciling invoices, match invoice totals with the ledger entries", "Invoice totals are reconciled against ledger entries one by one"],
  refund: ["Quote the refund window in days from the refund policy page", "Refund policy pages give the refund window: quote it in days", "When asked about refunds, quote the policy page's refund window in days", "The refund window comes from the refund policy page, quoted in days"],
  migration: ["Every schema migration gets a down migration in one transaction", "Schema migrations run inside one transaction and ship a down migration", "Write a down migration for every schema migration, run in a transaction", "A schema migration always has its down migration and one transaction"],
};
const FILES = Object.fromEntries(Object.entries(RULES).flatMap(([topic, lines]) => lines.map((line, i) => [`${topic}-${i}.md`, note(`${topic} rule ${String.fromCharCode(97 + i)}`, line, `${line}.\n`)])));
const merged = (topic, supersedes, body = `${RULES[topic][0]}.`) => [`\`\`\`note ${topic}-rule.md`, `---\nname: ${topic} rule\ndescription: ${RULES[topic][0]}\ntype: feedback\nsupersedes: [${supersedes.join(", ")}]\n---\n${body}`, "```"].join("\n");
const SKILL = "---\nname: find-policies\ndescription: Find a store's refund policy; use when a case asks for it\n---\n1. Read the page's text.\n2. Quote the refund lines.\n";
const DRAFT = { v: 2, name: "find-policies", schemas: { Page: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, Policies: { type: "object", properties: { refund: { type: "string" } }, required: ["refund"] } }, input: { schemaId: "Page" }, output: { schemaId: "Policies", path: "policies" }, root: { node: "extract", label: "read", instructions: "Say the store's refund policy, from the page.", out: "Policies", as: "policies" } };

/** A store, a learning folder holding `notes` (file to text) as a person committed them, and an agent; `before` runs on
 *  the folder first. */
async function world(t, notes = FILES, before) {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(tmpdir(), "learn-consolidate-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await agentWithRevision(store);
  await seedOf(data, "agent-1");
  const onFolder = async (fn) => {
    const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
    try {
      return await fn(folder.workspace);
    } finally {
      await folder.end();
    }
  };
  for (const [file, text] of Object.entries(notes)) assert.equal((await onFolder((ws) => learningCommit(ws, { kind: "person", action: "created", file, text, ifMatch: null }))).ok, true);
  if (before) await before(onFolder);
  return { store, data, onFolder };
}

/** A grader's verdict keeping every file it is asked about, or dropping those `drop` names. */
const graderAnswer = (prompt, drop = []) => {
  const files = /for each of these files, each once, and for no other: (.*)\.\n/.exec(prompt)[1].split(", ");
  const items = files.map((file) => (drop.includes(file) ? { file, decision: "drop", question: "Contradicts", why: "It loses a rule." } : { file, decision: "keep", why: "It keeps every rule." }));
  return JSON.stringify({ merge: items.some((item) => item.decision === "keep"), reason: "Checked.", items });
};

/** Consolidation run `id` of agent-1 (pairs out of step: `pairs`), claimed and run by the loop on asks that answer with
 *  `consolidator(prompt)` and the faux grader (dropping `drop`). Its end, its journal, what the folder holds, and the asks. */
async function consolidate({ store, data, onFolder }, consolidator, { drop = [], pairs = [], id = "run-0-consolidate" } = {}) {
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", pairs) });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  const asks = [];
  const ask = async ({ prompt }) => {
    asks.push(prompt);
    return { text: prompt.startsWith("You keep an agent's learned notes") ? consolidator(prompt) : graderAnswer(prompt, drop), usd: 0.01, tokens: { input: 10, cache_read: 0, cache_write: 0, output: 5 } };
  };
  const loop = learningLoopFactory({ refuse: async () => [], store, data, ask })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  const end = await loop.start(claim);
  const entries = await journalEntries(store.journal(claim), BACKGROUND_CONTEXT);
  const snapshot = await onFolder((ws) => readSnapshot(ws));
  return { end, entries, snapshot, asks, row: await store.runs.get(id) };
}
const statusOf = (snapshot) => Object.fromEntries(snapshot.notes.map((n) => [n.file, n.superseded_by ? `${n.status}:${n.superseded_by}` : n.status]));

/** A consolidator that writes one replacement for each cluster its prompt asks for, superseding all of its notes. */
const replaceAsked = (prompt) => {
  const asked = [...prompt.matchAll(/^### (\S+\.md) \(/gm)].map((m) => m[1]);
  return ["invoice", "refund", "migration"].map((topic) => asked.filter((file) => file.startsWith(`${topic}-`))).filter((files) => files.length).map((files) => {
    // Worded as the note it keeps first, which it supersedes: never another active note's rule word for word.
    const [topic, at] = files[0].replace(/\.md$/, "").split("-");
    return merged(topic, files, `${RULES[topic][Number(at)]}.`);
  }).join("\n\n");
};

test("twelve notes saying three rules: a consolidation replaces the two clusters that fit one merge (8 notes) in one commit, each old note superseded by its replacement, the index rebuilt; the next does the third; the run is no listed run and its cost is on its row", async (t) => {
  const w = await world(t);
  const before = (await w.onFolder((ws) => readSnapshot(ws))).main;
  const { end, entries, snapshot, asks, row } = await consolidate(w, replaceAsked);
  assert.deepEqual(end, { state: "ended" });
  assert.ok(entries.some((e) => e.kind === KINDS.learningMerged), JSON.stringify(entries.map((e) => [e.kind, e.data?.detail])));
  assert.equal(asks.length, 2, "one ask for the replacements, one grade");
  assert.ok(asks[0].includes("## Cluster 2") && !asks[0].includes("## Cluster 3"), "two clusters asked: the third would pass the cap");
  const status = statusOf(snapshot);
  const done = ["invoice", "refund", "migration"].filter((topic) => status[`${topic}-rule.md`] === "active");
  assert.equal(done.length, 2, JSON.stringify(status));
  for (const topic of done) for (const i of [0, 1, 2, 3]) assert.match(status[`${topic}-${i}.md`], new RegExp(`^(superseded:${topic}-rule\\.md|active)$`));
  assert.equal(Object.values(status).filter((one) => one.startsWith("superseded:")).length, asks[0].match(/^### /gm).length, "each note asked about superseded");
  assert.equal(snapshot.log.findIndex((change) => change.commit === before), 1, "one commit");
  const index = await w.onFolder((ws) => readLearning(ws, ({ snapshot: snap, body }) => body("MEMORY.md", snap.index.oid)));
  assert.equal(index.trim().split("\n").length, Object.values(status).filter((one) => one === "active").length, index);
  // The next consolidation takes the cluster left: three notes, all twelve rules kept.
  const next = await consolidate(w, replaceAsked, { id: "run-1-consolidate" });
  assert.deepEqual(next.end, { state: "ended" });
  const after = statusOf(next.snapshot);
  assert.deepEqual(["invoice", "refund", "migration"].map((topic) => after[`${topic}-rule.md`]), ["active", "active", "active"]);
  assert.ok(Object.values(after).filter((one) => one === "active").length < 12, JSON.stringify(after));
  // Its cost is its asks', on its row; it is no run a list names.
  assert.equal(Math.round(row.costUsd * 100) / 100, 0.02);
  assert.ok(!(await w.store.runs.list({ agentId: "agent-1" })).some((run) => run.id === "run-0-consolidate"));
});

test("a replacement the grader drops (it loses a rule) merges nothing: the notes it would replace stay active", async (t) => {
  const w = await world(t, Object.fromEntries(Object.entries(FILES).filter(([file]) => file.startsWith("invoice-"))));
  const { end, entries, snapshot } = await consolidate(w, () => merged("invoice", ["invoice-0.md", "invoice-1.md"], "Reconcile invoices."), { drop: ["invoice-rule.md"] });
  assert.deepEqual(end, { state: "ended" });
  assert.ok(entries.some((e) => e.kind === KINDS.learningDropped && e.data.reason === "grader"), JSON.stringify(entries.map((e) => [e.kind, e.data])));
  assert.ok(Object.values(statusOf(snapshot)).every((s) => s === "active"));
});

test("held to its clusters: a replacement that supersedes a note of another cluster is left out and its cluster stays; a cluster note no replacement names stays active", async (t) => {
  const w = await world(t);
  const answer = [merged("invoice", ["invoice-0.md", "refund-1.md"]), merged("refund", ["refund-0.md", "refund-2.md", "refund-3.md"])].join("\n\n");
  const { snapshot, entries } = await consolidate(w, () => answer);
  const status = statusOf(snapshot);
  assert.equal(status["invoice-rule.md"], undefined, "reached past its cluster: left out");
  for (const i of [0, 1, 2, 3]) assert.equal(status[`invoice-${i}.md`], "active");
  for (const i of [0, 2, 3]) assert.equal(status[`refund-${i}.md`], "superseded:refund-rule.md");
  assert.equal(status["refund-1.md"], "active", "named by no kept replacement: stays");
  assert.match(entries.find((e) => e.kind === KINDS.learningMerged).data.detail, /didn't pass the checks|consolidation/, "the left-out note is said");
});

test("retired notes are never touched, and with nothing to consolidate there is no ask", async (t) => {
  const two = { "invoice-0.md": FILES["invoice-0.md"], "migration-0.md": FILES["migration-0.md"] };
  const w = await world(t, two);
  const { end, entries, asks } = await consolidate(w, () => "never asked");
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual(asks, [], "no cluster, no pair: no ask");
  assert.equal(entries.find((e) => e.kind === KINDS.learningDropped)?.data.reason, "empty");
  // Three notes of a rule, one retired by a person: the retired one is in no cluster and stays retired.
  const w2 = await world(t, { "invoice-0.md": FILES["invoice-0.md"], "invoice-1.md": FILES["invoice-1.md"], "invoice-2.md": FILES["invoice-2.md"] }, async (onFolder) => {
    const snapshot = await onFolder((ws) => readSnapshot(ws));
    const oid = snapshot.notes.find((n) => n.file === "invoice-2.md").oid;
    assert.equal((await onFolder((ws) => learningCommit(ws, { kind: "person", action: "retired", file: "invoice-2.md", text: retire(FILES["invoice-2.md"]), ifMatch: oid }))).ok, true);
  });
  const run = await consolidate(w2, (prompt) => (assert.ok(!prompt.includes("invoice-2.md"), "the retired note is never offered"), merged("invoice", ["invoice-0.md", "invoice-1.md"])));
  assert.equal(statusOf(run.snapshot)["invoice-2.md"], "retired");
});

test("a skill and its draft out of step are written back in step, both in the merge's one commit", async (t) => {
  const w = await world(t, {}, async (onFolder) => {
    const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: "run-old", reason: "learned a job", graded: {}, files: [{ path: "skills/find-policies/SKILL.md", text: SKILL }, { path: "workflows/find-policies/workflow.json", text: JSON.stringify(DRAFT) }, { path: "workflows/find-policies/README.md", text: "---\nname: find-policies\ndescription: Finds a store's refund policy\n---\n" }] }));
    assert.equal(made.ok, true, JSON.stringify(made));
  });
  const skill2 = SKILL.replace("2. Quote the refund lines.", "2. Quote the refund lines whole.\n3. Say the window in days.");
  const draft2 = { ...DRAFT, root: { ...DRAFT.root, instructions: "Say the store's refund policy and its window in days, from the page." } };
  const answer = [`\`\`\`\`skill find-policies\n${skill2}\`\`\`\``, `\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy and window\n---\n${JSON.stringify(draft2)}\n\`\`\`\``].join("\n\n");
  const before = (await w.onFolder((ws) => readSnapshot(ws))).main;
  const { end, entries, snapshot, asks } = await consolidate(w, () => answer, { pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }] });
  assert.deepEqual(end, { state: "ended" }, JSON.stringify(entries.map((e) => [e.kind, e.data?.detail, e.data?.problems])));
  assert.match(asks[0], /A skill and its workflow draft out of step: the skill changed last/);
  const commit = snapshot.log[0];
  assert.equal(snapshot.log[1].commit, before, "one commit");
  assert.deepEqual([...commit.files].filter((f) => !f.startsWith(".")).sort(), ["skills/find-policies/SKILL.md", "workflows/find-policies/README.md", "workflows/find-policies/workflow.json"]);
  const texts = await w.onFolder(async (ws) => {
    const files = snapshot.skills[0].files.concat(snapshot.workflows[0].files);
    const { readLearning } = await import("../dist/learn/folder.js");
    return readLearning(ws, async ({ body }) => Object.fromEntries(await Promise.all(files.map(async (f) => [f.path, await body(f.path, f.oid)]))));
  });
  assert.match(texts["skills/find-policies/SKILL.md"], /Say the window in days/);
  assert.match(texts["workflows/find-policies/workflow.json"], /window in days/);
});

test("the 5th merge past the serve budget queues one consolidation run, as no listed run; a merge before it queues none", async (t) => {
  const big = (i) => note(`Long rule ${i}`, `A rule kept long ${i}`, `${`Keep this rule in mind ${i}. `.repeat(70)}\n`);
  const w = await world(t, {}, async (onFolder) => {
    for (const i of [1, 2, 3, 4]) {
      const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: `run-${i}`, reason: "learned", graded: {}, files: [{ path: `long-${i}.md`, text: big(i) }] }));
      assert.equal(made.ok, true, JSON.stringify(made));
    }
  });
  // run-5 ends keeping a note, and its learning run grades and merges it: the 5th merge.
  const learn = async (runId, file) => {
    await w.store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
    const claim = await w.store.claim(runId, "runner-a", { leaseMs: 60_000 });
    await w.store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "proposed", proposal: { notes: [{ file, text: big(file) }] } } } }, { table: "learning_run", row: { id: `${runId}-learning` } }] });
    const learningClaim = await w.store.claim(`${runId}-learning`, "runner-b", { leaseMs: 60_000 });
    const loop = learningLoopFactory({ refuse: async () => [], store: w.store, data: w.data, ask: async ({ prompt }) => ({ text: graderAnswer(prompt), usd: 0 }) })({ journal: (c) => w.store.journal(c), flush: () => w.store.flush(), signal: new AbortController().signal });
    return loop.start(learningClaim);
  };
  assert.deepEqual(await learn("run-5", "long-5.md"), { state: "ended" });
  const queued = await w.store.runs.get(consolidationRunId("run-5"));
  assert.equal(queued?.state, "queued", "the 5th merge past 8 KB queues a consolidation");
  assert.equal((await w.store.runs.launch(consolidationRunId("run-5"))).body.input.consolidate.agentId, "agent-1");
  assert.ok(!(await w.store.runs.list({})).some((run) => run.id.endsWith("-consolidate") || run.id.endsWith("-learning")), "no listed run");
  // The 6th merge is not a 5th: none queued.
  assert.deepEqual(await learn("run-6", "long-6.md"), { state: "ended" });
  assert.equal(await w.store.runs.get(consolidationRunId("run-6")), undefined);
});
