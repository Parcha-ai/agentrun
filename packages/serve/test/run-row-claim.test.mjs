// The run's row is the whole lock (store.sqlite's claim_epoch and claim_holder): a run's process writes no run.json and no
// owner.lock; a server that finds a run whose holder is gone takes it over by the row, whatever a file beside it says;
// and a takeover kills a holder that still lives before it bumps the epoch, so that process never commits after it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive as alive } from "@parcha/agentrun-kernel/host";
import { openStore } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { runHolderTestHooks } from "../dist/run-holder.js";
import { procTable } from "../../pi-durable-disk/dist/process-table.js";
import { agent, client, FAUX, follow, runDir, scratch, serve, storeRun } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every path below `dir` whose name is one of `names`. */
const named = (dir, names) => readdirSync(dir, { recursive: true }).filter((path) => names.includes(path.split("/").at(-1)));

/** The run's claim as its row holds it. */
const claimOf = (data, runId) => {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return { ...db.prepare("SELECT claim_epoch, claim_holder FROM runs WHERE id = ?").get(runId) };
  } finally {
    db.close();
  }
};

/** The pid of the process running the run in `dir`, found by its command line (`run --dir <dir>`), whatever it wrote. */
const processOf = (dir) => {
  const lines = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n");
  const pids = lines.filter((line) => line.includes(" run --dir ") && line.includes(`--dir ${dir} `)).map((line) => Number(line.trim().split(/\s+/)[0]));
  return pids.length === 1 ? pids[0] : undefined;
};

/** Kill `pid` with SIGKILL and wait until it is gone. */
async function killed(pid) {
  if (alive(pid)) process.kill(pid, "SIGKILL");
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 200, `${pid} exits on SIGKILL`);
    await sleep(50);
  }
}

/** A server in a process of its own, killable as a crash kills it; ready once its banner is out. */
async function serverProcess(t, data) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: dirname(data) } });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (/^AGENTRUN_API_KEY=.*\n/m.test(out) && /^AGENTRUN_BASE_URL=\S+\n/m.test(out)) resolve();
    });
    child.once("exit", (code, signal) => reject(new Error(`the server exited before it listened (${signal ?? code}): ${out}`)));
  });
  return { child, api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], (await readFile(join(data, ".token"), "utf8")).trim()) };
}

/** A run of a new agent started in a server process, its process up and its turn under way; then the server is killed
 *  as a crash kills it, the run's process left behind. */
async function crashMidRun(t) {
  const data = join(await scratch(t), "agents");
  const first = await serverProcess(t, data);
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await first.api("POST", "/agents/calc/runs", { input: { content: "Answer soon." } });
  const dir = runDir(data, run.run_id);
  let pid;
  for (let i = 0; !(pid = processOf(dir)); i++) {
    assert.ok(i < 400, "the run's process starts");
    await sleep(50);
  }
  // Its turn under way: it served (so its launch came through), and the crash cuts work in flight.
  for (let after = 0; ; ) {
    const { body: page } = await first.api("GET", `/runs/${run.run_id}/timeline?${new URLSearchParams({ ...(after ? { after: String(after) } : {}), wait_ms: "2000" })}`);
    if (page.status === "working" && page.state === "working") break;
    assert.ok(!["completed", "failed", "cancelled"].includes(page.status), `the run ended ${page.status} before it worked`);
    after = page.next_after;
  }
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  t.after(() => alive(pid) && process.kill(pid, "SIGKILL"));
  return { data, runId: run.run_id, dir, pid };
}

/** A process that stays alive, as a stand-in for a holder; its pid. */
function standIn(t, env, script = "setInterval(() => {}, 1000)") {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, ...env } });
  t.after(() => child.kill("SIGKILL"));
  return child;
}

