// The boxes runs leave: let go only on the reap's own count, never while the run process that recorded the box lives,
// quarantined when a reap cannot empty them, swept at start before any run opens a box, and let go at archive (a run's
// or its agent's). The box's reap is scripted here; the real one (bwrap's pid namespace, cgroup.kill) is proved where it
// runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BOX_QUARANTINE, Quarantine, settleBox, startTimeOf, sweepBoxes, writerGone } from "../dist/box/sweep.js";
import { agent, follow, serve } from "./support.mjs";

const linux = { skip: process.platform !== "linux" && "reads start times from /proc" };
/** This process: a writer that is alive. */
const ALIVE = { pid: process.pid, startTime: startTimeOf(process.pid) };

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "agentrun-box-sweep-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A writer that was alive and is gone: a process that ran and exited. */
async function goneWriter() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const startTime = await new Promise((resolve) => child.once("spawn", () => resolve(startTimeOf(child.pid))));
  await new Promise((resolve) => child.once("exit", resolve));
  return { pid: child.pid, startTime: startTime ?? "0" };
}

/** A box host scripted per test: every reap and removal recorded, each reap's verdict from `verdict`. */
function host({ verdict = () => ({ empty: true, left: 0, by: "pidns" }), cgroups } = {}) {
  const calls = [];
  return {
    calls,
    reap: async (record) => {
      calls.push(`reap ${record.id}`);
      return verdict(record);
    },
    ...(cgroups ? { cgroups: { list: async () => [...cgroups], remove: async (path) => { calls.push(`remove ${path}`); cgroups.delete(path); } } } : {}),
  };
}

async function runWith(t, record) {
  const dir = await scratch(t);
  const run = join(dir, "run-1");
  await mkdir(run);
  if (record) await writeFile(join(run, "box.json"), `${JSON.stringify(record)}\n`);
  return { dir, run, quarantine: await Quarantine.open(join(dir, BOX_QUARANTINE)) };
}
const stored = async (run) => JSON.parse(await readFile(join(run, "box.json"), "utf8"));

// ---- the writer ------------------------------------------------------------------------------------------------------

test("a record's writer is gone when no process has its pid, or the one that has it started at another time", linux, async () => {
  assert.equal(writerGone(ALIVE), false, "this process");
  assert.equal(writerGone({ pid: process.pid, startTime: "1" }), true, "its pid, reused by another start");
  assert.equal(writerGone(await goneWriter()), true, "a process that exited");
  assert.equal(writerGone(undefined), true, "no writer named");
});

// ---- one run's box -----------------------------------------------------------------------------------------------------

test("a box whose writer, the run process, still lives is that process's: not reaped, not cleared, whatever it records", linux, async (t) => {
  for (const record of [{ id: "box-1", pid: 4242, startTime: "9", writer: ALIVE }, { id: "box-1", writer: ALIVE }]) {
    const { run, quarantine } = await runWith(t, record);
    const h = host({ verdict: () => ({ empty: false, left: 0, by: "none" }) });
    assert.equal(await settleBox(h, quarantine, "run-1", run), "owned");
    assert.deepEqual(h.calls, [], "never reaped under a live writer");
    assert.equal((await stored(run)).reaped, undefined);
  }
});

test("a box whose writer is gone is reaped; empty by the reap's count, its record is marked and its cgroup removed", linux, async (t) => {
  const cgroups = new Set(["/sys/fs/cgroup/agentrun/run-1"]);
  const { run, quarantine } = await runWith(t, { id: "box-1", cgroup: "/sys/fs/cgroup/agentrun/run-1", pid: 4242, startTime: "9", writer: await goneWriter() });
  const h = host({ verdict: () => ({ empty: true, left: 0, by: "pidns" }), cgroups });
  assert.equal(await settleBox(h, quarantine, "run-1", run), "reaped");
  assert.deepEqual(h.calls, ["reap box-1", "remove /sys/fs/cgroup/agentrun/run-1"]);
  assert.equal((await stored(run)).reaped.by, "pidns");
  assert.equal(await settleBox(h, quarantine, "run-1", run), "none", "let go once");
});

