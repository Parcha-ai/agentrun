// What a source is, from its bytes first and its name second, and the sizes its header states: every format is built
// by the test, sizes are checked against sharp's own reading of the same bytes, and hostile input (a renamed file, a
// header cut short, random bytes behind each signature) is a typed answer, never a throw.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";
import { DECODE_GUARD_PIXELS, DEFAULT_LIMITS, exceedsDecodeGuard, imageHeader, KINDS, readMedia, readsAsText, SNIFF_BYTES, sniffKind } from "@parcha/pi-vision";
import { fixtureDir } from "@parcha/pi-vision/testing";
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

test("the other kinds are told by their bytes: documents, containers, video, audio, text, binary and nothing", async () => {
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
    [Buffer.concat([text("ID3\x04\0\0"), Buffer.alloc(16)]), "a.mp3", "audio", "mp3"], [Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]), "a.mp3", "audio", "mp3"],
    [Buffer.concat([text("RIFF"), Buffer.alloc(4), text("WAVEfmt ")]), "a.wav", "audio", "wav"], [Buffer.concat([text("OggS"), Buffer.alloc(24)]), "a.ogg", "audio", "ogg"],
    [Buffer.concat([text("fLaC"), Buffer.alloc(8)]), "a.flac", "audio", "flac"], [ftyp("M4A ", "M4A ", "isom"), "a.m4a", "audio", "m4a"],
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
  assert.deepEqual(KINDS.filter((k) => !["recording"].includes(k)).sort(), ["audio", "image", "office", "pdf", "sheet", "text", "unknown", "video"], "every kind but a handle is reachable from bytes");
});

const BODY = "Total due: 31,50 € — résumé\r\nsecond line\n";
const utf32 = (little) => Buffer.concat([Buffer.from(little ? [0xff, 0xfe, 0, 0] : [0, 0, 0xfe, 0xff]), ...Array.from(BODY, (char) => { const unit = Buffer.alloc(4); if (little) unit.writeUInt32LE(char.codePointAt(0)); else unit.writeUInt32BE(char.codePointAt(0)); return unit; })]);
const withMark = {
  "UTF-16 LE": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BODY, "utf16le")]),
  "UTF-16 BE": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(BODY, "utf16le").swap16()]),
  "UTF-32 LE": utf32(true),
  "UTF-32 BE": utf32(false),
};

test("UTF-16 and UTF-32 text with a byte order mark is text, though it is full of NUL bytes; UTF-8 with its mark is text too", () => {
  for (const [encoding, bytes] of Object.entries(withMark)) {
    assert.ok(bytes.includes(0), `${encoding} holds NUL bytes`);
    for (const name of ["notes.txt", "export.csv", "README", "a.md"]) {
      const sniffed = sniffKind(bytes, name);
      assert.ok(sniffed.ok, `${encoding} as ${name}: ${JSON.stringify(sniffed)}`);
      assert.deepEqual([sniffed.kind, sniffed.format], ["text", "text"], `${encoding} as ${name}`);
    }
  }
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BODY, "utf8")]);
  assert.deepEqual(kindOf(utf8, "notes.txt"), "text");
  for (const [bytes, label] of [[[0xff, 0xfe], "UTF-16 LE, the mark alone"], [[0xfe, 0xff], "UTF-16 BE, the mark alone"], [[0xff, 0xfe, 0, 0], "UTF-32 LE, the mark alone"], [[0, 0, 0xfe, 0xff], "UTF-32 BE, the mark alone"], [[0xff, 0xfe, 0], "UTF-16 LE cut in the middle of what could be UTF-32's"]]) {
    assert.equal(kindOf(Buffer.from(bytes), "empty.txt"), "text", label);
  }
});

