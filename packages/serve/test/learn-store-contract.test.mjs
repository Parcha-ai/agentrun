// The agent's learning as versioned rows in the Store (Store.learning), one contract over every backend: SQLite here,
// Postgres when AGENTRUN_TEST_PG_URL is set (store-target.mjs). A save is one transaction, compare and swap on the
// agent's newest version; a run's merge is taken once (its merge key); a seed the agent's learning no longer holds (a
// reset since) refuses the save; records (promotions, grades, audits) change in one transaction each. A purge of a run
// deletes its text from every version: its item versions, its grades, and the promotions and audits of the workflow
// versions it alone wrote; its saves stay as facts with no text, its merge key still taken, and its diff is gone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { client, postgresOnly, schemaOf } from "./store-target.mjs";

const { learningCommit, putCorrections } = await import("../dist/learn/commit.js");
const { learningOf, readAt, readView, runMergeOf, writeLearning } = await import("../dist/learn/rows.js");
const { changeWorkflow, etagOf } = await import("../dist/learning-routes.js");

const AGENT = "agent-1";
const HEX = /^[0-9a-f]{40}$/;

/** A workflow `name`'s two files, each holding `word`. */
const flow = (name, word) => [
  { path: `workflows/${name}/README.md`, text: `---\nname: ${name}\ndescription: ${word} description\n---\n` },
  { path: `workflows/${name}/workflow.json`, text: JSON.stringify({ v: 2, name, word }) },
];
const merge = async (learning, change) => {
  const done = await learningCommit(learning, { reason: `${change.runId} reason words`, files: [], ...change });
  assert.equal(done.ok, true, JSON.stringify(done));
  return done;
};
/** Every text the agent's learning rows hold, read through the store: each save the log shows (and the newest), what
 *  it holds and its diff, every version of every item, and every record. */
async function everything(store, agentId = AGENT) {
  const parts = [];
  const at = await store.learning.newest(agentId);
  const saves = (await store.learning.saves(agentId, { limit: 10_000 })).saves;
  for (const save of saves) parts.push(JSON.stringify(save), JSON.stringify(await store.learning.diff(agentId, save.id)), JSON.stringify(await store.learning.itemsAt(agentId, save.id)));
  if (at) {
    parts.push(JSON.stringify(at));
    for (const key of new Set(at.history.map((one) => `${one.kind}/${one.name}`))) {
      const [kind, name] = key.split("/");
      parts.push(JSON.stringify(await store.learning.versions(agentId, kind, name)));
    }
  }
  for (const kind of ["promotion", "grade", "audit"]) parts.push(JSON.stringify(await store.learning.records(agentId, kind)));
  return parts.join("\n");
}
const corrections = async (learning, at) => (at ? (await readAt(learning, at)).text("corrections.md") : (await readAt(learning, (await readView(learning)).main)).text("corrections.md"));
const workflows = async (learning) => (await readView(learning)).workflows.map(({ name, run }) => [name, run]);

test("a first seed makes one empty init save, which every later seed names until a save; newest is undefined before it", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await store.learning.newest(AGENT), undefined);
  const [one, two] = await Promise.all([store.learning.seed(AGENT), store.learning.seed(AGENT)]);
  assert.match(one.save.id, HEX);
  assert.deepEqual([one.save.id, one.save.version, one.save.by, one.items], [two.save.id, 1, { host: "init" }, []]);
  assert.equal((await store.learning.newest(AGENT)).save.id, one.save.id);
  assert.deepEqual(await store.learning.saves(AGENT), { saves: [], more: false, total: 0 }, "the log shows no init save");
  assert.equal(await store.learning.diff(AGENT, one.save.id), undefined, "an init save has no diff");
});

test("a save is compare and swap on the newest version: a stale base writes nothing and says the newest", async (t) => {
  const { store } = await storeOn(t);
  const write = (base, body) => store.learning.save(AGENT, { base, by: { run: "run-a" }, reason: "r", files: ["corrections.md"], items: [{ kind: "note", name: `n${body}`, body, byRun: "run-a", change: "learned", person: false, pos: 0, digest: null }] });
  const first = await write(0, "one");
  assert.ok("saved" in first, JSON.stringify(first));
  assert.deepEqual(await write(0, "two"), { stale: 1 });
  const next = await write(1, "three");
  assert.equal(next.saved.version, 2);
  assert.deepEqual((await store.learning.newest(AGENT)).items.map((item) => item.body).sort(), ["one", "three"]);
  assert.deepEqual((await store.learning.saves(AGENT)).saves.map((save) => save.version), [2, 1]);
});

test("two writers racing each land, the later computed again on the newer version: corrections.md holds both lines", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const [a, b] = await Promise.all([merge(learning, { runId: "run-a", correction: "Line A." }), merge(learning, { runId: "run-b", correction: "Line B." })]);
  assert.notEqual(a.commit, b.commit);
  assert.deepEqual((await corrections(learning)).split("\n").filter(Boolean).sort(), ["- Line A.", "- Line B."]);
  assert.equal((await readView(learning)).version, 2);
});

test("a run's round merges once: a second call is already done at the same save; two calls racing land one save", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const first = await merge(learning, { runId: "run-a", files: flow("x", "ALPHA"), correction: "Be brief." });
  const again = await merge(learning, { runId: "run-a", files: flow("x", "ALPHA"), correction: "Be brief." });
  assert.deepEqual([again.already, again.commit], [true, first.commit]);
  const [one, two] = await Promise.all([merge(learning, { runId: "run-b", correction: "Once." }), merge(learning, { runId: "run-b", correction: "Once." })]);
  assert.equal(one.commit, two.commit);
  assert.equal((await corrections(learning)).split("\n").filter((line) => line === "- Once.").length, 1);
  const round2 = await merge(learning, { runId: "run-b", round: 2, correction: "Twice." });
  assert.notEqual(round2.commit, one.commit, "a later round merges once of its own");
  assert.deepEqual((await store.learning.saves(AGENT)).saves.map((save) => save.by), [{ run: "run-b", round: 2 }, { run: "run-b" }, { run: "run-a" }]);
});

test("a file changed since the run's seed is a conflict, and nothing lands", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const seed = (await merge(learning, { runId: "run-a", files: flow("x", "ALPHA") })).commit;
  await merge(learning, { runId: "run-b", files: flow("x", "BRAVO"), seed });
  const before = (await readView(learning)).main;
  const stale = await learningCommit(learning, { runId: "run-c", reason: "r", files: flow("x", "CHARLIE"), seed });
  assert.deepEqual([stale.ok, stale.reason, stale.problems.map((problem) => problem.path).sort()], [false, "conflict", ["workflows/x/README.md", "workflows/x/workflow.json"]]);
  assert.equal((await readView(learning)).main, before);
});

