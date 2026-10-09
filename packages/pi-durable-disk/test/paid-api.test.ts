// The fake paid API (test/fixtures/paid-api.ts): it counts every dispatch by route and key, never deduplicates, holds
// matching requests open until released, marks a held request whose client went away as cut, and answers its control
// routes for a caller in another process.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { dispatch, startPaidApi } from "./fixtures/paid-api.ts";

const json = async (url: string, init?: RequestInit) => (await fetch(url, init)).json() as Promise<unknown>;

describe("the fake paid API", () => {
  it("counts every dispatch by route and key and never deduplicates", async () => {
    const api = await startPaidApi();
    try {
      const a1 = await dispatch(api.url, "charge", "k1", { n: 1 }, { writer: "w1" });
      const a2 = await dispatch(api.url, "charge", "k1", { n: 1 });
      await dispatch(api.url, "charge", "k2");
      await dispatch(api.url, "model", "k1");
      assert.deepEqual([a1.count, a2.count, a1.seq, a2.seq], [1, 2, 1, 2]);
      assert.deepEqual(api.counts("charge"), { k1: 2, k2: 1 });
      assert.equal(api.count("model", "k1"), 1);
      assert.deepEqual(api.requests("charge").map((r) => [r.key, r.nth, r.writer, r.state]), [["k1", 1, "w1", "answered"], ["k1", 2, null, "answered"], ["k2", 1, null, "answered"]]);
      assert.deepEqual(api.requests("charge")[0]!.body, { n: 1 });
      const res = await fetch(`${api.url}/charge`, { method: "POST", body: "{}" });
      assert.equal(res.status, 400, "no Idempotency-Key, no dispatch");
      assert.equal(api.requests().length, 4);
      await assert.rejects(dispatch(api.url, "charge", ""), /HTTP 400/);
    } finally {
      await api.close();
    }
  });

  it("holds a matching request open, counted and unanswered, until it is released; the hold catches only its count", async () => {
    const api = await startPaidApi();
    try {
      const hold = api.hold({ route: "charge", match: (r) => (r.body as { n?: number }).n === 2 });
      await dispatch(api.url, "charge", "a", { n: 1 });
      let answered = false;
      const held = dispatch(api.url, "charge", "b", { n: 2 }).then((a) => ((answered = true), a));
      const caught = await hold.first;
      assert.equal(caught.key, "b");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(answered, false);
      assert.equal(api.count("charge", "b"), 1, "a held request is already a dispatch");
      const again = await dispatch(api.url, "charge", "c", { n: 2 });
      assert.equal(again.count, 1, "the hold caught one request and stopped matching");
      hold.release();
      assert.equal((await held).seq, caught.seq);
      assert.equal(api.requests("charge").find((r) => r.key === "b")!.state, "answered");
      assert.equal(caught.holdId, hold.id);
    } finally {
      await api.close();
    }
  });

  it("marks a held request whose client goes away before the answer as cut, and never answers it", async () => {
    const api = await startPaidApi();
    try {
      const hold = api.hold({ route: "charge", key: "k" });
      const req = request(`${api.url}/charge`, { method: "POST", headers: { "idempotency-key": "k" } });
      req.on("error", () => undefined);
      req.end("{}");
      const caught = await hold.first;
      req.destroy();
      for (let i = 0; i < 100 && caught.state === "held"; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(caught.state, "cut");
      assert.ok(caught.cutAt! >= caught.receivedAt);
      hold.release();
      assert.equal(caught.state, "cut", "a release does not answer a cut request");
      assert.equal(api.count("charge", "k"), 1);
    } finally {
      await api.close();
    }
  });

  it("waitFor resolves with a past or a future request, and rejects after its time", async () => {
    const api = await startPaidApi();
    try {
      await dispatch(api.url, "model", "m1");
      assert.equal((await api.waitFor((r) => r.key === "m1")).seq, 1);
      const later = api.waitFor((r) => r.key === "m2", 5_000);
      await dispatch(api.url, "model", "m2");
      assert.equal((await later).seq, 2);
      await assert.rejects(api.waitFor((r) => r.key === "never", 20), /no matching request/);
    } finally {
      await api.close();
    }
  });

  it("answers its control routes, so a test in another process can read counters and hold or release", async () => {
    const api = await startPaidApi();
    try {
      const { id } = (await json(`${api.url}/_hold`, { method: "POST", body: JSON.stringify({ route: "charge", key: "x" }) })) as { id: number };
      const pending = dispatch(api.url, "charge", "x");
      await api.waitFor((r) => r.key === "x");
      assert.deepEqual(await json(`${api.url}/_counts?route=charge`), { x: 1 });
      assert.deepEqual(((await json(`${api.url}/_requests?route=charge`)) as { state: string }[]).map((r) => r.state), ["held"]);
      await json(`${api.url}/_release`, { method: "POST", body: JSON.stringify({ id }) });
      assert.equal((await pending).count, 1);
      assert.equal((await fetch(`${api.url}/_nope`)).status, 404);
    } finally {
      await api.close();
    }
  });
});
