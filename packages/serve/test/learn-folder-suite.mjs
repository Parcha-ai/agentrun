// The learning folder (learn/folder.ts: the snapshot, the merges, the reads and writes on top of the learning store),
// with the SAME assertions over every store: learn-folder-local.test.mjs runs them on the local git folder,
// learn-folder-code-storage.test.mjs on code.storage over its in-memory fake. Every check reads through the store alone,
// so a store that is not a folder of this machine is checked the same way. What the store holds: corrections.md and the
// learned workflow drafts, each workflows/<name>/README.md and workflow.json, and the host's .agentrun/ beside them.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blobOid, FolderTooLarge, forgetBodies, commitChange, learningInit, LOG_KEEP, nextSnapshot, readLearning, readSnapshot, runMergeOf, SNAPSHOT_FILE, WRITE_MAX, writeLearning,
} from "../dist/learn/folder.js";
import { learningCommit } from "../dist/learn/commit.js";
import { held, readmeOf, released, restoredLearned, retiredLearned } from "../dist/learn/workflow-draft.js";

const CORRECTIONS = "corrections.md";
const UNITS = "- Convert every amount to one unit before comparing.\n";
const SOURCES = "- Name the page each figure came from.\n";
const flow = (name, v = 1) => `${JSON.stringify({ v: 2, name, rev: v })}\n`;
const README = (name, description = `Answers the ${name} question; use when asked`) => readmeOf(name, description);
/** A draft's two files, as a run's merge writes them. */
const draft = (name, { v = 1, readme = README(name) } = {}) => [{ path: `workflows/${name}/README.md`, text: readme }, { path: `workflows/${name}/workflow.json`, text: flow(name, v) }];
const text = (bytes) => Buffer.from(bytes).toString("utf8");
const HEX = /^[0-9a-f]{40}$/;
let wrapped = 0;
/** `store` with some of its calls replaced, under an id of its own (so nothing it reads is another's cache). */
const wrap = (store, over = {}) => ({
  id: `${store.id}#${++wrapped}`,
  head: () => store.head(), read: (...args) => store.read(...args), log: (...args) => store.log(...args), diff: (...args) => store.diff(...args),
  save: (...args) => store.save(...args), remove: () => store.remove(), ...over,
});
/** `store` read as if no commit kept its snapshot: every snapshot rebuilt from the commit's tree and history (the oracle). */
const rebuilt = (store) => wrap(store, { read: async (ref, paths) => (await store.read(ref, paths))?.filter((file) => file.path !== SNAPSHOT_FILE) });
/** Main's files, as the store holds them. */
async function onMain(store) {
  const head = await store.head();
  return head ? await store.read(head) : [];
}
const textOn = async (store, path) => {
  const file = (await onMain(store)).find((one) => one.path === path);
  return file ? text(file.body) : undefined;
};

/** Every key of `value` is one the snapshot (v1) names, and each it requires is there. */
function shaped(snapshot) {
  const keys = (value, required, optional = []) => {
    const extra = Object.keys(value).filter((key) => !required.includes(key) && !optional.includes(key));
    assert.deepEqual(extra, [], `no key the snapshot does not name: ${JSON.stringify(value).slice(0, 200)}`);
    for (const key of required) assert.ok(key in value, `${key} is there: ${JSON.stringify(value).slice(0, 200)}`);
  };
  keys(snapshot, ["v", "main", "at", "workflows", "log", "log_more"], ["corrections", "audits"]);
  assert.equal(snapshot.v, 1);
  assert.match(snapshot.main, HEX);
  if (snapshot.corrections) keys(snapshot.corrections, ["path", "oid", "bytes"]);
  for (const one of snapshot.workflows) {
    keys(one, ["name", "file", "description", "status", "run", "files", "oid", "bytes", "order", "history"], ["links", "retired_from"]);
    // A retired draft's retired_from says what its restore gives back, active or pending; any other draft has none.
    if (one.status === "retired") assert.ok(["active", "pending"].includes(one.retired_from), JSON.stringify(one));
    else assert.equal(one.retired_from, undefined, JSON.stringify(one));
    for (const file of one.files) keys(file, ["path", "oid", "bytes"]);
    keys(one.history, ["at"], ["last", "retire", "person"]);
    for (const change of [one.history.last, one.history.retire, one.history.person].filter(Boolean)) keys(change, ["kind", "by", "at"]);
  }
  for (const change of snapshot.log) {
    keys(change, ["commit", "at", "by", "reason", "files"]);
    assert.match(change.commit, HEX);
  }
}

