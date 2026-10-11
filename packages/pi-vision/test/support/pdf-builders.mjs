// PDF fixtures written by hand: invented text, no font file, nothing from a real document. A page's text is set in the
// base-14 Helvetica, a scan is a raw RGB image drawn over the page, and the hostile files are the smallest bytes that
// make a reader work: a page tree under a password, a form that draws itself a hundred times over four levels, a page
// the size of a building.
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const latin1 = (text) => Buffer.from(text, "latin1");
const escape = (text) => text.replace(/[\\()]/g, "\\$&");

/** A stream object body: its dictionary entries (no `Length`) and its data. */
export const streamObject = (dict, data) => Buffer.concat([latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin1("\nendstream")]);

/** A file of the objects given (object `n` is `objects[n - 1]`, a string or bytes), a classic xref table and a trailer
 *  naming object 1 as the root; `trailer` adds entries to it. */
export function pdfFile(objects, { trailer = "", header = "%PDF-1.7\n" } = {}) {
  const parts = [latin1(header)];
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    const bytes = Buffer.concat([latin1(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : latin1(body), latin1("\nendobj\n")]);
    offsets.push(at);
    parts.push(bytes);
    at += bytes.length;
  });
  const table = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(latin1(`${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** `base` with one incremental update appended: the objects given replace or add (`[number, body]`), a new xref section
 *  and trailer follow. Each call adds one saved revision. */
export function appendRevision(base, replacements, size) {
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.toString("latin1"))[1]);
  const parts = [base];
  let at = base.length;
  const entries = [];
  for (const [number, body] of replacements) {
    const bytes = Buffer.concat([latin1(`${number} 0 obj\n`), Buffer.isBuffer(body) ? body : latin1(body), latin1("\nendobj\n")]);
    entries.push([number, at]);
    parts.push(bytes);
    at += bytes.length;
  }
  const rows = entries.map(([n, o]) => `${n} 1\n${String(o).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(latin1(`xref\n${rows}trailer\n<< /Size ${size} /Root 1 0 R /Prev ${prev} >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A page of the document: `lines` of text from the top, a `scan` (an image with no text layer) or `content` (page
 *  description operators), at `size` points
 *  (default Letter), `rotate` degrees, shown through `cropBox` when it has one. */
const pageObjects = (page, number, size, fontId) => {
  const [w, h] = page.size ?? size;
  const content = page.content ?? (page.scan
    ? `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`
    : `BT /F1 12 Tf 14 TL 72 ${h - 72} Td ${page.lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`);
  const resources = page.scan ? `/XObject << /Im0 ${fontId + 1} 0 R >>` : `/Font << /F1 ${fontId} 0 R >>`;
  const rotate = page.rotate ? ` /Rotate ${page.rotate}` : "";
  const crop = page.cropBox ? ` /CropBox [${page.cropBox.join(" ")}]` : "";
  return { page: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]${crop}${rotate} /Resources << ${resources} >> /Contents ${number + 1} 0 R >>`, content: streamObject("", latin1(content)) };
};

/** A document of `pages` (each `{ lines }` or `{ scan: true }`, optionally with `size`, `rotate` and `cropBox`). `info` is
 *  its document information (`{ Producer, Creator }`), `extra` more objects numbered after the pages'. */
export function documentPdf(pages, { size = [612, 792], trailer = "", header, info, extra = [] } = {}) {
  const fontId = 3;
  const image = streamObject(`/Type /XObject /Subtype /Image /Width 24 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(Buffer.from(Array.from({ length: 24 * 32 * 3 }, (_, i) => (i * 7) % 251))));
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", image];
  const kids = [];
  pages.forEach((page, i) => {
    const number = objects.length + 1;
    const made = pageObjects(page, number, size, fontId);
    objects.push(made.page, made.content);
    kids.push(`${number} 0 R`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objects.push(...extra);
  const infoEntry = info ? ` /Info ${objects.push(`<< ${Object.entries(info).map(([key, value]) => `/${key} (${escape(value)})`).join(" ")} >>`)} 0 R` : "";
  return pdfFile(objects, { trailer: `${trailer}${infoEntry}`, header });
}

/** One page of invented text. */
export const textPdf = (lines, options) => documentPdf([{ lines }], options);

/** `count` pages of text, page `scanned` (1-based) replaced by a scan. */
export const mixedPdf = (count, scanned, options) =>
  documentPdf(Array.from({ length: count }, (_, i) => (i + 1 === scanned ? { scan: true } : { lines: [`Section ${i + 1}`, `Ledger entry ${i + 1} reads ZK-${5000 + i}`] })), options);

/** A signature dictionary as an object body: a byte range over the file and a placeholder for the signature. */
export const signatureObject = () => `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <${"00".repeat(32)}> >>`;

const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const rc4 = (key, data) => {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; out[n] = data[n] ^ s[(s[i] + s[j]) & 255]; }
  return out;
};

/** A document whose user password is not empty: the standard security handler, revision 2, 40-bit RC4, so a reader that
 *  cannot ask for the password cannot open it. The page content is left in the clear; no reader gets that far. */
export function encryptedPdf(lines = ["This text is under a password."], password = "open-sesame") {
  const id = createHash("md5").update("fixture").digest();
  const owner = Buffer.alloc(32, 0x4f);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = createHash("md5").update(Buffer.concat([Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32), owner, permissions, id])).digest().subarray(0, 5);
  const user = rc4(key, PAD);
  const hex = (b) => `<${b.toString("hex")}>`;
  return documentPdf([{ lines }], { trailer: `/Encrypt << /Filter /Standard /V 1 /R 2 /O ${hex(owner)} /U ${hex(user)} /P -4 >> /ID [${hex(id)} ${hex(id)}]` });
}

/** A page that draws one small square (or, with `text`, one word) by drawing a form `fanout` times, each of which draws
 *  the next form `fanout` times, `depth` levels down: `fanout ** (depth - 1)` of them, more than any reader finishes. A
 *  reader skips forms that draw no text, so only the `text` file makes a text reader work. */
export function endlessPdf({ depth = 5, fanout = 100, text = false } = {}) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", ""];
  const forms = Array.from({ length: depth }, (_, i) => 5 + i);
  objects.push(streamObject("", latin1(`q /F${depth - 1} Do Q`)));
  objects[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /F${depth - 1} ${forms[depth - 1]} 0 R >> >> /Contents 4 0 R >>`;
  for (let level = 0; level < depth; level++) {
    const body = level === 0 ? (text ? "BT /F1 12 Tf 72 700 Td (bomb) Tj ET" : "0.2 g 100 100 4 4 re f") : `${`/F${level - 1} Do `.repeat(fanout)}`;
    const resources = level === 0 ? (text ? "/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>" : "") : `/Resources << /XObject << /F${level - 1} ${forms[level - 1]} 0 R >> >>`;
    objects.push(streamObject(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] ${resources}`, latin1(body)));
  }
  return pdfFile(objects);
}

/** A one-page document whose page is `points` square: a poster the size of a building at 72 points to the inch. */
export const hugePagePdf = (points = 14400) => documentPdf([{ lines: ["A very large page."], size: [points, points] }]);
