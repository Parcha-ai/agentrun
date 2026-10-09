// What bounds a machine when the serve that made it is gone: its hard lifetime (the provider's sandbox timeout), on
// every create; and the serve's one cleanup on a signal, a crash or an unhandled rejection. No machine is made.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { daytonaFleet, DEFAULT_TTL_MINUTES, machineLifetime, TTL_MARGIN_MINUTES } from "../daytona-fleet.ts";
import { cleanupOnExit, stagedCleanup } from "../exit-cleanup.ts";

test("the hard lifetime: 30 min by default, raised to cover warm-up and training, never shorter than both plus the margin", () => {
  assert.equal(DEFAULT_TTL_MINUTES, 30);
  assert.equal(machineLifetime(undefined, 6), 30);
  assert.equal(machineLifetime(undefined, 25), 25 + TTL_MARGIN_MINUTES);
  // The warm compile runs on the same machine before training (serve's budget: 900 s).
  assert.equal(machineLifetime(undefined, 6, 15), 15 + 6 + TTL_MARGIN_MINUTES);
  assert.equal(machineLifetime(undefined, 25, 15), 15 + 25 + TTL_MARGIN_MINUTES);
  assert.equal(machineLifetime(20, 8), 20);
  assert.throws(() => machineLifetime(15, 8), /ends before the warm-up \(0 min\), the training \(8 min\)/);
  assert.throws(() => machineLifetime(30, 6, 15), /ends before the warm-up \(15 min\)/);
  assert.throws(() => machineLifetime(Number.NaN, 8), /ends before/);
});

test("a budget that is not a number of minutes is refused, given a lifetime or not", () => {
  for (const ttl of [undefined, 60]) {
    for (const minutes of [Number.NaN, Number("abc"), -1, Number.POSITIVE_INFINITY]) {
      assert.throws(() => machineLifetime(ttl, minutes), /the training budget is a number of minutes/, `ttl ${ttl}, minutes ${minutes}`);
    }
    assert.throws(() => machineLifetime(ttl, 6, Number.NaN), /the warm-up budget is a number of minutes/);
  }
});

test("every box is created with the hard lifetime: the provider destroys it at that age whatever happens to the serve", async () => {
  const bodies: { ttlMinutes?: number; name: string }[] = [];
  const client = {
    async create(body: { ttlMinutes?: number; name: string }) {
      bodies.push(body);
      throw new Error("no machine in a test");
    },
  };
  const make = (ttlMinutes?: number) =>
    daytonaFleet({ client: client as never, snapshot: "im-test", fleet: "test", namePrefix: "pda-test-", placement: () => ({}) as never, ...(ttlMinutes ? { ttlMinutes } : {}) } as never);
  await assert.rejects(make().warm("a"), /no machine in a test/);
  await assert.rejects(make(18).warm("b"), /no machine in a test/);
  assert.deepEqual(bodies.map((b) => b.ttlMinutes), [DEFAULT_TTL_MINUTES, 18]);
});

test("a signal, a crash or an unhandled rejection runs the one cleanup and then exits; a second signal waits for it", async () => {
  for (const [event, code] of [["SIGINT", 130], ["SIGTERM", 130], ["uncaughtException", 1], ["unhandledRejection", 1]] as const) {
    const proc = Object.assign(new EventEmitter(), { exits: [] as number[], exit(c: number) { this.exits.push(c); } });
    let runs = 0;
    let finish!: () => void;
    const cleanup = () => {
      runs++;
      return new Promise<void>((r) => (finish = r));
    };
    const shared = (() => { let p: Promise<void> | undefined; return () => (p ??= cleanup()); })();
    const logs: string[] = [];
    cleanupOnExit(shared, proc, (e) => void logs.push(e));
    proc.emit(event, event === "SIGINT" || event === "SIGTERM" ? undefined : new Error("boom"));
    proc.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(proc.exits, [], `${event}: no exit before the cleanup ended`);
    finish();
    await new Promise((r) => setImmediate(r));
    assert.equal(runs, 1, `${event}: one cleanup`);
    assert.equal(proc.exits[0], code, `${event}: exit ${code}`);
    if (code === 1) assert.ok(logs.includes("crashed"));
  }
});

