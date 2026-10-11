// Fixture builders: the synthetic documents, images and spreadsheets a test or the bench writes for itself. Every word
// is invented (EXAMPLE WIDGETS LLC, 00-0000000, 100 SAMPLE STREET) and every number comes from an index, so a build gives
// the same bytes each time. PDFs and the zip containers are written here by hand. The image builders need a JPEG
// encoder and text drawn into an image, so they take the host's sharp module and never import it: this file's only
// dependency is fflate.

import { strToU8, type ZipOptions, zipSync } from "fflate";

/** The parts of sharp's default export the image builders call. */
export type SharpPipeline = {
  jpeg(options: { readonly quality: number }): SharpPipeline;
  png(): SharpPipeline;
  withMetadata(options: { readonly orientation: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
};
export type SharpFactory = (input: Uint8Array, options?: { readonly raw: { readonly width: number; readonly height: number; readonly channels: 3 } }) => SharpPipeline;

/** A page drawn as one JPEG over the whole Letter page. */
export type PdfImagePage = { readonly jpeg: Uint8Array; readonly width: number; readonly height: number };
/** One PDF page: text lines in Helvetica, or an image. */
export type PdfPage = { readonly lines: readonly string[] } | PdfImagePage;

const PAGE_POINTS = { width: 612, height: 792 };
const LINE_POINTS = 18;
/** A Letter page at 200 dpi: the size of a flatbed scan. */
const SCAN_PIXELS = { width: 1700, height: 2200 };

const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xmlDocument = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const xml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LETTER = [
  "EXAMPLE TAX AUTHORITY", "ANYTOWN ZZ 00000", "", "Date of this notice: 03-14-2025", "Employer Identification Number: 00-0000000",
  "Form: EX-1", "Notice number: EX 000 A", "", "EXAMPLE WIDGETS LLC", "100 SAMPLE STREET SUITE 4", "SPRINGFIELD, ZZ 00000", "",
  "THIS LETTER CONFIRMS YOUR EMPLOYER IDENTIFICATION NUMBER", "",
  "Thank you for applying for an Employer Identification Number (EIN). We assigned you",
  "EIN 00-0000000. This EIN will identify you, your business accounts, tax returns, and",
  "documents, even if you have no employees. Please keep this notice in your permanent records.", "",
  "This is a synthetic test document. It is not a real notice.",
];

/** Section `section` of the invented incorporation text: a heading and 33 numbered clauses. */
const sectionLines = (section: number) => [
  `Section ${section}. Article ${section} of the synthetic incorporation document.`,
  ...Array.from({ length: 33 }, (_, i) => `${section}.${i + 1} The corporation named EXAMPLE WIDGETS LLC shall keep record number ${10000 + ((section * 7919 + (i + 1) * 104729) % 90000)} on file.`),
];

const literal = (text: string) => {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new RangeError(`fixture text is ASCII only: ${text}`);
  return `(${text.replace(/[\\()]/g, "\\$&")})`;
};

const stream = (entries: string, data: Uint8Array | string) => {
  const body = typeof data === "string" ? Buffer.from(data, "latin1") : Buffer.from(data);
  return Buffer.concat([Buffer.from(`<< ${entries}/Length ${body.length} >>\nstream\n`, "latin1"), body, Buffer.from("\nendstream", "latin1")]);
};

/** A PDF 1.4 file of US Letter pages. Object 1 is the catalog, 2 the page tree, 3 Helvetica; each page takes one object
 *  for the page, one for its content and, for an image, one more. Every xref offset is measured from the bytes written. */
export function pdfBytes(pages: readonly PdfPage[]): Uint8Array {
  const { width, height } = PAGE_POINTS;
  const objects: (string | Buffer)[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  const kids: number[] = [];
  for (const page of pages) {
    const pageId = objects.push("");
    const content = "lines" in page
      ? page.lines.map((line, i) => `BT /F1 10.5 Tf 1 0 0 1 72 ${height - 72 - i * LINE_POINTS} Tm ${literal(line)} Tj ET`).join("\n")
      : `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`;
    const contentId = objects.push(stream("", content));
    const image = "jpeg" in page ? `/XObject << /Im1 ${objects.push(stream(`/Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode `, page.jpeg))} 0 R >>` : "";
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> ${image} >> /Contents ${contentId} 0 R >>`;
    kids.push(pageId);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let at = 0;
  const write = (chunk: Buffer) => { chunks.push(chunk); at += chunk.length; };
  write(Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"));
  objects.forEach((body, i) => {
    offsets.push(at);
    write(Buffer.from(`${i + 1} 0 obj\n`, "latin1"));
    write(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    write(Buffer.from("\nendobj\n", "latin1"));
  });
  const xrefAt = at;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  write(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

/** A Letter page as a scanner makes it: the lines drawn into a paper-coloured image, as a JPEG, with no text layer. */
async function scanOf(sharp: SharpFactory, lines: readonly string[]): Promise<PdfImagePage> {
  const { width, height } = SCAN_PIXELS;
  const text = lines.map((line, i) => `<text x="200" y="${200 + i * 50}" font-family="sans-serif" font-size="27" fill="#1a1a1a">${xml(line)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#f6f4ee"/>${text}</svg>`;
  return { jpeg: new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer()), width, height };
}

/** One Letter page of invented notice text, with a text layer. */
export const letterPdf = (): Uint8Array => pdfBytes([{ lines: LETTER }]);

/** One Letter page that is only a scan of the same notice: a JPEG, no text layer. */
export async function scanPdf(sharp: SharpFactory): Promise<Uint8Array> {
  return pdfBytes([await scanOf(sharp, LETTER)]);
}

/** `pages` Letter pages of invented section text, each with a text layer. */
export const textPdf = (pages: number): Uint8Array => pdfBytes(Array.from({ length: pages }, (_, i) => ({ lines: sectionLines(i + 1) })));

/** `pages` pages of section text, where page `scannedPage` (1-based) is a scan of its own lines instead. */
export async function mixedPdf(sharp: SharpFactory, pages: number, scannedPage: number): Promise<Uint8Array> {
  const out: PdfPage[] = [];
  for (let page = 1; page <= pages; page++) out.push(page === scannedPage ? await scanOf(sharp, sectionLines(page)) : { lines: sectionLines(page) });
  return pdfBytes(out);
}

const svgDocument = (width: number, height: number, background: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${background}"/>${body}</svg>`;

/** A full-page screenshot: numbered rows on alternating bands. The default shape is the one the planner's tiling covers. */
export async function tallPng(sharp: SharpFactory, width = 1288, height = 8319): Promise<Uint8Array> {
  const row = 22;
  const rows = Array.from({ length: Math.floor(height / row) }, (_, n) => {
    const y = n * row;
    const label = `row ${String(n).padStart(4, "0")}  entity EXAMPLE-${String(y).padStart(5, "0")}  status ACTIVE  amount ${(y * 3.17).toFixed(2)}`;
    return `<rect y="${y}" width="${width}" height="${row}" fill="${n % 2 ? "#f8f9fb" : "#ffffff"}"/><text x="16" y="${y + 15}" font-family="monospace" font-size="14" fill="#141414">${xml(label)}</text>`;
  });
  return new Uint8Array(await sharp(Buffer.from(svgDocument(width, height, "#ffffff", rows.join("")))).png().toBuffer());
}

/** A 3840 by 2160 dashboard at 2x: sixty bordered metric boxes. */
export async function widePng(sharp: SharpFactory): Promise<Uint8Array> {
  const boxes = Array.from({ length: 60 }, (_, i) => {
    const x = 40 + (i % 6) * 630, y = 40 + Math.floor(i / 6) * 210;
    return `<rect x="${x}" y="${y}" width="600" height="190" fill="#ffffff" stroke="#788296" stroke-width="3"/><text x="${x + 20}" y="${y + 40}" font-family="sans-serif" font-size="28" fill="#0a0a0a">metric ${i}: ${(i * 1543 + 977) % 99999}</text>`;
  });
  return new Uint8Array(await sharp(Buffer.from(svgDocument(3840, 2160, "#fafafc", boxes.join("")))).png().toBuffer());
}

/** A 3024 by 4032 photo-like JPEG: a warm gradient with fine grain, stored with EXIF orientation 6 (rotate 90 clockwise to show). */
export async function photoJpeg(sharp: SharpFactory): Promise<Uint8Array> {
  const width = 3024, height = 4032;
  const raw = new Uint8Array(width * height * 3);
  for (let y = 0, at = 0; y < height; y++) {
    for (let x = 0; x < width; x++, at += 3) {
      const k = (x + y) / (width + height);
      const grain = ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) & 3;
      raw[at] = 216 - 90 * k + grain;
      raw[at + 1] = 199 - 80 * k + grain;
      raw[at + 2] = 171 - 50 * k + grain;
    }
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg({ quality: 88 }).toBuffer());
}

/** The time every zip entry carries: the DOS epoch, read in local time both ways, so the bytes match on every machine. Without
 *  it fflate reads the clock, and a build would change with the time it ran. */
const ZIP_TIME = new Date(1980, 0, 1);
const zipEntry = (text: string, level?: ZipOptions["level"]): [Uint8Array, ZipOptions] => [strToU8(text), { mtime: ZIP_TIME, level }];
const zip = (parts: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, zipEntry(text)])));
const relationships = (items: readonly (readonly [string, string, string])[]) => xmlDocument(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`);
const contentTypes = (overrides: readonly (readonly [string, string])[]) => xmlDocument(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("")}</Types>`);
const rootRelationship = (target: string) => relationships([["rId1", `${RELATIONSHIPS}/officeDocument`, target]]);

const paragraph = (text: string, listItem = false) => `<w:p>${listItem ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
const tableRow = (cells: readonly string[]) => `<w:tr>${cells.map((text) => `<w:tc><w:tcPr><w:tcW w:w="2880" w:type="dxa"/></w:tcPr>${paragraph(text)}</w:tc>`).join("")}</w:tr>`;

/** A word processor file: a title line, a numbered list and a table, in that order. */
export function docxBytes(): Uint8Array {
  const table = `<w:tbl><w:tblPr><w:tblW w:w="8640" w:type="dxa"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2880"/>'.repeat(3)}</w:tblGrid>${[["Item", "Quantity", "Amount"], ["Widget A", "2", "10.00"], ["Widget B", "5", "25.50"]].map(tableRow).join("")}</w:tbl>`;
  const body = [paragraph("Proof of address (synthetic)"), paragraph("EXAMPLE WIDGETS LLC", true), paragraph("100 SAMPLE STREET SUITE 4", true), paragraph("SPRINGFIELD, ZZ 00000", true), paragraph("Utility statement for the period 2025-02-01 to 2025-02-28.", true), paragraph("Amount due: 35.50"), table].join("");
  return zip({
    "[Content_Types].xml": contentTypes([["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"], ["/word/numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"]]),
    "_rels/.rels": rootRelationship("word/document.xml"),
    "word/_rels/document.xml.rels": relationships([["rId1", `${RELATIONSHIPS}/numbering`, "numbering.xml"]]),
    "word/document.xml": xmlDocument(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    "word/numbering.xml": xmlDocument('<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'),
  });
}

const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const SHAPE_TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const run = (text: string) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${xml(text)}</a:t></a:r></a:p>`;
const bullet = (text: string) => `<a:p><a:pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${xml(text)}</a:t></a:r></a:p>`;
const placeholder = (id: number, name: string, ph: string, [x, y, cx, cy]: readonly number[], paragraphs: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
const theme = (name: string) => {
  const accents = ["4F81BD", "C0504D", "9BBB59", "8064A2", "4BACC6", "F79646"].map((hex, i) => `<a:accent${i + 1}><a:srgbClr val="${hex}"/></a:accent${i + 1}>`).join("");
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return xmlDocument(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements><a:clrScheme name="${name}"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>${accents}<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="${name}"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="${name}"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525, 25400, 38100].map((w) => `<a:ln w="${w}">${fill}</a:ln>`).join("")}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
};

/** A slide deck: two slides in order, each with a title, three bullets and its speaker notes. */
export function pptxBytes(): Uint8Array {
  const slides = [
    { title: "Slide 1: synthetic deck", bullets: ["Bullet A0", "Bullet B0", "Revenue figure 1000"], notes: "Speaker notes for slide 1: EXAMPLE WIDGETS LLC." },
    { title: "Slide 2: synthetic deck", bullets: ["Bullet A1", "Bullet B1", "Revenue figure 1037"], notes: "Speaker notes for slide 2." },
  ];
  const parts: Record<string, string> = {
    "[Content_Types].xml": contentTypes([
      ["/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
      ["/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
      ["/ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
      ["/ppt/notesMasters/notesMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"],
      ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
      ["/ppt/theme/theme2.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
      ...slides.flatMap((_, i): (readonly [string, string])[] => [
        [`/ppt/slides/slide${i + 1}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],
        [`/ppt/notesSlides/notesSlide${i + 1}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"],
      ]),
    ]),
    "_rels/.rels": rootRelationship("ppt/presentation.xml"),
    "ppt/presentation.xml": xmlDocument(`<p:presentation ${P_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${3 + i}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": relationships([
      ["rId1", `${RELATIONSHIPS}/slideMaster`, "slideMasters/slideMaster1.xml"],
      ["rId2", `${RELATIONSHIPS}/notesMaster`, "notesMasters/notesMaster1.xml"],
      ...slides.map((_, i): readonly [string, string, string] => [`rId${3 + i}`, `${RELATIONSHIPS}/slide`, `slides/slide${i + 1}.xml`]),
    ]),
    "ppt/slideMasters/slideMaster1.xml": xmlDocument(`<p:sldMaster ${P_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SHAPE_TREE}</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([["rId1", `${RELATIONSHIPS}/slideLayout`, "../slideLayouts/slideLayout1.xml"], ["rId2", `${RELATIONSHIPS}/theme`, "../theme/theme1.xml"]]),
    "ppt/slideLayouts/slideLayout1.xml": xmlDocument(`<p:sldLayout ${P_NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${SHAPE_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([["rId1", `${RELATIONSHIPS}/slideMaster`, "../slideMasters/slideMaster1.xml"]]),
    "ppt/notesMasters/notesMaster1.xml": xmlDocument(`<p:notesMaster ${P_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SHAPE_TREE}</p:spTree></p:cSld>${CLR_MAP}</p:notesMaster>`),
    "ppt/notesMasters/_rels/notesMaster1.xml.rels": relationships([["rId1", `${RELATIONSHIPS}/theme`, "../theme/theme2.xml"]]),
    "ppt/theme/theme1.xml": theme("Office"),
    "ppt/theme/theme2.xml": theme("Office"),
  };
  slides.forEach((slide, i) => {
    const n = i + 1;
    parts[`ppt/slides/slide${n}.xml`] = xmlDocument(`<p:sld ${P_NS}><p:cSld><p:spTree>${SHAPE_TREE}${placeholder(2, "Title 1", '<p:ph type="title"/>', [457200, 274638, 8229600, 1143000], run(slide.title))}${placeholder(3, "Content 2", '<p:ph idx="1"/>', [457200, 1600200, 8229600, 4525963], slide.bullets.map((text) => bullet(text)).join(""))}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    parts[`ppt/slides/_rels/slide${n}.xml.rels`] = relationships([["rId1", `${RELATIONSHIPS}/slideLayout`, "../slideLayouts/slideLayout1.xml"], ["rId2", `${RELATIONSHIPS}/notesSlide`, `../notesSlides/notesSlide${n}.xml`]]);
    parts[`ppt/notesSlides/notesSlide${n}.xml`] = xmlDocument(`<p:notes ${P_NS}><p:cSld><p:spTree>${SHAPE_TREE}${placeholder(2, "Notes 1", '<p:ph type="body" idx="1"/>', [685800, 4400550, 5486400, 3600450], run(slide.notes))}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
    parts[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = relationships([["rId1", `${RELATIONSHIPS}/notesMaster`, "../notesMasters/notesMaster1.xml"], ["rId2", `${RELATIONSHIPS}/slide`, `../slides/slide${n}.xml`]]);
  });
  return zip(parts);
}

/** A workbook with one sheet: a formula with a stored value, one without, and a 16-digit integer above 2^53, which a
 *  double cannot hold exactly, so a reader must keep it as digits. */
export function xlsxBytes(): Uint8Array {
  const text = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
  const number = (ref: string, value: string) => `<c r="${ref}"><v>${value}</v></c>`;
  const formula = (ref: string, expression: string, stored?: string) => `<c r="${ref}"><f>${expression}</f>${stored === undefined ? "" : `<v>${stored}</v>`}</c>`;
  const rows = [
    `<row r="1">${text("A1", "id")}${text("B1", "amount")}${text("C1", "doubled")}${text("D1", "running_total")}${text("E1", "account_no")}</row>`,
    `<row r="2">${number("A2", "1")}${number("B2", "1250.5")}${formula("C2", "B2*2", "2501")}${formula("D2", "SUM(B$2:B2)")}${number("E2", "9007199254740993")}</row>`,
    `<row r="3">${number("A3", "2")}${number("B3", "99.99")}${formula("C3", "B3*2", "199.98")}${formula("D3", "SUM(B$2:B3)")}</row>`,
  ];
  return zip({
    "[Content_Types].xml": contentTypes([["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"], ["/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"]]),
    "_rels/.rels": rootRelationship("xl/workbook.xml"),
    "xl/workbook.xml": xmlDocument(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${RELATIONSHIPS}"><sheets><sheet name="ledger" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": relationships([["rId1", `${RELATIONSHIPS}/worksheet`, "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": xmlDocument(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`),
  });
}

/** An OpenDocument text file: a heading, a paragraph and a two-item list. Its `mimetype` entry comes first and is stored. */
export function odtBytes(): Uint8Array {
  const content = xmlDocument(`<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:h text:outline-level="1">Proof of address (synthetic)</text:h><text:p>EXAMPLE WIDGETS LLC, 100 SAMPLE STREET SUITE 4, SPRINGFIELD, ZZ 00000</text:p><text:list><text:list-item><text:p>Utility statement for the period 2025-02-01 to 2025-02-28.</text:p></text:list-item><text:list-item><text:p>Amount due: 35.50</text:p></text:list-item></text:list></office:text></office:body></office:document-content>`);
  const manifest = xmlDocument('<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  return zipSync({
    mimetype: zipEntry("application/vnd.oasis.opendocument.text", 0),
    "META-INF/manifest.xml": zipEntry(manifest),
    "content.xml": zipEntry(content),
  });
}
