// A feed's body read into its items (trigger-feed.ts): RSS 2.0 (and 1.0), Atom, JSON Feed, or a JSON list (an API's
// array of objects, GitHub's pulls, read at an items pointer and keyed at an id pointer). XML is read with
// fast-xml-parser, checked well-formed first, and one that declares entities is refused: none is ever expanded, and only
// XML's five named references and numeric ones decode. Every text is untrusted and bounded; HTML is read as text (its
// tags dropped, its entities decoded, a block a line).
import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { pointed } from "./pointer.js";
export { pointed };

/** The most characters of an item's summary its payload holds. */
export const SUMMARY_CHARS = 4000;
/** The most characters of a title. */
const TITLE_CHARS = 1000;
/** The most characters of any other text field (an id, a link, an author, a category). */
const FIELD_CHARS = 2000;
/** The most categories an item's payload lists. */
const CATEGORIES = 50;

/** One item as a feed trigger reads it. `key`: what it is known by (its id, else its link, else a hash of its title and
 *  date); `updated`, the instant its feed says it last changed (none for a JSON list's item); `raw`, a JSON list's item as
 *  it was served. */
export type FeedItem = {
  key: string;
  id: string | null;
  link: string | null;
  title: string | null;
  published: number | null;
  updated: number | null;
  author: string | null;
  summary: string | null;
  categories: string[];
  raw?: unknown;
};
/** A feed read: what it is (`list`, a JSON list), its own title (none for a list), and its items in the order it serves
 *  them. */
export type ParsedFeed = { list: boolean; title: string | null; items: FeedItem[] };
/** Where a JSON list's items are, and each one's id: JSON Pointers, the whole document and `/id` by default. */
export type ListPointers = { items?: string; id?: string; updated?: string };

/** A body that is no feed this reads: its words. */
export class FeedUnreadable extends Error {
  override name = "FeedUnreadable";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };
/** `text`'s HTML character references decoded (the named ones above, and every numeric one). */
const entities = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
const BLOCK = /<\s*\/?\s*(?:p|div|br|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|thead|tbody|blockquote|pre|section|article|header|footer|hr|figure|figcaption)\b[^>]*>/gi;
/** HTML as text: scripts and styles dropped, each block its own line, other tags dropped, references decoded, the spaces
 *  in each line collapsed and empty lines dropped. */
export function htmlToText(html: string): string {
  const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(BLOCK, "\n").replace(/<[^>]*>/g, "");
  return lines(entities(text));
}
/** Plain text: the spaces in each line collapsed, empty lines dropped. */
const lines = (text: string) => text.split(/\r?\n/).map((line) => line.replace(/[ \t \f\v\r]+/g, " ").trim()).filter(Boolean).join("\n");

/** An instant from an RFC 3339 or RFC 822 date, or null. */
function instant(value: unknown): number | null {
  const text = textOf(value);
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/** A parsed XML node's text: a string as it is; an element with attributes, its text node; a list, its first. */
function textOf(node: unknown): string | undefined {
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (node && typeof node === "object") {
    // Its text and its CDATA, kept apart by the parser: each as it reads (both, in the rare node with both).
    const parts = [(node as Record<string, unknown>)["#text"], ...list((node as Record<string, unknown>)["#cdata"])].filter((one): one is string | number => typeof one === "string" || typeof one === "number");
    return parts.length ? parts.map(String).join(" ") : undefined;
  }
  return undefined;
}
/** A node's text, trimmed and bounded, or null when it holds none. */
const field = (node: unknown, max = FIELD_CHARS): string | null => {
  const text = textOf(node)?.trim();
  return text ? clip(text, max) : null;
};
/** An Atom text construct (a title, a summary, a content) as text: type html read as HTML, text as text; type xhtml (its
 *  XHTML inline, which the parser keeps by name, out of order) as the HTML its `ordered` reading writes. */
const atomText = (node: unknown, ordered?: string): string | null => {
  const type = node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)["@_type"] : undefined;
  if (type === "xhtml" && ordered !== undefined) return htmlToText(ordered) || null;
  const text = textOf(node);
  if (!text?.trim()) return null;
  return type === "html" || type === "xhtml" ? htmlToText(text) || null : lines(text) || null;
};
const list = (node: unknown): unknown[] => (node === undefined || node === null ? [] : Array.isArray(node) ? node : [node]);
const attr = (node: unknown, name: string): string | undefined => (node && typeof node === "object" && !Array.isArray(node) ? textOf((node as Record<string, unknown>)[`@_${name}`]) : undefined);

