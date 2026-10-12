// The service worker's two paths: a model chunk is answered from the cache first (it is immutable and was sha-checked when cached), everything else from the network first
// with a short timeout and the cache only as the fallback, and a network answer is never stored (so another page on the origin is never changed by a checkout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey } from "../tab/offline-cache.ts";
import { isFresh, isImmutable, serve, type CacheLike, type NetworkState } from "../tab/sw-core.ts";

const ORIGIN = "http://127.0.0.1:5";
const CHUNK = `${ORIGIN}/api/runs/r1/work/` + "home/model/chunk-0001.bin";
const SCRIPT = `${ORIGIN}/main.js`;
const OTHER = `${ORIGIN}/run/other`;

function rig(cached: Record<string, string>, network: (url: string, signal: AbortSignal) => Promise<Response>, timeoutMs = 40) {
  const entries = new Map(Object.entries(cached).map(([url, body]) => [cacheKey(url), body]));
  const cache: CacheLike & { puts: number } = { puts: 0, async match(key) { const body = entries.get(key); return body === undefined ? undefined : new Response(body, { headers: { "content-type": "text/plain" } }); } };
  const calls: string[] = [];
  const deps = { cache, timeoutMs, fetch: (r: Request, signal: AbortSignal) => { calls.push(r.url); return network(r.url, signal); } };
  const get = (url: string) => serve(new Request(url), deps);
  return { get, calls, cache };
}
const up = (body: string) => async () => new Response(body);
const down = async () => { throw new TypeError("Failed to fetch"); };
const hang = (_u: string, signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

test("a model chunk is answered from the cache first, and never asks the network when it is cached", async () => {
  const r = rig({ [CHUNK]: "cached chunk" }, up("network chunk"));
  const res = await r.get(CHUNK);
  assert.equal(await res.text(), "cached chunk");
  assert.deepEqual(r.calls, [], "no network request");
  assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp", "what the cache answers is isolated");
});

test("a model chunk the cache does not hold goes to the network, and with no network it is a 504 that says so", async () => {
  assert.equal(await (await rig({}, up("network chunk")).get(CHUNK)).text(), "network chunk");
  const none = await rig({}, down).get(CHUNK);
  assert.equal(none.status, 504);
});

test("everything else is network first: an online page is the server's, even when an older copy is cached", async () => {
  const r = rig({ [SCRIPT]: "old script" }, up("new script"));
  const res = await r.get(SCRIPT);
  assert.equal(await res.text(), "new script");
  assert.deepEqual(r.calls, [SCRIPT]);
});

test("with the network down the cache answers, isolated; with it too slow, after the timeout, the same", async () => {
  const offline = await rig({ [SCRIPT]: "cached script" }, down).get(SCRIPT);
  assert.equal(await offline.text(), "cached script");
  assert.equal(offline.headers.get("cross-origin-opener-policy"), "same-origin");
  const started = Date.now();
  const slow = await rig({ [SCRIPT]: "cached script" }, hang, 60).get(SCRIPT);
  assert.equal(await slow.text(), "cached script");
  assert.ok(Date.now() - started >= 55, "it waited for the network first");
});

test("a page the checkout did not cache is the network's only: online it is passed through untouched and stored nowhere, offline it is a 504", async () => {
  const r = rig({ [SCRIPT]: "cached script" }, up("other page"));
  const res = await r.get(OTHER);
  assert.equal(await res.text(), "other page");
  assert.equal(res.headers.get("cross-origin-embedder-policy"), null, "the server's answer is not rewrapped");
  assert.equal(r.cache.puts, 0, "nothing is stored");
  assert.equal((await rig({ [SCRIPT]: "cached script" }, down).get(OTHER)).status, 504);
});

test("a server's own error is the answer, not a reason to use an old copy", async () => {
  const r = rig({ [SCRIPT]: "old script" }, async () => new Response("no", { status: 404 }));
  assert.equal((await r.get(SCRIPT)).status, 404);
});

test("which requests are immutable: the model's folder of a run, nothing else", () => {
  assert.equal(isImmutable(CHUNK), true);
  assert.equal(isImmutable(`${ORIGIN}/api/runs/r1/work/` + "home/model/manifest.json"), true);
  assert.equal(isImmutable(`${ORIGIN}/api/runs/r1/work/notes/a.txt`), false);
  assert.equal(isImmutable(SCRIPT), false);
});

test("a network that accepts and never answers (a tunnel left up with the Wi-Fi off) costs one timeout, not one per request: the cache answers at once for a while after", async () => {
  const state: NetworkState = { downUntil: 0 };
  let clock = 1_000;
  const entries = new Map([[cacheKey(SCRIPT), "cached script"], [cacheKey(`${ORIGIN}/vendor/x.wasm`), "cached wasm"]]);
  const cache: CacheLike = { async match(key) { const b = entries.get(key); return b === undefined ? undefined : new Response(b); } };
  const calls: string[] = [];
  const deps = { cache, state, now: () => clock, timeoutMs: 40, downMs: 30_000, fetch: (r: Request, signal: AbortSignal) => { calls.push(r.url); return hang(r.url, signal); } };
  const first = Date.now();
  assert.equal(await (await serve(new Request(SCRIPT), deps)).text(), "cached script");
  assert.ok(Date.now() - first >= 35, "the first request waited for the network");
  const second = Date.now();
  assert.equal(await (await serve(new Request(`${ORIGIN}/vendor/x.wasm`), deps)).text(), "cached wasm");
  assert.ok(Date.now() - second < 30, "the next one did not wait");
  assert.deepEqual(calls, [SCRIPT], "the network was not tried again while it is known down");
  // an uncached request still gets its try, and after the window the network is tried first again
  const other = await serve(new Request(OTHER), deps);
  assert.equal(other.status, 504);
  assert.deepEqual(calls, [SCRIPT, OTHER]);
  clock += 31_000;
  state.downUntil = 1_000 + 30_000;
  const up = await serve(new Request(SCRIPT), { ...deps, fetch: async (r: Request) => { calls.push(r.url); return new Response("network script"); } });
  assert.equal(await up.text(), "network script", "back to network first once the window has passed");
});

test("a request that says ?fresh goes past the cache, even for a model chunk, so bytes found wrong can be replaced", async () => {
  const r = rig({ [CHUNK]: "old bytes" }, up("new bytes"));
  const res = await r.get(`${CHUNK}?fresh=1`);
  assert.equal(await res.text(), "new bytes");
  assert.deepEqual(r.calls, [`${CHUNK}?fresh=1`]);
  assert.equal((await rig({ [CHUNK]: "old bytes" }, down).get(`${CHUNK}?fresh=1`)).status, 504, "with no network it is not answered from the old bytes");
  assert.equal(isFresh(CHUNK), false);
  assert.equal(isFresh(`${CHUNK}?threads=6`), false);
});
