// Office documents with nothing installed, read by the package's own reader on fflate and @xmldom/xmldom: the text of
// docx and odt, the slides of pptx and odp in order with their notes, and the cells of xlsx and ods with value, formula
// and stored value, a formula with no stored value said, not dropped. RTF reads as its source text. A file is
// recognised by what it holds, never by its name. Every archive is held to the limits before anything is inflated and
// every part is inflated into a bounded buffer, so a hostile file is a typed miss that costs bounded time and memory.
import type { Element } from "@xmldom/xmldom";
import { OFFICE_LIMITS, OfficeMissError, readSource, sheetText, zipDirectory, type OfficeCell, type OfficeLimits, type ZipEntry } from "../core/office.js";
import type { Cell, Provider, ProviderCall, ProviderSource } from "../core/provider.js";

/** The reader's output version: it changes whenever the text or the cells it writes change, so a derivation cached
 *  under an older one is never reused. */
const READER_VERSION = "1";
/** Compressed bytes pushed to the inflater at a time: deflate expands at most 1,032 to 1, so one push writes at most 8 MiB past a part's cap. */
const PUSH_BYTES = 8192;
/** Word allows 63 columns in a table, and Word and LibreOffice 16,384 columns and 1,048,576 rows in a sheet: a span or repeat count past these is read as these. */
const MAX_TABLE_COLUMNS = 63;
const MAX_SHEET_COLUMNS = 16_384;
const MAX_SHEET_ROWS = 1_048_576;
/** Levels of a list in Word, of headings in Markdown, and the longest run of spaces an OpenDocument paragraph declares by count. */
const MAX_LIST_LEVEL = 8;
const MAX_HEADING = 6;
const SPACE_RUN = 80;
const LOCAL_HEADER = 0x04034b50;

type Deps = { readonly fflate: typeof import("fflate"); readonly xmldom: typeof import("@xmldom/xmldom") };
let deps: Promise<Deps> | undefined;
const loadDeps = () => (deps ??= Promise.all([import("fflate"), import("@xmldom/xmldom")]).then(([fflate, xmldom]) => ({ fflate, xmldom })));

type El = Element | null | undefined;
type Page = { readonly page: number; readonly text: string };
type Sheet = { readonly index: number; readonly name: string; readonly hidden: boolean; readonly cells: OfficeCell[] };
type Span = { readonly from: number; readonly to: number };
type Relationship = { readonly type: string; readonly target: string };
type Wanted = (index: number, name: string) => boolean;
type Archive = {
  names(): string[];
  raw(name: string): Uint8Array | null;
  part(name: string): Promise<Element | null>;
  rels(owner: string): Promise<Map<string, Relationship>>;
};

const unreadable = (why: string) => new OfficeMissError("unreadable", why);
const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const kids = (el: El): Element[] => {
  const out: Element[] = [];
  for (let node = el?.firstChild ?? null; node; node = node.nextSibling) if (node.nodeType === 1) out.push(node as Element);
  return out;
};
const named = (el: El, ...names: string[]) => kids(el).filter((k) => names.includes(k.localName ?? ""));
const first = (el: El, name: string) => named(el, name)[0] ?? null;
/** An attribute by its qualified or its local name; the qualified form tells `r:id` from `id`. */
const at = (el: El, name: string): string | null => {
  for (let i = 0; el && i < el.attributes.length; i++) {
    const attribute = el.attributes.item(i)!;
    if (attribute.name === name || attribute.localName === name) return attribute.value;
  }
  return null;
};
const dig = (el: El, name: string): Element | null => {
  for (const k of kids(el)) if (k.localName === name) return k;
  for (const k of kids(el)) { const found = dig(k, name); if (found) return found; }
  return null;
};
const within = (n: number, span?: Span) => !span || (n >= span.from && n <= span.to);
/** An integer attribute read within 0..max, `fallback` when it is absent or not a number. */
const int = (text: string | null, fallback: number, max: number) => {
  const n = Math.trunc(Number(text ?? fallback));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : fallback;
};
/** A stored number as a number; an integer of more than 15 digits stays the digits it was stored as, which a double would round. */
const number = (text: string): number | string => (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && !/^-?\d{16,}$/.test(text) ? Number(text) : text);
const columnName = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const resolve = (dir: string, target: string) => {
  const out = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const segment of target.split("/")) if (segment === "..") out.pop(); else if (segment && segment !== ".") out.push(segment);
  return out.join("/");
};

