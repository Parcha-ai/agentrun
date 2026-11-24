// The agent's learning as versioned rows in the Store (Store.learning), one contract over every backend: SQLite here,
// Postgres when AGENTRUN_TEST_PG_URL is set (store-target.mjs). A save is one transaction, compare and swap on the
// agent's newest version; a run's merge is taken once (its merge key); a seed the agent's learning no longer holds (a
// reset since) refuses the save; records (promotions, grades, audits) change in one transaction each. A purge of a run
// deletes its text from every version: its item versions, its grades, and the promotions and audits of the workflow
// versions it alone wrote; its saves stay as facts with no text, its merge key still taken, and its diff is gone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

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
  await merge(learningOf(store, "agent-2"), { runId: "run-z", correction: "Theirs." });
  await store.learning.addRecord("agent-2", "audit", { runId: "run-z", workflow: "x", digest: "d", data: {} });
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
  const a = await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest: "d1", data: { n: 1 } });
  const b = await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest: "d2", data: { n: 2 } });
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  const result = await store.learning.changeRecords(AGENT, "promotion", (records) => ({ records: [{ ...records[1], data: { n: 22 } }, { runId: "run-c", workflow: "y", digest: "d3", data: { n: 3 } }], result: records.length }));
  assert.equal(result, 2);
  assert.deepEqual((await store.learning.records(AGENT, "promotion")).map((one) => [one.seq, one.digest, one.data]), [[2, "d2", { n: 22 }], [3, "d3", { n: 3 }]]);
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
  await store.learning.purgeRun("run_gone");
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
  await store.learning.purgeRun("run_gone");
  assert.equal(await corrections(learning), `- ALPHA line from the owner\n- ${shared}\n`);
  const diff = await runMergeOf(learning, "run_later");
  assert.deepEqual(diff.files.map((file) => [file.path, file.patch.includes(`+- ${shared}`)]), [["corrections.md", true]]);
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
  await store.learning.purgeRun("run_bravo");
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
  await store.learning.purgeRun("run_bravo");
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
  await store.learning.purgeRun("run_bravo");
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
  await store.learning.purgeRun("run_bravo");
  await store.learning.purgeRun("run_bravo");
  assert.doesNotMatch(await everything(store), /BRAVO/);
  assert.deepEqual((await store.learning.records(AGENT, "promotion")).map((one) => one.workflow), ["x"]);
  assert.deepEqual((await store.learning.records(AGENT, "audit")).map((one) => one.workflow), ["x"]);
  assert.deepEqual((await store.learning.records(AGENT, "grade")).map((one) => one.runId), ["run_alpha"]);
});

test("a purge keeps the promotion of a digest another run also wrote: the same workflow text is still that run's", async (t) => {
  const { store } = await storeOn(t);
  const learning = learningOf(store, AGENT);
  const same = flow("x", "SAME");
  await merge(learning, { runId: "run_alpha", files: same });
  await merge(learning, { runId: "run_bravo", files: flow("x", "BRAVO") });
  await merge(learning, { runId: "run_charlie", files: same });
  const digest = (await store.learning.versions(AGENT, "workflow", "x"))[0].digest;
  await store.learning.addRecord(AGENT, "promotion", { runId: null, workflow: "x", digest, data: { workflow: "x", digest } });
  await store.learning.purgeRun("run_charlie");
  assert.equal((await store.learning.records(AGENT, "promotion")).length, 1, "run_alpha's version holds the digest");
  assert.deepEqual(await workflows(learning), [["x", "run_bravo"]]);
});
