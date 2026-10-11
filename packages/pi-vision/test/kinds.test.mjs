// What a source is, from its bytes first and its name second, and the sizes its header states: every format is built
// by the test, sizes are checked against sharp's own reading of the same bytes, and hostile input (a renamed file, a
// header cut short, random bytes behind each signature) is a typed answer, never a throw.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";
import { DECODE_GUARD_PIXELS, exceedsDecodeGuard, imageHeader, KINDS, SNIFF_BYTES, sniffKind } from "@parcha/pi-vision";
import { bmp, corners, flat, ftyp, pngClaiming, webp } from "./support/images.mjs";

const text = (s) => new TextEncoder().encode(s);
const kindOf = (bytes, name) => { const s = sniffKind(bytes, name); assert.ok(s.ok, JSON.stringify(s)); return s.kind; };

const built = {
  png: await flat(64, 48).png().toBuffer(),
  jpeg: await flat(64, 48).jpeg().toBuffer(),
  gif: await flat(64, 48).gif().toBuffer(),
  webp: await webp(64, 48),
  bmp: bmp(64, 48),
  tiff: await flat(64, 48).tiff().toBuffer(),
  avif: await flat(64, 48).avif({ effort: 0 }).toBuffer(),
};

test("every image format is an image by its bytes, whatever its file is called", () => {
  for (const [format, bytes] of Object.entries(built)) {
    for (const name of [`a.${format}`, "a", "a.dat", "README"]) {
      const sniffed = sniffKind(bytes, name);
      assert.ok(sniffed.ok, `${format} as ${name}: ${JSON.stringify(sniffed)}`);
      assert.equal(sniffed.kind, "image");
      assert.equal(sniffed.format, format);
      assert.equal(sniffed.mimeType, `image/${format === "jpeg" ? "jpeg" : format}`);
    }
  }
  assert.equal(sniffKind(built.png, "photo.jpg").ok, true, "a PNG called .jpg is an image: the same kind, and the bytes say which");
  assert.equal(sniffKind(built.png, "photo.jpg").format, "png");
});

test("the other kinds are told by their bytes: documents, containers, video, text, binary and nothing", async () => {
  const zip = zipSync({ "word/document.xml": strToU8("<w/>") });
  const cases = [
    [text("%PDF-1.7\n1 0 obj"), "a.pdf", "pdf", "pdf"],
    [Buffer.concat([text("junk before the header\n"), text("%PDF-1.4\n")]), "a.pdf", "pdf", "pdf"],
    [text("{\\rtf1\\ansi hello}"), "a.rtf", "office", "rtf"],
    [zip, "a.docx", "office", "zip"], [zip, "a.pptx", "office", "zip"], [zip, "a.odt", "office", "zip"], [zip, "a.odp", "office", "zip"],
    [zip, "a.xlsx", "sheet", "zip"], [zip, "a.xlsm", "sheet", "zip"], [zip, "a.ods", "sheet", "zip"],
    [zip, "a.zip", "unknown", "zip"], [zip, "a", "unknown", "zip"],
    [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]), "a.doc", "office", "ole2"],
    [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]), "a.xls", "sheet", "ole2"],
    [ftyp("isom", "iso2", "mp41"), "a.mp4", "video", "mp4"], [ftyp("qt  ", "qt  "), "a.mov", "video", "mov"],
    [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4), text("\x42\x82\x84webm")]), "a.webm", "video", "webm"],
    [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4), text("\x42\x82\x88matroska")]), "a.mkv", "video", "mkv"],
    [ftyp("heic", "mif1", "heic"), "a.heic", "image", "heic"], [ftyp("mif1", "mif1", "avif"), "a.avif", "image", "avif"], [ftyp("avis", "avif"), "a.avif", "image", "avif"],
    [text("plain notes\nsecond line\n"), "notes.txt", "text", "text"], [text("a,b\n1,2\n"), "a.csv", "text", "text"], [text("BMW notes"), "notes", "text", "text"],
    [new Uint8Array(0), "empty", "text", "empty"],
    [Buffer.concat([Buffer.from("\0\0\0\0"), randomBytes(64)]), "blob", "unknown", "binary"],
  ];
  for (const [bytes, name, kind, format] of cases) {
    const sniffed = sniffKind(bytes, name);
    assert.ok(sniffed.ok, `${name}: ${JSON.stringify(sniffed)}`);
    assert.deepEqual([sniffed.kind, sniffed.format], [kind, format], name);
  }
  assert.deepEqual(KINDS.filter((k) => !["recording"].includes(k)).sort(), ["image", "office", "pdf", "sheet", "text", "unknown", "video"], "every kind but a handle is reachable from bytes");
});

