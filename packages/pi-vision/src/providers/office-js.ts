// Office documents with nothing installed, read by the package's own reader on fflate and @xmldom/xmldom: the text of
// docx and odt, the slides of pptx and odp in order with their notes, and the cells of xlsx and ods with value, formula
// and stored value, a formula with no stored value said, not dropped. RTF reads as its source text. A file is
// recognised by what it holds, never by its name. Every archive is held to the limits before anything is inflated and
// every part is inflated into a bounded buffer, so a hostile file is a typed miss that costs bounded time and memory.
import type { Element } from "@xmldom/xmldom";
import { OFFICE_LIMITS, OfficeMissError, cellText, inflateEntry, readSource, sheetText, zipDirectory, type OfficeCell, type OfficeLimits } from "../core/office.js";
import type { Cell, Provider, ProviderCall, ProviderSource } from "../core/provider.js";

/** The reader's output version: it changes whenever the text or the cells it writes change, so a derivation cached
 *  under an older one is never reused. */
const READER_VERSION = "1";
/** Word allows 63 columns in a table, and Word and LibreOffice 16,384 columns and 1,048,576 rows in a sheet: a span or repeat count past these is read as these. */
const MAX_TABLE_COLUMNS = 63;
const MAX_SHEET_COLUMNS = 16_384;
const MAX_SHEET_ROWS = 1_048_576;
/** Levels of a list in Word, of headings in Markdown, and the longest run of spaces an OpenDocument paragraph declares by count. */
const MAX_LIST_LEVEL = 8;
/** Word's own limit on the number a list starts at. */
const MAX_LIST_START = 32_767;
const MAX_HEADING = 6;
const SPACE_RUN = 80;

let xmldom: Promise<typeof import("@xmldom/xmldom")> | undefined;
const loadXmldom = () => (xmldom ??= Promise.all([import("fflate"), import("@xmldom/xmldom")]).then(([, loaded]) => loaded));

type El = Element | null | undefined;
type Page = { readonly page: number; readonly text: string };
type Sheet = { readonly index: number; readonly name: string; readonly hidden: boolean; readonly cells: OfficeCell[] };
type Span = { readonly from: number; readonly to: number };
type Relationship = { readonly type: string; readonly target: string };
type Level = { readonly format: string; readonly start: number };
type Wanted = (index: number, name: string) => boolean;
type Archive = {
  names(): string[];
  raw(name: string): Promise<Uint8Array | null>;
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

async function openArchive(data: Uint8Array, call: ProviderCall, limits: OfficeLimits): Promise<Archive> {
  const parser = await loadXmldom();
  const entries = new Map(zipDirectory(data, limits).map((entry) => [entry.name, entry]));
  let parsed = 0;
  const raw = async (name: string) => {
    const entry = entries.get(name);
    return entry ? inflateEntry(data, entry, limits.maxPartBytes) : null;
  };
  const part = async (name: string): Promise<Element | null> => {
    call.signal?.throwIfAborted();
    const bytes = await raw(name);
    if (!bytes) return null;
    if ((parsed += bytes.length) > limits.maxParsedBytes) throw new OfficeMissError("over_budget", `the parts of this file pass ${mib(limits.maxParsedBytes)}, the most the reader parses in one read; read it with bash`);
    await new Promise((done) => setImmediate(done));
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    const xml = new TextDecoder(encoding).decode(bytes);
    let elements = 0;
    for (let tag = xml.indexOf("<"); tag >= 0; tag = xml.indexOf("<", tag + 1)) if (![47, 33, 63].includes(xml.charCodeAt(tag + 1))) elements++;
    if (elements > limits.maxElements) throw new OfficeMissError("over_budget", `${name} holds ${elements} elements, over the ${limits.maxElements} the reader takes of one part; read it with bash`);
    const root = new parser.DOMParser({ locator: false, onError: parser.onErrorStopParsing }).parseFromString(xml, "text/xml").documentElement;
    const open: [Element, number][] = root ? [[root, 1]] : [];
    for (let at = open.pop(); at; at = open.pop()) {
      if (at[1] > limits.maxDepth) throw new OfficeMissError("over_budget", `${name} nests more than ${limits.maxDepth} levels deep, more than the reader walks; read it with bash`);
      for (let node = at[0].firstChild; node; node = node.nextSibling) if (node.nodeType === 1) open.push([node as Element, at[1] + 1]);
    }
    return root;
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
      case "AlternateContent": out += inline(chosen(k)); break;
      case "pPr": case "rPr": case "endParaRPr": case "del": case "instrText": case "rPh": break;
      default: out += inline(k);
    }
  }
  return out;
}
const tableRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
/** Of the alternatives a package offers for one thing (`mc:AlternateContent`), the first one it prefers, else its fallback: never both. */
const chosen = (el: El) => first(el, "Choice") ?? first(el, "Fallback");

