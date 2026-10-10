// A driver whose connection dropped is replaced; the request observer, a separate connection that holds what the action
// policy does not pre-allow, stays attached while it is healthy. Closing it with the driver would leave the browser running
// with nothing holding a request until the next browser call (a page timer or an autosave could send a POST undecided).
// The observer here is a stub with counters: no Chrome is needed to see which connections custody closes and opens.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";
import { call, openRig } from "./wire/rig.mjs";

const CONFIG = { label: "node-a", run: "run-observer-drop", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000, actions: "deny" } };
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

async function run({ observerDiesWithDriver = false, reconnect = true, release = true }) {
  const backend = new FakeBackend({ start: "https://example.test/start", pages: { "https://example.test/start": { url: "https://example.test/start", title: "Start", text: "start", html: "<html></html>" } } });
  const counts = { opens: 0, closes: 0 };
  const observers = [];
  const openObserver = async () => {
    counts.opens += 1;
    const observer = { closed: false, holding: true, record() {}, async flush() {}, close() { observer.closed = true; counts.closes += 1; } };
    observers.push(observer);
    return observer;
  };
  const seen = {};
  const tools = {
    browser_read: async (_args, port) => {
      const first = await port.session();
      seen.beforeDrop = { ...counts, held: first.effects === observers[0] };
      if (observerDiesWithDriver) observers[0].closed = true;
      await port.dropped();
      seen.afterDrop = { ...counts };
      if (!reconnect) return text({ ok: true });
      const again = await port.session();
      seen.afterReconnect = { ...counts, sameSession: again.sessionId === first.sessionId, keptObserver: again.effects === observers[0], attaches: backend.tally().attaches };
      return text({ ok: true });
    },
  };
  const browser = createBrowserExtension({ provider: () => backend.provider, driver: fakeDriver(backend), tools, evidence: { file: async () => null }, openObserver, decisions: {} });
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "observer-drop-"));
  let rig = null;
  try {
    rig = await openRig({ dir, script: [[call("browser_read")]], install: (registry) => registry.install(browser.extension), rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } } });
    await browser.reconcile(rig.harness, () => true, rig.ctx);
    await rig.run();
    if (release) {
      await browser.release(rig.root, "close", rig.ctx);
      for (let i = 0; i < 200 && (await rig.harness.inspect(rig.ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    }
    seen.beforeClose = { ...counts };
    await browser.close();
    seen.final = { ...counts };
  } finally {
    await rig?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return seen;
}

test("a dropped driver connection leaves a healthy request observer attached, and the reconnect reuses it", { timeout: 60_000 }, async () => {
  const seen = await run({ observerDiesWithDriver: false });
  assert.deepEqual(seen.beforeDrop, { opens: 1, closes: 0, held: true });
  assert.deepEqual(seen.afterDrop, { opens: 1, closes: 0 }, "the driver let go; the observer, still holding requests, did not");
  assert.deepEqual(seen.afterReconnect, { opens: 1, closes: 0, sameSession: true, keptObserver: true, attaches: 2 }, "the driver attached again to the same session; no second observer was opened");
  assert.deepEqual(seen.beforeClose, { opens: 1, closes: 1 }, "the release closed the one observer");
});

test("when the observer's connection died with the driver's, both are replaced", { timeout: 60_000 }, async () => {
  const seen = await run({ observerDiesWithDriver: true });
  assert.deepEqual(seen.afterReconnect, { opens: 2, closes: 1, sameSession: true, keptObserver: false, attaches: 2 });
  assert.deepEqual(seen.beforeClose, { opens: 2, closes: 2 });
});

test("the extension's close lets go of an observer whose driver was dropped and not yet replaced", { timeout: 60_000 }, async () => {
  const seen = await run({ reconnect: false, release: false });
  assert.deepEqual(seen.afterDrop, { opens: 1, closes: 0 }, "the drop kept the observer");
  assert.deepEqual(seen.beforeClose, { opens: 1, closes: 0 });
  assert.deepEqual(seen.final, { opens: 1, closes: 1 }, "close() found it by its tag though no driver is attached");
});
