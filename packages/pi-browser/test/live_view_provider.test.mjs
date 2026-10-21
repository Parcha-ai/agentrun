// liveViewProvider: the provider with a live view. The viewer's URL is reported through `liveView(ref)` (what onSession carries), a release kills
// the token before the provider's own release runs, and everything else about the provider is untouched.
import assert from "node:assert/strict";
import test from "node:test";
import { createLiveView, liveViewProvider } from "../dist/live-view/index.js";

const ref = { id: "local:1:2:ar-run-1-1", tag: "ar-run-1-1" };
function inner(log) {
  const p = {
    name: "cdp", caps: { marker: true }, attaches: 0, failAttach: false, failRelease: false,
    async create() { log.push("create"); return this.helper(); },
    helper() { return ref; },
    async attach() { p.attaches += 1; if (p.failAttach) throw new Error("gone"); return { sdkCdpUrl: "ws://127.0.0.1:9/devtools/browser/abc" }; },
    async release() { log.push("provider release"); if (p.failRelease) throw new Error("not removed"); },
    async status() { return "running"; },
    async findByTag() { return []; },
  };
  return p;
}
const host = (t) => { const h = createLiveView({ hostOrigin: null, stream: () => ({ input: async () => {}, nav: async () => {}, dialog: async () => {}, close() {} }), gates: () => ({ state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => false, setViewing() {}, end() {} }), viewer: { html: "", js: "", css: "" } }); t.after(() => h.close()); return h; };

test("liveView(ref) gives the viewer's URL once per session: the second call asks the host, not the browser", async (t) => {
  const log = [];
  const provider = inner(log);
  const wrapped = liveViewProvider(provider, host(t));
  const first = await wrapped.liveView(ref);
  assert.match(first.fullscreen, /^http:\/\/127\.0\.0\.1:\d+\/v\/[A-Za-z0-9_-]{22}#t=[A-Za-z0-9_-]{43}$/);
  assert.equal(first.framed, first.fullscreen);
  assert.deepEqual((await wrapped.liveView(ref)).fullscreen, first.fullscreen);
  assert.equal(provider.attaches, 1);
});

test("a browser that cannot be reached has no view, and the session still reports; the next call can succeed", async (t) => {
  const provider = inner([]);
  const wrapped = liveViewProvider(provider, host(t));
  provider.failAttach = true;
  assert.equal(await wrapped.liveView(ref), null);
  provider.failAttach = false;
  assert.ok(await wrapped.liveView(ref));
});

test("release ends the token first and the provider's release second, and a provider release that fails leaves the token dead", async (t) => {
  const log = [];
  const provider = inner(log);
  const h = host(t);
  const wrapped = liveViewProvider(provider, h);
  await wrapped.liveView(ref);
  assert.ok(h.known(ref.tag));
  await wrapped.release(ref);
  assert.deepEqual(log, ["provider release"]);
  assert.equal(h.known(ref.tag), null);
  await wrapped.liveView(ref);
  provider.failRelease = true;
  await assert.rejects(() => wrapped.release(ref), /not removed/);
  assert.equal(h.known(ref.tag), null, "the failed removal does not bring the view back");
});

test("everything else is the provider's own: name, caps, methods that use `this`", async (t) => {
  const log = [];
  const wrapped = liveViewProvider(inner(log), host(t));
  assert.deepEqual([wrapped.name, wrapped.caps, await wrapped.status(ref)], ["cdp", { marker: true }, "running"]);
  assert.deepEqual(await wrapped.create({}), ref);
});
