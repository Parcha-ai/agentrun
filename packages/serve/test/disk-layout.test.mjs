// The disk: a run works in its agent's folder, <data>/disk/agents/<agent>/runs/<run>/{store,work}, apart from the data
// directory's control plane (store.sqlite). Its row holds its claim: the launch of its process bumps the epoch with the
// process as holder, and the server takes it back once the process is gone (another bump, the server the holder) and
// checkpoints its database. The server reads a run's database with a fresh read-only, lock-free open per read, never
// shows a read behind one before, and never opens it read-write while a process holds the run. A data directory an
// earlier version wrote is refused in words, with no migration. Through the HTTP API on the faux probe model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { checkpointRunDb, HeldRunDbError, MonotonicReads, BehindReadError, observeRunDbOpens, runDbTestHooks } from "../dist/run-db.js";
import { archilDisk, localDisk } from "../dist/disk.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { learningRepo } from "../dist/learning.js";
import { agent, FAUX, flowAgent, follow, runDir, scratch, serve } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const folderOf = (id) => `${id.toLowerCase()}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;
const claimOf = (data, runId) => {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return { ...db.prepare("SELECT claim_epoch, claim_holder FROM runs WHERE id = ?").get(runId) };
  } finally {
    db.close();
  }
};

async function probeRun(api, plan, id = "writer") {
  const made = await api("POST", "/agents", { definition: { id, name: id, instructions: "Probe.", tools: ["read", "write"] } });
  assert.ok([201, 409].includes(made.status), JSON.stringify(made.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("demo through the API: a run's folder is on the disk, its file tools write into its work/ there, nothing is under <data>/runs, and its row's claim went from its process (epoch 1) to the server, which checkpointed its database", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: PROBE });
  const runId = await probeRun(api, [{ tool: "write", args: { path: "out.txt", content: "on the disk" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const root = realpathSync(data);
  const folder = join(root, "disk", "agents", folderOf("writer"), "runs", runId);
  assert.equal(readFileSync(join(folder, "work", "out.txt"), "utf8"), "on the disk");
  assert.ok(existsSync(join(folder, "store", "run.sqlite")));
  assert.equal(existsSync(join(root, "runs")), false, "no run under the data directory's own files");
  const claim = claimOf(root, runId);
  assert.equal(claim.claim_holder, "server", "the server took it back");
  assert.ok(claim.claim_epoch >= 2, `launched (1), then taken back: epoch ${claim.claim_epoch}`);
  const wal = join(folder, "store", "run.sqlite-wal");
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, "its WAL was checkpointed into the database file at the take-back");
  // Its timeline still reads, from the database file alone.
  const rows = (await api("GET", `/runs/${runId}/timeline?after=0`)).body.rows;
  assert.ok(rows.some((row) => /out\.txt/.test(JSON.stringify(row))), "the write is on its timeline");
});

test("the server never opens a run's database read-write while its process holds the run: every open while held is a read, and the one checkpoint comes after the process is gone", { timeout: 120_000 }, async (t) => {
  const opens = [];
  t.after(observeRunDbOpens((open) => opens.push(open)));
  const { api } = await serve(t, { faux: PROBE });
  const hold = join(await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "disk-hold-")), "go");
  const runId = await probeRun(api, [{ wait: hold }, { tool: "write", args: { path: "a.txt", content: "a" } }]);
  // While its process holds it: reads of the run, its list and its timeline.
  for (let i = 0; i < 5; i++) {
    await api("GET", `/runs/${runId}`);
    await api("GET", `/runs/${runId}/timeline?after=0`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await writeFile(hold, "");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(opens.filter((open) => open.mode === "checkpoint" && open.held), [], "no read-write open while held");
  assert.ok(opens.some((open) => open.mode === "checkpoint" && !open.held), "the take-back checkpointed once the process was gone");
});

test("a read-write open while held is refused before any open; a read behind one before is refused, and the reads' guard is per run", async (t) => {
  const file = join(await scratch(t), "never.sqlite");
  await assert.rejects(checkpointRunDb(file, true), HeldRunDbError);
  assert.equal(existsSync(file), false, "nothing was opened, so nothing was made");
  const reads = new MonotonicReads();
  reads.accept("r1", 5);
  reads.accept("r1", 5);
  reads.accept("r1", 9);
  assert.throws(() => reads.accept("r1", 8), BehindReadError);
  reads.accept("r2", 1);
  reads.forget("r1");
  reads.accept("r1", 1);
});

test("a run's read guard goes at its end: after runs that ended, the server keeps none of their reads", { timeout: 120_000 }, async (t) => {
  const made = [];
  runDbTestHooks.madeReads = (reads) => made.push(reads);
  t.after(() => delete runDbTestHooks.madeReads);
  const { api } = await serve(t, { faux: PROBE });
  assert.equal(made.length, 1, "the server's one guard");
  const [reads] = made;
  let accepted = 0;
  const accept = reads.accept.bind(reads);
  reads.accept = (...args) => (accepted++, accept(...args));
  for (const content of ["one", "two"]) {
    const runId = await probeRun(api, [{ tool: "write", args: { path: `${content}.txt`, content } }]);
    await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  }
  assert.ok(accepted >= 2, `its reads were guarded (${accepted})`);
  assert.equal(reads.size, 0, "no ended run's reads are kept");
});

test("the take-back's checkpoint opens the run's database as its writer does: synchronous FULL, and on macOS F_FULLFSYNC at every sync and checkpoint", async (t) => {
  const file = join(await scratch(t), "run.sqlite");
  const made = new DatabaseSync(file);
  made.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; CREATE TABLE t(x)");
  made.close();
  const seen = [];
  runDbTestHooks.beforeCheckpoint = (db) => seen.push(Object.fromEntries(["synchronous", "fullfsync", "checkpoint_fullfsync", "locking_mode", "journal_mode"].map((pragma) => [pragma, Object.values(db.prepare(`PRAGMA ${pragma}`).get())[0]])));
  t.after(() => delete runDbTestHooks.beforeCheckpoint);
  await checkpointRunDb(file, false, "darwin");
  await checkpointRunDb(file, false, "linux");
  assert.deepEqual(seen, [
    { synchronous: 2, fullfsync: 1, checkpoint_fullfsync: 1, locking_mode: "exclusive", journal_mode: "wal" },
    { synchronous: 2, fullfsync: 0, checkpoint_fullfsync: 0, locking_mode: "exclusive", journal_mode: "wal" },
  ]);
});

test("the local disk adapter: mount gives a runner the folder itself, below the disk and through no link; sync and unmount; revoke bumps the run's epoch with the server as holder", async (t) => {
  const data = realpathSync(await scratch(t));
  const work = join(data, "disk", "agents", "a-0123456789abcdef", "runs", "r1", "work");
  mkdirSync(work, { recursive: true });
  const claimed = [];
  const disk = localDisk(data, { runClaim: () => ({ epoch: claimed.length + 1, holder: null }), claimRun: (runId, holder, from) => (claimed.push([runId, holder, from]), from + 1) });
  const mounted = await disk.mount("local", "agents/a-0123456789abcdef/runs/r1/work", undefined, "tools");
  assert.deepEqual(mounted, { subpath: "agents/a-0123456789abcdef/runs/r1/work", path: work, mode: "tools" });
  // Its files and folders, nested, are synced; a link in it is never followed.
  mkdirSync(join(work, "a", "b"), { recursive: true });
  writeFileSync(join(work, "a", "b", "f.txt"), "bytes");
  symlinkSync("/nonexistent/elsewhere", join(work, "a", "away"));
  await disk.sync(mounted);
  await disk.unmount(mounted);
  assert.equal(await disk.revoke("r1"), 2);
  assert.deepEqual(claimed, [["r1", "server", 1]], "claimed from the epoch it read");
  for (const bad of ["", "/etc", "agents/../../x", "agents/./a"]) await assert.rejects(disk.mount("local", bad, undefined, "tools"), /is not a path below the disk/, bad);
  symlinkSync(work, join(data, "disk", "agents", "linked"));
  await assert.rejects(disk.mount("local", "agents/linked", undefined, "tools"), /is a link/);
  await assert.rejects(disk.mount("local", "agents/a-0123456789abcdef/runs/r1/work", "/workspace", "tools"), /mounts .* where it is, not at \/workspace/);
});

/** A box whose programs are noted, each exiting `code(command)`, its stdin kept: a box that takes a real stdin. */
function notingBox(code = () => 0) {
  const ran = [];
  return {
    ran,
    box: {
      id: "box-1",
      facts: () => ({ provider: "fake", workspace: "/workspace", secretsVia: "fd" }),
      exec: async (command) => {
        const entry = { command: [...command], stdin: "" };
        ran.push(entry);
        const empty = (async function* () {})();
        return { ok: true, value: { stdin: { write: async (bytes) => void (entry.stdin += new TextDecoder().decode(bytes)), close: async () => {} }, stdout: empty, stderr: (async function* () { if (code(command)) yield new TextEncoder().encode("sudo: a password is required"); })(), wait: async () => ({ ok: true, value: code(command) }) } };
      },
    },
  };
}

test("the Archil disk adapter: a box mounts its run's work/ alone, through the helper by its fixed path, the token on its stdin; the folder is the shared group's; a revoke makes the next mount force a gone box's hold off; an unmount syncs, then checks in", async (t) => {
  const data = realpathSync(await scratch(t));
  const folder = "agents/a-0123456789abcdef/runs/r1/work";
  mkdirSync(join(data, "disk", folder), { recursive: true });
  const archil = { disk: "dsk-00000000000baf76", region: "aws-us-east-1", token: "planted-archil-token-0123456789", gid: process.getgid() };
  const disk = archilDisk(data, archil, { runClaim: () => ({ epoch: 4, holder: "launch" }) });
  const { box, ran } = notingBox();
  const target = { box, path: "/workspace", context: BACKGROUND_CONTEXT };
  const mounted = await disk.mount(archil.disk, folder, target, "tools");
  assert.equal(mounted.path, "/workspace");
  assert.deepEqual(ran.map((r) => [r.command, r.stdin]), [[["sudo", "-n", "/usr/local/sbin/agentrun-archil", "mount", archil.disk, archil.region, folder], `${archil.token}\n`]]);
  assert.equal(statSync(join(data, "disk", folder)).mode & 0o7777, 0o2770);
  assert.equal(await disk.revoke("r1"), 4, "the run's claim is not bumped: its process holds it");
  await disk.mount(archil.disk, folder, target, "tools");
  assert.equal(ran[1].command[3], "revoke", "the mount after a revoke forces the hold off");
  await disk.mount(archil.disk, folder, target, "tools");
  assert.equal(ran[2].command[3], "mount", "and only that one");
  await disk.unmount(mounted);
  assert.deepEqual(ran.slice(3).map((r) => r.command.slice(3)), [["sync"], ["checkin"]]);
  for (const r of ran) assert.ok(!r.command.some((part) => part.includes(archil.token)), "never an argument");
  // Refused before any box call: another disk, a folder that is not a run's work/, a path of this machine, a loop.
  const before = ran.length;
  await assert.rejects(disk.mount("dsk-0000000000000001", folder, target, "tools"), /not dsk-0000000000000001/);
  for (const bad of ["agents/a-0123456789abcdef/runs/r1", "agents/a-0123456789abcdef/runs/r1/store", "agents/a-0123456789abcdef/learning", "agents/../runs/r1/work"]) await assert.rejects(disk.mount(archil.disk, bad, target, "tools"), /mounts its run's work\/ alone/, bad);
  await assert.rejects(disk.mount(archil.disk, folder, "/workspace", "tools"), /in a box, not at a path of this machine/);
  await assert.rejects(disk.mount(archil.disk, folder, target, "loop"), /mounts its run's work\/ alone/);
  assert.equal(ran.length, before);
  // A box whose image has no helper its user may run: said, with what to do.
  const bare = notingBox(() => 1);
  await assert.rejects(disk.mount(archil.disk, folder, { ...target, box: bare.box }, "tools"), /the box has no Archil helper its user may run as root at \/usr\/local\/sbin\/agentrun-archil: use an image or snapshot that ships it/);
});

test("an agent's learning folder is on the disk, in its folder: <data>/disk/agents/<agent>/learning", () => {
  assert.equal(learningRepo("/var/lib/agentrun", "Notes"), join("/var/lib/agentrun", "disk", "agents", folderOf("Notes"), "learning"));
});

test("a data directory an earlier version wrote is refused at start, in words, and nothing is moved: a runs/ folder at its top, or a store of store version 1", async (t) => {
  const withRuns = join(await scratch(t), "with-runs");
  await mkdir(join(withRuns, "runs", "01a1ad00-0000-7000-8000-000000000000"), { recursive: true });
  await assert.rejects(startServe({ data: withRuns, port: 0 }), (error) => {
    assert.match(error.message, /^this data directory was written by an earlier version of AgentRun Server, which kept its runs outside the disk \(.*runs holds runs in an earlier version's layout\): this version keeps every run under .*disk and does not read or move the old ones\. Keep this directory with the earlier version, or start this one on a new data directory \(an empty folder, or a new volume\)\.$/);
    return true;
  });
  assert.ok(existsSync(join(withRuns, "runs", "01a1ad00-0000-7000-8000-000000000000")), "nothing moved");
  assert.equal(existsSync(join(withRuns, "disk")), false, "nothing made");
  const v1 = join(await scratch(t), "v1");
  mkdirSync(v1);
  const db = new DatabaseSync(join(v1, "store.sqlite"));
  db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY); PRAGMA user_version = 1");
  db.close();
  await assert.rejects(startServe({ data: v1, port: 0 }), /an earlier version's store \(store version 1\)/);
  writeFileSync(join(v1, "untouched"), "");
});

test("a take-back whose claim cannot be written (the control plane not writable) checkpoints nothing: the run still settles, its database keeps its WAL, and no read-write open of it is made", { skip: process.getuid?.() === 0 && "root writes a directory of mode 555", timeout: 90_000 }, async (t) => {
  const opens = [];
  t.after(observeRunDbOpens((open) => opens.push(open)));
  const { api, data } = await serve(t, { carryBackRetry: { delaysMs: [50] }, settleRetryMs: 200 });
  assert.equal((await api("POST", "/agents", agent("asks", { tools: ["ask_person"] }))).status, 201);
  const { body: run } = await api("POST", "/agents/asks/runs", { input: { content: "Pick a region." } });
  await follow(api, run.run_id, ["input_required"]);
  const file = join(runDir(data, run.run_id), "store", "run.sqlite");
  // The data directory turns read-only: the agent store's next write cannot make its journal, so no claim is written.
  await chmod(data, 0o555);
  try {
    assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
    const { last } = await follow(api, run.run_id, ["cancelled"]);
    assert.equal(last.final, true, "the run settles all the same");
    assert.deepEqual(opens.filter((open) => open.file === file && open.mode === "checkpoint"), [], "no checkpoint without the server's recorded take-back");
    assert.equal(JSON.parse(claimOf(data, run.run_id).claim_holder).pid > 0, true, "the claim is still its process's on the row");
  } finally {
    await chmod(data, 0o755);
  }
});

test("a workflow run whose claim cannot be written at its launch is launched again once it can, keeping its place in the server's limits meanwhile: it completes, never left without a process", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX, settleRetryMs: 200, maxRuns: 1 });
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  // The run's claim is refused (as by a store another writer holds) from its start until the test lets go.
  const db = new DatabaseSync(join(data, "store.sqlite"));
  t.after(() => db.isOpen && db.close());
  db.exec("CREATE TRIGGER held_claim BEFORE UPDATE OF claim_epoch ON runs BEGIN SELECT RAISE(ABORT, 'the claim is held'); END");
  const run = await api("POST", "/agents/flow/runs", { input: { question: "Answer soon." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(claimOf(data, run.body.run_id).claim_epoch, 0, "no claim written yet, so no process");
  // Its place is kept: with a limit of one run, another start is refused while it waits on its claim.
  const other = await api("POST", "/agents/flow/runs", { input: { question: "And another." } });
  assert.equal(other.status, 429, JSON.stringify(other.body));
  db.exec("DROP TRIGGER held_claim");
  db.close();
  const { last } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.equal(last.final, true);
  assert.ok(claimOf(data, run.body.run_id).claim_epoch >= 1, "claimed by its process once it could be");
});

test("an agentic run whose claim cannot be written at its launch waits for it, its first message with it: once the claim is written it completes, never failed for a process it never had", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX, settleRetryMs: 200 });
  assert.equal((await api("POST", "/agents", agent("asker"))).status, 201);
  const db = new DatabaseSync(join(data, "store.sqlite"));
  t.after(() => db.isOpen && db.close());
  db.exec("CREATE TRIGGER held_claim BEFORE UPDATE OF claim_epoch ON runs BEGIN SELECT RAISE(ABORT, 'the claim is held'); END");
  const run = await api("POST", "/agents/asker/runs", { input: { content: "Answer soon." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // Past the launch's first claim retries (50, 100 and 200 ms): its first message is still waiting, not failed.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(claimOf(data, run.body.run_id).claim_epoch, 0, "no claim written yet, so no process");
  assert.notEqual((await api("GET", `/runs/${run.body.run_id}`)).body.status, "failed", "not failed while it waits on its claim");
  db.exec("DROP TRIGGER held_claim");
  db.close();
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.ok(claimOf(data, run.body.run_id).claim_epoch >= 1, "claimed by its process once it could be");
});

test("a run cancelled while its launch waits on its claim gives its place back at once: the next start takes it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX, settleRetryMs: 60_000, maxRuns: 1 });
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const db = new DatabaseSync(join(data, "store.sqlite"));
  t.after(() => db.isOpen && db.close());
  db.exec("CREATE TRIGGER held_claim BEFORE UPDATE OF claim_epoch ON runs BEGIN SELECT RAISE(ABORT, 'the claim is held'); END");
  const run = await api("POST", "/agents/flow/runs", { input: { question: "Answer soon." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.equal((await api("POST", "/agents/flow/runs", { input: { question: "Too many." } })).status, 429, "its place is kept while it waits");
  assert.equal((await api("POST", `/runs/${run.body.run_id}/cancel`)).status, 202);
  await follow(api, run.body.run_id, ["cancelled"], { deadlineMs: 30_000 });
  // Well before the 60 s retry: the cancelled run holds no place.
  const next = await api("POST", "/agents/flow/runs", { input: { question: "Now." } });
  assert.equal(next.status, 202, JSON.stringify(next.body));
});