test("a cleanup that fails still exits, and says so", async () => {
  const proc = Object.assign(new EventEmitter(), { exits: [] as number[], exit(c: number) { this.exits.push(c); } });
  const logs: string[] = [];
  cleanupOnExit(() => Promise.reject(new Error("modal down")), proc, (e) => void logs.push(e));
  proc.emit("SIGTERM");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(proc.exits, [130]);
  assert.ok(logs.includes("cleanup.failed"));
});

test("a staged cleanup: the startup one until the whole one is ready, whichever is current runs once", async () => {
  const ran: string[] = [];
  const early = stagedCleanup(async () => void ran.push("startup"));
  await Promise.all([early.cleanup(), early.cleanup()]);
  early.ready(async () => void ran.push("full"));
  await early.cleanup();
  assert.deepEqual(ran, ["startup"], "a failure during startup ran the startup cleanup, once; nothing ran it again");
  ran.length = 0;
  const late = stagedCleanup(async () => void ran.push("startup"));
  late.ready(async () => void ran.push("full"));
  await Promise.all([late.cleanup(), late.cleanup()]);
  assert.deepEqual(ran, ["full"]);
});

test("a run stamp is the time in base 36 and 32 random bits: two serves in one millisecond differ by their random bits", async () => {
  const { runStamp } = await import("../source.ts");
  const at = 1_700_000_000_000;
  assert.equal(runStamp(at, () => Uint8Array.of(0xde, 0xad, 0xbe, 0xef)), `${at.toString(36)}deadbeef`);
  assert.notEqual(runStamp(at, () => Uint8Array.of(1, 2, 3, 4)), runStamp(at, () => Uint8Array.of(1, 2, 3, 5)));
  assert.match(runStamp(at), new RegExp(`^${at.toString(36)}[0-9a-f]{8}$`));
});

test("a repeated run id another client holds is refused at create and never listed, so this serve's cleanup leaves it", async () => {
  const { makeSourceRun } = await import("../source.ts");
  const noted: string[] = [];
  // The disk answers 409 to the directory's create: another serve holds this id.
  const control = { putObject: async () => Promise.reject(Object.assign(new Error("Conflict"), { status: 409 })) };
  await assert.rejects(
    makeSourceRun({ control: control as never, ref: { disk: "dsk-test", region: "test", id: "d1-src-same" }, mountRoot: "/nonexistent", story: "", onResource: (kind, id) => void noted.push(`${kind} ${id}`), log: () => {} }),
    (e: unknown) => e instanceof Error && /held by another client/.test(e.message),
  );
  assert.deepEqual(noted, [], "nothing listed: the startup cleanup deletes only what onResource listed");
});

test("a signal while a run is being created waits for the create, then cleans what it made", async () => {
  const listed: string[] = [];
  const deleted: string[] = [];
  const staged = stagedCleanup(async () => void deleted.push(...listed));
  let land!: () => void;
  // The create was sent; its directory exists once it lands, and only then is it listed.
  const create = staged.track(new Promise<void>((r) => (land = () => (listed.push("d1-src-x"), r()))));
  const cleaning = staged.cleanup();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(deleted, [], "the cleanup waits for the create in flight");
  land();
  await create;
  await cleaning;
  assert.deepEqual(deleted, ["d1-src-x"]);
});

test("a refused create is waited for and lists nothing; a create that never answers holds the cleanup only settleMs", async () => {
  const deleted: string[] = [];
  const staged = stagedCleanup(async () => void deleted.push("cleaned"), { settleMs: 30 });
  void staged.track(Promise.reject(new Error("held by another client"))).catch(() => undefined);
  void staged.track(new Promise(() => {}));
  const t0 = Date.now();
  await staged.cleanup();
  assert.ok(Date.now() - t0 < 1_000, "bounded");
  assert.deepEqual(deleted, ["cleaned"]);
});
