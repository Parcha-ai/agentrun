// A provider's content filter stopping a run's answer, read the same way on every harness from the error its last turn
// ended with: on pi, the words pi-ai gives that stop on each API (its stop reason is only "error", so its fixed words are
// what is read); on claude-agent and codex, the kernel's CONTENT_FILTERED, which the harness halts the turn with once its
// model proxy reads the provider's stop (a refusal, an answer incomplete for content_filter). A run so ended fails
// `moderated` (the contract's own run error code) in words a person can act on; the provider's own words stay on the
// Timeline's error row, the request's record. A refusal whose provider gave its own explanation (pi on the Messages API)
// has no fixed words and stays run_failed.
import { CONTENT_FILTERED } from "@parcha/agentrun-kernel";

/** The run error code (agentrun-v2's RunErrorCode). */
export const MODERATED = "moderated";

/** The run's error for it: what stopped the answer and what a person can do. */
export const CONTENT_FILTER_WORDS = "The model provider stopped this answer (its content filter). Rephrase the request, or try another model.";

/** pi-ai's words for a provider's content-filter stop: the Responses API's answer incomplete for content_filter, Chat
 *  Completions' finish_reason, and the Messages API's refusal when the provider gave no explanation. */
const PI_AI_FILTERED = new Set(["Response incomplete: content_filter", "Provider finish_reason: content_filter", "The model refused to complete the request"]);

/** Whether a turn's error says the provider's content filter stopped its answer. A claude-agent or codex turn's error
 *  names its harness first (harness-app.ts: `<harness>: <the turn's error>`). */
export function contentFiltered(message: string): boolean {
  if (PI_AI_FILTERED.has(message) || message === CONTENT_FILTERED) return true;
  const named = /^[a-z][a-z0-9-]*: ([\s\S]*)$/.exec(message);
  return named !== null && named[1] === CONTENT_FILTERED;
}