test("a reset takes every row: a save that must hold a seed from before it is refused, and the next seed is a new first save", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const seed = (await store.learning.seed(AGENT)).save.id;
  await merge(learning, { runId: "run-a", files: flow("x", "ALPHA"), correction: "ALPHA line." });
  await store.learning.addRecord(AGENT, "grade", { runId: "run-a", workflow: null, digest: null, data: { run: "run-a" } });
  await store.learning.reset(AGENT);
  assert.equal(await store.learning.newest(AGENT), undefined);
  assert.equal(await store.learning.itemsAt(AGENT, seed), undefined);
  assert.deepEqual(await store.learning.records(AGENT, "grade"), []);
  const refused = await learningCommit(learning, { runId: "run-b", reason: "r", files: flow("y", "BRAVO"), seed, mustHold: seed });
  assert.deepEqual([refused.ok, refused.reason], [false, "conflict"]);
  assert.match(refused.problems[0].detail, /reset/);
  assert.deepEqual(await store.learning.save(AGENT, { base: 0, by: { run: "run-c" }, reason: "r", files: [], items: [], seed }), { refused: { seed } });
  assert.equal(await store.learning.newest(AGENT), undefined, "nothing landed");
  const fresh = await store.learning.seed(AGENT);
  assert.deepEqual([fresh.save.version, fresh.save.by], [1, { host: "init" }]);
  assert.notEqual(fresh.save.id, seed);
  // The merge of run-a before the reset went with it: run-a may merge again.
  assert.equal((await merge(learning, { runId: "run-a", correction: "Again." })).already, undefined);
});

test("erase takes every row of the agent and none of another's", async (t) => {
  const { store } = await storeOn(t);
  await merge(learningOf(store, AGENT), { runId: "run-a", correction: "Mine." });
  await merge(learningOf(store, "agent-2"), { runId: "run-z", correction: "Theirs.", files: flow("x", "THEIRS") });
  const digest = (await store.learning.versions("agent-2", "workflow", "x"))[0].digest;
  await store.learning.addRecord("agent-2", "audit", { runId: "run-z", workflow: "x", digest, data: {} });
  await store.learning.erase(AGENT);
  assert.equal(await store.learning.newest(AGENT), undefined);
  assert.deepEqual((await store.learning.saves(AGENT)).total, 0);
  assert.equal(await corrections(learningOf(store, "agent-2")), "- Theirs.\n");
  assert.equal((await store.learning.records("agent-2", "audit")).length, 1);
});

test("a save as it was stays readable at its version id; versions and diff say each item's before and after", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const v1 = (await merge(learning, { runId: "run-a", files: flow("x", "ALPHA") })).commit;
  const v2 = (await merge(learning, { runId: "run-b", files: flow("x", "BRAVO") })).commit;
  assert.match((await readAt(learning, v1)).text("workflows/x/README.md"), /ALPHA/);
  assert.match((await readAt(learning, v2)).text("workflows/x/README.md"), /BRAVO/);
  const versions = await store.learning.versions(AGENT, "workflow", "x");
  assert.deepEqual(versions.map((one) => [one.version, one.byRun, one.save.id]), [[2, "run-b", v2], [1, "run-a", v1]]);
  assert.ok(versions.every((one) => typeof one.digest === "string"));
  const diff = await store.learning.diff(AGENT, v2);
  assert.deepEqual([diff.parent.id, diff.items.length], [v1, 1]);
  assert.match(diff.items[0].before, /ALPHA/);
  assert.match(diff.items[0].after, /BRAVO/);
  const patch = await runMergeOf(learning, "run-b");
  assert.deepEqual(patch.files.map((file) => [file.path, file.status]), [["workflows/x/README.md", "modified"], ["workflows/x/workflow.json", "modified"]]);
});

test("a run's merge writes each workflow whole: a file it does not give is gone from its version, never carried from another run's", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run-a", files: flow("x", "ALPHA") });
  await merge(learning, { runId: "run-b", files: [flow("x", "BRAVO")[1]] });
  const [newest] = await store.learning.versions(AGENT, "workflow", "x");
  assert.deepEqual(Object.keys(JSON.parse(newest.body)), ["workflows/x/workflow.json"]);
  assert.doesNotMatch(newest.body, /ALPHA/);
  assert.deepEqual(await workflows(learning), [], "x reads incomplete: no README.md");
});

test("records: added in order, changed whole in one transaction (a kept seq is that record), each kind its own", async (t) => {
  const { store } = await storeOn(t);
  // Each promotion names a digest a version of its workflow holds (a record of one no version holds is refused).
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run-a", files: flow("x", "ALPHA") });
  await merge(learning, { runId: "run-b", files: flow("x", "BRAVO") });
  await merge(learning, { runId: "run-c", files: flow("y", "CHARLIE") });
  const [d2, d1] = (await store.learning.versions(AGENT, "workflow", "x")).map((one) => one.digest);
  const [d3] = (await store.learning.versions(AGENT, "workflow", "y")).map((one) => one.digest);
  const a = await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest: d1, data: { n: 1 } });
  const b = await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest: d2, data: { n: 2 } });
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  const result = await store.learning.changeRecords(AGENT, "promotion", (records) => ({ records: [{ ...records[1], data: { n: 22 } }, { runId: "run-c", workflow: "y", digest: d3, data: { n: 3 } }], result: records.length }));
  assert.equal(result, 2);
  assert.deepEqual((await store.learning.records(AGENT, "promotion")).map((one) => [one.seq, one.digest, one.data]), [[2, d2, { n: 22 }], [3, d3, { n: 3 }]]);
  assert.equal(await store.learning.changeRecords(AGENT, "promotion", () => ({ result: "unchanged" })), "unchanged");
  assert.deepEqual(await store.learning.records(AGENT, "grade"), []);
  const raced = await Promise.all(Array.from({ length: 5 }, (_, i) => store.learning.changeRecords(AGENT, "grade", (records) => ({ records: [...records, { runId: `run-${i}`, workflow: null, digest: null, data: { i } }], result: undefined }))));
  assert.equal(raced.length, 5);
  assert.equal((await store.learning.records(AGENT, "grade")).length, 5, "no change lost");
});

// The purge scenarios (#3415's, on rows): a purged run's text is in no version, no diff and no record; the other runs'
// things stay, each workflow as its newest version left by a run that is not the purged one.