test("a name that claims one kind over the bytes of another is an unsupported miss that names both and the first bytes", () => {
  const png = built.png;
  for (const [bytes, name, bytesAre] of [
    [png, "report.pdf", "a PNG image"],
    [text("%PDF-1.7 but really notes"), "scan.png", "a PDF document"],
    [text("just words"), "photo.png", "text"],
    [new Uint8Array(0), "photo.png", "an empty file"],
    [zipSync({ "a.txt": strToU8("x") }), "photo.png", "a zip archive"],
    [png, "clip.mp4", "a PNG image"],
    [png, "sheet.xlsx", "a PNG image"],
    [Buffer.from([0, 255, 16, 128, 0, 77, 1, 2, 3]), "doc.docx", "binary data"],
  ]) {
    const sniffed = sniffKind(bytes, `dir/sub/${name}`);
    assert.equal(sniffed.ok, false, name);
    assert.equal(sniffed.code, "unsupported");
    assert.ok(sniffed.reason.startsWith(`${name} has a .${name.split(".")[1]} extension`), sniffed.reason);
    assert.ok(sniffed.reason.includes(bytesAre), `${name}: ${sniffed.reason}`);
    assert.ok(sniffed.reason.includes("first bytes"), sniffed.reason);
  }
  const named = sniffKind(png, "x.png");
  assert.ok(named.ok && named.signature === "89 50 4e 47 0d 0a 1a 0a", "the signature is the first eight bytes in hex");
});

test("an extension that names a property of Object is not a kind", () => {
  assert.equal(sniffKind(text("hello"), "x.constructor").ok, true);
  assert.equal(sniffKind(text("hello"), "x.__proto__").ok, true);
  assert.equal(kindOf(text("hello"), "x.toString"), "text");
});

const stated = async (bytes) => { const m = await sharp(bytes).metadata(); return { width: m.width, height: m.height, orientation: m.orientation ?? 1 }; };

test("the header states what sharp reads from the same bytes: size and EXIF orientation, for each format", async () => {
  const sizes = [[1, 1], [37, 11], [640, 480], [3024, 4032], [9000, 900]];
  for (const [width, height] of sizes) {
    const files = {
      "image/png": await flat(width, height).png().toBuffer(),
      "image/jpeg": await flat(width, height).jpeg().toBuffer(),
      "image/gif": await flat(Math.min(width, 4000), Math.min(height, 4000)).gif().toBuffer(),
      "image/webp": width <= 16383 && height <= 16383 ? await webp(width, height) : null,
      "image/tiff": await flat(width, height).tiff({ compression: "lzw" }).toBuffer(),
    };
    for (const [mimeType, bytes] of Object.entries(files)) {
      if (!bytes) continue;
      const want = await stated(bytes);
      assert.deepEqual(imageHeader(bytes), { mimeType, ...want }, `${mimeType} ${width}x${height}`);
    }
  }
  for (const kind of ["lossy", "lossless", "extended"]) {
    const bytes = await webp(500, 400, kind);
    assert.deepEqual(imageHeader(bytes), { mimeType: "image/webp", width: 500, height: 400, orientation: 1 }, kind);
  }
  const bottomUp = imageHeader(bmp(300, 200));
  const topDown = imageHeader(bmp(300, 200, { topDown: true }));
  assert.deepEqual(bottomUp, { mimeType: "image/bmp", width: 300, height: 200, orientation: 1 });
  assert.deepEqual(topDown, bottomUp, "a top-down BMP states a negative height: the size is the same");
});

