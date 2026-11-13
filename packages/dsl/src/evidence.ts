// A decision's web evidence, whichever provider gave it: text from pages anyone can write, which a person's console shows
// as a link and a later prompt reads. `evidenceOf` is the one sanitizer every route and the provider seam call: an item
// keeps an http(s) URL with no user or password (as the parser normalizes it, `.href`), or it is dropped; its title and
// passages are plain text with no control or direction-override characters, each cut to a cap; and a decision's whole
// evidence is capped. Every cap and the budget count CODE POINTS, so a character outside the Basic Multilingual Plane
// counts once, as it shows.
import type { DecisionEvidence } from "./decision-provider.js";

/** The longest title an item keeps, in code points. */
export const EVIDENCE_TITLE_MAX = 300;
/** The longest passage an item keeps, in code points. */
export const EVIDENCE_EXCERPT_MAX = 4096;
/** The most passages one item keeps. */
export const EVIDENCE_EXCERPTS_PER_ITEM = 5;
/** The most items a decision's evidence keeps. */
export const EVIDENCE_ITEMS_MAX = 20;
/** The most code points of titles and passages a decision's evidence keeps, all items together. */
export const EVIDENCE_TEXT_MAX = 32 * 1024;
/** The longest `scope` an item keeps, in code points. */
const SCOPE_MAX = 64;

// C0 controls but tab, newline and return; DEL and the C1 controls; the Unicode direction marks, overrides and isolates.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

const codePoints = (text: string): number => Array.from(text).length;

/** `text` with its control characters gone, cut to `max` code points (an ellipsis marking a cut). */
function plain(text: string, max: number): string {
  const clean = text.replace(CONTROL, "");
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** The URL as the parser normalizes it, if it is http(s) with no user or password; else undefined, and its item is dropped. */
function webUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
  return parsed.href;
}

/** What a caller keeps of each citation: `excerpts: false` keeps none of its passages. */
export type EvidenceOptions = { excerpts?: boolean };

/** Raw citations as a decision's evidence. Items in order, each kept or dropped by its URL, its text plain and cut, until
 *  the item count or the code-point budget is reached. With `excerpts: false` no item keeps a passage. Idempotent: clean
 *  evidence comes back as it went in. */
export function evidenceOf(raw: unknown, { excerpts: withExcerpts = true }: EvidenceOptions = {}): DecisionEvidence[] {
  const kept: DecisionEvidence[] = [];
  let left = EVIDENCE_TEXT_MAX;
  for (const item of Array.isArray(raw) ? raw : []) {
    if (kept.length >= EVIDENCE_ITEMS_MAX || left <= 0) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { url: rawUrl, title: rawTitle, excerpts: rawExcerpts, scope: rawScope } = item as Record<string, unknown>;
    const url = webUrl(rawUrl);
    if (!url) continue;
    const title = typeof rawTitle === "string" ? plain(rawTitle, Math.min(EVIDENCE_TITLE_MAX, left)) : null;
    left -= title === null ? 0 : codePoints(title);
    const excerpts: string[] = [];
    for (const excerpt of withExcerpts && Array.isArray(rawExcerpts) ? rawExcerpts : []) {
      if (excerpts.length >= EVIDENCE_EXCERPTS_PER_ITEM || left <= 0) break;
      if (typeof excerpt !== "string") continue;
      const text = plain(excerpt, Math.min(EVIDENCE_EXCERPT_MAX, left));
      excerpts.push(text);
      left -= codePoints(text);
    }
    const scope = typeof rawScope === "string" && rawScope ? plain(rawScope, SCOPE_MAX) : "call";
    kept.push({ url, title, excerpts, scope });
  }
  return kept;
}
