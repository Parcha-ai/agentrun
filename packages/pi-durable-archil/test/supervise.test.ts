// Supervisor unit tests every branch of ensureRunning over a fake control API and a fake host
// driver, plus two racing supervisors over a fake server that admits one exclusive mount. No Archil, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Delegation } from "disk";
import {
  ensureRunning,
  readRunStatus,
  superviseRuns,
  SuperviseError,
  sweepTokens,
  deleteRunTree,
  START_BACKOFF_MAX_MS,
  startGrace,
  TOKEN_TTL,
  type EnsureOptions,
  type HostDriver,
  type HostHandle,
  type HostStatus,
  type SupervisorControl,
} from "../src/supervise.ts";
import { PdaError } from "../src/errors.ts";
import { RunRecordError } from "../src/status.ts";
import { parseTokenNickname, tokenNickname } from "../src/claim.ts";

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" };
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Call = { op: string; at: number; arg?: unknown };

/** The control API: objects (run.json, directory markers), delegations, token users; every call logged in order. */
class FakeControl implements SupervisorControl {
  objects = new Map<string, string>();
  delegations: Delegation[] = [];
  users = new Map<string, { nickname: string; ttl: string; oneUse: boolean; token: string }>();
  calls: Call[] = [];
  fail: Partial<Record<"getObject" | "putMark" | "revoke" | "list" | "addUser" | "exec", unknown>> = {};
  /** The inode each `runs/<id>` names, as `exec` reports it (`stat`); a path not listed is absent. */
  inodes = new Map<string, number>();
  #n = 0;
  #log(op: string, arg?: unknown) {
    this.calls.push({ op, at: performance.now(), arg });
  }
  /** The call log; reads and writes of the start mark show as getMark and putMark. */
  ops() {
    const mark = (c: Call) => (typeof c.arg === "string" ? c.arg.endsWith("/start.json") : Boolean((c.arg as { key?: string } | undefined)?.key?.endsWith("/start.json")));
    return this.calls.map((c) => (c.op === "getObject" && mark(c) ? "getMark" : c.op === "putObject" && mark(c) ? "putMark" : c.op));
  }
  mark() {
    const v = this.objects.get(`runs/${REF.id}/start.json`);
    return v === undefined ? undefined : (JSON.parse(v) as { generation: number; at: string; by: string | null; failures?: number; lastExit?: unknown });
  }
  runJson(body: Record<string, unknown>) {
    this.objects.set(`runs/${REF.id}/run.json`, JSON.stringify(body));
  }
  async getObject(key: string) {
    this.#log("getObject", key);
    if (this.fail.getObject) throw this.fail.getObject;
    const v = this.objects.get(key);
    if (v === undefined) throw Object.assign(new Error("NoSuchKey"), { status: 404, code: "NoSuchKey" });
    return new TextEncoder().encode(v);
  }
  async headObject(key: string) {
    this.#log("headObject", key);
    return this.objects.has(key) ? { size: 0 } : null;
  }
  async putObject(key: string, body: string, options: { uid: number; gid: number; mode: number }) {
    this.#log("putObject", { key, ...options });
    if (this.fail.putMark && key.endsWith("/start.json")) throw this.fail.putMark;
    this.objects.set(key, body);
  }
  async addUser(user: { type: "token"; nickname: string; ttl: string; oneUse: boolean }) {
    this.#log("addUser", user);
    if (this.fail.addUser) throw this.fail.addUser;
    const identifier = `id-${++this.#n}`;
    const token = `tok-${this.#n}-${"9".repeat(20)}`;
    this.users.set(identifier, { nickname: user.nickname, ttl: user.ttl, oneUse: user.oneUse, token });
    return { identifier, token };
  }
  async removeUser(_type: "token", identifier: string) {
    this.#log("removeUser", identifier);
    this.users.delete(identifier);
  }
  async listDelegations() {
    this.#log("listDelegations");
    if (this.fail.list) throw this.fail.list;
    return this.delegations.map((d) => ({ ...d }));
  }
  async revokeDelegation(d: Pick<Delegation, "clientId" | "inodeId">) {
    this.#log("revokeDelegation", d);
    if (this.fail.revoke) throw this.fail.revoke;
    this.delegations = this.delegations.filter((x) => !(x.clientId === d.clientId && x.inodeId === d.inodeId));
  }
  async exec(command: string) {
    this.#log("exec", command);
    if (this.fail.exec) throw this.fail.exec;
    const path = [...this.inodes.keys()].find((p) => command.includes(`'${p}'`));
    return { exitCode: 0, stdout: path === undefined ? "absent\n" : `${this.inodes.get(path)}\n` };
  }
}

const deleg = (o: Partial<Delegation> = {}): Delegation => ({ clientId: "c-old", inodeId: 7, path: `runs/${REF.id}`, isPending: false, isOrphaned: false, ...o });

/** A host driver whose calls land in the control's log, so the order across both is one timeline. */
class FakeHost implements HostDriver {
  started: { token: string; at: number }[] = [];
  stops: HostHandle[] = [];
  statusOf: HostStatus = "running";
  stopBehavior: "ok" | "hang" | "throw" = "ok";
  startThrows = false;
  /** Answer the next start as a driver does that found the instance an earlier start of this attempt made. */
  adopts = false;
  readonly control: FakeControl;
  constructor(control: FakeControl) {
    this.control = control;
  }
  async start(_ref: typeof REF, token: string): Promise<HostHandle> {
    this.control.calls.push({ op: "host.start", at: performance.now(), arg: token });
    if (this.startThrows) throw new Error("no capacity");
    if (this.adopts) return { driver: "fake", n: this.started.length, adopted: true };
    this.started.push({ token, at: performance.now() });
    return { driver: "fake", n: this.started.length };
  }
  async status(_h: HostHandle): Promise<HostStatus> {
    this.control.calls.push({ op: "host.status", at: performance.now() });
    return this.statusOf;
  }
  async stop(h: HostHandle): Promise<void> {
    this.control.calls.push({ op: "host.stop", at: performance.now() });
    this.stops.push(h);
    if (this.stopBehavior === "hang") await new Promise(() => {});
    if (this.stopBehavior === "throw") throw new Error("cannot reach host");
  }
}

function rig() {
  const control = new FakeControl();
  const host = new FakeHost(control);
  const opts = (o: Partial<EnsureOptions> = {}): EnsureOptions => ({ control, now: () => NOW, leaseExpiryMs: 90_000, stonithTimeoutMs: 30_000, ...o });
  return { control, host, opts };
}

const running = (o: Record<string, unknown> = {}) => ({
  run: REF.id,
  status: "running",
  generation: 3,
  sealedSeq: null,
  wakeAt: null,
  holder: { driver: "fake", host: "a", bootId: null, pid: 42, since: ago(600_000) },
  heartbeatAt: ago(5_000),
  updatedAt: ago(600_000),
  detail: null,
  ...o,
});

// ---- run.json --------------------------------------------------------------------------------------------------------

test("readRunStatus reads with status.ts's strict reader: the driver's holder fields survive; anything malformed is RUN_JSON_INVALID", async () => {
  const { control } = rig();
  const holder = { driver: "local", mode: "systemd", host: "a", bootId: "b", unit: "pda-r1-x", mountpoint: "/mnt/archil/runs/r1", pid: 42, since: ago(1) };
  control.runJson(running({ sealedSeq: 12, wakeAt: ago(-1000), holder }));
  const r = (await readRunStatus(control, REF.id))!;
  assert.deepEqual([r.status, r.generation, r.sealedSeq], ["running", 3, 12]);
  assert.deepEqual(r.holder, holder, "unit and mountpoint come back for the driver's status and stop");
  const bad: Record<string, unknown>[] = [
    running({ status: "starting" }),
    running({ status: "Running" }),
    running({ heartbeatAt: "yesterday" }),
    running({ wakeAt: "not a time" }),
    running({ updatedAt: undefined }),
    running({ holder: { driver: "fake" } }),
    running({ generation: -1 }),
  ];
  for (const body of bad) {
    control.runJson(body);
    await assert.rejects(readRunStatus(control, REF.id), (e: unknown) => e instanceof RunRecordError && e.code === "RUN_JSON_INVALID", JSON.stringify(body));
  }
  for (const text of ["not json", "[]", "null", "{}"]) {
    control.objects.set(`runs/${REF.id}/run.json`, text);
    await assert.rejects(readRunStatus(control, REF.id), (e: unknown) => e instanceof RunRecordError, text);
  }
});

