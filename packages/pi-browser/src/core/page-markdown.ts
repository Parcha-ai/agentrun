// A page's HTML as markdown, in time that grows with the page's length. node-html-markdown is quadratic twice over: it
// appends to one string and reads that string's end after each append, and V8 pays for each read with a copy of the
// whole string (go.dev/dl, 3.15 MB of tables: 300 KB took 1.3 s, 600 KB 8.7 s, the whole did not end in 240 s); and
// the parser under it (node-html-parser) walks a node's siblings each time it appends one, so a table of 8,000 rows
// takes a second to parse, and four more when it is left unclosed and the parser takes it apart. So the page is never
// parsed whole: one linear scan of its tags (tagsOf), with a stack of the elements open, cuts it into pieces of about
// PIECE_CHARS, each converted on its own. A piece is cut before a block element's start tag where every element open
// adds nothing to the markdown (a div, a section); past WIDE_CHARS, also between a list's items or a table's rows, or
// before a <br> outside a table's rows, so a table or a list smaller than a piece is never cut; past FORCE_CHARS, before
// any tag. Each piece starts with the start tags of the elements open around it that put something into the markdown
// (a list, a table, a quote; a table's led by its first row, which a markdown table takes for its header) and ends with
// their end tags, so no piece is ever unclosed. The markdown of a well-formed page in pieces is the one pass's, but for
// the spaces that end a line at a piece's edges; an ordered list in pieces is counted from 1 in each.
import { NodeHtmlMarkdown } from "node-html-markdown";
import { tagsOf } from "./page-scan.js";

