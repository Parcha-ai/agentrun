// Synthetic office files for the office suites, built here from invented text with fflate: the smallest packages the
// reader's formats are made of, written the way their editors write them (namespaces, shared strings, relationships,
// notes parts, shared formulas, covered cells). Nothing in them is a real document.
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fixtureDir } from "@parcha/pi-vision/testing";

const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const PRES = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main";

/** A zip of text files; a value of `[text, { level: 0 }]` is stored. */
export const zip = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Array.isArray(value) ? [strToU8(value[0]), value[1]] : strToU8(value)])));
const rels = (items) => `${head}<Relationships xmlns="${PKG_REL}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;

// ---- docx ----------------------------------------------------------------------------------------------------------
const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
export const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${run(text)}</w:p>`;
export const item = (text, numId, level = 0) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
export const cell = (inner, span) => `<w:tc><w:tcPr>${span ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>${inner}</w:tc>`;
export const row = (...cells) => `<w:tr>${cells.join("")}</w:tr>`;
export const table = (...rows) => `<w:tbl><w:tblPr/>${rows.join("")}</w:tbl>`;
const NUMBERING = `${head}<w:numbering xmlns:w="${WORD}">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

/** A word document: `body` is the XML inside w:body; `extra` adds parts (headers, footers) by name. */
export function docx(body, extra = {}) {
  return zip({
    "[Content_Types].xml": `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": rels([["rId1", "officeDocument", "word/document.xml"]]),
    "word/document.xml": `${head}<w:document xmlns:w="${WORD}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    "word/numbering.xml": NUMBERING,
    ...extra,
  });
}
export const wordPart = (kind, inner) => `${head}<w:${kind} xmlns:w="${WORD}">${inner}</w:${kind}>`;

// ---- pptx ----------------------------------------------------------------------------------------------------------
const text = (value) => `<a:p><a:r><a:t>${value}</a:t></a:r></a:p>`;
export const shape = (paragraphs, ph) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs.map((p) => (p.startsWith("<") ? p : text(p))).join("")}</p:txBody></p:sp>`;
export const slideTable = (rows) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="t"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>${rows.map((r) => `<a:tr>${r.map((c) => `<a:tc><a:txBody>${text(c)}</a:txBody></a:tc>`).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const slideXml = (shapes, attrs = "") => `${head}<p:sld xmlns:p="${PRES}" xmlns:a="${DRAW}" ${attrs}><p:cSld><p:spTree><p:nvGrpSpPr/>${shapes.join("")}</p:spTree></p:cSld></p:sld>`;

/** A presentation: `slides` in presentation order, each `{ shapes, notes?, hidden? }`; the slide parts are numbered in the
 *  reverse of that order, so a reader that sorts by file name reads them wrong. */
export function pptx(slides) {
  const files = { "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]) };
  const total = slides.length;
  const relItems = slides.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${total - i}.xml`]);
  files["ppt/presentation.xml"] = `${head}<p:presentation xmlns:p="${PRES}" xmlns:r="${REL}"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = rels(relItems);
  slides.forEach((slide, i) => {
    const number = total - i;
    files[`ppt/slides/slide${number}.xml`] = slideXml(slide.shapes, slide.hidden ? 'show="0"' : "");
    if (!slide.notes) return;
    files[`ppt/slides/_rels/slide${number}.xml.rels`] = rels([["rId1", "notesSlide", `../notesSlides/notesSlide${number}.xml`]]);
    files[`ppt/notesSlides/notesSlide${number}.xml`] = `${head}<p:notes xmlns:p="${PRES}" xmlns:a="${DRAW}"><p:cSld><p:spTree><p:nvGrpSpPr/>${shape([], "sldImg")}${shape(slide.notes, "body")}${shape(["‹#›"], "sldNum")}</p:spTree></p:cSld></p:notes>`;
  });
  return zip(files);
}

// ---- xlsx ----------------------------------------------------------------------------------------------------------
export const c = (ref, inner, attrs = "") => `<c r="${ref}"${attrs}>${inner}</c>`;
export const sheetXml = (rows) => `${head}<worksheet xmlns="${SHEET}"><sheetData>${rows.map(([n, ...cells]) => `<row r="${n}">${cells.join("")}</row>`).join("")}</sheetData></worksheet>`;

/** A workbook: `sheets` are `{ name, xml, state? }`; `strings` are the shared strings' inner XML; `styles` the numFmts and the number format of each style. */
export function xlsx({ sheets, strings = [], formats = {}, styles = [0], date1904 = false }) {
  return zip({
    "_rels/.rels": rels([["rId1", "officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": `${head}<workbook xmlns="${SHEET}" xmlns:r="${REL}"><workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels(sheets.map((_, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`])),
    "xl/sharedStrings.xml": `${head}<sst xmlns="${SHEET}">${strings.map((s) => `<si>${s}</si>`).join("")}</sst>`,
    "xl/styles.xml": `${head}<styleSheet xmlns="${SHEET}"><numFmts>${Object.entries(formats).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`).join("")}</numFmts><cellXfs>${styles.map((id) => `<xf numFmtId="${id}"/>`).join("")}</cellXfs></styleSheet>`,
    ...Object.fromEntries(sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml])),
  });
}

// ---- OpenDocument --------------------------------------------------------------------------------------------------
const OFFICE = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
/** An OpenDocument package of one kind (`text`, `presentation`, `spreadsheet`) whose body is `body`. */
export const odf = (kind, body) => zip({
  mimetype: [`application/vnd.oasis.opendocument.${kind}`, { level: 0 }],
  "content.xml": `${head}<office:document-content ${OFFICE}><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`,
});

// ---- running a provider over bytes ---------------------------------------------------------------------------------
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A directory, the Node environment over it, and `source(name, bytes, kind)` that writes a file there and describes it
 *  as a provider is given it. */
export async function workspace(t) {
  const dir = await fixtureDir("pi-vision-office-");
  t.after(() => dir.remove());
  const env = new NodeExecutionEnv({ cwd: dir.path });
  return {
    dir,
    env,
    async source(name, bytes, kind = "office") {
      return { path: await dir.file(name, bytes), kind, bytes: bytes.length, sha256: sha256(bytes) };
    },
    call: (signal) => ({ env, signal, tempDir: dir.path }),
  };
}
