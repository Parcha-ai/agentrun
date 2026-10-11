// The image fit, through both processors a host can pass (Photon in a worker, sharp as the host's own module), on images
// the test builds for itself: an image within the limits comes back as its own bytes with nothing decoded, one over them
// comes back resized, or as tiles in reading order when a resize would shrink it past reading, and one that cannot be
// fitted comes back as a refusal that names the limit, never as bytes. Sharp decodes what the processors write.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { DEFAULT_LIMITS, FLOOR_EDGE, TILE_MAX_EDGE, TILE_OVERLAP, fitImage, fitSentence, imageLayout, imageProcessor } from "@parcha/pi-vision";
import { photonImages } from "@parcha/pi-vision/providers/photon";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { bandedPng, bmp, corners, flat, ftyp, pixelAt, pngClaiming, rowsPng, shadeAt, sizeOf, webp } from "./support/images.mjs";

const LIMITS = { ...DEFAULT_LIMITS.image, imagesPerCall: DEFAULT_LIMITS.imagesPerCall };
const EDGE = LIMITS.maxWidth;
const grouped = (n) => n.toLocaleString("en-US");
const processors = [["sharp", () => sharpImages(sharp)], ["photon", () => photonImages()]];
const fit = (processor, bytes, mime = "image/png", limits = LIMITS, options) => fitImage(processor, bytes, mime, limits, options);

/** A processor that fails every decode, and counts what it is asked. */
const failing = (cause = "Cannot find package 'sharp'", code) => {
  const asked = { raster: 0, probe: 0, encode: 0 };
  const boom = (name) => async () => { asked[name]++; throw Object.assign(new Error(cause), code ? { code } : {}); };
  return Object.assign(imageProcessor({ raster: boom("raster"), encode: boom("encode") }), { asked });
};