test("readRunStatus: absent is null; another GetObject failure is a control API failure", async () => {
  const { control } = rig();
  assert.equal(await readRunStatus(control, REF.id), null);
  control.fail.getObject = Object.assign(new Error("503"), { status: 503 });
  await assert.rejects(readRunStatus(control, REF.id), (e: unknown) => e instanceof SuperviseError && e.code === "CONTROL_API_FAILED");
});

// ---- the run.json branches -------------------------------------------------------------------------------------------

test("done and failed runs are left alone: no delegation lookup, no token, no start", async () => {
  for (const status of ["done", "failed"] as const) {
    const { control, host, opts } = rig();
    control.runJson(running({ status }));
    control.delegations = [deleg({ isOrphaned: true })];
    const r = await ensureRunning(REF, host, opts());
    assert.deepEqual(r, { action: "terminal", status, generation: 3, detail: null });
    assert.deepEqual(control.ops(), ["getObject"]);
  }
});

test("a store behind its seal (failed, STORE_BEHIND_SEAL, its delegation orphaned by the exit 65): terminal, never restarted into", async () => {
  const { control, host, opts } = rig();
  const detail = { code: "STORE_BEHIND_SEAL", sealedSeq: 812, head: 811 };
  control.runJson(running({ status: "failed", sealedSeq: 812, heartbeatAt: ago(400_000), detail }));
  control.delegations = [deleg({ isOrphaned: true })];
  const r = await ensureRunning(REF, host, opts({ demand: true }));
  assert.deepEqual(r, { action: "terminal", status: "failed", generation: 3, detail });
  assert.deepEqual(control.ops(), ["getObject"], "no revoke, no token, no start, even on demand");
});

test("sleeping with wakeAt later is left alone; with wakeAt null it is idle (woken on demand only)", async () => {
  for (const wakeAt of [ago(-60_000), null]) {
    const { control, host, opts } = rig();
    control.runJson(running({ status: "sleeping", wakeAt }));
    const r = await ensureRunning(REF, host, opts());
    assert.deepEqual(r, { action: "sleeping", wakeAt, generation: 3 });
    assert.deepEqual(control.ops(), ["getObject"]);
  }
});

test("sleeping and due: no delegation, so start (woke); a demand wakes it before its time", async () => {
  {
    const { control, host, opts } = rig();
    control.runJson(running({ status: "sleeping", wakeAt: ago(1) }));
    const r = await ensureRunning(REF, host, opts());
    assert.equal(r.action, "started");
    assert.ok(r.action === "started" && r.reason === "none" && r.woke);
    assert.deepEqual(control.ops(), ["getObject", "listDelegations", "getMark", "addUser", "putMark", "host.start"]);
  }
  {
    const { control, host, opts } = rig();
    control.runJson(running({ status: "sleeping", wakeAt: ago(-3_600_000) }));
    const r = await ensureRunning(REF, host, opts({ demand: true }));
    assert.ok(r.action === "started" && r.woke);
  }
});

test("sleeping and due with the sleeper's delegation still orphaned: revoke, then start (a plain start would be refused)", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ status: "sleeping", wakeAt: ago(1) }));
  control.delegations = [deleg({ isOrphaned: true })];
  const r = await ensureRunning(REF, host, opts());
  assert.ok(r.action === "started" && r.reason === "orphaned" && r.woke);
  assert.deepEqual(control.ops(), ["getObject", "listDelegations", "getMark", "revokeDelegation", "addUser", "putMark", "host.start"]);
});

test("sleeping and due but already woken by someone (held, lease fresh): healthy, nothing started", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ status: "sleeping", wakeAt: ago(1), heartbeatAt: ago(1_000) }));
  control.delegations = [deleg()];
  const r = await ensureRunning(REF, host, opts());
  assert.equal(r.action, "healthy");
  assert.equal(host.started.length, 0);
});

test("paused stays paused unless the caller demands it", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ status: "paused" }));
  assert.deepEqual(await ensureRunning(REF, host, opts()), { action: "paused", generation: 3 });
  assert.deepEqual(control.ops(), ["getObject"]);
  const r = await ensureRunning(REF, host, opts({ demand: true }));
  assert.ok(r.action === "started" && r.reason === "none");
});

test("an unknown status value fails closed: RUN_JSON_INVALID, nothing listed, revoked or started", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ status: "starting" }));
  control.delegations = [deleg({ isOrphaned: true })];
  await assert.rejects(ensureRunning(REF, host, opts()), (e: unknown) => e instanceof RunRecordError && e.code === "RUN_JSON_INVALID" && /starting/.test(e.message));
  assert.deepEqual(control.ops(), ["getObject"]);
});

test("superviseRuns: an invalid run.json fails that run's line only (typed); the other runs are decided", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ status: "zombie" }));
  const lines = await superviseRuns([{ ...REF, id: "r1" }, { ...REF, id: "r2" }], host, opts());
  assert.deepEqual(lines.map((l) => [l.run, l.action]), [["r1", "error"], ["r2", "started"]]);
  assert.ok(lines[0].action === "error" && lines[0].error === "RUN_JSON_INVALID" && /zombie/.test(lines[0].message));
});

test("invalid run.json stops the decision before any delegation, revoke or start", async () => {
  const { control, host, opts } = rig();
  control.objects.set(`runs/${REF.id}/run.json`, "{torn");
  control.delegations = [deleg({ isOrphaned: true })];
  await assert.rejects(ensureRunning(REF, host, opts()), (e: unknown) => e instanceof RunRecordError && e.code === "RUN_JSON_INVALID");
  assert.deepEqual(control.ops(), ["getObject"]);
});

// ---- the delegation branches -----------------------------------------------------------------------------------------

test("none: a reusable token minted for this attempt, with the TTL, handed to host.start", async () => {
  const { control, host, opts } = rig();
  const r = await ensureRunning(REF, host, opts({ tokenTtl: "6h", tokenPrefix: "pda-t-" }));
  assert.ok(r.action === "started");
  assert.equal(r.reason, "none");
  assert.equal(r.woke, false);
  assert.equal(r.created, false);
  assert.deepEqual(r.revoked, []);
  const user = control.users.get(r.token.identifier)!;
  assert.equal(user.oneUse, false, "reusable: a single-use token dies at the client's 5 min refresh");
  assert.equal(user.ttl, "6h");
  assert.deepEqual(parseTokenNickname(user.nickname, "pda-t-"), { runId: REF.id, attempt: 1, at: NOW }, "the user names its run and attempt");
  assert.equal(host.started[0].token, user.token, "the driver got exactly the minted token");
  assert.ok(!JSON.stringify(r).includes(user.token), "the result never carries the token");
});

test("none with create: the run directory is made with the owner when absent, left alone when present", async () => {
  {
    const { control, host, opts } = rig();
    const r = await ensureRunning(REF, host, opts({ create: { uid: 1000, gid: 1001 } }));
    assert.ok(r.action === "started" && r.created);
    const put = control.calls.find((c) => c.op === "putObject")!.arg as Record<string, unknown>;
    assert.deepEqual(put, { key: `runs/${REF.id}/`, uid: 1000, gid: 1001, mode: 0o755 }, "the directory is made before the start mark goes into it");
  }
  {
    const { control, host, opts } = rig();
    control.objects.set(`runs/${REF.id}/`, "");
    const r = await ensureRunning(REF, host, opts({ create: { uid: 1000, gid: 1001 } }));
    assert.ok(r.action === "started" && !r.created);
    assert.ok(!control.ops().includes("putObject"), "only the start mark is written");
  }
});

