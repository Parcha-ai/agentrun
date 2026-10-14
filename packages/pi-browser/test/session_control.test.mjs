import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CREATE_DEADLINE_MS, DEFAULT_BROWSER_POLICY, idleTracker, keyedSerializer } from "../dist/core/session-control.js";

test("the keyed serializer runs each key's work in order, through rejections, and its map is empty after a burst", async () => {
  const serial = keyedSerializer();
  const order = { a: [], b: [] };
  const step = (key, n, fail = false) => serial.run(key, async () => { await sleep(n % 3); order[key].push(n); if (fail) throw new Error(`${key}${n}`); return n; });
  const outcomes = await Promise.allSettled([step("a", 1), step("b", 1, true), step("a", 2, true), step("b", 2), step("a", 3), step("b", 3)]);
  assert.deepEqual(order, { a: [1, 2, 3], b: [1, 2, 3] });
  assert.deepEqual(outcomes.map((o) => o.status), ["fulfilled", "rejected", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  await sleep(0);
  assert.deepEqual(serial.keys(), [], "a settled key is dropped");
});

test("the keyed serializer keeps a key while newer work is queued behind a settling turn", async () => {
  const serial = keyedSerializer();
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = serial.run("k", () => gate);
  const second = serial.run("k", async () => "second");
  release("first");
  assert.equal(await first, "first");
  assert.deepEqual(serial.keys(), ["k"], "the queued turn still holds the key");
  assert.equal(await second, "second");
  await sleep(0);
  assert.deepEqual(serial.keys(), []);
});

test("the idle tracker fires only when nothing is in flight, and only its current timer counts", async () => {
  const fired = [];
  const idle = idleTracker({ idleMs: 20, onIdle: (key, timer, idleMs) => fired.push({ key, current: idle.isCurrent(key, timer), idleMs }) });
  idle.activity("k", 1);
  await sleep(40);
  assert.deepEqual(fired, [], "a call in flight holds the timer");
  idle.activity("k", -1);
  await sleep(40);
  assert.deepEqual(fired, [{ key: "k", current: true, idleMs: 20 }]);
  let stale;
  const late = idleTracker({ idleMs: 10, onIdle: (_key, timer) => { stale = timer; } });
  late.activity("k", 0);
  await sleep(25);
  late.activity("k", 1);
  assert.equal(late.isCurrent("k", stale), false, "a call since the timer fired makes it stale");
  late.clear();
});

test("forget with nothing in flight clears the key's timer and entry at once", async () => {
  const fired = [];
  const idle = idleTracker({ idleMs: 15, onIdle: (key) => fired.push(key) });
  idle.activity("k", 0);
  idle.forget("k");
  await sleep(30);
  assert.deepEqual(fired, [], "a forgotten timer never fires");
  assert.deepEqual(idle.keys(), []);
  idle.activity("k", 1);
  idle.activity("k", -1);
  await sleep(30);
  assert.deepEqual(fired, ["k"], "a later call starts the key afresh");
  idle.clear();
});

test("forget during a call in flight leaves no timer and no entry once the call ends", async () => {
  const fired = [];
  const idle = idleTracker({ idleMs: 15, onIdle: (key) => fired.push(key) });
  idle.activity("k", 1);
  idle.activity("k", 1);
  idle.forget("k");
  idle.activity("k", -1);
  await sleep(30);
  assert.deepEqual(fired, [], "the first call to end arms nothing under the second");
  idle.activity("k", -1);
  await sleep(30);
  assert.deepEqual(fired, [], "nothing is armed after forget");
  assert.deepEqual(idle.keys(), []);
});

test("cancel clears a key's timer and keeps its in-flight count", async () => {
  const fired = [];
  const idle = idleTracker({ idleMs: 15, onIdle: (key) => fired.push(key) });
  idle.activity("k", 1);
  idle.activity("k", 1);
  idle.cancel("k");
  idle.activity("k", -1);
  await sleep(30);
  assert.deepEqual(fired, [], "the second call still holds the timer");
  idle.activity("k", -1);
  idle.cancel("k");
  await sleep(30);
  assert.deepEqual(fired, [], "a cancelled timer never fires");
  assert.deepEqual(idle.keys(), ["k"]);
  idle.clear();
});

test("the shared defaults are the values both adapters used", () => {
  assert.equal(CREATE_DEADLINE_MS, 60_000);
  assert.deepEqual({ ...DEFAULT_BROWSER_POLICY }, { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 });
  assert.ok(Object.isFrozen(DEFAULT_BROWSER_POLICY));
});

test("the package index exports the shared defaults, frozen, so a host's BrowserConfig can spread them; the serializer and the tracker stay internal", async () => {
  const index = await import("../dist/index.js");
  assert.equal(index.DEFAULT_BROWSER_POLICY, DEFAULT_BROWSER_POLICY);
  assert.ok(Object.isFrozen(index.DEFAULT_BROWSER_POLICY));
  assert.deepEqual([index.keyedSerializer, index.idleTracker, index.CREATE_DEADLINE_MS], [undefined, undefined, undefined]);
});

test("every provider key the adapters read is in the one list the redactors use", async () => {
  const { PROVIDER_KEY_ENV, providerKeyValues } = await import("../dist/core/session-control.js");
  assert.deepEqual([...PROVIDER_KEY_ENV], ["BROWSERBASE_API_KEY", "BB_API_KEY", "KERNEL_API_KEY"]);
  assert.deepEqual(providerKeyValues({ BROWSERBASE_API_KEY: ["bb-value"].join(""), KERNEL_API_KEY: ["kernel-value"].join(""), OTHER: "x" }), ["bb-value", "kernel-value"]);
  assert.deepEqual(providerKeyValues({ BB_API_KEY: ["bb-value"].join("") }, () => ["host-value"]), ["bb-value", "host-value"]);
});