test("a run's process writes no run.json and no owner.lock: after a run, there is none anywhere on the disk", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: PROBE });
  const made = await api("POST", "/agents", { definition: { id: "writer", name: "writer", instructions: "Probe.", tools: ["read", "write"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/writer/runs", { input: { content: JSON.stringify({ probe: [{ tool: "write", args: { path: "out.txt", content: "done" } }] }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(named(join(data, "disk"), ["run.json", "run.json.tmp", "owner.lock"]), [], "no lease file under the disk");
});

test("a run whose holder is gone is taken over by its row, whatever a run.json beside it says: a fresh heartbeat naming a live process and a door changes nothing", { timeout: 120_000 }, async (t) => {
  const { data, runId, dir, pid } = await crashMidRun(t);
  await killed(pid);
  // A record that reads as a live lease: running, a heartbeat of now, a live process (not the run's) and a door.
  const other = standIn(t, undefined);
  const record = { run: runId, status: "running", generation: 1, sealedSeq: null, wakeAt: null, detail: null, heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString(), holder: { driver: "local", host: "here", bootId: null, pid: other.pid, since: new Date().toISOString(), serve: "http://127.0.0.1:9" } };
  writeFileSync(join(dir, "run.json.tmp"), JSON.stringify(record));
  await rename(join(dir, "run.json.tmp"), join(dir, "run.json"));
  const before = claimOf(data, runId).claim_epoch;
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 40_000 });
  assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${runId}`)).body.error ?? last));
  assert.ok(claimOf(data, runId).claim_epoch > before, "taken over: its epoch bumped");
  assert.ok(alive(other.pid), "the process the file named was never the run's, and is left alone");
});

for (const named of ["its pid", "a launch not yet named"]) test(`a takeover kills a holder that still lives (the row names ${named}) before it bumps the epoch: that process never commits to the run's store after it`, { skip: process.platform !== "linux" && "reads /proc", timeout: 120_000 }, async (t) => {
  const { data, runId, dir, pid } = await crashMidRun(t);
  await killed(pid);
  const store = join(dir, "store", "run.sqlite");
  // A holder that lives and serves no door: it holds the run's store as the run's process does, and commits a row every
  // 100 ms for as long as it lives.
  // A launch the row still names (its server went before it named the process) is found by its mark: <run>:<epoch>.
  const epochNow = claimOf(data, runId).claim_epoch;
  const holder = standIn(t, named === "its pid" ? undefined : { AGENTRUN_RUN_LAUNCH: `${runId}:${epochNow}` }, `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(store)});
    db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS stale_holder(at INTEGER)");
    setInterval(() => db.prepare("INSERT INTO stale_holder VALUES (?)").run(Date.now()), 100);
  `);
  for (let i = 0; !existsSync(`${store}-wal`) || i < 5; i++) await sleep(100);
  const start = readFileSync(`/proc/${holder.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const db = new DatabaseSync(join(data, "store.sqlite"));
  db.prepare("UPDATE runs SET claim_holder = ? WHERE id = ?").run(named === "its pid" ? JSON.stringify({ pid: holder.pid, start: Number(start), boot }) : "launching", runId);
  db.close();
  const before = claimOf(data, runId).claim_epoch;
  // Every claim the next server makes, as it makes it: whether the holder still lived then, and when.
  const claims = [];
  const scratchStore = openStore(join(await scratch(t), "probe"));
  const proto = Object.getPrototypeOf(scratchStore);
  scratchStore.close?.();
  const claimRun = proto.claimRun;
  proto.claimRun = function (...args) {
    claims.push({ at: Date.now(), holderLived: alive(holder.pid) });
    return claimRun.apply(this, args);
  };
  t.after(() => void (proto.claimRun = claimRun));
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", readyTimeoutMs: 3_000 });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 40_000 });
  assert.equal(alive(holder.pid), false, "the holder that lived was killed");
  assert.ok(claims.length > 0 && claims.every((claim) => !claim.holderLived), `killed before any claim: ${JSON.stringify(claims)}`);
  const kept = new DatabaseSync(store, { readOnly: true });
  const lastCommit = Number(kept.prepare("SELECT max(at) AS at FROM stale_holder").get().at);
  kept.close();
  assert.ok(lastCommit < claims[0].at, "its last commit came before the first claim over it");
  assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${runId}`)).body.error ?? last));
  assert.ok(claimOf(data, runId).claim_epoch > before, "taken over: its epoch bumped");
  assert.equal(storeRun(data, runId).state, "completed");
});

