// The two image processors as providers: the conformance suite's cases for each, detection, what the package does and
// does not load, and Photon's worker under hostile and slow input. A processor never takes the process down, never
// holds it open, and never stays broken after a failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import sharp from "sharp";
import { DECODE_GUARD_PIXELS, DEFAULT_LIMITS, detectOnce, fitImage } from "@parcha/pi-vision";
import { photonImages } from "@parcha/pi-vision/providers/photon";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { fixtureDir, registerProviderConformance } from "@parcha/pi-vision/testing";
import { flat } from "./support/images.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIMITS = { ...DEFAULT_LIMITS.image, imagesPerCall: DEFAULT_LIMITS.imagesPerCall };
const env = () => new NodeExecutionEnv({ cwd: ROOT });
const photonVersion = (await import("@silvia-odwyer/photon-node/package.json", { with: { type: "json" } })).default.version;

// Each processor passes the shared cases (it detects and never throws; every capability it declares has its method), and
// each is the other's twin. The suite has no fit fixture yet, so what a fit must give is checked in image.test.mjs.
registerProviderConformance({ provider: photonImages(), twin: sharpImages(sharp), env, fixtures: [], requireAvailable: true });
registerProviderConformance({ provider: sharpImages(sharp), twin: photonImages(), env, fixtures: [], requireAvailable: true });

test("each processor is a provider of one job: fitting images, named, versioned by what detection found", async () => {
  const [photon, viaSharp] = [photonImages(), sharpImages(sharp)];
  for (const provider of [photon, viaSharp]) {
    assert.deepEqual([provider.capabilities, provider.kinds], [["fit"], ["image"]]);
    assert.equal(typeof provider.prepare, "function");
  }
  assert.deepEqual(await detectOnce(photon, env()), { available: true, version: photonVersion });
  assert.deepEqual(await detectOnce(viaSharp, env()), { available: true, version: sharp.versions.sharp });
  assert.deepEqual([photon.name, viaSharp.name], ["photon", "sharp"]);
});

