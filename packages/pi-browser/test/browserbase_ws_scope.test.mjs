// The process WebSocket is wrapped only while a Browserbase session is bound to a credential proxy, and restored after.
// Its own file: the wrapper is process-wide, so every case here needs a process that starts with the native WebSocket.
import assert from "node:assert/strict";
import test from "node:test";
import { browserbaseProvider } from "../dist/providers/browserbase.js";
import { connectDialUrl } from "../dist/providers/browserbase-net.js";
import { fakeBrowserbase } from "./fixtures/fake-browserbase.mjs";

const native = globalThis.WebSocket;
let keySeq = 0;
const proxied = () => ({ BROWSERBASE_API_KEY: `not-a-secret-${(keySeq += 1)}`, BROWSERBASE_BASE_URL: "https://proxy.example", BROWSERBASE_CONNECT_BASE_URL: "wss://proxy.example/ws" });
const spec = (tag) => ({ tag, maxLifetimeS: 1800, idleTimeoutS: 120, proxies: true, verified: false, captcha: true, viewport: { width: 1288, height: 711 }, metadata: { agentrun: "1" } });
const rig = () => {
  const fake = fakeBrowserbase();
  const provider = browserbaseProvider({ env: proxied(), client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => undefined });
  return { fake, provider };
};
const attached = async (provider, tag) => {
  const ref = await provider.create(spec(tag), new AbortController().signal);
  const target = await provider.attach(ref);
  return { ref, url: target.sdkCdpUrl };
};

test("the native WebSocket is untouched until a session is bound to a proxy", () => {
  assert.equal(globalThis.WebSocket, native);
});

test("binding wraps the WebSocket once, and the last release puts the native one back", async () => {
  const { provider } = rig();
  const first = await attached(provider, "ar-ws-1-1");
  const wrapped = globalThis.WebSocket;
  assert.notEqual(wrapped, native, "a bound session's sockets go through the proxy");
  assert.notEqual(connectDialUrl(first.url), first.url);

  const second = await attached(provider, "ar-ws-2-1");
  assert.equal(globalThis.WebSocket, wrapped, "a second session does not wrap it again");

  await provider.release(first.ref);
  assert.equal(globalThis.WebSocket, wrapped, "a session is still bound, so the wrapper stays");

  await provider.release(second.ref);
  assert.equal(globalThis.WebSocket, native, "nothing is bound, so the process has its own WebSocket again");
  assert.equal(connectDialUrl(second.url), second.url);
});

test("a later binding wraps it again after a restore", async () => {
  const { provider } = rig();
  const one = await attached(provider, "ar-ws-3-1");
  await provider.release(one.ref);
  assert.equal(globalThis.WebSocket, native);
  const two = await attached(provider, "ar-ws-4-1");
  assert.notEqual(globalThis.WebSocket, native);
  await provider.release(two.ref);
  assert.equal(globalThis.WebSocket, native);
});

test("a WebSocket someone else put on top is left alone, and ours under it only passes URLs through", async () => {
  const dialed = [];
  const recorder = class Recorder { constructor(url) { dialed.push(String(url)); } };
  globalThis.WebSocket = recorder;
  const { provider } = rig();
  let theirs;
  try {
    const one = await attached(provider, "ar-ws-5-1");
    new globalThis.WebSocket(one.url);
    assert.notEqual(dialed.at(-1), one.url, "while bound, the socket goes to the proxy");
    theirs = function Theirs(...args) { return new globalThis.__ours(...args); };
    globalThis.__ours = globalThis.WebSocket;
    globalThis.WebSocket = theirs;
    await provider.release(one.ref);
    assert.equal(globalThis.WebSocket, theirs, "release does not remove a wrapper it did not install last");
    new globalThis.WebSocket(one.url);
    assert.equal(dialed.at(-1), one.url, "with no binding left, ours dials the URL as given");
  } finally {
    delete globalThis.__ours;
    globalThis.WebSocket = native;
  }
});

test("a host that replaces the WebSocket without wrapping ours does not leave later sessions dialing the raw URL", async () => {
  const dialed = [];
  const recorder = class Recorder { constructor(url) { dialed.push(String(url)); } };
  globalThis.WebSocket = recorder;
  const { provider } = rig();
  try {
    const one = await attached(provider, "ar-ws-6-1");
    class HostSocket { constructor(url) { dialed.push(`host ${url}`); } }
    globalThis.WebSocket = HostSocket;
    await provider.release(one.ref);
    assert.equal(globalThis.WebSocket, HostSocket, "the host's replacement is not removed");
    const two = await attached(provider, "ar-ws-7-1");
    new globalThis.WebSocket(two.url);
    assert.ok(dialed.at(-1).startsWith("host "), "the host's socket class is still the one that dials");
    assert.ok(dialed.at(-1).includes("proxy.example") && !dialed.at(-1).includes(two.url), "and it is given the proxy's URL, never the raw connect URL");
    await provider.release(two.ref);
    assert.equal(globalThis.WebSocket, HostSocket, "after the last release the host's socket class is back on top");
  } finally {
    globalThis.WebSocket = native;
  }
});

test("a direct session, with no credential proxy, never wraps the WebSocket and never keeps a proxied session's wrapper alive", async () => {
  const fake = fakeBrowserbase();
  const make = (env) => browserbaseProvider({ env, client: fake.sdk, sleep: async () => {}, downloadBehavior: async () => undefined });
  const direct = () => make({ BROWSERBASE_API_KEY: `not-a-secret-direct-${(keySeq += 1)}` });
  const alone = direct();
  const lone = await attached(alone, "ar-ws-8-1");
  assert.equal(globalThis.WebSocket, native, "a direct session has nothing to rewrite");
  await alone.release(lone.ref);

  const kept = await attached(direct(), "ar-ws-9-1");
  const provider = make(proxied());
  const proxiedSession = await attached(provider, "ar-ws-10-1");
  assert.notEqual(globalThis.WebSocket, native);
  await provider.release(proxiedSession.ref);
  assert.equal(globalThis.WebSocket, native, "the last proxied session is gone, so the native WebSocket returns although a direct session remains");
  assert.ok(kept.url);
});
