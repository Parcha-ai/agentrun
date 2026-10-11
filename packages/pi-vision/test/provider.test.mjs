// Detection runs once per provider and environment, is remembered, and never throws: a detect that fails is a
// provider that cannot run there, with the reason. It runs with no caller's signal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITIES, CAPABILITY_METHODS, detectOnce } from "@parcha/pi-vision";

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

test("the shared detection runs with no caller's signal, so no caller's cancellation decides another's answer", async () => {
  const signals = [];
  const provider = counting(async (_e, signal) => { signals.push(signal); return { available: true, version: "1" }; });
  const first = new AbortController();
  const [a, b] = [detectOnce(provider, env("x"), first.signal), detectOnce(provider, env("x"))];
  first.abort();
  assert.deepEqual([await a, await b], [{ available: true, version: "1" }, { available: true, version: "1" }]);
  assert.deepEqual(signals, [undefined]);
});

test("the capabilities are the nine a provider may declare, each served by its method; positions and ocr have none yet", () => {
  assert.deepEqual([...CAPABILITIES], ["text", "positions", "render", "office", "cells", "frames", "clip", "fit", "ocr"]);
  assert.deepEqual(Object.keys(CAPABILITY_METHODS), [...CAPABILITIES]);
  assert.deepEqual({ ...CAPABILITY_METHODS }, { text: "text", positions: null, render: "render", office: "office", cells: "cells", frames: "frames", clip: "clip", fit: "prepare", ocr: null });
});
