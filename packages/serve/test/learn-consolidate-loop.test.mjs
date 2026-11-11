// A consolidation run in the loop (runner/learning-loop.ts consolidateOn, learn/consolidate.ts): the agent's active notes
// clustered by what they say, one ask for the replacements, the usual checks, the hold to the clusters, the usual grade
// and one merge through learningCommit's mergeOf, the old notes superseded. A replacement the grader drops merges nothing;
// a replacement that reaches past its cluster is left out and its cluster stays; a cluster note no replacement names
// stays active; retired notes are never touched; nothing to consolidate asks nothing. A skill and its draft out of step
// are written back in step in the same commit. The run is no listed run, and its cost is on its row. After the 5th merge
// past the budget, a run's merge queues one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
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
async function world(t, notes = FILES, before, { instructions, tools } = {}) {
  const clock = { now: T0 };
  const { store } = await storeOn(t, { clock });
  const data = mkdtempSync(join(tmpdir(), "learn-consolidate-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  if (instructions || tools) await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "agentic", body: { ...(instructions ? { instructions } : {}), ...(tools ? { tools } : {}) } });
  else await agentWithRevision(store);
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
  return { store, data, onFolder, clock };
}

/** A grader's verdict keeping every file it is asked about, or dropping those `drop` names. */
const graderAnswer = (prompt, drop = []) => {
  const files = /for each of these files, each once, and for no other: (.*)\.\n/.exec(prompt)[1].split(", ");
  const items = files.map((file) => (drop.includes(file) ? { file, decision: "drop", question: "Contradicts", why: "It loses a rule." } : { file, decision: "keep", why: "It keeps every rule." }));
  return JSON.stringify({ merge: items.some((item) => item.decision === "keep"), reason: "Checked.", items });
};

/** Consolidation run `id` of agent-1 (pairs out of step: `pairs`), claimed and run by the loop on asks that answer with
 *  `consolidator(prompt)` and the faux grader (dropping `drop`). Its end, its journal, what the folder holds, and the asks. */
async function consolidate({ store, data, onFolder }, consolidator, { drop = [], pairs = [], id = "run-0-consolidate", stopFirst = false, beforeGrade } = {}) {
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", pairs) });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  const asks = [];
  const ask = async ({ prompt }) => {
    asks.push(prompt);
    if (!prompt.startsWith("You keep an agent's learned notes")) await beforeGrade?.(prompt);
    return { text: prompt.startsWith("You keep an agent's learned notes") ? consolidator(prompt) : graderAnswer(prompt, drop), usd: 0.01, tokens: { input: 10, cache_read: 0, cache_write: 0, output: 5 } };
  };
  const loop = learningLoopFactory({ refuse: async () => [], store, data, ask })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  // A person's stop already pending when the run starts (its row written, the loop told).
  if (stopFirst) await loop.stop({ kind: "command", commandId: (await store.command(id, { kind: "stop" })).id });
  const end = await loop.start(claim);
  const entries = await journalEntries(store.journal(claim), BACKGROUND_CONTEXT);
  const snapshot = await onFolder((ws) => readSnapshot(ws));
  return { end, entries, snapshot, asks, row: await store.runs.get(id) };
}
const statusOf = (snapshot) => Object.fromEntries(snapshot.notes.map((n) => [n.file, n.superseded_by ? `${n.status}:${n.superseded_by}` : n.status]));

/** The skill as a later run's merge changed it, its draft left as it was. */
const SKILL_NOW = SKILL.replace("2. Quote the refund lines.", "2. Quote the refund lines whole.");
/** A learning folder with a skill and its draft committed by a run's merge (`files` more beside them). */
const pairWorld = (t, files = [], description = "Finds a store's refund policy", options = {}) => world(t, {}, async (onFolder) => {
  const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: "run-old", reason: "learned a job", graded: {}, files: [{ path: "skills/find-policies/SKILL.md", text: SKILL }, { path: "workflows/find-policies/workflow.json", text: JSON.stringify(DRAFT) }, { path: "workflows/find-policies/README.md", text: `---\nname: find-policies\ndescription: ${description}\n---\n` }, ...files] }));
  assert.equal(made.ok, true, JSON.stringify(made));
}, options);
/** pairWorld put out of step as a consolidation is queued for: a later run's merge changed `skills` (by path) alone. */
async function driftedWorld(t, files = [], description, skills = { "skills/find-policies/SKILL.md": SKILL_NOW }, options = {}) {
  const w = await pairWorld(t, files, description, options);
  assert.equal((await mergeOn(w, "run-skill", Object.entries(skills).map(([path, text]) => ({ path, text })))).ok, true);
  return w;
}
/** One run's merge of `files` on the folder, as another learning run's would land. */
const mergeOn = (w, runId, files) => w.onFolder((ws) => learningCommit(ws, { kind: "merge", runId, reason: "learned more", graded: {}, files }));

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
  // And learning's usage counts it (store learning.spend, GET /v2/usage's learning meter): each consolidation, its cost
  // its row's, the agent's, when it ended.
  const spent = (await w.store.learning.spend({ from: 0, to: Date.now() + 60_000 })).filter((one) => one.agentId === "agent-1");
  assert.deepEqual(spent.map((one) => Math.round((one.costUsd ?? NaN) * 100) / 100), [0.02, Math.round(((await w.store.runs.get("run-1-consolidate")).costUsd) * 100) / 100], JSON.stringify(spent));
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
    assert.equal((await onFolder((ws) => learningCommit(ws, { kind: "person", action: "retired", file: "invoice-2.md", text: retire(FILES["invoice-2.md"], "active"), ifMatch: oid }))).ok, true);
  });
  const run = await consolidate(w2, (prompt) => (assert.ok(!prompt.includes("invoice-2.md"), "the retired note is never offered"), merged("invoice", ["invoice-0.md", "invoice-1.md"])));
  assert.equal(statusOf(run.snapshot)["invoice-2.md"], "retired");
});

