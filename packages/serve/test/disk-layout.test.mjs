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
import { checkpointRunDb, HeldRunDbError, MonotonicReads, BehindReadError, observeRunDbOpens } from "../dist/run-db.js";
import { localDisk } from "../dist/disk.js";
import { learningRepo } from "../dist/learning.js";
import { agent, follow, runDir, scratch, serve } from "./support.mjs";

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

test("the local disk adapter: mount gives a runner the folder itself, below the disk and through no link; sync and unmount; revoke bumps the run's epoch with the server as holder", async (t) => {
  const data = realpathSync(await scratch(t));
  const work = join(data, "disk", "agents", "a-0123456789abcdef", "runs", "r1", "work");
  mkdirSync(work, { recursive: true });
  const claimed = [];
  const disk = localDisk(data, { claimRun: (runId, holder) => (claimed.push([runId, holder]), claimed.length + 1) });
  const mounted = await disk.mount("agents/a-0123456789abcdef/runs/r1/work", undefined, "tools");
  assert.deepEqual(mounted, { subpath: "agents/a-0123456789abcdef/runs/r1/work", path: work, mode: "tools" });
  await disk.sync(mounted);
  await disk.unmount(mounted);
  assert.equal(await disk.revoke("r1"), 2);
  assert.deepEqual(claimed, [["r1", "server"]]);
  for (const bad of ["", "/etc", "agents/../../x", "agents/./a"]) await assert.rejects(disk.mount(bad, undefined, "tools"), /is not a path below the disk/, bad);
  symlinkSync(work, join(data, "disk", "agents", "linked"));
  await assert.rejects(disk.mount("agents/linked", undefined, "tools"), /is a link/);
  await assert.rejects(disk.mount("agents/a-0123456789abcdef/runs/r1/work", "/workspace", "tools"), /mounts .* where it is, not at \/workspace/);
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
    assert.equal(claimOf(data, run.run_id).claim_holder, "run-process", "the claim is still its process's on the row");
  } finally {
    await chmod(data, 0o755);
  }
});
