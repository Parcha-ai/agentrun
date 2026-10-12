// The GPU pool's money rules: boxes come up in parallel, threads get one each and wait their turn, a box released goes to the next thread,
// a failed box does not hang anyone, and close leaves nothing behind (a box still being created included).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GpuPool, type PoolBox } from "../gpu-pool.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function world(size: number, opts: { spares?: number; dead?: Set<string>; createMs?: (i: number) => number; fail?: (i: number) => boolean; removeFails?: (id: string, attempt: number) => boolean; closeWaitMs?: number } = {}) {
  const removed: string[] = [];
  const attempts = new Map<string, number>();
  const created: PoolBox[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const pool = new GpuPool({
    size,
    ...(opts.spares ? { spares: opts.spares } : {}),
    log: (event, data = {}) => void logs.push({ event, data }),
    alive: async (box) => !(opts.dead?.has(box.id)),
    watchMs: 0,
    ...(opts.closeWaitMs ? { closeWaitMs: opts.closeWaitMs } : {}),
    create: async (index) => {
      await sleep(opts.createMs?.(index) ?? 5);
      if (opts.fail?.(index)) throw new Error(`no capacity for box ${index}`);
      const box = { id: `sb-${index}`, name: `box-${index}`, index };
      created.push(box);
      return box;
    },
    remove: async (box) => {
      const n = (attempts.get(box.id) ?? 0) + 1;
      attempts.set(box.id, n);
      if (opts.removeFails?.(box.id, n)) throw new Error("modal is having a moment");
      removed.push(box.id);
      return true;
    },
  });
  return { pool, removed, created, logs };
}

describe("the GPU pool", () => {
  it("creates every box in parallel and hands out one per thread, first come first served", async () => {
    const w = world(3, { createMs: () => 60 });
    const t0 = Date.now();
    await w.pool.start();
    assert.ok(Date.now() - t0 < 150, `the boxes came up together (${Date.now() - t0} ms), not one after another`);
    const boxes = await Promise.all(["a", "b", "c"].map((t) => w.pool.acquire(t)));
    assert.deepEqual(new Set(boxes.map((b) => b.id)).size, 3, "three threads, three different boxes");
    assert.deepEqual(w.pool.status().boxes.map((b) => b.state), ["busy", "busy", "busy"]);
    await w.pool.close();
  });

  it("makes threads wait when there are fewer boxes than threads, and a released box goes to the next waiting thread in order", async () => {
    const w = world(2);
    await w.pool.start();
    const order: string[] = [];
    const run = async (thread: string, workMs: number) => {
      const box = await w.pool.acquire(thread);
      order.push(`${thread}@${box.index}`);
      await sleep(workMs);
      w.pool.release(thread);
    };
    await Promise.all([run("a", 80), run("b", 30), run("c", 10), run("d", 10)]);
    assert.deepEqual(order.slice(0, 2).sort(), ["a@0", "b@1"].sort());
    assert.equal(order[2]!.split("@")[0], "c", "c was first in line");
    assert.equal(order[3]!.split("@")[0], "d");
    assert.equal(order[2]!.split("@")[1], "1", "c took the box b released first");
    await w.pool.close();
  });

  it("a thread holds one box, and asking again returns that same box (a restart reruns the acquire)", async () => {
    const w = world(2);
    await w.pool.start();
    const first = await w.pool.acquire("a");
    const again = await w.pool.acquire("a");
    assert.equal(again.id, first.id);
    assert.equal(w.pool.status().boxes.filter((b) => b.state === "busy").length, 1, "still one busy box, not two");
    await w.pool.close();
  });

  it("a box that fails to come up is reported and does not stop the others; when none comes up, waiting threads fail instead of hanging", async () => {
    const half = world(2, { fail: (i) => i === 0 });
    await half.pool.start();
    assert.equal(half.pool.status().boxes[0]!.state, "failed");
    assert.match(half.pool.status().boxes[0]!.error ?? "", /no capacity/);
    assert.equal((await half.pool.acquire("a")).index, 1);
    await half.pool.close();

    const none = world(2, { fail: () => true, createMs: () => 30 });
    const starting = none.pool.start();
    const waiting = none.pool.acquire("a");
    await assert.rejects(waiting, /no GPU box came up/);
    await starting;
    await none.pool.close();
  });

  it("close removes every box, retries one that would not go, and says what is left", async () => {
    const w = world(3, { removeFails: (id, attempt) => id === "sb-1" && attempt < 3 });
    await w.pool.start();
    await w.pool.acquire("a");
    const r = await w.pool.close();
    assert.deepEqual(w.removed.sort(), ["sb-0", "sb-1", "sb-2"], "all three removed, the stubborn one on the third try");
    assert.equal(r.left, 0);

    const stuck = world(2, { removeFails: (id) => id === "sb-0" });
    await stuck.pool.start();
    const left = await stuck.pool.close();
    assert.equal(left.left, 1, "close says one box could not be removed");
    assert.ok(stuck.logs.some((l) => l.event === "pool.close-left"));
  });

  it("a box still being created when close begins is removed when it lands, and waiting threads are told the pool is closing", async () => {
    const w = world(2, { createMs: (i) => (i === 0 ? 5 : 150) });
    const starting = w.pool.start();
    await sleep(30); // box 0 is up, box 1 is still being created
    const waiting = w.pool.acquire("a");
    const taken = await waiting; // box 0 serves it
    assert.equal(taken.index, 0);
    const second = w.pool.acquire("b"); // waits for box 1
    const closing = w.pool.close();
    await assert.rejects(second, /closing/);
    await closing;
    await starting;
    assert.deepEqual(w.removed.sort(), ["sb-0", "sb-1"], "the late box was removed, nothing is left");
    assert.ok(w.logs.some((l) => l.event === "pool.late-box"));
    await assert.rejects(w.pool.acquire("c"), /closing/);
  });

  it("a wait for a box can be cancelled", async () => {
    const w = world(1);
    await w.pool.start();
    await w.pool.acquire("a");
    const ac = new AbortController();
    const waiting = w.pool.acquire("b", ac.signal);
    ac.abort();
    await assert.rejects(waiting, /cancelled/);
    w.pool.release("a");
    assert.equal((await w.pool.acquire("c")).index, 0, "the cancelled thread did not take the box");
    await w.pool.close();
  });
});