for (const [name, make] of processors) {
  const processor = make();
  const at = (what) => `${name}: ${what}`;

  test(at("a tall screenshot comes back as tiles in reading order, each within both limits, none a strip"), async () => {
    const out = await fit(processor, await bandedPng(1288, 8319, 1000));
    assert.equal(out.fit, "tiled");
    assert.ok(out.blocks.length >= 2 && out.blocks.length <= LIMITS.imagesPerCall, `${out.blocks.length} blocks`);
    for (const block of out.blocks) {
      const { width, height } = await sizeOf(block);
      assert.deepEqual([block.width, block.height], [width, height], "the block says the size it has");
      assert.ok(width <= EDGE && height <= EDGE, `${width}x${height}`);
      assert.ok(block.data.length <= LIMITS.maxBytes);
      assert.equal(width, 1288, "the full width survives: a tile is not a shrunken strip");
    }
    assert.match(fitSentence(out, LIMITS), new RegExp(`${out.blocks.length} tiles`));
    const shades = [];
    for (const tile of out.blocks) shades.push([await shadeAt(tile, 5, 0), await shadeAt(tile, 5, tile.height - 1)]);
    for (let i = 1; i < shades.length; i++) assert.ok(shades[i][0] >= shades[i - 1][0] && shades[i][1] >= shades[i - 1][1], JSON.stringify(shades));
    assert.ok(Math.abs(shades[0][0]) <= 8 && Math.abs(shades.at(-1)[1] - 28 * 8) <= 8, JSON.stringify(shades));
  });

  /** The mean difference between a tile's rows and the rows of `reference` (the picture the tiles are cut from) at `start`. */
  const tileDifference = async (tile, reference, start) => {
    const shown = await sharp(Buffer.from(tile.data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, count = 0;
    for (let y = 0; y < shown.info.height; y += 7) {
      const there = (start + y) * reference.info.width * 3 + Math.floor(reference.info.width / 2) * 3;
      const mine = (y * shown.info.width + Math.floor(shown.info.width / 2)) * shown.info.channels;
      for (let c = 0; c < 3; c++) { sum += Math.abs(shown.data[mine + c] - reference.data[there + c]); count++; }
    }
    return sum / count;
  };
  for (const [width, height, scaled] of [[1288, 8319, false], [600, 30_000, true], [3000, 7000, true]]) {
    test(at(`the tile starts the text gives are the rows each tile was cut from: ${width}x${height}`), async () => {
      const bytes = await rowsPng(width, height);
      const out = await fit(processor, bytes);
      const sentence = fitSentence(out, LIMITS);
      assert.equal(out.starts.length, out.blocks.length, "one start for each tile");
      assert.deepEqual(out.starts, sentence.match(/tile starts: ([\d, ]+)\)/)[1].split(",").map(Number), "the sentence gives the starts the fit has");
      assert.equal(out.starts[0], 0);
      const [, w, h] = scaled ? sentence.match(/scaled from \d+x\d+ to (\d+)x(\d+)/).map(Number) : [0, width, height];
      assert.deepEqual([out.scaled.width, out.scaled.height], [w, h]);
      const reference = await sharp(bytes).resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
      assert.equal(out.starts.at(-1) + TILE_MAX_EDGE, h, "the last tile starts at the span less the tile length and ends at the edge");
      for (const [i, tile] of out.blocks.entries()) {
        assert.ok(await tileDifference(tile, reference, out.starts[i]) < 25, `tile ${i + 1} was cut from row ${out.starts[i]}`);
        const elsewhere = out.starts[i] + 40 + TILE_MAX_EDGE <= h ? out.starts[i] + 40 : out.starts[i] - 40;
        assert.ok(await tileDifference(tile, reference, elsewhere) > 30, `and not from row ${elsewhere}`);
      }
      if (scaled) assert.match(sentence, /then multiply by/);
    });
  }

  test(at("a very tall image is cut into no more than 8 tiles that still cover all of it"), async () => {
    const out = await fit(processor, await bandedPng(600, 30_000, 4_000));
    assert.equal(out.blocks.length, 8);
    assert.ok(Math.abs(await shadeAt(out.blocks[0], 5, 0)) <= 8);
    assert.ok(Math.abs(await shadeAt(out.blocks.at(-1), 5, out.blocks.at(-1).height - 1) - 28 * 7) <= 8, "the last tile ends at the bottom of the image");
  });

  test(at("a wide image is cut left to right"), async () => {
    const out = await fit(processor, await flat(9000, 900, "#ffffff").png().toBuffer());
    assert.ok(out.blocks.length >= 2 && out.blocks.length <= LIMITS.imagesPerCall);
    for (const tile of out.blocks) assert.deepEqual(await sizeOf(tile), { width: TILE_MAX_EDGE, height: 900 });
    assert.match(fitSentence(out, LIMITS), /left to right/);
  });

  test(at("a phone photo comes back as one block within the limits, and the sentence maps coordinates back"), async () => {
    const out = await fit(processor, await flat(3024, 4032).jpeg().toBuffer(), "image/jpeg");
    assert.equal(out.fit, "resized");
    const [block, ...rest] = out.blocks;
    assert.equal(rest.length, 0);
    assert.deepEqual(await sizeOf(block), { width: 1500, height: 2000 });
    assert.ok(block.data.length <= LIMITS.maxBytes);
    assert.deepEqual(out.original, { width: 3024, height: 4032 });
    const sentence = fitSentence(out, LIMITS);
    assert.match(sentence, /3024x4032/);
    assert.match(sentence, /1500x2000/);
    assert.match(sentence, /2\.016/, "the factor to multiply shown coordinates by");
  });

  test(at("an image is turned upright by its EXIF orientation before it is fitted"), async () => {
    // Stored 3000x1000 and marked to be turned a quarter: it is 1000x3000 upright, so it fits at 667x2000.
    const out = await fit(processor, await flat(3000, 1000, "#aa6633").jpeg().withMetadata({ orientation: 6 }).toBuffer(), "image/jpeg");
    const { width, height } = await sizeOf(out.blocks[0]);
    assert.equal(height, 2000);
    assert.ok(Math.abs(width - 667) <= 1, `${width}x${height}: upright is taller than wide`);
    assert.match(fitSentence(out, LIMITS), /turned upright by its EXIF orientation/);
  });

  // Where each corner of an image stored with each orientation ends up once it is upright: top left, top right, bottom
  // left, bottom right, as the EXIF specification defines the eight orientations (R red, G green, B blue, Y yellow).
  const UPRIGHT = { 1: "RGBY", 2: "GRYB", 3: "YBGR", 4: "BYRG", 5: "RBGY", 6: "BRYG", 7: "YGBR", 8: "GYRB" };
  const COLOUR = { R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], Y: [255, 255, 0] };
  test(at("each of the eight EXIF orientations puts the corners where the specification says, in a JPEG, a lossless WebP and a TIFF"), async () => {
    for (let orientation = 1; orientation <= 8; orientation++) {
      const tall = orientation >= 5;
      for (const [format, bytes, mime] of [
        ["jpeg", await corners(96, 64).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).withMetadata({ orientation }).toBuffer(), "image/jpeg"],
        ["webp", await corners(96, 64).webp({ lossless: true }).withMetadata({ orientation }).toBuffer(), "image/webp"],
        ["tiff", await corners(96, 64).tiff({ compression: "lzw" }).withMetadata({ orientation }).toBuffer(), "image/tiff"],
      ]) {
        // Over the byte limit by the limits given, so that every orientation is decoded rather than passed as it is.
        const out = await fit(processor, bytes, mime, { ...LIMITS, maxWidth: 100, maxHeight: 100 });
        assert.equal(out.fit === "refused" ? out.why : out.fit, orientation === 1 && format !== "tiff" ? "as_is" : "resized", `${format} ${orientation}`);
        const block = out.blocks[0];
        assert.deepEqual([block.width, block.height], tall ? [64, 96] : [96, 64], `${format} ${orientation}: the shown size is the upright one`);
        const [w, h] = [block.width, block.height];
        for (const [corner, [x, y]] of Object.entries({ 0: [4, 4], 1: [w - 5, 4], 2: [4, h - 5], 3: [w - 5, h - 5] })) {
          const got = await pixelAt(block, x, y);
          const want = COLOUR[UPRIGHT[orientation][corner]];
          assert.ok(got.every((c, i) => Math.abs(c - want[i]) <= 24), `${format} orientation ${orientation} corner ${corner}: ${got} is not ${want}`);
        }
      }
    }
  });

  test(at("an image within the limits comes back byte for byte, and nothing is decoded"), async () => {
    const trap = failing("nothing may be decoded");
    for (const bytes of [await flat(800, 600, "#118833").png().toBuffer(), await webp(500, 400, "lossy"), await webp(500, 400, "lossless"), await webp(500, 400, "extended"), await flat(640, 480).jpeg().toBuffer(), await flat(64, 48).gif().toBuffer()]) {
      const out = await fit(trap, bytes, "application/octet-stream");
      assert.equal(out.fit, "as_is");
      assert.equal(out.blocks[0].data, bytes.toString("base64"));
      assert.equal(fitSentence(out, LIMITS), "");
    }
    assert.deepEqual(trap.asked, { raster: 0, probe: 0, encode: 0 });
    const png = await flat(800, 600).png().toBuffer();
    const out = await fit(processor, png);
    assert.deepEqual([out.fit, out.blocks[0].mimeType, out.blocks[0].width, out.blocks[0].height, out.original], ["as_is", "image/png", 800, 600, { width: 800, height: 600 }]);
  });

  test(at("an image within the pixel limits and over the byte limit is re-encoded down until it fits"), async () => {
    const out = await fit(processor, await sharp(randomBytes(1999 * 1999 * 3), { raw: { width: 1999, height: 1999, channels: 3 } }).png().toBuffer());
    assert.equal(out.fit, "resized");
    assert.ok(out.blocks[0].data.length <= LIMITS.maxBytes);
    assert.deepEqual(await sizeOf(out.blocks[0]), { width: 1999, height: 1999 });
    assert.equal(out.blocks[0].mimeType, "image/jpeg", "noise is smaller as a JPEG");
    assert.match(fitSentence(out, LIMITS), /re-encoded to fit 4,718,592 base64 characters; its 1999x1999 pixels are unchanged/);
  });

  test(at("a truncated over-limit image is refused, never sent as the bytes it is"), async () => {
    const whole = await bandedPng(1288, 8319, 1000);
    const out = await fit(processor, whole.subarray(0, Math.floor(whole.length / 2)));
    assert.equal(out.fit, "refused");
    assert.equal(out.code, "unreadable");
    assert.match(out.limit, /8319/);
    assert.equal(out.blocks, undefined, "the refusal carries no block");
    const photo = await sharp(randomBytes(2400 * 1800 * 3), { raw: { width: 2400, height: 1800, channels: 3 } }).jpeg({ quality: 60 }).toBuffer();
    for (const part of [0.2, 0.6, 0.95]) {
      const cut = await fit(processor, photo.subarray(0, Math.floor(photo.length * part)), "image/jpeg");
      assert.deepEqual([cut.fit, cut.code, cut.blocks], ["refused", "unreadable", undefined], `a JPEG cut at ${part}`);
    }
  });

  test(at("an image within the limits whose EXIF orientation turns it is decoded, not passed as it is, and refused when it cannot be"), async () => {
    const turned = await flat(300, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await fit(processor, turned, "image/jpeg");
    assert.deepEqual([out.fit, out.blocks[0].width, out.blocks[0].height, out.original], ["resized", 200, 300, { width: 200, height: 300 }]);
    const refused = await fit(failing(), turned, "image/jpeg");
    assert.equal(refused.fit, "refused");
    assert.match(refused.limit, /must be decoded/);
  });
}