test("a purge takes the purged run's line out of every version and diff; another run's line of the same words, and the lines between, stay", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const shared = "the same words later";
  await merge(learning, { runId: "run_alpha", correction: "ALPHA line from the owner" });
  await merge(learning, { runId: "run_gone", correction: shared });
  await merge(learning, { runId: "run_between", correction: "BETWEEN line from the owner" });
  const view = await readView(learning);
  const text = await corrections(learning);
  assert.equal((await putCorrections(learning, { text: text.replace(`- ${shared}\n`, ""), ifMatch: etagOf(view.corrections.oid) })).ok, true);
  const later = (await merge(learning, { runId: "run_later", correction: shared })).commit;
  const gone = await store.learning.saveOf(AGENT, { mergeKey: "run_gone" });
  await store.learning.purgeRun(AGENT, "run_gone");
  // Every version before the later run's merge, the purged one's own among them, holds none of the words.
  const laterVersion = (await store.learning.saveOf(AGENT, { id: later })).version;
  const before = [gone.id, ...(await store.learning.saves(AGENT, { limit: 100 })).saves.filter((one) => one.version < laterVersion).map((one) => one.id)];
  assert.equal(before.length, 4);
  for (const id of before) assert.ok(!((await corrections(learning, id)) ?? "").includes(shared), id);
  assert.equal(await runMergeOf(learning, "run_gone"), undefined, "the purged run's diff is gone");
  assert.equal(await corrections(learning, later), `- ALPHA line from the owner\n- BETWEEN line from the owner\n- ${shared}\n`);
  assert.ok((await runMergeOf(learning, "run_later")).files[0].patch.includes(`+- ${shared}`), "the later run's diff adds its line");
  const between = await runMergeOf(learning, "run_between");
  assert.ok(!JSON.stringify(between).includes(shared), "a diff between shows no purged line as context");
  // The purged save stays as a fact with no text: out of the log, its merge key taken (the run's merge is already done).
  const purged = await store.learning.saveOf(AGENT, { id: gone.id });
  assert.deepEqual([purged.by, purged.reason, purged.files, purged.mergeKey], [{ host: "purged" }, "", [], "run_gone"]);
  assert.ok(!(await store.learning.saves(AGENT, { limit: 100 })).saves.some((one) => one.id === gone.id));
  assert.equal((await merge(learning, { runId: "run_gone", correction: shared })).already, true);
});

test("a purge takes out only the purged run's copy of a line: one its owner removed and another run added again stays, in that run's diff and on the newest", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const shared = "the same words twice";
  await merge(learning, { runId: "run_alpha", correction: "ALPHA line from the owner" });
  await merge(learning, { runId: "run_gone", correction: shared });
  const view = await readView(learning);
  assert.equal((await putCorrections(learning, { text: (await corrections(learning)).replace(`- ${shared}\n`, ""), ifMatch: etagOf(view.corrections.oid) })).ok, true);
  await merge(learning, { runId: "run_later", correction: shared });
  await store.learning.purgeRun(AGENT, "run_gone");
  assert.equal(await corrections(learning), `- ALPHA line from the owner\n- ${shared}\n`);
  const diff = await runMergeOf(learning, "run_later");
  assert.deepEqual(diff.files.map((file) => [file.path, file.patch.includes(`+- ${shared}`)]), [["corrections.md", true]]);
});

/** corrections.md rewritten as `text` by `by`: a person's edit (putCorrections), or a run's merge that gives the file. */
const rewrite = async (learning, by, text) => {
  if (by === "person") {
    const view = await readView(learning);
    assert.equal((await putCorrections(learning, { text, ifMatch: etagOf(view.corrections.oid) })).ok, true);
    return;
  }
  await writeLearning(learning, async () => ({ result: null, change: { by: { run: by, reason: `${by} reason words` }, writes: [{ path: "corrections.md", text }] } }));
};
for (const by of ["person", "run_mover"]) test(`a line moved outside the longest common run (${by === "person" ? "a person's" : "another run's"} reorder) keeps its writer: the purged run's line is gone from every save and every later one`, async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_alpha", correction: "ALPHA rule." });
  await merge(learning, { runId: "run_bravo", correction: "BRAVO rule." });
  // [A, B] to [B, A]: the longest common run keeps one line, and the other moves outside it.
  await rewrite(learning, by, "- BRAVO rule.\n- ALPHA rule.\n");
  assert.equal(await corrections(learning), "- BRAVO rule.\n- ALPHA rule.\n");
  await store.learning.purgeRun(AGENT, "run_bravo");
  assert.equal(await corrections(learning), "- ALPHA rule.\n", "the purged run's line is gone after a reorder");
  await merge(learning, { runId: "run_later", correction: "LATER rule." });
  assert.equal(await corrections(learning), "- ALPHA rule.\n- LATER rule.\n");
  for (const save of (await store.learning.saves(AGENT, { limit: 100 })).saves) assert.doesNotMatch((await corrections(learning, save.id)) ?? "", /BRAVO/, save.id);
  assert.doesNotMatch(await everything(store), /BRAVO/, "no row holds the purged run's line");
  // The reorder wrote no words: a purge of the run that moved the lines keeps both.
  if (by !== "person") {
    await store.learning.purgeRun(AGENT, by);
    assert.equal(await corrections(learning), "- ALPHA rule.\n- LATER rule.\n");
  }
});

test("a line moved outside the longest common run of three keeps its writer; lines of the same words are matched one to one", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_a", correction: "ALPHA rule." });
  await merge(learning, { runId: "run_b", correction: "BRAVO rule." });
  await merge(learning, { runId: "run_c", correction: "CHARLIE rule." });
  // [A, B, C] to [C, A, B]: the longest common run is [A, B], and C moves outside it.
  await rewrite(learning, "person", "- CHARLIE rule.\n- ALPHA rule.\n- BRAVO rule.\n");
  await store.learning.purgeRun(AGENT, "run_c");
  assert.equal(await corrections(learning), "- ALPHA rule.\n- BRAVO rule.\n", "the purged run's line is gone after a move outside the longest common run");
  assert.doesNotMatch(await everything(store), /CHARLIE/);
  // Two runs' lines of the same words, reordered around a third: each copy keeps its own run, one to one.
  await merge(learning, { runId: "run_x1", correction: "SAME rule." });
  await merge(learning, { runId: "run_y", correction: "YANKEE rule." });
  await merge(learning, { runId: "run_x2", correction: "SAME rule." });
  await rewrite(learning, "run_mover", "- YANKEE rule.\n- SAME rule.\n- SAME rule.\n- BRAVO rule.\n- ALPHA rule.\n");
  const same = (await store.learning.newest(AGENT)).items.filter((item) => item.kind === "note" && item.body === "- SAME rule.").map((item) => item.byRun).sort();
  assert.deepEqual(same, ["run_x1", "run_x2"], "each copy of the same words keeps its own run");
  await store.learning.purgeRun(AGENT, "run_x2");
  assert.equal(await corrections(learning), "- YANKEE rule.\n- SAME rule.\n- BRAVO rule.\n- ALPHA rule.\n");
  await store.learning.purgeRun(AGENT, "run_x1");
  await store.learning.purgeRun(AGENT, "run_a");
  assert.equal(await corrections(learning), "- YANKEE rule.\n- BRAVO rule.\n");
  assert.doesNotMatch(await everything(store), /SAME|ALPHA|CHARLIE/);
});