describe("the GPU pool: one thread, one box", () => {
  it("two requests for the same thread share one wait and get the same box, whether the boxes are still coming up or all busy", async () => {
    const coming = world(2, { createMs: () => 80 });
    const starting = coming.pool.start();
    const [a1, a2] = await Promise.all([coming.pool.acquire("a"), coming.pool.acquire("a")]);
    assert.equal(a1.id, a2.id, "both requests got the same box");
    await starting;
    assert.equal(coming.pool.status().boxes.filter((b) => b.state === "busy").length, 1, "one busy box, not two");
    coming.pool.release("a");
    assert.equal(coming.pool.status().boxes.filter((b) => b.state === "busy").length, 0, "release frees it");
    await coming.pool.close();

    const full = world(1);
    await full.pool.start();
    await full.pool.acquire("holder");
    const w1 = full.pool.acquire("b");
    const w2 = full.pool.acquire("b");
    assert.equal(w1, w2, "the same pending wait");
    full.pool.release("holder");
    const [b1, b2] = await Promise.all([w1, w2]);
    assert.equal(b1.id, b2.id);
    await full.pool.close();
  });

  it("a box that lands after close and will not go the first time is removed on a retry", async () => {
    const w = world(1, { createMs: () => 100, removeFails: (_id, attempt) => attempt < 3 });
    const starting = w.pool.start();
    await w.pool.close();
    await starting;
    assert.deepEqual(w.removed, ["sb-0"], "removed on the third try");
    assert.ok(!w.logs.some((l) => l.event === "pool.late-box-left"));
  });
});