/** One part's bytes, inflated into a buffer that never passes `limit`, however the entry declares itself. */
function inflate({ Inflate }: Deps["fflate"], data: Uint8Array, entry: ZipEntry, limit: number): Uint8Array {
  const tooBig = (bytes: number) => new OfficeMissError("over_budget", `${entry.name} is ${mib(bytes)}, over the ${mib(limit)} the reader takes of one part; read it with bash`);
  if (Math.max(entry.originalSize, entry.size) > limit) throw tooBig(Math.max(entry.originalSize, entry.size));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(entry.offset, true) !== LOCAL_HEADER) throw unreadable(`${entry.name} has a damaged header`);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const packed = data.subarray(start, start + entry.size);
  if (entry.method === 0) return packed;
  if (entry.method !== 8) throw new OfficeMissError("unsupported", `${entry.name} uses compression method ${entry.method}, which the reader does not take`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw tooBig(total);
    chunks.push(chunk);
  });
  for (let from = 0; from < packed.length; from += PUSH_BYTES) stream.push(packed.subarray(from, from + PUSH_BYTES), from + PUSH_BYTES >= packed.length);
  return Buffer.concat(chunks);
}

async function openArchive(data: Uint8Array, call: ProviderCall, limits: OfficeLimits): Promise<Archive> {
  const { fflate, xmldom } = await loadDeps();
  const entries = new Map(zipDirectory(data, limits).map((entry) => [entry.name, entry]));
  let parsed = 0;
  const raw = (name: string) => {
    const entry = entries.get(name);
    return entry ? inflate(fflate, data, entry, limits.maxPartBytes) : null;
  };
  const part = async (name: string): Promise<Element | null> => {
    call.signal?.throwIfAborted();
    const bytes = raw(name);
    if (!bytes) return null;
    if ((parsed += bytes.length) > limits.maxParsedBytes) throw new OfficeMissError("over_budget", `the parts of this file pass ${mib(limits.maxParsedBytes)}, the most the reader parses in one read; read it with bash`);
    await new Promise((done) => setImmediate(done));
    return new xmldom.DOMParser({ locator: false, onError: xmldom.onErrorStopParsing }).parseFromString(new TextDecoder().decode(bytes), "text/xml").documentElement;
  };
  const rels = async (owner: string) => {
    const dir = owner.slice(0, owner.lastIndexOf("/") + 1);
    return new Map(kids(await part(`${dir}_rels/${owner.slice(dir.length)}.rels`)).map((r): [string, Relationship] => [at(r, "Id") ?? "", { type: at(r, "Type") ?? "", target: resolve(dir, at(r, "Target") ?? "") }]));
  };
  return { names: () => [...entries.keys()], raw, part, rels };
}

/** The text of an inline run of WordprocessingML, DrawingML or SpreadsheetML: text, tabs and breaks in order. Deleted
 *  text, field codes, properties, phonetic guides and the fallback copy of a drawing are not text. */
function inline(el: El): string {
  let out = "";
  for (const k of kids(el)) {
    switch (k.localName) {
      case "t": out += k.textContent ?? ""; break;
      case "tab": out += "\t"; break;
      case "br": case "cr": out += "\n"; break;
      case "noBreakHyphen": out += "-"; break;
      case "p": out += `\n${inline(k)}`; break;
      case "pPr": case "rPr": case "endParaRPr": case "del": case "instrText": case "rPh": case "Fallback": break;
      default: out += inline(k);
    }
  }
  return out;
}
const tableRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

