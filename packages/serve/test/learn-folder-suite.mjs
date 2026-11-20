// The learning folder's script (src/learn/learning.sh, through learn/folder.ts), with the SAME assertions over every
// Workspace backend: learn-folder-local.test.mjs runs them on a local folder, learn-folder-archil.test.mjs on the fake
// Archil disk. Every check reads the folder through the workspace alone (its file API, and the script's own `read` for
// what git holds), so a backend that is not a folder of this machine is checked the same way. What the folder holds:
// corrections.md and the learned workflow drafts, each workflows/<name>/README.md and workflow.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blobOid, DIFFS_DIR, FolderBusy, STDIN_MAX, folderTestHooks, forgetBodies, commitChange, learningInit, learningRepair, nextSnapshot, parseRead,
  readLearning, readRunDiff, readSnapshot, runMergeOf, SCRIPT_FILE, SNAPSHOT_FILE, snapshotOfRead, writeLearning,
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
/** `ws` with some of its calls replaced: every call of the port, bound to `ws`. */
const wrap = (ws, over = {}) => ({
  read: (...args) => ws.read(...args), write: (...args) => ws.write(...args), append: (...args) => ws.append(...args), list: (...args) => ws.list(...args),
  mkdir: (...args) => ws.mkdir(...args), grep: (...args) => ws.grep(...args), remove: (...args) => ws.remove(...args), exec: (...args) => ws.exec(...args),
  process: ws.process, mountSpec: () => ws.mountSpec(), attach: (...args) => ws.attach(...args), ...over,
});

