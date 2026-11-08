// The learning folder's script (src/learn/learning.sh, through learn/folder.ts), with the SAME assertions over every
// Workspace backend: learn-folder-local.test.mjs runs them on a local folder, learn-folder-archil.test.mjs on the fake
// Archil disk. Every check reads the folder through the workspace alone (its file API, and the script's own `read` for
// what git holds), so a backend that is not a folder of this machine is checked the same way.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blobOid, DIFFS_DIR, FolderBusy, folderTestHooks, forgetBodies, commitChange, learningInit, learningRepair, nextSnapshot, parseRead,
  readLearning, readRunDiff, readSnapshot, SCRIPT_FILE, SNAPSHOT_FILE, snapshotOfRead, writeLearning,
} from "../dist/learn/folder.js";
import { learningCommit, readMain } from "../dist/learn/commit.js";
import { makeProposalCheck, seedBase } from "../dist/learn/seed-check.js";
import { buildIndex, parseNoteFile, retire, approve, mergedNote, supersede, held, released, retiredLearned } from "../dist/learn/index.js";

const note = (name, description, body = `${name}, in a sentence.\n`, extra = "") => `---\nname: ${name}\ndescription: ${description}\ntype: reference\n${extra}---\n${body}`;
const UNITS = note("Check units", "Convert every amount to one unit before comparing");
const SOURCES = note("Quote sources", "Name the page each figure came from");
const TABLES = note("Prefers tables", "Answer with a table when comparing");
const SKILL = "---\nname: weekly-report\ndescription: How the weekly report is laid out\n---\nSteps.\n";
const indexOf = (files) => buildIndex(Object.entries(files).map(([file, text]) => parseNoteFile(file, text)));
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

