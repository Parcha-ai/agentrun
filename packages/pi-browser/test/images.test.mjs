import assert from "node:assert/strict";
import test from "node:test";
import { captureParams, captureWithinBudget, imageSize, SCREENSHOT_MAX_EDGE_PX, ScreenshotBudgetError } from "../dist/index.js";

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const segment = (marker, payload) => [0xff, marker, ...u16(payload.length + 2), ...payload];
const sof = (marker, width, height) => segment(marker, [8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

const png = (width, height, pad = 0) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...Buffer.from("IHDR"), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...new Array(pad).fill(0)]);
const jpeg = (width, height, { before = [], frame = 0xc0, pad = 0 } = {}) => Buffer.from([0xff, 0xd8, ...segment(0xe0, [...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]), ...before, ...sof(frame, width, height), ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), ...new Array(pad).fill(0), 0xff, 0xd9]);

test("a PNG's size is read from its IHDR, as unsigned 32-bit numbers", () => {
  assert.deepEqual(imageSize(png(1280, 720)), { type: "png", width: 1280, height: 720 });
  assert.deepEqual(imageSize(png(0x80000001, 1)), { type: "png", width: 0x80000001, height: 1 });
});

test("a JPEG's size is read from its first frame, past fill bytes, standalone markers and the tables that are not frames", () => {
  assert.deepEqual(imageSize(jpeg(1280, 720)), { type: "jpeg", width: 1280, height: 720 });
  assert.deepEqual(imageSize(jpeg(800, 600, { frame: 0xc2 })), { type: "jpeg", width: 800, height: 600 }, "progressive");
  const lookalikes = [...segment(0xc4, [0, 8, ...u16(9999), ...u16(9999), 0]), ...segment(0xc8, [8, ...u16(1), ...u16(1)]), ...segment(0xcc, [8, ...u16(2), ...u16(2)])];
  assert.deepEqual(imageSize(jpeg(640, 480, { before: lookalikes })), { type: "jpeg", width: 640, height: 480 }, "DHT, JPG and DAC are not frames");
  assert.deepEqual(imageSize(jpeg(320, 240, { before: [0xff, 0xff, 0xff, 0xd0, 0xff, 0x01] })), { type: "jpeg", width: 320, height: 240 }, "fill bytes, RST0 and TEM");
});

test("bytes that are not a whole PNG header or a JPEG with a frame before its scan have no size", () => {
  const head = png(10, 10);
  const scanFirst = Buffer.from([0xff, 0xd8, ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), ...sof(0xc0, 10, 10)]);
  const truncatedFrame = jpeg(10, 10).subarray(0, 2 + 18 + 8);
  for (const [name, bytes] of [
    ["empty", Buffer.alloc(0)], ["short PNG", head.subarray(0, 23)], ["PNG without IHDR", Buffer.concat([head.subarray(0, 12), Buffer.from("IDAT"), head.subarray(16)])],
    ["GIF", Buffer.from("GIF89a\x0a\x00\x0a\x00")], ["JPEG scan before frame", scanFirst], ["JPEG end before frame", Buffer.from([0xff, 0xd8, 0xff, 0xd9, ...sof(0xc0, 1, 1)])],
    ["truncated frame", truncatedFrame], ["no marker where one belongs", Buffer.from([0xff, 0xd8, 0x00, 0xc0, 0, 17, 8, 0, 10, 0, 10])], ["three bytes", Buffer.from([0xff, 0xd8, 0xff])],
  ]) assert.equal(imageSize(bytes), null, name);
});