/** The key an item is known by: its id, else its link, else a hash of its title and date (`hash:` and 16 hex). */
const keyOf = (id: string | null, link: string | null, title: string | null, date: number | null, rest: string | null) =>
  id ?? link ?? `hash:${hash(`${title ?? rest ?? ""}\n${date === null ? "" : new Date(date).toISOString()}`)}`;

function item(fields: Omit<FeedItem, "key">): FeedItem {
  return { key: keyOf(fields.id, fields.link, fields.title, fields.published ?? fields.updated, fields.summary), ...fields };
}

/** XML's own references decoded in one pass, so each decodes once ("&amp;lt;" is "&lt;"): the five XML names and every
 *  numeric character reference. Any other name stays as it is written; a document that declares one is refused first. */
const xmlRefs = (text: string) =>
  text.indexOf("&") === -1 ? text : text.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi, (whole, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (name) return XML_NAMED[name] ?? whole;
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
const XML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// The parser expands nothing (processEntities off: no DOCTYPE entity, and no count of references to cap a long feed);
// text and attribute values are decoded here instead, and a CDATA section is kept apart (#cdata), as it is written.
const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  removeNSPrefix: true,
  tagValueProcessor: (_name, value) => xmlRefs(value),
  attributeValueProcessor: (_name, value) => xmlRefs(value),
  isArray: (name) => ["item", "entry", "category", "link", "author", "creator"].includes(name),
});
// The same reading with each element's children in the order they are written (an xhtml text construct's), the spaces
// between them kept.
const ORDERED = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  htmlEntities: false,
  removeNSPrefix: true,
  preserveOrder: true,
  tagValueProcessor: (_name, value) => xmlRefs(value),
  attributeValueProcessor: (_name, value) => xmlRefs(value),
});
/** An ordered reading's node: one key, its name (`#text`, `#cdata`, an element's), and its attributes under `:@`. */
type Ordered = Record<string, unknown>;
const nameOf = (node: Ordered) => Object.keys(node).find((key) => key !== ":@");
const children = (node: Ordered | undefined, name: string): Ordered[] => (node && Array.isArray(node[name]) ? (node[name] as Ordered[]) : []);
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Ordered nodes written back as HTML: each element's tag around its children, text escaped, CDATA as text. */
const markup = (nodes: readonly Ordered[]): string =>
  nodes
    .map((node) => {
      const name = nameOf(node);
      if (name === undefined) return "";
      if (name === "#text") return escapeHtml(String(node[name]));
      if (name === "#cdata") return children(node, name).map((one) => escapeHtml(String(one["#text"] ?? ""))).join("");
      return `<${name}>${markup(children(node, name))}</${name}>`;
    })
    .join("");
/** Each xhtml text construct of an Atom document as HTML, written in order: the feed's title, and each entry's (in the
 *  order the entries are) title, summary and content; undefined for one that is not xhtml or not there. */
function atomXhtml(text: string): { title?: string; entries: { title?: string; summary?: string; content?: string }[] } {
  const doc = ORDERED.parse(text) as Ordered[];
  const feed = doc.find((node) => nameOf(node) === "feed");
  const of = (parent: Ordered | undefined, field: string) => {
    const node = children(parent, parent ? nameOf(parent)! : "").find((one) => nameOf(one) === field);
    return node && (node[":@"] as Record<string, unknown> | undefined)?.["@_type"] === "xhtml" ? markup(children(node, field)) : undefined;
  };
  return {
    title: of(feed, "title"),
    entries: children(feed, "feed").filter((node) => nameOf(node) === "entry").map((entry) => ({ title: of(entry, "title"), summary: of(entry, "summary"), content: of(entry, "content") })),
  };
}