/** Every key of `value` is one SNAPSHOT.md v1 names, and each it requires is there. */
function shaped(snapshot) {
  const keys = (value, required, optional = []) => {
    const extra = Object.keys(value).filter((key) => !required.includes(key) && !optional.includes(key));
    assert.deepEqual(extra, [], `no key SNAPSHOT.md does not name: ${JSON.stringify(value).slice(0, 200)}`);
    for (const key of required) assert.ok(key in value, `${key} is there: ${JSON.stringify(value).slice(0, 200)}`);
  };
  const history = (value) => {
    keys(value, ["at"], ["last", "retire", "person"]);
    for (const change of [value.last, value.retire, value.person].filter(Boolean)) keys(change, ["kind", "by", "at"]);
  };
  keys(snapshot, ["v", "main", "at", "index", "notes", "skills", "workflows", "log", "log_more"]);
  assert.equal(snapshot.v, 1);
  assert.match(snapshot.main, HEX);
  keys(snapshot.index, ["oid", "bytes"]);
  for (const one of snapshot.notes) {
    keys(one, ["file", "oid", "bytes", "name", "description", "type", "status", "origin", "supersedes", "superseded_by", "order", "history"]);
    history(one.history);
  }
  for (const one of [...snapshot.skills, ...snapshot.workflows]) {
    keys(one, ["name", "file", "description", "status", "run", "files", "oid", "bytes", "order", "history"]);
    for (const file of one.files) keys(file, ["path", "oid", "bytes"]);
    history(one.history);
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
  for (const { file, oid } of snapshot.notes) assert.equal(blobOid(await ws.read(file)), oid, file);
  for (const { files } of [...snapshot.skills, ...snapshot.workflows]) for (const { path, oid } of files) assert.equal(blobOid(await ws.read(path)), oid, path);
  assert.equal(blobOid(await ws.read("MEMORY.md")), snapshot.index.oid);
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

/** A person's write as the route makes it: the file and MEMORY.md rebuilt. */
const personChange = (kind, file, files, approved = false) => ({ by: { person: kind, file, ...(approved ? { approved: true } : {}) }, writes: [{ path: file, text: files[file] }, { path: "MEMORY.md", text: indexOf(Object.fromEntries(Object.entries(files).filter(([path]) => !path.includes("/")))) }] });

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
    assert.deepEqual([first.main, first.notes, first.skills, first.workflows, first.log, first.log_more, first.index], [init.result, [], [], [], [], false, { oid: blobOid(""), bytes: 0 }]);
    assert.equal(await learningInit(ws), init.result, "a second init reads the snapshot and makes nothing");

    const files = { "check-units.md": mergedNote(UNITS, { origin: "you" }), "quote-sources.md": SOURCES };
    const merge = await execsOf(() => commitChange(ws, first, { by: { run: "run-1", reason: "Each note is general and new." }, writes: [...Object.entries(files).map(([path, text]) => ({ path, text })), { path: "MEMORY.md", text: indexOf(files) }, { path: "skills/weekly-report/SKILL.md", text: SKILL }], absent: Object.keys(files) }));
    assert.deepEqual(merge.ops, ["commit"], "one exec");
    assert.equal(merge.result.landed, true);
    const second = await matchesMain(ws);
    assert.equal(second.main, merge.result.main);
    assert.deepEqual(merge.result.snapshot, second, "what commitChange hands back is what the script wrote");
    assert.deepEqual(second.notes.map((n) => [n.file, n.oid, n.bytes, n.name, n.status, n.origin, n.order, n.history.last]), [
      ["check-units.md", blobOid(files["check-units.md"]), Buffer.byteLength(files["check-units.md"]), "Check units", "active", "you", 0, { kind: "learned", by: "run", at: second.at }],
      ["quote-sources.md", blobOid(SOURCES), Buffer.byteLength(SOURCES), "Quote sources", "active", "run", 0, { kind: "learned", by: "run", at: second.at }],
    ]);
    assert.deepEqual(second.skills.map((s) => [s.name, s.file, s.description, s.status, s.run, s.files.map((f) => f.path)]), [["weekly-report", "skills/weekly-report/SKILL.md", "How the weekly report is laid out", "active", "run-1", ["skills/weekly-report/SKILL.md"]]]);
    assert.deepEqual(second.log.map((c) => [c.commit, c.by, c.reason, c.files]), [[second.main, { run: "run-1" }, "Each note is general and new.", ["MEMORY.md", "check-units.md", "quote-sources.md", "skills/weekly-report/SKILL.md"]]]);
    assert.equal(text(await ws.read("MEMORY.md")), indexOf(files));
  });

  test(`${backend}: a stale main exits 3 and writes nothing: main, the snapshot and the working tree as they were`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const base = await readSnapshot(ws);
    const won = await commitChange(ws, base, personChange("created", "check-units.md", { "check-units.md": UNITS }));
    assert.equal(won.landed, true);
    const before = { snapshot: text(await ws.read(SNAPSHOT_FILE)), main: (await gitMain(ws)).main, list: (await ws.list("")).map((e) => e.name) };
    const lost = await commitChange(ws, base, personChange("created", "prefers-tables.md", { "prefers-tables.md": TABLES }));
    assert.deepEqual(lost, { stale: true, main: won.main }, "exit 3, with main as it is");
    assert.deepEqual({ snapshot: text(await ws.read(SNAPSHOT_FILE)), main: (await gitMain(ws)).main, list: (await ws.list("")).map((e) => e.name) }, before);
    await assert.rejects(ws.read("prefers-tables.md"), (error) => error.code === "NOT_FOUND");
    // writeLearning computes it again on main as it is, and lands.
    const again = await writeLearning(ws, async ({ snapshot }) => ({ result: snapshot.main, change: personChange("created", "prefers-tables.md", { "check-units.md": UNITS, "prefers-tables.md": TABLES }) }));
    assert.equal(again.result, won.main, "computed on the main that won");
    const after = await matchesMain(ws);
    assert.deepEqual(after.notes.map((n) => n.file).sort(), ["check-units.md", "prefers-tables.md"]);
  });

  test(`${backend}: a merge writes .agentrun/diffs/<run>.json: its commit, its parent and each file's patch as git diffs it`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const base = await readSnapshot(ws);
    const one = await commitChange(ws, base, { by: { run: "run-a", reason: "General." }, writes: [{ path: "check-units.md", text: UNITS }, { path: "MEMORY.md", text: indexOf({ "check-units.md": UNITS }) }] });
    const diff = await readRunDiff(ws, "run-a");
    assert.deepEqual([diff.v, diff.run, diff.merge, diff.parent], [1, "run-a", one.main, base.main]);
    const lines = UNITS.split("\n").slice(0, -1);
    assert.deepEqual(diff.files, [
      { path: "MEMORY.md", status: "modified", patch: `@@ -0,0 +1 @@\n+${indexOf({ "check-units.md": UNITS }).trimEnd()}\n` },
      { path: "check-units.md", status: "added", patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}` },
    ]);
    // A second merge supersedes the note: a modified file's patch, and a patch over the cap withheld.
    const second = await readSnapshot(ws);
    const big = note("Big", "A long one", `${"word ".repeat(16000)}\n`);
    const marked = supersede(UNITS, "units-v2.md");
    const v2 = note("Units v2", "Convert to the answer's unit", "Better.\n", "supersedes: [check-units.md]\n");
    const two = await commitChange(ws, second, { by: { run: "run-b", reason: "It replaces the older note." }, writes: [{ path: "units-v2.md", text: v2 }, { path: "check-units.md", text: marked }, { path: "big.md", text: big }, { path: "MEMORY.md", text: indexOf({ "units-v2.md": v2, "big.md": big }) }] });
    const diff2 = await readRunDiff(ws, "run-b");
    assert.deepEqual([diff2.merge, diff2.parent], [two.main, one.main]);
    assert.deepEqual(diff2.files.map((f) => [f.path, f.status, f.withheld ?? null]), [["MEMORY.md", "modified", null], ["big.md", "added", "too_large"], ["check-units.md", "modified", null], ["units-v2.md", "added", null]]);
    assert.match(diff2.files[2].patch, /^@@ .* @@\n(?:.*\n)*\+status: superseded\n\+superseded_by: units-v2.md\n/);
    // A note's text with quotes, backslashes, tabs and characters past ASCII is carried as JSON writes it.
    const third = await readSnapshot(ws);
    const odd = note("Odd \"quotes\"", "Back\\slash and tab", "A\ttab, a \\ and é ü — and \"quotes\".\n");
    await commitChange(ws, third, { by: { run: "run-c", reason: "Odd characters." }, writes: [{ path: "odd.md", text: odd }] });
    const lines3 = odd.split("\n").slice(0, -1);
    assert.deepEqual((await readRunDiff(ws, "run-c")).files, [{ path: "odd.md", status: "added", patch: `@@ -0,0 +1,${lines3.length} @@\n${lines3.map((l) => `+${l}\n`).join("")}` }]);
    // A person's write keeps no diff file.
    await commitChange(ws, await readSnapshot(ws), personChange("retired", "odd.md", { "odd.md": retire(odd) }));
    assert.deepEqual((await ws.list(DIFFS_DIR)).map((e) => e.name), ["run-a.json", "run-b.json", "run-c.json"]);
    await matchesMain(ws);
  });

  test(`${backend}: snapshot.json is written last: a failure after the files leaves the old snapshot, a reader sees the old snapshot with newer bodies (503 on what changed), and the next write rebuilds it from main`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    await commitChange(ws, await readSnapshot(ws), personChange("created", "check-units.md", { "check-units.md": UNITS }));
    await commitChange(ws, await readSnapshot(ws), personChange("created", "quote-sources.md", { "check-units.md": UNITS, "quote-sources.md": SOURCES }));
    const old = await readSnapshot(ws);
    const oldBytes = text(await ws.read(SNAPSHOT_FILE));
    const edited = note("Check units", "Convert every amount to the answer's unit");
    folderTestHooks.env = { AGENTRUN_LEARNING_FAIL: "before-snapshot" };
    try {
      await assert.rejects(commitChange(ws, old, { by: { run: "run-x", reason: "Edited." }, writes: [{ path: "check-units.md", text: edited }, { path: "MEMORY.md", text: indexOf({ "check-units.md": edited, "quote-sources.md": SOURCES }) }] }), /before the snapshot/);
    } finally {
      folderTestHooks.env = undefined;
    }
    const moved = (await gitMain(ws)).main;
    assert.notEqual(moved, old.main, "the commit landed: main moved");
    assert.equal(text(await ws.read(SNAPSHOT_FILE)), oldBytes, "the old snapshot, untouched");
    assert.equal(text(await ws.read("check-units.md")), edited, "the files were brought in line before the snapshot");
    assert.equal((await readRunDiff(ws, "run-x")).merge, moved, "the diff was written before the snapshot");
    // A reader: an unchanged body reads; the changed one is not the old snapshot's blob, twice: FolderBusy (503).
    forgetBodies();
    assert.equal(await readLearning(ws, ({ snapshot, body }) => body("quote-sources.md", snapshot.notes.find((n) => n.file === "quote-sources.md").oid)), SOURCES);
    await assert.rejects(readLearning(ws, ({ snapshot, body }) => body("check-units.md", snapshot.notes.find((n) => n.file === "check-units.md").oid)), FolderBusy);
    // The next write finds main moved under its snapshot (exit 3 naming a main the snapshot is not): rebuilt, then lands.
    const ops = [];
    folderTestHooks.exec = (argv) => ops.push(argv[2]);
    try {
      await writeLearning(ws, async ({ snapshot }) => ({ result: null, change: personChange("retired", "quote-sources.md", { "check-units.md": edited, "quote-sources.md": retire(SOURCES) }) }));
    } finally {
      folderTestHooks.exec = undefined;
    }
    assert.deepEqual(ops, ["commit", "read", "snapshot", "commit"], "stale, rebuilt from main, computed again");
    const after = await matchesMain(ws);
    assert.equal(after.notes.find((n) => n.file === "check-units.md").history.last.kind, "learned");
    assert.equal(after.log[1].commit, moved, "the stopped merge is in the log the rebuild read");
  });

  test(`${backend}: a person's create, edit, retire, approve and restore, and a skill's approve and retire, are each one exec, and each snapshot is main's`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const files = {};
    const step = async (change, kind) => {
      const { result, ops } = await execsOf(async () => commitChange(ws, await readSnapshot(ws), change));
      assert.equal(result.landed, true, kind);
      assert.deepEqual(ops, ["commit"], `${kind}: one exec`);
      return matchesMain(ws);
    };
    files["check-units.md"] = UNITS;
    let snap = await step(personChange("created", "check-units.md", files), "create");
    assert.deepEqual(snap.log[0].by, { user: true });
    assert.equal(snap.log[0].reason, "created by a person: check-units.md");
    files["check-units.md"] = note("Check units", "Convert to the answer's unit");
    snap = await step(personChange("edited", "check-units.md", files), "edit");
    assert.deepEqual(snap.notes[0].history.last, { kind: "edited", by: "person", at: snap.at });
    files["ask-first.md"] = mergedNote(note("Ask first", "Ask which currency"), { origin: "run", pending: true });
    snap = await step({ by: { run: "run-p", reason: "Held for its owner's OK." }, writes: [{ path: "ask-first.md", text: files["ask-first.md"] }, { path: "MEMORY.md", text: indexOf(files) }, { path: "skills/weekly-report/SKILL.md", text: held(SKILL) }] }, "a merge that holds");
    assert.deepEqual(snap.notes.map((n) => [n.file, n.status]), [["check-units.md", "active"], ["ask-first.md", "pending"]]);
    assert.equal(snap.skills[0].status, "pending");
    files["ask-first.md"] = approve(files["ask-first.md"]);
    snap = await step(personChange("approved", "ask-first.md", files, true), "approve");
    assert.deepEqual(snap.log[0].by, { user: true, via: "console" });
    files["check-units.md"] = retire(files["check-units.md"]);
    snap = await step(personChange("retired", "check-units.md", files), "retire");
    const retired = snap.notes.find((n) => n.file === "check-units.md");
    assert.deepEqual([retired.status, retired.history.retire?.kind, retired.history.person?.kind], ["retired", "retired", "retired"]);
    files["check-units.md"] = approve(files["check-units.md"]);
    snap = await step(personChange("restored", "check-units.md", files), "restore");
    assert.deepEqual(snap.notes.find((n) => n.file === "check-units.md").history, { at: snap.at, last: { kind: "restored", by: "person", at: snap.at }, retire: retired.history.retire, person: { kind: "restored", by: "person", at: snap.at } });
    snap = await step({ by: { person: "approved", file: "skills/weekly-report/SKILL.md", approved: true }, writes: [{ path: "skills/weekly-report/SKILL.md", text: released(held(SKILL)) }, { path: "MEMORY.md", text: indexOf(files) }] }, "a skill's approve");
    assert.deepEqual([snap.skills[0].status, snap.skills[0].run, snap.skills[0].history.last.kind, snap.log[0].files], ["active", "run-p", "approved", ["skills/weekly-report/SKILL.md"]]);
    snap = await step({ by: { person: "retired", file: "skills/weekly-report/SKILL.md" }, writes: [{ path: "skills/weekly-report/SKILL.md", text: retiredLearned(released(held(SKILL))) }, { path: "MEMORY.md", text: indexOf(files) }] }, "a skill's retire");
    assert.equal(snap.skills[0].status, "retired");
    assert.deepEqual(snap.log.map((c) => c.reason), ["retired by a person: skills/weekly-report/SKILL.md", "approved by a person: skills/weekly-report/SKILL.md", "restored by a person: check-units.md", "retired by a person: check-units.md", "approved by a person: ask-first.md", "Held for its owner's OK.", "edited by a person: check-units.md", "created by a person: check-units.md"]);
  });

  test(`${backend}: a precondition the script checks on main refuses the write whole (exit 4): a new name held by a file that is no note, a file changed since a seed`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const seed = await commitChange(ws, await readSnapshot(ws), { by: { run: "run-s", reason: "A skill." }, writes: [{ path: "skills/weekly-report/SKILL.md", text: SKILL }, { path: "bare.md", text: "no front matter\n" }] });
    const snap = await readSnapshot(ws);
    assert.deepEqual(snap.notes, [], "a file that is no note is not in the snapshot");
    const refused = await commitChange(ws, snap, { ...personChange("created", "bare.md", { "bare.md": UNITS }), absent: ["bare.md"] });
    assert.deepEqual(refused, { refused: { absent: ["bare.md"], same: [] } });
    await commitChange(ws, snap, { by: { person: "retired", file: "skills/weekly-report/SKILL.md" }, writes: [{ path: "skills/weekly-report/SKILL.md", text: retiredLearned(SKILL) }] });
    const after = await readSnapshot(ws);
    const moved = await commitChange(ws, after, { by: { run: "run-t", reason: "A newer skill." }, writes: [{ path: "skills/weekly-report/SKILL.md", text: SKILL.replace("Steps.", "Better steps.") }], same: [{ commit: seed.main, path: "skills/weekly-report/SKILL.md" }] });
    assert.deepEqual(moved, { refused: { absent: [], same: ["skills/weekly-report/SKILL.md"] } });
    assert.equal((await readSnapshot(ws)).main, after.main, "nothing written");
    await assert.rejects(ws.read(`${DIFFS_DIR}/run-t.json`), (error) => error.code === "NOT_FOUND");
  });

  test(`${backend}: a body is checked against its oid: a mismatch reads the snapshot again and tries once more, a second is FolderBusy; the reads use the file API alone`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    await commitChange(ws, await readSnapshot(ws), personChange("created", "check-units.md", { "check-units.md": UNITS }));
    const snap = await readSnapshot(ws);
    const oid = snap.notes[0].oid;
    // A body that is wrong once (a write in flight), then right: one retry, read whole.
    let reads = 0;
    let snapshots = 0;
    forgetBodies();
    const flaky = wrap(ws, {
      read: async (path, range) => {
        if (path === SNAPSHOT_FILE) snapshots++;
        if (path === "check-units.md" && reads++ === 0) return Buffer.from("half a note");
        return ws.read(path, range);
      },
      exec: () => assert.fail("a read never execs"),
    });
    assert.equal(await readLearning(flaky, ({ snapshot, body }) => body("check-units.md", snapshot.notes[0].oid)), UNITS);
    assert.deepEqual([reads, snapshots], [2, 2], "the snapshot read again, the body once more");
    // A body that stays wrong: FolderBusy.
    forgetBodies();
    const wrong = wrap(ws, { read: async (path, range) => (path === "check-units.md" ? Buffer.from(TABLES) : ws.read(path, range)), exec: () => assert.fail("a read never execs") });
    await assert.rejects(readLearning(wrong, ({ body }) => body("check-units.md", oid)), FolderBusy);
    // A body that is gone: the same.
    const gone = wrap(ws, { read: async (path, range) => (path === "check-units.md" ? ws.read("no-such-file.md") : ws.read(path, range)), exec: () => assert.fail("a read never execs") });
    await assert.rejects(readLearning(gone, ({ body }) => body("check-units.md", oid)), FolderBusy);
  });

  test(`${backend}: nextSnapshot and a rebuild from main agree over a longer history: a log past LOG_KEEP says older exist`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const files = {};
    for (let i = 0; i < 6; i++) {
      files[`n${i}.md`] = note(`Note ${i}`, `The ${i}th`);
      await commitChange(ws, await readSnapshot(ws), personChange("created", `n${i}.md`, files));
    }
    const snap = await matchesMain(ws);
    assert.deepEqual(snap.notes.map((n) => [n.file, n.order]), [["n5.md", 0], ["n4.md", 1], ["n3.md", 2], ["n2.md", 3], ["n1.md", 4], ["n0.md", 5]]);
    // The log keeps LOG_KEEP: shown on a synthetic snapshot, the shape the script writes.
    let synthetic = snap;
    for (let i = 0; i < 200; i++) synthetic = { ...nextSnapshot(synthetic, personChange("edited", "n0.md", { ...files, "n0.md": note("Note 0", `edit ${i}`) }), 1_800_000_000 + i).snapshot, main: snap.main };
    assert.deepEqual([synthetic.log.length, synthetic.log_more], [200, true]);
  });

  test(`${backend}: the script is written once per version, as .agentrun/learning-<sha8>.sh`, async () => {
    const { ws } = await make();
    let writes = 0;
    const counted = wrap(ws, { write: async (path, data) => { if (path === SCRIPT_FILE) writes++; return ws.write(path, data); } });
    await learningInit(counted);
    await commitChange(counted, await readSnapshot(counted), personChange("created", "check-units.md", { "check-units.md": UNITS }));
    assert.match(SCRIPT_FILE, /^\.agentrun\/learning-[0-9a-f]{8}\.sh$/);
    assert.equal(writes, 1, "written once, then found");
    await learningRepair(counted);
    assert.equal(writes, 1);
  });

  test(`${backend}: learningCommit (COMMIT-API v1): a merge with a held note and a supersede is one exec and idempotent; a stale graded oid is a conflict; a name main holds is refused; a person's stale ifMatch is a conflict; a failing exec is unavailable`, async () => {
    const { ws } = await make();
    // A folder with no main: made in the same call.
    const first = await execsOf(() => learningCommit(ws, { kind: "person", action: "created", file: "check-units.md", text: UNITS, ifMatch: null }));
    assert.equal(first.result.ok, true, JSON.stringify(first.result));
    assert.deepEqual(first.ops, ["init", "commit"]);
    assert.deepEqual(first.result.files, ["MEMORY.md", "check-units.md"]);
    const base = await matchesMain(ws);
    const unitsOid = base.notes[0].oid;
    const V2 = note("Units v2", "Convert to the answer's unit", "Better.\n", "supersedes: [check-units.md]\n");
    const ASK = note("Ask first", "Ask which currency");
    const merge = { kind: "merge", runId: "run-c1", reason: "One general rule, one risky.", files: [{ path: "units-v2.md", text: V2 }, { path: "ask-first.md", text: ASK }, { path: "skills/weekly-report/SKILL.md", text: SKILL }], held: ["ask-first.md", "skills/weekly-report/SKILL.md"], supersede: [{ path: "check-units.md", by: "units-v2.md" }], graded: { "check-units.md": unitsOid } };
    const merged = await execsOf(() => learningCommit(ws, merge));
    assert.equal(merged.result.ok, true, JSON.stringify(merged.result));
    assert.deepEqual(merged.ops, ["commit"], "one exec");
    assert.equal(merged.result.main, merged.result.commit);
    const snap = await matchesMain(ws);
    assert.deepEqual(snap.notes.map((n) => [n.file, n.status]), [["units-v2.md", "active"], ["ask-first.md", "pending"], ["check-units.md", "superseded"]]);
    assert.equal(snap.skills[0].status, "pending");
    assert.equal(text(await ws.read("MEMORY.md")), indexOf({ "units-v2.md": V2 }));
    assert.equal((await readRunDiff(ws, "run-c1")).merge, merged.result.main);
    const again = await execsOf(() => learningCommit(ws, merge));
    assert.deepEqual([again.result, again.ops], [{ ok: true, main: snap.main, commit: snap.main, files: merged.result.files }, []], "merged once: nothing written again");
    // A graded oid that is another blob on main now: a conflict, nothing written.
    const stale = await learningCommit(ws, { ...merge, runId: "run-c2", files: [{ path: "later.md", text: note("Later", "A later rule") }], held: [], supersede: [], graded: { "check-units.md": unitsOid } });
    assert.deepEqual([stale.ok, stale.reason, stale.problems.map((p) => p.path)], [false, "conflict", ["check-units.md"]]);
    // A new note named like a note on main: refused.
    const taken = await learningCommit(ws, { kind: "merge", runId: "run-c3", reason: "x", files: [{ path: "units-v2.md", text: V2 }], graded: {} });
    assert.deepEqual([taken.ok, taken.reason, taken.problems?.map((p) => p.rule)], [false, "refused", ["exists"]], JSON.stringify(taken));
    // A person's write by an ETag main moved past: a conflict. By the right one: lands.
    const edited = note("Units v2", "Convert to the answer's unit, always", "Better.\n", "supersedes: [check-units.md]\n");
    const v2oid = snap.notes.find((n) => n.file === "units-v2.md").oid;
    const lost = await learningCommit(ws, { kind: "person", action: "edited", file: "units-v2.md", text: edited, ifMatch: `"${unitsOid}"` });
    assert.deepEqual([lost.ok, lost.reason], [false, "conflict"]);
    const won = await learningCommit(ws, { kind: "person", action: "edited", file: "units-v2.md", text: edited, ifMatch: `"${v2oid}"` });
    assert.equal(won.ok, true, JSON.stringify(won));
    assert.deepEqual((await matchesMain(ws)).log[0].by, { user: true });
    // The workspace failing under the exec: unavailable, retryable later.
    const broken = wrap(ws, { exec: async () => { throw Object.assign(new Error("the disk is gone"), { name: "WorkspaceError", code: "UNAVAILABLE" }); } });
    const down = await learningCommit(broken, { kind: "person", action: "created", file: "x.md", text: note("X", "x"), ifMatch: null });
    assert.deepEqual([down.ok, down.reason], [false, "unavailable"]);
    assert.match(down.error, /the disk is gone/);
  });

  test(`${backend}: seedBase reads a run's seed from the snapshot when it is main (no exec), else with one read-only exec at that commit; makeProposalCheck checks a proposal against it`, async () => {
    const { ws } = await make();
    await learningInit(ws);
    const one = await commitChange(ws, await readSnapshot(ws), personChange("created", "check-units.md", { "check-units.md": UNITS }));
    const atMain = await execsOf(() => seedBase(ws, one.main));
    assert.deepEqual(atMain.ops, [], "the seed is main: the snapshot, no exec");
    assert.deepEqual([atMain.result.ok, [...atMain.result.base.files], atMain.result.base.active.map((n) => n.file)], [true, ["MEMORY.md", "check-units.md"], ["check-units.md"]]);
    await commitChange(ws, await readSnapshot(ws), personChange("created", "quote-sources.md", { "check-units.md": UNITS, "quote-sources.md": SOURCES }));
    const older = await execsOf(() => seedBase(ws, one.main));
    assert.deepEqual(older.ops, ["read"], "an older seed: one read-only exec");
    assert.deepEqual([...older.result.base.files], ["MEMORY.md", "check-units.md"], "the folder as the seed held it");
    assert.deepEqual(await seedBase(ws, "0".repeat(40)), { ok: false, reason: "gone", detail: `the learning folder has no commit ${"0".repeat(40)}` });
    let ended = 0;
    const check = makeProposalCheck({ open: () => ({ workspace: ws, end: async () => void ended++ }) });
    const common = { agentId: "a", seed: one.main, outcome: "completed", tools: [], dsl: undefined };
    assert.deepEqual(await check({ ...common, changes: [{ path: "prefers-tables.md", status: "added", mode: "100644", bytes: Buffer.from(TABLES) }] }), { ok: true, problems: [] });
    const edit = await check({ ...common, changes: [{ path: "check-units.md", status: "modified", mode: "100644", bytes: Buffer.from(TABLES) }] });
    assert.deepEqual([edit.ok, edit.problems.map((p) => p.rule)], [false, ["edited"]]);
    assert.equal(ended, 2, "the folder is ended after each check");
  });

  test(`${backend}: learningCommit as the runner's learning loop calls it (no supersede named): the new notes' own front matter marks what they supersede, a held one marks nothing, the run's risky mark is never kept; readMain gives the grader main from the snapshot`, async () => {
    const { ws } = await make();
    await learningCommit(ws, { kind: "person", action: "created", file: "check-units.md", text: UNITS, ifMatch: null });
    const V2 = note("Units v2", "Convert to the answer's unit", "Better.\n", "supersedes: [check-units.md]\nrisky: false\n");
    const main = await readMain(ws, { notes: [{ file: "units-v2.md", text: V2 }] });
    const unitsOid = (await readSnapshot(ws)).notes[0].oid;
    assert.deepEqual(main, { active: [{ file: "check-units.md", name: "Check units", description: "Convert every amount to one unit before comparing" }], superseded: [{ file: "check-units.md", text: UNITS }], graded: { "check-units.md": unitsOid } });
    assert.deepEqual(await readMain(ws, { notes: [{ file: "check-units.md", text: UNITS }] }), { problems: [{ rule: "exists", path: "check-units.md", detail: "the folder has a note by this name" }] });
    const HELD = note("Held v3", "A risky rule", "Hold it.\n", "supersedes: [check-units.md]\nrisky: true\n");
    const one = await learningCommit(ws, { kind: "merge", runId: "run-h", reason: "Held.", files: [{ path: "held-v3.md", text: HELD }], held: ["held-v3.md"], graded: {} });
    assert.equal(one.ok, true, JSON.stringify(one));
    let snap = await matchesMain(ws);
    assert.deepEqual(snap.notes.map((n) => [n.file, n.status]), [["check-units.md", "active"], ["held-v3.md", "pending"]], "a held note supersedes nothing");
    assert.doesNotMatch(text(await ws.read("held-v3.md")), /^risky:/m);
    const two = await learningCommit(ws, { kind: "merge", runId: "run-v2", reason: "General.", files: [{ path: "units-v2.md", text: V2 }], graded: main.graded });
    assert.equal(two.ok, true, JSON.stringify(two));
    snap = await matchesMain(ws);
    assert.deepEqual(snap.notes.map((n) => [n.file, n.status, n.superseded_by]), [["units-v2.md", "active", null], ["check-units.md", "superseded", "units-v2.md"], ["held-v3.md", "pending", null]], "the view's order: active first, then the newest change");
    assert.doesNotMatch(text(await ws.read("units-v2.md")), /^risky:/m);
    assert.equal(text(await ws.read("MEMORY.md")), indexOf({ "units-v2.md": V2 }));
  });
}