test("a skill and its draft out of step are written back in step, both in the merge's one commit", async (t) => {
  // Out of step as main's log says it: a later run's merge changed the skill alone.
  const w = await driftedWorld(t);
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

test("a consolidation that gives the skill back unchanged and rewrites its draft: the grader reads the skill beside the draft, as main holds it, and grades the draft alone; the merge writes the draft", async (t) => {
  // Out of step as main's log says it: a later run's merge changed the skill alone.
  const w = await driftedWorld(t);
  const draft2 = { ...DRAFT, root: { ...DRAFT.root, instructions: "Read the page's text, then quote the store's refund lines whole." } };
  const answer = [`\`\`\`\`skill find-policies\n${SKILL_NOW}\`\`\`\``, `\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy\n---\n${JSON.stringify(draft2)}\n\`\`\`\``].join("\n\n");
  const { end, entries, snapshot, asks } = await consolidate(w, () => answer, { pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }] });
  assert.deepEqual(end, { state: "ended" }, JSON.stringify(entries.map((e) => [e.kind, e.data?.detail, e.data?.problems])));
  const grade = asks[1];
  assert.match(grade, /Give one item for each of these files, each once, and for no other: workflows\/find-policies\/workflow\.json\./, "the draft alone is graded");
  const beside = grade.slice(grade.indexOf("## Beside them"), grade.indexOf("## Your verdict"));
  assert.ok(beside.includes("skills/find-policies/SKILL.md, active") && beside.includes("2. Quote the refund lines whole."), beside);
  assert.ok(grade.indexOf("## The new skill and workflow draft") < grade.indexOf("## Beside them"));
  const commit = snapshot.log[0];
  assert.deepEqual([...commit.files].filter((f) => !f.startsWith(".")), ["workflows/find-policies/workflow.json"], "the draft alone: its README and the skill as they were");
});

const big = (i) => note(`Long rule ${i}`, `A rule kept long ${i}`, `${`Keep this rule in mind ${i}. `.repeat(70)}\n`);
/** A world whose folder holds `merges` merges of long notes (past the serve budget), by runs run-1 to run-<merges>. */
const longWorld = (t, merges) => world(t, {}, async (onFolder) => {
  for (let i = 1; i <= merges; i++) {
    const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: `run-${i}`, reason: "learned", graded: {}, files: [{ path: `long-${i}.md`, text: big(i) }] }));
    assert.equal(made.ok, true, JSON.stringify(made));
  }
});
/** Run `runId` ends keeping note `file` (or `files`), its learning run (grade model `model`) grades and merges it on
 *  the faux grader: the learning run's end. `store` stands in for the store the loop is given. */
async function learn(w, runId, file, { model, store = w.store, files } = {}) {
  w.clock.now += 1000;
  await w.store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
  const claim = await w.store.claim(runId, "runner-a", { leaseMs: 60_000 });
  const proposal = files ? { notes: [], files } : { notes: [{ file, text: big(file) }] };
  await w.store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "proposed", proposal } } }, { table: "learning_run", row: { id: `${runId}-learning`, ...(model ? { model } : {}) } }] });
  const learningClaim = await w.store.claim(`${runId}-learning`, "runner-b", { leaseMs: 60_000 });
  return { claim: learningClaim, end: await learnAgain(w, learningClaim, store) };
}
const learnAgain = (w, claim, store = w.store) =>
  learningLoopFactory({ refuse: async () => [], store, data: w.data, now: () => w.clock.now, ask: async ({ prompt }) => ({ text: graderAnswer(prompt), usd: 0 }) })({ journal: (c) => w.store.journal(c), flush: () => w.store.flush(), signal: new AbortController().signal }).start(claim);
/** Ends queued consolidation run `id` as one that merged nothing. */
async function endConsolidation(w, id) {
  w.clock.now += 1000;
  const claim = await w.store.claim(id, "runner-c", { leaseMs: 60_000 });
  await w.store.runs.update(claim, { state: "ended" });
}

test("the 5th merge past the serve budget queues one consolidation run, as no listed run, on the learning run's grade model, before that run ends; a merge before it queues none", async (t) => {
  const w = await longWorld(t, 4);
  assert.deepEqual((await learn(w, "run-5", "long-5.md", { model: "faux/grade-model" })).end, { state: "ended" });
  const queued = await w.store.runs.get(consolidationRunId("run-5"));
  assert.equal(queued?.state, "queued", "the 5th merge past 8 KB queues a consolidation");
  const launch = (await w.store.runs.launch(consolidationRunId("run-5"))).body;
  assert.equal(launch.input.consolidate.agentId, "agent-1");
  assert.equal(launch.model, "faux/grade-model", "the grade model the learning run was queued with: its ask and its grade go there");
  assert.equal(launch.input.consolidate.after, (await w.onFolder((ws) => readSnapshot(ws))).main, "main as it was queued: the next count starts there");
  assert.ok(!(await w.store.runs.list({})).some((run) => run.id.endsWith("-consolidate") || run.id.endsWith("-learning")), "no listed run");
});

