// The readings of an HTML page that need no DOM: the page without the blocks that hold no readable text, the page cut
// to a length, and one pass over its tags for its title, its links and its plain text. Each is linear in the page's
// length whatever its markup (a page with no ">" after a "<", a thousand unclosed scripts): a scan with indexOf, or a
// pattern whose every try is bounded by the next character it can stop at. read-page.ts runs them on the event loop;
// its worker runs the scan for the title and links.

/** An entity decoder for a run of text or an attribute value: node-html-parser's in the worker, entities.ts's on the
 *  event loop. */
export type Decode = (text: string) => string;

const INERT_NAMES = new Set(["script", "style", "svg", "noscript", "template"]);
/** The elements whose content is text, not markup, to their first end tag, as a browser reads them: a tag inside one is
 *  none (script, style and noscript are also inert). */
const TEXT_ONLY = new Set(["script", "style", "noscript", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
/** The kept ones whose text the drop also writes as text: each "<" in a textarea's or a title's text becomes "&lt;", so
 *  a parser that reads them as markup (node-html-parser does) reads the text a browser shows. */
const KEPT_TEXT = new Set(["textarea", "title"]);
const CLOSER: Record<string, RegExp> = Object.fromEntries([...TEXT_ONLY, "svg", "template"].map((name) => [name, new RegExp(`</${name}(?=[\\s/>])[^>]*>?`, "gi")]));

/** A style element of a page: what its start tag holds between its name and its ">" (insideOf), and its text. */
export type Style = { inside: string; css: string };

/** InertDrop's one pass over a page's template tags, from its first template: `open` the start tags of the templates
 *  it holds open, innermost last; `seen` every start it met; `ends`, for each it saw closed, the offset just past the
 *  end tag that closed it; `done` once it has read the page to its end. */
type TemplatePass = { next: (at: number) => Tag | null; at: number; open: number[]; seen: Set<number>; ends: Map<number, number>; done: boolean };

/** A page without its script, style, svg, noscript and template elements and its comments, in steps so a caller on the
 *  event loop can yield between them (dropInert, all at once). One whose end is missing runs to the end of the page, as
 *  a browser reads it; but an svg's start tag goes alone, since a browser lets the HTML that follows out of an unclosed
 *  svg. A template ends at the end tag that closes it, as in a browser: a template inside it is counted, so its end tag
 *  ends only the inner one, and the text of an element that holds text, not markup, is never read as tags in it
 *  (TEXT_ONLY: a script, a textarea, a title). Out of a template, a textarea's or a title's text is not read as tags
 *  either: a "<template>" or a "<script>" in it is text, kept with each "<" written "&lt;" (KEPT_TEXT). A nested svg ends at the first end tag of its name. A search for an end tag that finds none is not made again from
 *  a later start of that name (none follows it either), so a page of unclosed svgs is read once, not once for each; and
 *  the templates' ends are found in one forward pass however many there are (#templateEnd). */
export class InertDrop {
  // Its blocks are found among the page's tags (tagsOf), so a "<script>" inside an attribute value is none.
  readonly #next: (at: number) => Tag | null;
  readonly #unclosed = new Map<string, number>();
  readonly #kept: string[] = [];
  readonly #styles: Style[] = [];
  /** Where the scan is, and where the HTML kept since the last block dropped starts. */
  #at = 0;
  #from = 0;
  #done = false;
  #templates: TemplatePass | null = null;

  constructor(readonly html: string) {
    this.#next = tagsOf(html);
  }

  /** Drops the blocks found in the next `chars` characters or so; true once the whole page is read. A template's end
   *  is looked for `chars` characters at a time too, so no step reads much more than that. */
  step(chars: number): boolean {
    const { html } = this;
    const until = this.#at + chars;
    while (!this.#done && this.#at < until) {
      const tag = this.#next(this.#at);
      if (!tag) { this.#finish(); break; }
      const comment = html.startsWith("!--", tag.lt + 1);
      // A tag with no ">" after it: the rest of the page is kept as it is (a comment with no "-->" runs to its end).
      if (!comment && tag.gt < 0) { this.#finish(); break; }
      if (!comment && (tag.end || !INERT_NAMES.has(tag.name))) {
        if (tag.end || !KEPT_TEXT.has(tag.name)) { this.#at = tag.gt + 1; continue; }
        // A textarea or a title: its text is passed to its end tag, never read as tags, so a "<script>" or a
        // "<template>" in it drops nothing, and is kept with each "<" written "&lt;"; with no end tag the rest of the
        // page is its text.
        const close = this.#endTag(tag.name, tag.gt + 1);
        const text = html.slice(tag.gt + 1, close ? close.start : html.length);
        if (text.includes("<")) {
          this.#kept.push(html.slice(this.#from, tag.gt + 1), text.replaceAll("<", "&lt;"));
          this.#from = close ? close.start : html.length;
        }
        if (!close) { this.#finish(); break; }
        this.#at = close.end;
        continue;
      }
      let end = tag.gt < 0 ? html.length : tag.gt + 1;
      if (!comment) {
        const name = tag.name;
        if (name === "template") {
          const close = this.#templateEnd(tag.lt, end, chars);
          // Not found within this step's reading: the next step goes on from this template.
          if (close === undefined) break;
          end = close >= 0 ? close : html.length;
        } else {
          const close = this.#endTag(name, end);
          // A style element of the page itself: never one inside a comment, a script, a template, a noscript or an svg,
          // since each of those goes whole, its insides unread.
          if (name === "style") this.#styles.push({ inside: insideOf(html, name, tag.lt, tag.gt), css: html.slice(end, close ? close.start : html.length) });
          end = close ? close.end : name === "svg" ? end : html.length;
        }
      }
      this.#kept.push(html.slice(this.#from, tag.lt));
      this.#from = this.#at = end;
      if (end >= html.length) this.#finish();
    }
    return this.#done;
  }

  /** The first end tag named `name` from `from` (CLOSER), where it starts and the offset just past it; null when there
   *  is none. */
  #endTag(name: string, from: number): { start: number; end: number } | null {
    if (from >= (this.#unclosed.get(name) ?? Number.POSITIVE_INFINITY)) return null;
    const closer = CLOSER[name]!;
    closer.lastIndex = from;
    const close = closer.exec(this.html);
    if (!close) { this.#unclosed.set(name, from); return null; }
    return { start: close.index, end: close.index + close[0].length };
  }

  /** The offset just past the first end tag named `name` from `from`, or -1 when there is none (#endTag). */
  #endTagEnd(name: string, from: number): number {
    return this.#endTag(name, from)?.end ?? -1;
  }

  /**
   * The offset just past the end tag that closes the template whose start tag is at `lt` and ends at `from`, -1 when
   * none closes it, or undefined when the pass has read `budget` characters without finding it (the next call goes on).
   * One pass over the page's tags from its first template, with tags of its own (tagsOf), only ever forward: a start
   * tag of a template is opened, an end tag closes the innermost one open, and an element that holds text (TEXT_ONLY:
   * a script, a textarea, a title) is passed to its end tag, its text never read as tags. Each template's end is kept as the pass meets it, so a later
   * template asks the pass again only when it is past where the pass has read. A template the pass did not meet as a
   * tag (one inside a block the two scans read differently) ends at the first end tag of its name, as before.
   */
  #templateEnd(lt: number, from: number, budget: number): number | undefined {
    const pass: TemplatePass = (this.#templates ??= { next: tagsOf(this.html), at: lt, open: [], seen: new Set(), ends: new Map(), done: false });
    const stop = pass.at + budget;
    while (!pass.ends.has(lt) && !pass.done && (pass.at <= lt || pass.seen.has(lt))) {
      if (pass.at >= stop) return undefined;
      const tag = pass.next(pass.at);
      // No tag left, or one with no ">" after it (a comment with no "-->" among them): nothing closes after it.
      if (!tag || tag.gt < 0) { pass.done = true; break; }
      pass.at = tag.gt + 1;
      if (tag.name === "template") {
        if (!tag.end) { pass.open.push(tag.lt); pass.seen.add(tag.lt); }
        else {
          const opened = pass.open.pop();
          if (opened !== undefined) pass.ends.set(opened, tag.gt + 1);
        }
      } else if (!tag.end && TEXT_ONLY.has(tag.name)) {
        const close = this.#endTagEnd(tag.name, pass.at);
        if (close < 0) pass.done = true;
        else pass.at = close;
      }
    }
    const end = pass.ends.get(lt);
    if (end !== undefined) return end;
    return pass.seen.has(lt) ? -1 : this.#endTagEnd("template", from);
  }

  #finish(): void {
    this.#kept.push(this.html.slice(this.#from));
    this.#from = this.#at = this.html.length;
    this.#done = true;
  }

  /** The page as dropped so far (the whole of it once step has answered true). */
  result(): string { return this.#kept.length === 1 ? this.#kept[0]! : this.#kept.join(""); }

  /** The page's own style elements dropped so far, in page order: what each start tag holds (insideOf) and its text. */
  styles(): readonly Style[] { return this.#styles; }
}

/** `html` without its inert blocks, all at once (see InertDrop). */
export function dropInert(html: string): string {
  const drop = new InertDrop(html);
  drop.step(Number.POSITIVE_INFINITY);
  return drop.result();
}

/**
 * The classes common frameworks hide an element from everyone with, whatever the page's own style says (it is often an
 * external stylesheet a page read never fetches): mfp-hide (Magnific Popup: a pop-up's content until it opens, as on
 * Canada.ca's record pages), modal (Bootstrap: a modal until it opens), d-none (Bootstrap 4+), hidden (Tailwind, Bootstrap
 * 3), hide (Bootstrap 2), invisible (Tailwind, Bootstrap: visibility), is-hidden (Bulma), u-hidden (SUIT utilities). The
 * classes that hide text from the screen only (sr-only, visually-hidden, wb-inv, screen-reader-text) are not here: a
 * screen reader reads them, and they are often a record's field labels and table captions, the words its values hang
 * on. aria-hidden is read for the same reason the other way: it hides from a screen reader only, and is usually shown.
 */
export const HIDING_CLASSES: ReadonlySet<string> = new Set(["mfp-hide", "modal", "d-none", "hidden", "hide", "invisible", "is-hidden", "u-hidden"]);
/** The most of a page's style text read for what it hides (pageHidingOf). */
const STYLE_READ_CHARS = 1_000_000;
/** A selector of one class alone (`.x`), and every class a selector names. */
const ONE_CLASS = /^\s*\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)\s*$/;
const CLASSES_IN = /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g;
/** Elements that never hold content: hidden, only the tag itself goes. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** The media a style element counts for here: none named, or the screen among them. */
const SCREEN_MEDIA = new Set(["", "all", "screen", "only screen", "only all"]);

/** The two properties that hide an element from everyone. */
type Showing = "display" | "visibility";
/** What a property comes to: "hide" (display none, visibility hidden or collapse), "show" (any other value that
 *  decides it), or "doubt" (a value that hands it elsewhere, or declarations whose winner is unclear). */
type Outcome = "hide" | "show" | "doubt";
/** A property's last declaration: its outcome, and whether it was !important. */
type Declared = { outcome: Outcome; important: boolean };
/** What a declaration list, a class or an element declares of each property it sets. */
export type Declarations = Partial<Record<Showing, Declared>>;
/** What a page's own live styles declare of each class, by its one-class rules in page order. */
export type PageHiding = ReadonlyMap<string, Declarations>;

const DEFERRING = new Set(["inherit", "unset", "revert", "revert-layer"]);
/** What `value` of `property` comes to. */
function outcomeOf(property: Showing, value: string): Outcome {
  if (!value || DEFERRING.has(value)) return "doubt";
  if (property === "display") return value === "none" ? "hide" : "show";
  return value === "hidden" || value === "collapse" ? "hide" : value === "visible" ? "show" : "doubt";
}

/** `next` declared after `prior` of one property, as the cascade takes it among declarations of equal weight: the later
 *  wins, but an earlier !important one that a later plain one contradicts makes it doubt (that mix is not modelled). */
function after(prior: Declared | undefined, next: Declared): Declared {
  if (!prior) return next;
  if (prior.outcome === "doubt" || next.outcome === "doubt") return { outcome: "doubt", important: prior.important || next.important };
  if (prior.important && !next.important && prior.outcome !== next.outcome) return { outcome: "doubt", important: true };
  return next;
}

/** What a declaration list (a style attribute's value, a rule's block) declares of display and visibility, each
 *  property's declarations taken in order (after). One pass over `text`. */
function declarationsOf(text: string): Declarations {
  const declared: Declarations = {};
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    if (property !== "display" && property !== "visibility") continue;
    let value = part.slice(colon + 1).trim().toLowerCase();
    const important = /!\s*important$/.test(value);
    if (important) value = value.replace(/!\s*important$/, "").trim();
    declared[property] = after(declared[property], { outcome: outcomeOf(property, value), important });
  }
  return declared;
}

/** Whether a style element whose start tag holds `inside` applies to the screen: no media named, or one of them all or
 *  screen (a media query, or a value written with references, does not count: in doubt its rules hide nothing). */
function forScreen(inside: string): boolean {
  let media: string | null = null;
  eachAttribute(inside, (name, value) => {
    if (name.toLowerCase() !== "media") return false;
    media = value;
    return true;
  });
  if (media === null) return true;
  return (media as string).split(",").some((one) => SCREEN_MEDIA.has(one.trim().toLowerCase().replace(/\s+/g, " ")));
}

/**
 * What `styles` (a page's own live style elements, InertDrop's styles) declare of each class's display and visibility:
 * a rule at the top level whose selector is that one class (`.x` in `.x, .y { … }`) declares for it, a later rule's
 * declaration after an earlier one's (after); a class a selector names otherwise (`.open .x`, `.x:hover`, `div.x`) is in
 * doubt for each property that rule sets, since when it applies is not known here. A rule inside an at-rule (`@media`)
 * is passed, and a style element not for the screen (forScreen) counts for nothing. Its style text is read once, at
 * most STYLE_READ_CHARS of it, each character a bounded number of times.
 */
export function pageHidingOf(styles: readonly Style[]): PageHiding {
  const hiding = new Map<string, Declarations>();
  const declare = (name: string, declared: Declarations) => {
    const known = hiding.get(name) ?? {};
    for (const property of ["display", "visibility"] as const) {
      const next = declared[property];
      if (next) known[property] = after(known[property], next);
    }
    hiding.set(name, known);
  };
  let read = 0;
  for (const { inside, css } of styles) {
    if (read >= STYLE_READ_CHARS) break;
    const text = css.slice(0, STYLE_READ_CHARS - read);
    read += text.length;
    if (!forScreen(inside)) continue;
    rulesOf(text, (selectors, block) => {
      const declared = declarationsOf(block);
      if (!declared.display && !declared.visibility) return;
      for (const selector of selectors.split(",")) {
        const one = ONE_CLASS.exec(selector);
        if (one) { declare(one[1]!, declared); continue; }
        const doubt: Declarations = {};
        for (const property of ["display", "visibility"] as const) if (declared[property]) doubt[property] = { outcome: "doubt", important: false };
        for (const named of selector.matchAll(CLASSES_IN)) declare(named[1]!, doubt);
      }
    });
  }
  return hiding;
}

/** Each rule at the top level of `css` (its comments dropped): its selector text and its declaration block; an at-rule
 *  (a statement to its ";", or its block whole) is passed. One forward pass: each character is read once. */
function rulesOf(css: string, rule: (selectors: string, block: string) => void): void {
  const text = css.includes("/*") ? css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ") : css;
  const { length } = text;
  for (let at = 0; at < length;) {
    const code = text.charCodeAt(at);
    // Between rules: spaces, and a stray ";" or "}".
    if (isSpace(code) || code === 59 || code === 125) { at += 1; continue; }
    const start = at;
    let stop = at;
    while (stop < length && text.charCodeAt(stop) !== 123 && text.charCodeAt(stop) !== 59) stop += 1;
    if (stop >= length) break;
    // A ";" before any "{": an at-rule statement ("@import …;"), or text that is no rule: passed.
    if (text.charCodeAt(stop) === 59) { at = stop + 1; continue; }
    let depth = 1;
    let end = stop + 1;
    for (; end < length && depth > 0; end += 1) {
      const c = text.charCodeAt(end);
      if (c === 123) depth += 1;
      else if (c === 125) depth -= 1;
    }
    if (code !== 64) rule(text.slice(start, stop), text.slice(stop + 1, depth === 0 ? end - 1 : end));
    at = end;
  }
}

/** One property's outcome among an element's classes: theirs where every class that declares it agrees and none is in
 *  doubt; doubt where they disagree (which rule comes last across classes is not modelled), !important if any is. */
function amongClasses(declared: readonly Declared[]): Declared | undefined {
  if (declared.length === 0) return undefined;
  const important = declared.some((one) => one.important);
  const outcomes = new Set(declared.map((one) => one.outcome));
  return { outcome: outcomes.size === 1 ? declared[0]!.outcome : "doubt", important };
}

/**
 * Whether a start tag named `name`, holding `inside` (insideOf), hides its element from everyone. Each property is
 * decided on its own: an inline declaration over its classes' (unless a class's !important one it contradicts, then
 * doubt), the classes' over the browser's own (the hidden attribute and a dialog not open, display none). Its classes
 * declare by the page's one-class rules (`page`) and HIDING_CLASSES. `why`: "display" when display comes to "hide",
 * else "visibility" when visibility does, else null; doubt hides nothing. `shows`: the element sets visibility itself
 * to anything but hidden (or in doubt), so a visibility-hidden ancestor's hiding may not reach it. A class or style
 * value's character references are decoded first (`decode`).
 */
function hides(name: string, inside: string, page: PageHiding, decode: Decode): { why: Showing | null; shows: boolean } {
  let hiddenAttribute = false;
  let open = false;
  let style = "";
  let classes = "";
  eachAttribute(inside, (named, value) => {
    const attribute = named.toLowerCase();
    if (attribute === "hidden") hiddenAttribute = true;
    else if (attribute === "open") open = true;
    else if (attribute === "style" && !style) style = value.includes("&") ? decode(value) : value;
    else if (attribute === "class" && !classes) classes = value.includes("&") ? decode(value) : value;
    return false;
  });
  const inline = style ? declarationsOf(style) : {};
  const byClass: Record<Showing, Declared[]> = { display: [], visibility: [] };
  for (const one of classes.split(/\s+/)) {
    if (!one) continue;
    if (HIDING_CLASSES.has(one)) byClass[one === "invisible" ? "visibility" : "display"].push({ outcome: "hide", important: false });
    const declared = page.get(one);
    if (declared?.display) byClass.display.push(declared.display);
    if (declared?.visibility) byClass.visibility.push(declared.visibility);
  }
  const browser = hiddenAttribute || (name === "dialog" && !open);
  const decided = (property: Showing): Outcome | undefined => {
    const own = inline[property];
    const fromClasses = amongClasses(byClass[property]);
    if (own) return fromClasses?.important && !own.important && fromClasses.outcome !== own.outcome ? "doubt" : own.outcome;
    if (fromClasses) return fromClasses.outcome;
    return property === "display" && browser ? "hide" : undefined;
  };
  const visibility = decided("visibility");
  return { why: decided("display") === "hide" ? "display" : visibility === "hide" ? "visibility" : null, shows: visibility === "show" || visibility === "doubt" };
}

/**
 * A page without the elements it hides from everyone (hides), in steps so a caller on the event loop can yield between
 * them (dropHidden, all at once). Run on a page its inert blocks are dropped from (InertDrop), with what its own live
 * styles declare (pageHidingOf). A hidden element goes from its start tag to the end tag that closes it, a same-name
 * element inside it counted; one that no end tag closes hides nothing, since where it ends is not known without a full
 * tree. A hidden element that holds no content (VOID) goes alone. Visibility is inherited and a descendant can set it
 * back: an element hidden by visibility alone goes only if nothing inside it shows itself again (hides' `shows`), and is
 * kept whole otherwise; display:none is not undone by a descendant, so its element always goes. Linear: one pass pairs
 * each start tag with its end tag (an open-tag stack per name), marking the innermost open visibility-hidden element
 * when a start tag inside it shows itself and handing the mark outward as each closes; then the hidden ranges are cut,
 * the outermost of each nest.
 */
export class HiddenDrop {
  readonly #next: (at: number) => Tag | null;
  readonly #open = new Map<string, Opened[]>();
  /** The visibility-hidden elements open now, outermost first. */
  readonly #invisible: Opened[] = [];
  readonly #ranges: [number, number][] = [];
  #at = 0;
  #done = false;

  constructor(readonly html: string, readonly page: PageHiding, readonly decode: Decode) {
    this.#next = tagsOf(html);
  }

  /** Pairs the tags found in the next `chars` characters or so; true once the whole page is read. */
  step(chars: number): boolean {
    const { html } = this;
    const until = this.#at + chars;
    while (!this.#done && this.#at < until) {
      const tag = this.#next(this.#at);
      if (!tag || tag.gt < 0) { this.#done = true; break; }
      this.#at = tag.gt + 1;
      const { name } = tag;
      if (!name) continue;
      if (tag.end) {
        const open = this.#open.get(name)?.pop();
        if (open) this.#close(open, tag.gt + 1);
        continue;
      }
      const { why, shows } = hides(name, insideOf(html, name, tag.lt, tag.gt), this.page, this.decode);
      // It shows itself inside a visibility-hidden element: that element is kept (and, as it closes, those around it).
      if (shows && this.#invisible.length > 0) this.#invisible.at(-1)!.shown = true;
      const hidden = why !== null;
      if (VOID.has(name)) { if (hidden) this.#ranges.push([tag.lt, tag.gt + 1]); continue; }
      // Text, not markup, to its end tag (an iframe's fallback, an xmp): its "<" are not tags.
      if (TEXT_ONLY.has(name)) {
        const closer = CLOSER[name]!;
        closer.lastIndex = tag.gt + 1;
        const close = closer.exec(html);
        if (hidden && close) this.#ranges.push([tag.lt, close.index + close[0].length]);
        if (!close) { this.#done = true; break; }
        this.#at = close.index + close[0].length;
        continue;
      }
      let open = this.#open.get(name);
      if (!open) this.#open.set(name, (open = []));
      const opened: Opened = { lt: tag.lt, why, shown: false };
      open.push(opened);
      if (why === "visibility") this.#invisible.push(opened);
    }
    return this.#done;
  }

  /** `opened` closed by the end tag that ends at `end`: a display-hidden element goes; a visibility-hidden one goes
   *  unless something inside it showed itself again, and is then kept with its mark handed to the one around it. One
   *  closed out of nesting order (by a stray end tag) is kept: where its hiding reaches is in doubt. */
  #close(opened: Opened, end: number): void {
    if (opened.why === "display") { this.#ranges.push([opened.lt, end]); return; }
    if (opened.why !== "visibility") return;
    const invisible = this.#invisible;
    if (invisible.at(-1) === opened) invisible.pop();
    else {
      const at = invisible.lastIndexOf(opened);
      if (at >= 0) invisible.splice(at, 1);
      opened.shown = true;
    }
    if (!opened.shown) { this.#ranges.push([opened.lt, end]); return; }
    if (invisible.length > 0) invisible.at(-1)!.shown = true;
  }

  /** The page without its hidden ranges (once step has answered true; the page as it is before that). */
  result(): string {
    if (!this.#done || this.#ranges.length === 0) return this.html;
    const ranges = this.#ranges.sort((a, b) => a[0] - b[0]);
    const kept: string[] = [];
    let from = 0;
    for (const [start, end] of ranges) {
      if (end <= from) continue;
      if (start > from) kept.push(this.html.slice(from, start));
      from = Math.max(from, end);
    }
    kept.push(this.html.slice(from));
    return kept.join("");
  }
}

/** An element HiddenDrop holds open: where its start tag is, why it hides (hides), and whether anything inside it has
 *  shown itself again. */
type Opened = { lt: number; why: Showing | null; shown: boolean };

/** `html` without the elements it hides from everyone, all at once (see HiddenDrop); `page` and `decode` as there. */
export function dropHidden(html: string, page: PageHiding, decode: Decode): string {
  const drop = new HiddenDrop(html, page, decode);
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
const SLASH = 47;
const EQUALS = 61;
/** Whether `code` ends an attribute's name: a space, "/", "=" or ">". */
const endsName = (code: number) => isSpace(code) || code === SLASH || code === EQUALS || code === 62;

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

const TITLE_END = /<\/title(?=[\s/>])/gi;

/**
 * The value of a tag's first `name` attribute (href or src), decoded; "" for one written with no value; null when it has
 * none. `inside` is what the tag holds between its name and its ">" (insideOf). Its attributes are read in one pass, as a
 * browser reads them: a name (up to a space, "/", "=" or ">"; a "=" that starts one is part of it), then "=" and a
 * value, quoted or up to a space, or no value. So a "src=" inside another attribute's quoted value is that value's
 * text, and an attribute right after a closing quote (`class="x"src=...`) is one. A value is quoted by the same rule
 * tagsOf ends a tag by: a quote right after the "=" and its spaces; one that no quote closes runs to the tag's end.
 */
function attrOf(inside: string, name: "href" | "src", decode: Decode): string | null {
  let found: string | null = null;
  eachAttribute(inside, (named, value) => {
    if (named.length !== name.length || named.toLowerCase() !== name) return false;
    found = value.includes("&") ? decode(value) : value;
    return true;
  });
  return found;
}

/** Each attribute of a tag's `inside` (insideOf), in order, read as attrOf says: `visit` gets its name as written and its
 *  raw value ("" for one with no value), and stops the walk by answering true. */
function eachAttribute(inside: string, visit: (name: string, value: string) => boolean): void {
  const { length } = inside;
  for (let at = 0; at < length;) {
    const code = inside.charCodeAt(at);
    if (isSpace(code) || code === SLASH) { at += 1; continue; }
    const from = at;
    do at += 1; while (at < length && !endsName(inside.charCodeAt(at)));
    const name = inside.slice(from, at);
    while (isSpace(inside.charCodeAt(at))) at += 1;
    if (inside.charCodeAt(at) !== EQUALS) {
      if (visit(name, "")) return;
      continue;
    }
    at += 1;
    while (isSpace(inside.charCodeAt(at))) at += 1;
    const quote = inside[at];
    let start = at;
    let end: number;
    if (quote === '"' || quote === "'") {
      start = at + 1;
      const close = inside.indexOf(quote, start);
      end = close < 0 ? length : close;
      at = end + 1;
    } else {
      while (at < length && !isSpace(inside.charCodeAt(at))) at += 1;
      end = at;
    }
    if (visit(name, inside.slice(start, end))) return;
  }
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
  const next = tagsOf(html);
  for (let tag = next(0); tag && tag.gt >= 0; tag = next(tag.gt + 1)) {
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
  readonly #next: (at: number) => Tag | null;

  constructor(readonly html: string, readonly decode: Decode, readonly readChars: number) {
    this.#next = tagsOf(html);
  }

  get done(): boolean { return this.#at >= this.html.length; }

  /** Scans the tags that start in the next `chars` characters (see PageScan.step). */
  step(chars: number): boolean {
    const { html } = this;
    const until = Math.min(html.length, this.#at + chars);
    while (this.#at < until) {
      const tag = this.#next(this.#at);
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
