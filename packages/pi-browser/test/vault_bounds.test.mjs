import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { connectCdp } from "../dist/providers/cdp-session.js";
import { captureFor, planRestore, vaultRuntime } from "../dist/vault-session.js";

// What bounds the adapters' use of a host's vault: a vault that stops answering never holds a browser back, a capture that passes its deadline writes nothing, a
// saved sign-in this session could not take is never replaced, and a socket nobody receives is closed.
const SPEC = { tag: "t1", maxLifetimeS: 60, idleTimeoutS: 30, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: { run: "r", label: "l" } };
const REF = { id: "s1", tag: "t1" };
const TARGET = { sessionKey: "k", origins: ["https://app.example.com"] };
const never = () => new Promise(() => {});
/** A local Chrome's provider as the vault sees it: its attach never answers here, so a capture that reaches it reads nothing. */
const cdpProvider = () => ({ name: "cdp", caps: {}, vault: { kind: "cdp" }, attach: never });
function runtime(port, limits, warnings = []) { return vaultRuntime({ sessionVault: port }, () => {}, (m) => warnings.push(m), undefined, limits); }
const quick = { restoreMs: 150, captureMs: 150 };
const A = "https://a.example.com";

test("a vault that never answers a restore does not hold the create: the session starts signed out, with a warning", async () => {
  const warnings = [];
  const rt = runtime({ restore: never, capture: async () => {}, forget: async () => {} }, quick, warnings);
  const started = Date.now();
  const plan = await planRestore(rt, TARGET, cdpProvider(), SPEC);
  assert.ok(Date.now() - started < 3000, "returned within the bound");
  assert.equal(plan.afterAttach, null, "nothing is restored");
  assert.match(plan.holdBack, /left untouched/);
  assert.match(warnings.join("\n"), /could not restore \(TimeoutError\); the session starts signed out/);
});

test("a capture whose target never resolves ends at the deadline, and writes nothing", async () => {
  const warnings = []; const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, quick, warnings);
  const started = Date.now();
  await captureFor(rt, never, cdpProvider(), REF)();
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(written, []);
  assert.match(warnings.join("\n"), /could not capture this session \(TimeoutError\)/);
});

test("a capture that finishes its read after the deadline writes nothing: the deadline stops further reads and writes", async () => {
  const written = []; const warnings = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, { restoreMs: 5000, captureMs: 100 }, warnings);
  await captureFor(rt, async () => { await new Promise((r) => setTimeout(r, 300)); return TARGET; }, cdpProvider(), REF)();
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(written, [], "the late read wrote nothing");
  assert.match(warnings.join("\n"), /could not capture this session \(TimeoutError\)/);
});

test("a target that reads as absent at the capture means the host no longer wants the session kept: nothing is captured", async () => {
  const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, quick);
  await captureFor(rt, async () => undefined, cdpProvider(), REF)();
  assert.deepEqual(written, []);
});

test("a failed local restore says the session may be signed out or only in part: cookies are written before storage, so the browser may keep some", async () => {
  const warnings = [];
  const rt = runtime({ restore: async () => ({ kind: "cdp", capturedAt: new Date().toISOString(), cookies: [], localStorage: {} }), capture: async () => {}, forget: async () => {} }, quick, warnings);
  const plan = await planRestore(rt, TARGET, { name: "cdp", caps: {}, vault: { kind: "cdp" } }, SPEC);
  await plan.afterAttach({ sdkCdpUrl: "ws://127.0.0.1:1/devtools/browser/x" });
  assert.match(warnings.join("\n"), /restore failed \(Error\); the session may start signed out, or signed in only in part/);
});

test("a DevTools socket whose handshake never finishes is closed when the deadline passes, so no connection is left with no owner", async (t) => {
  const sockets = [];
  const server = net.createServer((socket) => { sockets.push(socket); socket.on("data", () => {}); socket.on("error", () => {}); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }), { timeout: 30_000 });
  await assert.rejects(connectCdp(`ws://127.0.0.1:${server.address().port}/devtools/browser/x`, 200), /did not open/);
  // The first connection is the handshake that was left hanging: the client ends it (the runtime may dial once more on its own, which is not ours).
  for (const end = Date.now() + 3000; !(sockets[0]?.destroyed || sockets[0]?.readableEnded) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(sockets[0]?.destroyed || sockets[0]?.readableEnded, "the client end of the hanging handshake was closed");
});

test("a restore that failed, or a saved state of a kind a local Chrome cannot take, leaves the saved one untouched: the session is never captured, at create or at release", async () => {
  const written = []; const warnings = [];
  const port = (restore) => ({ restore, capture: async (input) => { written.push(input); }, forget: async () => {} });
  const cases = {
    "the read threw": port(async () => { throw new Error("vault down"); }),
    // A hosted vendor's context a host's vault kept from before this package stopped opening hosted browsers itself.
    "the saved state is another kind": port(async () => ({ kind: "provider-context", capturedAt: new Date().toISOString(), provider: "browserbase", contextId: "ctx_kept_5d1e8a07", origins: [A] })),
  };
  for (const [what, p] of Object.entries(cases)) {
    const rt = runtime(p, quick, warnings);
    const plan = await planRestore(rt, { sessionKey: "k", origins: [A] }, cdpProvider(), SPEC);
    assert.deepEqual([plan.vaulted, !!plan.holdBack, plan.afterAttach, plan.spec], [true, true, null, SPEC], what);
    const capture = captureFor(rt, { sessionKey: "k", origins: [A] }, cdpProvider(), REF, { vaulted: plan.vaulted, holdBack: plan.holdBack });
    await capture(); await capture();
  }
  assert.deepEqual(written, [], "nothing was written under the key in any case");
  assert.equal(warnings.filter((w) => /left untouched/.test(w)).length, 2, "each session warned once, not on every capture");
  assert.equal(warnings.some((w) => w.includes("ctx_kept_5d1e8a07")), false, "no warning names what the vault held");
  // a successful read that finds nothing is different: the session may be captured
  const rt = runtime(port(async () => null), quick);
  const plan = await planRestore(rt, { sessionKey: "k", origins: [A] }, cdpProvider(), SPEC);
  assert.deepEqual([plan.vaulted, plan.holdBack], [true, undefined]);
});