test("a box a reap cannot empty is quarantined, its record kept; a later reap that counts it empty lets it go", linux, async (t) => {
  const { dir, run, quarantine } = await runWith(t, { id: "box-1", pid: 4242, startTime: "9", writer: await goneWriter() });
  let left = 2;
  const h = host({ verdict: () => ({ empty: left === 0, left, by: "pidns" }) });
  assert.equal(await settleBox(h, quarantine, "run-1", run), "quarantined");
  assert.equal((await stored(run)).reaped, undefined, "the record is kept");
  const kept = await Quarantine.open(join(dir, BOX_QUARANTINE));
  assert.ok(kept.has("run-1"), "and the quarantine is on disk");
  assert.match(kept.list()[0].why, /left 2 processes/);
  left = 0;
  assert.equal(await settleBox(h, kept, "run-1", run), "reaped");
  assert.equal((await Quarantine.open(join(dir, BOX_QUARANTINE))).has("run-1"), false, "and leaves the quarantine");
});

test("a reap that throws (it could not count) quarantines the box: it is never let go", linux, async (t) => {
  const { run, quarantine } = await runWith(t, { id: "box-1", cgroup: "/sys/fs/cgroup/agentrun/run-1", writer: await goneWriter() });
  const h = host({ verdict: () => { throw new Error("EACCES: cgroup.procs"); } });
  assert.equal(await settleBox(h, quarantine, "run-1", run), "quarantined");
  assert.match(quarantine.list()[0].why, /EACCES/);
  assert.equal((await stored(run)).reaped, undefined);
});

test("a record nothing could count (no pid, no cgroup) is cleared only once its writer is gone, by pid and start time", linux, async (t) => {
  const none = () => ({ empty: false, left: 0, by: "none" });
  const alive = await runWith(t, { id: "box-1", writer: ALIVE });
  assert.equal(await settleBox(host({ verdict: none }), alive.quarantine, "run-1", alive.run), "owned", "its writer may still be starting it");
  assert.equal((await stored(alive.run)).reaped, undefined);
  const reused = await runWith(t, { id: "box-1", writer: { pid: process.pid, startTime: "1" } });
  assert.equal(await settleBox(host({ verdict: none }), reused.quarantine, "run-1", reused.run), "cleared", "a reused pid is not the writer");
  const gone = await runWith(t, { id: "box-1", writer: await goneWriter() });
  assert.equal(await settleBox(host({ verdict: none }), gone.quarantine, "run-1", gone.run), "cleared");
  assert.equal((await stored(gone.run)).reaped.by, "none");
  assert.equal(gone.quarantine.list().length, 0, "and nothing quarantined");
});

test("a record with no pid but a cgroup is reaped through its cgroup", linux, async (t) => {
  const cgroups = new Set(["/sys/fs/cgroup/agentrun/run-1"]);
  const { run, quarantine } = await runWith(t, { id: "box-1", cgroup: "/sys/fs/cgroup/agentrun/run-1", writer: await goneWriter() });
  const seen = [];
  const h = host({ verdict: (r) => (seen.push(r), { empty: true, left: 0, by: "cgroup" }), cgroups });
  assert.equal(await settleBox(h, quarantine, "run-1", run), "reaped");
  assert.equal(seen[0].cgroup, "/sys/fs/cgroup/agentrun/run-1");
  assert.equal(seen[0].pid, undefined);
  assert.ok(!cgroups.has("/sys/fs/cgroup/agentrun/run-1"), "and the cgroup removed");
});

// ---- the start sweep ---------------------------------------------------------------------------------------------------