test("a watch of an adopted run whose poll fails (the agent store held by another writer) keeps watching: the server stays up, and the run is taken over once the store is free", { skip: process.platform !== "linux" && "reads /proc", timeout: 120_000 }, async (t) => {
  const { data, runId, pid } = await crashMidRun(t);
  await killed(pid);
  // A holder that lives and serves no door: the next server adopts it and polls its row while it waits for a door.
  const holder = standIn(t, undefined);
  const start = readFileSync(`/proc/${holder.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const control = new DatabaseSync(join(data, "store.sqlite"));
  control.prepare("UPDATE runs SET claim_holder = ? WHERE id = ?").run(JSON.stringify({ pid: holder.pid, start: Number(start), boot }), runId);
  control.close();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", readyTimeoutMs: 3_000 });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 200, "adopted");
  // Another writer holds the agent store for a while: the watch's reads of the run's row fail.
  const held = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  held.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
  await sleep(2_500);
  held.exec("COMMIT");
  held.close();
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 40_000 });
  assert.deepEqual(unhandled, [], "no failed poll went unhandled");
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.equal(alive(holder.pid), false, "taken over: the holder that named no door was killed");
});

/** Every line this process writes to stderr from now until the test ends (the in-process server's warnings). */
function stderrLines(t) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => (process.stderr.write = write));
  return lines;
}

/** A process table that cannot be read: every look throws, as ps can on macOS. */
const failingTable = { snapshot: () => { throw new Error("the process listing cannot be read"); }, bootId: () => undefined, walkMs: 0 };

test("an adopted process whose pid now names another process (another start) gets no signal when the run is stopped", { skip: process.platform !== "linux" && "reads /proc", timeout: 120_000 }, async (t) => {
  const { data, runId, pid } = await crashMidRun(t);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 200, "adopted");
  // From here its pid reads as another process's: the same pid, another start.
  const real = procTable();
  runHolderTestHooks.table = { ...real, snapshot: () => {
    const look = real.snapshot();
    return { ...look, info: (asked) => { const info = look.info(asked); return asked === pid && info ? { ...info, start: info.start + 1 } : info; } };
  } };
  t.after(() => delete runHolderTestHooks.table);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await sleep(1_500);
  assert.ok(alive(pid), "the process its pid now names got no SIGTERM");
});

test("a settle that cannot tell who holds the run (the process listing fails) neither takes it back nor opens it again; once it can, the run goes on", { timeout: 120_000 }, async (t) => {
  const { data, runId, pid } = await crashMidRun(t);
  await killed(pid);
  const control = new DatabaseSync(join(data, "store.sqlite"));
  control.prepare("UPDATE runs SET claim_holder = ? WHERE id = ?").run("launching", runId);
  control.close();
  const before = claimOf(data, runId);
  const lines = stderrLines(t);
  runHolderTestHooks.table = failingTable;
  t.after(() => delete runHolderTestHooks.table);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", settleRetryMs: 300 });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  await sleep(2_500);
  const said = lines.filter((line) => line.includes(runId));
  assert.deepEqual(said.filter((line) => /opening it again|not taken back/.test(line)), [], `no take-back and no relaunch: ${said.join("")}`);
  assert.deepEqual(claimOf(data, runId), before, "the row as it was");
  delete runHolderTestHooks.table;
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a launch whose process cannot be identified (the process listing fails right after the spawn) still wires its process: the run completes", { timeout: 120_000 }, async (t) => {
  runHolderTestHooks.table = failingTable;
  t.after(() => delete runHolderTestHooks.table);
  const { api } = await serve(t, { faux: FAUX });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const run = await api("POST", "/agents/calc/runs", { input: { content: "Answer soon." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
});

test("a stop of an adopted run while the process listing fails is kept pending, never sent unidentified: once the listing reads again, the process gets it and the run ends cancelled", { skip: process.platform !== "linux" && "reads /proc", timeout: 120_000 }, async (t) => {
  const { data, runId, pid } = await crashMidRun(t);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 200, "adopted");
  runHolderTestHooks.table = failingTable;
  t.after(() => delete runHolderTestHooks.table);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await sleep(1_500);
  assert.ok(alive(pid), "no signal while its identity cannot be checked");
  delete runHolderTestHooks.table;
  for (let i = 0; alive(pid); i++) {
    assert.ok(i < 300, "the stop kept pending reaches the process once the listing reads again");
    await sleep(50);
  }
  const { last } = await follow(api, runId, ["cancelled"], { deadlineMs: 30_000 });
  assert.equal(last.status, "cancelled");
});

test("close() leaves no stop pending: a stop kept waiting on an identity that cannot be checked is never sent after the server closed", { skip: process.platform !== "linux" && "reads /proc", timeout: 120_000 }, async (t) => {
  const { data, runId, pid } = await crashMidRun(t);
  const lines = stderrLines(t);
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "1s" });
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("GET", `/runs/${runId}`)).status, 200, "adopted");
  runHolderTestHooks.table = failingTable;
  t.after(() => delete runHolderTestHooks.table);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await sleep(2_500);
  assert.equal(lines.filter((line) => line.includes(runId) && line.includes("its stop waits")).length, 1, "said once while it waits");
  await next.close();
  delete runHolderTestHooks.table;
  await sleep(1_500);
  assert.ok(alive(pid), "no stop sent after the close: its timer was cleared");
});