/** The characters a document's text may grow to, the part cap: every line is charged as it is built, and what a table
 *  repeats (a cell by its column count, a row by its row count) before it is, so neither long list labels nor tables
 *  nested in tables can multiply the text past it. */
type TextBudget = { left: number };
function spend(budget: TextBudget, chars: number): void {
  if ((budget.left -= chars) < 0) throw new OfficeMissError("over_budget", "the text of this file grows past what the reader builds; read it with bash");
}

/** A word document as one page: headers, the body in reading order, then footers. A list item carries its marker: `-` for a
 *  bullet and for any numbering the reader does not count (roman, ordinal), `1.` and `a.` for decimal and letter numbering,
 *  counted per list and level. A table row is `| a | b |`, a cell's paragraphs joined by ` / `, a merged cell followed by
 *  the empty cells it spans. Inserted text is kept, deleted text is not. */
async function docx(a: Archive, limits: OfficeLimits): Promise<Page[]> {
  const [body, numbering] = [await a.part("word/document.xml"), await a.part("word/numbering.xml")];
  if (!body) throw unreadable("a word document without word/document.xml");
  const levels = new Map(named(numbering, "abstractNum").map((n): [string, Map<string, Level>] => [at(n, "abstractNumId") ?? "", new Map(named(n, "lvl").map((l): [string, Level] => [at(l, "ilvl") ?? "0", { format: at(first(l, "numFmt"), "val") ?? "decimal", start: Math.max(1, int(at(first(l, "start"), "val"), 1, MAX_LIST_START)) }]))]));
  const lists = new Map(named(numbering, "num").map((n): [string, Map<string, Level>] => {
    const own = new Map(levels.get(at(first(n, "abstractNumId"), "val") ?? ""));
    for (const o of named(n, "lvlOverride")) {
      const [key, start] = [at(o, "ilvl") ?? "0", at(first(o, "startOverride"), "val")];
      if (start !== null && own.has(key)) own.set(key, { ...own.get(key)!, start: Math.max(1, int(start, 1, MAX_LIST_START)) });
    }
    return [at(n, "numId") ?? "", own];
  }));
  const counts = new Map<string, number>();
  const budget = { left: limits.maxPartBytes };
  const marker = (p: Element) => {
    const num = first(first(p, "pPr"), "numPr");
    const id = at(first(num, "numId"), "val");
    if (id === null || id === "0") return "";
    const depth = int(at(first(num, "ilvl"), "val"), 0, MAX_LIST_LEVEL);
    const indent = "  ".repeat(depth);
    const { format, start } = lists.get(id)?.get(String(depth)) ?? { format: "bullet", start: 1 };
    if (format !== "decimal" && !format.endsWith("Letter")) return `${indent}- `;
    for (const key of [...counts.keys()]) if (key.startsWith(`${id}:`) && Number(key.split(":")[1]) > depth) counts.delete(key);
    const n = (counts.get(`${id}:${depth}`) ?? start - 1) + 1;
    counts.set(`${id}:${depth}`, n);
    return `${indent}${format === "decimal" ? n : String.fromCharCode((format.startsWith("upper") ? 65 : 97) + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1)}. `;
  };
  const blocks = (el: El, out: string[]): string[] => {
    for (const k of kids(el)) {
      if (k.localName === "p") {
        const style = at(first(first(k, "pPr"), "pStyle"), "val") ?? "";
        const heading = style === "Title" ? 1 : style.startsWith("Heading") ? Math.max(1, int(style.slice(7), 1, MAX_HEADING)) : 0;
        const text = inline(k).trim();
        const line = text && `${heading ? `${"#".repeat(heading)} ` : marker(k)}${text}`;
        if (line) { spend(budget, line.length); out.push(line); }
      } else if (k.localName === "tbl") {
        for (const tr of named(k, "tr")) {
          const row = tableRow(named(tr, "tc").flatMap((tc) => [blocks(tc, []).join(" / "), ...Array<string>(Math.max(1, int(at(first(first(tc, "tcPr"), "gridSpan"), "val"), 1, MAX_TABLE_COLUMNS)) - 1).fill("")]));
          spend(budget, row.length);
          out.push(row);
        }
      } else blocks(k.localName === "AlternateContent" ? chosen(k) : k, out);
    }
    return out;
  };
  const related = await a.rels("word/document.xml");
  const side = async (kind: "header" | "footer") => {
    const texts = new Set<string>();
    for (const rel of related.values()) if (rel.type.endsWith(`/${kind}`)) texts.add(blocks(await a.part(rel.target), []).join("\n"));
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
      } else lines(k.localName === "AlternateContent" ? chosen(k) : k, skip, out);
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

type DateKind = "date" | "time" | "datetime";
/** The built-in number formats that show a date or a time of day. Elapsed time (46) and the East Asian formats (27 to 36, 50 to 58) are left unannotated. */
const BUILTIN_DATE_KINDS: Partial<Record<number, DateKind>> = { 14: "date", 15: "date", 16: "date", 17: "date", 18: "time", 19: "time", 20: "time", 21: "time", 22: "datetime", 45: "time", 47: "time" };
/** What a custom number format code shows: a date letter (d, y, or m with no time letter beside it) or a time letter (h, s) outside its quotes, brackets and escapes; elapsed time in brackets is neither. */
function formatKind(code: string): DateKind | undefined {
  if (/\[[hms]+\]/i.test(code)) return undefined;
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, "");
  const time = /[hs]/i.test(bare);
  const date = /[dy]/i.test(bare) || (!time && /m/i.test(bare));
  return date && time ? "datetime" : date ? "date" : time ? "time" : undefined;
}
/** The cell styles whose number format shows a date, a time or both, by style index. */
function dateStyles(styles: El): Map<number, DateKind> {
  const codes = new Map(named(first(styles, "numFmts"), "numFmt").map((n): [number, string] => [Number(at(n, "numFmtId")), at(n, "formatCode") ?? ""]));
  return new Map(named(first(styles, "cellXfs"), "xf").flatMap((xf, index): [number, DateKind][] => {
    const id = Number(at(xf, "numFmtId") ?? 0);
    const kind = BUILTIN_DATE_KINDS[id] ?? formatKind(codes.get(id) ?? "");
    return kind ? [[index, kind]] : [];
  }));
}
/** A serial date as ISO text, as much of it as its format shows: the date, the time of day, or both; nothing for a serial no date has.
 *  Excel counts a 29 February 1900 that never was, so its serials before 60 are one day past the 30 December 1899 epoch. */