export const PIECE_CHARS = 16_384;
/** Past this, a piece is cut between a list's items or a table's rows, or before a `<br>`. */
const WIDE_CHARS = 2 * PIECE_CHARS;
/** Past this, a piece is cut before any tag: what is open is closed around it and reopened after. */
const FORCE_CHARS = 3 * PIECE_CHARS;
const CELLS = new Set(["tr", "td", "th"]);
/** Containers that add nothing of their own to the markdown: never reopened around a piece. */
const NEUTRAL = new Set(["html", "body", "main", "article", "section", "div", "header", "footer", "nav", "aside", "form", "center", "fieldset", "figure", "hgroup", "span", "font", "address", "details"]);
/** Containers a piece may be cut inside, between their children (each reopened around the piece). */
const BETWEEN = new Set(["ul", "ol", "menu", "dl", "blockquote", "table", "thead", "tbody", "tfoot"]);
/** node-html-markdown's block elements: a piece is cut only before one's start tag. */
const BLOCK = new Set(["address", "article", "aside", "audio", "blockquote", "body", "canvas", "center", "dd", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "isindex", "li", "main", "menu", "nav", "noframes", "noscript", "ol", "output", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
/** For a start tag: the open element it ends, if one is open below the nearest of the elements that bound it. */
const ENDS: Record<string, { ends: Set<string>; within: Set<string> }> = {
  li: { ends: new Set(["li"]), within: new Set(["ul", "ol", "menu"]) },
  dt: { ends: new Set(["dt", "dd"]), within: new Set(["dl"]) },
  dd: { ends: new Set(["dt", "dd"]), within: new Set(["dl"]) },
  tr: { ends: new Set(["tr"]), within: new Set(["table", "thead", "tbody", "tfoot"]) },
  td: { ends: new Set(["td", "th"]), within: new Set(["tr", "table"]) },
  th: { ends: new Set(["td", "th"]), within: new Set(["tr", "table"]) },
  thead: { ends: new Set(["thead", "tbody", "tfoot"]), within: new Set(["table"]) },
  tbody: { ends: new Set(["thead", "tbody", "tfoot"]), within: new Set(["table"]) },
  tfoot: { ends: new Set(["thead", "tbody", "tfoot"]), within: new Set(["table"]) },
  option: { ends: new Set(["option"]), within: new Set(["select", "datalist", "optgroup"]) },
  body: { ends: new Set(["head"]), within: new Set(["html"]) },
};
/** How far down the stack an end tag, or a start tag that ends an element, looks for its element. */
const REACH = 64;
/** The most elements reopened around a piece. A start tag longer than MAX_TAG is reopened bare (`<ul>`), and a
 *  table's first row longer than a quarter piece is not repeated. */
const MAX_REOPENED = 32;
const MAX_TAG = 256;

/** An open element: its name and its start tag; for a table, whether its first row has started (`row`) and that row,
 *  once it has ended (`header`); for a table's first row, the table (`rowOf`) and where the row starts (`at`). */
type Open = { name: string; tag: string; row?: true; header?: string; rowOf?: Open; at?: number };

/** `html` in pieces, each well-formed on its own (see the file's head). */
export function piecesOf(html: string): string[] {
  const pieces: string[] = [];
  const stack: Open[] = [];
  /** How many open elements a cut would split (neither NEUTRAL nor BETWEEN); how many are BETWEEN; how many a row or
   *  its cells. */
  let inside = 0;
  let between = 0;
  let cells = 0;
  const count = (name: string, by: number) => {
    if (BETWEEN.has(name)) between += by;
    else if (!NEUTRAL.has(name)) inside += by;
    if (CELLS.has(name)) cells += by;
  };
  let start = 0;
  let opening = "";
  const reopened = () => stack.filter((open) => !NEUTRAL.has(open.name)).slice(-MAX_REOPENED);
  const cut = (at: number) => {
    if (at <= start) return;
    pieces.push(opening + html.slice(start, at) + reopened().reverse().map((open) => `</${open.name}>`).join(""));
    start = at;
    opening = reopened().map((open) => open.tag + (open.header && open.header.length <= PIECE_CHARS / 4 ? open.header : "")).join("");
  };
  /** Ends the elements from `index` up, those above it at `before`, the one at `index` at `after` (past its own end
   *  tag, when that is what ends it). */
  const pop = (index: number, before: number, after: number) => {
    while (stack.length > index) {
      const open = stack.pop()!;
      count(open.name, -1);
      const at = stack.length === index ? after : before;
      // A row its own end tag ended holds that tag; one another tag ended is closed here.
      if (open.rowOf && open.rowOf.header === undefined) open.rowOf.header = html.slice(open.at, at) + (at === after && after !== before ? "" : "</tr>");
    }
  };
  /** The index of the nearest open element `name` (or one in `names`), looking no further down than REACH or an
   *  element in `within`; -1 when there is none. */
  const find = (names: string | ReadonlySet<string>, within?: ReadonlySet<string>) => {
    for (let i = stack.length - 1; i >= Math.max(0, stack.length - REACH); i -= 1) {
      const open = stack[i]!.name;
      if (typeof names === "string" ? open === names : names.has(open)) return i;
      if (within?.has(open)) return -1;
    }
    return -1;
  };
  const next = tagsOf(html);
  for (let tag = next(0); tag && tag.gt >= 0; tag = next(tag.gt + 1)) {
    const { lt, gt, name, end } = tag;
    if (!name) continue;
    if (end) {
      if (lt - start >= FORCE_CHARS) cut(lt);
      const at = find(name);
      if (at >= 0) pop(at, lt, gt + 1);
      continue;
    }
    const rule = ENDS[name];
    if (rule) { const at = find(rule.ends, rule.within); if (at >= 0) pop(at, lt, lt); }
    if (BLOCK.has(name) && stack.at(-1)?.name === "p") pop(stack.length - 1, lt, lt);
    const size = lt - start;
    if (size >= FORCE_CHARS || (BLOCK.has(name) && inside === 0 && size >= (between ? WIDE_CHARS : PIECE_CHARS)) || (name === "br" && cells === 0 && size >= WIDE_CHARS)) cut(lt);
    if (VOID.has(name) || html.charCodeAt(gt - 1) === 47) continue;
    const open: Open = { name, tag: gt - lt <= MAX_TAG ? html.slice(lt, gt + 1) : `<${name}>` };
    if (name === "tr") {
      const table = stack[find("table")];
      if (table && !table.row) { table.row = true; open.rowOf = table; open.at = lt; }
    }
    stack.push(open);
    count(name, 1);
  }
  cut(html.length);
  return pieces;
}

/** `html` as markdown, a piece at a time (see the file's head). */
export function markdownOf(html: string): string {
  const converter = new NodeHtmlMarkdown({ keepDataImages: false });
  const parts: string[] = [];
  for (const piece of piecesOf(html)) {
    const markdown = converter.translate(piece).replace(/^\n+|\n+$/g, "");
    if (markdown.trim()) parts.push(markdown);
  }
  return parts.join("\n\n").trim();
}