test("one consolidation at a time: while one is queued, a merge that would make one due queues none; two queues of one agent at once make one", async (t) => {
  const w = await longWorld(t, 4);
  await w.store.runs.create({ id: "run-0-consolidate", agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", []) });
  assert.deepEqual((await learn(w, "run-5", "long-5.md")).end, { state: "ended" });
  assert.equal(await w.store.runs.get(consolidationRunId("run-5")), undefined, "one is queued: the 5th merge queues none");
  // The store's queue: checked and written in one transaction, so of two at once, one is queued.
  await endConsolidation(w, "run-0-consolidate");
  const made = await Promise.all(["run-a-consolidate", "run-b-consolidate"].map((id) => w.store.learning.queueConsolidation({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", []) })));
  assert.equal(made.filter((one) => "queued" in one).length, 1, JSON.stringify(made));
  const [one] = made.filter((m) => "queued" in m);
  assert.deepEqual(made.filter((m) => "pending" in m), [{ pending: one.queued }]);
  assert.equal((await w.store.learning.consolidation("agent-1")).id, one.queued);
});

test("merges are counted from the last consolidation's queue, never from a consolidation's commit or the log's cap: one that merged nothing is asked again 5 merges after it was queued, never at each merge", async (t) => {
  // Seven merges on main, then a consolidation queued (main as it was then) that ended merging nothing.
  const w = await longWorld(t, 7);
  const after = (await w.onFolder((ws) => readSnapshot(ws))).main;
  await w.store.runs.create({ id: "run-7-consolidate", agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", [], { after }) });
  await endConsolidation(w, "run-7-consolidate");
  for (const i of [8, 9, 10, 11]) {
    assert.deepEqual((await learn(w, `run-${i}`, `long-${i}.md`)).end, { state: "ended" });
    assert.equal(await w.store.runs.get(consolidationRunId(`run-${i}`)), undefined, `merge ${i - 7} since the queue: none`);
  }
  assert.deepEqual((await learn(w, "run-12", "long-12.md")).end, { state: "ended" });
  assert.equal((await w.store.runs.get(consolidationRunId("run-12")))?.state, "queued", "the 5th merge since the last queue");
});

test("a consolidation that cannot be queued parks the learning run, its merge on main and the run not ended; at its wake it queues it, then ends", async (t) => {
  const w = await longWorld(t, 4);
  let fail = true;
  const failing = { ...w.store, runs: w.store.runs, agents: w.store.agents, learning: { ...w.store.learning, queueConsolidation: async (...args) => {
    if (fail) throw new Error("the store is busy");
    return w.store.learning.queueConsolidation(...args);
  } } };
  const { claim, end } = await learn(w, "run-5", "long-5.md", { store: failing });
  assert.equal(end.state, "parked", JSON.stringify(end));
  assert.equal((await w.store.runs.get("run-5-learning")).state, "parked", "not ended: its end waits for the queue");
  const entries = await journalEntries(w.store.journal(claim), BACKGROUND_CONTEXT);
  assert.ok(!entries.some((e) => e.kind === KINDS.learningMerged), "no end recorded yet");
  assert.match(entries.find((e) => e.kind === KINDS.learningUnavailable).data.error, /consolidation could not be queued/);
  assert.ok((await w.onFolder((ws) => readSnapshot(ws))).notes.some((n) => n.file === "long-5.md"), "its merge is on main");
  // At its wake, a claim resumes it: the merge already on main, the queue made, the run ended merged.
  await w.store.release(claim, { state: "parked", wakeAt: end.wakeAt });
  w.clock.now = end.wakeAt + 1;
  fail = false;
  const again = await w.store.claim("run-5-learning", "runner-b", { leaseMs: 60_000 });
  assert.ok(again, "claimable at its wake");
  assert.deepEqual(await learnAgain(w, again, failing), { state: "ended" });
  assert.equal((await w.store.runs.get(consolidationRunId("run-5")))?.state, "queued");
  assert.ok((await journalEntries(w.store.journal(again), BACKGROUND_CONTEXT)).some((e) => e.kind === KINDS.learningMerged));
});

test("a skill and its draft put out of step are found by a later merge too: one queued while it waited never loses that pair", async (t) => {
  const w = await world(t, {}, async (onFolder) => {
    const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: "run-old", reason: "learned a job", graded: {}, files: [{ path: "skills/find-policies/SKILL.md", text: SKILL }, { path: "workflows/find-policies/workflow.json", text: JSON.stringify(DRAFT) }, { path: "workflows/find-policies/README.md", text: "---\nname: find-policies\ndescription: Finds a store's refund policy\n---\n" }] }));
    assert.equal(made.ok, true, JSON.stringify(made));
  });
  await w.store.runs.create({ id: "run-0-consolidate", agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", []) });
  // The skill alone changes while a consolidation is queued: none queued then.
  const skill2 = SKILL.replace("2. Quote the refund lines.", "2. Quote the refund lines whole.");
  assert.deepEqual((await learn(w, "run-1", undefined, { files: [{ file: "skills/find-policies/SKILL.md", text: skill2 }] })).end, { state: "ended" });
  assert.equal(await w.store.runs.get(consolidationRunId("run-1")), undefined);
  // It ends; the next merge, of a note alone, finds the pair still out of step and queues it.
  await endConsolidation(w, "run-0-consolidate");
  assert.deepEqual((await learn(w, "run-2", "plain.md")).end, { state: "ended" });
  const launch = (await w.store.runs.launch(consolidationRunId("run-2"))).body;
  assert.deepEqual(launch.input.consolidate.pairs, [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }]);
});


test("a consolidation stopped while its first request was cut ends with an unknown cost (null), never $0: the cut request may have been billed", async (t) => {
  const w = await world(t);
  const { end, row } = await consolidate(w, () => { throw new Error("the consolidation request was cut"); }, { stopFirst: true });
  assert.deepEqual(end, { state: "stopped" });
  assert.deepEqual([row.state, row.costUsd], ["stopped", null], "unknown, never 0");
});

test("a draft that pairs with two skills, rewritten alone, is graded with both skills beside it, each once, and merges: companion context is no proposed write and has no write caps", async (t) => {
  const QUOTE = "---\nname: quote-refunds\ndescription: Quote a store's refund lines; use when a case asks for them\n---\n1. Quote the refund lines whole.\n";
  const w = await driftedWorld(t, [{ path: "skills/quote-refunds/SKILL.md", text: QUOTE }], "Finds a store's refund policy with quote-refunds", { "skills/find-policies/SKILL.md": SKILL_NOW, "skills/quote-refunds/SKILL.md": QUOTE.replace("whole.", "whole, each line once.") });
  const draft2 = { ...DRAFT, root: { ...DRAFT.root, instructions: "Read the page's text, then quote the store's refund lines whole." } };
  const answer = [`\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy with quote-refunds\n---\n${JSON.stringify(draft2)}\n\`\`\`\``].join("\n\n");
  const { end, entries, snapshot, asks } = await consolidate(w, () => answer, { pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }, { skill: "quote-refunds", workflow: "find-policies", changed: "skill" }] });
  assert.deepEqual(end, { state: "ended" }, JSON.stringify(entries.map((e) => [e.kind, e.data?.detail, e.data?.problems])));
  const grade = asks[1] ?? "";
  const beside = grade.slice(grade.indexOf("## Beside them"), grade.indexOf("## Your verdict"));
  for (const skill of ["find-policies", "quote-refunds"]) assert.equal(beside.split(`skills/${skill}/SKILL.md, active`).length - 1, 1, `${skill} beside, once: ${beside.slice(0, 400)}`);
  assert.deepEqual([...snapshot.log[0].files].filter((f) => !f.startsWith(".")), ["workflows/find-policies/workflow.json"]);
});

test("which side of a pair changed last is read as the consolidation reads the files: a skill change queued it, a later merge changed the draft, so the draft is the one to follow", async (t) => {
  const w = await pairWorld(t);
  assert.equal((await mergeOn(w, "run-skill", [{ path: "skills/find-policies/SKILL.md", text: SKILL.replace("2. Quote the refund lines.", "2. Quote the refund lines whole.") }])).ok, true);
  const draft2 = { ...DRAFT, root: { ...DRAFT.root, instructions: "Say the store's refund policy and its window in days, from the page." } };
  assert.equal((await mergeOn(w, "run-draft", [{ path: "workflows/find-policies/workflow.json", text: JSON.stringify(draft2) }])).ok, true);
  // Queued when the skill changed: its launch still says the skill.
  const { asks } = await consolidate(w, () => "", { pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }] });
  assert.match(asks[0], /A skill and its workflow draft out of step: the workflow changed last/);
  assert.doesNotMatch(asks[0], /the skill changed last/);
});

test("a companion the grader read beside the rewrite that changes on main before the merge refuses the merge: the pair is never left out of step", async (t) => {
  const w = await driftedWorld(t);
  const draft2 = { ...DRAFT, root: { ...DRAFT.root, instructions: "Read the page's text, then quote the store's refund lines whole." } };
  const answer = `\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy\n---\n${JSON.stringify(draft2)}\n\`\`\`\``;
  // Another run's merge changes the skill after the grader read it beside the draft, before the merge commits.
  const beforeGrade = async () => assert.equal((await mergeOn(w, "run-later", [{ path: "skills/find-policies/SKILL.md", text: SKILL.replace("2. Quote the refund lines.", "2. Quote the refund lines, then the window.") }])).ok, true);
  const { end, entries, snapshot } = await consolidate(w, () => answer, { pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }], beforeGrade });
  assert.deepEqual(end, { state: "ended" });
  const dropped = entries.find((e) => e.kind === KINDS.learningDropped)?.data;
  assert.equal(dropped?.reason, "checker", JSON.stringify(entries.map((e) => [e.kind, e.data?.detail])));
  assert.ok(dropped.problems.some((p) => p.path === "skills/find-policies/SKILL.md"), JSON.stringify(dropped.problems));
  assert.equal(snapshot.log[0].by.run, "run-later", "the draft was not written");
});

