// What bounds a machine when the serve that made it is gone: its hard lifetime (the provider's sandbox timeout), on
// every create; and the serve's one cleanup on a signal, a crash or an unhandled rejection. No machine is made.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { daytonaFleet, DEFAULT_TTL_MINUTES, machineLifetime, TTL_MARGIN_MINUTES } from "../daytona-fleet.ts";
import { cleanupOnExit } from "../exit-cleanup.ts";

test("the hard lifetime: 30 min by default, raised to cover the training, and never shorter than the training plus its margin", () => {
  assert.equal(DEFAULT_TTL_MINUTES, 30);
  assert.equal(machineLifetime(undefined, 6), 30);
  assert.equal(machineLifetime(undefined, 25), 25 + TTL_MARGIN_MINUTES);
  assert.equal(machineLifetime(20, 8), 20);
  assert.throws(() => machineLifetime(15, 8), /ends before the training \(8 min\)/);
  assert.throws(() => machineLifetime(Number.NaN, 8), /ends before/);
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