test("a processor that fails refuses an over-limit image with the size, the limit and the reason, and never sends its bytes", async () => {
  const photo = await flat(3024, 4032).jpeg().toBuffer();
  for (const [processor, code, why] of [[failing(), "unreadable", /Cannot find package 'sharp'/], [failing("Photon is not installed", "needs"), "needs", /Photon is not installed/]]) {
    const out = await fit(processor, photo, "image/jpeg");
    assert.equal(out.fit, "refused");
    assert.equal(out.code, code);
    assert.equal(out.blocks, undefined);
    assert.match(out.limit, /4032/, "the measured size");
    assert.match(out.limit, /2,000 px/, "the limit it broke");
    assert.match(out.why, why);
  }
});

test("a header over 100 megapixels is refused without asking the processor, and 100 megapixels exactly is not", async () => {
  const trap = failing("never");
  for (const [w, h] of [[20_000, 20_000], [10_001, 10_000], [4_294_967_295, 4_294_967_295]]) {
    const out = await fit(trap, pngClaiming(w, h));
    assert.equal(out.fit, "refused", `${w}x${h}`);
    assert.equal(out.code, "over_budget");
    assert.match(out.why, /pixels are over the 100,000,000/);
  }
  assert.deepEqual(trap.asked, { raster: 0, probe: 0, encode: 0 });
  const atGuard = await fit(trap, pngClaiming(10_000, 10_000));
  assert.deepEqual([atGuard.fit, atGuard.code, trap.asked.raster], ["refused", "unreadable", 1], "within the guard, so the processor is asked, and it fails");
});

