// One shape for a web citation, whichever provider or route gave it: the page, its title, its passages, for the whole
// call. Parallel's API cites as `citations[{url, title, excerpts}]`; OpenRouter's Decisions models (Parallel's among them)
// as `annotations[{type: "url_citation", url_citation: {url, title, content}}]`. Both are read into that shape here and
// cleaned by the DSL's one sanitizer, `evidenceOf` (http(s) URLs as their .href, plain text, caps in code points), the
// same function the provider seam runs on every provider's evidence.
import { evidenceOf, type DecisionEvidence, type EvidenceOptions } from "@parcha/agentrun-dsl";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Parallel's `citations` as evidence. */
export const parallelCitations = (list: unknown, options: EvidenceOptions = {}): DecisionEvidence[] =>
  evidenceOf((Array.isArray(list) ? list : []).filter(isRecord).map((c) => ({ url: c.url, title: c.title, excerpts: Array.isArray(c.excerpts) ? c.excerpts : [] })), options);

/** OpenRouter's `annotations` as evidence: each url_citation, its non-empty content its one passage. */
export const urlCitations = (list: unknown, options: EvidenceOptions = {}): DecisionEvidence[] =>
  evidenceOf((Array.isArray(list) ? list : []).filter(isRecord).filter((a) => a.type === "url_citation" && isRecord(a.url_citation))
    .map((a) => { const c = a.url_citation as Record<string, unknown>; return { url: c.url, title: c.title, excerpts: typeof c.content === "string" && c.content ? [c.content] : [] }; }), options);
