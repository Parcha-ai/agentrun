import assert from "node:assert/strict";
import test from "node:test";
import { captureWithinBudget, imageSize, SCREENSHOT_MAX_EDGE_PX, ScreenshotBudgetError } from "../dist/index.js";

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

const capturer = (images) => {
  const calls = [];
  const capture = async (options) => {
    calls.push(options);
    const image = images[Math.min(calls.length - 1, images.length - 1)];
    return { data: image.toString("base64"), mimeType: image[0] === 0x89 ? "image/png" : "image/jpeg" };
  };
  return { capture, calls };
};

test("an image within budget is the first capture, taken as requested", async () => {
  const { capture, calls } = capturer([jpeg(1280, 720)]);
  const shot = await captureWithinBudget(capture, {});
  assert.deepEqual(calls, [{ fullPage: false, type: "jpeg", quality: 40 }]);
  assert.deepEqual(shot.size, { type: "jpeg", width: 1280, height: 720 });
  assert.equal(shot.adjusted, null);
  assert.equal(shot.mimeType, "image/jpeg");
});

test("the long edge may reach the limit but not pass it; past it, a viewport JPEG at CSS scale is taken", async () => {
  const fits = capturer([png(1280, SCREENSHOT_MAX_EDGE_PX)]);
  assert.equal((await captureWithinBudget(fits.capture, { type: "png", fullPage: true })).adjusted, null);
  const tall = capturer([png(1280, SCREENSHOT_MAX_EDGE_PX + 1), jpeg(1280, 720)]);
  const shot = await captureWithinBudget(tall.capture, { type: "png", fullPage: true });
  assert.deepEqual(tall.calls, [{ fullPage: true, type: "png" }, { fullPage: false, type: "jpeg", quality: 40, scale: "css" }]);
  assert.deepEqual(shot.adjusted, { why: "long_edge", first: { type: "png", width: 1280, height: SCREENSHOT_MAX_EDGE_PX + 1 } });
});

test("over the byte budget, quality steps down 40, 25, 10 and stops at the first that fits", async () => {
  const big = jpeg(100, 100, { pad: 2_000 }), small = jpeg(100, 100);
  const budget = { maxEdgePx: 2_000, maxBase64Bytes: small.toString("base64").length };
  const { capture, calls } = capturer([big, big, big, small]);
  const shot = await captureWithinBudget(capture, { scale: "device" }, budget);
  assert.deepEqual(calls.map((o) => [o.quality, o.scale]), [[40, "device"], [40, "css"], [25, "css"], [10, "css"]]);
  assert.equal(shot.adjusted.why, "base64_bytes");
  assert.deepEqual(shot.options, { fullPage: false, type: "jpeg", quality: 10, scale: "css" });
});

test("a requested quality caps every retake, and a retake that repeats an earlier attempt is not taken again", async () => {
  const big = jpeg(100, 100, { pad: 2_000 });
  const budget = { maxEdgePx: 2_000, maxBase64Bytes: 1_000 };
  const low = capturer([big]);
  await assert.rejects(captureWithinBudget(low.capture, { quality: 20 }, budget), ScreenshotBudgetError);
  assert.deepEqual(low.calls.map((o) => [o.quality, o.scale]), [[20, undefined], [20, "css"], [10, "css"]]);
  const same = capturer([big]);
  await assert.rejects(captureWithinBudget(same.capture, { quality: 40, scale: "css" }, budget), ScreenshotBudgetError);
  assert.deepEqual(same.calls.map((o) => o.quality), [40, 25, 10]);
});

test("an image whose size cannot be read is never returned", async () => {
  const { capture } = capturer([Buffer.from("not an image at all"), jpeg(640, 480)]);
  const shot = await captureWithinBudget(capture, {});
  assert.deepEqual(shot.size, { type: "jpeg", width: 640, height: 480 });
  assert.equal(shot.adjusted.first, null);
});

test("an image still over budget after every retake throws a ScreenshotBudgetError after four captures", async () => {
  const { capture, calls } = capturer([png(4_000, 4_000)]);
  const error = await captureWithinBudget(capture, { type: "png", fullPage: true }).catch((e) => e);
  assert.ok(error instanceof ScreenshotBudgetError);
  assert.equal(error.name, "ScreenshotBudgetError");
  assert.match(error.message, /2000 px .* 900000 base64 bytes/);
  assert.equal(calls.length, 4);
});
