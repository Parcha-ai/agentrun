// The fixture builders, each read back by a reader for its kind: the images by sharp and by the package's own size
// reader, the PDFs by their xref table and page tree, the zip containers entry by entry with each CRC-32 checked, and
// every XML part parsed. A builder that writes a wrong offset, size or part fails here, before any provider reads it.
import assert from "node:assert/strict";
import { crc32, inflateRawSync } from "node:zlib";
import { mock, test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import sharp from "sharp";
import { docxBytes, imageSize, letterPdf, mixedPdf, odtBytes, pdfBytes, photoJpeg, pptxBytes, scanPdf, tallPng, textPdf, widePng, xlsxBytes } from "@parcha/pi-vision/testing";

const sharpFactory = (input, options) => sharp(input, options);

/** The entries of a zip as unzip reads them: the end record, the central directory, each local header, and the bytes
 *  inflated and checked against the directory's CRC-32 and size. */
function readZip(bytes) {
  const b = Buffer.from(bytes);
  let end = b.length - 22;
  while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, "no end record");
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(at), 0x02014b50, "central directory entry");
    const method = b.readUInt16LE(at + 10), crc = b.readUInt32LE(at + 16), size = b.readUInt32LE(at + 24), packed = b.readUInt32LE(at + 20);
    const nameLength = b.readUInt16LE(at + 28), extraLength = b.readUInt16LE(at + 30), commentLength = b.readUInt16LE(at + 32);
    const name = b.toString("utf8", at + 46, at + 46 + nameLength);
    const local = b.readUInt32LE(at + 42);
    assert.equal(b.readUInt32LE(local), 0x04034b50, `local header of ${name}`);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + packed);
    const body = method === 0 ? data : inflateRawSync(data);
    assert.equal(body.length, size, `size of ${name}`);
    assert.equal(crc32(body), crc, `CRC of ${name}`);
    entries.set(name, { method, text: body.toString("utf8") });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const parseXml = (text, what) => {
  const errors = [];
  const doc = new DOMParser({ onError: (level, message) => { if (level !== "warning") errors.push(message); } }).parseFromString(text, "text/xml");
  assert.deepEqual(errors, [], `${what} is well formed`);
  return doc;
};

/** The xref table of a PDF points at every object, and the page tree counts `pages` pages. */
function checkPdf(bytes, pages) {
  const text = Buffer.from(bytes).toString("latin1");
  const xrefAt = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
  const table = /^xref\n0 (\d+)\n0000000000 65535 f \n/.exec(text.slice(xrefAt));
  assert.ok(table, "xref table");
  const count = Number(table[1]);
  const offsets = text.slice(xrefAt + table[0].length, xrefAt + table[0].length + 20 * (count - 1));
  for (let n = 1; n < count; n++) {
    const at = Number(offsets.slice((n - 1) * 20, (n - 1) * 20 + 10));
    assert.equal(text.slice(at, at + `${n} 0 obj\n`.length), `${n} 0 obj\n`, `xref offset of object ${n}`);
  }
  assert.equal(Number(/\/Count (\d+)/.exec(text)[1]), pages, "page count");
  assert.equal([...text.matchAll(/\/Type \/Page[\s/>]/g)].length, pages, "page objects");
  return text;
}

test("every PDF builder writes a file whose xref points at each object and whose page tree counts its pages", async () => {
  checkPdf(letterPdf(), 1);
  checkPdf(await scanPdf(sharpFactory), 1);
  checkPdf(textPdf(200), 200);
  checkPdf(await mixedPdf(sharpFactory, 30, 17), 30);
});

test("a scanned page is one JPEG drawn over the page, at the size the builder reports", async () => {
  const text = checkPdf(await scanPdf(sharpFactory), 1);
  assert.equal([...text.matchAll(/\/DCTDecode/g)].length, 1);
  assert.match(text, /\/Width 1700 \/Height 2200/);
  assert.equal(text.includes("BT /F1"), false, "a scan has no text layer");
});

test("the images are the sizes they say, and the photo is stored with EXIF orientation 6", async () => {
  assert.deepEqual(imageSize(await tallPng(sharpFactory)), { mimeType: "image/png", width: 1288, height: 8319 });
  assert.deepEqual(imageSize(await tallPng(sharpFactory, 64, 200)), { mimeType: "image/png", width: 64, height: 200 });
  assert.deepEqual(imageSize(await widePng(sharpFactory)), { mimeType: "image/png", width: 3840, height: 2160 });
  const photo = await photoJpeg(sharpFactory);
  assert.deepEqual(imageSize(photo), { mimeType: "image/jpeg", width: 3024, height: 4032 });
  const meta = await sharp(photo).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.orientation], ["jpeg", 3024, 4032, 6]);
});

test("every zip-based builder reads back entry by entry, with each CRC-32 right, and every XML part parses", () => {
  for (const [name, bytes] of [["docx", docxBytes()], ["pptx", pptxBytes()], ["xlsx", xlsxBytes()], ["odt", odtBytes()]]) {
    const entries = readZip(bytes);
    assert.ok(entries.size > 0, name);
    for (const [part, { text }] of entries) if (/\.(xml|rels)$/.test(part)) parseXml(text, `${name}:${part}`);
  }
});

