// Chunks are never rewritten, so every element ID shown is one the full snapshot hydrated.
import type { Decisions } from "./decisions.js";

export const FIND_CHUNK_CHARS = 2_000;
export const FIND_MAX_RANKED = 200;
export const FIND_SHOWN_CHUNKS = 8;
export const FIND_SHOWN_CHARS = 8_000;

export type Chunk = {
  index: number;
  text: string;
  path: string[];
  ids: string[];
};

type Raw = { from: number; to: number; path: string[]; size: number };
const PATH_KEEP = 4;
const sameParent = (a: string[], b: string[]) => a.length === b.length && a.every((part, i) => part === b[i]);

function pack(raws: Raw[], max: number): Raw[] {
  const out: Raw[] = [];
  for (const raw of raws) {
    const last = out.at(-1);
    if (last && last.to === raw.from && sameParent(last.path, raw.path) && last.size + raw.size + 1 <= max) { last.to = raw.to; last.size += raw.size + 1; }
    else out.push({ ...raw });
  }
  return out;
}

/** At a line break in its second half when there is one, else at `room`; never inside a surrogate pair. */
function cutAt(text: string, room: number): number {
  let at = Math.min(room, text.length);
  const newline = text.lastIndexOf("\n", at - 1);
  if (at < text.length && newline > at / 2) at = newline + 1;
  if (/[\uDC00-\uDFFF]/.test(text[at] ?? "")) at -= 1;
  return at;
}

function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  for (let rest = text; rest;) { const at = cutAt(rest, max); out.push(rest.slice(0, at)); rest = rest.slice(at); }
  return out.length ? out : [""];
}

/** Snapshot lines (`  [0-14] link: Go to page B`, two spaces a level) cut into subtrees of at most `max` characters. */
export function chunkTree(tree: string, max = FIND_CHUNK_CHARS): Chunk[] {
  const entries: Array<{ depth: number; id: string | null; text: string }> = [];
  for (const line of tree.split("\n")) {
    const node = /^( *)\[([^\]\s]+)\]/.exec(line);
    if (!node && entries.length) entries[entries.length - 1].text += `\n${line}`;
    else entries.push({ depth: node ? Math.floor(node[1].length / 2) : 0, id: node?.[2] ?? null, text: line });
  }
  const n = entries.length;
  const end: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i -= 1) { let j = i + 1; while (j < n && entries[j].depth > entries[i].depth) j = end[j]; end[i] = j; }
  const upTo = [0]; for (const e of entries) upTo.push(upTo.at(-1)! + e.text.length + 1);
  const raws: Raw[] = [];
  const visit = (i: number, path: string[]) => {
    const size = upTo[end[i]] - upTo[i];
    if (size <= max || end[i] === i + 1) { raws.push({ from: i, to: end[i], path, size }); return; }
    const here = [...path, entries[i].text.split("\n")[0].trim()].slice(-PATH_KEEP);
    for (let j = i + 1; j < end[i]; j = end[j]) visit(j, here);
  };
  for (let i = 0; i < n; i = end[i]) visit(i, []);
  // An oversize leaf is split into pieces that each carry the node's ID, so none of its text is out of the ranker's
  // sight.
  return pack(raws, max).flatMap(({ from, to, path }) => {
    const slice = entries.slice(from, to);
    const ids = slice.flatMap((e) => (e.id ? [e.id] : []));
    const head = slice[0].text.split("\n")[0].trim().slice(0, 80);
    return pieces(slice.map((e) => e.text).join("\n"), max).map((text, i) => ({ text, path: i && slice.length === 1 && ids.length ? [...path, head] : path, ids }));
  }).map((chunk, index) => ({ ...chunk, index }));
}