function isoDate(serial: number, kind: DateKind, from1904: boolean): string | undefined {
  if (!(serial >= 0 && serial < 2_958_466)) return undefined;
  if (kind === "time") return new Date(Math.round((serial % 1) * 86_400) * 1000).toISOString().slice(11, 19);
  const iso = new Date((from1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, serial < 60 ? 31 : 30)) + Math.round(serial * 86_400) * 1000).toISOString();
  return kind === "date" ? iso.slice(0, 10) : iso.slice(0, 19);
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
  const rendered = { left: limits.maxParsedBytes };
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
      const stored = type === "inlineStr" ? first(c, "is") !== null : v !== null && (text !== "" || type === "str");
      const value: Cell["value"] = !stored ? null : type === "s" ? (table[Number(text)] ?? null) : type === "b" ? text === "1" : type === "n" ? number(text) : text;
      let formula: string | undefined;
      if (f) {
        let source = f.textContent ?? "";
        const id = at(f, "t") === "shared" ? at(f, "si") : null;
        if (id !== null && source) shared.set(id, { ref, text: source });
        else if (id !== null && shared.has(id)) source = `${shared.get(id)!.text} (shared from ${shared.get(id)!.ref})`;
        formula = source || "(formula text not stored)";
      } else if (value === null || value === "") continue;
      if (++count > limits.maxCells) throw tooManyCells(limits, "the workbook");
      const kind = typeof value === "number" ? dates.get(Number(at(c, "s") ?? 0)) : undefined;
      const date = kind ? isoDate(value as number, kind, from1904) : undefined;
      const cell: OfficeCell = { ref, value, ...(formula === undefined ? {} : { formula, cached: value !== null }), ...(date ? { date } : {}) };
      spend(rendered, cellText(cell).length);
      cells.push(cell);
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