/** The snapshot main keeps is main's: what a rebuild from its tree and history gives, and its shape v1. */
async function matchesMain(store) {
  forgetBodies();
  const snapshot = await readSnapshot(store);
  shaped(snapshot);
  assert.deepEqual(snapshot, await readSnapshot(rebuilt(store)), "the snapshot the commit kept is the one main gives, rebuilt from its tree");
  // Each body main holds is the blob the snapshot names.
  const files = new Map((await onMain(store)).map((file) => [file.path, file.body]));
  if (snapshot.corrections) assert.equal(blobOid(files.get(CORRECTIONS)), snapshot.corrections.oid);
  for (const { files: named } of snapshot.workflows) for (const { path, oid } of named) assert.equal(blobOid(files.get(path)), oid, path);
  return snapshot;
}

/** The saves `work` makes on `store` (handed a counting stand-in of it). */
async function savesOf(store, work) {
  const ops = [];
  const counted = wrap(store, { save: (save) => { ops.push("save"); return store.save(save); } });
  return { result: await work(counted), ops };
}

/** A person's write as the routes make it: corrections.md replaced whole, or a draft's README.md approved, retired or restored. */
const edited = (corrections) => ({ by: { person: "edited", file: CORRECTIONS }, writes: [{ path: CORRECTIONS, text: corrections }] });
const person = (kind, name, readme) => ({ by: { person: kind, file: `workflows/${name}/README.md`, ...(kind === "approved" ? { approved: true } : {}) }, writes: [{ path: `workflows/${name}/README.md`, text: readme }] });

/**
 * The suite: `make(t)` gives a fresh, empty learning store.
 */
