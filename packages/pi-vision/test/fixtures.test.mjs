// The fixture helpers, checked against the two image processors the package supports: what `pngBytes` writes both
// decode at its size, and `imageSize` reads the sizes both write, in every format the package measures. Both processors
// load in this workspace, so their suites run here.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";
import photon from "@silvia-odwyer/photon-node";
import { fixtureDir, imageSize, pngBytes } from "@parcha/pi-vision/testing";
import { bmp } from "./support/images.mjs";

test("a written PNG decodes at its size in sharp and in Photon, with the pixels asked for", async () => {
  const png = pngBytes(37, 11, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [0, 0, 255]));
  assert.deepEqual(imageSize(png), { mimeType: "image/png", width: 37, height: 11 });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [37, 11, 3]);
  assert.deepEqual([...data.subarray(0, 6)], [255, 0, 0, 0, 0, 255]);
  const image = photon.PhotonImage.new_from_byteslice(png);
  try { assert.deepEqual([image.get_width(), image.get_height()], [37, 11]); } finally { image.free(); }
});

test("the size reader reads what both processors write, every format the package measures, and nothing else", async () => {
  const png = pngBytes(64, 48);
  for (const [format, mimeType] of [["jpeg", "image/jpeg"], ["png", "image/png"], ["gif", "image/gif"], ["webp", "image/webp"], ["tiff", "image/tiff"]]) {
    for (const [width, height] of [[1288, 377], [37, 2001]]) {
      const bytes = await sharp(png).resize(width, height).toFormat(format).toBuffer();
      const decoded = await sharp(bytes).metadata();
      assert.deepEqual([decoded.width, decoded.height], [width, height], `${format}: the decoder agrees with the size asked for`);
      assert.deepEqual(imageSize(bytes), { mimeType, width, height }, `${format} ${width}x${height}`);
    }
  }
  const image = photon.PhotonImage.new_from_byteslice(png);
  try { assert.deepEqual(imageSize(image.get_bytes_jpeg(80)), { mimeType: "image/jpeg", width: 64, height: 48 }); } finally { image.free(); }
  const webp = photon.PhotonImage.new_from_byteslice(await sharp(png).webp().toBuffer());
  try { assert.deepEqual([webp.get_width(), webp.get_height()], [64, 48]); } finally { webp.free(); }
  for (const topDown of [false, true]) {
    const bytes = bmp(40, 30, { topDown });
    const decoded = photon.PhotonImage.new_from_byteslice(bytes);
    try { assert.deepEqual([decoded.get_width(), decoded.get_height()], [40, 30], "Photon decodes the BMP at the size written"); } finally { decoded.free(); }
    assert.deepEqual(imageSize(bytes), { mimeType: "image/bmp", width: 40, height: 30 }, `a ${topDown ? "top-down" : "bottom-up"} BMP`);
  }
  const webpBytes = await sharp(png).webp().toBuffer();
  for (const bytes of [new Uint8Array(0), new TextEncoder().encode("%PDF-1.7"), png.subarray(0, 20), webpBytes.subarray(0, 20), bmp(40, 30).subarray(0, 20), new Uint8Array(100)]) assert.equal(imageSize(bytes), null);
});

test("a fixture directory holds what a test writes, refuses a name that leaves it, and goes away", async () => {
  const dir = await fixtureDir("pi-vision-fixture-");
  const path = await dir.file("nested/one.txt", "hello");
  assert.equal(await readFile(path, "utf8"), "hello");
  assert.ok(path.startsWith(`${dir.path}/nested/`));
  await assert.rejects(dir.file("../escape.txt", "x"), RangeError);
  await dir.remove();
  assert.equal(existsSync(dir.path), false);
});