test("held and orphaned: revoke exactly the listed delegations, then start", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(1_000) }));
  control.delegations = [deleg({ isOrphaned: true })];
  const r = await ensureRunning(REF, host, opts());
  assert.ok(r.action === "started" && r.reason === "orphaned");
  assert.deepEqual(r.revoked, [{ clientId: "c-old", inodeId: 7, path: `runs/${REF.id}`, isOrphaned: true }]);
  assert.equal(r.stonith, undefined, "an orphaned client is gone: no STONITH");
  assert.deepEqual(control.ops(), ["getObject", "listDelegations", "getMark", "revokeDelegation", "addUser", "putMark", "host.start"]);
});

test("held and orphaned, listed without a path: found by the run's inode, revoked, then started", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(1_000) }));
  control.delegations = [deleg({ isOrphaned: true, path: undefined }), deleg({ clientId: "c-other", inodeId: 8, isOrphaned: true, path: undefined })];
  control.inodes.set(`runs/${REF.id}`, 7);
  const r = await ensureRunning(REF, host, opts());
  assert.ok(r.action === "started" && r.reason === "orphaned", "by path alone this read as none, and the start was refused (76)");
  assert.deepEqual(r.revoked, [{ clientId: "c-old", inodeId: 7, path: undefined, isOrphaned: true }]);
  assert.deepEqual(control.delegations.map((d) => d.clientId), ["c-other"], "another run's pathless delegation is left alone");
  assert.deepEqual(control.ops(), ["getObject", "listDelegations", "exec", "getMark", "revokeDelegation", "addUser", "putMark", "host.start"]);
});

test("held, not orphaned, listed without a path, lease fresh: healthy, no second instance", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(1_000) }));
  control.delegations = [deleg({ path: undefined })];
  control.inodes.set(`runs/${REF.id}`, 7);
  const r = await ensureRunning(REF, host, opts());
  assert.equal(r.action, "healthy", "by path alone this read as none and started a second instance");
  assert.equal(host.started.length, 0);
});

test("a pathless delegation the supervisor cannot attribute fails the pass: nothing revoked or started", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(1_000) }));
  control.delegations = [deleg({ isOrphaned: true, path: undefined })];
  control.fail.exec = new Error("504 Gateway Time-out");
  await assert.rejects(ensureRunning(REF, host, opts()), (e: unknown) => e instanceof SuperviseError && e.code === "CONTROL_API_FAILED");
  assert.equal(host.started.length, 0);
  assert.ok(!control.ops().includes("revokeDelegation"));
});

test("held, not orphaned, lease fresh: healthy, nothing stopped, revoked or started", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(89_000) }));
  control.delegations = [deleg()];
  const r = await ensureRunning(REF, host, opts());
  assert.ok(r.action === "healthy");
  assert.equal(r.ageMs, 89_000);
  assert.deepEqual(control.ops(), ["getObject", "listDelegations"]);
});

test("held, lease expired, holder running: STONITH (status, stop), revoke, start, in that order", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(91_000) }));
  control.delegations = [deleg()];
  const r = await ensureRunning(REF, host, opts());
  assert.ok(r.action === "started" && r.reason === "lease-expired");
  assert.equal(r.stonith?.outcome, "stopped");
  assert.deepEqual(host.stops, [running().holder]);
  assert.deepEqual(control.ops(), ["getObject", "listDelegations", "getMark", "host.status", "host.stop", "revokeDelegation", "addUser", "putMark", "host.start"]);
});

test("lease expired, STONITH hangs: never waited past the timeout, then revoke and start anyway", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(120_000) }));
  control.delegations = [deleg()];
  host.stopBehavior = "hang";
  const t0 = performance.now();
  const r = await ensureRunning(REF, host, opts({ stonithTimeoutMs: 150 }));
  const elapsed = performance.now() - t0;
  assert.ok(r.action === "started" && r.stonith?.outcome === "timed-out");
  assert.ok(elapsed >= 140 && elapsed < 1_000, `bounded by the timeout (${elapsed} ms)`);
  assert.deepEqual(control.ops().slice(-4), ["revokeDelegation", "addUser", "putMark", "host.start"]);
});

test("lease expired, STONITH fails or the holder is out of reach: revoke and start; a stopped or failed holder is still stopped (cleaned)", async () => {
  {
    const { control, host, opts } = rig();
    control.runJson(running({ heartbeatAt: ago(120_000) }));
    control.delegations = [deleg()];
    host.stopBehavior = "throw";
    const r = await ensureRunning(REF, host, opts());
    assert.ok(r.action === "started" && r.stonith?.outcome === "failed" && r.stonith.error === "cannot reach host");
  }
  for (const s of ["unknown", "gone"] as const) {
    const { control, host, opts } = rig();
    control.runJson(running({ heartbeatAt: ago(120_000) }));
    control.delegations = [deleg()];
    host.statusOf = s;
    const r = await ensureRunning(REF, host, opts());
    assert.ok(r.action === "started");
    assert.deepEqual(r.stonith, { outcome: "unreachable", status: s });
    assert.equal(host.stops.length, 0, s);
  }
  for (const s of ["stopped", "failed"] as const) {
    const { control, host, opts } = rig();
    control.runJson(running({ heartbeatAt: ago(120_000) }));
    control.delegations = [deleg()];
    host.statusOf = s;
    const r = await ensureRunning(REF, host, opts());
    assert.ok(r.action === "started" && r.stonith?.outcome === "stopped" && r.stonith.status === s);
    assert.equal(host.stops.length, 1, `${s}: stop cleans what the holder left`);
  }
});

test("lease expired with no run.json, or no heartbeat: no holder to stop; revoke, start", async () => {
  for (const body of [null, running({ heartbeatAt: null, holder: null })]) {
    const { control, host, opts } = rig();
    if (body) control.runJson(body);
    control.delegations = [deleg()];
    const r = await ensureRunning(REF, host, opts());
    assert.ok(r.action === "started" && r.reason === "lease-expired");
    assert.deepEqual(r.stonith, { outcome: "no-holder" });
    assert.deepEqual(control.ops().slice(-4), ["revokeDelegation", "addUser", "putMark", "host.start"]);
  }
});

test("a delegation still checking out is a mount in flight: nothing is revoked or started", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(500_000) }));
  control.delegations = [deleg({ isPending: true })];
  assert.deepEqual(await ensureRunning(REF, host, opts()), { action: "pending", delegations: 1 });
  assert.deepEqual(control.ops(), ["getObject", "listDelegations"]);
});

test("no wait between the revoke and the start: the token and the driver follow at once", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(200_000) }));
  control.delegations = [deleg()];
  await ensureRunning(REF, host, opts());
  const revoked = control.calls.find((c) => c.op === "revokeDelegation")!.at;
  const started = control.calls.find((c) => c.op === "host.start")!.at;
  assert.ok(started - revoked < 20, `start ${started - revoked} ms after the revoke`);
});

test("a token per attempt: consecutive starts never share a token or a token user", async () => {
  const { control, host, opts } = rig();
  const a = await ensureRunning(REF, host, opts({ startGraceMs: 0 }));
  const b = await ensureRunning(REF, host, opts({ startGraceMs: 0 }));
  assert.ok(a.action === "started" && b.action === "started");
  assert.notEqual(a.token.identifier, b.token.identifier);
  assert.notEqual(host.started[0].token, host.started[1].token);
  assert.equal(control.calls.filter((c) => c.op === "addUser").length, 2);
});