test("sharp is the host's own module: anything but its default export is refused at once, and the module is used only to decode", async () => {
  for (const [what, wrong] of [["nothing", undefined], ["null", null], ["an object", {}], ["a name", "sharp"], ["the module namespace", await import("sharp")]]) assert.throws(() => sharpImages(wrong), /takes sharp's default export/, what);
  const calls = [];
  const fake = Object.assign((...args) => { calls.push(args); throw new Error("a decode attempt"); }, { versions: { sharp: "9.9.9" } });
  const processor = sharpImages(fake);
  assert.deepEqual(await processor.detect(env()), { available: true, version: "9.9.9" });
  const png = await flat(800, 600).png().toBuffer();
  assert.equal((await fitImage(processor, png, "image/png", LIMITS)).fit, "as_is");
  assert.equal(calls.length, 0, "an image within the limits does not touch it");
  const big = await flat(3000, 2000).jpeg().toBuffer();
  const out = await fitImage(processor, big, "image/jpeg", LIMITS);
  assert.deepEqual([out.fit, out.code], ["refused", "unreadable"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].limitInputPixels, DECODE_GUARD_PIXELS, "the decoder is told the guard as well");
  assert.equal(calls[0][1].failOn, "error");
});

test("the package never resolves sharp or Photon itself: copied where neither can be found, it fits what needs no decoder and names Photon when it is wanted", async () => {
  const where = await fixtureDir("pi-vision-standalone-");
  try {
    cpSync(new URL("../dist", import.meta.url), join(where.path, "dist"), { recursive: true });
    await where.file("package.json", JSON.stringify({ type: "module" }));
    const script = `
      const { fitImage, DEFAULT_LIMITS } = await import(${JSON.stringify(pathToFileURL(join(where.path, "dist/index.js")).href)});
      const { photonImages } = await import(${JSON.stringify(pathToFileURL(join(where.path, "dist/providers/photon.js")).href)});
      const { sharpImages } = await import(${JSON.stringify(pathToFileURL(join(where.path, "dist/providers/sharp.js")).href)});
      const limits = { ...DEFAULT_LIMITS.image, imagesPerCall: 8 };
      const png = (w, h) => { const b = Buffer.alloc(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
      const photon = photonImages();
      const fake = Object.assign(() => { throw new Error("a decode attempt"); }, { versions: { sharp: "9.9.9" } });
      console.log(JSON.stringify({
        small: (await fitImage(photon, png(640, 480), "image/png", limits)).fit,
        large: await fitImage(photon, png(3000, 2000), "image/png", limits).then((r) => [r.fit, r.code, r.why]),
        detect: await photon.detect({ id: "e", cwd: "/" }),
        sharp: await sharpImages(fake).detect({ id: "e", cwd: "/" }),
      }));`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: where.path, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const seen = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(seen.small, "as_is");
    assert.deepEqual(seen.large, ["refused", "needs", "Photon (@silvia-odwyer/photon-node) is not installed"]);
    assert.deepEqual(seen.detect, { available: false, needs: "@silvia-odwyer/photon-node", reason: "Photon (@silvia-odwyer/photon-node) is not installed" });
    assert.deepEqual(seen.sharp, { available: true, version: "9.9.9" });
  } finally {
    await where.remove();
  }
});

test("an operation that takes longer than its limit is refused as a typed miss, and the processor takes the next one", async () => {
  const photon = photonImages({ timeoutMs: 1 });
  const photo = await flat(3024, 2000).jpeg().toBuffer();
  for (let i = 0; i < 2; i++) {
    const out = await fitImage(photon, photo, "image/jpeg", LIMITS);
    assert.deepEqual([out.fit, out.code], ["refused", "unreadable"], `attempt ${i + 1}`);
    assert.match(out.why, /Photon took longer than 1 ms/);
  }
});

test("Photon's worker never holds the process open: after a fit, after a timeout and after a trap the process ends by itself", () => {
  const script = `
    import { createRequire } from "node:module";
    const sharp = createRequire(process.cwd() + "/package.json")("sharp");
    const { fitImage, DEFAULT_LIMITS } = await import("@parcha/pi-vision");
    const { photonImages } = await import("@parcha/pi-vision/providers/photon");
    const limits = { ...DEFAULT_LIMITS.image, imagesPerCall: 8 };
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const trap = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#fff" } }).tiff({ compression: "jpeg" }).toBuffer();
    const results = [];
    results.push((await fitImage(photonImages(), big, "image/jpeg", limits)).fit);
    results.push((await fitImage(photonImages({ timeoutMs: 1 }), big, "image/jpeg", limits)).fit);
    results.push((await fitImage(photonImages(), trap, "image/tiff", limits)).fit);
    console.log(JSON.stringify(results));`;
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, `${run.error ?? ""}${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)), ["resized", "refused", "refused"]);
  assert.ok(Date.now() - started < 30_000, "it ended on its own");
});

test("calls that overlap are served one at a time, each its own answer, and one that fails does not fail the others", async () => {
  const photon = photonImages();
  const sizes = [[2400, 1600], [3000, 1000], [1200, 2600], [2200, 2200]];
  const files = await Promise.all(sizes.map(([w, h]) => flat(w, h).jpeg().toBuffer()));
  const results = await Promise.all([...files.map((bytes) => fitImage(photon, bytes, "image/jpeg", LIMITS)), fitImage(photon, Buffer.concat([files[0].subarray(0, 600), Buffer.alloc(200)]), "image/jpeg", LIMITS)]);
  assert.deepEqual(results.slice(0, 4).map((r) => [r.fit, r.blocks[0].width, r.blocks[0].height]), [["resized", 2000, 1333], ["resized", 2000, 667], ["resized", 923, 2000], ["resized", 2000, 2000]]);
  assert.equal(results[4].fit, "refused", "the damaged one");
});

test("a reply or an error from a worker that was given up on never reaches the request that follows", () => {
  // The worker module is replaced by a fake whose workers answer only when the test says: the one a timeout stopped
  // answers late, while its successor's first request is waiting.
  const script = `
    import { registerHooks } from "node:module";
    const fake = ${JSON.stringify(`
      import { EventEmitter } from "node:events";
      export class Worker extends EventEmitter {
        constructor() { super(); globalThis.workers.push(this); }
        ref() {} unref() {} postMessage() {} terminate() { return Promise.resolve(); }
      }`)};
    globalThis.workers = [];
    registerHooks({ resolve(specifier, context, next) { return specifier === "node:worker_threads" ? { url: "data:text/javascript," + encodeURIComponent(fake), shortCircuit: true } : next(specifier, context); } });
    const { photonImages } = await import("@parcha/pi-vision/providers/photon");
    const photon = photonImages({ timeoutMs: 50 });
    const raster = { width: 1, height: 1, channels: 4, data: new Uint8Array(4) };
    const first = await photon.encode(raster).then(() => "answered", (error) => error.message);
    const second = photon.encode(raster);
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.workers[0].emit("message", { id: 1, value: "STALE" });
    globalThis.workers[0].emit("error", new Error("late"));
    globalThis.workers[1].emit("message", { id: 2, value: "FRESH" });
    console.log(JSON.stringify({ first, second: await second.catch((error) => error.message), workers: globalThis.workers.length }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)), { first: "Photon took longer than 50 ms", second: "FRESH", workers: 2 });
});