test("the EXIF orientation of a JPEG, a WebP and a TIFF is read from the header, 1 to 8, and 1 when there is none", async () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    const jpeg = await corners(64, 32).jpeg().withMetadata({ orientation }).toBuffer();
    assert.equal(imageHeader(jpeg).orientation, orientation, `jpeg ${orientation}`);
    const tiff = await corners(64, 32).tiff({ compression: "lzw" }).withMetadata({ orientation }).toBuffer();
    assert.equal(imageHeader(tiff).orientation, (await stated(tiff)).orientation, `tiff ${orientation}`);
  }
  for (const orientation of [3, 6, 8]) {
    const lossless = await corners(64, 32).webp({ lossless: true }).withMetadata({ orientation }).toBuffer();
    assert.equal(imageHeader(lossless).orientation, orientation, `webp ${orientation}`);
  }
  assert.equal(imageHeader(await corners(64, 32).jpeg().toBuffer()).orientation, 1);
  assert.equal(imageHeader(built.png).orientation, 1);
});

test("a header cut short, claiming no size, or in another format states nothing, and nothing throws", async () => {
  const whole = { png: built.png, jpeg: await flat(3024, 4032).jpeg().withMetadata({ orientation: 6 }).toBuffer(), webp: await webp(500, 400, "extended"), gif: built.gif, tiff: built.tiff, bmp: built.bmp };
  for (const [format, bytes] of Object.entries(whole)) {
    assert.ok(imageHeader(bytes), format);
    for (let cut = 0; cut < Math.min(bytes.length, 64); cut++) assert.doesNotThrow(() => imageHeader(bytes.subarray(0, cut)), `${format} cut at ${cut}`);
    assert.equal(imageHeader(bytes.subarray(0, 8)), null, `${format} cut at 8 bytes`);
  }
  const odd = Buffer.concat([text("RIFF"), Buffer.from([120, 0, 0, 0]), text("WEBPXXXX"), Buffer.alloc(100, 1)]);
  const zeroWidth = pngClaiming(0, 10);
  for (const bytes of [new Uint8Array(0), text("%PDF-1.7"), odd, zeroWidth, built.avif, ftyp("heic", "mif1")]) assert.equal(imageHeader(bytes), null);
});

test("a header cut anywhere states the size it has or nothing: never a size the bytes do not hold", async () => {
  const files = {
    png: built.png,
    jpeg: await flat(3024, 4032).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "x".repeat(20_000) } } }).toBuffer(),
    lossy: await webp(500, 400, "lossy"), lossless: await webp(500, 400, "lossless"), extended: await webp(500, 400, "extended"),
    exifWebp: await flat(500, 400).webp({ lossless: true }).withMetadata({ orientation: 8 }).toBuffer(),
    gif: built.gif, tiff: await flat(500, 400).tiff({ compression: "lzw" }).toBuffer(), bmp: bmp(500, 400), topDown: bmp(500, 400, { topDown: true }),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const whole = imageHeader(bytes);
    assert.ok(whole, name);
    for (let cut = 0; cut <= Math.min(bytes.length, 400); cut++) {
      const part = imageHeader(bytes.subarray(0, cut));
      assert.ok(part === null || (part.width === whole.width && part.height === whole.height && part.mimeType === whole.mimeType), `${name} cut at ${cut} states ${JSON.stringify(part)}`);
    }
  }
  const tiny = Buffer.concat([text("RIFF"), Buffer.from([20, 0, 0, 0]), text("WEBPVP8X")]);
  assert.equal(imageHeader(tiny), null, "an extended WebP cut before its canvas fields is not 1x1");
});

test("an extended WebP's EXIF chunk is found after its image data, by chunks, and a file of endless tiny chunks is not walked to its end", async () => {
  const noisy = await sharp(randomBytes(1400 * 1000 * 3), { raw: { width: 1400, height: 1000, channels: 3 } }).webp({ lossless: true }).withMetadata({ orientation: 6 }).toBuffer();
  assert.ok(noisy.length > SNIFF_BYTES * 3, "the EXIF chunk lies far past the first megabyte");
  assert.deepEqual(imageHeader(noisy), { mimeType: "image/webp", width: 1400, height: 1000, orientation: 6 });
  const chunk = (id, length) => { const head = Buffer.alloc(8 + length); head.write(id, 0, "latin1"); head.writeUInt32LE(length, 4); return head; };
  const canvas = chunk("VP8X", 10);
  canvas.set([0, 0, 0, 0, 99, 0, 0, 49, 0, 0], 8);
  const endless = Buffer.concat([text("RIFF"), Buffer.alloc(4), text("WEBP"), canvas, ...Array(400_000).fill(chunk("JUNK", 0)), chunk("EXIF", 14)]);
  const started = performance.now();
  assert.deepEqual(imageHeader(endless), { mimeType: "image/webp", width: 100, height: 50, orientation: 1 });
  assert.ok(performance.now() - started < 100, "the walk stops after a handful of chunks");
});