/** The rubric's consolidation rule, as the grader's prompt holds it. */
const CONSOLIDATION_RULE = /Consolidation: a new note that supersedes several active notes replaces them\. Keep it only when it keeps every rule/;
/** A strict grader: it applies the consolidation rule when its prompt holds it, dropping as Contradicts a note that
 *  supersedes several and changes a rule (every new note here does); else it keeps every item. */
const strictGrader = (prompt) => {
  if (!CONSOLIDATION_RULE.test(prompt)) return graderAnswer(prompt);
  const files = /for each of these files, each once, and for no other: (.*)\.\n/.exec(prompt)[1].split(", ");
  return JSON.stringify({ merge: false, reason: "It changes a rule.", items: files.map((file) => ({ file, decision: "drop", question: "Contradicts", why: "It changes a rule of the notes it replaces." })) });
};

test("an ordinary run's note that supersedes two old notes with an updated rule is graded without the consolidation rule, and kept: an owner's correction replaces the outdated guidance", async (t) => {
  const w = await world(t, { "invoice-0.md": FILES["invoice-0.md"], "invoice-1.md": FILES["invoice-1.md"] });
  const updated = note("invoice rule", "Match invoice totals to the ledger, now within one cent", "Match each invoice total to its ledger entry within one cent before reconciling.\n", "supersedes: [invoice-0.md, invoice-1.md]\norigin: you\n");
  w.clock.now += 1000;
  await w.store.runs.create({ id: "run-fix", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await w.store.claim("run-fix", "runner-a", { leaseMs: 60_000 });
  await w.store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "proposed", proposal: { notes: [{ file: "invoice-rule.md", text: updated }] } } } }, { table: "learning_run", row: { id: "run-fix-learning" } }] });
  const learningClaim = await w.store.claim("run-fix-learning", "runner-b", { leaseMs: 60_000 });
  const asks = [];
  const loop = learningLoopFactory({ refuse: async () => [], store: w.store, data: w.data, now: () => w.clock.now, ask: async ({ prompt }) => (asks.push(prompt), { text: strictGrader(prompt), usd: 0 }) })({ journal: (c) => w.store.journal(c), flush: () => w.store.flush(), signal: new AbortController().signal });
  assert.deepEqual(await loop.start(learningClaim), { state: "ended" });
  assert.doesNotMatch(asks[0], CONSOLIDATION_RULE, "a run's grade holds no consolidation rule");
  const status = statusOf(await w.onFolder((ws) => readSnapshot(ws)));
  assert.deepEqual([status["invoice-rule.md"], status["invoice-0.md"], status["invoice-1.md"]], ["active", "superseded:invoice-rule.md", "superseded:invoice-rule.md"], JSON.stringify(status));
});