test("the sweep reaps and removes every run cgroup no record names, and leaves a live run's alone", linux, async (t) => {
  const dir = await scratch(t);
  const live = join(dir, "live");
  await mkdir(live);
  await writeFile(join(live, "box.json"), JSON.stringify({ id: "box-live", cgroup: "/cg/live", pid: 1, startTime: "1", writer: ALIVE }));
  const cgroups = new Set(["/cg/live", "/cg/leftover", "/cg/stuck"]);
  const h = host({ cgroups, verdict: (r) => (r.cgroup === "/cg/stuck" ? { empty: false, left: 3, by: "cgroup" } : { empty: true, left: 0, by: "cgroup" }) });
  const quarantine = await Quarantine.open(join(dir, BOX_QUARANTINE));
  const settled = await sweepBoxes(h, quarantine, [{ id: "live", dir: live }]);
  assert.equal(settled.live, "owned");
  assert.ok(!h.calls.includes("reap box-live") && cgroups.has("/cg/live"), "the live run's cgroup is untouched");
  assert.ok(h.calls.includes("remove /cg/leftover") && !cgroups.has("/cg/leftover"), "a leftover cgroup is reaped and removed");
  assert.ok(cgroups.has("/cg/stuck") && quarantine.has("cgroup:/cg/stuck"), "one a reap cannot empty is quarantined, not removed");
});

// ---- through serve -----------------------------------------------------------------------------------------------------

/** A finished run's directory given a box record (as its process's box start writes it), then serve again with `box`. */
async function servedWithRecord(t, record, box) {
  const first = await serve(t);
  assert.equal((await first.api("POST", "/agents", agent("plain"))).status, 201);
  const id = (await first.api("POST", "/agents/plain/runs", { input: { content: "What is 2 + 2?" } })).body.run_id;
  await follow(first.api, id, ["completed"]);
  await first.close();
  const runDir = join(first.data, "runs", id);
  await writeFile(join(runDir, "box.json"), `${JSON.stringify({ id: `box-${id}`, ...record })}\n`);
  const second = await serve(t, { data: first.data, box });
  return { ...second, id, runDir };
}

test("no run starts a box before the start sweep has let go what earlier runs left", linux, async (t) => {
  const order = [];
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const box = { reap: async () => { order.push("sweep reaping"); await held; order.push("sweep done"); return { empty: true, left: 0, by: "pidns" }; } };
  const { api } = await servedWithRecord(t, { pid: 4242, startTime: "9", writer: await goneWriter() }, box);
  const created = api("POST", "/agents/plain/runs", { input: { content: "And 3 + 3?" } }).then((r) => (order.push("run created"), r));
  // Released after a while, or as soon as the start returns without waiting (the bug this guards against).
  await Promise.race([created, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  release();
  const run = await created;
  assert.equal(run.status, 202);
  assert.deepEqual(order, ["sweep reaping", "sweep done", "run created"]);
  await follow(api, run.body.run_id, ["completed"]);
});

test("archiving a run lets its box go; archiving an agent lets every one of its runs' boxes go", linux, async (t) => {
  const reaped = [];
  const box = { reap: async (r) => (reaped.push(r.id), { empty: true, left: 0, by: "pidns" }) };
  // The sweep at start reaps the record (its writer is gone); a new record, as a later box would leave, is the archive's.
  const one = await servedWithRecord(t, { pid: 4242, startTime: "9", writer: await goneWriter() }, box);
  await one.api("GET", "/runs");
  await writeFile(join(one.runDir, "box.json"), `${JSON.stringify({ id: "box-later", pid: 4243, startTime: "9", writer: await goneWriter() })}\n`);
  assert.equal((await one.api("POST", `/runs/${one.id}/archive`)).status, 200);
  assert.ok(reaped.includes("box-later"), `the run archive reaped it: ${reaped}`);
  assert.equal((await stored(one.runDir)).reaped.by, "pidns");
  // The run itself unarchived: only its agent's archive archives it now.
  assert.equal((await one.api("POST", `/runs/${one.id}/unarchive`)).status, 200);
  await writeFile(join(one.runDir, "box.json"), `${JSON.stringify({ id: "box-agent", pid: 4244, startTime: "9", writer: await goneWriter() })}\n`);
  assert.equal((await one.api("POST", "/agents/plain/archive")).status, 200);
  assert.ok(reaped.includes("box-agent"), `the agent archive reaped its run's box: ${reaped}`);
});
