// The screenshot budget on a real Chrome at two device pixels per CSS pixel (a Retina display, or a vendor browser whose
// fingerprint is one), through the page tools on the raw-CDP driver, the stack every browser computer runs: a long
// pricing page's viewport (2576x1422 device pixels) is scaled down to the 2,000 px long edge, never refused; its full page
// (tens of thousands of pixels long) is the viewport, scaled; and a page short enough to stay readable is its whole self,
// shrunk.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { cdpDriver } from "../dist/driver/cdp.js";
import { imageSize, pageTools, SCREENSHOT_MAX_BASE64_BYTES, SCREENSHOT_MAX_EDGE_PX } from "../dist/index.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { scratchSync } from "./fixtures/scratch.mjs";

/** A pricing page: a header, plan cards, a long fee table and a footer, `rows` rows long. */
const pricing = (rows) => `<!doctype html><title>Pricing</title><body style="margin:0;font:16px/1.5 system-ui,sans-serif;color:#1a1f36">
<header style="padding:24px 48px;background:#0a2540;color:#fff;font-size:20px">Payments <span style="float:right">Sign in</span></header>
<section style="display:flex;gap:24px;padding:48px">${["Standard", "Custom", "Volume"].map((plan, i) => `<div style="flex:1;border:1px solid #e3e8ee;border-radius:12px;padding:32px;background:linear-gradient(#fff,#f6f9fc)">
<h2>${plan}</h2><p style="font-size:40px;margin:8px 0">${2.9 - i * 0.3}% + ${30 - i * 5}&cent;</p><p>per successful card charge</p><button style="padding:12px 24px;background:#635bff;color:#fff;border:0;border-radius:6px">Start now</button></div>`).join("")}</section>
<table style="margin:0 48px;border-collapse:collapse;width:calc(100% - 96px)">${Array.from({ length: rows }, (_, i) => `<tr style="background:${i % 2 ? "#f6f9fc" : "#fff"}"><td style="padding:14px">Fee line ${i + 1}: international cards, currency conversion and disputes</td><td style="padding:14px;text-align:right">${(i % 7) + 0.5}%</td></tr>`).join("")}</table>
<footer style="padding:48px;background:#0a2540;color:#adbdcc">Footer</footer>`;

const textOf = (out) => out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const imageOf = (out) => { const image = out.content.find((c) => c.type === "image"); return image && { ...image, size: imageSize(Buffer.from(image.data, "base64")) }; };
const within = (image, what) => {
  assert.ok(image, `${what}: an image`);
  assert.ok(image.size, `${what}: a JPEG or PNG whose size reads`);
  assert.ok(Math.max(image.size.width, image.size.height) <= SCREENSHOT_MAX_EDGE_PX, `${what}: ${image.size.width}x${image.size.height} within the long edge`);
  assert.ok(image.data.length <= SCREENSHOT_MAX_BASE64_BYTES, `${what}: within the byte budget`);
};

test("on a display of two device pixels per CSS pixel, a long page's screenshots are scaled to the budget, never refused", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const pages = { "/long": pricing(560), "/short": pricing(40) };
  const server = http.createServer((req, res) => { res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }); res.end(pages[req.url] ?? ""); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`; // key-gate: loopback-rule a test's own page server
  const root = scratchSync(t, "shot-budget-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: ["--force-device-scale-factor=2"] } });
  const signal = new AbortController().signal;
  let ref, driver;
  t.after(async () => {
    try {
      if (driver) await Promise.race([driver.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
      if (ref) await provider.release(ref);
    } finally {
      server.close();
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, { timeout: 60_000 });
  ref = await provider.create({ tag: "shot-budget-1", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1288, height: 711 }, metadata: {} }, signal);
  driver = await cdpDriver()(await provider.attach(ref), signal);
  const port = {
    session: async () => ({ driver, tag: ref.tag, sessionId: ref.id, record: { lastUrl: null }, notice: null, interrupted: null, recorded: false, effects: null, downloads: provider.downloads }),
    dispatching: async () => {}, journal: async () => {}, mark: async () => {}, settle: async () => {}, navigated: async () => {}, ended: async () => false, dropped: async () => {},
  };
  let n = 0;
  const call = () => ({ callId: `c${++n}`, conversationId: 1, signal: undefined, label: "node", redact: (text) => text, evidence: { file: async () => null } });
  const tools = pageTools();
  const run = async (name, args = {}) => { const out = await tools[name](args, port, call()); assert.notEqual(out.isError, true, `${name} ${JSON.stringify(args)}: ${textOf(out)}`); return out; };

  await run("run", { actions: [{ op: "goto", url: `${base}/long` }] });
  const viewport = await run("screenshot", {});
  within(imageOf(viewport), "the viewport");
  assert.ok(imageOf(viewport).size.width >= 1900, `the viewport kept as large as the edge allows: ${JSON.stringify(imageOf(viewport).size)}`);
  assert.match(textOf(viewport), /adjusted: the first capture \(2576x\d+\) was over the 2,000 px long edge budget; this is the viewport at \d+x\d+, scaled down/);

  const full = await run("screenshot", { fullPage: true, type: "png" });
  within(imageOf(full), "the full page");
  assert.match(textOf(full), /adjusted: the first capture \(\d+x\d{5}\) was over the 2,000 px long edge budget; this is the viewport at \d+x\d+, scaled down/);

  await run("run", { actions: [{ op: "goto", url: `${base}/short` }] });
  const whole = await run("screenshot", { fullPage: true });
  within(imageOf(whole), "a page short enough to read shrunk");
  assert.ok(imageOf(whole).size.height >= SCREENSHOT_MAX_EDGE_PX - 10, `its whole length, at the long edge: ${JSON.stringify(imageOf(whole).size)}`);
  assert.match(textOf(whole), /this is the full page at \d+x\d+, scaled down/);
});
