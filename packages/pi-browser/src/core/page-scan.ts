// The readings of an HTML page that need no DOM: the page without the blocks that hold no readable text, the page cut
// to a length, and one pass over its tags for its title, its links and its plain text. Each is linear in the page's
// length whatever its markup (a page with no ">" after a "<", a thousand unclosed scripts): a scan with indexOf, or a
// pattern whose every try is bounded by the next character it can stop at. read-page.ts runs them on the event loop;
// its worker runs the scan for the title and links.

/** An entity decoder for a run of text or an attribute value: node-html-parser's in the worker, entities.ts's on the
 *  event loop. */
export type Decode = (text: string) => string;

const INERT = /<(script|style|svg|noscript|template)(?=[\s/>])|<!--/gi;
const CLOSER: Record<string, RegExp> = Object.fromEntries(["script", "style", "svg", "noscript", "template"].map((name) => [name, new RegExp(`</${name}(?=[\\s/>])[^>]*>?`, "gi")]));

/** A page without its script, style, svg, noscript and template elements and its comments, in steps so a caller on the
 *  event loop can yield between them (dropInert, all at once). One whose end is missing runs to the end of the page, as
 *  a browser reads it; but an svg's start tag goes alone, since a browser lets the HTML that follows out of an unclosed
 *  svg. A nested svg or template ends at the first end tag of its name. A search for an end tag that finds none is not
 *  made again from a later start of that name (none follows it either), so a page of unclosed svgs is read once, not
 *  once for each. */
export class InertDrop {
  readonly #inert = new RegExp(INERT.source, INERT.flags);
  readonly #unclosed = new Map<string, number>();
  readonly #kept: string[] = [];
  #at = 0;
  #done = false;

  constructor(readonly html: string) {}