test("the OpenDocument file has its mimetype first and stored, as the format requires", () => {
  const entries = readZip(odtBytes());
  const [first] = entries.keys();
  assert.equal(first, "mimetype");
  assert.equal(entries.get("mimetype").method, 0);
  assert.equal(entries.get("mimetype").text, "application/vnd.oasis.opendocument.text");
});

test("the word processor file reads as a title, a numbered list and a table, in that order", () => {
  const doc = parseXml(readZip(docxBytes()).get("word/document.xml").text, "document.xml");
  const body = doc.getElementsByTagName("w:body")[0];
  const blocks = [...body.childNodes].filter((node) => node.nodeType === 1).map((node) => {
    if (node.tagName === "w:tbl") return `table ${node.getElementsByTagName("w:tr").length}x${node.getElementsByTagName("w:tc").length / node.getElementsByTagName("w:tr").length}`;
    return node.getElementsByTagName("w:numPr").length ? "list" : "p";
  });
  assert.deepEqual(blocks, ["p", "list", "list", "list", "list", "p", "table 3x3"]);
});

test("the deck has two slides, in order, and each slide has its own notes", () => {
  const entries = readZip(pptxBytes());
  const presentation = parseXml(entries.get("ppt/presentation.xml").text, "presentation.xml");
  const rels = parseXml(entries.get("ppt/_rels/presentation.xml.rels").text, "presentation rels");
  const target = new Map([...rels.getElementsByTagName("Relationship")].map((rel) => [rel.getAttribute("Id"), rel.getAttribute("Target")]));
  const slides = [...presentation.getElementsByTagName("p:sldId")].map((id) => `ppt/${target.get(id.getAttribute("r:id"))}`);
  assert.equal(slides.length, 2);
  slides.forEach((part, i) => {
    const slideNumber = /slide(\d+)\.xml$/.exec(part)[1];
    assert.equal(slideNumber, String(i + 1), "slide order");
    const slide = parseXml(entries.get(`ppt/slides/slide${slideNumber}.xml`).text, `slide ${slideNumber}`);
    assert.equal(slide.getElementsByTagName("a:buChar").length, 3, `bullets of slide ${slideNumber}`);
    const notes = /notesSlide\d+\.xml/.exec(entries.get(`ppt/slides/_rels/slide${slideNumber}.xml.rels`).text)?.[0];
    assert.ok(notes, `slide ${slideNumber} has a notes slide`);
    const text = parseXml(entries.get(`ppt/notesSlides/${notes}`).text, notes).getElementsByTagName("a:t")[0].textContent;
    assert.ok(text.length > 0, `notes of slide ${slideNumber}`);
  });
});

test("the workbook has a formula with a stored value, one without, and a 16-digit integer kept as digits", () => {
  const sheet = parseXml(readZip(xlsxBytes()).get("xl/worksheets/sheet1.xml").text, "sheet1.xml");
  const cell = (ref) => [...sheet.getElementsByTagName("c")].find((c) => c.getAttribute("r") === ref);
  const stored = (ref) => cell(ref).getElementsByTagName("v")[0]?.textContent;
  assert.equal(cell("C2").getElementsByTagName("f")[0].textContent, "B2*2");
  assert.equal(stored("C2"), "2501");
  assert.equal(cell("D2").getElementsByTagName("f")[0].textContent, "SUM(B$2:B2)");
  assert.equal(stored("D2"), undefined, "no stored value for D2");
  assert.equal(stored("E2"), "9007199254740993");
  assert.equal(stored("E2").length, 16);
  assert.equal(cell("E2").getAttribute("t"), null, "the integer is a number cell, not a string cell");
});

test("the OpenDocument text has a heading, a paragraph and a two-item list", () => {
  const content = parseXml(readZip(odtBytes()).get("content.xml").text, "content.xml");
  assert.equal(content.getElementsByTagName("text:h").length, 1);
  assert.equal(content.getElementsByTagName("text:p").length, 3);
  assert.equal(content.getElementsByTagName("text:list-item").length, 2);
});

/** Every fixture, built now. */
const everyFixture = async () => ({
  "letter.pdf": letterPdf(),
  "scan.pdf": await scanPdf(sharpFactory),
  "text-3p.pdf": textPdf(3),
  "mixed.pdf": await mixedPdf(sharpFactory, 4, 2),
  "tall.png": await tallPng(sharpFactory, 40, 110),
  "wide.png": await widePng(sharpFactory),
  "photo.jpg": await photoJpeg(sharpFactory),
  "proof.docx": docxBytes(),
  "deck.pptx": pptxBytes(),
  "ledger.xlsx": xlsxBytes(),
  "doc.odt": odtBytes(),
});

test("every fixture gives the same bytes when built at two different times", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  try {
    const first = await everyFixture();
    mock.timers.setTime(Date.parse("2027-06-01T12:34:56Z"));
    const second = await everyFixture();
    for (const [name, bytes] of Object.entries(first)) assert.deepEqual(second[name], bytes, name);
  } finally {
    mock.timers.reset();
  }
});

test("the PDF writer refuses text it cannot write in Helvetica", () => {
  assert.throws(() => pdfBytes([{ lines: ["café"] }]), RangeError);
});