test("an image whose header states no size is refused when the processor cannot read it, even within the byte limit", async () => {
  // A WebP container whose first chunk is of a kind the header parse does not know.
  const odd = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([120, 0, 0, 0]), Buffer.from("WEBPXXXX", "latin1"), Buffer.alloc(100, 1)]);
  for (const processor of [failing(), photonImages(), sharpImages(sharp)]) {
    const out = await fit(processor, odd, "image/webp");
    assert.equal(out.fit, "refused");
    assert.equal(out.blocks, undefined, "the bytes are never passed on their size alone");
  }
});

test("a WebP over the edge limit, whatever its header kind, is refused when the processor fails and tiled when it works", async () => {
  for (const kind of ["lossy", "lossless", "extended"]) {
    const bytes = await webp(9000, 900, kind);
    assert.ok(bytes.length < 100_000, "a small file: only its edges are over a limit");
    const refused = await fit(failing(), bytes, "image/webp");
    assert.equal(refused.fit, "refused", kind);
    assert.match(refused.limit, /9000x900/);
    const out = await fit(sharpImages(sharp), bytes, "image/webp");
    assert.equal(out.fit, "tiled", kind);
    for (const tile of out.blocks) assert.deepEqual(await sizeOf(tile), { width: TILE_MAX_EDGE, height: 900 });
  }
});

