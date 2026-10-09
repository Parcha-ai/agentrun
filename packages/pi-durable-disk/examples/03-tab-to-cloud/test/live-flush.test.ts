// A long tool call's files reach the disk while it runs: the write-through ticks on an interval, never stacks a tick behind a
// slow one, and `stop` leaves nothing in flight (a handover reads the baseline right after it).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startLiveFlush } from "../tab/runtime.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the live write-through", () => {
  it("flushes on its interval until stopped, and not after", async () => {
    let calls = 0;
    const live = startLiveFlush(async () => void calls++, 20);
    await sleep(110);
    await live.stop();
    const stopped = calls;
    assert.ok(stopped >= 3, `ticked ${stopped} times`);
    await sleep(80);
    assert.equal(calls, stopped, "no tick after stop");
  });

  it("skips a tick while the previous sync is still running, so a slow sync never queues behind itself", async () => {
    let running = 0;
    let peak = 0;
    let calls = 0;
    const live = startLiveFlush(async () => {
      calls++;
      peak = Math.max(peak, ++running);
      await sleep(70);
      running--;
    }, 10);
    await sleep(160);
    await live.stop();
    assert.equal(peak, 1, "never two at once");
    assert.ok(calls >= 2 && calls <= 3, `${calls} syncs in 160 ms of 70 ms syncs`);
  });

  it("stop waits for the sync in flight and swallows its failure", async () => {
    let finished = false;
    const live = startLiveFlush(async () => {
      await sleep(60);
      finished = true;
      throw new Error("the pipe is gone");
    }, 10);
    await sleep(30);
    await live.stop();
    assert.equal(finished, true, "stop returned only after the sync ended");
  });
});