test("revoke fails but the delegation is gone (someone else revoked): start; still listed: fail, no token, no start", async () => {
  {
    const { control, host, opts } = rig();
    control.delegations = [deleg({ isOrphaned: true })];
    control.revokeDelegation = async function (this: FakeControl, d) {
      this.calls.push({ op: "revokeDelegation", at: performance.now(), arg: d });
      this.delegations = [];
      throw Object.assign(new Error("not found"), { status: 404 });
    };
    const r = await ensureRunning(REF, host, opts());
    assert.ok(r.action === "started");
  }
  {
    const { control, host, opts } = rig();
    control.delegations = [deleg({ isOrphaned: true })];
    control.fail.revoke = new Error("500");
    await assert.rejects(ensureRunning(REF, host, opts()), (e: unknown) => e instanceof SuperviseError && e.code === "CONTROL_API_FAILED");
    assert.ok(!control.ops().includes("addUser") && host.started.length === 0);
  }
});

test("only the delegations the decision saw are revoked: a holder that appeared since is not ours to judge", async () => {
  const { control, host, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(200_000) }));
  control.delegations = [deleg()];
  host.stop = async () => {
    control.calls.push({ op: "host.stop", at: performance.now() });
    control.delegations.push(deleg({ clientId: "c-racer", inodeId: 7 }));
  };
  await ensureRunning(REF, host, opts());
  assert.deepEqual(control.delegations.map((d) => d.clientId), ["c-racer"]);
  const revoked = control.calls.filter((c) => c.op === "revokeDelegation").map((c) => (c.arg as Delegation).clientId);
  assert.deepEqual(revoked, ["c-old"]);
});

test("a driver that cannot start: the unused token user is removed and the error is typed (exit 1)", async () => {
  const { control, host, opts } = rig();
  host.startThrows = true;
  const err = await ensureRunning(REF, host, opts()).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SuperviseError && err.code === "HOST_START_FAILED" && err.exitCode === 1);
  assert.equal(control.users.size, 0);
  assert.deepEqual(control.ops().slice(-3), ["host.start", "removeUser", "putMark"]);
  assert.equal(control.mark()!.generation, 0, "the mark is spent: nothing was started, so no grace");
  host.startThrows = false;
  const again = await ensureRunning(REF, host, opts());
  assert.ok(again.action === "started", "the next tick starts at once");
});

test("a driver that adopts the instance an earlier start of this attempt made: the token minted for this start is removed at once", async () => {
  const { control, host, opts } = rig();
  host.adopts = true;
  const r = await ensureRunning(REF, host, opts());
  assert.ok(r.action === "started" && r.adopted === true, JSON.stringify(r));
  assert.equal(control.users.size, 0, "no token user is left for a start that used none");
  assert.deepEqual(control.ops().slice(-2), ["host.start", "removeUser"]);
  host.adopts = false;
  const fresh = await ensureRunning(REF, host, opts({ now: () => NOW + 3_600_000 }));
  assert.ok(fresh.action === "started" && fresh.adopted === undefined, JSON.stringify(fresh));
  assert.equal(control.users.size as number, 1, "a start that is not adopted keeps its token");
});

test("control API failures are typed and stop the decision", async () => {
  const { control, host, opts } = rig();
  control.fail.list = new Error("down");
  await assert.rejects(ensureRunning(REF, host, opts()), (e: unknown) => e instanceof SuperviseError && e.code === "CONTROL_API_FAILED");
  control.fail.list = undefined;
  control.fail.addUser = new Error("down");
  await assert.rejects(ensureRunning(REF, host, opts()), (e: unknown) => e instanceof PdaError && e.code === "CONTROL_API_FAILED");
  assert.equal(host.started.length, 0);
});

// ---- two racing supervisors over a fake server ------------------------------------------------------------------------

/**
 * One exclusive mount per run (Archil's rule): a mount is refused while another client holds a delegation, and a
 * refused mount spends its single-use token. An instance that loses exits 76; a revoked holder is fenced (75) at its
 * next write. Instances write their heartbeat into run.json once they hold the claim.
 */
class FakeServer {
  clients = 0;
  outcomes: { client: string; token: string; exit: 76 | null; fenced: boolean }[] = [];
  spent = new Set<string>();
  readonly control: FakeControl;
  constructor(control: FakeControl) {
    this.control = control;
    const revoke = control.revokeDelegation.bind(control);
    control.revokeDelegation = async (d) => {
      await revoke(d);
      for (const o of this.outcomes) if (o.client === d.clientId) o.fenced = true;
    };
  }
  async mount(token: string): Promise<void> {
    await sleep(Math.random() * 5);
    assert.ok(!this.spent.has(token), "a token is never presented twice");
    this.spent.add(token);
    const client = `c-${++this.clients}`;
    if (this.control.delegations.length) {
      this.outcomes.push({ client, token, exit: 76, fenced: false });
      return;
    }
    this.control.delegations.push(deleg({ clientId: client }));
    this.outcomes.push({ client, token, exit: null, fenced: false });
    await sleep(Math.random() * 5);
    this.control.runJson(running({ heartbeatAt: new Date(NOW).toISOString(), holder: { ...running().holder, client } }));
  }
}

function racingHost(server: FakeServer): HostDriver & { pending: Promise<void>[] } {
  const pending: Promise<void>[] = [];
  return {
    pending,
    async start(_ref, token) {
      pending.push(server.mount(token));
      return { driver: "fake", token: token.slice(0, 6) };
    },
    async status() {
      return "unknown";
    },
    async stop() {},
  };
}

test("two supervisors race on a run with no holder: both start, the mount admits one, the other instance exits 76", async () => {
  for (let round = 0; round < 20; round++) {
    const { control, opts } = rig();
    const server = new FakeServer(control);
    const host = racingHost(server);
    const [a, b] = await Promise.all([ensureRunning(REF, host, opts()), ensureRunning(REF, host, opts())]);
    await Promise.all(host.pending);
    const started = [a, b].filter((r) => r.action === "started");
    const live = server.outcomes.filter((o) => o.exit === null && !o.fenced);
    assert.equal(live.length, 1, `round ${round}: exactly one live holder`);
    assert.equal(control.delegations.length, 1);
    assert.equal(server.outcomes.filter((o) => o.exit === 76).length, started.length - 1, "every other instance exited 76");
    if (started.length === 2) assert.notEqual(a.action === "started" && a.token.identifier, b.action === "started" && b.token.identifier);
  }
});

test("two supervisors race on an expired lease: at most one live holder; neither revokes the other's new instance", async () => {
  for (let round = 0; round < 20; round++) {
    const { control, opts } = rig();
    const server = new FakeServer(control);
    control.runJson(running({ heartbeatAt: ago(300_000) }));
    control.delegations = [deleg({ clientId: "c-zombie" })];
    server.outcomes.push({ client: "c-zombie", token: "-", exit: null, fenced: false });
    const host = racingHost(server);
    await Promise.all([ensureRunning(REF, host, opts()), ensureRunning(REF, host, opts())]);
    await Promise.all(host.pending);
    const live = server.outcomes.filter((o) => o.exit === null && !o.fenced);
    assert.equal(live.length, 1, `round ${round}: one live holder`);
    assert.notEqual(live[0].client, "c-zombie", "the zombie is fenced");
    assert.ok(server.outcomes.find((o) => o.client === "c-zombie")!.fenced);
    const fencedNew = server.outcomes.filter((o) => o.client !== "c-zombie" && o.fenced);
    assert.equal(fencedNew.length, 0, "a supervisor revokes only the delegation it judged, never the other's new holder");
  }
});

