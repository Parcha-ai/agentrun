// The page APIs Stagehand 4.4.0 cannot serve (the facade calls page.sendCDP and page.onCDP, which no v4 page has) are asserted to
// fail, so a fixed upstream flips this test.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { STAGEHAND_INFERENCE_REFUSED, stagehandDriver } from "../dist/driver/stagehand.js";
import { createDrivingGates } from "../dist/core/driving.js";
import { drivingGuard } from "../dist/core/driving-guard.js";
import { staleSnapshotIdError } from "../dist/vendor/stagehand-facade/contract.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";
import { scratch } from "./fixtures/scratch.mjs";

const LOOPBACK_ONLY = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
// A read issued while an earlier action's navigation commits can throw CDP -32000 or hang (Stagehand 4.1.0, under
// load): a read is safe to repeat, so after a navigating action it is retried, bounded, until the next page answers.
async function readAfterNavigation(read, answered) {
  let last;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { last = await read(); if (answered(last)) return last; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (last instanceof Error) throw last;
  return last;
}
const AFTER_SUBMIT = `await page.waitForSelector("#count", { timeout: 1000 }); return await page.locator("#count").innerText({ timeout: 1000 });`;
const pngSize = (b64) => { const b = Buffer.from(b64, "base64"); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

test("the Stagehand driver serves the page tools' contract on a real Chrome", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const site = await startSite({ slowMs: 5_000 });
  const root = await scratch(t, "stagehand-driver-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK_ONLY] } });
  const signal = new AbortController().signal;
  const ref = await provider.create(spec("driver-1"), signal);
  let driver;
  try {
    try { driver = await stagehandDriver()(await provider.attach(ref), signal, { batchTimeoutMs: 3_000 }); }
    catch (error) { if (skipIncapable(t, error)) return; throw error; }

    await t.test("run code navigates; url() reads the address without the page", async () => {
      assert.equal(await driver.run({ code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }), "Page A");
      assert.equal(await driver.url(), `${site.base}/a`);
    });
    await t.test("page() returns the page's url, title, text and html", async () => {
      const page = await driver.page();
      assert.equal(page.url, `${site.base}/a`);
      assert.equal(page.title, "Page A");
      assert.match(page.text, /The answer is forty-two\./);
      assert.match(page.html, /<article><h1>Page A<\/h1>/);
    });
    await t.test("a navigation that never commits leaves url() and page() on the page the browser shows", async () => {
      // A 204 (here) or a download (a PDF on Browserbase) starts a navigation that never commits: goto fails at its
      // start and the browser keeps page A, which Stagehand's own page.url() already reports as the target.
      await assert.rejects(driver.run({ code: `await page.goto(${JSON.stringify(`${site.base}/no-content`)}, { timeout: 1500 }); return "moved";` }), /Navigation start timed out/);
      assert.equal(await driver.url(), `${site.base}/a`);
      const page = await driver.page();
      assert.deepEqual([page.url, page.title], [`${site.base}/a`, "Page A"]);
      assert.match(page.text, /forty-two/);
    });
    await t.test("snapshot IDs drive ref actions, and a submitted form reaches the server once", async () => {
      const idOf = (tree, pattern) => tree.split("\n").map((line) => line.match(/^\s*\[([^\]]+)\]\s*(.*)$/)).find((m) => m && pattern.test(m[2]))?.[1];
      const link = idOf(await driver.snapshot({}), /link.*Go to page B/);
      assert.ok(link, "a link ID");
      assert.equal((await driver.run({ actions: [{ op: "click", id: link }] })).completed, 1);
      const form = await readAfterNavigation(() => driver.snapshot({}), (tree) => Boolean(idOf(tree, /^textbox/i) && idOf(tree, /button.*Submit/)));
      const actions = [{ op: "fill", id: idOf(form, /^textbox/i), value: "Ada Lovelace" }, { op: "click", id: idOf(form, /button.*Submit/) }];
      // Every action is checked against the snapshot before any is sent, in the facade's own words for a stale id.
      await assert.rejects(driver.checkActions([actions[0], { op: "click", id: "999-999" }]), (error) => error.message === staleSnapshotIdError("999-999"));
      await driver.checkActions(actions);
      // Through the driving guard, as a model call runs it: the actions go one at a time, and the form still reaches the
      // server once.
      const gates = createDrivingGates();
      const port = { session: async () => ({ tag: "sh-driver-run", driver, notice: null }), relaunch: async () => ({ tag: "sh-driver-run", driver }), release: async () => ({ released: true, sessionId: null }) };
      const ran = await drivingGuard(async (_args, p) => ({ content: [{ type: "text", text: JSON.stringify(await (await p.session()).driver.run({ actions })) }] }), gates)({}, port, {});
      assert.equal(JSON.parse(ran.content[0].text).completed, 2);
      assert.equal(await readAfterNavigation(() => driver.run({ code: AFTER_SUBMIT }), (value) => typeof value === "string"), "Submission 1 received for Ada Lovelace.");
      assert.equal(site.submissions(), 1);
    });
    await t.test("screenshot honors type, quality and the css or device scale", async () => {
      const png = await driver.screenshot({ type: "png", scale: "css" });
      assert.equal(png.mimeType, "image/png");
      assert.deepEqual(pngSize(png.data), { width: 1000, height: (pngSize(png.data)).height });
      const jpeg = await driver.screenshot({ type: "jpeg", quality: 40.4 });
      assert.equal(jpeg.mimeType, "image/jpeg");
      assert.equal(Buffer.from(jpeg.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
    });

    const unavailable = {
      'waitForEvent("download")': `return (await page.waitForEvent("download", { timeout: 2000 })).suggestedFilename();`,
      "route": `await page.route("**/*", (route) => route.continue()); return "routed";`,
      "waitForResponse": `return (await page.waitForResponse(() => true, { timeout: 2000 })).status();`,
      "newCDPSession": `return await (await context.newCDPSession(page)).send("Runtime.evaluate", { expression: "1 + 1" });`,
      'on("pageerror")': `page.on("pageerror", () => undefined); return "listening";`,
      'on("framenavigated")': `page.on("framenavigated", () => undefined); return "listening";`,
      'on("response")': `page.on("response", () => undefined); return "listening";`,
    };
    for (const [api, code] of Object.entries(unavailable)) {
      await t.test(`${api} throws on Stagehand 4.4.0's page`, async () => {
        await assert.rejects(driver.run({ code }), /(sendCDP|onCDP) is not a function/, `${api} works now: the browser section can stop calling it unavailable`);
      });
    }
    await t.test("act, extract and observe reach no model: the run throws the refusal", async () => {
      await assert.rejects(driver.run({ code: `return await batchStagehand.act("click the link");` }), (error) => error.message.includes(STAGEHAND_INFERENCE_REFUSED));
    });
    await t.test("a run past its batch timeout ends at the driver's deadline, not the facade's 60 s", async () => {
      const started = Date.now();
      await assert.rejects(driver.run({ code: `await page.goto(${JSON.stringify(`${site.base}/slow`)}); return "late";` }), (error) => error.name === "TimeoutError");
      assert.ok(Date.now() - started < 4_500, `ended after ${Date.now() - started} ms`);
      assert.equal(await driver.run({ code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.title();` }), "Page A", "the next batch runs once the slow page settles");
    });
    await t.test("close detaches and leaves the browser to the provider", async () => {
      await driver.close();
      driver = null;
      assert.equal(await provider.status(ref), "running");
      const again = await stagehandDriver()(await provider.attach(ref), signal);
      assert.match(await again.url(), /^http:\/\/127\.0\.0\.1:\d+\//, "a second attach finds the same browser, its extension already loaded");
      await again.close();
    });
    await t.test("one client at a time: an attach while another driver holds the browser is refused, and succeeds once that driver closes", async () => {
      const target = await provider.attach(ref);
      const holder = await stagehandDriver()(target, signal);
      try {
        await assert.rejects(stagehandDriver()(target, signal), /A Stagehand client is already connected/);
        assert.match(await holder.url(), /^http:\/\/127\.0\.0\.1:\d+\//, "the refused attach left the holder's session working");
      } finally { await holder.close(); }
      for (let attach = 1; attach <= 2; attach += 1) {
        const next = await stagehandDriver()(await provider.attach(ref), signal);
        assert.match(await next.url(), /^http:\/\/127\.0\.0\.1:\d+\//, `attach ${attach} after the holder closed`);
        await next.close();
      }
    });
  } finally {
    await driver?.close().catch(() => undefined);
    await provider.release(ref);
    assert.equal(await provider.status(ref), "gone", "the Chrome this test started is gone");
    await site.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed open names the host the process dialed, and keeps the cause so the failure stays typed", async () => {
  // Both ends are closed loopback ports (nothing leaves the host); the raw URL is on `localhost`, the dial URL on
  // `127.0.0.1`.
  const target = { sdkCdpUrl: "ws://localhost:9/s?signingKey=SECRETKEY", dial: { url: "ws://127.0.0.1:9/ws/s?signingKey=SECRETKEY" } };
  const error = await stagehandDriver()(target, new AbortController().signal).then(() => null, (e) => e);
  assert.ok(error instanceof Error, "the attach failed");
  assert.match(error.message, /attaching to the browser at 127\.0\.0\.1:9 failed/, "the dial host, not the raw URL's");
  assert.equal(error.message.includes("localhost"), false);
  assert.ok(error.cause instanceof Error, "the original error is the cause");
  assert.equal(error.message.includes("SECRETKEY"), false, "the host only: never the path or the signing query");
});

test("a run of several actions on a real Chrome stops before an action that would land on a new document; a pushState move keeps the document and runs on", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const http = await import("node:http");
  // Each page: a link (the batch's first action) and a field at the same place (its second), so an old snapshot's xpath
  // for the field finds a field on the next page too, and a fill that ran there is seen in the page's own value.
  const body = (link) => `<!doctype html><title>t</title><body>${link}<input id="name" aria-label="Name"></body>`;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/new") return res.end(body(`<a href="/other">Next page</a>`));
    if (path === "/other") return res.end(body(`<a href="/new">Back</a>`));
    if (path.startsWith("/push")) return res.end(body(`<a href="#" onclick="history.pushState({}, '', '/push/step-2'); return false;">Next step</a>`));
    if (path === "/reload") return res.end(body(`<a href="#" onclick="location.reload(); return false;">Reload</a>`));
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await scratch(t, "stagehand-doc-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: [LOOPBACK_ONLY] } });
  const signal = new AbortController().signal;
  const ref = await provider.create(spec("driver-doc"), signal);
  let driver;
  try {
    try { driver = await stagehandDriver()(await provider.attach(ref), signal, { batchTimeoutMs: 10_000 }); }
    catch (error) { if (skipIncapable(t, error)) return; throw error; }
    const gates = createDrivingGates();
    const idOf = (tree, pattern) => tree.split("\n").map((line) => line.match(/^\s*\[([^\]]+)\]\s*(.*)$/)).find((m) => m && pattern.test(m[2]))?.[1];
    /** At `path`: a snapshot, then one model call of a click on its link and a fill of its field. */
    const clickThenFill = async (path, tag) => {
      await driver.run({ code: `await page.goto(${JSON.stringify(`${base}${path}`)}); return true;` });
      const tree = await driver.snapshot({});
      const actions = [{ op: "click", id: idOf(tree, /^link/i) }, { op: "fill", id: idOf(tree, /^textbox/i), value: "Ada" }];
      assert.ok(actions.every((a) => a.id), `ids on ${path}: ${tree}`);
      const port = { session: async () => ({ tag, driver, notice: null }), relaunch: async () => ({ tag, driver }), release: async () => ({ released: true, sessionId: null }) };
      const out = await drivingGuard(async (_a, p) => {
        const s = await p.session();
        try { return { content: [{ type: "text", text: JSON.stringify(await s.driver.run({ actions })) }] }; }
        catch (error) { return { content: [{ type: "text", text: JSON.stringify(error.failure ?? { message: error.message }) }], isError: true }; }
      }, gates)({}, port, {});
      // Settle, then read the page the browser shows: its address and whether the fill reached its field.
      await new Promise((r) => setTimeout(r, 500));
      const now = await driver.run({ code: `return await page.evaluate(() => ({ url: location.href, value: document.getElementById("name").value }));` });
      return { out: JSON.parse(out.content[0].text), isError: out.isError === true, now };
    };

    await t.test("a link to another page: the fill is never sent to it", async () => {
      const { out, isError, now } = await clickThenFill("/new", "driver-doc-1");
      assert.equal(isError, true, JSON.stringify(out));
      assert.deepEqual([out.code, out.effect, out.completed], ["stale_snapshot", "partial", 1], JSON.stringify(out));
      assert.match(out.message, /snapshot again/);
      assert.deepEqual(now, { url: `${base}/other`, value: "" }, "on the new page, and its field untouched");
    });
    await t.test("a pushState move: the same document, and the fill runs", async () => {
      const { out, isError, now } = await clickThenFill("/push", "driver-doc-2");
      assert.equal(isError, false, JSON.stringify(out));
      assert.equal(out.completed, 2);
      assert.deepEqual(now, { url: `${base}/push/step-2`, value: "Ada" });
    });
    await t.test("a reload: a new document at the same address, and the fill is never sent", async () => {
      const { out, isError, now } = await clickThenFill("/reload", "driver-doc-3");
      assert.equal(isError, true, JSON.stringify(out));
      assert.deepEqual([out.code, out.completed], ["stale_snapshot", 1], JSON.stringify(out));
      assert.deepEqual(now, { url: `${base}/reload`, value: "" });
    });
  } finally {
    await driver?.close?.().catch(() => undefined);
    await provider.release(ref);
  }
});