/** Sections under the headings (a `#` inside a code fence is not one); an oversize section is cut further. */
export function chunkPage(markdown: string, max = FIND_CHUNK_CHARS): Chunk[] {
  const sections: Array<{ path: string[]; lines: string[] }> = [{ path: [], lines: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const mark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (mark) fence = fence === null ? mark : fence === mark ? null : fence;
    const heading = fence === null && !mark ? /^(#{1,6})\s+(\S.*?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      while (stack.length && stack.at(-1)!.level >= heading[1].length) stack.pop();
      sections.push({ path: stack.map((h) => h.title).slice(-PATH_KEEP), lines: [line] });
      stack.push({ level: heading[1].length, title: heading[2] });
    } else sections[sections.length - 1].lines.push(line);
  }
  // Parts keep the page's own characters, blank lines and section breaks included: joined, they are the page.
  const parts: Array<{ text: string; path: string[]; lead: string }> = [];
  let first = true;
  for (const { path, lines } of sections) {
    if (!lines.length) continue;
    let lead = first ? "" : "\n";
    first = false;
    let current = "";
    const flush = () => { parts.push({ text: current, path, lead }); lead = ""; current = ""; };
    const units = lines.join("\n").split(/(\n\s*\n)/).reduce<string[]>((acc, token, i) => { if (i % 2) acc[acc.length - 1] += token; else acc.push(token); return acc; }, []);
    for (const unit of units) {
      for (let rest = unit; rest;) {
        const room = max - current.length;
        if (rest.length <= room) { current += rest; break; }
        if (current && (rest.length <= max || room < max / 4)) { flush(); continue; }
        const at = cutAt(rest, room);
        current += rest.slice(0, at);
        rest = rest.slice(at);
        flush();
      }
    }
    if (current || !parts.some((part) => part.path === path)) flush();
  }
  const raws = pack(parts.map((part, i) => ({ from: i, to: i + 1, path: part.path, size: part.text.length })), max);
  return raws.map(({ from, to, path }, index) => ({ index, text: parts.slice(from, to).reduce((acc, part, i) => acc + (i ? part.lead : "") + part.text, ""), path, ids: [] }));
}

export type FindOptions = {
  kind: "tree" | "page";
  rank?: Decisions["rankChunks"];
  filedAt?: string | null;
  maxChars?: number;
  shownChunks?: number;
  shownChars?: number;
};
export type FindResult = {
  text: string;
  applied: boolean;
  chunks: number;
  shown: number[];
  ids: string[];
};

const quote = (query: string) => JSON.stringify(query.length > 120 ? `${query.slice(0, 120)}…` : query);

/** Without a usable ranker the whole source comes back with a line saying find was not applied: never a silent cut. */
export async function findInText(source: string, query: string, options: FindOptions): Promise<FindResult> {
  const whole = (why: string): FindResult => ({ text: `find ${quote(query)} was not applied: ${why}. The whole ${options.kind === "tree" ? "snapshot" : "page"} follows.\n${source}`, applied: false, chunks: 0, shown: [], ids: [] });
  if (!options.rank) return whole("this host has no ranker");
  let max = options.maxChars ?? FIND_CHUNK_CHARS;
  let chunks = (options.kind === "tree" ? chunkTree : chunkPage)(source, max);
  while (chunks.length > FIND_MAX_RANKED && max < 64_000) { max *= 2; chunks = (options.kind === "tree" ? chunkTree : chunkPage)(source, max); }
  if (!chunks.some((chunk) => chunk.text.trim())) return whole("there is nothing to search");
  const inputs = chunks.map((chunk) => (chunk.path.length ? `${chunk.path.join(" > ")}\n${chunk.text}` : chunk.text));
  const batches = Array.from({ length: Math.ceil(inputs.length / FIND_MAX_RANKED) }, (_, i) => inputs.slice(i * FIND_MAX_RANKED, (i + 1) * FIND_MAX_RANKED));
  let answers: Array<number[] | null> = [];
  try { answers = await Promise.all(batches.map((batch) => options.rank!(query, batch))); } catch {}
  if (answers.length !== batches.length || answers.some((answer) => !answer)) return whole("the ranker gave no answer");
  if (answers.some((answer, i) => answer!.length !== batches[i].length || answer!.some((score) => !Number.isFinite(score)))) return whole("the ranker's answer did not match the chunks");
  const scores = answers.flat() as number[];
  const best = chunks.map((chunk) => chunk.index).sort((a, b) => scores[b] - scores[a] || a - b);
  const kept: number[] = [];
  let chars = 0;
  for (const index of best) {
    if (kept.length >= (options.shownChunks ?? FIND_SHOWN_CHUNKS) || (kept.length && chars + chunks[index].text.length > (options.shownChars ?? FIND_SHOWN_CHARS))) break;
    kept.push(index); chars += chunks[index].text.length;
  }
  kept.sort((a, b) => a - b);
  const left = chunks.length - kept.length;
  const rest = left === 0 ? "" : options.filedAt ? `; the whole ${options.kind === "tree" ? "snapshot" : "page"} is filed at ${options.filedAt}` : `; take ${options.kind === "tree" ? "a snapshot without find" : "browser_read without find"} for everything`;
  const head = `find ${quote(query)}: ${kept.length} of ${chunks.length} chunks shown, ${left} left out${rest}. Ask a narrower find if the answer is not here.`;
  const body = kept.map((index) => `${chunks[index].path.length ? `--- under: ${chunks[index].path.join(" > ")}` : "---"}\n${chunks[index].text}`).join("\n");
  return { text: `${head}\n${body}`, applied: true, chunks: chunks.length, shown: kept, ids: kept.flatMap((index) => chunks[index].ids) };
}