test("a file with a NUL in its first 8 KiB and no byte order mark stays binary: nothing is guessed, and a mark must be at offset 0", async () => {
  const sqlite = Buffer.concat([text("SQLite format 3\0"), Buffer.alloc(100)]);
  const noise = Buffer.from(Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? 0 : (i * 37 + 11) % 251 + 1)));
  const cases = {
    "a zip": [zipSync({ "a.txt": strToU8("x") }), "zip"],
    "an sqlite header": [sqlite, "binary"],
    "bytes with NULs": [noise, "binary"],
    "UTF-16 LE text with no mark": [Buffer.from(BODY, "utf16le"), "binary"],
    "UTF-16 BE text with no mark": [Buffer.from(BODY, "utf16le").swap16(), "binary"],
    "UTF-32 LE text with no mark": [utf32(true).subarray(4), "binary"],
    "a mark after the first byte": [Buffer.concat([text("x"), withMark["UTF-16 LE"]]), "binary"],
    "a UTF-32 BE mark cut short": [Buffer.concat([Buffer.from([0, 0, 0xfe]), Buffer.alloc(20)]), "binary"],
    "a mark that is half UTF-16's and half not": [Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from(BODY, "utf16le")]), "binary"],
  };
  for (const [what, [bytes, format]] of Object.entries(cases)) {
    const sniffed = sniffKind(bytes, "data");
    assert.ok(sniffed.ok, what);
    assert.deepEqual([sniffed.kind, sniffed.format], ["unknown", format], what);
  }
  const unnamed = sniffKind(withMark["UTF-16 LE"], "photo.png");
  assert.equal(unnamed.ok, false, "text under a name that claims another kind is the mismatch it always was");
  assert.match(unnamed.reason, /but its bytes are text/);
});

