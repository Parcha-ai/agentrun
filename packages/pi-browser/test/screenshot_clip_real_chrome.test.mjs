// A screenshot of a region on a real Chrome through the Stagehand driver: the pixels are the region's, a clip is read from the viewport
// as it is scrolled, and an element is scrolled into view first.
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startAgent, turn } from "./coding-agent/rig.mjs";

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
const png = (result) => Buffer.from(result.result.content.find((c) => c.type === "image").data, "base64");
const same = (image, color) => { for (let y = 0; y < image.height; y += 7) for (let x = 0; x < image.width; x += 7) assert.deepEqual(image.pixel(x, y), color, `pixel ${x},${y}`); };

test("a region of a real Chrome page is captured as its own pixels: a clip read from the viewport, an element scrolled into view first", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const env = { PI_BROWSER_CHROME: CHROME, PATH: process.env.PATH ?? "", ...(process.env.CI ? { PI_BROWSER_NO_SANDBOX: "1" } : {}) };
  let agent;
  try {
    agent = await startAgent(t, { extension: { env } });
    const go = `await page.goto(${JSON.stringify(`data:text/html,${encodeURIComponent(PAGE)}`)}); return await page.title();`;
    const [opened, top, scrolled] = await agent.run(
      turn(["run", { code: go }]),
      turn(["screenshot", { type: "png", clip: { x: 40, y: 10, width: 100, height: 80 } }]),
      turn(["run", { code: "await page.evaluate(() => window.scrollTo(0, 1500)); return await page.evaluate(() => window.scrollY);" }]),
    );
    assert.equal(opened.isError, false, opened.text);
    assert.equal(top.isError, false, top.text);
    const first = decodePng(png(top));
    assert.deepEqual([first.width, first.height], [100, 80], "the image is the clip's size");
    same(first, COLORS.red);
    assert.deepEqual(top.result.details.media.clip, { x: 40, y: 10, width: 100, height: 80 });
    assert.match(scrolled.text, /1500/);

    // The same clip after a scroll is the viewport's top-left, not the document's: the green block, not the red one.
    const [afterScroll, element, byId, nothing, twins] = await agent.run(
      turn(["screenshot", { type: "png", clip: { x: 40, y: 10, width: 100, height: 80 } }]),
      turn(["screenshot", { type: "png", selector: "#blue" }]),
      turn(["snapshot"]),
      turn(["screenshot", { type: "png", selector: "#nope" }]),
      turn(["screenshot", { type: "png", selector: ".twin" }]),
    );
    same(decodePng(png(afterScroll)), COLORS.green);
    const blue = decodePng(png(element));
    assert.deepEqual([blue.width, blue.height], [240, 160], "an element is captured as its own box");
    same(blue, COLORS.blue);
    assert.equal(element.result.details.media.selector, "#blue");
    assert.deepEqual([element.result.details.media.clip.width, element.result.details.media.clip.height], [240, 160]);
    // `snapshot` ran in the call above this one's list position: byId is the snapshot text, the ID is read from it.
    const idOf = /\[(\d+-\d+)\][^\n]*Target/.exec(byId.text)?.[1];
    assert.ok(idOf, `the snapshot lists the button: ${byId.text.slice(0, 400)}`);
    assert.equal(nothing.isError, true);
    assert.match(nothing.text, /selector #nope matches nothing/);
    assert.equal(twins.isError, true);
    assert.match(twins.text, /matches 2 elements/);

    const [button, stale] = await agent.run(
      turn(["screenshot", { type: "png", id: idOf }]),
      turn(["screenshot", { type: "png", id: "9-999" }]),
    );
    assert.equal(button.isError, false, button.text);
    const small = decodePng(png(button));
    assert.deepEqual([small.width, small.height], [120, 40], "an element named by snapshot ID is its own box");
    assert.equal(button.result.details.media.id, idOf);
    assert.equal(stale.isError, true, "an ID the snapshot never gave is refused");
  } catch (error) { if (skipIncapable(t, error)) return; throw error; }
});