function odfBlocks(el: El, depth: number, out: string[], budget: TextBudget): string[] {
  for (const k of kids(el)) {
    switch (k.localName) {
      case "p": case "h": {
        const line = k.localName === "h" ? `${"#".repeat(Math.max(1, int(at(k, "outline-level"), 1, MAX_HEADING)))} ${odfInline(k)}` : odfInline(k);
        spend(budget, line.length);
        out.push(line);
        break;
      }
      case "list":
        for (const item of named(k, "list-item", "list-header")) {
          const lines = odfBlocks(item, depth + 1, [], budget);
          if (lines.length) lines[0] = `${"  ".repeat(depth)}- ${lines[0]}`;
          out.push(...lines);
        }
        break;
      case "table":
        for (const tr of tableRows(k)) {
          const cells = named(tr, "table-cell", "covered-table-cell").flatMap((tc) => Array<string>(repeats(tc, "number-columns-repeated", MAX_TABLE_COLUMNS)).fill(odfBlocks(tc, 0, [], budget).join(" / ")));
          while (cells.at(-1) === "") cells.pop();
          const times = repeats(tr, "number-rows-repeated", MAX_SHEET_ROWS);
          if (!cells.length) continue;
          spend(budget, cells.reduce((chars, cell) => chars + cell.length + 3, 4) * times);
          const row = tableRow(cells);
          for (let i = 0; i < times; i++) out.push(row);
        }
        break;
      case "tracked-changes": case "annotation": case "notes": break;
      default: odfBlocks(k, depth, out, budget);
    }
  }
  return out;
}

async function odf(a: Archive, format: "odt" | "odp", limits: OfficeLimits): Promise<Page[]> {
  const content = await a.part("content.xml");
  if (!content) throw unreadable("an OpenDocument file without content.xml");
  const budget = { left: limits.maxPartBytes };
  const lines = (el: El) => odfBlocks(el, 0, [], budget).filter((line) => line.trim());
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
  const rendered = { left: limits.maxParsedBytes };
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
        const placed: OfficeCell = { ref: `${columnName(c + i)}${row + r + 1}`, ...cell };
        spend(rendered, cellText(placed).length);
        cells.push(placed);
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
    const mime = new TextDecoder().decode((await archive.raw("mimetype")) ?? new Uint8Array());
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

/** Limits over the archive limits of `OFFICE_LIMITS`; a field left out keeps its default. */
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
        await loadXmldom();
        return { available: true, version: READER_VERSION };
      } catch (error) {
        xmldom = undefined;
        return { available: false, needs: "fflate and @xmldom/xmldom", reason: `they did not load: ${String((error as Error)?.message ?? error).split("\n")[0]}` };
      }
    },
    text: (source, request, call) => guarded(call, async () => {
      const { format, archive, rtf } = await openSource(source, call, limits);
      const wanted: Wanted = (index) => within(index + 1, request.pages);
      const sheetPages = (sheets: Sheet[]) => sheets.map((s) => ({ page: s.index + 1, text: sheetText(s.name, s.cells, s.hidden) }));
      const pages = format === "rtf" ? [{ page: 1, text: rtf! }]
        : format === "docx" ? await docx(archive!, limits)
        : format === "pptx" ? await pptx(archive!, request.pages)
        : format === "xlsx" ? sheetPages(await xlsx(archive!, limits, wanted))
        : format === "ods" ? sheetPages(await ods(archive!, limits, wanted))
        : await odf(archive!, format, limits);
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