test("a consolidation's grade holds the consolidation rule: a replacement must keep every rule of the notes it supersedes", async (t) => {
  const w = await world(t);
  const { asks } = await consolidate(w, replaceAsked);
  assert.match(asks[1], CONSOLIDATION_RULE);
});

/** A workflow draft named `name`, whose README names the skill find-policies, so the two pair. */
const partnerDraft = (name) => [
  { path: `workflows/${name}/workflow.json`, text: JSON.stringify({ ...DRAFT, name }) },
  { path: `workflows/${name}/README.md`, text: `---\nname: ${name}\ndescription: Runs find-policies on a store\n---\n` },
];

test("a skill with 3 workflow partners, rewritten, would need 6 files beside it: more than the grade holds, so that rewrite is left out of this consolidation, said, and nothing is asked of the model", async (t) => {
  const w = await world(t, {}, async (onFolder) => {
    const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: "run-old", reason: "learned a job", graded: {}, files: [{ path: "skills/find-policies/SKILL.md", text: SKILL }, ...partnerDraft("policies-a"), ...partnerDraft("policies-b"), ...partnerDraft("policies-c")] }));
    assert.equal(made.ok, true, JSON.stringify(made));
  });
  // The drafts changed last: the skill is the side to rewrite, and all 3 drafts would go beside it.
  const changed = (name) => ({ path: `workflows/${name}/workflow.json`, text: JSON.stringify({ ...DRAFT, name, root: { ...DRAFT.root, instructions: "Say the refund policy and its window, from the page." } }) });
  assert.equal((await mergeOn(w, "run-drafts", [changed("policies-a"), changed("policies-b"), changed("policies-c")])).ok, true);
  const pairs = ["policies-a", "policies-b", "policies-c"].map((workflow) => ({ skill: "find-policies", workflow, changed: "workflow" }));
  const { end, entries, asks } = await consolidate(w, () => { throw new Error("the model is never asked"); }, { pairs });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(asks.length, 0, "no paid request");
  const dropped = entries.find((e) => e.kind === KINDS.learningDropped)?.data;
  assert.ok(dropped?.problems?.some((p) => p.path === "skills/find-policies/SKILL.md" && /do not fit/.test(p.detail)), JSON.stringify(dropped));
});

/** `n` words of letters only, drawn from `seed`: text no other note's shares. */
const wordsOf = (seed, n) => Array.from({ length: n }, (_, i) => createHash("sha256").update(`${seed} ${i}`).digest("hex").replace(/[0-9]/g, "").slice(0, 8)).join(" ");

