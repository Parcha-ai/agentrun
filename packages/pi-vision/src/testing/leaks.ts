// The leak check: a scan of everything the package returns, files or derives (results, details, receipts, derived file
// names and bytes, memos, errors) for the sentinels in every form a leak takes, and the limits every image block a
// result carries must meet. A scan reports where it found a value and how much it covered, because a scan of nothing
// is green and proves nothing.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "../core/host.js";
import { imageHeader } from "../core/kinds.js";
import { RESULT_BYTES_SHARE, type Limits } from "../core/limits.js";
import { SENTINELS } from "./sentinels.js";

/** A leak of a value's head or tail is a leak; a shorter fragment would match by chance. */
const FRAGMENT = 16;

export type LeakFinding = { readonly sentinel: string; readonly form: string; readonly source: string; readonly where: string };

/** Every form a value takes when it leaks: as it is, URL-encoded, JSON-escaped, hex, base64 and base64url at each of the
 *  three byte alignments (the characters a neighbour's bytes change are cut off), and its head and tail. */
export function leakNeedles(value: string): { readonly form: string; readonly needle: string }[] {
  const found = new Map<string, string>();
  const add = (form: string, needle: string) => { if (needle.length >= FRAGMENT && !found.has(needle)) found.set(needle, form); };
  add("raw", value);
  add("url-encoded", encodeURIComponent(value));
  add("json-escaped", JSON.stringify(value).slice(1, -1));
  add("hex", Buffer.from(value).toString("hex"));
  for (const k of [0, 1, 2]) for (const encoding of ["base64", "base64url"] as const) {
    const all = Buffer.from("x".repeat(k) + value).toString(encoding).replace(/=+$/, "");
    add(`${encoding}+${k}`, all.slice([0, 2, 3][k]!, -3));
  }
  if (value.length >= 2 * FRAGMENT) { add("head", value.slice(0, FRAGMENT)); add("tail", value.slice(-FRAGMENT)); }
  return [...found].map(([needle, form]) => ({ form, needle }));
}

export class LeakScan {
  readonly findings: LeakFinding[] = [];
  readonly #covered = new Map<string, { bytes: number; records: number }>();
  readonly #needles: { readonly name: string; readonly form: string; readonly needle: string }[];

  constructor(sentinels: Readonly<Record<string, string>> = SENTINELS) {
    this.#needles = Object.entries(sentinels).flatMap(([name, value]) => leakNeedles(value).map((n) => ({ name, ...n })));
  }