async function docx(a: Archive): Promise<Page[]> {
  const [body, numbering] = [await a.part("word/document.xml"), await a.part("word/numbering.xml")];
  if (!body) throw unreadable("a word document without word/document.xml");
  const levels = new Map(named(numbering, "abstractNum").map((n): [string, Map<string, string>] => [at(n, "abstractNumId") ?? "", new Map(named(n, "lvl").map((l): [string, string] => [at(l, "ilvl") ?? "0", at(first(l, "numFmt"), "val") ?? "decimal"]))]));
  const formats = new Map(named(numbering, "num").map((n): [string, Map<string, string> | undefined] => [at(n, "numId") ?? "", levels.get(at(first(n, "abstractNumId"), "val") ?? "")]));
  const counts = new Map<string, number>();
  const marker = (p: Element) => {
    const num = first(first(p, "pPr"), "numPr");
    const id = at(first(num, "numId"), "val");
    if (id === null || id === "0") return "";
    const level = int(at(first(num, "ilvl"), "val"), 0, MAX_LIST_LEVEL);
    const indent = "  ".repeat(level);
    const format = formats.get(id)?.get(String(level)) ?? "bullet";
    if (format !== "decimal" && !format.endsWith("Letter")) return `${indent}- `;
    for (const key of [...counts.keys()]) if (key.startsWith(`${id}:`) && Number(key.split(":")[1]) > level) counts.delete(key);
    const n = (counts.get(`${id}:${level}`) ?? 0) + 1;
    counts.set(`${id}:${level}`, n);
    return `${indent}${format === "decimal" ? n : String.fromCharCode((format.startsWith("upper") ? 65 : 97) + ((n - 1) % 26))}. `;
  };
  const blocks = (el: El, out: string[]): string[] => {
    for (const k of kids(el)) {
      if (k.localName === "p") {
        const style = at(first(first(k, "pPr"), "pStyle"), "val") ?? "";
        const heading = style === "Title" ? 1 : style.startsWith("Heading") ? Math.max(1, int(style.slice(7), 1, MAX_HEADING)) : 0;
        const text = inline(k).trim();
        if (text) out.push(`${heading ? `${"#".repeat(heading)} ` : marker(k)}${text}`);
      } else if (k.localName === "tbl") {
        for (const tr of named(k, "tr")) {
          out.push(tableRow(named(tr, "tc").flatMap((tc) => [blocks(tc, []).join(" / "), ...Array<string>(Math.max(1, int(at(first(first(tc, "tcPr"), "gridSpan"), "val"), 1, MAX_TABLE_COLUMNS)) - 1).fill("")])));
        }
      } else if (k.localName !== "Fallback") blocks(k, out);
    }
    return out;
  };
  const side = async (kind: "header" | "footer") => {
    const texts = new Set<string>();
    for (const name of a.names().filter((n) => n.startsWith(`word/${kind}`) && n.endsWith(".xml")).sort()) texts.add(blocks(await a.part(name), []).join("\n"));
    return [...texts].filter(Boolean).map((text) => `${kind === "header" ? "Header" : "Footer"}: ${text}`);
  };
  return [{ page: 1, text: [...(await side("header")), ...blocks(body, []), ...(await side("footer"))].join("\n") }];
}