describe("the GPU pool: boxes that ended", () => {
  it("a box that ended while a thread held it is not handed to the next thread; the waiter gets the surviving box", async () => {
    const dead = new Set<string>();
    const w = world(2, { dead });
    await w.pool.start();
    const a = await w.pool.acquire("a");
    await w.pool.acquire("b");
    const waiting = w.pool.acquire("c"); // both busy: c waits
    dead.add(a.id); // a's box ended (its TTL)
    w.pool.release("a"); // the thread lets go of a box that is already gone
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.pool.status().boxes.find((b) => b.id === a.id)?.state, "failed", "the ended box is dead, not ready");
    w.pool.release("b");
    const got = await waiting;
    assert.notEqual(got.id, a.id, "c did not get the dead box");
    assert.ok(w.logs.some((l) => l.event === "pool.box-dead"));
    await w.pool.close();
  });

  it("when every box ended, waiting threads fail with a clear error instead of waiting for ever", async () => {
    const w = world(1);
    await w.pool.start();
    const a = await w.pool.acquire("a");
    const waiting = w.pool.acquire("b");
    w.pool.markDead(a.id, "exit 137"); // the server's poll saw it end
    await assert.rejects(waiting, /every GPU box ended/);
    await w.pool.close();
  });

  it("markDead is idempotent and ignores a box it does not know", async () => {
    const w = world(1);
    await w.pool.start();
    const a = await w.pool.acquire("a");
    w.pool.markDead(a.id, "x");
    w.pool.markDead(a.id, "x");
    w.pool.markDead("nope", "x");
    assert.equal(w.logs.filter((l) => l.event === "pool.box-dead").length, 1);
    await w.pool.close();
  });
});

describe("the GPU pool: a liveness check that does not answer", () => {
  it("does not keep a released box blocked: after the check's deadline the box is available again", async () => {
    const removed: string[] = [];
    const pool = new GpuPool({
      size: 1,
      log: () => undefined,
      create: async (index) => ({ id: `sb-${index}`, name: `box-${index}`, index }),
      remove: async (box) => (removed.push(box.id), true),
      alive: () => new Promise<boolean>(() => undefined), // Modal never answers
      aliveTimeoutMs: 100,
      watchMs: 0,
    });
    await pool.start();
    await pool.acquire("a");
    pool.release("a");
    const t0 = Date.now();
    const next = await pool.acquire("b"); // waits for the check, then gets the box
    assert.equal(next.id, "sb-0");
    assert.ok(Date.now() - t0 >= 90 && Date.now() - t0 < 2_000, `waited for the deadline (${Date.now() - t0} ms), not for ever`);
    await pool.close();
  });
});

describe("the GPU pool: a liveness answer that comes late", () => {
  it("a box found dead after the check's deadline is marked dead then, not forgotten", async () => {
    let answer!: (alive: boolean) => void;
    const logs: string[] = [];
    const pool = new GpuPool({
      size: 1,
      log: (event) => void logs.push(event),
      create: async (index) => ({ id: `sb-${index}`, name: `box-${index}`, index }),
      remove: async () => true,
      alive: () => new Promise<boolean>((r) => (answer = r)),
      aliveTimeoutMs: 50,
      watchMs: 0,
    });
    await pool.start();
    await pool.acquire("a");
    pool.release("a"); // the check starts and does not answer in 50 ms: the box stays available
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pool.status().boxes[0]!.state, "ready");
    answer(false); // Modal answers late: the box had ended
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pool.status().boxes[0]!.state, "failed", "the late answer was acted on");
    assert.ok(logs.includes("pool.box-dead"));
    await pool.close();
  });
});

describe("the GPU pool: a spare box", () => {
  it("is ready when the boxes needed are up: a slow box among the extra ones does not hold the start", async () => {
    // Three boxes made for two needed; the one that is slow (box 1) is the straggler.
    const w = world(2, { spares: 1, createMs: (i) => (i === 1 ? 400 : 20) });
    const t0 = Date.now();
    await w.pool.start();
    assert.ok(Date.now() - t0 < 300, `ready after ${Date.now() - t0} ms, before the straggler`);
    assert.equal(w.pool.status().boxes.filter((b) => b.state === "ready").length, 2);
    assert.equal(w.pool.status().boxes.length, 3);
    // The straggler lands later and joins the pool as a ready box.
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(w.pool.status().boxes.filter((b) => b.state === "ready").length, 3);
    await w.pool.close();
    assert.deepEqual(w.removed.sort(), ["sb-0", "sb-1", "sb-2"]);
  });

  it("a spare stands in for a box that ended, and close removes a straggler that lands after it began", async () => {
    const w = world(1, { spares: 1, createMs: (i) => (i === 1 ? 300 : 10) });
    await w.pool.start();
    const a = await w.pool.acquire("a");
    w.pool.markDead(a.id, "exit 137");
    const closing = w.pool.close(); // the spare is still being created
    await closing;
    assert.deepEqual(w.removed.sort(), ["sb-0", "sb-1"], "the straggler that landed during close was removed too");
  });
});