test("a purge takes the purged run's workflows out of every version: one it alone learned is in none; one a later run rewrote is that run's; the other runs' things stay", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_alpha", files: flow("w", "ALPHA"), correction: "ALPHA line from the owner" });
  const bravo = (await merge(learning, { runId: "run_bravo", files: [...flow("y", "BRAVO"), ...flow("x", "BRAVO")], correction: "BRAVO line from the owner" })).commit;
  // The owner's own line between B's merge and C's: it changes no workflow's run.
  const view = await readView(learning);
  assert.equal((await putCorrections(learning, { text: `${await corrections(learning)}- a hand line\n`, ifMatch: etagOf(view.corrections.oid) })).ok, true);
  const charlie = (await merge(learning, { runId: "run_charlie", files: flow("x", "CHARLIE") })).commit;
  const alphaBefore = (await runMergeOf(learning, "run_alpha")).files;
  await store.learning.purgeRun(AGENT, "run_bravo");
  assert.doesNotMatch(await everything(store), /BRAVO/);
  assert.deepEqual(await workflows(learning), [["w", "run_alpha"], ["x", "run_charlie"]]);
  assert.match((await readAt(learning, charlie)).text("workflows/x/README.md"), /CHARLIE/);
  // B's own version id now reads as B left nothing: no y, no x, no B line.
  const atBravo = await readAt(learning, bravo);
  assert.deepEqual(atBravo.view.workflows.map(({ name }) => name), ["w"]);
  assert.equal(atBravo.text("corrections.md"), "- ALPHA line from the owner\n");
  assert.deepEqual((await runMergeOf(learning, "run_alpha")).files, alphaBefore);
  assert.equal(await corrections(learning), "- ALPHA line from the owner\n- a hand line\n");
});

test("a purge gives back the workflow the purged run revised: A's version again on the newest and at B's version id, and a workflow B wrote alone in none", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const alpha = (await merge(learning, { runId: "run_alpha", files: flow("x", "ALPHA") })).commit;
  const bravo = (await merge(learning, { runId: "run_bravo", files: [...flow("x", "BRAVO"), ...flow("y", "BRAVO")] })).commit;
  const v1 = ["workflows/x/README.md", "workflows/x/workflow.json"].map((path) => readAt(learning, alpha).then((read) => read.text(path)));
  await store.learning.purgeRun(AGENT, "run_bravo");
  assert.doesNotMatch(await everything(store), /BRAVO/);
  for (const at of [bravo, (await readView(learning)).main]) {
    const read = await readAt(learning, at);
    assert.deepEqual(["workflows/x/README.md", "workflows/x/workflow.json"].map((path) => read.text(path)), await Promise.all(v1), at);
    assert.equal(read.text("workflows/y/README.md"), undefined, at);
  }
  assert.deepEqual(await workflows(learning), [["x", "run_alpha"]]);
});

test("a purge takes a person's change of the purged run's workflow with it (still its text), and keeps the person's change of another run's", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_alpha", files: flow("x", "ALPHA"), held: ["workflows/x/README.md"] });
  await merge(learning, { runId: "run_bravo", files: flow("y", "BRAVO"), held: ["workflows/y/README.md"] });
  for (const name of ["x", "y"]) {
    const item = (await readView(learning)).workflows.find((one) => one.name === name);
    assert.equal(item.status, "pending");
    assert.equal((await changeWorkflow(store, AGENT, item.file, { action: "approve", ifMatch: etagOf(item.oid), refuse: [] })).status, 200);
  }
  await store.learning.purgeRun(AGENT, "run_bravo");
  assert.doesNotMatch(await everything(store), /BRAVO/);
  assert.deepEqual((await readView(learning)).workflows.map(({ name, status, run }) => [name, status, run]), [["x", "active", "run_alpha"]]);
  assert.deepEqual((await store.learning.saves(AGENT)).saves.map((save) => save.by.person ?? save.by.run), ["approved", "run_alpha"], "the log shows neither of B's saves");
});

test("a purge takes the purged run's grades, and the promotions and audits of the workflow versions it alone wrote; another's stay; it is idempotent", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_alpha", files: flow("x", "ALPHA") });
  await merge(learning, { runId: "run_bravo", files: flow("y", "BRAVO") });
  const digestOf = async (name) => (await store.learning.versions(AGENT, "workflow", name))[0].digest;
  const [x, y] = [await digestOf("x"), await digestOf("y")];
  for (const [workflow, digest] of [["x", x], ["y", y]]) {
    await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow, digest, data: { workflow, digest, decided: "promote", reason: `${workflow} words` } });
    await store.learning.addRecord(AGENT, "audit", { runId: "run_audited", workflow, digest, data: { workflow, digest } });
  }
  await store.learning.addRecord(AGENT, "grade", { runId: "run_bravo", workflow: null, digest: null, data: { run: "run_bravo", label: "BRAVO grade words" } });
  await store.learning.addRecord(AGENT, "grade", { runId: "run_alpha", workflow: null, digest: null, data: { run: "run_alpha" } });
  await store.learning.purgeRun(AGENT, "run_bravo");
  await store.learning.purgeRun(AGENT, "run_bravo");
  assert.doesNotMatch(await everything(store), /BRAVO/);
  assert.deepEqual((await store.learning.records(AGENT, "promotion")).map((one) => one.workflow), ["x"]);
  assert.deepEqual((await store.learning.records(AGENT, "audit")).map((one) => one.workflow), ["x"]);
  assert.deepEqual((await store.learning.records(AGENT, "grade")).map((one) => one.runId), ["run_alpha"]);
});

test("a purge keeps the promotion of a digest another run also wrote (changed the file to it): that run's version still holds it", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const same = flow("x", "SAME");
  await merge(learning, { runId: "run_alpha", files: same });
  await merge(learning, { runId: "run_bravo", files: flow("x", "BRAVO") });
  await merge(learning, { runId: "run_charlie", files: same });
  const digest = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest, data: { workflow: "x", digest } });
  await store.learning.purgeRun(AGENT, "run_charlie");
  assert.equal((await store.learning.records(AGENT, "promotion")).length, 1, "run_alpha's version holds the digest");
  assert.deepEqual(await workflows(learning), [["x", "run_bravo"]]);
});

