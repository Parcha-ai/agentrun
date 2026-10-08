// The wire check on the durable extension: a real run on SQLite with the fake provider and driver, scanned in every
// place the run writes. The tools here are the thinnest implementations over the custody port; what is under test is
// what custody commits, notices and reports.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver, sentinelPages } from "@parcha/pi-browser/testing";
import { call, collect, openRig } from "./rig.mjs";
import { Scan } from "./scan.mjs";
import { ALLOW, hostRegistered, makeSentinels } from "./sentinels.mjs";

const scratch = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "wire-durable-"));
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const CONFIG = { label: "node-a", run: "run-wire", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };

/** One conversation on the extension: `navigate` moves the page to `url` the way a redirect or a followed link does,
 *  so the URL comes from the page and never from the model's own words. */
async function runScript(sentinels, script, { navigateTo, echo = false, prepare = () => {} } = {}) {
  const backend = new FakeBackend({ sentinels: { ...sentinels, bbSessionId: "bbs-id" }, pages: sentinelPages(sentinels), start: "https://example.test/start" });
  backend.echo(echo);
  prepare(backend);
  const dir = scratch();
  let rig;
  const tools = {
    browser_read: async (_args, port) => {
      const session = await port.session();
      const page = await session.driver.page();
      return text({ ok: true, session: session.sessionId, title: page.title, url: session.record.lastUrl, notice: session.notice, interrupted: session.interrupted?.callId ?? null });
    },
    run: async (_args, port, callCtx) => {
      const session = await port.session();
      await port.dispatching({ callId: callCtx.callId, codeSha: "sha", url: session.record.lastUrl });
      const value = await session.driver.run({ actions: [{ op: "goto", url: navigateTo }] });
      await port.navigated(value.url);
      await port.settle();
      return text({ ok: true, session: session.sessionId, url: (await port.session()).record.lastUrl });
    },
  };
  const browser = createBrowserExtension({
    provider: () => backend.provider,
    driver: fakeDriver(backend),
    tools,
    evidence: { file: async () => null },
    redact: { values: () => hostRegistered(sentinels) },
    onSession: (row, change) => rig.host({ label: row.label, session: row.session, liveView: row.liveView }, change),
  });
  rig = await openRig({
    dir, script,
    install: (registry) => registry.install(browser.extension),
    rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } },
  });
  await browser.reconcile(rig.harness, () => true, rig.ctx);
  await rig.run();
  await browser.release(rig.root, "close", rig.ctx);
  for (let i = 0; i < 200 && (await rig.harness.inspect(rig.ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  const scan = new Scan(sentinels, { allow: ALLOW });
  await collect(rig, scan);
  const navigated = [...backend.sessions.values()].map((s) => s.url);
  const tally = backend.tally();
  await browser.close();
  await rig.close();
  return { scan, navigated, tally };
}

test("a page URL carrying credentials in its query reaches no document, entry, onSession row or result", async () => {
  const sentinels = makeSentinels();
  // run twice: the second `run` commits the first one's page URL as the pending effect's URL; then a read reports it.
  const { scan, navigated, tally } = await runScript(sentinels, [[call("run")], [call("run")], [call("browser_read")]], { navigateTo: sentinels.pageUrl });
  // the control: the browser really was on the credential URL, so the scan had something to find
  assert.ok(navigated.includes(sentinels.pageUrl), "the page was navigated to the credential URL");
  assert.ok(tally.dispatches === 2 && tally.creates === 1 && tally.releases === 1 && tally.liveAtEnd === 0, "one session, two runs, released");
  for (const source of ["run.sqlite:document_revisions", "run.sqlite:entries", "model-requests", "onSession"]) assert.ok(scan.coverageOf(source).records > 0, `${source} was scanned`);
  assert.equal(scan.report(), "no sentinel found");
});

test("a lifecycle whose provider calls fail echoing every secret leaves none in the run", async () => {
  const sentinels = makeSentinels();
  // the first create fails (echoed) and the model reads again, a session opens; the release fails once (echoed) and is retried
  const { scan, tally } = await runScript(sentinels, [[call("browser_read")], [call("browser_read")], [call("run")]], {
    navigateTo: sentinels.pageUrl, echo: true, prepare: (backend) => { backend.fail("create", 1); backend.fail("release", 1); },
  });
  assert.ok(tally.creates === 1 && tally.liveAtEnd === 0, "the second create opened a session and the release was retried to the end");
  assert.equal(scan.report(), "no sentinel found");
});