export function folderSuite(backend, make) {
  test(`${backend}: init then a merge lands, one save each, and the snapshot is main's: oids, front matter, history and log`, async (t) => {
    const store = await make(t);
    assert.equal(await readSnapshot(store), undefined, "no snapshot before the store's first commit");
    const init = await savesOf(store, (s) => learningInit(s));
    assert.match(init.result, HEX);
    assert.deepEqual(init.ops, ["save"], "one save");
    const first = await matchesMain(store);
    assert.deepEqual([first.main, first.corrections, first.workflows, first.log, first.log_more], [init.result, undefined, [], [], false]);
    assert.deepEqual((await onMain(store)).map((file) => file.path), [SNAPSHOT_FILE], "the first commit holds the host's snapshot alone");
    assert.equal(await learningInit(store), init.result, "a second init reads main and makes nothing");

    const merge = await savesOf(store, (s) => commitChange(s, first, { by: { run: "run-1", reason: "Compiled the job; the owner's correction." }, writes: [...draft("weekly-report"), { path: CORRECTIONS, text: UNITS }], absent: [CORRECTIONS] }));
    assert.deepEqual(merge.ops, ["save"], "one save");
    assert.equal(merge.result.landed, true);
    const second = await matchesMain(store);
    assert.equal(second.main, merge.result.main);
    assert.deepEqual(merge.result.snapshot, second, "what commitChange hands back is what main keeps");
    assert.deepEqual(second.corrections, { path: CORRECTIONS, oid: blobOid(UNITS), bytes: Buffer.byteLength(UNITS) });
    assert.deepEqual(second.workflows.map((w) => [w.name, w.file, w.description, w.status, w.run, w.files.map((f) => f.path), w.oid, w.order, w.history.last]), [
      ["weekly-report", "workflows/weekly-report/README.md", "Answers the weekly-report question; use when asked", "active", "run-1", ["workflows/weekly-report/README.md", "workflows/weekly-report/workflow.json"], blobOid(README("weekly-report")), 0, { kind: "learned", by: "run", at: second.at }],
    ]);
    assert.deepEqual(second.log.map((c) => [c.commit, c.by, c.reason, c.files]), [[second.main, { run: "run-1" }, "Compiled the job; the owner's correction.", [CORRECTIONS, "workflows/weekly-report/README.md", "workflows/weekly-report/workflow.json"]]]);
    assert.equal(await textOn(store, CORRECTIONS), UNITS);
    assert.equal(await textOn(store, ".agentrun/runs/run-1"), "", "the run's marker, in the same commit");
    const [commit] = await store.log(second.main, { limit: 1 });
    assert.equal(commit.message.trimEnd(), "learning: run-1: merged\n\nCompiled the job; the owner's correction.\n\nRun-Id: run-1");
  });

  test(`${backend}: a stale main writes nothing: main as it was; writeLearning computes again on main as it is`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    const base = await readSnapshot(store);
    const won = await commitChange(store, base, edited(UNITS));
    assert.equal(won.landed, true);
    const lost = await commitChange(store, base, edited(SOURCES));
    assert.deepEqual(lost, { stale: true, main: won.main }, "stale, with main as it is");
    assert.equal(await store.head(), won.main);
    assert.equal(await textOn(store, CORRECTIONS), UNITS);
    const again = await writeLearning(store, async ({ snapshot }) => ({ result: snapshot.main, change: edited(UNITS + SOURCES) }));
    assert.equal(again.result, won.main, "computed on the main that won");
    const after = await matchesMain(store);
    assert.equal(after.corrections.oid, blobOid(UNITS + SOURCES));
  });

  test(`${backend}: a run's merge is found by its marker, and its diff is the store's: its commit, its parent and each file's patch`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    const base = await readSnapshot(store);
    const one = await commitChange(store, base, { by: { run: "run-a", reason: "The owner's correction." }, writes: [{ path: CORRECTIONS, text: UNITS }] });
    const diff = await runMergeOf(store, "run-a");
    assert.deepEqual([diff.v, diff.run, diff.merge, diff.parent], [1, "run-a", one.main, base.main]);
    assert.deepEqual(diff.files, [{ path: CORRECTIONS, status: "added", patch: `@@ -0,0 +1 @@\n+${UNITS.trimEnd()}\n` }], "no host path in it");
    // A second merge appends a line and writes a draft: a modified file's patch, and a patch over the cap withheld.
    const big = [{ path: "workflows/big/README.md", text: README("big") }, { path: "workflows/big/workflow.json", text: `${JSON.stringify({ v: 2, name: "big", note: "word ".repeat(16000) })}\n` }];
    const two = await commitChange(store, await readSnapshot(store), { by: { run: "run-b", reason: "A draft and a second line." }, writes: [{ path: CORRECTIONS, text: UNITS + SOURCES }, ...big] });
    const diff2 = await runMergeOf(store, "run-b");
    assert.deepEqual([diff2.merge, diff2.parent], [two.main, one.main]);
    assert.deepEqual(diff2.files.map((f) => [f.path, f.status, f.withheld ?? null]), [[CORRECTIONS, "modified", null], ["workflows/big/README.md", "added", null], ["workflows/big/workflow.json", "added", "too_large"]]);
    assert.equal(diff2.files[0].patch, `@@ -1 +1,2 @@\n ${UNITS.trimEnd()}\n+${SOURCES.trimEnd()}\n`);
    // A text with quotes, backslashes, tabs and characters past ASCII is carried as it is.
    const odd = "- Odd \"quotes\", a back\\slash,\ta tab, é ü — and more.\n";
    await commitChange(store, await readSnapshot(store), { by: { run: "run-c", reason: "Odd characters." }, writes: [{ path: CORRECTIONS, text: UNITS + SOURCES + odd }] });
    assert.deepEqual((await runMergeOf(store, "run-c")).files, [{ path: CORRECTIONS, status: "modified", patch: `@@ -1,2 +1,3 @@\n ${UNITS.trimEnd()}\n ${SOURCES.trimEnd()}\n+${odd.trimEnd()}\n` }]);
    // A person's write leaves no marker.
    await commitChange(store, await readSnapshot(store), edited(UNITS));
    assert.deepEqual((await onMain(store)).map((f) => f.path).filter((path) => path.startsWith(".agentrun/runs/")).sort(), [".agentrun/runs/run-a", ".agentrun/runs/run-b", ".agentrun/runs/run-c"]);
    assert.equal(await runMergeOf(store, "run-a", 2), undefined, "a round that never merged");
    assert.equal(await runMergeOf(store, "run-never"), undefined, "a run that never merged");
    await matchesMain(store);
  });

  test(`${backend}: a commit whose snapshot is not its own (one saved without the host's) is read past: rebuilt from its tree, and the next write lands over it`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    await commitChange(store, await readSnapshot(store), { by: { run: "run-1", reason: "A draft." }, writes: draft("weekly-report") });
    const old = await readSnapshot(store);
    const hand = await store.save({ old: old.main, message: "by hand", at: Math.floor(Date.now() / 1000), writes: [{ path: CORRECTIONS, text: UNITS }] });
    assert.match(hand.saved, HEX);
    forgetBodies();
    const read = await readSnapshot(store);
    assert.equal(read.main, hand.saved);
    assert.equal(read.corrections.oid, blobOid(UNITS), "the hand's file is read");
    assert.equal(await readLearning(store, ({ snapshot, body }) => body(CORRECTIONS, snapshot.corrections.oid)), UNITS);
    await writeLearning(store, async () => ({ result: null, change: person("retired", "weekly-report", retiredLearned(README("weekly-report"))) }));
    const after = await matchesMain(store);
    assert.equal(after.workflows[0].status, "retired");
    assert.deepEqual(after.log.map((c) => c.by), [{ user: true }, { run: "run-1" }], "the log names the learning's own commits");
    assert.equal((await store.log(after.main))[1].sha, hand.saved, "the hand's commit is main's history");
  });

  test(`${backend}: a person's corrections edit, and a draft's approve, retire and restore, are each one save, and each snapshot is main's`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    const step = async (change, kind) => {
      const { result, ops } = await savesOf(store, async (s) => commitChange(s, await readSnapshot(s), change));
      assert.equal(result.landed, true, kind);
      assert.deepEqual(ops, ["save"], `${kind}: one save`);
      return matchesMain(store);
    };
    let snap = await step(edited(UNITS), "corrections edited");
    assert.deepEqual(snap.log[0].by, { user: true });
    assert.equal(snap.log[0].reason, "edited by a person: corrections.md");
    const HELD = held(README("weekly-report"));
    snap = await step({ by: { run: "run-p", reason: "Held for its owner's OK." }, writes: draft("weekly-report", { readme: HELD }) }, "a merge that holds");
    assert.deepEqual(snap.workflows.map((w) => [w.name, w.status, w.run]), [["weekly-report", "pending", "run-p"]]);
    const approved = released(HELD);
    snap = await step(person("approved", "weekly-report", approved), "approve");
    assert.deepEqual(snap.log[0].by, { user: true, via: "console" });
    assert.deepEqual([snap.workflows[0].status, snap.workflows[0].run, snap.workflows[0].history.last.kind, snap.log[0].files], ["active", "run-p", "approved", ["workflows/weekly-report/README.md"]]);
    const retired = retiredLearned(approved);
    snap = await step(person("retired", "weekly-report", retired), "retire");
    const was = snap.workflows[0];
    assert.deepEqual([was.status, was.retired_from, was.history.retire?.kind, was.history.person?.kind], ["retired", "active", "retired", "retired"]);
    snap = await step(person("restored", "weekly-report", restoredLearned(retired)), "restore");
    assert.equal(snap.workflows[0].status, "active");
    assert.deepEqual(snap.workflows[0].history, { at: snap.at, last: { kind: "restored", by: "person", at: snap.at }, retire: was.history.retire, person: { kind: "restored", by: "person", at: snap.at } });
    assert.deepEqual(snap.log.map((c) => c.reason), ["restored by a person: workflows/weekly-report/README.md", "retired by a person: workflows/weekly-report/README.md", "approved by a person: workflows/weekly-report/README.md", "Held for its owner's OK.", "edited by a person: corrections.md"]);
  });

  test(`${backend}: a precondition the store checks on main refuses the write whole: a path main holds that must be absent, a file changed since a seed`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    const seed = await commitChange(store, await readSnapshot(store), { by: { run: "run-s", reason: "A draft." }, writes: [...draft("weekly-report"), { path: CORRECTIONS, text: UNITS }] });
    const snap = await readSnapshot(store);
    const refused = await commitChange(store, snap, { ...edited(SOURCES), absent: [CORRECTIONS] });
    assert.deepEqual(refused, { refused: { absent: [CORRECTIONS], same: [] } });
    await commitChange(store, snap, person("retired", "weekly-report", retiredLearned(README("weekly-report"))));
    const after = await readSnapshot(store);
    const moved = await commitChange(store, after, { by: { run: "run-t", reason: "A newer draft." }, writes: draft("weekly-report", { v: 2 }), same: [{ commit: seed.main, path: "workflows/weekly-report/README.md" }] });
    assert.deepEqual(moved, { refused: { absent: [], same: ["workflows/weekly-report/README.md"] } });
    assert.equal(await store.head(), after.main, "nothing written");
    assert.equal(await runMergeOf(store, "run-t"), undefined, "no merge of it");
  });

  test(`${backend}: a body is read at the snapshot's commit and checked against its oid: one that is not is an error, and no read saves`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    await commitChange(store, await readSnapshot(store), edited(UNITS));
    const noSave = { save: () => assert.fail("a read never saves"), remove: () => assert.fail("a read never removes") };
    forgetBodies();
    assert.equal(await readLearning(wrap(store, noSave), ({ snapshot, body }) => body(CORRECTIONS, snapshot.corrections.oid)), UNITS);
    // A store that answers other bytes for it.
    forgetBodies();
    const wrong = wrap(store, { ...noSave, read: async (ref, paths) => (await store.read(ref, paths))?.map((file) => (file.path === CORRECTIONS ? { ...file, body: Buffer.from(SOURCES) } : file)) });
    await assert.rejects(readLearning(wrong, ({ snapshot, body }) => body(CORRECTIONS, snapshot.corrections.oid)), /holds no corrections\.md as its snapshot names it/);
  });

  test(`${backend}: nextSnapshot and a rebuild from main agree over a longer history: a log past LOG_KEEP says older exist`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    for (let i = 0; i < 6; i++) await commitChange(store, await readSnapshot(store), { by: { run: `run-${i}`, reason: `Draft ${i}.` }, writes: draft(`w${i}`) });
    const snap = await matchesMain(store);
    assert.deepEqual(snap.workflows.map((w) => [w.name, w.order]), [["w0", 5], ["w1", 4], ["w2", 3], ["w3", 2], ["w4", 1], ["w5", 0]]);
    // The log keeps LOG_KEEP: shown on a synthetic snapshot, the shape a commit keeps.
    let synthetic = snap;
    for (let i = 0; i < LOG_KEEP; i++) synthetic = { ...nextSnapshot(synthetic, edited(`- edit ${i}\n`), 1_800_000_000 + i).snapshot, main: snap.main };
    assert.deepEqual([synthetic.log.length, synthetic.log_more], [LOG_KEEP, true]);
  });

  test(`${backend}: learningCommit: a run's merge (a held draft and its owner's correction) is one save past the first commit, and idempotent; a store that fails is unavailable`, async (t) => {
    const store = await make(t);
    // A store with no main: made in the same call.
    const merge = { runId: "run-c1", reason: "Compiled; held for its owner's OK.", files: draft("weekly-report"), held: ["workflows/weekly-report/README.md"], correction: "Convert  every amount\tto one unit before comparing." };
    const merged = await savesOf(store, (s) => learningCommit(s, merge));
    assert.equal(merged.result.ok, true, JSON.stringify(merged.result));
    assert.deepEqual(merged.ops, ["save", "save"], "the first commit, then the merge");
    assert.equal(merged.result.main, merged.result.commit);
    assert.deepEqual(merged.result.files, [CORRECTIONS, "workflows/weekly-report/README.md", "workflows/weekly-report/workflow.json"]);
    const snap = await matchesMain(store);
    assert.deepEqual(snap.workflows.map((w) => [w.name, w.status]), [["weekly-report", "pending"]]);
    assert.equal(await textOn(store, CORRECTIONS), UNITS, "one line, its whitespace folded");
    assert.equal((await runMergeOf(store, "run-c1")).merge, merged.result.main);
    const again = await savesOf(store, (s) => learningCommit(s, merge));
    // The run's merge on main already (a retry after a crash): its commit, said `already`, and nothing written again.
    assert.deepEqual([again.result, again.ops], [{ ok: true, main: snap.main, commit: snap.main, files: merged.result.files, already: true }, []], "merged once: nothing written again");
    // The store failing under the save: unavailable, retryable later.
    const broken = wrap(store, { save: async () => { throw new Error("the store is gone"); } });
    const down = await learningCommit(broken, { runId: "run-c2", reason: "x", files: [], correction: "Be brief." });
    assert.deepEqual([down.ok, down.reason], [false, "unavailable"]);
    assert.match(down.error, /the store is gone/);
  });

  test(`${backend}: learningCommit: two calls for one run and round racing (a reclaimed run) land its correction once; the second, computed before the first saved, reads the first's merge`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    await commitChange(store, await readSnapshot(store), edited(UNITS));
    // Both calls compute their save before either saves; then the first saves whole before the second.
    let waiting = 0;
    let both;
    const barrier = new Promise((resolve) => { both = resolve; });
    let first;
    const gated = wrap(store, {
      save: async (save) => {
        if (++waiting === 2) both();
        if (waiting <= 2) await barrier;
        if (!first) {
          first = store.save(save);
          return first;
        }
        await first.catch(() => {});
        return store.save(save);
      },
    });
    const change = { runId: "run-race", round: 2, reason: "the owner's correction", files: [], correction: "Name the page each figure came from." };
    const [one, two] = await Promise.all([learningCommit(gated, change), learningCommit(gated, change)]);
    assert.ok(waiting >= 2, "both calls computed a save before either saved");
    assert.deepEqual([one.ok, two.ok], [true, true], JSON.stringify([one, two]));
    assert.equal(await textOn(store, CORRECTIONS), `${UNITS}${SOURCES}`, "the correction landed once");
    const diff = await runMergeOf(store, "run-race", 2);
    const [landed, read] = one.already ? [two, one] : [one, two];
    assert.equal(diff.merge, landed.commit, "the round's merge is the one that landed");
    assert.deepEqual(read, { ok: true, main: landed.main, commit: landed.commit, files: [CORRECTIONS], already: true }, "the second call reads the first's merge");
    assert.equal((await readSnapshot(store)).log.filter((change) => change.by.run === "run-race").length, 1, "one merge on main");
    await matchesMain(store);
  });

  test(`${backend}: the store merges a run (its round) once, in the save's compare and swap: a second merge of it writes nothing and names the first`, async (t) => {
    const store = await make(t);
    await learningInit(store);
    const first = await commitChange(store, await readSnapshot(store), { by: { run: "run-once", reason: "First." }, writes: [{ path: CORRECTIONS, text: UNITS }] });
    assert.equal(first.landed, true, JSON.stringify(first));
    const before = await readSnapshot(store);
    const again = await savesOf(store, async (s) => commitChange(s, before, { by: { run: "run-once", reason: "Again." }, writes: [{ path: CORRECTIONS, text: `${UNITS}${UNITS}` }] }));
    assert.deepEqual([again.result, again.ops], [{ merged: first.main }, ["save"]], "the store refused it, its first merge named");
    assert.equal(await store.head(), first.main, "nothing written");
    // Another round of the run is its own merge.
    const round = await commitChange(store, before, { by: { run: "run-once", reason: "Round two.", round: 2 }, writes: [{ path: CORRECTIONS, text: `${UNITS}${SOURCES}` }] });
    assert.equal(round.landed, true, JSON.stringify(round));
    assert.equal((await runMergeOf(store, "run-once", 2)).merge, round.main);
    await matchesMain(store);
  });

  test(`${backend}: learningCommit maps the store's preconditions: a draft's file changed on main since the run's seed is a conflict; a write past what one save carries is refused before any save`, async (t) => {
    const store = await make(t);
    const seeded = await learningCommit(store, { runId: "run-s1", reason: "A draft.", files: draft("weekly-report") });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const seed = seeded.main;
    const retired = await commitChange(store, await readSnapshot(store), person("retired", "weekly-report", retiredLearned(README("weekly-report"))));
    assert.equal(retired.landed, true, JSON.stringify(retired));
    const before = await store.head();
    const stale = await savesOf(store, (s) => learningCommit(s, { runId: "run-s2", reason: "A newer draft.", files: draft("weekly-report", { v: 2 }), seed }));
    assert.deepEqual(stale.result, { ok: false, reason: "conflict", problems: [{ rule: "kept", path: "workflows/weekly-report/README.md", detail: "workflows/weekly-report/README.md changed on main after the run started" }] });
    assert.deepEqual(stale.ops, ["save"], "the store checked it on main: one save, refused");
    assert.equal(await store.head(), before, "nothing written");
    const big = await savesOf(store, (s) => learningCommit(s, { runId: "run-big", reason: "Too much.", files: [{ path: "workflows/huge/README.md", text: README("huge") }, { path: "workflows/huge/workflow.json", text: "x".repeat(WRITE_MAX) }] }));
    assert.deepEqual([big.result.ok, big.result.reason, big.result.problems?.map((p) => p.rule)], [false, "refused", ["too_large"]]);
    assert.match(big.result.problems[0].detail, new RegExp(`one write to the agent's learning takes at most ${WRITE_MAX}`));
    assert.deepEqual(big.ops, [], "refused before any save");
    assert.equal(await store.head(), before);
    await assert.rejects(commitChange(store, await readSnapshot(store), edited("x".repeat(WRITE_MAX))), FolderTooLarge);
  });

  test(`${backend}: a draft or a correction alone that must find a commit the store no longer holds (its learning reset since) is a conflict that says so, and nothing lands on the new history; a correction whose seed this store never held and that names none to find lands`, async (t) => {
    const store = await make(t);
    const seeded = await learningCommit(store, { runId: "run-r1", reason: "A draft.", files: draft("weekly-report") });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const seed = seeded.main;
    // The reset (learn/delete.ts): the store removed, every commit with it, and again (idempotent); the next write starts anew.
    await store.remove();
    assert.equal(await store.head(), null);
    await store.remove();
    const fresh = await learningCommit(store, { runId: "run-r2", reason: "After the reset.", files: draft("daily-report") });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    const before = await store.head();
    const stale = await learningCommit(store, { runId: "run-r3", reason: "Drafted on the old history.", files: draft("monthly-report"), seed, mustHold: seed });
    assert.deepEqual([stale.ok, stale.reason, stale.problems?.length], [false, "conflict", 1], JSON.stringify(stale));
    assert.match(stale.problems[0].detail, /learning was reset after the run started/);
    assert.equal(await store.head(), before, "nothing written");
    // A correction alone has no file a `same` covers: the commit it must find is the wall.
    const line = await learningCommit(store, { runId: "run-r4", reason: "Its owner's correction.", files: [], correction: "Retry more slowly next time.", seed, mustHold: seed });
    assert.deepEqual([line.ok, line.reason], [false, "conflict"], JSON.stringify(line));
    assert.match(line.problems[0].detail, /learning was reset after the run started/);
    assert.equal(await store.head(), before, "nothing written");
    assert.equal(await textOn(store, CORRECTIONS), undefined, "no corrections line on the new history");
    // A run whose seed names nothing to find: its correction lands.
    const other = await learningCommit(store, { runId: "run-r5", reason: "Its owner's correction.", files: [], correction: "Retry more slowly next time.", seed });
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.equal(await textOn(store, CORRECTIONS), "- Retry more slowly next time.\n", "its corrections line is on main");
  });
}