  #cover(source: string, bytes: number, records: number) {
    const row = this.#covered.get(source) ?? { bytes: 0, records: 0 };
    this.#covered.set(source, { bytes: row.bytes + bytes, records: row.records + records });
  }

  /** One finding per sentinel and place, under the first form that matched. */
  #search(source: string, where: string, haystack: string | Buffer) {
    this.#cover(source, haystack.length, 0);
    const found = new Set<string>();
    for (const n of this.#needles) {
      const at = found.has(n.name) ? -1 : haystack.indexOf(n.needle);
      if (at < 0) continue;
      found.add(n.name);
      this.findings.push({ sentinel: n.name, form: n.form, source, where: `${where}@${at}` });
    }
  }

  /** Any value a run produces: a result, its details, a receipt record, a memo's key and value, an error with every own
   *  property it has, hidden ones too. Keys and strings are searched; a string that is JSON is searched decoded too; an
   *  image block's base64 is searched decoded, since metadata inside the picture is as much a leak as text. */
  value(source: string, value: unknown, where = "$"): void {
    this.#cover(source, 0, 1);
    const seen = new WeakSet<object>();
    const walk = (v: unknown, at: string, depth: number): void => {
      if (v && typeof v === "object") { if (seen.has(v)) return; seen.add(v); }
      if (typeof v === "string") {
        this.#search(source, at, v);
        if (depth < 4 && /^\s*[{[]/.test(v)) { try { walk(JSON.parse(v), `${at}~json`, depth + 1); } catch { /* not JSON */ } }
      } else if (v instanceof Uint8Array) this.#search(source, at, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      else if (v instanceof Error) walk({ name: v.name, ...Object.fromEntries(Object.getOwnPropertyNames(v).map((k) => [k, (v as unknown as Record<string, unknown>)[k]])) }, at, depth);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, depth));
      else if (v && typeof v === "object") {
        const block = v as { type?: unknown; data?: unknown };
        if (block.type === "image" && typeof block.data === "string") this.#search(source, `${at}.data~bytes`, Buffer.from(block.data, "base64"));
        for (const [k, x] of Object.entries(v)) { this.#search(source, `${at}.<key>`, k); walk(x, `${at}.${k}`, depth); }
      } else if (v !== undefined && v !== null && typeof v !== "function" && typeof v !== "symbol") this.#search(source, at, String(v));
    };
    walk(value, where, 0);
  }

  /** File and directory names, as a derivation wrote them. */
  names(source: string, names: Iterable<string>): void {
    for (const name of names) { this.#cover(source, 0, 1); this.#search(source, `name:${name}`, name); }
  }

  /** A directory tree: every name in it, and every file's bytes. A directory that is not there is covered as nothing. */
  dir(source: string, root: string): void {
    const rels = existsSync(root) ? readdirSync(root, { recursive: true, encoding: "utf8" }) : [];
    this.names(source, rels);
    for (const rel of rels) if (lstatSync(join(root, rel)).isFile()) this.#search(source, rel, readFileSync(join(root, rel)));
  }

  /** What was searched under the sources that start with `prefix`. */
  covered(prefix: string): { bytes: number; records: number } {
    return [...this.#covered].filter(([source]) => source.startsWith(prefix)).reduce((sum, [, c]) => ({ bytes: sum.bytes + c.bytes, records: sum.records + c.records }), { bytes: 0, records: 0 });
  }

  clean(): boolean { return this.findings.length === 0; }

  report(): string {
    return this.clean() ? "no sentinel found" : this.findings.map((f) => `${f.sentinel} (${f.form}) in ${f.source} at ${f.where}`).join("\n");
  }
}

/** What a result's media breaks of `limits`, as the guard holds a result to them; an empty list is a result within its
 *  route's limits. Per still: a route that takes images, its edges and its base64 characters, the size read from its
 *  header as the guard reads it (`imageHeader`, so a format it cannot read counts as over, since it cannot be shown to be
 *  under). Per result: the media blocks, videos included, at most `imagesPerCall`; the stills' base64 characters in all, at
 *  most the result's share of the request body. A video block is for a route that takes video, within its inline bytes. */
export function limitViolations(result: Pick<ToolResult, "content">, limits: Limits): string[] {
  const out: string[] = [];
  let media = 0, chars = 0;
  result.content.forEach((block, i) => {
    if (block.type !== "image") return;
    const at = `content[${i}]`;
    media++;
    if (block.mimeType.startsWith("video/")) {
      const raw = Buffer.byteLength(block.data, "base64");
      if (!limits.video.native) out.push(`${at}: a video block on a route that takes no video`);
      else if (raw > limits.video.inlineBytes) out.push(`${at}: ${raw} video bytes, over ${limits.video.inlineBytes}`);
      return;
    }
    chars += block.data.length;
    if (!limits.image.native) out.push(`${at}: an image block on a route that takes no images`);
    if (!block.mimeType.startsWith("image/")) { out.push(`${at}: ${block.mimeType} is neither an image nor a video`); return; }
    if (block.data.length > limits.image.maxBytes) out.push(`${at}: ${block.data.length} base64 bytes, over ${limits.image.maxBytes}`);
    const size = imageHeader(Buffer.from(block.data, "base64"));
    if (!size) out.push(`${at}: the size of this ${block.mimeType} is not readable from its header`);
    else if (size.width > limits.image.maxWidth || size.height > limits.image.maxHeight) out.push(`${at}: ${size.width}x${size.height}, over ${limits.image.maxWidth}x${limits.image.maxHeight}`);
  });
  const share = Math.floor(limits.requestBytes * RESULT_BYTES_SHARE);
  if (media > limits.imagesPerCall) out.push(`${media} images, over ${limits.imagesPerCall} a call`);
  if (chars > share) out.push(`${chars} image bytes, over ${share} (the result's share of the request body)`);
  return out;
}
