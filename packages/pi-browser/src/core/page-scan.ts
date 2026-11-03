// The readings of an HTML page that need no DOM: the page without the blocks that hold no readable text, the page cut
// to a length, and one pass over its tags for its title, its links and its plain text. Each is linear in the page's
// length whatever its markup (a page with no ">" after a "<", a thousand unclosed scripts): a scan with indexOf, or a
// pattern whose every try is bounded by the next character it can stop at. read-page.ts runs them on the event loop;
// its worker runs the scan for the title and links.

/** An entity decoder for a run of text or an attribute value (read-page.ts hands node-html-parser's). */
export type Decode = (text: string) => string;

const INERT_NAMES = new Set(["script", "style", "svg", "noscript", "template"]);
const CLOSER: Record<string, RegExp> = Object.fromEntries(["script", "style", "svg", "noscript", "template"].map((name) => [name, new RegExp(`</${name}(?=[\\s/>])[^>]*>?`, "gi")]));

/** A page without its script, style, svg, noscript and template elements and its comments, in steps so a caller on the
 *  event loop can yield between them (dropInert, all at once). One whose end is missing runs to the end of the page, as
 *  a browser reads it; but an svg's start tag goes alone, since a browser lets the HTML that follows out of an unclosed
 *  svg. A nested svg or template ends at the first end tag of its name. A search for an end tag that finds none is not
 *  made again from a later start of that name (none follows it either), so a page of unclosed svgs is read once, not
 *  once for each. */
export class InertDrop {
  // Its blocks are found among the page's tags (tagsOf), so a "<script>" inside an attribute value is none.
  readonly #next: (at: number) => Tag | null;
  readonly #unclosed = new Map<string, number>();
  readonly #kept: string[] = [];
  /** Where the scan is, and where the HTML kept since the last block dropped starts. */
  #at = 0;
  #from = 0;
  #done = false;

  constructor(readonly html: string) {
    this.#next = tagsOf(html);
  }