describe("the GPU pool: idle timeout", () => {
  it("removes its boxes after sitting unused, leaves them alone while a thread holds one, and makes them again on the next request", async () => {
    let made = 0;
    const removed: string[] = [];
    const logs: string[] = [];
    const pool = new GpuPool({
      size: 2,
      log: (event) => void logs.push(event),
      create: async () => {
        const index = made++;
        return { id: `sb-${index}`, name: `box-${index}`, index: index % 2 };
      },
      remove: async (box) => (removed.push(box.id), true),
      idleMs: 200,
      watchMs: 0,
    });
    await pool.start();
    const a = await pool.acquire("a"); // a thread holds a box: the pool is in use
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(removed, [], "nothing removed while a thread holds a box");
    pool.release("a");
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(removed.sort(), ["sb-0", "sb-1"], "both boxes removed after the pool sat unused");
    assert.ok(logs.includes("pool.idle-timeout"));
    assert.deepEqual(pool.status().boxes.map((b) => b.state), ["idle", "idle"]);
    assert.equal(logs.filter((e) => e === "pool.box-removed").length, 2, "each removed box says so, so the report of how many are up drops");
    // The next request makes boxes again and is served.
    const b = await pool.acquire("b");
    assert.ok(logs.includes("pool.wake"));
    assert.notEqual(b.id, a.id, "a new box, not the removed one");
    await pool.close();
    assert.ok(removed.join(",").includes(b.id), "and it is removed at close");
  });

  it("a command running in a box keeps the pool from going idle (touch)", async () => {
    const removed: string[] = [];
    const pool = new GpuPool({ size: 1, log: () => undefined, create: async (index) => ({ id: `sb-${index}`, name: "b", index }), remove: async (box) => (removed.push(box.id), true), idleMs: 200, watchMs: 0 });
    await pool.start();
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 80));
      pool.touch();
    }
    assert.deepEqual(removed, [], "kept alive by activity");
    await pool.close();
  });
});