test("a rewrite whose companions fit the count but not the grade prompt's room (a full index, a full cluster, big partner skills) is left out of this consolidation, said, before any paid request for it", async (t) => {
  // 186 active notes, each listed by a long index line, and one cluster of 8 near-full notes saying one rule.
  const filler = Object.fromEntries(Array.from({ length: 186 }, (_, i) => [`fact-${i}.md`, note(`Fact ${wordsOf(`name ${i}`, 3)}`, wordsOf(`desc ${i}`, 32), `${wordsOf(`body ${i}`, 20)}.\n`)]));
  const rule = "Match each invoice total to its ledger entry before reconciling";
  const cluster = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`invoice-${i}.md`, note(`invoice rule ${i}`, rule, `${rule}, case ${i}. ${"Keep the ledger and the invoice side by side while you match them. ".repeat(55)}\n`)]));
  // A draft paired with 4 skills near the file cap: 4 files beside it, within the count, over the room the agent's
  // long instructions, the full index and the cluster leave.
  const big = (name) => ({ path: `skills/${name}/SKILL.md`, text: `---\nname: ${name}\ndescription: Use ${name} for a store's refund policy\n---\n${"1. Read the refund policy page and quote it.\n".repeat(360)}` });
  const instructions = `${"Answer each case from the store's own pages, and say where each figure came from. ".repeat(190)}`;
  const w = await world(t, {}, async (onFolder) => {
    for (const [i, batch] of [Object.entries(filler), Object.entries(cluster)].entries()) {
      for (let at = 0; at < batch.length; at += 30) {
        const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: `run-notes-${i}-${at}`, reason: "learned notes", graded: {}, files: batch.slice(at, at + 30).map(([path, text]) => ({ path, text })) }));
        assert.equal(made.ok, true, JSON.stringify(made));
      }
    }
    const made = await onFolder((ws) => learningCommit(ws, { kind: "merge", runId: "run-old", reason: "learned a job", graded: {}, files: [big("refund-a"), big("refund-b"), big("refund-c"), big("refund-d"), { path: "workflows/refunds/workflow.json", text: JSON.stringify({ ...DRAFT, name: "refunds" }) }, { path: "workflows/refunds/README.md", text: "---\nname: refunds\ndescription: Runs refund-a, refund-b, refund-c and refund-d\n---\n" }] }));
    assert.equal(made.ok, true, JSON.stringify(made));
  }, { instructions });
  // The skills changed last: the draft is the side to rewrite, with all 3 skills beside it.
  assert.equal((await mergeOn(w, "run-skills", ["refund-a", "refund-b", "refund-c", "refund-d"].map((name) => ({ ...big(name), text: big(name).text.replace("quote it", "quote it whole") })))).ok, true);
  const pairs = ["refund-a", "refund-b", "refund-c", "refund-d"].map((skill) => ({ skill, workflow: "refunds", changed: "skill" }));
  const { entries, asks } = await consolidate(w, replaceAsked, { pairs });
  // The cluster is still asked about; the draft is not.
  assert.ok(asks.length >= 1, "the cluster is asked about");
  assert.doesNotMatch(asks[0], /workflow draft out of step/, "the draft is not asked about");
  const said = JSON.stringify(entries.map((e) => e.data?.left ?? e.data?.problems ?? []));
  assert.match(said, /workflows\/refunds\/workflow\.json/, said.slice(0, 600));
  assert.match(said, /do not fit/);
});

// #2335 review (PRRT_kwDOUmdVMs62FtV0, money): the consolidation's paid request is saved, with what it spent, as it
// returns, before anything a crash can cut. A runner that goes down after the request and before the answer is checked
// and saved: the next claim reuses the saved answer, never asks again, and the run's cost holds that one request.
test("a consolidation whose runner goes down after its paid request resumes on the saved answer: one request, booked once", async (t) => {
  const w = await world(t);
  const id = "run-0-consolidate";
  await w.store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", []) });
  const asks = [];
  const ask = async ({ prompt }) => {
    asks.push(prompt);
    return { text: prompt.startsWith("You keep an agent's learned notes") ? replaceAsked(prompt) : graderAnswer(prompt), usd: 0.01, tokens: { input: 10, cache_read: 0, cache_write: 0, output: 5 } };
  };
  // The first claim's runner goes down right after the request: its checks (which read the refused values) never run.
  let down = true;
  const refuse = async () => {
    if (down) throw new Error("the runner went down");
    return [];
  };
  const loopOf = () => learningLoopFactory({ refuse, store: w.store, data: w.data, ask })({ journal: (c) => w.store.journal(c), flush: () => w.store.flush(), signal: new AbortController().signal });
  const first = await w.store.claim(id, "runner-a", { leaseMs: 60_000 });
  await assert.rejects(loopOf().start(first), /the runner went down/);
  down = false;
  w.clock.now += 120_000;
  const again = await w.store.claim(id, "runner-b", { leaseMs: 60_000 });
  assert.ok(again, "claimable once its lease ran out");
  assert.deepEqual(await loopOf().start(again), { state: "ended" });
  assert.equal(asks.filter((prompt) => prompt.startsWith("You keep an agent's learned notes")).length, 1, "the paid consolidation request is asked once");
  const row = await w.store.runs.get(id);
  assert.equal(Math.round(row.costUsd * 1e6) / 1e6, 0.02, "the run's cost: the one consolidation request and its grade");
});