test("a header is read from the first megabyte only: a size that comes later is not found, and a larger file costs no more to scan", () => {
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(65_533)]);
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, 0x0f, 0xa0, 0x0b, 0xb8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const early = Buffer.concat([Buffer.from([0xff, 0xd8]), segment, frame]);
  assert.deepEqual(imageHeader(early), { mimeType: "image/jpeg", width: 3000, height: 4000, orientation: 1 });
  const late = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array(24).fill(segment), frame]);
  assert.ok(late.length > SNIFF_BYTES);
  assert.equal(imageHeader(late), null, "the frame header sits past the first megabyte");
  const junk = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64 * 1024 * 1024, 0x41)]);
  const started = performance.now();
  assert.equal(imageHeader(junk), null);
  assert.ok(performance.now() - started < 250, "64 MiB of bytes that are no segments is not walked");
});

test("no header read throws, whatever bytes follow a signature", () => {
  const signatures = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), text("GIF89a"), Buffer.from([0xff, 0xd8, 0xff, 0xe1]), text("RIFF\0\0\0\0WEBPVP8X"), text("BM"), text("II*\0"), text("MM\0*"), text("RIFF\0\0\0\0WEBPVP8 ")];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (const signature of signatures) {
    for (let i = 0; i < 300; i++) {
      const tail = Buffer.alloc(next() % 200);
      for (let j = 0; j < tail.length; j++) tail[j] = next() & 0xff;
      const bytes = Buffer.concat([signature, tail]);
      assert.doesNotThrow(() => imageHeader(bytes), bytes.toString("hex"));
      assert.doesNotThrow(() => sniffKind(bytes, "x.png"), bytes.toString("hex"));
    }
  }
});

test("a JPEG whose EXIF block is large still states its size from the first megabyte, and a TIFF that is big-endian too", async () => {
  const big = await flat(640, 480).jpeg().withMetadata({ exif: { IFD0: { Copyright: "x".repeat(60_000) } }, orientation: 3 }).toBuffer();
  assert.ok(big.length > 60_000);
  assert.deepEqual(imageHeader(big.subarray(0, SNIFF_BYTES)), { mimeType: "image/jpeg", width: 640, height: 480, orientation: 3 });
  const be = Buffer.alloc(8 + 2 + 3 * 12 + 4);
  be.write("MM\0*", 0, "latin1");
  be.writeUInt32BE(8, 4);
  be.writeUInt16BE(3, 8);
  [[256, 3, 123], [257, 4, 45678], [274, 3, 6]].forEach(([tag, type, value], i) => {
    be.writeUInt16BE(tag, 10 + i * 12); be.writeUInt16BE(type, 12 + i * 12); be.writeUInt32BE(1, 14 + i * 12);
    if (type === 3) be.writeUInt16BE(value, 18 + i * 12); else be.writeUInt32BE(value, 18 + i * 12);
  });
  assert.deepEqual(imageHeader(be), { mimeType: "image/tiff", width: 123, height: 45678, orientation: 6 });
});

test("the decode guard is over 100 megapixels, by the header, before any decoder", () => {
  const side = Math.sqrt(DECODE_GUARD_PIXELS);
  assert.equal(exceedsDecodeGuard({ width: side, height: side }), false, "exactly 100 megapixels is allowed");
  assert.equal(exceedsDecodeGuard({ width: side + 1, height: side }), true);
  assert.equal(exceedsDecodeGuard(imageHeader(pngClaiming(20_000, 20_000))), true);
  assert.equal(exceedsDecodeGuard(imageHeader(pngClaiming(4_294_967_295, 4_294_967_295))), true, "32-bit sides do not overflow the product");
  assert.equal(exceedsDecodeGuard(imageHeader(built.jpeg)), false);
});