describe("the GPU pool: the idle clock", () => {
  it("starts when the pool starts, not when it was built: a server up for longer than the idle time does not lose its boxes the moment a page attaches", async () => {
    const removed: string[] = [];
    const logs: string[] = [];
    let clock = 0; // a driven clock: a slow machine cannot make the pool look idle
    const pool = new GpuPool({ size: 2, log: (event) => void logs.push(event), create: async (index) => ({ id: `sb-${index}`, name: `b${index}`, index }), remove: async (box) => (removed.push(box.id), true), idleMs: 300, watchMs: 0, now: () => clock });
    clock = 10_000; // the server sat waiting for the person to open the link, far longer than the idle time
    await pool.start();
    await new Promise((r) => setTimeout(r, 200)); // the idle check runs every 150 ms of real time
    assert.deepEqual(removed, [], "freshly created boxes are not removed by an idle clock that began before they existed");
    assert.ok(!logs.includes("pool.idle-timeout"));
    clock += 301; // now they have really sat unused for the idle time
    for (let i = 0; i < 40 && removed.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(removed.sort(), ["sb-0", "sb-1"]);
    await pool.close();
  });
});

describe("the GPU pool: idle removal that fails", () => {
  it("a box that would not be removed is still usable: a request that came during the removal is served, not left waiting for ever", async () => {
    let made = 0;
    const pool = new GpuPool({
      size: 1,
      log: () => undefined,
      create: async () => ({ id: `sb-${made}`, name: `box-${made}`, index: made++ }),
      remove: async () => false, // Modal will not take the removal
      idleMs: 100,
      watchMs: 0,
    });
    await pool.start();
    await new Promise((r) => setTimeout(r, 160)); // idle: the removal starts and fails
    const got = await Promise.race([pool.acquire("a"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the request waited for ever")), 3_000))]);
    assert.equal(got.id, "sb-0", "the box that would not go is handed out");
    await pool.close();
  });
});

describe("the GPU pool: waking after a partial idle removal", () => {
  it("with one box that would not be removed, three waiting threads are all served: the survivor and two new boxes", async () => {
    let made = 0;
    const live = new Set<string>();
    const pool = new GpuPool({
      size: 3,
      log: () => undefined,
      create: async (index) => {
        const id = `sb-${made++}`;
        live.add(id);
        return { id, name: id, index };
      },
      remove: async (box) => (box.index === 2 ? false : (live.delete(box.id), true)), // the third box will not go
      idleMs: 100,
      watchMs: 0,
    });
    await pool.start();
    await new Promise((r) => setTimeout(r, 180)); // idle: two removed, one stays
    const got = await Promise.race([
      Promise.all(["a", "b", "c"].map((t) => pool.acquire(t))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("a thread waited for ever")), 4_000)),
    ]);
    assert.equal(new Set(got.map((b) => b.id)).size, 3, "three different boxes");
    assert.ok(got.some((b) => b.index === 2), "the box that would not go is one of them");
    await pool.close();
  });
});

describe("the GPU pool: a box that did not place is made again", () => {
  const until = async (check: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error("timed out");
  };

  it("a create that never places is tried again with a fresh request, and the box comes up (code9: three of four never placed)", async () => {
    const calls: number[] = [];
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const pool = new GpuPool({
      size: 2,
      log: (event, data = {}) => void logs.push({ event, data }),
      create: async (index) => {
        calls.push(index);
        if (index === 0 && calls.filter((i) => i === 0).length === 1) throw new Error("GPU box 0 did not place in 90 s");
        return { id: `sb-${index}-${calls.length}`, name: `b${index}`, index };
      },
      remove: async () => true,
      retryDelaysMs: [20],
      watchMs: 0,
    });
    await pool.start(); // resolves once every first attempt has settled: box 0 failed, box 1 is up
    assert.deepEqual(pool.status().boxes.map((b) => b.state), ["failed", "ready"]);
    assert.equal(pool.status().boxes[0]!.retrying, true, "the failed box says it is being retried");
    await until(() => pool.status().boxes.every((b) => b.state === "ready"));
    assert.deepEqual(calls, [0, 1, 0], "a second, fresh create for box 0");
    const retry = logs.find((l) => l.event === "pool.box-retry")!;
    assert.deepEqual({ index: retry.data.index, attempt: retry.data.attempt, afterMs: retry.data.afterMs, previous: retry.data.previous }, { index: 0, attempt: 2, afterMs: 20, previous: "GPU box 0 did not place in 90 s" });
    assert.equal(pool.status().boxes[0]!.attempt, 2);
    await pool.close();
  });

  it("a thread that asks while its only box is being retried waits for it instead of being told no box can come up", async () => {
    let made = 0;
    const pool = new GpuPool({ size: 1, log: () => undefined, create: async (index) => (++made === 1 ? Promise.reject(new Error("did not place")) : { id: "sb-late", name: "late", index }), remove: async () => true, retryDelaysMs: [30], watchMs: 0 });
    await pool.start();
    assert.equal(pool.status().boxes[0]!.state, "failed");
    const box = await pool.acquire("walk"); // before the retry fires
    assert.equal(box.id, "sb-late");
    await pool.close();
  });

  it("without a retry setting a failed box stays failed, and its waiter is told so", async () => {
    const pool = new GpuPool({ size: 1, log: () => undefined, create: async () => Promise.reject(new Error("did not place")), remove: async () => true, watchMs: 0 });
    await pool.start();
    await assert.rejects(pool.acquire("walk"), /no GPU box came up/);
    await pool.close();
  });

  it("the delays repeat their last value, every attempt is logged, and closing stops the retrying", async () => {
    const logs: Record<string, unknown>[] = [];
    let creates = 0;
    const pool = new GpuPool({ size: 1, log: (event, data = {}) => void (event === "pool.box-retry" && logs.push(data)), create: async () => (creates++, Promise.reject(new Error("did not place"))), remove: async () => true, retryDelaysMs: [5, 15], watchMs: 0 });
    await pool.start();
    await until(() => logs.length >= 3);
    assert.deepEqual(logs.slice(0, 3).map((l) => [l.attempt, l.afterMs]), [[2, 5], [3, 15], [4, 15]]);
    await pool.close();
    const after = creates;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(creates, after, "no create after the pool closed");
  });
});