// A promotion names the save its revision's text is read at (its `commit`): a purge that keeps the record (another run's
// version holds the digest) names a save that still holds it, so the champion still serves.
test("a purge keeps a shared promotion serving: its record is moved to a save of a version that still holds its digest", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const same = flow("x", "SAME");
  const alpha = await merge(learning, { runId: "run_alpha", files: same });
  await merge(learning, { runId: "run_bravo", files: flow("x", "BRAVO") });
  const charlie = await merge(learning, { runId: "run_charlie", files: same });
  const digest = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest, data: { workflow: "x", digest, decided: "promote", commit: charlie.commit } });
  await store.learning.purgeRun(AGENT, "run_charlie");
  const [record] = await store.learning.records(AGENT, "promotion");
  assert.ok(record, "run_alpha's version holds the digest: the promotion stays");
  assert.equal(record.data.commit, alpha.commit, "its commit names run_alpha's save, the newest that holds the digest");
  assert.equal((await readAt(learning, record.data.commit)).text("workflows/x/workflow.json"), same[1].text, "the champion's text is read there");
  assert.deepEqual(await workflows(learning), [["x", "run_bravo"]]);
});

// Each file of a workflow is its writer's: the run that changed it to its text. A run's merge that gives a file as it
// was at its base changes nothing of it, so the file stays its earlier writer's, and a purge takes each file back to
// the text before its writer's (the view's `run`: workflow.json's writer).
for (const purged of ["run_r", "run_s"]) test(`a merge that copies a file unchanged is not its writer: a purge of ${purged === "run_r" ? "the run that wrote workflow.json takes it out of the copy's version too, with its promotion" : "the copier takes only its README, and the promotion stays"}`, async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const readme = (word) => ({ path: "workflows/x/README.md", text: `---\nname: x\ndescription: ${word} description\n---\n` });
  const json = (word) => ({ path: "workflows/x/workflow.json", text: JSON.stringify({ v: 2, name: "x", steps: word }) });
  await merge(learning, { runId: "run_q", files: [readme("QWORD"), json("QSTEPS")] });
  await merge(learning, { runId: "run_r", files: [readme("RWORD"), json("RSECRET")] });
  await merge(learning, { runId: "run_s", files: [readme("SWORD"), json("RSECRET")] });
  assert.deepEqual(await workflows(learning), [["x", "run_r"]], "workflow.json is still run_r's: run_s gave it unchanged");
  const digest = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest, data: { workflow: "x", digest, decided: "promote" } });
  await store.learning.purgeRun(AGENT, purged);
  const read = await readAt(learning, (await readView(learning)).main);
  if (purged === "run_r") {
    assert.doesNotMatch(await everything(store), /RSECRET|RWORD/);
    assert.match(read.text("workflows/x/README.md"), /SWORD/, "run_s's README stays");
    assert.match(read.text("workflows/x/workflow.json"), /QSTEPS/, "workflow.json is back to run_q's");
    assert.deepEqual(await workflows(learning), [["x", "run_q"]]);
    assert.deepEqual(await store.learning.records(AGENT, "promotion"), [], "no version holds the promoted digest");
  } else {
    assert.doesNotMatch(await everything(store), /SWORD/);
    assert.match(read.text("workflows/x/README.md"), /RWORD/);
    assert.match(read.text("workflows/x/workflow.json"), /RSECRET/);
    assert.deepEqual(await workflows(learning), [["x", "run_r"]]);
    assert.equal((await store.learning.records(AGENT, "promotion")).length, 1, "run_r's version holds the digest");
  }
});

test("a person's retire outlives a purge of the run whose text it retired: the version that comes back is retired too", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  await merge(learning, { runId: "run_r", files: flow("x", "RWORD") });
  const item = (await readView(learning)).workflows[0];
  assert.equal((await changeWorkflow(store, AGENT, item.file, { action: "retire", ifMatch: etagOf(item.oid), refuse: [] })).status, 200);
  await store.learning.purgeRun(AGENT, "run_r");
  assert.doesNotMatch(await everything(store), /RWORD/);
  assert.deepEqual((await readView(learning)).workflows.map(({ name, status, run }) => [name, status, run]), [["x", "retired", "run_q"]]);
  assert.match((await readAt(learning, (await readView(learning)).main)).text("workflows/x/README.md"), /QWORD/);
});

test("a purge touches only the run's agent: another agent's items, saves and records of the same run id stay", async (t) => {
  const { store } = await storeOn(t);
  const mine = learningOf(store, AGENT);
  const theirs = learningOf(store, "agent-2");
  await merge(mine, { runId: "run_shared", files: flow("x", "MINE") });
  await merge(theirs, { runId: "run_shared", files: flow("y", "THEIRS"), held: ["workflows/y/README.md"] });
  const item = (await readView(theirs)).workflows[0];
  assert.equal((await changeWorkflow(store, "agent-2", item.file, { action: "approve", ifMatch: etagOf(item.oid), refuse: [] })).status, 200);
  const digest = (await store.learning.versions("agent-2", "workflow", "y"))[0].digest;
  await store.learning.addRecord("agent-2", "promotion", { runId: null, workflow: "y", digest, data: { workflow: "y", digest } });
  await store.learning.addRecord("agent-2", "grade", { runId: "run_shared", workflow: null, digest: null, data: { run: "run_shared" } });
  await store.learning.purgeRun(AGENT, "run_shared");
  assert.doesNotMatch(await everything(store), /MINE/);
  assert.deepEqual((await readView(theirs)).workflows.map(({ name, status, run }) => [name, status, run]), [["y", "active", "run_shared"]]);
  assert.deepEqual((await store.learning.saves("agent-2")).saves.map((save) => save.by.person ?? save.by.run), ["approved", "run_shared"]);
  assert.equal((await store.learning.records("agent-2", "promotion")).length, 1);
  assert.equal((await store.learning.records("agent-2", "grade")).length, 1);
});

test("a person's save that changed the purged run's workflow and another keeps the other, and names none of the purged run's", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  await merge(learning, { runId: "run_r", files: flow("rname", "RWORD") });
  await writeLearning(learning, async () => ({ result: null, change: { by: { person: "edited", file: "workflows/rname/README.md" }, writes: [
    { path: "workflows/rname/README.md", text: "---\nname: rname\ndescription: edited RWORD description\n---\n" },
    { path: "workflows/x/README.md", text: "---\nname: x\ndescription: edited QWORD description\n---\n" },
  ] } }));
  await store.learning.purgeRun(AGENT, "run_r");
  assert.doesNotMatch(await everything(store), /RWORD|rname/);
  const [save] = (await store.learning.saves(AGENT)).saves;
  assert.deepEqual([save.by.person, save.files], ["edited", ["workflows/x/README.md"]], "the person's save stays, with x's file alone");
  assert.match((await readAt(learning, (await readView(learning)).main)).text("workflows/x/README.md"), /edited QWORD/);
});