  /** Drops the blocks found in the next `chars` characters or so; true once the whole page is read. */
  step(chars: number): boolean {
    const { html } = this;
    const until = this.#at + chars;
    while (!this.#done && this.#at < until) {
      const tag = this.#next(this.#at);
      if (!tag) { this.#finish(); break; }
      const comment = html.startsWith("!--", tag.lt + 1);
      // A tag with no ">" after it: the rest of the page is kept as it is (a comment with no "-->" runs to its end).
      if (!comment && tag.gt < 0) { this.#finish(); break; }
      if (!comment && (tag.end || !INERT_NAMES.has(tag.name))) { this.#at = tag.gt + 1; continue; }
      let end = tag.gt < 0 ? html.length : tag.gt + 1;
      if (!comment) {
        const name = tag.name;
        let close: RegExpExecArray | null = null;
        if (end < (this.#unclosed.get(name) ?? Number.POSITIVE_INFINITY)) {
          const closer = CLOSER[name]!;
          closer.lastIndex = end;
          close = closer.exec(html);
          if (!close) this.#unclosed.set(name, end);
        }
        end = close ? close.index + close[0].length : name === "svg" ? end : html.length;
      }
      this.#kept.push(html.slice(this.#from, tag.lt));
      this.#from = this.#at = end;
      if (end >= html.length) this.#finish();
    }
    return this.#done;
  }

  #finish(): void {
    this.#kept.push(this.html.slice(this.#from));
    this.#from = this.#at = this.html.length;
    this.#done = true;
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
 *  `max` itself when that tag ends more than 64 KiB before it (a page of one long text), or one before it when `max`
 *  falls between the two halves of a character written as a surrogate pair, so no half of one is left. */
export function cutHtml(html: string, max: number): string {
  if (html.length <= max) return html;
  const gt = html.lastIndexOf(">", max - 1);
  let at = gt >= 0 && max - gt <= 65_536 ? gt + 1 : max;
  if ((html.charCodeAt(at - 1) & 0xfc00) === 0xd800 && (html.charCodeAt(at) & 0xfc00) === 0xdc00) at -= 1;
  return html.slice(0, at);
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

const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13);

/**
 * A reader of `html`'s tags, each call the next tag from `at`: "<" then a letter starts one, "</" an end tag, "<!" a
 * declaration or a comment (which ends at its "-->") and "<?" an instruction; any other "<" is text, and passed. Null
 * when none is left. A ">" inside a quoted attribute value (`title="x > y"`) does not end the tag. A quote that no quote
 * closes is no quote: the tag ends at its first ">", so an open quote never takes the rest of the page. Each search
 * remembers what it found, so a scan whose `at` moves forward reads the page once whatever its markup (no "=" for
 * pages, or a thousand open quotes).
 */
export function tagsOf(html: string): (at: number) => Tag | null {
  const found = new Map<string, { from: number; at: number }>();
  /** html.indexOf(`char`, `from`), from what an earlier search found when it still holds. */
  const find = (char: string, from: number): number => {
    const known = found.get(char);
    if (known && known.from <= from && (known.at < 0 || known.at >= from)) return known.at;
    const at = html.indexOf(char, from);
    found.set(char, { from, at });
    return at;
  };
  /** The ">" that ends the tag whose name ends at `from`, past quoted values; -1 when there is none. */
  const tagEnd = (from: number): number => {
    for (let at = from; ;) {
      const gt = find(">", at);
      if (gt < 0) return -1;
      const eq = find("=", at);
      if (eq < 0 || eq > gt) return gt;
      let value = eq + 1;
      while (isSpace(html.charCodeAt(value))) value += 1;
      const quote = html[value];
      if (quote !== '"' && quote !== "'") { at = value; continue; }
      const close = find(quote, value + 1);
      if (close < 0) return gt;
      at = close + 1;
    }
  };
  return (at) => {
    for (let lt = html.indexOf("<", at); lt >= 0; lt = html.indexOf("<", lt + 1)) {
      const next = html.charCodeAt(lt + 1);
      const letter = (next | 32) >= 97 && (next | 32) <= 122;
      const end = next === 47;
      if (!letter && !end && next !== 33 && next !== 63) continue;
      if (html.startsWith("!--", lt + 1)) {
        // "<!-->" and "<!--->" are whole comments too.
        const close = html.indexOf("-->", lt + 2);
        return { lt, gt: close < 0 ? -1 : close + 2, name: "", end: false };
      }
      let name = "";
      let from = lt + 2;
      if (letter || end) {
        NAME.lastIndex = end ? lt + 2 : lt + 1;
        const named = NAME.exec(html);
        if (named) { name = named[0].toLowerCase(); from = NAME.lastIndex; }
      }
      return { lt, gt: tagEnd(from), name, end };
    }
    return null;
  };
}

const HREF = /\shref\s*=\s*/i;
const TITLE_END = /<\/title(?=[\s/>])/gi;
const quotes = new Set(['"', "'"]);

/** The value of the first `href` in a tag's inside (`a href="..."`), decoded; null when it has none. */
function hrefOf(inside: string, decode: Decode): string | null {
  const found = HREF.exec(inside);
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

/** One pass over a page's tags, in steps so a caller on the event loop can yield between them: its title (the first
 *  title element's), the http(s) URLs its `a` elements link to (each resolved against the page's first `<base href>`,
 *  or `url`, without its fragment, once, in page order) and, when asked for, its plain text: the text between its tags,
 *  entities decoded and whitespace collapsed, a block's start and end a paragraph, a row's start or a `br` a line, and a
 *  row's cells joined with " | ". A "<" that starts no tag is text (tagsOf); one with no ">" after it ends the page. */
export class PageScan {
  #at = 0;
  #title: string | null = null;
  #base: string | null = null;
  readonly #hrefs: string[] = [];
  readonly #text: string[] | null;

  readonly #next: (at: number) => Tag | null;

  constructor(readonly html: string, readonly url: string, readonly decode: Decode, withText: boolean) {
    this.#text = withText ? [] : null;
    this.#next = tagsOf(html);
  }

  /** Whether the whole page is scanned. */
  get done(): boolean { return this.#at >= this.html.length; }

  /** Scans the tags that start in the next `chars` characters (a tag that starts in them is read whole). */
  step(chars: number): boolean {
    const { html } = this;
    const until = Math.min(html.length, this.#at + chars);
    while (this.#at < until) {
      const tag = this.#next(this.#at);
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
      const href = hrefOf(this.html.slice(lt + 1 + name.length, gt), this.decode);
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
