import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { connectCdp } from "../dist/providers/cdp-session.js";
import { captureFor, planRestore, vaultRuntime } from "../dist/vault-session.js";

// What bounds the adapters' use of a host's vault: a vault that stops answering never holds a browser back, a capture that passes its deadline writes nothing, an older read never
// replaces a newer one, a session that started without a target cannot be given a context later, and a socket nobody receives is closed.
const CTX = "ctx_bounds_5d1e8a07";
const SPEC = { tag: "t1", maxLifetimeS: 60, idleTimeoutS: 30, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: { run: "r", label: "l" } };
const REF = { id: "s1", tag: "t1" };
const TARGET = { sessionKey: "k", origins: ["https://app.example.com"] };
const contextProvider = (contextOf = () => CTX) => ({ name: "bb", caps: {}, vault: { kind: "context", provider: "browserbase", contextIdsInClear: false, contextOf } });
const never = () => new Promise(() => {});
function runtime(port, limits, warnings = []) { return vaultRuntime({ sessionVault: port }, () => {}, (m) => warnings.push(m), undefined, limits); }
const quick = { restoreMs: 150, captureMs: 150 };

test("a vault that never answers a restore does not hold the create: the session starts signed out, with a warning", async () => {
  const warnings = [];
  const rt = runtime({ restore: never, capture: async () => {}, forget: async () => {} }, quick, warnings);
  const started = Date.now();
  const plan = await planRestore(rt, TARGET, contextProvider(), SPEC);
  assert.ok(Date.now() - started < 3000, "returned within the bound");
  assert.equal(plan.fresh, false, "a failed read is not 'nothing kept': no new context is saved over what the vault may hold");
  assert.equal(plan.spec.profile, undefined);
  assert.match(plan.holdBack, /left untouched/);
  assert.match(warnings.join("\n"), /could not restore \(TimeoutError\); the session starts signed out/);
});

test("a capture whose target never resolves ends at the deadline, and writes nothing", async () => {
  const warnings = []; const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, quick, warnings);
  const started = Date.now();
  await captureFor(rt, never, contextProvider(), REF)();
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(written, []);
  assert.match(warnings.join("\n"), /could not capture this session \(TimeoutError\)/);
});

test("a capture that finishes its read after the deadline writes nothing: the deadline stops further reads and writes", async () => {
  const written = []; const warnings = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, { restoreMs: 5000, captureMs: 100 }, warnings);
  await captureFor(rt, async () => { await new Promise((r) => setTimeout(r, 300)); return TARGET; }, contextProvider(), REF)();
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(written, [], "the late read wrote nothing");
  assert.match(warnings.join("\n"), /could not capture this session \(TimeoutError\)/);
});

test("an older capture that is still waiting when a newer one of the same key begins writes nothing", async () => {
  const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input.state.capturedAt); }, forget: async () => {} }, { restoreMs: 5000, captureMs: 5000 });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const provider = contextProvider();
  const older = captureFor(rt, async () => { await gate; return TARGET; }, provider, REF)();
  await new Promise((r) => setTimeout(r, 20));
  await captureFor(rt, TARGET, provider, REF)();
  release();
  await older;
  assert.equal(written.length, 1, "only the newer capture was written");
});

test("a context session that started with no vault target is not captured when a target appears later, and the warning says why", async () => {
  const warnings = []; const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, quick, warnings);
  const plan = await planRestore(rt, undefined, contextProvider(), SPEC);
  assert.equal(plan.vaulted, false);
  await captureFor(rt, TARGET, contextProvider(), REF, { vaulted: plan.vaulted })();
  assert.deepEqual(written, []);
  assert.match(warnings.join("\n"), /started with no vault target/);
});

test("a target that reads as absent at the capture means the host no longer wants the session kept: nothing is captured", async () => {
  const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, quick);
  await captureFor(rt, async () => undefined, contextProvider(), REF)();
  assert.deepEqual(written, []);
});

test("a provider that no longer knows the session's context (the run restarted) captures nothing and says so, never the id", async () => {
  const warnings = []; const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, quick, warnings);
  await captureFor(rt, TARGET, contextProvider(() => null), REF)();
  assert.deepEqual(written, []);
  assert.match(warnings.join("\n"), /no longer knows the context/);
});