test("the audit ledger keeps its newest AUDITS_KEPT rows and every open started line, trimmed in the write that adds", async (t) => {
  const { store } = await storeOn(t);
  const { AUDITS_KEPT, addAuditLines, ledgerOf } = await import("../dist/learn/audit.js");
  assert.equal(typeof AUDITS_KEPT, "number");
  await merge(learningOf(store, AGENT), { runId: "run_q", files: flow("x", "QWORD") });
  const digest = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  const at = "2026-11-25T00:00:00.000Z";
  const common = (run) => ({ run, shadow_run: `audit.${run}`, workflow: "x", digest, promoted_at: null, at });
  const shadow = (run) => ({ ...common(run), source: "shadow", agreed: true, served_cost: 0.1, shadow_cost: 0.1 });
  const lines = [{ ...common("open-0"), source: "started" }, { ...common("closed-0"), source: "started" }, shadow("closed-0")];
  for (let i = 0; i < AUDITS_KEPT + 5; i++) lines.push(shadow(`r-${i}`));
  await addAuditLines(store.learning, AGENT, lines);
  const kept = await ledgerOf(store.learning, AGENT);
  assert.equal(kept.length, AUDITS_KEPT + 1);
  assert.deepEqual([kept[0].run, kept[0].source], ["open-0", "started"], "the open started line stays");
  assert.deepEqual(kept.slice(1).map((line) => line.run), lines.slice(-AUDITS_KEPT).map((line) => line.run), "the newest rows");
});

test("a promotion recorded for a digest no version of its workflow holds (a purge took it since its check read it) writes nothing, in the one write; a failed draft's record is the one exception", async (t) => {
  const { store } = await storeOn(t);
  const { recordPromotion } = await import("../dist/learn/promote.js");
  const { LearningRecordRefused } = await import("../dist/store/index.js");
  await merge(learningOf(store, AGENT), { runId: "run_q", files: flow("x", "QWORD") });
  const record = { workflow: "x", digest: "0123456789abcdef", at: "2026-11-25T00:00:00.000Z", decided: "promote", reason: "checked: promoted" };
  for (const decided of ["promote", "hold", "replaying"]) {
    const done = await recordPromotion(store.learning, AGENT, { ...record, decided }, () => true);
    assert.deepEqual([done.won, done.record], [false, undefined], `a ${decided} of an unheld digest is not won`);
  }
  assert.deepEqual(await store.learning.records(AGENT, "promotion"), [], "nothing written");
  await assert.rejects(store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest: record.digest, data: record }), LearningRecordRefused, "a raw add of an unheld digest is refused too");
  await assert.rejects(store.learning.addRecord(AGENT, "audit", { runId: null, workflow: "x", digest: record.digest, data: record }), LearningRecordRefused);
  const failed = await recordPromotion(store.learning, AGENT, { ...record, digest: "draftfailed00001", decided: "hold" }, () => true, { anyDigest: true });
  assert.equal(failed.won, true, "a failed draft's hold names its run's own digest, which no version holds");
  const held = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  assert.equal((await recordPromotion(store.learning, AGENT, { ...record, digest: held }, () => true)).record.decided, "promote", "a digest a version holds is promoted");
});

// A record's write read before a purge, written after it: the purge took the digest it names, so its write (in its own
// transaction) writes nothing. In order, never by timing: the reservation reads the digest, the purge commits, then the
// reservation and an audit line are written.
test("a promotion reservation and an audit line prepared before a purge and written after it write nothing for the digest the purge took", async (t) => {
  const { store } = await storeOn(t);
  const { recordPromotion, promotionsOf } = await import("../dist/learn/promote.js");
  const { addAuditLines, ledgerOf } = await import("../dist/learn/audit.js");
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  await merge(learning, { runId: "run_r", files: flow("x", "RWORD") });
  const [taken, kept] = [(await store.learning.versions(AGENT, "workflow", "x"))[0].digest, (await store.learning.versions(AGENT, "workflow", "x")).at(-1).digest];
  assert.notEqual(taken, kept);
  const at = "2026-11-25T00:00:00.000Z";
  const reservation = { workflow: "x", digest: taken, at, decided: "replaying", reason: "checking", runs: ["replay-1"], inputs: ["run_q"], replay_id: "replay" };
  const line = (digest, run) => ({ run, shadow_run: `audit.${run}`, workflow: "x", digest, promoted_at: null, at, source: "started" });
  await store.learning.purgeRun(AGENT, "run_r");
  const reserved = await recordPromotion(store.learning, AGENT, reservation, (was) => was === undefined);
  assert.equal(reserved.won, false, "the reservation is not won: its claim starts no replay");
  assert.deepEqual(await promotionsOf(store.learning, AGENT), []);
  const { added } = await addAuditLines(store.learning, AGENT, [line(taken, "served-1"), line(kept, "served-2")]);
  assert.deepEqual(added.map((one) => one.run), ["served-2"], "the line of the taken digest is not appended; the other is");
  assert.deepEqual((await ledgerOf(store.learning, AGENT)).map((one) => one.digest), [kept]);
});

test("a person's restore after a retire outlives a purge of the run whose text it restored: the version that comes back is active", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  await merge(learning, { runId: "run_r", files: flow("x", "RWORD") });
  const act = async (action) => {
    const item = (await readView(learning)).workflows[0];
    assert.equal((await changeWorkflow(store, AGENT, item.file, { action, ifMatch: etagOf(item.oid), refuse: [] })).status, 200, action);
  };
  await act("retire");
  await act("restore");
  assert.equal((await readView(learning)).workflows[0].status, "active");
  await store.learning.purgeRun(AGENT, "run_r");
  assert.doesNotMatch(await everything(store), /RWORD/);
  assert.deepEqual((await readView(learning)).workflows.map(({ name, status, run }) => [name, status, run]), [["x", "active", "run_q"]], "the owner's newest decision, restore, stands");
});

test("a purge scrubs every other save of a path only the purged run wrote: a later run's save and a person's save name it nowhere", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  // run_r adds a file of its own to x (a path only it wrote), a person edits it (its writer still run_r), and run_s's
  // merge gives x without it: run_s's save names it among the files it changed (deleted).
  await merge(learning, { runId: "run_r", files: [...flow("x", "RWORD"), { path: "workflows/x/rsecretpath.md", text: "RWORD notes" }] });
  await writeLearning(learning, async () => ({ result: null, change: { by: { person: "edited", file: "workflows/x/rsecretpath.md" }, writes: [{ path: "workflows/x/rsecretpath.md", text: "edited RWORD notes" }] } }));
  await merge(learning, { runId: "run_s", files: flow("x", "SWORD") });
  assert.ok((await store.learning.saves(AGENT)).saves[0].files.includes("workflows/x/rsecretpath.md"), "run_s's save names the path it deleted");
  assert.match(await everything(store), /rsecretpath/);
  await store.learning.purgeRun(AGENT, "run_r");
  assert.doesNotMatch(await everything(store), /RWORD|rsecretpath/, "no save, file list or reason names the purged run's path");
  assert.match((await readAt(learning, (await readView(learning)).main)).text("workflows/x/README.md"), /SWORD/, "run_s's own change stays");
  assert.deepEqual((await store.learning.saves(AGENT)).saves.map((save) => [save.by.run ?? save.by.person, save.files]), [["run_s", ["workflows/x/README.md", "workflows/x/workflow.json"]], ["run_q", ["workflows/x/README.md", "workflows/x/workflow.json"]]]);
});

