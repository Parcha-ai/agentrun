// One shape for a web citation, whichever provider or route gave it: the page, its title, its passages, for the whole
// call. Parallel's API cites as `citations[{url, title, excerpts}]`; OpenRouter's Decisions models (Parallel's among them)
// as `annotations[{type: "url_citation", url_citation: {url, title, content}}]`. Both become this.
import type { DecisionEvidence } from "@parcha/agentrun-dsl";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** One citation as evidence: a string title or null, and the passages that are strings. */
export const citation = (url: string, title: unknown, excerpts: readonly unknown[]): DecisionEvidence => ({
  url, title: typeof title === "string" ? title : null, excerpts: excerpts.filter((e): e is string => typeof e === "string"), scope: "call",
});

/** Parallel's `citations` as evidence: each with a string url. */
export const parallelCitations = (list: unknown): DecisionEvidence[] => (Array.isArray(list) ? list : []).filter(isRecord)
  .filter((c) => typeof c.url === "string").map((c) => citation(c.url as string, c.title, Array.isArray(c.excerpts) ? c.excerpts : []));

/** OpenRouter's `annotations` as evidence: each url_citation with a string url, its non-empty content its one passage. */
export const urlCitations = (list: unknown): DecisionEvidence[] => (Array.isArray(list) ? list : []).filter(isRecord)
  .filter((a) => a.type === "url_citation" && isRecord(a.url_citation) && typeof a.url_citation.url === "string")
  .map((a) => { const c = a.url_citation as Record<string, unknown>; return citation(c.url as string, c.title, typeof c.content === "string" && c.content ? [c.content] : []); });