/** What git holds on main, as the script's `read` shows it (the oracle: git's own tree, log and blobs). */
async function gitMain(ws) {
  const result = await ws.exec(["sh", SCRIPT_FILE, "read"], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  return parseRead(result.stdout);
}

/** Every key of `value` is one the snapshot (v1) names, and each it requires is there. */
function shaped(snapshot) {
  const keys = (value, required, optional = []) => {
    const extra = Object.keys(value).filter((key) => !required.includes(key) && !optional.includes(key));
    assert.deepEqual(extra, [], `no key the snapshot does not name: ${JSON.stringify(value).slice(0, 200)}`);
    for (const key of required) assert.ok(key in value, `${key} is there: ${JSON.stringify(value).slice(0, 200)}`);
  };
  keys(snapshot, ["v", "main", "at", "workflows", "log", "log_more"], ["corrections"]);
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

/** The snapshot on the folder is main's: what a rebuild from git's own tree, log and blobs gives, and its shape v1. */
async function matchesMain(ws) {
  const snapshot = await readSnapshot(ws);
  shaped(snapshot);
  const fromGit = snapshotOfRead(await gitMain(ws));
  assert.deepEqual(snapshot, fromGit, "the snapshot the commit wrote is the one main gives, rebuilt from git");
  // Each body the working tree holds is the blob the snapshot names.
  if (snapshot.corrections) assert.equal(blobOid(await ws.read(CORRECTIONS)), snapshot.corrections.oid);
  for (const { files } of snapshot.workflows) for (const { path, oid } of files) assert.equal(blobOid(await ws.read(path)), oid, path);
  return snapshot;
}

/** The folder's execs while `work` runs: each exec's op. */
async function execsOf(work) {
  const ops = [];
  folderTestHooks.exec = (argv) => ops.push(argv[2]);
  try {
    return { result: await work(), ops };
  } finally {
    folderTestHooks.exec = undefined;
  }
}

/** A person's write as the routes make it: corrections.md replaced whole, or a draft's README.md approved, retired or restored. */
const edited = (corrections) => ({ by: { person: "edited", file: CORRECTIONS }, writes: [{ path: CORRECTIONS, text: corrections }] });
const person = (kind, name, readme) => ({ by: { person: kind, file: `workflows/${name}/README.md`, ...(kind === "approved" ? { approved: true } : {}) }, writes: [{ path: `workflows/${name}/README.md`, text: readme }] });

/**
 * The suite: `make()` gives a fresh, empty learning folder's Workspace (`{ ws }`).
 */
export function folderSuite(backend, make) {
  test(`${backend}: init then a merge lands, one exec each, and the snapshot is main's: oids, front matter, history and log`, async () => {
    const { ws } = await make();
    assert.equal(await readSnapshot(ws), undefined, "no snapshot before the folder's first commit");
    const init = await execsOf(() => learningInit(ws));
    assert.match(init.result, HEX);
    assert.deepEqual(init.ops, ["init"], "one exec");
    const first = await matchesMain(ws);
    assert.deepEqual([first.main, first.corrections, first.workflows, first.log, first.log_more], [init.result, undefined, [], [], false]);
    assert.equal(await learningInit(ws), init.result, "a second init reads the snapshot and makes nothing");

    const merge = await execsOf(() => commitChange(ws, first, { by: { run: "run-1", reason: "Compiled the job; the owner's correction." }, writes: [...draft("weekly-report"), { path: CORRECTIONS, text: UNITS }], absent: [CORRECTIONS] }));
    assert.deepEqual(merge.ops, ["commit"], "one exec");
    assert.equal(merge.result.landed, true);
    const second = await matchesMain(ws);
    assert.equal(second.main, merge.result.main);
    assert.deepEqual(merge.result.snapshot, second, "what commitChange hands back is what the script wrote");
    assert.deepEqual(second.corrections, { path: CORRECTIONS, oid: blobOid(UNITS), bytes: Buffer.byteLength(UNITS) });
    assert.deepEqual(second.workflows.map((w) => [w.name, w.file, w.description, w.status, w.run, w.files.map((f) => f.path), w.oid, w.order, w.history.last]), [
      ["weekly-report", "workflows/weekly-report/README.md", "Answers the weekly-report question; use when asked", "active", "run-1", ["workflows/weekly-report/README.md", "workflows/weekly-report/workflow.json"], blobOid(README("weekly-report")), 0, { kind: "learned", by: "run", at: second.at }],
    ]);
    assert.deepEqual(second.log.map((c) => [c.commit, c.by, c.reason, c.files]), [[second.main, { run: "run-1" }, "Compiled the job; the owner's correction.", [CORRECTIONS, "workflows/weekly-report/README.md", "workflows/weekly-report/workflow.json"]]]);
    assert.equal(text(await ws.read(CORRECTIONS)), UNITS);
  });

  test(`${backend}: a stale main exits 3 and writes nothing: main, the snapshot and the working tree as they were`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const base = await readSnapshot(ws);
    const won = await commitChange(ws, base, edited(UNITS));
    assert.equal(won.landed, true);
    const before = { snapshot: text(await ws.read(SNAPSHOT_FILE)), main: (await gitMain(ws)).main, list: (await ws.list("")).map((e) => e.name), corrections: text(await ws.read(CORRECTIONS)) };
    const lost = await commitChange(ws, base, edited(SOURCES));
    assert.deepEqual(lost, { stale: true, main: won.main }, "exit 3, with main as it is");
    assert.deepEqual({ snapshot: text(await ws.read(SNAPSHOT_FILE)), main: (await gitMain(ws)).main, list: (await ws.list("")).map((e) => e.name), corrections: text(await ws.read(CORRECTIONS)) }, before);
    // writeLearning computes it again on main as it is, and lands.
    const again = await writeLearning(ws, async ({ snapshot }) => ({ result: snapshot.main, change: edited(UNITS + SOURCES) }));
    assert.equal(again.result, won.main, "computed on the main that won");
    const after = await matchesMain(ws);
    assert.equal(after.corrections.oid, blobOid(UNITS + SOURCES));
  });

  test(`${backend}: a merge writes .agentrun/diffs/<run>.json: its commit, its parent and each file's patch as git diffs it`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const base = await readSnapshot(ws);
    const one = await commitChange(ws, base, { by: { run: "run-a", reason: "The owner's correction." }, writes: [{ path: CORRECTIONS, text: UNITS }] });
    const diff = await readRunDiff(ws, "run-a");
    assert.deepEqual([diff.v, diff.run, diff.merge, diff.parent], [1, "run-a", one.main, base.main]);
    assert.deepEqual(diff.files, [{ path: CORRECTIONS, status: "added", patch: `@@ -0,0 +1 @@\n+${UNITS.trimEnd()}\n` }]);
    // A second merge appends a line and writes a draft: a modified file's patch, and a patch over the cap withheld.
    const second = await readSnapshot(ws);
    const big = [{ path: "workflows/big/README.md", text: README("big") }, { path: "workflows/big/workflow.json", text: `${JSON.stringify({ v: 2, name: "big", note: "word ".repeat(16000) })}\n` }];
    const two = await commitChange(ws, second, { by: { run: "run-b", reason: "A draft and a second line." }, writes: [{ path: CORRECTIONS, text: UNITS + SOURCES }, ...big] });
    const diff2 = await readRunDiff(ws, "run-b");
    assert.deepEqual([diff2.merge, diff2.parent], [two.main, one.main]);
    assert.deepEqual(diff2.files.map((f) => [f.path, f.status, f.withheld ?? null]), [[CORRECTIONS, "modified", null], ["workflows/big/README.md", "added", null], ["workflows/big/workflow.json", "added", "too_large"]]);
    assert.equal(diff2.files[0].patch, `@@ -1 +1,2 @@\n ${UNITS.trimEnd()}\n+${SOURCES.trimEnd()}\n`);
    // A text with quotes, backslashes, tabs and characters past ASCII is carried as JSON writes it.
    const third = await readSnapshot(ws);
    const odd = "- Odd \"quotes\", a back\\slash,\ta tab, é ü — and more.\n";
    await commitChange(ws, third, { by: { run: "run-c", reason: "Odd characters." }, writes: [{ path: CORRECTIONS, text: UNITS + SOURCES + odd }] });
    assert.deepEqual((await readRunDiff(ws, "run-c")).files, [{ path: CORRECTIONS, status: "modified", patch: `@@ -1,2 +1,3 @@\n ${UNITS.trimEnd()}\n ${SOURCES.trimEnd()}\n+${odd.trimEnd()}\n` }]);
    // A person's write keeps no diff file.
    await commitChange(ws, await readSnapshot(ws), edited(UNITS));
    assert.deepEqual((await ws.list(DIFFS_DIR)).map((e) => e.name), ["run-a.json", "run-b.json", "run-c.json"]);
    await matchesMain(ws);
  });

  test(`${backend}: snapshot.json is written last: a failure after the files leaves the old snapshot, a reader sees the old snapshot with newer bodies (503 on what changed), and the next write rebuilds it from main`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    await commitChange(ws, await readSnapshot(ws), { by: { run: "run-1", reason: "A draft." }, writes: draft("weekly-report") });
    await commitChange(ws, await readSnapshot(ws), edited(UNITS));
    const old = await readSnapshot(ws);
    const oldBytes = text(await ws.read(SNAPSHOT_FILE));
    folderTestHooks.env = { AGENTRUN_LEARNING_FAIL: "before-snapshot" };
    try {
      await assert.rejects(commitChange(ws, old, { by: { run: "run-x", reason: "Appended." }, writes: [{ path: CORRECTIONS, text: UNITS + SOURCES }] }), /before the snapshot/);
    } finally {
      folderTestHooks.env = undefined;
    }
    const moved = (await gitMain(ws)).main;
    assert.notEqual(moved, old.main, "the commit landed: main moved");
    assert.equal(text(await ws.read(SNAPSHOT_FILE)), oldBytes, "the old snapshot, untouched");
    assert.equal(text(await ws.read(CORRECTIONS)), UNITS + SOURCES, "the files were brought in line before the snapshot");
    assert.equal((await readRunDiff(ws, "run-x")).merge, moved, "the diff was written before the snapshot");
    // A reader: an unchanged body reads; the changed one is not the old snapshot's blob, twice: FolderBusy (503).
    forgetBodies();
    const readmeFile = old.workflows[0].file;
    assert.equal(await readLearning(ws, ({ snapshot, body }) => body(readmeFile, snapshot.workflows[0].oid)), README("weekly-report"));
    await assert.rejects(readLearning(ws, ({ snapshot, body }) => body(CORRECTIONS, snapshot.corrections.oid)), FolderBusy);
    // The next write finds main moved under its snapshot (exit 3 naming a main the snapshot is not): rebuilt, then lands.
    const ops = [];
    folderTestHooks.exec = (argv) => ops.push(argv[2]);
    try {
      await writeLearning(ws, async () => ({ result: null, change: person("retired", "weekly-report", retiredLearned(README("weekly-report"))) }));
    } finally {
      folderTestHooks.exec = undefined;
    }
    assert.deepEqual(ops, ["commit", "read", "snapshot", "commit"], "stale, rebuilt from main, computed again");
    const after = await matchesMain(ws);
    assert.equal(after.workflows[0].status, "retired");
    assert.equal(after.log[1].commit, moved, "the stopped merge is in the log the rebuild read");
  });

  test(`${backend}: a person's corrections edit, and a draft's approve, retire and restore, are each one exec, and each snapshot is main's`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const step = async (change, kind) => {
      const { result, ops } = await execsOf(async () => commitChange(ws, await readSnapshot(ws), change));
      assert.equal(result.landed, true, kind);
      assert.deepEqual(ops, ["commit"], `${kind}: one exec`);
      return matchesMain(ws);
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

  test(`${backend}: a precondition the script checks on main refuses the write whole (exit 4): a path main holds that must be absent, a file changed since a seed`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const seed = await commitChange(ws, await readSnapshot(ws), { by: { run: "run-s", reason: "A draft." }, writes: [...draft("weekly-report"), { path: CORRECTIONS, text: UNITS }] });
    const snap = await readSnapshot(ws);
    const refused = await commitChange(ws, snap, { ...edited(SOURCES), absent: [CORRECTIONS] });
    assert.deepEqual(refused, { refused: { absent: [CORRECTIONS], same: [] } });
    await commitChange(ws, snap, person("retired", "weekly-report", retiredLearned(README("weekly-report"))));
    const after = await readSnapshot(ws);
    const moved = await commitChange(ws, after, { by: { run: "run-t", reason: "A newer draft." }, writes: draft("weekly-report", { v: 2 }), same: [{ commit: seed.main, path: "workflows/weekly-report/README.md" }] });
    assert.deepEqual(moved, { refused: { absent: [], same: ["workflows/weekly-report/README.md"] } });
    assert.equal((await readSnapshot(ws)).main, after.main, "nothing written");
    await assert.rejects(ws.read(`${DIFFS_DIR}/run-t.json`), (error) => error.code === "NOT_FOUND");
  });

  test(`${backend}: a body is checked against its oid: a mismatch reads the snapshot again and tries once more, a second is FolderBusy; the reads use the file API alone`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    await commitChange(ws, await readSnapshot(ws), edited(UNITS));
    const snap = await readSnapshot(ws);
    const oid = snap.corrections.oid;
    // A body that is wrong once (a write in flight), then right: one retry, read whole.
    let reads = 0;
    let snapshots = 0;
    forgetBodies();
    const flaky = wrap(ws, {
      read: async (path, range) => {
        if (path === SNAPSHOT_FILE) snapshots++;
        if (path === CORRECTIONS && reads++ === 0) return Buffer.from("half a line");
        return ws.read(path, range);
      },
      exec: () => assert.fail("a read never execs"),
    });
    assert.equal(await readLearning(flaky, ({ snapshot, body }) => body(CORRECTIONS, snapshot.corrections.oid)), UNITS);
    assert.deepEqual([reads, snapshots], [2, 2], "the snapshot read again, the body once more");
    // A body that stays wrong: FolderBusy.
    forgetBodies();
    const wrong = wrap(ws, { read: async (path, range) => (path === CORRECTIONS ? Buffer.from(SOURCES) : ws.read(path, range)), exec: () => assert.fail("a read never execs") });
    await assert.rejects(readLearning(wrong, ({ body }) => body(CORRECTIONS, oid)), FolderBusy);
    // A body that is gone: the same.
    const gone = wrap(ws, { read: async (path, range) => (path === CORRECTIONS ? ws.read("no-such-file.md") : ws.read(path, range)), exec: () => assert.fail("a read never execs") });
    await assert.rejects(readLearning(gone, ({ body }) => body(CORRECTIONS, oid)), FolderBusy);
  });

  test(`${backend}: nextSnapshot and a rebuild from main agree over a longer history: a log past LOG_KEEP says older exist`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    for (let i = 0; i < 6; i++) await commitChange(ws, await readSnapshot(ws), { by: { run: `run-${i}`, reason: `Draft ${i}.` }, writes: draft(`w${i}`) });
    const snap = await matchesMain(ws);
    assert.deepEqual(snap.workflows.map((w) => [w.name, w.order]), [["w0", 5], ["w1", 4], ["w2", 3], ["w3", 2], ["w4", 1], ["w5", 0]]);
    // The log keeps LOG_KEEP: shown on a synthetic snapshot, the shape the script writes.
    let synthetic = snap;
    for (let i = 0; i < 200; i++) synthetic = { ...nextSnapshot(synthetic, edited(`- edit ${i}\n`), 1_800_000_000 + i).snapshot, main: snap.main };
    assert.deepEqual([synthetic.log.length, synthetic.log_more], [200, true]);
  });

  test(`${backend}: the script is written once per version, as .agentrun/learning-<sha8>.sh`, async () => {
    const { ws } = await make();
    let writes = 0;
    const counted = wrap(ws, { write: async (path, data) => { if (path === SCRIPT_FILE) writes++; return ws.write(path, data); } });
    await learningInit(counted);
    await commitChange(counted, await readSnapshot(counted), edited(UNITS));
    assert.match(SCRIPT_FILE, /^\.agentrun\/learning-[0-9a-f]{8}\.sh$/);
    assert.equal(writes, 1, "written once, then found");
    await learningRepair(counted);
    assert.equal(writes, 1);
  });

  test(`${backend}: learningCommit: a run's merge (a held draft and its owner's correction) is one exec and idempotent; a failing exec is unavailable`, async () => {
    const { ws } = await make();
    // A folder with no main: made in the same call.
    const merge = { runId: "run-c1", reason: "Compiled; held for its owner's OK.", files: draft("weekly-report"), held: ["workflows/weekly-report/README.md"], correction: "Convert  every amount\tto one unit before comparing." };
    const merged = await execsOf(() => learningCommit(ws, merge));
    assert.equal(merged.result.ok, true, JSON.stringify(merged.result));
    assert.deepEqual(merged.ops, ["init", "commit"]);
    assert.equal(merged.result.main, merged.result.commit);
    assert.deepEqual(merged.result.files, [CORRECTIONS, "workflows/weekly-report/README.md", "workflows/weekly-report/workflow.json"]);
    const snap = await matchesMain(ws);
    assert.deepEqual(snap.workflows.map((w) => [w.name, w.status]), [["weekly-report", "pending"]]);
    assert.equal(text(await ws.read(CORRECTIONS)), UNITS, "one line, its whitespace folded");
    assert.equal((await readRunDiff(ws, "run-c1")).merge, merged.result.main);
    const again = await execsOf(() => learningCommit(ws, merge));
    // The run's merge on main already (a retry after a crash): its commit, said `already`, and nothing written again.
    assert.deepEqual([again.result, again.ops], [{ ok: true, main: snap.main, commit: snap.main, files: merged.result.files, already: true }, []], "merged once: nothing written again");
    // The workspace failing under the exec: unavailable, retryable later.
    const broken = wrap(ws, { exec: async () => { throw Object.assign(new Error("the disk is gone"), { name: "WorkspaceError", code: "UNAVAILABLE" }); } });
    const down = await learningCommit(broken, { runId: "run-c2", reason: "x", files: [], correction: "Be brief." });
    assert.deepEqual([down.ok, down.reason], [false, "unavailable"]);
    assert.match(down.error, /the disk is gone/);
  });

  test(`${backend}: learningCommit: two calls for one run and round racing (a reclaimed run) land its correction once; the second, past the diff check before the first committed, reads the first's diff`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    await commitChange(ws, await readSnapshot(ws), edited(UNITS));
    // Both calls read the run's diff file (none yet) before either commits; then the first call's exec runs whole before
    // the second's, which finds main moved and computes again on the main the first one made.
    const KEY = `${DIFFS_DIR}/run-race.r2.json`;
    let looked = 0;
    let bothLooked;
    const barrier = new Promise((resolve) => { bothLooked = resolve; });
    let first;
    const gated = wrap(ws, {
      read: async (path, ...rest) => {
        if (path === KEY && looked < 2) {
          looked += 1;
          if (looked === 2) bothLooked();
          await barrier;
        }
        return ws.read(path, ...rest);
      },
      exec: async (argv, ...rest) => {
        if (argv[2] !== "commit") return ws.exec(argv, ...rest);
        if (!first) {
          first = ws.exec(argv, ...rest);
          return first;
        }
        await first.catch(() => {});
        return ws.exec(argv, ...rest);
      },
    });
    const change = { runId: "run-race", round: 2, reason: "the owner's correction", files: [], correction: "Name the page each figure came from." };
    const [one, two] = await Promise.all([learningCommit(gated, change), learningCommit(gated, change)]);
    assert.equal(looked, 2, "both calls passed the diff check before either committed");
    assert.deepEqual([one.ok, two.ok], [true, true], JSON.stringify([one, two]));
    assert.equal(text(await ws.read(CORRECTIONS)), `${UNITS}${SOURCES}`, "the correction landed once");
    const diff = await readRunDiff(ws, "run-race.r2");
    const [landed, read] = one.already ? [two, one] : [one, two];
    assert.equal(diff.merge, landed.commit, "the round's diff is the merge that landed, never replaced");
    assert.deepEqual(read, { ok: true, main: landed.main, commit: landed.commit, files: [CORRECTIONS], already: true }, "the second call reads the first's diff");
    assert.equal((await readSnapshot(ws)).log.filter((change) => change.by.run === "run-race").length, 1, "one merge on main");
    await matchesMain(ws);
  });

  test(`${backend}: the script merges a run (its round) once, in the same ref transaction as main's compare and swap: a second merge of it on main as it is now writes nothing and names the first`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const first = await commitChange(ws, await readSnapshot(ws), { by: { run: "run-once", reason: "First." }, writes: [{ path: CORRECTIONS, text: UNITS }] });
    assert.equal(first.landed, true, JSON.stringify(first));
    const before = await readSnapshot(ws);
    const again = await execsOf(() => commitChange(ws, before, { by: { run: "run-once", reason: "Again." }, writes: [{ path: CORRECTIONS, text: `${UNITS}${UNITS}` }] }));
    assert.deepEqual([again.result, again.ops], [{ merged: first.main }, ["commit"]], "the script refused it: exit 6, its first merge named");
    assert.equal(snapshotOfRead(await gitMain(ws)).main, first.main, "main as git holds it, as it was");
    assert.deepEqual(await readSnapshot(ws), before, "nothing written");
    // Another round of the run is its own merge.
    const round = await commitChange(ws, before, { by: { run: "run-once", reason: "Round two.", round: 2 }, writes: [{ path: CORRECTIONS, text: `${UNITS}${SOURCES}` }] });
    assert.equal(round.landed, true, JSON.stringify(round));
    await matchesMain(ws);
  });

  test(`${backend}: a stop between a run's merge and its diff file (main and the run's ref moved, no diff): the merge is read back with its diff rebuilt from the run's ref, and merging the round again names it with its files`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const cut = async (runId) => {
      const old = await readSnapshot(ws);
      folderTestHooks.env = { AGENTRUN_LEARNING_FAIL: "before-diff" };
      try {
        await assert.rejects(commitChange(ws, old, { by: { run: runId, reason: "Cut." }, writes: draft(runId) }), /before the diff/);
      } finally {
        folderTestHooks.env = undefined;
      }
      const moved = (await gitMain(ws)).main;
      assert.notEqual(moved, old.main, "the commit landed: main moved");
      assert.equal(await readRunDiff(ws, runId), undefined, "no diff file");
      return { old, moved };
    };
    // Read back once the snapshot is main's again (a later write or a read rebuilt it): the learning end's own read.
    const first = await cut("run-cut");
    await learningRepair(ws);
    const back = await runMergeOf(ws, "run-cut");
    assert.deepEqual([back?.merge, back?.parent, back?.files.map((f) => [f.path, f.status])], [first.moved, first.old.main, [["workflows/run-cut/README.md", "added"], ["workflows/run-cut/workflow.json", "added"]]]);
    assert.deepEqual(await readRunDiff(ws, "run-cut"), back, "the rebuilt diff is kept");
    assert.equal(await runMergeOf(ws, "run-cut", 2), undefined, "a round that never merged");
    assert.equal(await runMergeOf(ws, "run-never"), undefined, "a run that never merged");
    // Merged again (a reclaimed run's compile drafted again) before any rebuild, the old snapshot still in place: the
    // script names the first merge and writes its diff.
    const second = await cut("run-cut2");
    const again = await learningCommit(ws, { runId: "run-cut2", reason: "Cut.", files: draft("run-cut2", { v: 2 }) });
    assert.deepEqual([again.ok, again.already, again.commit, again.files], [true, true, second.moved, ["workflows/run-cut2/README.md", "workflows/run-cut2/workflow.json"]], JSON.stringify(again));
    assert.equal((await readRunDiff(ws, "run-cut2"))?.parent, second.old.main);
    await matchesMain(ws);
  });

  test(`${backend}: learningCommit maps the script's preconditions: a draft's file changed on main since the run's seed is a conflict; a write past what one exec carries is refused before any exec`, async () => {
    const { ws } = await make();
    const seeded = await learningCommit(ws, { runId: "run-s1", reason: "A draft.", files: draft("weekly-report") });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const seed = seeded.main;
    const retired = await commitChange(ws, await readSnapshot(ws), person("retired", "weekly-report", retiredLearned(README("weekly-report"))));
    assert.equal(retired.landed, true, JSON.stringify(retired));
    const before = await readSnapshot(ws);
    const stale = await execsOf(() => learningCommit(ws, { runId: "run-s2", reason: "A newer draft.", files: draft("weekly-report", { v: 2 }), seed }));
    assert.deepEqual(stale.result, { ok: false, reason: "conflict", problems: [{ rule: "kept", path: "workflows/weekly-report/README.md", detail: "workflows/weekly-report/README.md changed on main after the run started" }] });
    assert.deepEqual(stale.ops, ["commit"], "the script checked it on main: one exec, exit 4");
    assert.deepEqual(await readSnapshot(ws), before, "nothing written");
    const big = await execsOf(() => learningCommit(ws, { runId: "run-big", reason: "Too much.", files: [{ path: "workflows/huge/README.md", text: README("huge") }, { path: "workflows/huge/workflow.json", text: "x".repeat(STDIN_MAX) }] }));
    assert.deepEqual([big.result.ok, big.result.reason, big.result.problems?.map((p) => p.rule)], [false, "refused", ["too_large"]]);
    assert.match(big.result.problems[0].detail, /one exec takes at most 2097152/);
    assert.deepEqual(big.ops, [], "refused before any exec");
    assert.deepEqual(await readSnapshot(ws), before);
  });

  test(`${backend}: a draft or a correction alone seeded from a commit the folder no longer holds (its learning reset since) is a conflict that says so, and nothing lands on the new history`, async () => {
    const { ws } = await make();
    const seeded = await learningCommit(ws, { runId: "run-r1", reason: "A draft.", files: draft("weekly-report") });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const seed = seeded.main;
    // The reset (learn/delete.ts): every entry of the folder removed, its git history with it; the next write starts anew.
    for (const entry of await ws.list("")) await ws.remove(entry.name, { recursive: true, force: true });
    const fresh = await learningCommit(ws, { runId: "run-r2", reason: "After the reset.", files: draft("daily-report") });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    const before = await readSnapshot(ws);
    const stale = await learningCommit(ws, { runId: "run-r3", reason: "Drafted on the old history.", files: draft("monthly-report"), seed });
    assert.deepEqual([stale.ok, stale.reason, stale.problems?.length], [false, "conflict", 1], JSON.stringify(stale));
    assert.match(stale.problems[0].detail, /learning was reset after the run started/);
    assert.deepEqual(await readSnapshot(ws), before, "nothing written");
    assert.deepEqual((await gitMain(ws)).tree.map((entry) => entry.path).filter((path) => path.startsWith("workflows/monthly-report")), [], "the stale draft is not on main");
    // A correction alone has no file a `same` covers: the seed itself is the wall.
    const line = await learningCommit(ws, { runId: "run-r4", reason: "Its owner's correction.", files: [], correction: "Retry more slowly next time.", seed });
    assert.deepEqual([line.ok, line.reason], [false, "conflict"], JSON.stringify(line));
    assert.match(line.problems[0].detail, /learning was reset after the run started/);
    assert.deepEqual(await readSnapshot(ws), before, "nothing written");
    assert.equal((await gitMain(ws)).tree.some((entry) => entry.path === CORRECTIONS), false, "no corrections line on the new history");
  });

  test(`${backend}: a tracked link in a draft's folder is named in its links, never one of its files; the same from the snapshot the script writes and from a rebuild of main`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    await commitChange(ws, await readSnapshot(ws), { by: { run: "run-l", reason: "Two drafts." }, writes: [...draft("alpha"), ...draft("beta")] });
    // A tracked link in draft alpha's folder, committed by hand (as only an operator or an older server could), through
    // the folder's own exec, then the snapshot rebuilt from main.
    const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "op", GIT_AUTHOR_EMAIL: "op@example.invalid", GIT_COMMITTER_NAME: "op", GIT_COMMITTER_EMAIL: "op@example.invalid" };
    const hand = await ws.exec(["sh", "-c", "ln -s ../beta/workflow.json workflows/alpha/linked.json && git add workflows/alpha/linked.json && git -c core.hooksPath=/dev/null commit -q -m 'a hand link'"], { env, timeoutMs: 60_000 });
    assert.equal(hand.code, 0, hand.stderr);
    const rebuilt = await learningRepair(ws);
    const alpha = rebuilt.workflows.find((w) => w.name === "alpha");
    assert.deepEqual([alpha.links, alpha.files.map((f) => f.path)], [["workflows/alpha/linked.json"], ["workflows/alpha/README.md", "workflows/alpha/workflow.json"]]);
    assert.equal(rebuilt.workflows.find((w) => w.name === "beta").links, undefined);
    // A later write carries the links on in the snapshot it computes, as a rebuild of main gives them.
    await commitChange(ws, await readSnapshot(ws), edited(UNITS));
    assert.deepEqual((await matchesMain(ws)).workflows.find((w) => w.name === "alpha").links, ["workflows/alpha/linked.json"]);
  });
}