// PRRT_kwDOUmdVMs62RAsP: a resumed consolidation is held to the clusters its saved answer was asked about, never to
// clusters rebuilt from main as it is at the resume. A note merged between the claims seeds another cluster first, and
// the clusters rebuilt then would leave the saved replacements outside any cluster: the paid answer wasted.
test("a consolidation resumed on its saved answer is held to the clusters that answer was asked about, even when a note merged since changes the clusters main gives now", async (t) => {
  const w = await world(t);
  const id = "run-0-consolidate";
  await w.store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", []) });
  const asks = [];
  const ask = async ({ prompt }) => {
    asks.push(prompt);
    return { text: prompt.startsWith("You keep an agent's learned notes") ? replaceAsked(prompt) : graderAnswer(prompt), usd: 0.01, tokens: { input: 10, cache_read: 0, cache_write: 0, output: 5 } };
  };
  let down = true;
  const refuse = async () => {
    if (down) throw new Error("the runner went down");
    return [];
  };
  const loopOf = () => learningLoopFactory({ refuse, store: w.store, data: w.data, ask })({ journal: (c) => w.store.journal(c), flush: () => w.store.flush(), signal: new AbortController().signal });
  const first = await w.store.claim(id, "runner-a", { leaseMs: 60_000 });
  await assert.rejects(loopOf().start(first), /the runner went down/);
  const askedAbout = ["invoice", "refund", "migration"].filter((topic) => asks[0].includes(`### ${topic}-0.md (`));
  assert.equal(askedAbout.length, 2, "two clusters asked about");
  // Between the claims, another run merges a note of the rule left out: newest, it seeds that rule's cluster first now,
  // five notes, and the two clusters asked about no longer fit one merge beside it.
  const [left] = ["invoice", "refund", "migration"].filter((topic) => !askedAbout.includes(topic));
  const extra = note(`${left} rule e`, RULES[left][0], `${RULES[left][0]}, every time.\n`);
  const between = await mergeOn(w, "run-between", [{ path: `${left}-4.md`, text: extra }]);
  assert.ok(between.ok && between.files.includes(`${left}-4.md`), JSON.stringify(between));
  down = false;
  w.clock.now += 120_000;
  const again = await w.store.claim(id, "runner-b", { leaseMs: 60_000 });
  assert.deepEqual(await loopOf().start(again), { state: "ended" });
  const entries = await journalEntries(w.store.journal(again), BACKGROUND_CONTEXT);
  assert.ok(entries.some((e) => e.kind === KINDS.learningMerged), `the saved answer merges: ${JSON.stringify(entries.map((e) => [e.kind, e.data?.detail, e.data?.problems]))}`);
  const status = statusOf(await w.onFolder((ws) => readSnapshot(ws)));
  for (const topic of askedAbout) {
    assert.equal(status[`${topic}-rule.md`], "active", JSON.stringify(status));
    for (const i of [0, 1, 2, 3]) assert.match(status[`${topic}-${i}.md`], new RegExp(`^(superseded:${topic}-rule\\.md|active)$`));
  }
  assert.equal(asks.filter((prompt) => prompt.startsWith("You keep an agent's learned notes")).length, 1, "asked once");
});

// PRRT_kwDOUmdVMs62RAsX: an answer that rewrites both sides of a pair is graded with the two side by side, never beside
// main's. If the grader keeps one side and drops the other, the kept side was never compared with the partner it would
// merge beside: the pair is dropped whole, and the next consolidation asks for it again.
test("an answer that rewrites both sides of a pair, whose grade drops one side, merges neither: the kept side is left out with its partner, said, and main keeps the pair as it was", async (t) => {
  const w = await driftedWorld(t);
  const skill2 = SKILL.replace("2. Quote the refund lines.", "2. Quote the refund lines whole.\n3. Say the window in days.");
  const draft2 = { ...DRAFT, root: { ...DRAFT.root, instructions: "Say the store's refund policy and its window in days, from the page." } };
  const answer = [`\`\`\`\`skill find-policies\n${skill2}\`\`\`\``, `\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy and window\n---\n${JSON.stringify(draft2)}\n\`\`\`\``].join("\n\n");
  const before = await w.onFolder((ws) => readSnapshot(ws));
  const { end, entries, snapshot, asks } = await consolidate(w, () => answer, { pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }], drop: ["workflows/find-policies/workflow.json"] });
  assert.deepEqual(end, { state: "ended" });
  assert.match(asks[1], /each once, and for no other: skills\/find-policies\/SKILL\.md, workflows\/find-policies\/workflow\.json\./, "both sides graded together");
  assert.equal(snapshot.main, before.main, `nothing merged: ${JSON.stringify(entries.map((e) => [e.kind, e.data?.detail]))}`);
  const dropped = entries.find((e) => e.kind === KINDS.learningDropped);
  assert.equal(dropped?.data.reason, "grader", JSON.stringify(entries.map((e) => [e.kind, e.data])));
  assert.match(dropped.data.detail, /find-policies/, dropped.data.detail);
});

// PRRT_kwDOUmdVMs62S14f: a merge whose pair was dropped whole (pairedOf), committed before its end was recorded (the
// runner stopped between them), resumes as it was: the dropped skill is never read as learned. The resume settles each
// item by the paired verdict, never the grade's own.
test("a merge that dropped a rewritten pair whole, committed before its end was recorded, resumes saying the skill was not learned", async (t) => {
  const invoice = Object.entries(FILES).filter(([file]) => file.startsWith("invoice-")).map(([path, text]) => ({ path, text }));
  const w = await driftedWorld(t, invoice);
  const skill2 = SKILL.replace("2. Quote the refund lines.", "2. Quote the refund lines whole.\n3. Say the window in days.");
  const draft2 = { ...DRAFT, root: { ...DRAFT.root, instructions: "Say the store's refund policy and its window in days, from the page." } };
  const pair = [`\`\`\`\`skill find-policies\n${skill2}\`\`\`\``, `\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy and window\n---\n${JSON.stringify(draft2)}\n\`\`\`\``];
  // The cluster the prompt asks about gets its one replacement (replaceAsked), beside the pair.
  let replacement;
  const answer = (prompt) => ((replacement = replaceAsked(prompt)), [replacement, ...pair].join("\n\n"));
  const id = "run-0-consolidate";
  // The first attempt's commit (the replacement alone: the pair dropped whole) lands while it is graded, as a runner that
  // committed and went down before it recorded its end leaves it for its resume.
  const beforeGrade = async () => {
    const [, file, text] = /```note (\S+)\n([\s\S]*?)```/.exec(replacement);
    const made = await mergeOn(w, id, [{ path: file, text }]);
    assert.equal(made.ok, true, JSON.stringify(made));
  };
  const { end, entries } = await consolidate(w, answer, { id, pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }], drop: ["workflows/find-policies/workflow.json"], beforeGrade });
  assert.deepEqual(end, { state: "ended" });
  const done = entries.find((e) => e.kind === KINDS.learningMerged);
  assert.ok(done, JSON.stringify(entries.map((e) => [e.kind, e.data?.detail, e.data?.left])));
  const skillItem = done.data.verdict.items.find(({ file }) => file === "skills/find-policies/SKILL.md");
  assert.equal(skillItem?.keep, false, `the skill dropped with its partner stays dropped: ${JSON.stringify(skillItem)}`);
  assert.doesNotMatch(done.data.detail, /Learned the skill/, done.data.detail);
});

