// core/dial.ts: the one way a CDP socket is opened from an AttachTarget: its dial URL with its headers (a relay's
// capability) when it has them, its driver URL otherwise. A dial's address and headers carry credentials: no error names
// more than the host. A dial with expiresAt is closed at that moment, and one already past it is never opened.
import assert from "node:assert/strict";
import test from "node:test";
import { dialUrl, isPlaceholder, openDial, placeholderUrl } from "../dist/core/dial.js";
import * as pkg from "../dist/index.js";
import { fakeRelay } from "./fixtures/fake-relay.mjs";

const CAPABILITY = "bcap.relay-capability-sentinel-0123456789";
const opened = (socket) => new Promise((resolve, reject) => { socket.onopen = () => resolve(socket); socket.onerror = () => reject(new Error("refused")); });
const closed = (socket) => new Promise((resolve) => { if (socket.readyState === 3) resolve(); else socket.addEventListener("close", () => resolve(), { once: true }); });

async function relay(t) {
  const fake = await fakeRelay({ token: CAPABILITY });
  t.after(() => fake.close());
  return fake;
}

test("dialUrl is the dial URL when the target has one, the driver's URL otherwise", () => {
  assert.equal(dialUrl({ sdkCdpUrl: "ws://127.0.0.1:9222/devtools/browser/x" }), "ws://127.0.0.1:9222/devtools/browser/x");
  assert.equal(dialUrl({ sdkCdpUrl: "ws://127.0.0.1:9222/devtools/browser/x", dial: { url: "wss://broker.example/cdp" } }), "wss://broker.example/cdp");
});

test("openDial dials the target's dial URL with its headers", async (t) => {
  const fake = await relay(t);
  const socket = await opened(openDial({ sdkCdpUrl: "ws://127.0.0.1:1/vm-local/devtools/browser/x", dial: { url: fake.url, headers: { Authorization: `Bearer ${CAPABILITY}` } } }));
  socket.close();
  assert.deepEqual(fake.upgrades.map((u) => [u.path, u.headers.authorization]), [["/cdp", `Bearer ${CAPABILITY}`]]);
});

test("a dial with expiresAt is closed at that moment", async (t) => {
  const fake = await relay(t);
  const socket = await opened(openDial({ sdkCdpUrl: "ws://127.0.0.1:1/x", dial: { url: fake.url, headers: { Authorization: `Bearer ${CAPABILITY}` }, expiresAt: Date.now() + 400 } }));
  const started = Date.now();
  await closed(socket);
  assert.ok(Date.now() - started < 2_000, "closed at the deadline, not left open");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.open(), 0);
});

test("a dial already past its expiresAt is never opened", async (t) => {
  const fake = await relay(t);
  assert.throws(() => openDial({ sdkCdpUrl: "ws://127.0.0.1:1/x", dial: { url: fake.url, headers: { Authorization: `Bearer ${CAPABILITY}` }, expiresAt: Date.now() - 1 } }), /expired/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.upgrades.length, 0);
});

test("no error names a dial's address beyond its host, or its headers", () => {
  const secretUrl = "wss://connect.browserbase.com/?signingKey=signing-key-sentinel-0123456789&sessionId=s";
  const messages = [];
  for (const target of [
    { sdkCdpUrl: "ws://127.0.0.1:1/x", dial: { url: "not a url signing-key-sentinel-0123456789", headers: { Authorization: `Bearer ${CAPABILITY}` } } },
    { sdkCdpUrl: "ws://127.0.0.1:1/x", dial: { url: secretUrl, headers: { Authorization: `Bearer ${CAPABILITY}` }, expiresAt: 1 } },
  ]) {
    try { openDial(target); } catch (error) { messages.push(String(error?.message), String(error?.stack), JSON.stringify(error)); }
  }
  assert.equal(messages.length, 6, "both cases failed");
  for (const secret of ["signing-key-sentinel-0123456789", CAPABILITY]) assert.equal(messages.join("\n").includes(secret), false, secret);
});

test("a placeholder marks a driver URL no browser can dial: unique per call, never mistaken for a real CDP URL, exported from the package", () => {
  const a = placeholderUrl("session-1"), b = placeholderUrl("session-1");
  assert.notEqual(a, b, "unique per session object, so a binding keyed on one never catches another");
  assert.equal(isPlaceholder(a), true);
  for (const real of ["ws://127.0.0.1:9222/devtools/browser/0b4b6c8e", "wss://connect.browserbase.com/?signingKey=signing-key-sentinel-0123456789", "wss://broker.example/internal/browser-access/cdp", "not a url"]) {
    assert.equal(isPlaceholder(real), false, real);
  }
  assert.equal(pkg.isPlaceholder, isPlaceholder);
  assert.equal(pkg.placeholderUrl, placeholderUrl);
  assert.equal(pkg.openDial, openDial);
});