test("an image whose format a model does not take is converted, and says so; one the processor cannot decode is a `needs` miss that says who can", async () => {
  const png = await flat(640, 480).png().toBuffer();
  const bitmap = bmp(640, 480);
  const photon = await fit(photonImages(), bitmap, "image/bmp");
  assert.equal(photon.fit, "resized");
  assert.equal(photon.convertedFrom, "image/bmp");
  assert.deepEqual(await sizeOf(photon.blocks[0]), { width: 640, height: 480 });
  assert.match(fitSentence(photon, LIMITS), /converted from image\/bmp to image\/(png|jpeg); its 640x480 pixels are unchanged/);
  const noBmp = await fit(sharpImages(sharp), bitmap, "image/bmp");
  assert.deepEqual([noBmp.fit, noBmp.code], ["refused", "needs"]);
  assert.match(noBmp.why, /does not decode image\/bmp; Photon reads it/);
  assert.match(noBmp.limit, /image\/bmp is not a format a model takes as it is/);
  const avif = await flat(640, 480).avif({ effort: 0 }).toBuffer();
  const viaSharp = await fit(sharpImages(sharp), avif, "image/avif");
  assert.deepEqual([viaSharp.fit, viaSharp.convertedFrom], ["resized", "image/avif"]);
  assert.deepEqual(await sizeOf(viaSharp.blocks[0]), { width: 640, height: 480 });
  const noAvif = await fit(photonImages(), avif, "image/avif");
  assert.deepEqual([noAvif.fit, noAvif.code], ["refused", "needs"]);
  assert.match(noAvif.why, /sharp reads it, and so does ffmpeg/);
  for (const processor of [sharpImages(sharp), photonImages()]) {
    const heic = await fit(processor, ftyp("heic", "mif1", "heic"), "image/heic");
    assert.deepEqual([heic.fit, heic.code], ["refused", "needs"]);
    assert.match(heic.why, /image\/heic/);
    assert.equal(heic.blocks, undefined);
  }
  assert.equal((await fit(sharpImages(sharp), png)).fit, "as_is");
});

test("TIFF is converted by sharp whatever its compression, and by Photon unless it is compressed with JPEG or WebP, which refuse without taking the processor down", async () => {
  const flatTiff = (compression) => flat(320, 240).tiff({ compression }).toBuffer();
  const photon = photonImages();
  for (const compression of ["none", "lzw", "deflate", "packbits", "jpeg", "webp"]) {
    const bytes = await flatTiff(compression);
    const viaSharp = await fit(sharpImages(sharp), bytes, "image/tiff");
    assert.deepEqual([viaSharp.fit, viaSharp.convertedFrom, viaSharp.blocks[0].width], ["resized", "image/tiff", 320], `sharp ${compression}`);
    const viaPhoton = await fit(photon, bytes, "image/tiff");
    if (compression === "jpeg" || compression === "webp") {
      assert.deepEqual([viaPhoton.fit, viaPhoton.code], ["refused", "unreadable"], `photon ${compression}`);
      assert.match(viaPhoton.why, /could not be decoded/);
    } else assert.deepEqual([viaPhoton.fit, viaPhoton.convertedFrom, viaPhoton.blocks[0].width], ["resized", "image/tiff", 320], `photon ${compression}`);
  }
  assert.equal((await fit(photon, await flat(2400, 1800).png().toBuffer())).fit, "resized", "and the next image over the limits is fitted after a failure");
});

test("channels and depths all come out as the pixels they were: grey, grey with alpha, palette, 16 bit, transparent", async () => {
  const gradient = Buffer.alloc(2400 * 100 * 4);
  for (let i = 0; i < 2400 * 100; i++) gradient.set([i % 2400 < 1200 ? 255 : 0, 0, 0, i % 2400 < 1200 ? 255 : 128], i * 4);
  const rgba = await sharp(gradient, { raw: { width: 2400, height: 100, channels: 4 } }).png().toBuffer();
  const files = {
    grey: await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#808080" } }).greyscale().png().toBuffer(),
    greyAlpha: await sharp({ create: { width: 2400, height: 1200, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 0.5 } } }).greyscale().png().toBuffer(),
    palette: await flat(2400, 1200, "#cc3322").png({ palette: true }).toBuffer(),
    sixteen: await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#336699" } }).png({ bitdepth: 16 }).toBuffer(),
    rgba,
  };
  for (const [name, make] of processors) for (const [format, bytes] of Object.entries(files)) {
    const out = await fit(make(), bytes);
    assert.ok(out.fit === "resized" || out.fit === "tiled", `${name} ${format}: ${out.fit} ${out.why ?? ""}`);
    const block = out.blocks[0];
    assert.ok(block.width <= EDGE && block.height <= EDGE, `${name} ${format}`);
    const [r, g, b] = await pixelAt(block, 10, Math.floor(block.height / 2));
    // Half-transparent grey is 128 as a PNG and 191 once flattened onto white for a JPEG, whichever is smaller.
    const want = { grey: [128, 128, 128], greyAlpha: block.mimeType === "image/jpeg" ? [191, 191, 191] : [128, 128, 128], palette: [204, 51, 34], sixteen: [51, 102, 153], rgba: [255, 0, 0] }[format];
    assert.ok([r, g, b].every((c, i) => Math.abs(c - want[i]) <= 6), `${name} ${format}: ${[r, g, b]} is not ${want}`);
  }
});

