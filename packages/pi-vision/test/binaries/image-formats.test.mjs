// What the package tells a model about the formats no model takes as they are (AVIF, BMP, TIFF) is that the
// environment's ffmpeg converts them: this suite runs ffmpeg through the environment port on images it builds and holds
// the claim, so a change in the program is a failing test and not a wrong sentence. HEIC is promised nowhere, and the
// second test holds that: nothing here reads it. It runs in the job that installs ffmpeg and fails there when ffmpeg is
// missing; elsewhere it skips with its reason.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import sharp from "sharp";
import { DEFAULT_LIMITS, fitImage, visionContext } from "@parcha/pi-vision";
import { photonImages } from "@parcha/pi-vision/providers/photon";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { fixtureDir, imageSize } from "@parcha/pi-vision/testing";
import { heifFile } from "../support/heif.mjs";
import { bmp, flat } from "../support/images.mjs";

const required = process.env.PI_VISION_REQUIRE_BINARIES === "1";
const dir = await fixtureDir("pi-vision-ffmpeg-image-");
test.after(() => dir.remove());
const env = new NodeExecutionEnv({ cwd: dir.path });
const probe = await env.exec(["ffmpeg", "-version"], { timeout: 10_000 }, visionContext());
const available = probe.ok && probe.value.exitCode === 0;

/** ffmpeg's conversion of `name` to a PNG, through the environment: the size of what it wrote, or null when it failed. */
async function convert(name) {
  const out = `${name}.png`;
  const ran = await env.exec(["ffmpeg", "-v", "error", "-y", "-i", name, "-frames:v", "1", out], { cwd: dir.path, timeout: 60_000 }, visionContext());
  if (!ran.ok || ran.value.exitCode !== 0) return null;
  const size = imageSize(await readFile(`${dir.path}/${out}`));
  return size && { width: size.width, height: size.height };
}

test("ffmpeg in the environment converts AVIF, BMP and TIFF to PNG at the size they have", { skip: !available && !required && "ffmpeg is not on PATH" }, async () => {
  assert.ok(available, "ffmpeg must be on PATH where PI_VISION_REQUIRE_BINARIES=1");
  const files = {
    "flat.avif": await flat(640, 480).avif({ effort: 0 }).toBuffer(),
    "flat.bmp": bmp(640, 480),
    "plain.tiff": await flat(640, 480).tiff({ compression: "none" }).toBuffer(),
    "lzw.tiff": await flat(640, 480).tiff({ compression: "lzw" }).toBuffer(),
    "jpeg.tiff": await flat(640, 480).tiff({ compression: "jpeg" }).toBuffer(),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await dir.file(name, bytes);
    assert.deepEqual(await convert(name), { width: 640, height: 480 }, name);
    if (!name.endsWith(".bmp")) assert.equal((await sharp(bytes).metadata()).width, 640, `${name} is the image it says`);
  }
});

test("no reader is promised for HEIC: the same container decodes as AV1 in sharp, and as HEVC in neither sharp nor ffmpeg", { skip: !available && !required && "ffmpeg is not on PATH" }, async () => {
  assert.ok(available, "ffmpeg must be on PATH where PI_VISION_REQUIRE_BINARIES=1");
  const encode = async (name, ...codec) => {
    const ran = await env.exec(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x64", "-frames:v", "1", ...codec, name], { cwd: dir.path, timeout: 60_000 }, visionContext());
    assert.ok(ran.ok && ran.value.exitCode === 0, `ffmpeg encoded ${name}`);
    return readFile(`${dir.path}/${name}`);
  };
  const av1 = heifFile("av1", await encode("still.obu", "-c:v", "libaom-av1", "-cpu-used", "8", "-f", "obu"), { width: 64, height: 64 });
  const hevc = heifFile("hevc", await encode("still.hevc", "-c:v", "libx265", "-x265-params", "keyint=1:log-level=none:repeat-headers=1:info=0", "-f", "hevc"), { width: 64, height: 64 });
  assert.equal((await sharp(av1).metadata()).compression, "av1");
  assert.equal((await sharp(hevc).metadata()).compression, "hevc", "the container is read as the HEIC it is");
  const decoded = await sharp(av1).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([decoded.info.width, decoded.info.height], [64, 64], "the AV1 image in the container decodes: the container is sound");
  await assert.rejects(sharp(hevc).raw().toBuffer(), "the HEVC image in it does not: sharp's prebuilt libheif has no HEVC decoder");
  await dir.file("still.heic", hevc);
  assert.equal(await convert("still.heic"), null, "and ffmpeg does not open a HEIF still");
  for (const processor of [sharpImages(sharp), photonImages()]) {
    const out = await fitImage(processor, hevc, "image/heic", { ...DEFAULT_LIMITS.image, imagesPerCall: 8 });
    assert.deepEqual([out.fit, out.code], ["refused", "needs"], "so a HEIC is a typed miss, never bytes");
  }
  const avif = await fitImage(sharpImages(sharp), av1, "image/avif", { ...DEFAULT_LIMITS.image, imagesPerCall: 8 });
  assert.deepEqual([avif.fit, avif.convertedFrom, avif.blocks[0].width], ["resized", "image/avif", 64], "while the AVIF is converted");
});