  /** Drops the blocks found in the next `chars` characters or so; true once the whole page is read. */
  step(chars: number): boolean {
    const { html } = this;
    const until = this.#at + chars;
    while (!this.#done && this.#at < until) {
      const inert = this.#inert;
      inert.lastIndex = this.#at;
      const found = inert.exec(html);
      if (!found) { this.#kept.push(html.slice(this.#at)); this.#done = true; break; }
      this.#kept.push(html.slice(this.#at, found.index));
      let end: number;
      if (found[0] === "<!--") {
        // "<!-->" and "<!--->" are whole comments too.
        const close = html.indexOf("-->", found.index + 2);
        end = close < 0 ? html.length : close + 3;
      } else {
        const name = found[1]!.toLowerCase();
        const from = found.index + found[0].length;
        let close: RegExpExecArray | null = null;
        if (from < (this.#unclosed.get(name) ?? Number.POSITIVE_INFINITY)) {
          const closer = CLOSER[name]!;
          closer.lastIndex = from;
          close = closer.exec(html);
          if (!close) this.#unclosed.set(name, from);
        }
        end = close ? close.index + close[0].length : name === "svg" ? (html.indexOf(">", found.index) + 1 || html.length) : html.length;
      }
      this.#at = end;
      if (end >= html.length) this.#done = true;
    }
    return this.#done;
  }

  /** The page as dropped so far (the whole of it once step has answered true). */
  result(): string { return this.#kept.length === 1 ? this.#kept[0]! : this.#kept.join(""); }
}

/** `html` without its inert blocks, all at once (see InertDrop). */
export function dropInert(html: string): string {
  const drop = new InertDrop(html);
  drop.step(Number.POSITIVE_INFINITY);
  return drop.result();
}

/** `html` cut to at most `max` characters, after the last tag that ends before the cut, so no tag is left half; at
 *  `max` itself when that tag ends more than 64 KiB before it (a page of one long text). */
export function cutHtml(html: string, max: number): string {
  if (html.length <= max) return html;
  const gt = html.lastIndexOf(">", max - 1);
  return html.slice(0, gt >= 0 && max - gt <= 65_536 ? gt + 1 : max);
}

/** Tags whose start and end each begin a paragraph of the plain text; LINES, a line; CELLS, a cell of a row. */
const BLOCKS = new Set(["address", "article", "aside", "blockquote", "body", "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "tbody", "tfoot", "thead", "ul"]);
const LINES = new Set(["br", "caption", "dd", "dt", "figcaption", "legend", "li", "option", "summary", "tr"]);
const CELLS = new Set(["td", "th"]);
const CELL = "\u0000";
const NAME = /[a-zA-Z][a-zA-Z0-9:-]*/y;

/** A tag in a page: `lt` and `gt` the offsets of its "<" and ">", `name` lowercase ("" for a declaration, a comment
 *  or an instruction), `end` for an end tag; `gt` is -1 for a "<" that starts a tag with no ">" after it. */
export type Tag = { lt: number; gt: number; name: string; end: boolean };

/** The next tag from `at`: "<" then a letter starts one, "</" an end tag, "<!" a declaration and "<?" an
 *  instruction; any other "<" is text, and passed. Null when none is left. */
export function nextTag(html: string, at: number): Tag | null {
  for (let lt = html.indexOf("<", at); lt >= 0; lt = html.indexOf("<", lt + 1)) {
    const next = html.charCodeAt(lt + 1);
    const letter = (next | 32) >= 97 && (next | 32) <= 122;
    const end = next === 47;
    if (!letter && !end && next !== 33 && next !== 63) continue;
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) return { lt, gt: -1, name: "", end: false };
    if (!letter && !end) return { lt, gt, name: "", end: false };
    NAME.lastIndex = end ? lt + 2 : lt + 1;
    return { lt, gt, name: NAME.exec(html)?.[0].toLowerCase() ?? "", end };
  }
  return null;
}
const ATTRS: Record<string, RegExp> = { href: /\shref\s*=\s*/i, src: /\ssrc\s*=\s*/i };
const TITLE_END = /<\/title(?=[\s/>])/gi;
const quotes = new Set(['"', "'"]);

/** The value of the first `name` attribute (href or src) in a tag's inside (`a href="..."`), decoded; null when it has
 *  none. */
function attrOf(inside: string, name: "href" | "src", decode: Decode): string | null {
  const found = ATTRS[name]!.exec(inside);
  if (!found) return null;
  const from = found.index + found[0].length;
  const quote = inside[from]!;
  let value: string;
  if (quotes.has(quote)) {
    const close = inside.indexOf(quote, from + 1);
    value = inside.slice(from + 1, close < 0 ? inside.length : close);
  } else {
    const space = inside.slice(from).search(/[\s>]/);
    value = inside.slice(from, space < 0 ? inside.length : from + space);
  }
  return value.includes("&") ? decode(value) : value;
}
/** What a tag at `lt` named `name` holds between its name and its ">" at `gt`. */
const insideOf = (html: string, name: string, lt: number, gt: number) => html.slice(lt + 1 + name.length, gt);

const MAIN = ["article", "main", "body"] as const;
/** The first article element of `html`, else its first main, else its body, as HTML from its start tag to its end tag
 *  (or the page's end); the whole of `html` when it has none of them. One pass: an element of the same name inside one
 *  is counted, so its end tag does not end the one around it. Run on a page its inert blocks are dropped from, so
 *  none is picked from inside a script or a comment. */
export function mainOf(html: string): string {
  const found = new Map<string, { from: number; depth: number; to?: number }>();
  for (let tag = nextTag(html, 0); tag && tag.gt >= 0; tag = nextTag(html, tag.gt + 1)) {
    if (!(MAIN as readonly string[]).includes(tag.name)) continue;
    const element = found.get(tag.name);
    if (!tag.end) {
      if (!element) found.set(tag.name, { from: tag.lt, depth: 1 });
      else if (element.to === undefined) element.depth += 1;
    } else if (element && element.to === undefined && (element.depth -= 1) === 0) {
      element.to = tag.gt + 1;
      if (tag.name === "article") break;
    }
  }
  for (const name of MAIN) {
    const element = found.get(name);
    if (element) return html.slice(element.from, element.to ?? html.length);
  }
  return html;
}

/** One pass over a page's tags for its frames, in steps so a caller on the event loop can yield between them: each
 *  `iframe` element's, and each `frame` element's inside a `frameset` (a `<frame>` outside one is no element, as in a
 *  browser), `src` (decoded; null without one), in page order, with the text inside an iframe element (the fallback a
 *  browser does not render, where a block page keeps its message: its tags skipped, its entities decoded, read up to
 *  `readChars` characters); and the page's first `<base href>`. Inside an iframe element, only its end tag is a tag. */
export class FrameScan {
  #at = 0;
  #frameset = 0;
  #base: string | null = null;
  #open: { src: string | null; text: string[]; read: number } | null = null;
  readonly #frames: Array<{ src: string | null; text: string }> = [];

  constructor(readonly html: string, readonly decode: Decode, readonly readChars: number) {}

  get done(): boolean { return this.#at >= this.html.length; }

  /** Scans the tags that start in the next `chars` characters (see PageScan.step). */
  step(chars: number): boolean {
    const { html } = this;
    const until = Math.min(html.length, this.#at + chars);
    while (this.#at < until) {
      const tag = nextTag(html, this.#at);
      if (!tag) { this.#words(html.slice(this.#at)); this.#at = html.length; break; }
      this.#words(html.slice(this.#at, tag.lt));
      if (tag.gt < 0) { this.#at = html.length; break; }
      this.#at = tag.gt + 1;
      const { name, end, lt, gt } = tag;
      if (this.#open) { if (end && name === "iframe") this.#close(); continue; }
      if (name === "frameset") this.#frameset = Math.max(0, this.#frameset + (end ? -1 : 1));
      else if (end) continue;
      else if (name === "base" && this.#base === null) this.#base = attrOf(insideOf(html, name, lt, gt), "href", this.decode);
      else if (name === "iframe") this.#open = { src: attrOf(insideOf(html, name, lt, gt), "src", this.decode), text: [], read: 0 };
      else if (name === "frame" && this.#frameset > 0) this.#frames.push({ src: attrOf(insideOf(html, name, lt, gt), "src", this.decode), text: "" });
    }
    if (this.done && this.#open) this.#close();
    return this.done;
  }

  #words(raw: string): void {
    const open = this.#open;
    if (!open || !raw || open.read >= this.readChars) return;
    const part = raw.slice(0, this.readChars - open.read);
    open.read += part.length;
    open.text.push(part.includes("&") ? this.decode(part) : part);
  }

  #close(): void {
    this.#frames.push({ src: this.#open!.src, text: this.#open!.text.join("") });
    this.#open = null;
  }

  /** The frames scanned, and the first base href (null without one). */
  result(): { frames: Array<{ src: string | null; text: string }>; base: string | null } {
    return { frames: [...this.#frames], base: this.#base };
  }
}

/** One pass over a page's tags, in steps so a caller on the event loop can yield between them: its title (the first
 *  title element's), the http(s) URLs its `a` elements link to (each resolved against the page's first `<base href>`,
 *  or `url`, without its fragment, once, in page order) and, when asked for, its plain text: the text between its tags,
 *  entities decoded and whitespace collapsed, a block's start and end a paragraph, a row's start or a `br` a line, and a
 *  row's cells joined with " | ". A "<" that starts no tag is text (nextTag); one with no ">" after it ends the page. */
export class PageScan {
  #at = 0;
  #title: string | null = null;
  #base: string | null = null;
  readonly #hrefs: string[] = [];
  readonly #text: string[] | null;

  constructor(readonly html: string, readonly url: string, readonly decode: Decode, withText: boolean) {
    this.#text = withText ? [] : null;
  }

  /** Whether the whole page is scanned. */
  get done(): boolean { return this.#at >= this.html.length; }

  /** Scans the tags that start in the next `chars` characters (a tag that starts in them is read whole). */
  step(chars: number): boolean {
    const { html } = this;
    const until = Math.min(html.length, this.#at + chars);
    while (this.#at < until) {
      const tag = nextTag(html, this.#at);
      if (!tag) { this.#words(html.slice(this.#at)); this.#at = html.length; break; }
      this.#words(html.slice(this.#at, tag.lt));
      if (tag.gt < 0) { this.#at = html.length; break; }
      this.#at = tag.gt + 1;
      if (tag.name) this.#tag(tag.name, tag.end, tag.lt, tag.gt);
    }
    return this.done;
  }

  #tag(name: string, end: boolean, lt: number, gt: number): void {
    const text = this.#text;
    if (text) {
      if (BLOCKS.has(name)) text.push("\n\n");
      else if (LINES.has(name)) text.push("\n");
      else if (CELLS.has(name) && !end) text.push(CELL);
    }
    if (end) return;
    if (name === "a" || (name === "base" && this.#base === null)) {
      const href = attrOf(insideOf(this.html, name, lt, gt), "href", this.decode);
      if (href === null) return;
      if (name === "a") this.#hrefs.push(href);
      else this.#base = href;
    } else if (name === "title" && this.#title === null) {
      // The first title's text is the page's title, never its text: it is read up to its end tag, and the scan goes on
      // there. Only the first is looked for (once), so a page of unclosed titles is not searched to its end at each.
      TITLE_END.lastIndex = gt + 1;
      const close = TITLE_END.exec(this.html);
      const stop = close ? close.index : this.html.indexOf("<", gt + 1);
      this.#title = this.decode(this.html.slice(gt + 1, stop < 0 ? this.html.length : stop)).trim();
      if (close) this.#at = Math.max(this.#at, close.index);
    }
  }

  #words(raw: string): void {
    if (!this.#text || !raw) return;
    // A NUL is a space here: it would read as CELL.
    this.#text.push((raw.includes("&") ? this.decode(raw) : raw).replace(/[\s\u0000]+/g, " "));
  }

  /** The title, the links and the plain text ("" when it was not asked for) of what was scanned. */
  result(): { title: string; links: string[]; text: string } {
    let base = this.url;
    if (this.#base !== null) { try { base = new URL(this.#base, this.url).href; } catch { /* a base that does not parse: the page's own URL stands */ } }
    const links = new Set<string>();
    for (const href of this.#hrefs) {
      const link = URL.parse(href, base);
      if (!link || !/^https?:$/.test(link.protocol)) continue;
      link.hash = "";
      links.add(link.href);
    }
    const text = this.#text ? this.#text.join("")
      .replace(/ {2,}/g, " ")
      .replace(/(^|\n) ?\u0000/g, "$1")
      .replace(/ ?\u0000 ?/g, " | ")
      .replace(/ {2,}/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() : "";
    return { title: this.#title ?? "", links: [...links], text };
  }
}