test("transparency is flattened onto white when an image is encoded as a JPEG, by both processors", async () => {
  const half = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) half.set(i % 64 < 32 ? [200, 0, 0, 255] : [0, 0, 0, 0], i * 4);
  const raster = { width: 64, height: 64, channels: 4, data: half };
  for (const [name, make] of processors) {
    const processor = make();
    const jpeg = await processor.encode(raster, 90);
    const [r, g, b] = await pixelAt({ data: Buffer.from(jpeg).toString("base64") }, 56, 32);
    assert.ok([r, g, b].every((c) => c >= 250), `${name}: transparent became ${[r, g, b]}, not white`);
    assert.equal((await sharp(Buffer.from(jpeg)).metadata()).format, "jpeg");
    assert.equal((await sharp(Buffer.from(await processor.encode(raster))).metadata()).format, "png");
  }
});

test("the layout never exceeds its limits, covers the whole raster and numbers its tiles, for random sizes and limits", () => {
  let seed = 11;
  const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return 1 + (seed % n); };
  let tiled = 0;
  for (let i = 0; i < 4000; i++) {
    const original = { width: next(40_000), height: next(40_000) };
    const limits = { maxWidth: next(4000) + 200, maxHeight: next(4000) + 200, maxBytes: 1, imagesPerCall: next(12) };
    const { scaled, tiles } = imageLayout(original, limits);
    const label = JSON.stringify({ original, limits });
    assert.ok(scaled.width >= 1 && scaled.height >= 1, label);
    assert.ok(scaled.width <= original.width && scaled.height <= original.height, `never scaled up: ${label}`);
    if (!tiles.length) {
      assert.ok(scaled.width <= limits.maxWidth && scaled.height <= limits.maxHeight, `a whole fit is within the limits: ${label}`);
      continue;
    }
    tiled++;
    const vertical = original.height >= original.width;
    assert.ok(tiles.length >= 2 && tiles.length <= limits.imagesPerCall, `${tiles.length} tiles: ${label}`);
    assert.ok(scaled.width <= (vertical ? limits.maxWidth : Infinity) && scaled.height <= (vertical ? Infinity : limits.maxHeight), label);
    const span = vertical ? scaled.height : scaled.width;
    let covered = 0;
    for (const [index, tile] of tiles.entries()) {
      const [start, length] = vertical ? [tile.top, tile.height] : [tile.left, tile.width];
      assert.ok(tile.width <= limits.maxWidth && tile.height <= limits.maxHeight, `a tile is within the limits: ${label}`);
      assert.ok(length <= TILE_MAX_EDGE, label);
      assert.deepEqual(vertical ? [tile.left, tile.width] : [tile.top, tile.height], [0, vertical ? scaled.width : scaled.height], `the full short side: ${label}`);
      assert.ok(start >= 0 && start + length <= span, `inside the raster: ${label}`);
      assert.ok(start <= covered, `no gap before tile ${index}: ${label}`);
      if (index) assert.ok(tiles[index - 1] && (vertical ? tiles[index - 1].top : tiles[index - 1].left) < start, `tiles run in reading order: ${label}`);
      if (index) assert.ok(covered - start >= TILE_OVERLAP, `tile ${index} overlaps the one before by at least ${TILE_OVERLAP}: ${label}`);
      covered = Math.max(covered, start + length);
    }
    assert.equal(covered, span, `the last tile ends at the edge: ${label}`);
    assert.equal(vertical ? tiles[0].top : tiles[0].left, 0);
  }
  assert.ok(tiled > 200, `the property was exercised on ${tiled} tiled layouts`);
});