test("a purge that changed a row is a host save (kind purged) at the newest version plus one, which the log never shows; one that changed nothing adds none", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  await merge(learning, { runId: "run_r", files: flow("y", "RWORD") });
  const before = (await store.learning.newest(AGENT)).save;
  await store.learning.purgeRun(AGENT, "run_r");
  const after = (await store.learning.newest(AGENT)).save;
  assert.deepEqual([after.version, after.by], [before.version + 1, { host: "purged" }]);
  await store.learning.purgeRun(AGENT, "run_r");
  await store.learning.purgeRun(AGENT, "run_never");
  assert.equal((await store.learning.newest(AGENT)).save.version, after.version, "a second purge, and a purge of a run that learned nothing, add no save");
  assert.deepEqual((await store.learning.saves(AGENT)).saves.map((save) => save.by.run ?? save.by.host), ["run_q"], "the log shows neither the purged run's save nor the purge's");
});

// A purge is a save: a host save at the agent's newest version + 1 in the purge's own transaction, so a save computed
// before the purge (its base read before it) is stale and computed again on the rewritten rows. Driven in order, never
// by timing: the save is prepared, the purge commits, then the save is submitted.
test("a save prepared before a purge and submitted after it is stale: it never writes the purged run's text back", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  await merge(learning, { runId: "run_r", files: flow("x", "RWORD") });
  // The store's own compare and swap: a save whose base is the version read before the purge.
  const before = await store.learning.newest(AGENT);
  const json = before.items.find((item) => item.kind === "workflow" && item.name === "x");
  await store.learning.purgeRun(AGENT, "run_r");
  const late = await store.learning.save(AGENT, { base: before.save.version, by: { person: "edited", file: "workflows/x/README.md" }, reason: "edited by a person", files: ["workflows/x/README.md"], items: [{ ...json, body: json.body.replace("RWORD description", "RWORD edited"), change: "edited", person: true, pos: 0 }] });
  assert.doesNotMatch(await everything(store), /RWORD/, "the purged run's text is not written back");
  assert.ok("stale" in late, JSON.stringify(late));
  // A person's write through writeLearning, read before the purge (its compute runs once on the version read before it):
  // computed again on the rewritten rows.
  await merge(learning, { runId: "run_s", files: flow("x", "SWORD") });
  let purged = false;
  const { saved } = await writeLearning(learning, async (read) => {
    if (!purged) {
      purged = true;
      await store.learning.purgeRun(AGENT, "run_s");
    }
    const text = read.text("workflows/x/README.md");
    return { result: null, change: { by: { person: "edited", file: "workflows/x/README.md" }, writes: [{ path: "workflows/x/README.md", text: text.replace(/description: (\w+) description/, "description: $1 edited description") }] } };
  });
  assert.doesNotMatch(await everything(store), /SWORD/, "the write read before the purge is computed again after it");
  assert.match((await readAt(learning, saved.id)).text("workflows/x/README.md"), /QWORD edited description/);
});

// A run live across a purge: its seed was read before the purge rewrote it, so its draft can hold the purged run's bytes
// as its own (a file given unchanged from the seed). Its merge is refused whole, nothing written.
test("a run seeded before a purge has its merge refused: the purged run's bytes are never saved as its own", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const created = await merge(learning, { runId: "run_r", files: flow("x", "RWORD") });
  // run_s was seeded at run_r's save: its sandbox holds run_r's README.md, which its draft gives back unchanged.
  const seed = created.commit;
  await store.learning.purgeRun(AGENT, "run_r");
  const [readme] = flow("x", "RWORD");
  const done = await learningCommit(learning, { runId: "run_s", reason: "run_s reason words", seed, mustHold: seed, files: [readme, { path: "workflows/x/workflow.json", text: JSON.stringify({ v: 2, name: "x", word: "SWORD" }) }], correction: "Use the SWORD rule." });
  assert.doesNotMatch(await everything(store), /RWORD/, "run_r's README is not saved as run_s's");
  assert.deepEqual([done.ok, done.reason], [false, "purged"], JSON.stringify(done));
  assert.doesNotMatch(await everything(store), /SWORD/, "nothing of the refused merge is written");
  assert.equal(await runMergeOf(learning, "run_s"), undefined);
  // A run seeded after the purge merges.
  const after = (await store.learning.newest(AGENT)).save.id;
  const later = await learningCommit(learning, { runId: "run_t", reason: "run_t reason words", seed: after, files: flow("x", "TWORD") });
  assert.equal(later.ok, true, JSON.stringify(later));
});

// The lock order a reset and a run's purge take: the agent's learning lock, then its records' lock. On Postgres a records
// write in flight (its transaction holding the records' lock, its row written, not yet committed) is in before the
// reset's or the purge's delete, never left after it. Driven by the locks, never by timing: the reset or purge is seen
// waiting in pg_locks before the write commits.
for (const [what, drop] of [["a reset", (store) => store.learning.reset(AGENT)], ["a run's purge", (store) => store.learning.purgeRun(AGENT, "run_r")]]) test(`on Postgres, ${what} waits for a records write that holds the agent's records lock, then deletes what it wrote: no record of what it took outlives it`, postgresOnly("advisory locks"), async (t) => {
  const { store, file } = await storeOn(t);
  const schema = schemaOf(file);
  await merge(learningOf(store, AGENT), { runId: "run_r", files: flow("x", "RWORD") });
  const digest = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  const [writer, watcher] = [await client(schema), await client(schema)];
  t.after(() => Promise.all([writer.end(), watcher.end()]));
  await writer.query("BEGIN");
  await writer.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [schema, `learning.records:${AGENT}`]);
  await writer.query("INSERT INTO learning_records (agent_id, kind, seq, run_id, workflow, digest, data, at) VALUES ($1, 'promotion', 1, NULL, 'x', $2, '{}', 0)", [AGENT, digest]);
  let done = false;
  const dropping = drop(store).then(() => { done = true; });
  const waiting = async () => (await watcher.query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = hashtext($1)::oid AND objid = hashtext($2)::oid AND objsubid = 2", [schema, `learning.records:${AGENT}`])).rows[0].n;
  while (!done && (await waiting()) === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, `${what} waits on the records' lock`);
  await writer.query("COMMIT");
  await dropping;
  assert.deepEqual(await store.learning.records(AGENT, "promotion"), [], "the write that held the lock is in before the delete, and goes with it");
});

