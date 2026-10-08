// The shared fake's contract for the crash matrix: a create the provider applied and never answered is in the
// parent's ledger after the child that made it is SIGKILLed, and a new process finds the session by its tag.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { FakeBackend, remoteDriver, remoteProvider } from "@agentrun/pi-browser/testing";

const CHILD = `
import { remoteProvider } from "@agentrun/pi-browser/testing";
const p = remoteProvider(process.env.FAKE);
await p.create({ tag: "ar-run-aaaa-1", maxLifetimeS: 60, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1, height: 1 }, metadata: {} }, new AbortController().signal);
`;

test("a held create survives the death of the process that made it, and findByTag binds it", async () => {
  const backend = new FakeBackend();
  const served = await backend.serve();
  try {
    backend.hold("create");
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], { env: { ...process.env, FAKE: served.url }, stdio: "ignore" });
    await new Promise((resolve) => backend.events.once("held", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
    assert.equal(backend.tally().creates, 1);
    const found = await remoteProvider(served.url).findByTag("ar-run-aaaa-1");
    assert.equal(found.length, 1);
    await remoteProvider(served.url).release(found[0]);
    const tally = backend.tally();
    assert.deepEqual([tally.creates, tally.releases, tally.peakLive, tally.liveAtEnd], [1, 1, 1, 0]);
  } finally { await served.close(); }
});

const DRIVER_CHILD = `
import { remoteDriver, remoteProvider } from "@agentrun/pi-browser/testing";
const p = remoteProvider(process.env.FAKE);
const ref = await p.create({ tag: "ar-run-bbbb-1", maxLifetimeS: 60, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1, height: 1 }, metadata: {} }, new AbortController().signal);
const driver = await remoteDriver(process.env.FAKE)(await p.attach(ref));
await driver.run({ actions: [{ op: "goto", url: "https://example.test/next" }] });
`;

test("a held driver run is applied in the parent and the child's calls are counted; a delayed read waits", async () => {
  const backend = new FakeBackend();
  const served = await backend.serve();
  try {
    backend.hold("driver.run");
    const child = spawn(process.execPath, ["--input-type=module", "-e", DRIVER_CHILD], { env: { ...process.env, FAKE: served.url }, stdio: "ignore" });
    await new Promise((resolve) => backend.events.once("held", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
    assert.equal(backend.tally().dispatches, 1);
    assert.equal(backend.live()[0] && [...backend.sessions.values()][0].url, "https://example.test/next");
    // A second process attaches to the same session and sees the page where the dead one left it.
    const provider = remoteProvider(served.url);
    const [ref] = await provider.findByTag("ar-run-bbbb-1");
    const driver = await remoteDriver(served.url)(await provider.attach(ref));
    backend.delay("driver.page", 150);
    const started = Date.now();
    const page = await driver.page();
    assert.ok(Date.now() - started >= 140, "the read was delayed");
    assert.equal(page.url, "https://example.test/next");
    assert.equal(backend.tally().reads, 1);
  } finally { await served.close(); }
});