test("an image is fitted whole when tiling is off, and a route that takes fewer tiles scales the image so they cover it", () => {
  const original = { width: 1288, height: 8319 };
  assert.deepEqual(imageLayout(original, LIMITS, false).tiles, []);
  const [whole] = [imageLayout(original, LIMITS, false).scaled];
  assert.equal(whole.height, EDGE);
  const few = imageLayout(original, { ...LIMITS, imagesPerCall: 3 });
  assert.equal(few.tiles.length, 3);
  assert.ok(few.scaled.height < original.height, "scaled down so three tiles cover it");
  assert.equal(few.tiles.at(-1).top + few.tiles.at(-1).height, few.scaled.height);
  const oneAtATime = imageLayout(original, { ...LIMITS, imagesPerCall: 1 });
  assert.deepEqual(oneAtATime.tiles, [], "one image per call is never tiled");
});

test("a fit that would leave an image under the floor is refused, never sent shrunk past it", async () => {
  const photo = await flat(3000, 2000).jpeg().toBuffer();
  const out = await fit(sharpImages(sharp), photo, "image/jpeg", { ...LIMITS, maxWidth: FLOOR_EDGE - 100, maxHeight: FLOOR_EDGE - 100 });
  assert.deepEqual([out.fit, out.code], ["refused", "over_budget"]);
  assert.match(out.why, new RegExp(`under the ${grouped(FLOOR_EDGE)} px`));
  const small = await flat(FLOOR_EDGE - 200, 300).png().toBuffer();
  assert.equal((await fit(sharpImages(sharp), small, "image/png", { ...LIMITS, maxWidth: FLOOR_EDGE - 100, maxHeight: FLOOR_EDGE - 100 })).fit, "as_is", "an image already smaller than the floor is sent as it is");
});

test("both processors turn an image by the orientation the fit decided on, so a large WebP with EXIF at its end is turned and not stretched", async () => {
  const noisy = await sharp(randomBytes(1400 * 1000 * 3), { raw: { width: 1400, height: 1000, channels: 3 } }).webp({ lossless: true }).withMetadata({ orientation: 6 }).toBuffer();
  for (const [name, make] of processors) {
    const out = await fit(make(), noisy, "image/webp");
    assert.equal(out.fit, "resized", name);
    assert.deepEqual([out.blocks[0].width, out.blocks[0].height, out.original], [1000, 1400, { width: 1000, height: 1400 }], `${name}: upright, not 1400x1000 squeezed`);
  }
});

test("a tile is held to the floor as a whole fit is: refused when the route shrinks it under it, sent when it is a crop of the pixels the image has", async () => {
  const sharpP = sharpImages(sharp);
  const tall = await bandedPng(1000, 10_000, 1000);
  // Tiles the route shrinks to half the floor on their long edge: the layout says what they are.
  const tightLimits = { ...LIMITS, maxHeight: Math.floor(FLOOR_EDGE / 2) };
  const [shrunk] = imageLayout({ width: 1000, height: 10_000 }, tightLimits).tiles;
  assert.ok(shrunk && Math.max(shrunk.width, shrunk.height) < FLOOR_EDGE && shrunk.width < 1000, "the tiles are shrunk and under the floor");
  const tight = await fit(sharpP, tall, "image/png", tightLimits);
  assert.deepEqual([tight.fit, tight.code], ["refused", "over_budget"], "tiles shrunk past reading are refused");
  assert.match(tight.why, new RegExp(`leaves tiles of ${shrunk.width}x${shrunk.height}, under the ${grouped(FLOOR_EDGE)} px`));
  // Tiles under the floor on their long edge that are the image's own pixels: nothing was shrunk.
  const narrowLimits = { ...LIMITS, maxHeight: FLOOR_EDGE - 68 };
  const narrowImage = { width: 300, height: 3000 };
  const layout = imageLayout(narrowImage, narrowLimits);
  assert.ok(layout.tiles.length > 1 && layout.scaled.height === narrowImage.height && layout.tiles[0].height < FLOOR_EDGE, "a tiled layout of unscaled tiles under the floor");
  const narrow = await fit(sharpP, await bandedPng(narrowImage.width, narrowImage.height, 500), "image/png", narrowLimits);
  assert.equal(narrow.fit, "tiled", "tiles that are the image's own pixels are sent, whatever the route's edge");
  assert.deepEqual(await sizeOf(narrow.blocks[0]), { width: layout.tiles[0].width, height: layout.tiles[0].height });
});