test("with the start grace off, a supervisor that looks between a new instance's mount and its first heartbeat revokes it; the run still has one holder", async () => {
  const { control, opts } = rig();
  control.runJson(running({ heartbeatAt: ago(300_000) }));
  control.delegations = [deleg({ clientId: "c-starting" })];
  control.objects.set(`runs/${REF.id}/start.json`, JSON.stringify({ generation: 4, at: ago(2_000), by: "s1" }));
  const server = new FakeServer(control);
  server.outcomes.push({ client: "c-starting", token: "-", exit: null, fenced: false });
  const host = racingHost(server);
  const r = await ensureRunning(REF, host, opts({ startGraceMs: 0 }));
  await Promise.all(host.pending);
  assert.ok(r.action === "started" && r.reason === "lease-expired");
  assert.ok(server.outcomes.find((o) => o.client === "c-starting")!.fenced, "the starting instance is fenced (75): churn, never two writers");
  assert.equal(server.outcomes.filter((o) => o.exit === null && !o.fenced).length, 1);
});

// ---- the start grace: a tick never fences the instance a start just made ---------------------------------------------

/** A clock the test moves, and a supervisor over it: the state an expired holder left (generation 3, heartbeat 5 min old). */
function graceRig(o: Partial<EnsureOptions> = {}) {
  const r = rig();
  let t = NOW;
  const clock = { at: (ms: number) => (t = NOW + ms) };
  r.control.runJson(running({ heartbeatAt: ago(300_000) }));
  r.control.delegations = [deleg({ clientId: "c-dead" })];
  const tick = (extra: Partial<EnsureOptions> = {}) => ensureRunning(REF, r.host, r.opts({ now: () => t, supervisorId: "sup-1", ...o, ...extra }));
  /** The new instance: its mount shows as a delegation; its first write is run.json at generation 4. */
  const instance = {
    mount: () => void r.control.delegations.push(deleg({ clientId: "c-new" })),
    write: (atMs: number) => r.control.runJson(running({ generation: 4, heartbeatAt: new Date(NOW + atMs).toISOString(), holder: { ...running().holder, pid: 43 } })),
  };
  return { ...r, clock, tick, instance };
}

const DECIDING = ["host.status", "host.stop", "revokeDelegation", "addUser", "putMark", "host.start"];
const decided = (ops: string[]) => ops.filter((op) => DECIDING.includes(op));

test("start grace: a tick inside it leaves the new instance alone (not mounted yet, or mounted without run.json): no revoke, no second start", async () => {
  const { control, host, clock, tick, instance } = graceRig();
  const first = await tick();
  assert.ok(first.action === "started" && first.reason === "lease-expired" && first.startMark);
  assert.deepEqual(control.mark(), { generation: 4, at: new Date(NOW).toISOString(), by: "sup-1", failures: 0, lastExit: null }, "the mark names the generation the instance will write");
  control.calls = [];
  clock.at(1_000);
  assert.deepEqual(await tick(), { action: "starting", generation: 4, sinceMs: 1_000, graceMs: 90_000, failures: 0, lastExit: null, by: "sup-1", delegations: 0 }, "no delegation yet: no second start");
  instance.mount();
  for (const ms of [2_000, 30_000, 89_999]) {
    clock.at(ms);
    assert.deepEqual(await tick(), { action: "starting", generation: 4, sinceMs: ms, graceMs: 90_000, failures: 0, lastExit: null, by: "sup-1", delegations: 1 }, `${ms} ms: the held, unwritten run is left alone`);
  }
  assert.deepEqual(decided(control.ops()), [], "nothing stopped, revoked, minted or started");
  assert.equal(host.started.length, 1);
  assert.deepEqual(control.delegations.map((d) => d.clientId), ["c-new"]);
});

test("start grace: another supervisor process sees the mark (it lives in the run's directory, not in memory)", async () => {
  const { control, host, clock, tick, instance } = graceRig();
  await tick();
  instance.mount();
  clock.at(2_000);
  const other = await ensureRunning(REF, host, { control, now: () => NOW + 2_000, leaseExpiryMs: 90_000, supervisorId: "sup-2" });
  assert.deepEqual(other, { action: "starting", generation: 4, sinceMs: 2_000, graceMs: 90_000, failures: 0, lastExit: null, by: "sup-1", delegations: 1 });
  assert.equal(host.started.length, 1);
});

test("start grace: once the new instance writes run.json at its generation, the normal lease rules apply", async () => {
  const { control, host, clock, tick, instance } = graceRig();
  await tick();
  instance.mount();
  instance.write(1_200);
  clock.at(2_000);
  const healthy = await tick();
  assert.ok(healthy.action === "healthy" && healthy.generation === 4 && healthy.ageMs === 800, "the mark is spent; the lease decides");
  clock.at(1_200 + 90_001);
  const expired = await tick();
  assert.ok(expired.action === "started" && expired.reason === "lease-expired", "a lapsed lease after the first write is expired, grace or not");
  assert.equal(expired.stonith?.outcome, "stopped");
  assert.deepEqual(control.calls.filter((c) => c.op === "revokeDelegation").map((c) => (c.arg as Delegation).clientId), ["c-dead", "c-new"]);
  assert.equal(control.mark()!.generation, 5, "the next start marks the next generation");
  assert.equal(host.started.length, 2);
});

test("start grace: a start that never writes run.json is a failed start once the grace passes: revoked and started again", async () => {
  {
    const { control, host, clock, tick, instance } = graceRig();
    await tick();
    instance.mount();
    clock.at(90_000);
    const r = await tick();
    assert.ok(r.action === "started" && r.reason === "lease-expired");
    assert.deepEqual(r.revoked.map((d) => d.clientId), ["c-new"]);
    assert.equal(host.started.length, 2);
    assert.deepEqual(control.mark(), { generation: 4, at: new Date(NOW + 90_000).toISOString(), by: "sup-1", failures: 1, lastExit: "held" }, "run.json is still at 3: the retry marks 4 again, one failure on");
  }
  {
    const { host, clock, tick } = graceRig();
    await tick();
    clock.at(90_000);
    const r = await tick();
    assert.ok(r.action === "started" && r.reason === "none", "never mounted: started again");
    assert.equal(host.started.length, 2);
  }
});

test("start grace: its own length (startGraceMs), independent of the lease; 0 turns it off", async () => {
  {
    const { clock, tick, instance } = graceRig({ startGraceMs: 10_000 });
    await tick();
    instance.mount();
    clock.at(9_999);
    assert.equal((await tick()).action, "starting");
    clock.at(10_000);
    const r = await tick();
    assert.ok(r.action === "started" && r.revoked.some((d) => d.clientId === "c-new"));
  }
  {
    const { clock, tick, instance } = graceRig({ startGraceMs: 0 });
    await tick();
    instance.mount();
    clock.at(2_000);
    const r = await tick();
    assert.ok(r.action === "started" && r.revoked.some((d) => d.clientId === "c-new"), "no grace: the 2 s tick fences the new instance");
  }
});

test("start grace: a mark that cannot be written costs only the grace; the start goes ahead", async () => {
  const { control, host, clock, tick, instance } = graceRig();
  control.fail.putMark = Object.assign(new Error("409"), { status: 409 });
  const first = await tick();
  assert.ok(first.action === "started" && first.startMark === false);
  assert.equal(host.started.length, 1);
  instance.mount();
  clock.at(2_000);
  const r = await tick();
  assert.ok(r.action === "started", "no mark, no grace");
});

