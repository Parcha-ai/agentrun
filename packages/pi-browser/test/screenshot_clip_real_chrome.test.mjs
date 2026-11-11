// A screenshot of a region on a real Chrome through the Stagehand driver and the page tools: the pixels are the region's, a clip is
// read from the viewport as it is scrolled, and an element is scrolled into view first.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { pageTools } from "../dist/index.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";

/** The RGB of every pixel of an 8-bit PNG (colour type 2 or 6, no interlace). */
function decodePng(bytes) {
  let at = 8, width = 0, height = 0, type = 0;
  const data = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at), kind = bytes.toString("ascii", at + 4, at + 8), body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9]; assert.equal(body[8], 8); assert.equal(body[12], 0, "no interlace"); }
    if (kind === "IDAT") data.push(body);
    at += 12 + length;
  }
  const channels = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(data)), stride = width * channels, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[y * stride + x - channels] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      out[y * stride + x] = (line[x] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
  const pixel = (x, y) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)];
  return { width, height, pixel };
}

const COLORS = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255] };
// Three 240x160 blocks at document heights 0, 1500 and 3000, so a clip read from the page's top and one read from the viewport differ.
const PAGE = `<!doctype html><title>blocks</title><body style="margin:0;height:3400px;position:relative">
<div id=red style="position:absolute;left:30px;top:0;width:240px;height:160px;background:#f00"></div>
<div id=green style="position:absolute;left:30px;top:1500px;width:240px;height:160px;background:#0f0"></div>
<div id=blue style="position:absolute;left:30px;top:3000px;width:240px;height:160px;background:#00f"></div>
<button id=go style="position:absolute;left:400px;top:3000px;width:120px;height:40px;background:#00f;color:#fff">Target</button>
<p class=twin style="position:absolute;left:600px;top:10px">a</p><p class=twin style="position:absolute;left:600px;top:50px">b</p>`;
const png = (out) => Buffer.from(out.content.find((c) => c.type === "image").data, "base64");
const textOf = (out) => out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const same = (image, color) => { for (let y = 0; y < image.height; y += 7) for (let x = 0; x < image.width; x += 7) assert.deepEqual(image.pixel(x, y), color, `pixel ${x},${y}`); };

test("a region of a real Chrome page is captured as its own pixels: a clip read from the viewport, an element scrolled into view first", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "clip-chrome-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const signal = new AbortController().signal;
  let ref, driver;
  t.after(async () => {
    try {
      if (driver) await Promise.race([driver.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
      if (ref) await provider.release(ref);
    } finally { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, { timeout: 60_000 });
  try {
    ref = await provider.create(spec("clip-1"), signal);
    driver = await stagehandDriver()(await provider.attach(ref), signal, { batchTimeoutMs: 30_000 });
  } catch (error) { if (skipIncapable(t, error)) return; throw error; }
  const port = {
    session: async () => ({ driver, tag: ref.tag, sessionId: ref.id, record: { lastUrl: null }, notice: null, interrupted: null, recorded: false, effects: null, downloads: provider.downloads }),
    dispatching: async () => {}, journal: async () => {}, mark: async () => {}, settle: async () => {}, navigated: async () => {}, ended: async () => false, dropped: async () => {},
  };
  let n = 0;
  const call = () => ({ callId: `c${++n}`, conversationId: 1, signal: undefined, label: "node", redact: (text) => text, evidence: { file: async () => null } });
  const tools = pageTools();
  const run = async (name, args = {}) => { const out = await tools[name](args, port, call()); return { out, isError: out.isError === true, text: textOf(out) }; };

  const go = `await page.goto(${JSON.stringify(`data:text/html,${encodeURIComponent(PAGE)}`)}); return await page.title();`;
  const opened = await run("run", { code: go });
  const top = await run("screenshot", { type: "png", clip: { x: 40, y: 10, width: 100, height: 80 } });
  const scrolled = await run("run", { code: "await page.evaluate(() => window.scrollTo(0, 1500)); return await page.evaluate(() => window.scrollY);" });
  assert.equal(opened.isError, false, opened.text);
  assert.equal(top.isError, false, top.text);
  const first = decodePng(png(top.out));
  assert.deepEqual([first.width, first.height], [100, 80], "the image is the clip's size");
  same(first, COLORS.red);
  assert.deepEqual(top.out.details.media.clip, { x: 40, y: 10, width: 100, height: 80 });
  assert.match(scrolled.text, /1500/);

  // The same clip after a scroll is the viewport's top-left, not the document's: the green block, not the red one.
  const afterScroll = await run("screenshot", { type: "png", clip: { x: 40, y: 10, width: 100, height: 80 } });
  const element = await run("screenshot", { type: "png", selector: "#blue" });
  const byId = await run("snapshot");
  const nothing = await run("screenshot", { type: "png", selector: "#nope" });
  const twins = await run("screenshot", { type: "png", selector: ".twin" });
  same(decodePng(png(afterScroll.out)), COLORS.green);
  const blue = decodePng(png(element.out));
  assert.deepEqual([blue.width, blue.height], [240, 160], "an element is captured as its own box");
  same(blue, COLORS.blue);
  assert.equal(element.out.details.media.selector, "#blue");
  assert.deepEqual([element.out.details.media.clip.width, element.out.details.media.clip.height], [240, 160]);
  const idOf = /\[(\d+-\d+)\][^\n]*Target/.exec(byId.text)?.[1];
  assert.ok(idOf, `the snapshot lists the button: ${byId.text.slice(0, 400)}`);
  assert.equal(nothing.isError, true);
  assert.match(nothing.text, /selector #nope matches nothing/);
  assert.equal(twins.isError, true);
  assert.match(twins.text, /matches 2 elements/);

  const button = await run("screenshot", { type: "png", id: idOf });
  const stale = await run("screenshot", { type: "png", id: "9-999" });
  assert.equal(button.isError, false, button.text);
  const small = decodePng(png(button.out));
  assert.deepEqual([small.width, small.height], [120, 40], "an element named by snapshot ID is its own box");
  assert.equal(button.out.details.media.id, idOf);
  assert.equal(stale.isError, true, "an ID the snapshot never gave is refused");
});