test("both processors give the same shapes and the same pictures for the same image, sizes within 1 px", async () => {
  const sharpP = sharpImages(sharp);
  const photonP = photonImages();
  const gradient = Buffer.alloc(3000 * 2000 * 3);
  for (let y = 0; y < 2000; y++) for (let x = 0; x < 3000; x++) gradient.set([x % 256, y % 256, (x + y) % 256], (y * 3000 + x) * 3);
  const files = [
    ["image/jpeg", await sharp(gradient, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()],
    ["image/png", await bandedPng(1288, 5000, 700)],
    ["image/png", await flat(5000, 900, "#223344").png().toBuffer()],
    ["image/jpeg", await flat(2400, 800, "#aa6633").jpeg().withMetadata({ orientation: 8 }).toBuffer()],
    ["image/webp", await webp(3000, 2500, "lossless")],
    ["image/png", await flat(640, 480).png().toBuffer()],
  ];
  for (const [mime, bytes] of files) {
    const [a, b] = [await fit(sharpP, bytes, mime), await fit(photonP, bytes, mime)];
    assert.equal(a.fit, b.fit);
    assert.deepEqual(a.original, b.original);
    assert.equal(a.blocks.length, b.blocks.length);
    assert.deepEqual(a.starts, b.starts);
    for (const [i, block] of a.blocks.entries()) {
      assert.ok(Math.abs(block.width - b.blocks[i].width) <= 1 && Math.abs(block.height - b.blocks[i].height) <= 1, `block ${i}: ${block.width}x${block.height} against ${b.blocks[i].width}x${b.blocks[i].height}`);
      if (a.fit === "as_is") continue;
      const [x, y] = [await sharp(Buffer.from(block.data, "base64")).removeAlpha().raw().toBuffer(), await sharp(Buffer.from(b.blocks[i].data, "base64")).removeAlpha().raw().toBuffer()];
      let sum = 0;
      for (let k = 0; k < Math.min(x.length, y.length); k += 13) sum += Math.abs(x[k] - y[k]);
      assert.ok(sum / (Math.min(x.length, y.length) / 13) < 12, `block ${i} differs by ${(sum / (Math.min(x.length, y.length) / 13)).toFixed(1)} levels on average`);
    }
  }
});

test("pi-durable's own door: `prepare` fits one image or gives none, and a processor with only `prepare` is fitted through it", async () => {
  const photo = await flat(3024, 4032).jpeg().toBuffer();
  const tall = await bandedPng(1288, 8319, 1000);
  for (const [name, make] of processors) {
    const processor = make();
    const out = await processor.prepare(photo, "image/jpeg", { maxWidth: 2000, maxHeight: 2000, maxBytes: LIMITS.maxBytes });
    assert.deepEqual(out.resized, { from: { width: 3024, height: 4032 }, to: { width: 1500, height: 2000 } }, name);
    assert.ok(out.data.length <= LIMITS.maxBytes);
    const whole = await processor.prepare(tall, "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: LIMITS.maxBytes });
    assert.deepEqual(whole.resized.to, { width: 310, height: 2000 }, `${name}: prepare never tiles`);
    assert.equal(await processor.prepare(tall.subarray(0, 4000), "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: LIMITS.maxBytes }), undefined, `${name}: an image it cannot decode is none`);
    const small = await flat(100, 100).png().toBuffer();
    assert.deepEqual(await processor.prepare(small, "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: LIMITS.maxBytes }), { data: small.toString("base64"), mimeType: "image/png" });
  }
  const piStyle = { prepare: async (bytes, mimeType) => (bytes.length > 100_000 ? { data: (await sharp(bytes).resize(500, 400).png().toBuffer()).toString("base64"), mimeType: "image/png", resized: { from: { width: 3024, height: 4032 }, to: { width: 500, height: 400 } } } : undefined) };
  const viaPrepare = await fit(piStyle, await flat(3024, 4032).png().toBuffer());
  assert.deepEqual([viaPrepare.fit, viaPrepare.original, viaPrepare.blocks[0].width, viaPrepare.blocks[0].height], ["resized", { width: 3024, height: 4032 }, 500, 400]);
  const refused = await fit(piStyle, await flat(2400, 1800, "#ffffff").jpeg().toBuffer(), "image/jpeg");
  assert.equal(refused.fit, "refused", "a processor that gives none is a refusal, never the original");
  assert.equal((await fit(piStyle, await flat(800, 600).png().toBuffer())).fit, "as_is");
});