async function pptx(a: Archive, want?: Span): Promise<Page[]> {
  const [presentation, rels] = [await a.part("ppt/presentation.xml"), await a.rels("ppt/presentation.xml")];
  if (!presentation) throw unreadable("a presentation without ppt/presentation.xml");
  const paragraph = (p: Element) => `${"  ".repeat(int(at(first(p, "pPr"), "lvl"), 0, MAX_LIST_LEVEL))}${inline(p).trim()}`;
  const lines = (el: El, skip: string[], out: string[]): string[] => {
    for (const k of kids(el)) {
      if (k.localName === "sp") {
        if (!skip.includes(at(first(first(first(k, "nvSpPr"), "nvPr"), "ph"), "type") ?? "")) out.push(...named(first(k, "txBody"), "p").map(paragraph).filter((line) => line.trim()));
      } else if (k.localName === "graphicFrame") {
        for (const tr of named(dig(k, "tbl"), "tr")) out.push(tableRow(named(tr, "tc").map((tc) => named(first(tc, "txBody"), "p").map(paragraph).filter((line) => line.trim()).join(" / "))));
      } else if (k.localName !== "Fallback") lines(k, skip, out);
    }
    return out;
  };
  const pages: Page[] = [];
  for (const [index, id] of named(first(presentation, "sldIdLst"), "sldId").entries()) {
    if (!within(index + 1, want)) continue;
    const path = rels.get(at(id, "r:id") ?? "")?.target ?? "";
    const slide = await a.part(path);
    if (!slide) { pages.push({ page: index + 1, text: `(slide ${index + 1} is missing from the file)` }); continue; }
    const notesPath = [...(await a.rels(path)).values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notes = notesPath ? lines(await a.part(notesPath), ["sldNum", "sldImg", "hdr", "ftr", "dt"], []) : [];
    pages.push({ page: index + 1, text: [...(at(slide, "show") === "0" ? ["(hidden slide)"] : []), ...lines(slide, ["sldNum"], []), ...(notes.length ? ["", "Notes:", ...notes] : [])].join("\n") });
  }
  return pages;
}

/** The number formats built in to SpreadsheetML that show a date or a time of day. */
const BUILTIN_DATE_FORMATS = [[14, 22], [27, 36], [45, 47], [50, 58]] as const;
/** The cell styles whose number format is a date or a time: a built-in one, or a custom code with a date or time letter outside its quotes, brackets and escapes. */
function dateStyles(styles: El): Set<number> {
  const codes = new Map(named(first(styles, "numFmts"), "numFmt").map((n): [number, string] => [Number(at(n, "numFmtId")), at(n, "formatCode") ?? ""]));
  const isDate = (id: number) => BUILTIN_DATE_FORMATS.some(([from, to]) => id >= from && id <= to) || /[dmyhs]/i.test((codes.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, ""));
  return new Set(named(first(styles, "cellXfs"), "xf").flatMap((xf, index) => (isDate(Number(at(xf, "numFmtId") ?? 0)) ? [index] : [])));
}
/** A serial date as ISO text: a date, a time of day, or both, as the number's fraction says; nothing for a serial no date
 *  has. Excel counts a 29 February 1900 that never was, so its serials before 60 are one day past the 30 December 1899 epoch. */
function isoDate(serial: number, from1904: boolean): string | undefined {
  if (!(serial >= 0 && serial < 2_958_466)) return undefined;
  const iso = new Date((from1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, serial < 60 ? 31 : 30)) + Math.round(serial * 86_400) * 1000).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : serial < 1 ? iso.slice(11, 19) : iso.slice(0, 19);
}

const tooManyCells = (limits: OfficeLimits, where: string) => new OfficeMissError("over_budget", `${where} holds more than ${limits.maxCells} cells, over what the reader builds; read it with bash`);