/** Run `id` of agent-1 made, ended and purged through the store (Runs.purge: its learning rows go in its transaction). */
async function purgedRun(store, id) {
  const { queued } = await import("./store-helpers.mjs");
  await queued(store, id);
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended", costUsd: 0.1 });
  await store.runs.purge(id, { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
}

// A correction line is the owner's new words appended to the newest corrections.md: it copies nothing from the run's
// seed, so a purge since the seed (of another run) never refuses it. A draft from the same seed still is.
test("an owner's correction on a run seeded before another run's purge lands: a correction-only merge copies no seed bytes", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  const seed = (await store.learning.newest(AGENT)).save.id;
  await merge(learning, { runId: "run_r", files: flow("y", "RWORD") });
  await store.learning.purgeRun(AGENT, "run_r");
  const done = await learningCommit(learning, { runId: "run_s", reason: "run_s reason words", seed, mustHold: seed, files: [], correction: "The DOB field is MM/DD." });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(await corrections(learning), /The DOB field is MM\/DD\./, "the owner's line lands");
  const draft = await learningCommit(learning, { runId: "run_t", reason: "run_t reason words", seed, mustHold: seed, files: flow("x", "TWORD"), correction: "Use the TWORD rule." });
  assert.deepEqual([draft.ok, draft.reason], [false, "purged"], "a draft read at the same seed is still refused");
  assert.doesNotMatch(await everything(store), /TWORD/);
});

// A promotion's `commit` names the save its champion's text is read at. One written after a purge, with a commit read
// before it (a claim seeded at the purged run's save), names a save that holds its digest: moved in its own write.
test("a promotion written after a purge, with a commit the purge rewrote, names the newest save that holds its digest: the champion serves", async (t) => {
  const { store } = await storeOn(t);
  const { recordPromotion } = await import("../dist/learn/promote.js");
  const learning = learningOf(store, AGENT);
  const same = flow("x", "SAME");
  const alpha = await merge(learning, { runId: "run_alpha", files: same });
  await merge(learning, { runId: "run_bravo", files: flow("x", "BRAVO") });
  const charlie = await merge(learning, { runId: "run_charlie", files: same });
  const digest = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  await store.learning.purgeRun(AGENT, "run_charlie");
  const done = await recordPromotion(store.learning, AGENT, { workflow: "x", digest, at: "2026-11-25T00:00:00.000Z", decided: "promote", reason: "checked: promoted", commit: charlie.commit }, () => true);
  assert.equal(done.won, true);
  const [record] = await store.learning.records(AGENT, "promotion");
  assert.equal(record.data.commit, alpha.commit, "its commit names run_alpha's save, the newest that holds the digest");
  assert.equal((await readAt(learning, record.data.commit)).text("workflows/x/workflow.json"), same[1].text, "the champion's text is read there");
  const added = await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest, data: { workflow: "x", digest, decided: "promote", commit: charlie.commit } });
  assert.equal(added.data.commit, alpha.commit, "a raw add is moved the same way");
  assert.equal((await store.learning.records(AGENT, "promotion")).at(-1).data.commit, alpha.commit);
});

// A compile whose drafts all failed keeps a hold record naming its workflow and the check errors; its digest is its
// run's, which no version holds. It is the run's: its purge takes it, and one written after the purge writes nothing.
test("a purged run's failed-draft hold goes with its purge, and one written after its purge writes nothing", async (t) => {
  const { store } = await storeOn(t);
  const { recordDraftFailed } = await import("../dist/runner/learning-end.js");
  const { promotionsOf } = await import("../dist/learn/promote.js");
  const failed = (runId) => recordDraftFailed({ store }, { runId, agentId: AGENT, compile: { mode: "new" }, workflow: `acme-${runId}-escalation`, errors: [`workflows/acme-${runId}-escalation/workflow.json: FAILWORD`] });
  const { queued } = await import("./store-helpers.mjs");
  await queued(store, "run_f");
  await failed("run_f");
  assert.equal((await promotionsOf(store.learning, AGENT)).length, 1, "the hold is kept");
  const claim = await store.claim("run_f", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended", costUsd: 0.1 });
  await store.runs.purge("run_f", { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null });
  assert.doesNotMatch(await everything(store), /FAILWORD|acme-run_f/, "the purged run's failed-draft hold is gone");
  await failed("run_f");
  assert.doesNotMatch(await everything(store), /FAILWORD|acme-run_f/, "one written after the purge writes nothing");
});

// A promotion's check and audit copy a run's input and answer into their disagreements. A purged run's copies are
// blanked by its purge's own transaction (one written before it), and in the write of one written after it (a check
// that read its rows before the purge): no record keeps a purged run's words.
test("a promotion record never keeps a purged run's input or answer: blanked in the purge's transaction, and in the write of one made after it", async (t) => {
  const { store } = await storeOn(t);
  const { recordPromotion } = await import("../dist/learn/promote.js");
  const learning = learningOf(store, AGENT);
  await merge(learning, { runId: "run_q", files: flow("x", "QWORD") });
  await merge(learning, { runId: "run_p", files: flow("y", "PWORD") });
  const [x, y] = [(await store.learning.versions(AGENT, "workflow", "x"))[0].digest, (await store.learning.versions(AGENT, "workflow", "y"))[0].digest];
  const told = (run, word) => ({ run, input: `${word} input`, agent: `${word} answer`, draft: `${word} draft` });
  const hold = (workflow, digest, gone) => ({ workflow, digest, at: "2026-11-25T00:00:00.000Z", decided: "hold", reason: "checked: held", check: { compile_after: 3, agree_min: 1, alone_min: 1, attempt: 1, n: 2, agreed: 1, alone: 0, of: [], disagreements: [told(gone, "GONE"), told("run_live", "LIVE")] } });
  await recordPromotion(store.learning, AGENT, { ...hold("x", x, "run_before"), audit: { disagreements: [{ run: "run_live", served: "run_before", input: "GONE served input", agent: "GONE served answer", draft: null }] } }, () => true);
  await purgedRun(store, "run_before");
  assert.doesNotMatch(await everything(store), /GONE/, "a record written before the purge is blanked in its transaction");
  await purgedRun(store, "run_after");
  await recordPromotion(store.learning, AGENT, hold("y", y, "run_after"), () => true);
  assert.doesNotMatch(await everything(store), /GONE/, "a record written after the purge is blanked in its write");
  assert.match(await everything(store), /LIVE input/, "another run's copy stays");
  assert.deepEqual((await store.learning.records(AGENT, "promotion")).map((one) => one.data.decided), ["hold", "hold"], "each decision stays");
});