test("start grace: a spent, unreadable or far-future mark gives no grace; a mark read that fails stops the decision", async () => {
  const key = `runs/${REF.id}/start.json`;
  for (const body of [
    JSON.stringify({ generation: 3, at: ago(1_000), by: "s" }),
    JSON.stringify({ generation: 4, at: "soon", by: "s" }),
    JSON.stringify({ generation: 4.5, at: ago(1_000), by: "s" }),
    "{torn",
    JSON.stringify({ generation: 4, at: ago(-200_000), by: "s" }),
  ]) {
    const { control, tick } = graceRig();
    control.objects.set(key, body);
    const r = await tick();
    assert.ok(r.action === "started", body);
  }
  {
    const { control, tick } = graceRig();
    control.objects.set(key, JSON.stringify({ generation: 4, at: ago(-5_000), by: null }));
    assert.deepEqual(await tick(), { action: "starting", generation: 4, sinceMs: -5_000, graceMs: 90_000, failures: 0, lastExit: null, by: null, delegations: 1 }, "a supervisor clock a little behind still sees the grace");
  }
  {
    const { control, host, tick } = graceRig();
    const get = control.getObject.bind(control);
    control.getObject = async (k: string) => (k === key ? Promise.reject(Object.assign(new Error("503"), { status: 503 })) : get(k));
    await assert.rejects(tick(), (e: unknown) => e instanceof SuperviseError && e.code === "CONTROL_API_FAILED");
    assert.equal(host.started.length, 0);
    assert.deepEqual(control.delegations.map((d) => d.clientId), ["c-dead"], "nothing revoked on an unread mark");
  }
});

test("start grace at a 2 s tick: a takeover whose instance takes 5 s to its first run.json write starts once and is never fenced", async () => {
  for (const startGraceMs of [undefined, 0]) {
    const { control, host, clock, tick } = graceRig({ leaseExpiryMs: 6_000, startGraceMs });
    const actions: string[] = [];
    let startedAt = -1;
    for (let ms = 0; ms <= 30_000; ms += 2_000) {
      clock.at(ms);
      // The newest instance mounts 0.5 s after its start, writes run.json (generation 4) 5 s after it, then beats.
      if (startedAt >= 0 && ms >= startedAt + 500 && !control.delegations.length) control.delegations.push(deleg({ clientId: `c-new-${startedAt}` }));
      if (startedAt >= 0 && ms >= startedAt + 5_000) control.runJson(running({ generation: 4, heartbeatAt: new Date(NOW + ms - 100).toISOString() }));
      const r = await tick();
      actions.push(r.action);
      if (r.action === "started") startedAt = ms;
    }
    const fencedNew = control.calls.filter((c) => c.op === "revokeDelegation" && (c.arg as Delegation).clientId.startsWith("c-new")).length;
    if (startGraceMs === undefined) {
      assert.equal(host.started.length, 1, actions.join(","));
      assert.equal(fencedNew, 0, "the new instance is never revoked");
      assert.deepEqual(actions.slice(0, 4), ["started", "starting", "starting", "healthy"]);
      assert.ok(actions.slice(3).every((a) => a === "healthy"), actions.join(","));
    } else {
      assert.ok(fencedNew >= 3 && host.started.length > 3, `without the grace every tick fences what the last one started: ${actions.join(",")}`);
    }
  }
});

// ---- the backoff: a run whose starts keep failing is started a handful of times, not once a tick ------------------------

/** A fresh run (no run.json) on a clock the test moves, whose instances never get to write run.json unless the test says so. */
function backoffRig(o: Partial<EnsureOptions> = {}) {
  const r = rig();
  let t = NOW;
  const at = (ms: number) => (t = NOW + ms);
  const tick = (extra: Partial<EnsureOptions> = {}) => ensureRunning(REF, r.host, r.opts({ now: () => t, supervisorId: "sup-1", ...o, ...extra }));
  /** Tick every `everyMs` from `fromMs` to `toMs`; the time and decision of each start. */
  const run = async (fromMs: number, toMs: number, everyMs: number) => {
    const out: { ms: number; failures: number; lastExit: unknown; graceMs: number }[] = [];
    for (let ms = fromMs; ms <= toMs; ms += everyMs) {
      at(ms);
      const d = await tick();
      if (d.action === "started") out.push({ ms, failures: d.failures, lastExit: d.lastExit, graceMs: d.graceMs });
    }
    return out;
  };
  return { ...r, at, tick, run };
}

test("startGrace: the base doubled per failure, capped, never below the base; 0 is off", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((f) => startGrace(90_000, f)), [90_000, 180_000, 360_000, 600_000, 600_000, 600_000]);
  assert.equal(START_BACKOFF_MAX_MS, 600_000);
  assert.equal(startGrace(900_000, 3), 900_000, "a base above the cap stays the base");
  assert.equal(startGrace(6_000, 1_000, 60_000), 60_000, "no overflow");
  assert.equal(startGrace(0, 5), 0);
});