test("read leaves a file with a byte order mark to the host's text read, and still refuses one without a mark", async (t) => {
  const dir = await fixtureDir("pi-vision-bom-");
  t.after(() => dir.remove());
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const setup = { scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, limits: DEFAULT_LIMITS, providers: [], sources: {}, evidence: { file: async () => null } };
  const call = { conversationId: "c1", callId: "t1", model: undefined, signal: undefined };
  for (const [encoding, bytes] of Object.entries(withMark)) {
    const name = `${encoding.replace(" ", "-").toLowerCase()}.txt`;
    await dir.file(name, bytes);
    assert.equal(await readMedia(env, { path: name }, call, setup), null, `${encoding}: the media half has nothing to say`);
    assert.equal(await readsAsText(env, { path: name }, call, setup), true, encoding);
  }
  await dir.file("no-mark.txt", Buffer.from(BODY, "utf16le"));
  assert.equal(await readsAsText(env, { path: "no-mark.txt" }, call, setup), false, "a file with NULs and no mark is not the host's text");
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

const OFFICE = ["docx", "pptx", "odt", "odp"];
const SHEET = ["xlsx", "xlsm", "ods"];
const zipBytes = () => zipSync({ "word/document.xml": strToU8("<w/>") });

test("a name taken from a link keeps its extension: a query or a fragment after it is cut off, in every container kind", () => {
  const zip = zipBytes();
  const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
  const tails = ["?sig=abc123&exp=99", "#tab", "#page=2", "?x=1#y", "?", "#", "?v=1.2", "?v=1.2#frag.x", "?file=a.b", "#a.b?c", "?a=b.zzz#c"];
  for (const [extensions, expected] of [[OFFICE, "office"], [SHEET, "sheet"]]) {
    for (const extension of extensions) for (const tail of tails) for (const dir of ["", "reports/", "week#1/", "who?/"]) {
      const name = `${dir}report.${extension}${tail}`;
      const sniffed = sniffKind(zip, name);
      assert.ok(sniffed.ok, `${name}: ${JSON.stringify(sniffed)}`);
      assert.deepEqual([sniffed.kind, sniffed.format], [expected, "zip"], name);
    }
  }
  assert.equal(kindOf(ole2, "legacy.doc?sig=a"), "office");
  assert.equal(kindOf(ole2, "legacy.xls#tab"), "sheet");
  assert.equal(kindOf(ole2, "LEGACY.XLS?Sig=A"), "sheet", "and the extension's case does not matter");
});

test("a name with a # or a ? before its extension keeps the extension, in every container kind and in upper case", () => {
  const zip = zipBytes();
  const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
  const stems = ["Invoice #123", "Q3 #2", "what? now", "a#b?c", "#1", "?", "x ?1 #2", "2026-10 #3 (final)"];
  const tails = ["", "?sig=abc", "#tab", "?v=1.2"];
  for (const [extensions, expected] of [[OFFICE, "office"], [SHEET, "sheet"]]) {
    for (const extension of extensions) for (const stem of stems) for (const tail of tails) for (const ext of [extension, extension.toUpperCase()]) {
      const name = `${stem}.${ext}${tail}`;
      const sniffed = sniffKind(zip, name);
      assert.ok(sniffed.ok, `${name}: ${JSON.stringify(sniffed)}`);
      assert.deepEqual([sniffed.kind, sniffed.format], [expected, "zip"], name);
    }
  }
  for (const [bytes, name, expected] of [[ole2, "Invoice #12.doc", "office"], [ole2, "Q3 #2.XLS", "sheet"], [ole2, "Q3 #2.xls?sig=a", "sheet"], [ole2, "Invoice #12.DOC#p3", "office"]]) assert.equal(kindOf(bytes, name), expected, name);
  assert.equal(kindOf(zip, "dir#1/Invoice #12.docx"), "office");
  assert.equal(kindOf(zip, "dir?/Q3 #2.xlsx"), "sheet");
});

test("a name that ends in an extension has it, wherever the dots before it are; a name that ends in none and has no extension before its query has no hint", () => {
  const zip = zipBytes();
  assert.equal(kindOf(zip, "download?file=a.docx"), "office", "the name ends in .docx");
  assert.equal(kindOf(zip, "download#a.xlsx"), "sheet");
  assert.equal(kindOf(zip, "get?name=report.pptx"), "office");
  for (const name of ["download?v=1.2", "download#a.b", "get?name=report&x=1.2", "dir.docx/download?v=1.2", "dir.xlsx/file#a.b", "?a.b", "#a.b", "download", "docx", ".", "report."]) {
    const sniffed = sniffKind(zip, name);
    assert.ok(sniffed.ok, name);
    assert.deepEqual([sniffed.kind, sniffed.format], ["unknown", "zip"], `${name} is a zip and nothing more`);
  }
  for (const name of ["notes?v=1.2", "notes#1", "Invoice #123.txt", "a?b.csv#c"]) assert.equal(kindOf(text("plain notes\n"), name), "text", name);
});

test("a mismatch names the file without a query or fragment that follows its extension, which can carry a signature, and a name without one whole", () => {
  const png = built.png;
  const reason = (name) => { const sniffed = sniffKind(png, name); assert.equal(sniffed.ok, false, name); assert.equal(sniffed.code, "unsupported"); return sniffed.reason; };
  const tail = " extension but its bytes are a PNG image (first bytes 89 50 4e 47 0d 0a 1a 0a)";
  assert.equal(reason("reports/chart.pdf?sig=SECRETSIGNATURE&exp=99#frag"), `chart.pdf has a .pdf${tail}`);
  assert.equal(reason("chart.pdf?v=1.2&sig=SECRETSIGNATURE"), `chart.pdf has a .pdf${tail}`, "cut where the extension ends, whatever dots the query has");
  assert.equal(reason("Q3 #2.docx?sig=SECRETSIGNATURE"), `Q3 #2.docx has a .docx${tail}`, "a # in the name stays");
  assert.equal(reason("Invoice #123.pdf"), `Invoice #123.pdf has a .pdf${tail}`);
  assert.equal(reason("chart.pdf"), `chart.pdf has a .pdf${tail}`, "and a plain name reads as it always did");
  assert.equal(kindOf(zipBytes(), "report.docx"), "office", "plain names are unchanged");
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
