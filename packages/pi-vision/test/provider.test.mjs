// Detection runs once per provider and environment, is remembered, and never throws: a detect that fails is a
// provider that cannot run there, with the reason. An aborted detection is not remembered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITIES, detectOnce } from "@parcha/pi-vision";

const counting = (detect) => {
  const provider = { name: "counted", capabilities: ["text"], kinds: ["pdf"], calls: 0, async detect(env, signal) { provider.calls++; return detect(env, signal); } };
  return provider;
};
const env = (id) => ({ id, cwd: "/" });

test("detection runs once per environment id, and again for another environment", async () => {
  const provider = counting(async (e) => ({ available: true, version: `1.0.0-${e.id}` }));
  const [a, b] = await Promise.all([detectOnce(provider, env("one")), detectOnce(provider, env("one"))]);
  assert.deepEqual(a, { available: true, version: "1.0.0-one" });
  assert.equal(a, b);
  assert.equal(provider.calls, 1);
  assert.deepEqual(await detectOnce(provider, env("two")), { available: true, version: "1.0.0-two" });
  assert.equal(provider.calls, 2);
  await detectOnce(provider, env("one"));
  assert.equal(provider.calls, 2);
});

test("a detect that throws or rejects is a provider that cannot run there, with the first line of the reason", async () => {
  const thrown = counting(() => { throw new Error("ffprobe exited 127\nmore detail"); });
  assert.deepEqual(await detectOnce(thrown, env("x")), { available: false, needs: "counted", reason: "detect failed: ffprobe exited 127" });
  const rejected = counting(async () => { throw new Error("no wasm"); });
  assert.deepEqual(await detectOnce(rejected, env("x")), { available: false, needs: "counted", reason: "detect failed: no wasm" });
  await detectOnce(rejected, env("x"));
  assert.equal(rejected.calls, 1, "the failure is remembered like any detection");
});

test("a detection whose signal was aborted is not remembered", async () => {
  const controller = new AbortController();
  const provider = counting(async (_e, signal) => { if (signal) controller.abort(); return signal?.aborted ? { available: false, needs: "counted", reason: "aborted" } : { available: true, version: "1" }; });
  assert.equal((await detectOnce(provider, env("x"), controller.signal)).available, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await detectOnce(provider, env("x")), { available: true, version: "1" });
  assert.equal(provider.calls, 2);
});

test("the capabilities are the nine a provider may declare", () => {
  assert.deepEqual([...CAPABILITIES], ["text", "positions", "render", "office", "cells", "frames", "clip", "fit", "ocr"]);
});
