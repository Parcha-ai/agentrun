// The GPU pool's money rules: boxes come up in parallel, threads get one each and wait their turn, a box released goes to the next thread,
// a failed box does not hang anyone, and close leaves nothing behind (a box still being created included).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GpuPool, type PoolBox } from "../gpu-pool.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function world(size: number, opts: { dead?: Set<string>; createMs?: (i: number) => number; fail?: (i: number) => boolean; removeFails?: (id: string, attempt: number) => boolean; closeWaitMs?: number } = {}) {
  const removed: string[] = [];
  const attempts = new Map<string, number>();
  const created: PoolBox[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const pool = new GpuPool({
    size,
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
