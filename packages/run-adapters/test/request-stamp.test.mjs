// A model request's record says when it left (GRE-4835): the booking writes `runner.request` before the request leaves,
// stamped `at` on the port's clock, with the input it was admitted with (`inputTokensMax`), so a reader shows a request
// still in flight (no `runner.turn` yet) from its start, on every harness the booking runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPortFor, RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";

const key = "chat:c1";
const requests = async (store) => (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => r.data);

test("a request's record is stamped when it left, on the port's clock, with the input it was admitted with", async () => {
  const store = memorySessionStore();
  let now = Date.parse("2026-11-23T22:48:36.000Z");
  const booking = await modelPortFor(await store.open(key), { key, now: () => now });
  await booking.models.beforeRequest({ model: "ollama/inkling-2-mini", inputTokensMax: 17_355 });
  assert.deepEqual(await requests(store), [{ turn: 1, model: "ollama/inkling-2-mini", at: "2026-11-23T22:48:36.000Z", inputTokensMax: 17_355 }]);
  // Answered, it has its turn record; the next request is stamped at its own time.
  await booking.models.afterRequest({ input: 17_355, output: 1, cacheRead: 0 });
  now += 53_000;
  await booking.models.beforeRequest({ model: "ollama/inkling-2-mini" });
  const [, second] = await requests(store);
  assert.equal(second.at, "2026-11-23T22:49:29.000Z");
  assert.equal("inputTokensMax" in second, false, "none asked, none written");
});

test("the stamp is the wall clock where the port is given none", async () => {
  const store = memorySessionStore();
  const before = Date.now();
  const booking = await modelPortFor(await store.open(key), { key });
  await booking.models.beforeRequest({ model: "m" });
  const [first] = await requests(store);
  const at = Date.parse(first.at);
  assert.ok(at >= before && at <= Date.now(), first.at);
});