test("CDP's capture parameters: a clip moves to the document, a full page is the document's clip beyond the viewport, a scaled viewport is its own clip", () => {
  const layout = { cssVisualViewport: { pageX: 0, pageY: 300, clientWidth: 1273, clientHeight: 624 }, cssContentSize: { width: 1273, height: 5016.4 } };
  assert.deepEqual(captureParams({ type: "jpeg", quality: 40.4 }, layout), { format: "jpeg", quality: 40 }, "the viewport at the device's pixels: no clip");
  assert.deepEqual(captureParams({ type: "png", quality: 40 }, layout), { format: "png" }, "no quality for a PNG");
  assert.deepEqual(captureParams({ type: "jpeg", scale: 0.5 }, layout), { format: "jpeg", clip: { x: 0, y: 300, width: 1273, height: 624, scale: 0.5 } });
  assert.deepEqual(captureParams({ fullPage: true, scale: 0.25 }, layout), { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1273, height: 5017, scale: 0.25 } });
  assert.deepEqual(captureParams({ clip: { x: 10, y: 20, width: 30, height: 40 } }, layout), { format: "png", clip: { x: 10, y: 320, width: 30, height: 40, scale: 1 } });
});

/** A page as Chrome captures it: `css` (its viewport and its document, in CSS pixels) times its device scale and the
 *  scale asked, rounded; `bytes` the base64 bytes it comes to at a quality and pixel count, so the byte budget can bite. */
const page = ({ viewport = { width: 1288, height: 711 }, document = 8319, dpr = 1, bytes = () => 0, scales = true } = {}) => {
  const calls = [];
  const capture = async (options) => {
    calls.push(options);
    const factor = dpr * (scales ? options.scale ?? 1 : 1);
    const width = Math.round((options.clip ? options.clip.width : viewport.width) * factor);
    const height = Math.round((options.clip ? options.clip.height : options.fullPage ? document : viewport.height) * factor);
    const pad = Math.ceil(bytes(width * height, options) * 3 / 4);
    const image = options.type === "png" ? png(width, height, pad) : jpeg(width, height, { pad });
    return { data: image.toString("base64"), mimeType: options.type === "png" ? "image/png" : "image/jpeg" };
  };
  return { capture, calls };
};

test("an image within budget is the first capture, taken as requested", async () => {
  const { capture, calls } = page();
  const shot = await captureWithinBudget(capture, {});
  assert.deepEqual(calls, [{ fullPage: false, type: "jpeg", quality: 40 }]);
  assert.deepEqual(shot.size, { type: "jpeg", width: 1288, height: 711 });
  assert.equal(shot.adjusted, null);
  assert.equal(shot.mimeType, "image/jpeg");
});

test("a scale asked is the first capture's, and a retake only scales further down from it", async () => {
  const fits = page({ dpr: 2 });
  const half = await captureWithinBudget(fits.capture, { scale: 0.5 });
  assert.deepEqual(fits.calls, [{ fullPage: false, type: "jpeg", quality: 40, scale: 0.5 }]);
  assert.deepEqual([half.size.width, half.size.height, half.adjusted], [1288, 711, null]);
  const over = page({ dpr: 4 });
  const shot = await captureWithinBudget(over.capture, { scale: 0.5 });
  assert.deepEqual(over.calls.map((o) => o.scale), [0.5, 0.5 * (SCREENSHOT_MAX_EDGE_PX / 2576)]);
  assert.deepEqual([shot.size.width, shot.size.height], [2000, 1104]);
});

test("a viewport over the long edge on a dense display is scaled to fit it, as the region asked", async () => {
  const { capture, calls } = page({ dpr: 2 });
  const shot = await captureWithinBudget(capture, { type: "png" });
  assert.deepEqual(calls.map((o) => [o.fullPage, o.type, o.scale]), [[false, "png", undefined], [false, "png", SCREENSHOT_MAX_EDGE_PX / 2576]]);
  assert.deepEqual(shot.size, { type: "png", width: 2000, height: 1104 });
  assert.deepEqual(shot.adjusted, { why: "long_edge", first: { type: "png", width: 2576, height: 1422 } });
});