async function xlsx(a: Archive, limits: OfficeLimits, wanted: Wanted): Promise<Sheet[]> {
  const workbook = await a.part("xl/workbook.xml");
  if (!workbook) throw unreadable("a workbook without xl/workbook.xml");
  const [rels, strings, styles] = [await a.rels("xl/workbook.xml"), await a.part("xl/sharedStrings.xml"), await a.part("xl/styles.xml")];
  const table = named(strings, "si").map(inline);
  const dates = dateStyles(styles);
  const from1904 = ["1", "true"].includes(at(first(workbook, "workbookPr"), "date1904") ?? "");
  const sheets: Sheet[] = [];
  let count = 0;
  for (const [index, sheet] of named(first(workbook, "sheets"), "sheet").entries()) {
    const name = at(sheet, "name") ?? `Sheet${index + 1}`;
    if (!wanted(index, name)) continue;
    const root = await a.part(rels.get(at(sheet, "r:id") ?? "")?.target ?? "");
    if (!root) throw unreadable(`sheet ${name} is missing from the file`);
    const shared = new Map<string, { ref: string; text: string }>();
    const cells: OfficeCell[] = [];
    for (const c of named(first(root, "sheetData"), "row").flatMap((row) => named(row, "c"))) {
      const ref = at(c, "r");
      if (!ref) throw unreadable(`a cell in sheet ${name} has no reference, so its place is not known`);
      const [type, f, v] = [at(c, "t") ?? "n", first(c, "f"), first(c, "v")];
      const text = type === "inlineStr" ? inline(first(c, "is")) : (v?.textContent ?? "");
      const value: Cell["value"] = text === "" ? null : type === "s" ? (table[Number(text)] ?? null) : type === "b" ? text === "1" : type === "n" ? number(text) : text;
      let formula: string | undefined;
      if (f) {
        let source = f.textContent ?? "";
        const id = at(f, "t") === "shared" ? at(f, "si") : null;
        if (id !== null && source) shared.set(id, { ref, text: source });
        else if (id !== null && shared.has(id)) source = `${shared.get(id)!.text} (shared from ${shared.get(id)!.ref})`;
        formula = source || "(formula text not stored)";
      } else if (value === null || value === "") continue;
      if (++count > limits.maxCells) throw tooManyCells(limits, "the workbook");
      const date = typeof value === "number" && dates.has(Number(at(c, "s") ?? 0)) ? isoDate(value, from1904) : undefined;
      cells.push({ ref, value, ...(formula === undefined ? {} : { formula, cached: value !== null }), ...(date ? { date } : {}) });
    }
    sheets.push({ index, name, hidden: (at(sheet, "state") ?? "visible") !== "visible", cells });
  }
  return sheets;
}

function odfInline(el: Element): string {
  let out = "";
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3 || node.nodeType === 4) out += node.nodeValue ?? "";
    else if (node.nodeType === 1) {
      const k = node as Element;
      if (k.localName === "s") out += " ".repeat(Math.max(1, int(at(k, "c"), 1, SPACE_RUN)));
      else if (k.localName === "tab") out += "\t";
      else if (k.localName === "line-break") out += "\n";
      else if (k.localName !== "annotation") out += odfInline(k);
    }
  }
  return out;
}
const tableRows = (el: El): Element[] => kids(el).flatMap((k) => (k.localName === "table-row" ? [k] : ["table-row-group", "table-header-rows", "table-rows"].includes(k.localName ?? "") ? tableRows(k) : []));
const repeats = (el: Element, name: string, max: number) => Math.max(1, int(at(el, name), 1, max));

function odfBlocks(el: El, depth: number, out: string[]): string[] {
  for (const k of kids(el)) {
    switch (k.localName) {
      case "p": out.push(odfInline(k)); break;
      case "h": out.push(`${"#".repeat(Math.max(1, int(at(k, "outline-level"), 1, MAX_HEADING)))} ${odfInline(k)}`); break;
      case "list":
        for (const item of named(k, "list-item", "list-header")) {
          const lines = odfBlocks(item, depth + 1, []);
          if (lines.length) lines[0] = `${"  ".repeat(depth)}- ${lines[0]}`;
          out.push(...lines);
        }
        break;
      case "table":
        for (const tr of tableRows(k)) {
          const cells = named(tr, "table-cell", "covered-table-cell").flatMap((tc) => Array<string>(repeats(tc, "number-columns-repeated", MAX_TABLE_COLUMNS)).fill(odfBlocks(tc, 0, []).join(" / ")));
          while (cells.at(-1) === "") cells.pop();
          if (cells.length) out.push(tableRow(cells));
        }
        break;
      case "tracked-changes": case "annotation": case "notes": break;
      default: odfBlocks(k, depth, out);
    }
  }
  return out;
}

async function odf(a: Archive, format: "odt" | "odp"): Promise<Page[]> {
  const content = await a.part("content.xml");
  if (!content) throw unreadable("an OpenDocument file without content.xml");
  const lines = (el: El) => odfBlocks(el, 0, []).filter((line) => line.trim());
  if (format === "odt") return [{ page: 1, text: lines(dig(content, "text")).join("\n") }];
  return named(dig(content, "presentation"), "page").map((slide, index) => {
    const notes = lines(first(slide, "notes"));
    return { page: index + 1, text: [...lines(slide), ...(notes.length ? ["", "Notes:", ...notes] : [])].join("\n") };
  });
}