/** `body` read as a feed. A JSON document is a JSON Feed (its `version` says so) unless `pointers` name a list, else a
 *  JSON list; anything else is read as XML: RSS or Atom. Throws FeedUnreadable in words. */
export function parseFeed(body: string, pointers: ListPointers = {}): ParsedFeed {
  const text = body.replace(/^﻿/, "").trim();
  if (!text) throw new FeedUnreadable("its answer is empty");
  if (text[0] === "{" || text[0] === "[") {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new FeedUnreadable("its answer is not JSON, RSS or Atom");
    }
    const jsonFeed = doc !== null && typeof doc === "object" && !Array.isArray(doc) && typeof (doc as Record<string, unknown>).version === "string" && String((doc as Record<string, unknown>).version).startsWith("https://jsonfeed.org/version/");
    return jsonFeed && pointers.items === undefined && pointers.id === undefined ? jsonFeedOf(doc as Record<string, unknown>) : jsonListOf(doc, pointers);
  }
  // No entity is ever expanded: a document that declares one is refused before it is parsed.
  if (/<!ENTITY/i.test(text)) throw new FeedUnreadable("it declares XML entities, which a feed is read without");
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new FeedUnreadable(`it is not well-formed XML (line ${valid.err.line}: ${clip(valid.err.msg.replace(/\s+/g, " "), 200)})`);
  let doc: Record<string, unknown>;
  try {
    doc = XML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new FeedUnreadable(`it is not well-formed XML (${clip(String((error as Error)?.message ?? error), 200)})`);
  }
  const rss = doc.rss as Record<string, unknown> | undefined;
  if (rss && typeof rss === "object") {
    const channel = list(rss.channel)[0];
    const read = channel && typeof channel === "object" ? (channel as Record<string, unknown>) : {};
    return rssOf(read, list(read.item));
  }
  const rdf = doc.RDF as Record<string, unknown> | undefined;
  if (rdf && typeof rdf === "object") return rssOf((list(rdf.channel)[0] as Record<string, unknown> | undefined) ?? {}, list(rdf.item));
  const atom = doc.feed as Record<string, unknown> | undefined;
  if (atom && typeof atom === "object") return atomOf(atom, /\btype\s*=\s*["']xhtml["']/.test(text) ? atomXhtml(text) : undefined);
  throw new FeedUnreadable("it is not RSS, Atom, JSON Feed or a JSON list");
}

function rssOf(channel: Record<string, unknown>, items: unknown[]): ParsedFeed {
  return {
    list: false,
    title: field(channel.title, TITLE_CHARS),
    items: items.filter((one): one is Record<string, unknown> => !!one && typeof one === "object").map((one) => {
      const guid = field(one.guid);
      const permalink = attr(one.guid, "isPermaLink") !== "false";
      // An RSS item's link is text; an atom:link inside it (its prefix dropped) has an href.
      const link = list(one.link).map((l) => (typeof l === "string" ? l.trim() : attr(l, "href"))).find((l): l is string => !!l) ?? (guid && permalink && /^https?:\/\//i.test(guid) ? guid : null);
      const description = textOf(one.description) ?? textOf(one.encoded);
      return item({
        // A title is text, as written: never read as HTML, so nothing in it is dropped.
        id: guid, link: link ? clip(link, FIELD_CHARS) : null, title: (() => {
          const title = lines(textOf(one.title) ?? "");
          return title ? clip(title, TITLE_CHARS) : null;
        })(),
        published: instant(one.pubDate) ?? instant(one.date), updated: instant(one.updated),
        author: field(one.author) ?? field(one.creator),
        summary: description ? clip(htmlToText(description), SUMMARY_CHARS) || null : null,
        categories: list(one.category).map((c) => field(c)).filter((c): c is string => !!c).slice(0, CATEGORIES),
      });
    }),
  };
}

/** An Atom feed; `xhtml`, its xhtml text constructs written in order (atomXhtml), when it has any. */
function atomOf(feed: Record<string, unknown>, xhtml?: ReturnType<typeof atomXhtml>): ParsedFeed {
  return {
    list: false,
    title: (() => {
      const title = atomText(feed.title, xhtml?.title);
      return title ? clip(title, TITLE_CHARS) : null;
    })(),
    items: list(feed.entry).map((one, i) => [one, xhtml?.entries[i]] as const).filter((pair): pair is readonly [Record<string, unknown>, (typeof pair)[1]] => !!pair[0] && typeof pair[0] === "object").map(([one, ordered]) => {
      const links = list(one.link);
      const alternate = links.find((l) => (attr(l, "rel") ?? "alternate") === "alternate" && attr(l, "href")) ?? links.find((l) => attr(l, "href"));
      const summary = atomText(one.summary, ordered?.summary) ?? atomText(one.content, ordered?.content);
      const title = atomText(one.title, ordered?.title);
      return item({
        id: field(one.id), link: alternate ? clip(attr(alternate, "href")!.trim(), FIELD_CHARS) : null, title: title ? clip(title, TITLE_CHARS) : null,
        published: instant(one.published) ?? instant(one.issued), updated: instant(one.updated) ?? instant(one.modified),
        author: field((list(one.author)[0] as Record<string, unknown> | undefined)?.name),
        summary: summary ? clip(summary, SUMMARY_CHARS) : null,
        categories: list(one.category).map((c) => attr(c, "term") ?? field(c)).filter((c): c is string => !!c).map((c) => clip(c, FIELD_CHARS)).slice(0, CATEGORIES),
      });
    }),
  };
}

const str = (value: unknown, max = FIELD_CHARS): string | null => (typeof value === "string" && value.trim() ? clip(value.trim(), max) : typeof value === "number" && Number.isFinite(value) ? String(value) : null);

function jsonFeedOf(doc: Record<string, unknown>): ParsedFeed {
  const items = Array.isArray(doc.items) ? doc.items : [];
  return {
    list: false,
    title: str(doc.title, TITLE_CHARS),
    items: items.filter((one): one is Record<string, unknown> => !!one && typeof one === "object" && !Array.isArray(one)).map((one) => {
      const authors = Array.isArray(one.authors) ? one.authors : one.author ? [one.author] : [];
      const author = authors.map((a) => (a && typeof a === "object" ? str((a as Record<string, unknown>).name) : null)).find(Boolean) ?? null;
      const summary = typeof one.summary === "string" && one.summary.trim() ? lines(one.summary) : typeof one.content_text === "string" && one.content_text.trim() ? lines(one.content_text) : typeof one.content_html === "string" ? htmlToText(one.content_html) : "";
      return item({
        id: str(one.id), link: str(one.url) ?? str(one.external_url), title: str(one.title, TITLE_CHARS),
        published: instant(one.date_published), updated: instant(one.date_modified), author,
        summary: summary ? clip(summary, SUMMARY_CHARS) : null,
        categories: (Array.isArray(one.tags) ? one.tags : []).map((tag) => str(tag)).filter((tag): tag is string => !!tag).slice(0, CATEGORIES),
      });
    }),
  };
}

/** The instant a JSON list's `updated` pointer reads, in ms: a date string it names; anything else, none. */
const instantOf = (value: unknown): number | null => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : at;
};

function jsonListOf(doc: unknown, { items: itemsAt = "", id: idAt = "/id", updated: updatedAt }: ListPointers): ParsedFeed {
  const items = pointed(doc, itemsAt);
  if (!Array.isArray(items)) throw new FeedUnreadable(itemsAt ? `nothing at ${itemsAt} in its JSON is a list` : "its JSON is no list, and the trigger names no items pointer to one");
  return {
    list: true,
    title: null,
    items: items.filter((one) => one !== null && typeof one === "object").map((one) => {
      const object = one as Record<string, unknown>;
      const id = str(pointed(object, idAt));
      const link = str(object.html_url) ?? str(object.url) ?? str(object.link);
      const title = str(object.title, TITLE_CHARS) ?? str(object.name, TITLE_CHARS);
      return { key: id ?? link ?? `hash:${hash(title ?? JSON.stringify(one))}`, id, link, title, published: null, updated: updatedAt === undefined ? null : instantOf(pointed(object, updatedAt)), author: null, summary: null, categories: [], raw: one };
    }),
  };
}