test("the long edge may reach the limit but not pass it; a full page that stays readable shrinks, a longer one is the viewport", async () => {
  const fits = page({ document: SCREENSHOT_MAX_EDGE_PX });
  assert.equal((await captureWithinBudget(fits.capture, { type: "png", fullPage: true })).adjusted, null);
  const long = page({ document: 3_000 });
  const shrunk = await captureWithinBudget(long.capture, { fullPage: true });
  assert.deepEqual([shrunk.options.fullPage, shrunk.size], [true, { type: "jpeg", width: 859, height: 2000 }], "the whole page, two thirds of its size");
  const stripe = page({ document: 23_302, dpr: 2 });
  const viewport = await captureWithinBudget(stripe.capture, { fullPage: true });
  assert.deepEqual(stripe.calls.map((o) => [o.fullPage, o.scale]), [[true, undefined], [false, undefined], [false, SCREENSHOT_MAX_EDGE_PX / 2576]]);
  assert.deepEqual([viewport.options.fullPage, viewport.size.width, viewport.adjusted.first.height], [false, 2000, 46604]);
});

test("over the byte budget, quality steps down 40, 25, 10, then the pixels shrink until it fits", async () => {
  const budget = { maxEdgePx: 2_000, maxBase64Bytes: 100_000 };
  // Ten base64 bytes a pixel at quality 40, fewer at 25 and 10: still over at 10, so the capture is shrunk.
  const { capture, calls } = page({ viewport: { width: 200, height: 100 }, bytes: (pixels, o) => pixels * (o.quality === 10 ? 6 : o.quality === 25 ? 8 : 10) });
  const shot = await captureWithinBudget(capture, {}, budget);
  assert.deepEqual(calls.slice(0, 3).map((o) => [o.quality, o.scale]), [[40, undefined], [25, undefined], [10, undefined]]);
  assert.ok(calls.length >= 4 && calls.at(-1).scale < 1, JSON.stringify(calls));
  assert.ok(Buffer.byteLength(shot.data) <= budget.maxBase64Bytes);
  assert.equal(shot.adjusted.why, "base64_bytes");
});

test("a requested quality caps every retake", async () => {
  const budget = { maxEdgePx: 2_000, maxBase64Bytes: 100_000 };
  const { capture, calls } = page({ viewport: { width: 200, height: 100 }, bytes: (pixels, o) => (o.quality > 10 ? pixels * 10 : 0) });
  await captureWithinBudget(capture, { quality: 20 }, budget);
  assert.deepEqual(calls.map((o) => o.quality), [20, 10]);
});

test("a capture whose size cannot be read is retaken once as a viewport JPEG, and never returned", async () => {
  let n = 0;
  const shot = await captureWithinBudget(async () => ({ data: (n++ === 0 ? Buffer.from("not an image at all") : jpeg(640, 480)).toString("base64"), mimeType: "image/png" }), { type: "png" });
  assert.deepEqual(shot.size, { type: "jpeg", width: 640, height: 480 });
  assert.deepEqual(shot.adjusted, { why: "unreadable", first: null });
  const never = await captureWithinBudget(async () => ({ data: Buffer.from("not an image at all").toString("base64"), mimeType: "image/png" }), {}).catch((e) => e);
  assert.ok(never instanceof ScreenshotBudgetError);
  assert.match(never.message, /not a PNG or JPEG whose size can be read/);
});

test("a driver that does not scale: a full page is the viewport, and a viewport over budget throws a ScreenshotBudgetError", async () => {
  const full = page({ document: 3_000, scales: false });
  const shot = await captureWithinBudget(full.capture, { fullPage: true });
  assert.deepEqual(full.calls.map((o) => [o.fullPage, o.scale]), [[true, undefined], [true, 2000 / 3000], [false, undefined]]);
  assert.deepEqual(shot.size, { type: "jpeg", width: 1288, height: 711 });
  const dense = page({ dpr: 2, scales: false });
  const error = await captureWithinBudget(dense.capture, {}).catch((e) => e);
  assert.ok(error instanceof ScreenshotBudgetError);
  assert.equal(error.name, "ScreenshotBudgetError");
  assert.match(error.message, /does not take this capture smaller than 2576x1422/);
});