test("Photon is asked to decode nothing over the guard, and nothing whose size its header does not state", async () => {
  const photon = photonImages();
  const png = await flat(640, 480).png().toBuffer();
  await assert.rejects(photon.raster(png, { orientation: 1, maxPixels: 640 * 480 - 1 }), /over what Photon is asked to decode/);
  await assert.rejects(photon.raster(Buffer.from("not an image"), { orientation: 1, maxPixels: DECODE_GUARD_PIXELS }), /not in its header/);
  const raster = await photon.raster(png, { size: { width: 320, height: 240 }, orientation: 1, maxPixels: DECODE_GUARD_PIXELS });
  assert.deepEqual([raster.width, raster.height, raster.channels, raster.data.length], [320, 240, 4, 320 * 240 * 4]);
});

test("each processor encodes the other's rasters: opaque with 3 channels and transparent with 4, as a PNG and as a JPEG", async () => {
  const bytes = await sharp(Buffer.from(Array.from({ length: 64 * 32 * 3 }, (_, i) => ((i / 3) % 64 < 32 ? [220, 40, 40] : [30, 30, 200])[i % 3])), { raw: { width: 64, height: 32, channels: 3 } }).png().toBuffer();
  const opaque = await sharpImages(sharp).raster(bytes, { orientation: 1, maxPixels: DECODE_GUARD_PIXELS });
  assert.equal(opaque.channels, 3);
  const translucent = await photonImages().raster(bytes, { orientation: 1, maxPixels: DECODE_GUARD_PIXELS });
  assert.equal(translucent.channels, 4);
  for (const [name, make] of [["sharp", () => sharpImages(sharp)], ["photon", () => photonImages()]]) {
    for (const raster of [opaque, translucent]) {
      for (const quality of [undefined, 90]) {
        const encoded = await make().encode(raster, quality);
        const decoded = await sharp(Buffer.from(encoded)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([decoded.info.width, decoded.info.height], [64, 32], `${name} ${raster.channels} channels ${quality ?? "png"}`);
        const at = (x) => Array.from(decoded.data.subarray((16 * 64 + x) * decoded.info.channels, (16 * 64 + x) * decoded.info.channels + 3));
        assert.ok(at(8).every((c, i) => Math.abs(c - [220, 40, 40][i]) <= 12) && at(56).every((c, i) => Math.abs(c - [30, 30, 200][i]) <= 12), `${name} ${raster.channels} channels ${quality ?? "png"}: ${at(8)} and ${at(56)}`);
      }
    }
  }
});

test("a processor turns an image by the orientation it is given and by no other it finds in the file", async () => {
  const marked = await flat(300, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const plain = await flat(300, 200).jpeg().toBuffer();
  for (const [name, make] of [["sharp", () => sharpImages(sharp)], ["photon", () => photonImages()]]) {
    const size = async (bytes, orientation) => { const r = await make().raster(bytes, { orientation, maxPixels: DECODE_GUARD_PIXELS }); return [r.width, r.height]; };
    assert.deepEqual(await size(marked, 1), [300, 200], `${name}: a file that says 6, given 1, is not turned`);
    assert.deepEqual(await size(plain, 6), [200, 300], `${name}: a file that says nothing, given 6, is turned`);
    assert.deepEqual(await size(marked, 6), [200, 300], `${name}: and turned once, not twice`);
  }
});

test("a decoded raster is what the image was: the same pixels from both processors, within the resampler's difference", async () => {
  const bytes = await sharp(Buffer.from(Array.from({ length: 200 * 100 * 3 }, (_, i) => ((i / 3) % 200 < 100 ? [220, 40, 40] : [30, 30, 200])[i % 3])), { raw: { width: 200, height: 100, channels: 3 } }).png().toBuffer();
  const [a, b] = [await sharpImages(sharp).raster(bytes, { size: { width: 100, height: 50 }, orientation: 1, maxPixels: DECODE_GUARD_PIXELS }), await photonImages().raster(bytes, { size: { width: 100, height: 50 }, orientation: 1, maxPixels: DECODE_GUARD_PIXELS })];
  assert.deepEqual([a.width, a.height], [b.width, b.height]);
  const at = (r, x, y) => Array.from(r.data.subarray((y * r.width + x) * r.channels, (y * r.width + x) * r.channels + 3));
  for (const [x, y] of [[10, 10], [90, 40], [20, 25]]) assert.ok(at(a, x, y).every((c, i) => Math.abs(c - at(b, x, y)[i]) <= 3), `(${x}, ${y}): ${at(a, x, y)} against ${at(b, x, y)}`);
});