// Main's hold on a draft calling an MCP tool with no declared price (LS-07, learning-end heldOf) holds a consolidation's
// draft as it holds a run's: its rewrite waits for the owner's OK whatever the grade, never merged served. Its tools are
// the agent's as a run's end reads them (learnedDraftTools over the revision's grants and gates).
test("a consolidation that rewrites a draft to call an MCP tool with no declared price merges it held for the owner's OK, as a run's draft is", async (t) => {
  const w = await driftedWorld(t, [], undefined, undefined, { tools: ["mcp:door/lookup"] });
  const draft2 = { ...DRAFT, root: { node: "call", label: "look up", via: "tool", tool: "mcp:door/lookup", args: { text: "{text}" }, out: "Policies", as: "policies", deadline_s: 30 } };
  const answer = [`\`\`\`\`skill find-policies\n${SKILL_NOW}\`\`\`\``, `\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy\n---\n${JSON.stringify(draft2)}\n\`\`\`\``].join("\n\n");
  const { end, entries } = await consolidate(w, () => answer, { pairs: [{ skill: "find-policies", workflow: "find-policies", changed: "skill" }] });
  assert.deepEqual(end, { state: "ended" });
  const done = entries.find((e) => e.kind === KINDS.learningMerged);
  assert.ok(done, JSON.stringify(entries.map((e) => [e.kind, e.data?.detail, e.data?.left ?? e.data?.problems])));
  const item = done.data.verdict.items.find(({ file }) => file === "workflows/find-policies/workflow.json");
  assert.deepEqual([item?.keep, item?.pending, item?.question], [true, true, "Unpriced"], JSON.stringify(item));
  assert.match(item.why, /lookup on door, which has no price/, item.why);
});

// PRRT_kwDOUmdVMs62Vj3P (a money test): a consolidation's paid request honours a person's stop as the grade's does. A stop
// pending before it sends nothing and costs nothing; a stop during it cuts it at once (its cost then unknown, never $0).
test("a stop pending before a consolidation's first request sends nothing: the run ends stopped at $0, no request made", async (t) => {
  const w = await world(t);
  const { end, row, asks } = await consolidate(w, replaceAsked, { stopFirst: true });
  assert.deepEqual(end, { state: "stopped" });
  assert.deepEqual(asks, [], "no request sent");
  assert.deepEqual([row.state, row.costUsd], ["stopped", 0], "nothing spent");
});

test("a stop during a consolidation's first request cuts it at once: its signal aborts, the run ends stopped, its cost unknown (null), never $0", async (t) => {
  const w = await world(t);
  const id = "run-0-consolidate";
  await w.store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", []) });
  const claim = await w.store.claim(id, "runner-a", { leaseMs: 60_000 });
  let loop;
  let cut;
  // The request in flight: the person's stop lands while it runs, and the request learns of it through its signal alone.
  const ask = async ({ prompt }, signal) => {
    assert.ok(prompt.startsWith("You keep an agent's learned notes"), "only the consolidation request is asked");
    await loop.stop({ kind: "command", commandId: (await w.store.command(id, { kind: "stop" })).id });
    cut = signal.aborted;
    if (signal.aborted) throw signal.reason;
    return { text: replaceAsked(prompt), usd: 0.01 };
  };
  loop = learningLoopFactory({ refuse: async () => [], store: w.store, data: w.data, ask })({ journal: (c) => w.store.journal(c), flush: () => w.store.flush(), signal: new AbortController().signal });
  assert.deepEqual(await loop.start(claim), { state: "stopped" });
  assert.equal(cut, true, "the stop aborted the request's signal while it ran");
  const row = await w.store.runs.get(id);
  assert.deepEqual([row.state, row.costUsd], ["stopped", null], "a cut request may have been billed: unknown, never 0");
});

// PRRT_kwDOUmdVMs62Vj3X: a pair a consolidation was asked about and left out of step is not forgotten when the next merges
// touch neither side: the next consolidation (queued as its merges and budget say) is asked about it again.
test("a skill and its draft a consolidation left out of step are asked about again by the next consolidation, though no later merge touches them", async (t) => {
  const w = await driftedWorld(t);
  const pair = { skill: "find-policies", workflow: "find-policies", changed: "skill" };
  const after = (await w.onFolder((ws) => readSnapshot(ws))).main;
  await w.store.runs.create({ id: "run-d-consolidate", agentId: "agent-1", revisionId: "rev-1" }, { body: consolidationLaunchOf("agent-1", [pair], { after }) });
  // It ends without writing the pair back in step (its request failed, say).
  await endConsolidation(w, "run-d-consolidate");
  for (const i of [1, 2, 3, 4]) {
    assert.deepEqual((await learn(w, `run-${i}`, `long-${i}.md`)).end, { state: "ended" });
    assert.equal(await w.store.runs.get(consolidationRunId(`run-${i}`)), undefined, `merge ${i} since the queue: none`);
  }
  assert.deepEqual((await learn(w, "run-5", "long-5.md")).end, { state: "ended" });
  const launch = (await w.store.runs.launch(consolidationRunId("run-5")))?.body;
  assert.deepEqual(launch?.input.consolidate.pairs, [pair], JSON.stringify(launch?.input));
});