test("backoff, every start failing at a 3 s tick with a 6 s grace: 7 starts in 420 s (the grace alone: 71; no grace: 141)", async () => {
  const shape = { leaseExpiryMs: 6_000 };
  const backedOff = await backoffRig(shape).run(0, 420_000, 3_000);
  assert.deepEqual(backedOff.map((s) => s.ms), [0, 6_000, 18_000, 42_000, 90_000, 186_000, 378_000]);
  assert.deepEqual(backedOff.map((s) => s.failures), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(backedOff.map((s) => s.graceMs), [6_000, 12_000, 24_000, 48_000, 96_000, 192_000, 384_000]);
  assert.ok(backedOff.slice(1).every((s) => s.lastExit === "no-delegation"), "what each decision saw of the failed start");
  const graceOnly = await backoffRig({ ...shape, startBackoffMaxMs: 6_000 }).run(0, 420_000, 3_000);
  assert.equal(graceOnly.length, 71, "a constant grace: one start per grace");
  const noGrace = await backoffRig({ ...shape, startGraceMs: 0 }).run(0, 420_000, 3_000);
  assert.equal(noGrace.length, 141, "no grace: one start per tick");
  assert.ok(noGrace.every((s) => s.failures === 0), "grace 0 turns the backoff off too");
});

test("backoff cap: the grace stops growing at startBackoffMaxMs; the mark carries the count", async () => {
  const { control, run } = backoffRig({ leaseExpiryMs: 10_000, startBackoffMaxMs: 40_000 });
  const s = await run(0, 300_000, 2_000);
  assert.deepEqual(s.map((x) => x.ms), [0, 10_000, 30_000, 70_000, 110_000, 150_000, 190_000, 230_000, 270_000]);
  assert.deepEqual(s.map((x) => x.graceMs), [10_000, 20_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000]);
  assert.deepEqual(control.mark(), { generation: 1, at: new Date(NOW + 270_000).toISOString(), by: "sup-1", failures: 8, lastExit: "no-delegation" });
});

test("backoff resets on the first run.json write at the start's generation", async () => {
  const { control, at, tick, run } = backoffRig({ leaseExpiryMs: 10_000 });
  const failed = await run(0, 70_000, 2_000);
  assert.deepEqual(failed.map((x) => x.failures), [0, 1, 2, 3]);
  // The fourth start (failures 3, grace 80 s) mounts and writes run.json at generation 1.
  control.delegations = [deleg({ clientId: "c-good" })];
  control.runJson(running({ generation: 1, heartbeatAt: new Date(NOW + 71_000).toISOString() }));
  at(72_000);
  assert.equal((await tick()).action, "healthy", "the mark is spent: the lease decides");
  // Its lease lapses later: the next start counts from 0 with the base grace.
  at(71_000 + 10_001);
  const r = await tick();
  assert.ok(r.action === "started" && r.reason === "lease-expired");
  assert.deepEqual([r.failures, r.lastExit, r.graceMs], [0, null, 10_000]);
  assert.deepEqual(control.mark(), { generation: 2, at: new Date(NOW + 81_001).toISOString(), by: "sup-1", failures: 0, lastExit: null });
});

test("backoff lastExit is what the decision saw of the failed start: no delegation, a delegation still held, its client gone", async () => {
  {
    const { at, tick } = backoffRig({ leaseExpiryMs: 10_000 });
    await tick();
    at(10_000);
    const r = await tick();
    assert.ok(r.action === "started" && r.reason === "none");
    assert.deepEqual([r.failures, r.lastExit, r.graceMs], [1, "no-delegation", 20_000]);
  }
  {
    // Mounted and never wrote (stuck): revoked once its grace is over.
    const { control, at, tick } = backoffRig({ leaseExpiryMs: 10_000 });
    await tick();
    control.delegations = [deleg({ clientId: "c-stuck" })];
    at(10_000);
    const r = await tick();
    assert.ok(r.action === "started" && r.reason === "lease-expired");
    assert.deepEqual([r.failures, r.lastExit], [1, "held"]);
    assert.deepEqual(r.revoked.map((d) => d.clientId), ["c-stuck"]);
  }
  {
    // The driver is never asked: the backoff needs no more than the generation the mark names.
    const { control, host, at, tick } = backoffRig({ leaseExpiryMs: 10_000 });
    await tick();
    control.calls = [];
    at(10_000);
    await tick();
    assert.ok(!control.ops().includes("host.status"));
    assert.equal(host.stops.length, 0);
  }
});


test("backoff: every delegation orphaned inside a start's grace waits it out (the start's client is gone: a failed start); then revoke, start, one failure on", async () => {
  const { control, host, at, tick } = backoffRig({ leaseExpiryMs: 10_000 });
  await tick();
  control.delegations = [deleg({ clientId: "c-new", isOrphaned: true })];
  at(4_000);
  const waiting = await tick();
  assert.ok(waiting.action === "starting" && waiting.delegations === 1);
  assert.ok(!control.ops().includes("revokeDelegation"));
  at(10_000);
  const r = await tick();
  assert.ok(r.action === "started" && r.reason === "orphaned");
  assert.deepEqual([r.failures, r.lastExit, r.graceMs], [1, "orphaned", 20_000]);
  assert.deepEqual(r.revoked.map((d) => d.clientId), ["c-new"]);
  assert.equal(host.started.length, 2);
});

test("backoff: a driver that throws started nothing and adds no failure; the mark goes back to the last start's", async () => {
  const { control, host, at, tick, run } = backoffRig({ leaseExpiryMs: 10_000 });
  await run(0, 30_000, 2_000);
  const before = control.mark()!;
  assert.equal(before.failures, 2);
  host.startThrows = true;
  at(70_000);
  await assert.rejects(tick(), (e: unknown) => e instanceof SuperviseError && e.code === "HOST_START_FAILED");
  assert.deepEqual(control.mark(), before, "the last start's mark, as it was");
  host.startThrows = false;
  at(72_000);
  const r = await tick();
  assert.ok(r.action === "started");
  assert.equal(r.failures, 3, "the failed start counts once; the driver's refusal not at all");
});

test("backoff: a mark written before the count existed reads as 0 failures", async () => {
  const { control, at, tick } = backoffRig({ leaseExpiryMs: 10_000 });
  control.objects.set(`runs/${REF.id}/start.json`, JSON.stringify({ generation: 1, at: new Date(NOW).toISOString(), by: "old" }));
  at(5_000);
  const r = await tick();
  assert.ok(r.action === "starting" && r.failures === 0 && r.lastExit === null && r.graceMs === 10_000);
  at(10_000);
  const s = await tick();
  assert.ok(s.action === "started" && s.failures === 1);
});

// ---- the follow-up: control timeouts, the token janitor ---------------------------------------------------------

const never = () => new Promise<never>(() => {});

test("every control API call is bounded: a call that does not answer fails this decision as CONTROL_API_FAILED", { timeout: 10_000 }, async () => {
  for (const hang of ["getObject", "listDelegations", "addUser", "revokeDelegation"] as const) {
    const { control, host, opts } = rig();
    control.delegations = hang === "revokeDelegation" ? [deleg({ isOrphaned: true })] : [];
    (control as unknown as Record<string, unknown>)[hang] = never;
    const t0 = performance.now();
    const err = await ensureRunning(REF, host, opts({ controlTimeoutMs: 100 })).then(() => null, (e: unknown) => e);
    const ms = performance.now() - t0;
    assert.ok(err instanceof PdaError && err.code === "CONTROL_API_FAILED", `${hang}: ${err}`);
    assert.ok(ms < 1_000, `${hang}: bounded (${Math.round(ms)} ms)`);
    assert.equal(host.started.length, 0, `${hang}: nothing started`);
  }
});

test("superviseRuns: one run whose control call hangs costs only its own line; the next run is decided", { timeout: 10_000 }, async () => {
  const { control, host, opts } = rig();
  const list = control.listDelegations.bind(control);
  let calls = 0;
  control.listDelegations = () => (calls++ === 0 ? never() : list());
  const lines = await superviseRuns([{ ...REF, id: "r1" }, { ...REF, id: "r2" }], host, opts({ controlTimeoutMs: 100 }));
  assert.deepEqual(lines.map((l) => [l.run, l.action]), [["r1", "error"], ["r2", "started"]]);
  assert.ok(lines[0].action === "error" && lines[0].error === "CONTROL_API_FAILED");
});

test("defaults: a 24 h reusable token whose nickname names the run and the generation the instance will write", async () => {
  assert.equal(TOKEN_TTL, "24h");
  const { control, host, opts } = rig();
  control.runJson(running({ status: "paused", generation: 3 }));
  const r = await ensureRunning(REF, host, opts({ demand: true }));
  assert.ok(r.action === "started");
  const user = control.users.get(r.token.identifier)!;
  assert.deepEqual([user.ttl, user.oneUse], ["24h", false]);
  assert.equal(r.token.nickname, user.nickname);
  assert.deepEqual(parseTokenNickname(user.nickname), { runId: REF.id, attempt: 4, at: NOW });
});

// ---- the token sweep: no live mount ever loses its token user -----------------------------------------------------------

function sweepRig(runs: Record<string, { status?: string; held?: boolean } | null>) {
  const control = new FakeControl();
  for (const [id, r] of Object.entries(runs)) {
    if (r?.status) control.objects.set(`runs/${id}/run.json`, JSON.stringify({ ...running({ status: r.status }), run: id }));
    if (r?.held) control.delegations.push(deleg({ clientId: `c-${id}`, path: `runs/${id}` }));
  }
  const user = (id: string, run: string, ageMs: number, extra: Record<string, string> = {}) => ({
    identifier: id,
    nickname: tokenNickname(run, 1, NOW - ageMs),
    createdAt: new Date(NOW - ageMs).toISOString(),
    expiresAt: new Date(NOW - ageMs + 86_400_000).toISOString(),
    status: "active",
    ...extra,
  });
  return { control, user };
}

test("token sweep: a released run's users go once they are older than the grace; a held, running, absent or young run keeps them", async () => {
  const { control, user } = sweepRig({
    paused: { status: "paused" },
    done: { status: "done" },
    failed: { status: "failed" },
    sleeping: { status: "sleeping" },
    held: { status: "paused", held: true },
    running: { status: "running" },
    absent: null,
    young: { status: "paused" },
  });
  control.objects.set("runs/invalid/run.json", "{torn");
  const users = [
    user("u-paused", "paused", 20 * 60_000),
    user("u-done", "done", 20 * 60_000),
    user("u-failed", "failed", 20 * 60_000),
    user("u-sleeping", "sleeping", 20 * 60_000),
    user("u-held", "held", 20 * 60_000),
    user("u-running", "running", 20 * 60_000),
    user("u-absent", "absent", 20 * 60_000),
    user("u-invalid", "invalid", 20 * 60_000),
    user("u-young", "young", 5 * 60_000),
    { identifier: "u-other", nickname: "other-app-r1-g1-x", status: "active" },
  ];
  const r = await sweepTokens({ listUsers: async () => users, control, prefix: "pda-", now: () => NOW });
  assert.deepEqual(r.removed.map((x) => x.identifier).sort(), ["u-done", "u-failed", "u-paused", "u-sleeping"]);
  assert.ok(r.removed.every((x) => x.why === "released"));
  assert.equal(control.calls.filter((c) => c.op === "listDelegations").length, 1, "one delegation listing per pass");
  assert.equal(control.calls.filter((c) => c.op === "getObject" && c.arg === "runs/paused/run.json").length, 1, "run.json read once per run");
});

test("token sweep: a start in flight (minted, not mounted, the run still released) is safe for the grace; runs outside the pass are not touched", async () => {
  const { control, user } = sweepRig({ r1: { status: "sleeping" }, r2: { status: "paused" } });
  const fresh = [user("u-start", "r1", 30_000), user("u-r2", "r2", 3_600_000)];
  const r = await sweepTokens({ listUsers: async () => fresh, control, prefix: "pda-", runs: ["r1"], now: () => NOW });
  assert.deepEqual(r.removed, []);
  const later = await sweepTokens({ listUsers: async () => fresh, control, prefix: "pda-", runs: ["r1"], graceMs: 10_000, now: () => NOW });
  assert.deepEqual(later.removed.map((x) => x.identifier), ["u-start"], "past the grace, a released run's user goes; r2 is not in this pass");
});

test("token sweep: a released run whose live holder is listed without a path keeps its users; so does one that cannot be attributed", async () => {
  const { control, user } = sweepRig({ sleeping: { status: "sleeping" }, done: { status: "done" }, paused: { status: "paused" } });
  control.delegations.push(deleg({ clientId: "c-sleeping", inodeId: 41, path: undefined }));
  control.inodes.set("runs/sleeping", 41).set("runs/done", 42).set("runs/paused", 43);
  const users = [user("u-sleeping", "sleeping", 20 * 60_000), user("u-done", "done", 20 * 60_000)];
  const r = await sweepTokens({ listUsers: async () => users, control, prefix: "pda-", now: () => NOW });
  assert.deepEqual(r.removed.map((x) => x.identifier), ["u-done"], "by path alone the sleeping run read as unheld and lost its token under a live mount");
  control.fail.exec = new Error("504 Gateway Time-out");
  const blind = await sweepTokens({ listUsers: async () => [user("u-paused", "paused", 20 * 60_000)], control, prefix: "pda-", now: () => NOW });
  assert.deepEqual(blind.removed, [], "a run that cannot be told apart from the pathless holder keeps its users");
});

test("token sweep with expired: expired users go whatever their run, held included; an unparseable nickname goes only when expired", async () => {
  const { control, user } = sweepRig({ held: { status: "running", held: true } });
  const users = [
    user("u-exp-held", "held", 25 * 3_600_000, { status: "expired" }),
    user("u-exp-by-time", "held", 30 * 3_600_000),
    user("u-live-held", "held", 3_600_000),
    { identifier: "u-odd", nickname: "pda-handmade", status: "expired" },
    { identifier: "u-odd-live", nickname: "pda-handmade-2", status: "active" },
  ];
  const off = await sweepTokens({ listUsers: async () => users, control, prefix: "pda-", now: () => NOW });
  assert.deepEqual(off.removed, [], "without expired, a held run keeps every user");
  const on = await sweepTokens({ listUsers: async () => users, control, prefix: "pda-", expired: true, now: () => NOW });
  assert.deepEqual(on.removed.map((x) => [x.identifier, x.why]).sort(), [["u-exp-by-time", "expired"], ["u-exp-held", "expired"], ["u-odd", "expired"]]);
});

test("token sweep: a failed removal is reported, the rest go on; no users means no delegation listing; a prefix is required", async () => {
  const { control, user } = sweepRig({ a: { status: "done" }, b: { status: "done" } });
  control.removeUser = async function (this: FakeControl, _t, id) {
    this.calls.push({ op: "removeUser", at: performance.now(), arg: id });
    if (id === "u-a") throw new Error("404");
  };
  const r = await sweepTokens({ listUsers: async () => [user("u-a", "a", 3_600_000), user("u-b", "b", 3_600_000)], control, prefix: "pda-", now: () => NOW });
  assert.deepEqual(r.failed, [{ identifier: "u-a", error: "404" }]);
  assert.deepEqual(r.removed.map((x) => x.identifier), ["u-b"]);
  const empty = new FakeControl();
  assert.deepEqual(await sweepTokens({ listUsers: async () => [], control: empty, prefix: "pda-" }), { removed: [], failed: [] });
  assert.deepEqual(empty.ops(), []);
  await assert.rejects(sweepTokens({ listUsers: async () => [], control: empty, prefix: "" }), /prefix/);
});

// ---- deleting a run's tree: revoke, delete, verify ------------------------------------------------------------------------

/**
 * S3 as P7 measured it: DeleteObjects on objects under a delegated subtree (orphaned or not) keeps them and reports no
 * error. `revokeTakes: false` plays a revoke the server accepts but that leaves the delegation in place.
 */
class FakeTree {
  objects = new Set<string>();
  delegations: Delegation[] = [];
  log: string[] = [];
  revokeTakes = true;
  constructor(keys: string[]) {
    keys.forEach((k) => this.objects.add(k));
  }
  #covered(key: string) {
    return this.delegations.some((d) => d.path !== undefined && (key === `${d.path}/` || key.startsWith(`${d.path}/`)));
  }
  async listObjects(prefix: string) {
    return { objects: [...this.objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), commonPrefixes: [] };
  }
  async deleteObjects(keys: string[]) {
    this.log.push(`delete ${keys.length}`);
    for (const k of keys) if (!this.#covered(k)) this.objects.delete(k);
    return { errors: [] };
  }
  async listDelegations() {
    return this.delegations.map((d) => ({ ...d }));
  }
  async revokeDelegation(d: Pick<Delegation, "clientId" | "inodeId">) {
    this.log.push(`revoke ${d.clientId}`);
    if (this.revokeTakes) this.delegations = this.delegations.filter((x) => !(x.clientId === d.clientId && x.inodeId === d.inodeId));
  }
  async putObject() {}
  async addUser() {
    return {};
  }
  async removeUser() {}
}

const TREE = ["runs/r1/", "runs/r1/run.json", "runs/r1/store/", "runs/r1/store/run.sqlite", "runs/r1/work/", "runs/r1/work/a.txt"];

test("deleteRunTree revokes the run's delegation (orphaned too) before deleting, and the prefix ends empty", async () => {
  const fake = new FakeTree([...TREE, "runs/r10/", "runs/r10/run.json"]);
  fake.delegations = [deleg({ clientId: "c-dead", path: "runs/r1", isOrphaned: true }), deleg({ clientId: "c-sibling", path: "runs/r10" })];
  const r = await deleteRunTree(fake as never, "r1");
  assert.deepEqual(r, { objects: TREE.length, revoked: 1 });
  assert.deepEqual((await fake.listObjects("runs/r1/")).objects, []);
  assert.equal(fake.log[0], "revoke c-dead", "the revoke comes first");
  assert.ok(fake.objects.has("runs/r10/run.json") && fake.delegations.some((d) => d.clientId === "c-sibling"), "a sibling run is untouched");
});

test("deleteRunTree never reports success over a prefix that is not empty: a delete the held delegation kept is RUN_TREE_NOT_DELETED", async () => {
  const fake = new FakeTree(TREE);
  fake.delegations = [deleg({ clientId: "c-stuck", path: "runs/r1", isOrphaned: true })];
  fake.revokeTakes = false;
  const err = await deleteRunTree(fake as never, "r1").then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SuperviseError && err.code === "RUN_TREE_NOT_DELETED", String(err));
  assert.match((err as Error).message, /still holds 6 objects .* 1 delegations after revoking 1/);
  assert.equal(fake.objects.size, TREE.length, "the fake kept every object, as S3 does under a delegation");
});

test("deleteRunTree on a released run (no delegation) deletes everything without a revoke", async () => {
  const fake = new FakeTree(TREE);
  assert.deepEqual(await deleteRunTree(fake as never, "r1"), { objects: TREE.length, revoked: 0 });
  assert.ok(!fake.log.some((l) => l.startsWith("revoke")));
  assert.equal(fake.objects.size, 0);
});