/** The attribute of a spreadsheet cell that holds its value, by the cell's value type. */
const ODS_VALUE_ATTRIBUTE: Record<string, string> = { float: "value", percentage: "value", currency: "value", date: "date-value", time: "time-value", boolean: "boolean-value", string: "string-value" };
function odsCell(tc: Element): Omit<OfficeCell, "ref"> | null {
  const [type, formula, text] = [at(tc, "value-type") ?? "", at(tc, "formula"), named(tc, "p").map(odfInline).join("\n")];
  const stored = at(tc, ODS_VALUE_ATTRIBUTE[type] ?? "") ?? (text || null);
  const value: Cell["value"] = stored === null ? null : type === "boolean" ? stored === "true" : ODS_VALUE_ATTRIBUTE[type] === "value" ? number(stored) : stored;
  if (formula === null && (value === null || value === "")) return null;
  return { value, ...(formula === null ? {} : { formula: formula.slice(formula.indexOf("=") + 1), cached: value !== null }) };
}

async function ods(a: Archive, limits: OfficeLimits, wanted: Wanted): Promise<Sheet[]> {
  const content = await a.part("content.xml");
  if (!content) throw unreadable("an OpenDocument file without content.xml");
  const sheets: Sheet[] = [];
  let count = 0;
  for (const [index, table] of named(dig(content, "spreadsheet"), "table").entries()) {
    const name = at(table, "name") ?? `Sheet${index + 1}`;
    if (!wanted(index, name)) continue;
    const cells: OfficeCell[] = [];
    let row = 0;
    for (const tr of tableRows(table)) {
      const here: { column: number; times: number; cell: Omit<OfficeCell, "ref"> }[] = [];
      let column = 0;
      for (const tc of named(tr, "table-cell", "covered-table-cell")) {
        const times = repeats(tc, "number-columns-repeated", MAX_SHEET_COLUMNS);
        const cell = tc.localName === "table-cell" ? odsCell(tc) : null;
        if (cell) here.push({ column, times, cell });
        column += times;
      }
      const rowTimes = repeats(tr, "number-rows-repeated", MAX_SHEET_ROWS);
      for (let r = 0; r < (here.length ? rowTimes : 0); r++) for (const { column: c, times, cell } of here) for (let i = 0; i < times; i++) {
        if (++count > limits.maxCells) throw tooManyCells(limits, `the sheet ${name}`);
        cells.push({ ref: `${columnName(c + i)}${row + r + 1}`, ...cell });
      }
      row += rowTimes;
    }
    sheets.push({ index, name, hidden: at(table, "display") === "false", cells });
  }
  return sheets;
}

type Format = "docx" | "pptx" | "xlsx" | "odt" | "odp" | "ods" | "rtf";
/** The word of an OpenDocument media type that names its kind, tried in this order. */
const OPEN_DOCUMENT = [["spreadsheet", "ods"], ["presentation", "odp"], ["text", "odt"]] as const;
const OPEN_DOCUMENT_TYPE = "application/vnd.oasis.opendocument.";
const FORMATS = "docx, pptx, xlsx, odt, odp, ods and rtf";
const ARCHIVE_FORMATS = "docx, pptx, xlsx, odt, odp or ods";