test("a first-run context session is flagged fresh so its id goes to the vault right after the create", async () => {
  const rt = runtime({ restore: async () => null, capture: async () => {}, forget: async () => {} }, quick);
  const plan = await planRestore(rt, TARGET, contextProvider(), SPEC);
  assert.deepEqual([plan.vaulted, plan.fresh], [true, true]);
  const kept = runtime({ restore: async () => ({ kind: "provider-context", capturedAt: new Date().toISOString(), provider: "browserbase", contextId: CTX, origins: TARGET.origins }), capture: async () => {}, forget: async () => {} }, quick);
  const again = await planRestore(kept, TARGET, contextProvider(), SPEC);
  assert.deepEqual([again.vaulted, again.fresh, again.spec.contextId], [true, false, CTX]);
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

const keptContext = (origins) => ({ kind: "provider-context", capturedAt: new Date().toISOString(), provider: "browserbase", contextId: CTX, ...(origins ? { origins } : {}) });
const A = "https://a.example.com"; const B = "https://b.example.com";

test("a kept provider context is restored only when the request covers EVERY origin it was saved for: a request for A never brings back B's sign-in", async () => {
  const run = async (saved, requested) => {
    const warnings = [];
    const rt = runtime({ restore: async () => saved, capture: async () => {}, forget: async () => {} }, quick, warnings);
    const plan = await planRestore(rt, { sessionKey: "k", origins: requested }, contextProvider(), SPEC);
    return { plan, warnings };
  };
  const partial = await run(keptContext([A, B]), [A]);
  assert.equal(partial.plan.spec.contextId, undefined, "the saved context was not given to the provider");
  assert.equal(partial.plan.fresh, false, "no new context is saved over the one the vault holds");
  assert.match(partial.plan.holdBack, /left untouched/);
  assert.match(partial.warnings.join("\n"), /does not cover every origin/);
  assert.equal(partial.warnings.join("\n").includes(CTX), false, "the warning never names the id");
  const other = await run(keptContext([B]), [A]);
  assert.equal(other.plan.spec.contextId, undefined, "a context saved for B is not restored for A");
  const same = await run(keptContext([A, B]), [B, A]);
  assert.equal(same.plan.spec.contextId, CTX, "the same origins, in any order, restore it");
  const wider = await run(keptContext([A]), [A, B]);
  assert.equal(wider.plan.spec.contextId, CTX, "a request that covers everything saved restores it");
  const unknown = await run(keptContext(undefined), [A]);
  assert.equal(unknown.plan.spec.contextId, undefined, "a context that records no origins is refused: it cannot be shown to be inside the request");
});

test("a captured provider context records the origins it was captured for", async () => {
  const written = [];
  const rt = runtime({ restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} }, quick);
  await captureFor(rt, { sessionKey: "k", origins: [A, B] }, contextProvider(), REF)();
  assert.deepEqual(written.map((w) => w.state.origins), [[A, B]]);
});

test("a restore that failed, or a saved sign-in this request could not use, leaves the saved one untouched: the session is never captured, at create or at release", async () => {
  const written = []; const warnings = [];
  const port = (restore) => ({ restore, capture: async (input) => { written.push(input); }, forget: async () => {} });
  const cases = {
    "the read threw": port(async () => { throw new Error("vault down"); }),
    "the saved context covers other origins": port(async () => keptContext([A, B])),
    "the saved state is another kind": port(async () => ({ kind: "cdp", capturedAt: new Date().toISOString(), cookies: [], localStorage: {} })),
  };
  for (const [what, p] of Object.entries(cases)) {
    const rt = runtime(p, quick, warnings);
    const plan = await planRestore(rt, { sessionKey: "k", origins: [A] }, contextProvider(), SPEC);
    assert.deepEqual([plan.fresh, !!plan.holdBack, plan.spec.contextId, plan.spec.profile], [false, true, undefined, undefined], what);
    const capture = captureFor(rt, { sessionKey: "k", origins: [A] }, contextProvider(), REF, { vaulted: plan.vaulted, holdBack: plan.holdBack });
    await capture(); await capture();
  }
  assert.deepEqual(written, [], "nothing was written under the key in any case");
  assert.equal(warnings.filter((w) => /left untouched/.test(w)).length, 3, "each session warned once, not on every capture");
  // a successful read that finds nothing is different: a new context is made and kept
  const rt = runtime(port(async () => null), quick);
  const plan = await planRestore(rt, { sessionKey: "k", origins: [A] }, contextProvider(), SPEC);
  assert.deepEqual([plan.fresh, plan.holdBack], [true, undefined]);
});
