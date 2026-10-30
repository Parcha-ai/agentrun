// The boxes runs leave: let go only on the reap's own count, never while the run process that recorded the box lives,
// quarantined when a reap cannot empty them, swept at start before any run opens a box, and let go at archive (a run's
// or its agent's). The box's reap is scripted here; the real one (bwrap's pid namespace, cgroup.kill) is proved where it
// runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
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
  assert.ok(kept.has("run-1/box-1"), "and the quarantine is on disk, by the run and its box");
  assert.match(kept.list()[0].why, /left 2 processes/);
  left = 0;
  assert.equal(await settleBox(h, kept, "run-1", run), "reaped");
  assert.equal((await Quarantine.open(join(dir, BOX_QUARANTINE))).has("run-1/box-1"), false, "and leaves the quarantine");
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

test("a cgroup the reap already removed is let go, not failed: a box's record is marked and a leftover is not held", linux, async (t) => {
  // bwrapBox's reap removes a cgroup it emptied, so serve's removal after it finds none (ENOENT): the removal is done.
  const dir = await scratch(t);
  const run = join(dir, "run-1");
  await mkdir(run);
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-1", cgroup: "/cg/run-1", pid: 4242, startTime: "9", writer: await goneWriter() }));
  const cgroups = new Set(["/cg/run-1", "/cg/leftover"]);
  const removed = [];
  const h = {
    reap: async (record) => (cgroups.delete(record.cgroup), { empty: true, left: 0, by: "cgroup" }),
    cgroups: {
      list: async () => [...cgroups],
      remove: async (path) => {
        removed.push(path);
        if (!cgroups.delete(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, rmdir '${path}'`), { code: "ENOENT" });
      },
    },
  };
  const quarantine = await Quarantine.open(join(dir, BOX_QUARANTINE));
  const settled = await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.equal(settled["run-1"], "reaped", "the run's box is let go");
  assert.equal((await stored(run)).reaped.by, "cgroup", "its record is marked reaped");
  assert.deepEqual(removed.sort(), ["/cg/leftover", "/cg/run-1"], "each removal found the cgroup already gone");
  assert.equal(quarantine.has("cgroup:/cg/leftover"), false, "the leftover is not held");
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

test("a start sweep that fails once is tried again by the next run, not kept: one transient error never holds every run back until a restart", linux, async (t) => {
  let lists = 0;
  const box = {
    reap: async () => ({ empty: true, left: 0, by: "pidns" }),
    cgroups: {
      list: async () => {
        if (lists++ === 0) throw Object.assign(new Error("EIO: i/o error, scandir '/cg'"), { code: "EIO" });
        return [];
      },
      remove: async () => {},
    },
  };
  const { api } = await servedWithRecord(t, { pid: 4242, startTime: "9", writer: await goneWriter() }, box);
  const first = await api("POST", "/agents/plain/runs", { input: { content: "And 3 + 3?" } });
  assert.notEqual(first.status, 202, `the run the failed sweep was for is not started: ${JSON.stringify(first.body)}`);
  const second = await api("POST", "/agents/plain/runs", { input: { content: "And 4 + 4?" } });
  assert.equal(second.status, 202, `the next run sweeps again and starts: ${JSON.stringify(second.body)}`);
  assert.equal(lists, 2, "swept twice: once failed, once whole");
  await follow(api, second.body.run_id, ["completed"]);
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


// ---- what the first pass of review found untested ------------------------------------------------------------------

test("a process's start time is /proc's field 22, the clock ticks since boot it started at: non-zero, and later for a later process", linux, async () => {
  const stat = readFileSync("/proc/self/stat", "utf8");
  // Its own parse: the fields after the command's closing parenthesis, the state first (field 3), so field 22 is 19 on.
  const own = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[22 - 3];
  assert.equal(startTimeOf(process.pid), own);
  assert.ok(Number(own) > 0, "never a field that reads 0");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    assert.ok(Number(startTimeOf(child.pid)) >= Number(own), "a later process started no earlier");
    assert.ok(Number(startTimeOf(child.pid)) > 0);
  } finally {
    child.kill("SIGKILL");
  }
});

test("a quarantined run's cgroup is that run's: the sweep quarantines it once, by the run, never again as a leftover", linux, async (t) => {
  const dir = await scratch(t);
  const run = join(dir, "run-1");
  await mkdir(run);
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-1", cgroup: "/cg/run-1", pid: 4242, startTime: "9", writer: await goneWriter() }));
  const cgroups = new Set(["/cg/run-1"]);
  const h = host({ cgroups, verdict: () => ({ empty: false, left: 2, by: "cgroup" }) });
  const quarantine = await Quarantine.open(join(dir, BOX_QUARANTINE));
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.deepEqual(quarantine.list().map((e) => e.key), ["run-1/box-1"], "one entry, the run's box");
  assert.deepEqual(h.calls, ["reap box-1"], "reaped once, by its record");
  assert.ok(cgroups.has("/cg/run-1"), "and its cgroup kept");
});

test("a leftover cgroup whose reap throws is quarantined, never removed: a reap that could not count never lets go", linux, async (t) => {
  const dir = await scratch(t);
  const cgroups = new Set(["/cg/leftover"]);
  const h = host({ cgroups, verdict: () => { throw new Error("EACCES: cgroup.procs"); } });
  const quarantine = await Quarantine.open(join(dir, BOX_QUARANTINE));
  await sweepBoxes(h, quarantine, []);
  assert.ok(quarantine.has("cgroup:/cg/leftover"));
  assert.ok(!h.calls.some((c) => c.startsWith("remove")), `never removed: ${h.calls}`);
  assert.ok(cgroups.has("/cg/leftover"));
});

/** Each spawn of a run's process, by its run directory, in `order`, from now until the test ends. */
function spawnsInto(t, order) {
  const cp = createRequire(import.meta.url)("node:child_process");
  const real = cp.spawn;
  cp.spawn = function (command, args, ...rest) {
    const dir = Array.isArray(args) ? args[args.indexOf("--dir") + 1] : undefined;
    if (args?.includes("run") && dir) order.push(`spawn ${dir.split("/").at(-1)}`);
    return real.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    cp.spawn = real;
    syncBuiltinESMExports();
  });
}

/** A box host whose reap is held until `release()`, recording when it began and ended. */
function heldReap(order) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  return { release, box: { reap: async (r) => { order.push(`reap ${r.id}`); await held; order.push(`reaped ${r.id}`); return { empty: true, left: 0, by: "pidns" }; } } };
}

test("a follow-up that opens an ended run again waits for the start sweep, when it is the server's first act", linux, async (t) => {
  const first = await serve(t);
  assert.equal((await first.api("POST", "/agents", agent("plain"))).status, 201);
  const id = (await first.api("POST", "/agents/plain/runs", { input: { content: "What is 2 + 2?" } })).body.run_id;
  await follow(first.api, id, ["completed"]);
  await first.close();
  await writeFile(join(first.data, "runs", id, "box.json"), JSON.stringify({ id: "box-old", pid: 4242, startTime: "9", writer: await goneWriter() }));
  const order = [];
  const { release, box } = heldReap(order);
  spawnsInto(t, order);
  const second = await serve(t, { data: first.data, box });
  const sent = second.api("POST", `/runs/${id}/messages`, { content: "And 3 + 3?" });
  await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  release();
  assert.equal((await sent).status, 202);
  await follow(second.api, id, ["completed"]);
  assert.ok(order.indexOf("reaped box-old") >= 0 && order.indexOf("reaped box-old") < order.indexOf(`spawn ${id}`), `the sweep before the run's process: ${order}`);
});

test("a run the server finds left running is opened again only after the start sweep", linux, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data });
  assert.equal((await first.api("POST", "/agents", agent("asks", { tools: ["ask_person"] }))).status, 201);
  const id = (await first.api("POST", "/agents/asks/runs", { input: { content: "Pick a region." } })).body.run_id;
  await follow(first.api, id, ["input_required"]);
  // Its process killed with the server's: the run is left running, for the next start to open again.
  const pid = JSON.parse(await readFile(join(data, "runs", id, "run.json"), "utf8")).holder.pid;
  process.kill(pid, "SIGKILL");
  await first.close();
  await writeFile(join(data, "runs", id, "box.json"), JSON.stringify({ id: "box-left", pid: 4242, startTime: "9", writer: await goneWriter() }));
  const order = [];
  const { release, box } = heldReap(order);
  spawnsInto(t, order);
  const second = await serve(t, { data, box });
  const answered = second.api("POST", `/runs/${id}/messages`, { content: "eu" });
  await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  release();
  await answered;
  await follow(second.api, id, ["completed"]);
  assert.ok(order.indexOf("reaped box-left") >= 0 && order.indexOf("reaped box-left") < order.indexOf(`spawn ${id}`), `the sweep before the run opened again: ${order}`);
});

test("archiving one run lets go of that run's box only: another run's record and cgroup are left alone", linux, async (t) => {
  const cgroups = new Set();
  const reaped = [];
  const box = { reap: async (r) => (reaped.push(r.id), { empty: true, left: 0, by: "pidns" }), cgroups: { list: async () => [...cgroups], remove: async (path) => void cgroups.delete(path) } };
  const { api, data } = await serve(t, { box });
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const ids = [];
  for (const q of ["What is 2 + 2?", "And 3 + 3?"]) {
    const id = (await api("POST", "/agents/plain/runs", { input: { content: q } })).body.run_id;
    await follow(api, id, ["completed"]);
    ids.push(id);
  }
  const [a, b] = ids;
  for (const id of ids) {
    cgroups.add(`/cg/${id}`);
    await writeFile(join(data, "runs", id, "box.json"), JSON.stringify({ id: `box-${id}`, cgroup: `/cg/${id}`, pid: 4242, startTime: "9", writer: await goneWriter() }));
  }
  assert.equal((await api("POST", `/runs/${a}/archive`)).status, 200);
  assert.deepEqual(reaped, [`box-${a}`], "only the archived run's box");
  assert.equal(JSON.parse(await readFile(join(data, "runs", b, "box.json"), "utf8")).reaped, undefined, "the other's record is unmarked");
  assert.ok(cgroups.has(`/cg/${b}`) && !cgroups.has(`/cg/${a}`), "and its cgroup in place");
});

test("an archived run that is still live has its box let go when its process exits, not at the next start", linux, async (t) => {
  const reaped = [];
  const box = { reap: async (r) => (reaped.push(r.id), { empty: true, left: 0, by: "pidns" }) };
  const { api, data } = await serve(t, { box });
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const go = join(data, "go-live");
  const id = (await api("POST", "/agents/busy/runs", { input: { content: `Answer once ${go} exists.` } })).body.run_id;
  for (const deadline = Date.now() + 10_000; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const record = JSON.parse(await readFile(join(data, "runs", id, "run.json"), "utf8").catch(() => "null"));
    if (record?.holder?.pid) break;
    assert.ok(Date.now() < deadline, "the run's process came up");
  }
  // The record its box would leave; its writer stands in for the run process, gone once that exits.
  await writeFile(join(data, "runs", id, "box.json"), JSON.stringify({ id: "box-live", pid: 4242, startTime: "9", writer: await goneWriter() }));
  assert.equal((await api("POST", `/runs/${id}/archive`)).status, 200);
  assert.deepEqual(reaped, [], "a live run's box is its process's while it lives");
  await writeFile(go, "");
  await follow(api, id, ["completed"]);
  const mark = async () => JSON.parse(await readFile(join(data, "runs", id, "box.json"), "utf8")).reaped;
  for (const deadline = Date.now() + 10_000; !(await mark()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < deadline, `let go when its process exited: ${reaped}`);
  assert.deepEqual(reaped, ["box-live"]);
  assert.equal((await mark()).by, "pidns");
});


// ---- Greptile's three (2026-10-30) ----------------------------------------------------------------------------------

test("a run's quarantined box stays held when the run opens a new one: the sweep tries it again by its own record, and the new box's reap never clears it", linux, async (t) => {
  const dir = await scratch(t);
  const run = join(dir, "run-1");
  await mkdir(run);
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-a", pid: 4242, startTime: "9", writer: await goneWriter() }));
  let aLeft = 2;
  const h = host({ verdict: (r) => (r.id === "box-a" ? { empty: aLeft === 0, left: aLeft, by: "pidns" } : { empty: true, left: 0, by: "pidns" }) });
  const quarantine = await Quarantine.open(join(dir, BOX_QUARANTINE));
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.deepEqual(quarantine.list().map((e) => e.key), ["run-1/box-a"]);
  // The run opens again: its box start replaces box.json with the new box's record.
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-b", pid: 5151, startTime: "9", writer: await goneWriter() }));
  h.calls.length = 0;
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.ok(h.calls.includes("reap box-b") && h.calls.includes("reap box-a"), `both boxes reaped, each by its record: ${h.calls}`);
  assert.deepEqual(quarantine.list().map((e) => e.key), ["run-1/box-a"], "the old box still held; the new one's empty reap cleared nothing of it");
  aLeft = 0;
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.deepEqual(quarantine.list(), [], "let go once its own reap counts it empty");
});

test("a quarantined box whose later reap empties and removes its cgroup is let go: the removal after it finds none, and that is done", linux, async (t) => {
  const dir = await scratch(t);
  const run = join(dir, "run-1");
  await mkdir(run);
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-a", cgroup: "/cg/a", pid: 4242, startTime: "9", writer: await goneWriter() }));
  const cgroups = new Set(["/cg/a"]);
  const removed = [];
  let aLeft = 2;
  const h = {
    // bwrapBox's reap removes a cgroup it empties.
    reap: async (record) => (record.id === "box-a" && aLeft === 0 && cgroups.delete(record.cgroup), { empty: record.id !== "box-a" || aLeft === 0, left: record.id === "box-a" ? aLeft : 0, by: "cgroup" }),
    cgroups: {
      list: async () => [...cgroups],
      remove: async (path) => {
        removed.push(path);
        if (!cgroups.delete(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, rmdir '${path}'`), { code: "ENOENT" });
      },
    },
  };
  const quarantine = await Quarantine.open(join(dir, BOX_QUARANTINE));
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.deepEqual(quarantine.list().map((e) => e.key), ["run-1/box-a"], "held: its reap left processes");
  // The run opens again with a box of no cgroup; the held box's own reap now empties it and removes its cgroup.
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-b", pid: 5151, startTime: "9", writer: await goneWriter() }));
  aLeft = 0;
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.deepEqual(quarantine.list(), [], "let go");
  assert.deepEqual(removed, ["/cg/a"], "its removal found the cgroup already gone");
});

test("a run's boxes share its cgroup: an old box's empty reap leaves the cgroup in place while the run's current box names it", linux, async (t) => {
  const dir = await scratch(t);
  const run = join(dir, "run-1");
  await mkdir(run);
  const cgroups = new Set(["/cg/run-1"]);
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-a", cgroup: "/cg/run-1", pid: 4242, startTime: "9", writer: await goneWriter() }));
  let aLeft = 1;
  const h = host({ cgroups, verdict: (r) => (r.id === "box-a" ? { empty: aLeft === 0, left: aLeft, by: "pidns" } : { empty: true, left: 0, by: "pidns" }) });
  const quarantine = await Quarantine.open(join(dir, BOX_QUARANTINE));
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.ok(quarantine.has("run-1/box-a"));
  // The run's next box, live (its writer is this process), in the same cgroup.
  await writeFile(join(run, "box.json"), JSON.stringify({ id: "box-b", cgroup: "/cg/run-1", pid: 5151, startTime: "9", writer: ALIVE }));
  aLeft = 0;
  await sweepBoxes(h, quarantine, [{ id: "run-1", dir: run }]);
  assert.equal(quarantine.has("run-1/box-a"), false, "the old box let go");
  assert.ok(cgroups.has("/cg/run-1"), `and the cgroup the live box names left in place: ${h.calls}`);
  assert.ok(!h.calls.includes("remove /cg/run-1"));
});

test("quarantine saves made at once all land: every entry is on disk, none lost and none refused", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, BOX_QUARANTINE);
  const quarantine = await Quarantine.open(file);
  await Promise.all(Array.from({ length: 25 }, (_, i) => quarantine.add(`run-${i}/box-${i}`, { id: `box-${i}`, writer: { pid: 1, startTime: "1" } }, "held")));
  const reread = await Quarantine.open(file);
  assert.equal(reread.list().length, 25);
  for (let i = 0; i < 25; i++) assert.ok(reread.has(`run-${i}/box-${i}`), `run-${i}`);
});

test("an archived run whose process dies while it waits for the person has its box let go then, not at the next start", linux, async (t) => {
  const reaped = [];
  const box = { reap: async (r) => (reaped.push(r.id), { empty: true, left: 0, by: "pidns" }) };
  const { api, data } = await serve(t, { box });
  assert.equal((await api("POST", "/agents", agent("asks", { tools: ["ask_person"] }))).status, 201);
  const id = (await api("POST", "/agents/asks/runs", { input: { content: "Pick a region." } })).body.run_id;
  await follow(api, id, ["input_required"]);
  const pid = JSON.parse(await readFile(join(data, "runs", id, "run.json"), "utf8")).holder.pid;
  await writeFile(join(data, "runs", id, "box.json"), JSON.stringify({ id: "box-waiting", pid: 4242, startTime: "9", writer: await goneWriter() }));
  assert.equal((await api("POST", `/runs/${id}/archive`)).status, 200);
  assert.deepEqual(reaped, [], "its process lives, so its box is its own");
  process.kill(pid, "SIGKILL");
  const mark = async () => JSON.parse(await readFile(join(data, "runs", id, "box.json"), "utf8")).reaped;
  for (const deadline = Date.now() + 15_000; !(await mark()); await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < deadline, `let go once its process died: ${reaped}`);
  assert.deepEqual(reaped, ["box-waiting"]);
});


test("a box that cannot be let go never holds up its run's end: an archived run that completes is carried back, its box tried again later", linux, async (t) => {
  const reaped = [];
  const box = {
    reap: async (r) => (reaped.push(r.id), { empty: true, left: 0, by: "cgroup" }),
    cgroups: { list: async () => [], remove: async () => { throw new Error("EBUSY: cgroup removal refused"); } },
  };
  const { api, data } = await serve(t, { box });
  assert.equal((await api("POST", "/agents", agent("busy"))).status, 201);
  const go = join(data, "go-stuck");
  const id = (await api("POST", "/agents/busy/runs", { input: { content: `Answer once ${go} exists.` } })).body.run_id;
  for (const deadline = Date.now() + 10_000; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const record = JSON.parse(await readFile(join(data, "runs", id, "run.json"), "utf8").catch(() => "null"));
    if (record?.holder?.pid) break;
    assert.ok(Date.now() < deadline, "the run's process came up");
  }
  await writeFile(join(data, "runs", id, "box.json"), JSON.stringify({ id: "box-stuck", cgroup: "/cg/stuck", writer: await goneWriter() }));
  assert.equal((await api("POST", `/runs/${id}/archive`)).status, 200);
  await writeFile(go, "");
  const { last } = await follow(api, id, ["completed"], { deadlineMs: 20_000 });
  assert.equal(last.status, "completed", "carried back, whatever its box's cleanup did");
  assert.ok(reaped.includes("box-stuck"), "its box was reaped");
  assert.equal(JSON.parse(await readFile(join(data, "runs", id, "box.json"), "utf8")).reaped, undefined, "its record left unmarked, for the next start to try again");
});

test("an archived run that is then cancelled has its box let go once the cancel settles", linux, async (t) => {
  const reaped = [];
  const box = { reap: async (r) => (reaped.push(r.id), { empty: true, left: 0, by: "pidns" }) };
  const { api, data } = await serve(t, { box });
  assert.equal((await api("POST", "/agents", agent("asks", { tools: ["ask_person"] }))).status, 201);
  const id = (await api("POST", "/agents/asks/runs", { input: { content: "Pick a region." } })).body.run_id;
  await follow(api, id, ["input_required"]);
  await writeFile(join(data, "runs", id, "box.json"), JSON.stringify({ id: "box-cancelled", pid: 4242, startTime: "9", writer: await goneWriter() }));
  assert.equal((await api("POST", `/runs/${id}/archive`)).status, 200);
  assert.deepEqual(reaped, [], "its process lives, so its box is its own");
  assert.equal((await api("POST", `/runs/${id}/cancel`)).status, 202);
  await follow(api, id, ["cancelled"]);
  const mark = async () => JSON.parse(await readFile(join(data, "runs", id, "box.json"), "utf8")).reaped;
  for (const deadline = Date.now() + 15_000; !(await mark()); await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < deadline, `let go once the cancel settled: ${reaped}`);
  assert.deepEqual(reaped, ["box-cancelled"]);
});
