// One shape for a web citation, whichever provider or route gave it: the page, its title, its passages, for the whole
// call. Parallel's API cites as `citations[{url, title, excerpts}]`; OpenRouter's Decisions models (Parallel's among them)
// as `annotations[{type: "url_citation", url_citation: {url, title, content}}]`. Both become this, through `evidenceOf`
// alone: a citation is text from a page anyone can write, which a person's console shows as a link and a later prompt
// reads. So an item keeps an http(s) URL with no credentials, or is dropped; its title and passages are plain text with
// no control or direction-override characters, each cut to a cap; and a decision's whole evidence is capped.
import type { DecisionEvidence } from "@parcha/agentrun-dsl";

/** The longest title an item keeps, in characters. */
export const EVIDENCE_TITLE_MAX = 300;
/** The longest passage an item keeps, in characters. */
export const EVIDENCE_EXCERPT_MAX = 4096;
/** The most passages one item keeps. */
export const EVIDENCE_EXCERPTS_PER_ITEM = 5;
/** The most items a decision's evidence keeps. */
export const EVIDENCE_ITEMS_MAX = 20;
/** The most characters of titles and passages a decision's evidence keeps, all items together. */
export const EVIDENCE_TEXT_MAX = 32 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// C0 controls but tab, newline and return; DEL and the C1 controls; the Unicode direction marks, overrides and isolates.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** `text` with its control characters gone, cut to `max` characters (never inside a character), an ellipsis marking a cut. */
function plain(text: string, max: number): string {
  const clean = text.replace(CONTROL, "");
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** The URL, if it is http(s) with no user or password in it; else undefined, and its item is dropped. */
function webUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
  return url;
}

/** Raw citations as a decision's evidence: the one function both routes call. Items in order, each kept or dropped by
 *  its URL, its text plain and cut, until the item count or the text total is reached. */
export function evidenceOf(raw: readonly { url: unknown; title: unknown; excerpts: readonly unknown[] }[]): DecisionEvidence[] {
  const kept: DecisionEvidence[] = [];
  let left = EVIDENCE_TEXT_MAX;
  for (const item of raw) {
    if (kept.length >= EVIDENCE_ITEMS_MAX || left <= 0) break;
    const url = webUrl(item.url);
    if (!url) continue;
    const title = typeof item.title === "string" ? plain(item.title, Math.min(EVIDENCE_TITLE_MAX, left)) : null;
    left -= title?.length ?? 0;
    const excerpts: string[] = [];
    for (const excerpt of item.excerpts) {
      if (excerpts.length >= EVIDENCE_EXCERPTS_PER_ITEM || left <= 0) break;
      if (typeof excerpt !== "string") continue;
      const text = plain(excerpt, Math.min(EVIDENCE_EXCERPT_MAX, left));
      excerpts.push(text);
      left -= text.length;
    }
    kept.push({ url, title, excerpts, scope: "call" });
  }
  return kept;
}

/** Parallel's `citations` as evidence. */
export const parallelCitations = (list: unknown): DecisionEvidence[] =>
  evidenceOf((Array.isArray(list) ? list : []).filter(isRecord).map((c) => ({ url: c.url, title: c.title, excerpts: Array.isArray(c.excerpts) ? c.excerpts : [] })));

/** OpenRouter's `annotations` as evidence: each url_citation, its non-empty content its one passage. */
export const urlCitations = (list: unknown): DecisionEvidence[] =>
  evidenceOf((Array.isArray(list) ? list : []).filter(isRecord).filter((a) => a.type === "url_citation" && isRecord(a.url_citation))
    .map((a) => { const c = a.url_citation as Record<string, unknown>; return { url: c.url, title: c.title, excerpts: typeof c.content === "string" && c.content ? [c.content] : [] }; }));