type Source = { readonly format: Format; readonly archive?: Archive; readonly rtf?: string };
async function openSource(source: ProviderSource, call: ProviderCall, limits: OfficeLimits): Promise<Source> {
  const data = await readSource(source, call);
  if (Buffer.from(data.subarray(0, 5)).toString("latin1") === "{\\rtf") {
    if (data.length > limits.maxPartBytes) throw new OfficeMissError("over_budget", `the RTF source is ${mib(data.length)}, over the ${mib(limits.maxPartBytes)} the reader takes; read it with bash`);
    return { format: "rtf", rtf: new TextDecoder().decode(data) };
  }
  const magic = hex(data.subarray(0, 4));
  if (magic.startsWith("504b")) {
    const archive = await openArchive(data, call, limits);
    const names = new Set(archive.names());
    const mime = new TextDecoder().decode(archive.raw("mimetype") ?? new Uint8Array());
    const found = names.has("word/document.xml") ? "docx" : names.has("ppt/presentation.xml") ? "pptx" : names.has("xl/workbook.xml") ? "xlsx" : OPEN_DOCUMENT.find(([word]) => mime.startsWith(OPEN_DOCUMENT_TYPE) && mime.includes(word))?.[1];
    if (!found) throw new OfficeMissError("unsupported", `a zip archive that is not a ${ARCHIVE_FORMATS} file (its first entries: ${[...names].slice(0, 3).join(", ") || "none"})`);
    return { format: found, archive };
  }
  throw new OfficeMissError("unsupported", `${magic === "d0cf11e0" ? "a legacy binary Office file or an encrypted package" : "not an office document"} (first bytes ${magic}); the reader takes ${FORMATS}${magic === "d0cf11e0" ? ", and LibreOffice converts the older formats" : ""}`);
}

/** A failure that is not a typed miss becomes one: a damaged part, a document nested past the stack, anything the
 *  parser threw. A cancellation stays a cancellation. */
async function guarded<T>(call: ProviderCall, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (call.signal?.aborted) throw call.signal.reason ?? error;
    if (error instanceof OfficeMissError) throw error;
    throw unreadable(`the file could not be read: ${String((error as Error)?.message ?? error).split("\n")[0]}`);
  }
}

export type OfficeJsOptions = { readonly limits?: Partial<OfficeLimits> };

/** The zero-install office reader: `text` for documents and presentations (a slide is a page) and for spreadsheets (a
 *  sheet is a page), `cells` for spreadsheets. */
export function officeJsProvider(options: OfficeJsOptions = {}): Provider {
  const limits: OfficeLimits = { ...OFFICE_LIMITS, ...options.limits };
  const madeBy = { provider: "office-js", version: READER_VERSION };
  return {
    name: "office-js",
    capabilities: ["text", "cells"],
    kinds: ["office", "sheet"],
    async detect() {
      try {
        await loadDeps();
        return { available: true, version: READER_VERSION };
      } catch (error) {
        deps = undefined;
        return { available: false, needs: "fflate and @xmldom/xmldom", reason: `they did not load: ${String((error as Error)?.message ?? error).split("\n")[0]}` };
      }
    },
    text: (source, request, call) => guarded(call, async () => {
      const { format, archive, rtf } = await openSource(source, call, limits);
      const wanted: Wanted = (index) => within(index + 1, request.pages);
      const sheetPages = (sheets: Sheet[]) => sheets.map((s) => ({ page: s.index + 1, text: sheetText(s.name, s.cells, s.hidden) }));
      const pages = format === "rtf" ? [{ page: 1, text: rtf! }]
        : format === "docx" ? await docx(archive!)
        : format === "pptx" ? await pptx(archive!, request.pages)
        : format === "xlsx" ? sheetPages(await xlsx(archive!, limits, wanted))
        : format === "ods" ? sheetPages(await ods(archive!, limits, wanted))
        : await odf(archive!, format);
      return { madeBy, pages: pages.filter((p) => within(p.page, request.pages)) };
    }),
    cells: (source, request, call) => guarded(call, async () => {
      const { format, archive } = await openSource(source, call, limits);
      if (format !== "xlsx" && format !== "ods") throw new OfficeMissError("unsupported", `cells are read from a spreadsheet, and this is ${format === "rtf" ? "an rtf" : `a ${format}`} file`);
      const sheets = await (format === "xlsx" ? xlsx : ods)(archive!, limits, (_, name) => request.sheet === undefined || request.sheet === name);
      if (request.sheet !== undefined && !sheets.length) throw new OfficeMissError("unsupported", `the workbook has no sheet named ${request.sheet}`);
      return { madeBy, sheets: sheets.map(({ name, cells }) => ({ name, cells })) };
    }),
  };
}
