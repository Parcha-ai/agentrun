// Chrome's network service, killed while a page's cross-origin POST waits for its preflight, as Chrome for Testing 155
// sometimes crashes it on its own under the observer's interception (more often the busier the machine).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EffectObserver, effectDecider } from "@parcha/pi-browser";
import { cdpProvider } from "../dist/providers/cdp.js";
import { cdpDriver } from "./effects/cdp-driver.mjs";
import { CASES, startServer } from "./effects/server.mjs";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const LOOPBACK = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const G3 = CASES.find((each) => each.name.startsWith("G3"));
const C = CASES.find((each) => each.name.startsWith("C "));

/** The network service's pid, asked over a socket of the test's own. */
async function networkService(target) {
  const ws = new WebSocket(target.sdkCdpUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  try {
    const answer = await new Promise((resolve) => { ws.onmessage = (e) => resolve(JSON.parse(String(e.data))); ws.send(JSON.stringify({ id: 1, method: "SystemInfo.getProcessInfo" })); });
    return answer.result.processInfo.find((p) => p.type.includes("NetworkService"))?.id ?? null;
  } finally { ws.close(); }
}

async function rig(t, tag, policy) {
  const server = await startServer();
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "effects-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK] } });
  let ref = null;
  t.after(async () => { if (ref) await provider.release(ref); await server.close(); await rm(root, { recursive: true, force: true }); }, { timeout: 30_000 });
  ref = await provider.create(spec(tag), new AbortController().signal);
  const target = await provider.attach(ref);
  const driver = await cdpDriver(server.base)(target);
  t.after(() => driver.close(), { timeout: 30_000 });
  const observer = await EffectObserver.open(target, effectDecider(policy));
  t.after(() => observer.close(), { timeout: 30_000 });
  /** One call: the case's steps, recorded as a run records them; the rows and the lost requests it was told. */
  const call = async (c) => {
    const rows = [];
    const lost = [];
    const stop = observer.record((row) => { rows.push(`${row.method} ${row.path} ${row.held}`); }, (request) => { lost.push(`${request.method} ${request.origin}${request.path}`); });
    try { await driver.run({ code: JSON.stringify(c.steps) }); } finally { await observer.flush(undefined, 3_000); stop(); }
    return { rows: rows.filter((row) => !row.endsWith(" pending")), lost };
  };
  return { server, target, call };
}

/** Kills the network service when G3's preflight reaches the server; resolves once Chrome runs another. */
async function killAtPreflight(server, target) {
  const pid = await networkService(target);
  assert.ok(pid, "Chrome names its network service's process");
  server.onPreflight("/api/xorigin", () => { try { process.kill(pid, "SIGKILL"); } catch {} });
  return async () => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const now = await networkService(target);
      if (now && now !== pid) return;
    }
    assert.fail("Chrome never started another network service");
  };
}

test("under allow, a POST the network service took with it is told to the call as lost and NOT sent, never journaled as sent or allowed", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { server, target, call } = await rig(t, "ns-allow", "allow");
  const restarted = await killAtPreflight(server, target);
  const { rows, lost } = await call(G3);
  await restarted();
  const xorigin = `${new URL(server.base).protocol}//localhost:${new URL(server.base).port}`;
  assert.deepEqual(lost, [`POST ${xorigin}/api/xorigin`], `the call is told (its journal: ${JSON.stringify(rows)})`);
  assert.deepEqual(rows, [], "nothing journaled as sent or allowed");
  assert.deepEqual(server.nonGet(), [], "nothing reached the server");
  // The browser works after the restart: the next call's POST is held, allowed and sent, and nothing is told lost.
  server.reset();
  const after = await call(C);
  assert.deepEqual(after, { rows: ["POST /api/order allowed"], lost: [] });
  await server.nonGetReached(1, 10_000);
  assert.deepEqual(server.nonGet(), ["POST /api/order"]);
});

test("under deny, a POST the network service took with it is told lost, nothing reaches the server, and the observer still holds and denies after the restart", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { server, target, call } = await rig(t, "ns-deny", "deny");
  const restarted = await killAtPreflight(server, target);
  const { rows, lost } = await call(G3);
  await restarted();
  assert.equal(lost.length, 1, `the call is told (its journal: ${JSON.stringify(rows)})`);
  assert.deepEqual(rows, []);
  for (const c of [C, G3]) {
    const after = await call(c);
    assert.deepEqual(after, { rows: [`${c.expected[0]} denied`], lost: [] }, `${c.name} after the restart`);
  }
  assert.deepEqual(server.nonGet(), [], "nothing reached the server");
});

test("under allow, a POST redirected 307 to another origin is held hop by hop, and both hops are journaled under the call that sent it", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { server, call } = await rig(t, "ns-redirect", "allow");
  // The call flushes right after the click, with no wait of its own: hop 2 exists only once hop 1's 307 is back.
  const { rows, lost } = await call({ steps: [{ goto: "/g" }, { click: "#redirect" }] });
  assert.deepEqual(rows, ["POST /api/redirect allowed", "POST /api/xorigin allowed"]);
  assert.deepEqual(lost, []);
  await server.nonGetReached(2, 10_000);
  assert.deepEqual(server.nonGet(), ["POST /api/redirect", "POST /api/xorigin"]);
});

test("with no restart, a call is told nothing lost: the same POST under allow is held, allowed and sent", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { server, call } = await rig(t, "ns-none", "allow");
  const { rows, lost } = await call(G3);
  assert.deepEqual(lost, []);
  assert.deepEqual(rows, ["POST /api/xorigin allowed"]);
  await server.nonGetReached(1, 10_000);
  assert.deepEqual(server.nonGet(), ["POST /api/xorigin"]);
});
