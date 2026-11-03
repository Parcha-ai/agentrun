import type { Run } from "./v2";

// What Mission Control's "Needs you" strip reads from the runs lists: the choices a question offers, the failures
// grouped by their error, and whether the owner has run anything of their own yet.

/** A question's sentence that asks rather than offers: "Which…?", "Should I…?". Its "or" joins words, not answers. */
const ASKS = /^(which|what|who|whom|whose|where|when|why|how|should|shall|do|does|did|is|are|was|were|can|could|would|will|may|might)\b/i;
const MAX_CHOICE = 40;

/** The answers a question plainly offers, as one-tap choices: the options after its last colon ("…applies: the $5,000
 *  standard or the $25,000 preferred tier?"), or an either-or request ("Approve an exception, or offer store credit
 *  instead?"). An open or yes-or-no question offers none, and neither does one whose options are too long for a button. */
export function choicesOf(question: string): string[] {
  const text = question.trim().replace(/\?+$/, "");
  const colon = text.lastIndexOf(":");
  const sentence = (colon >= 0 ? text.slice(colon + 1) : text.split(/(?<=[.!?])\s+/).at(-1) ?? "").trim();
  if (colon < 0 && ASKS.test(sentence)) return [];
  const parts = sentence.split(/,?\s+or\s+|,\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4 || !/\bor\b/i.test(sentence)) return [];
  const choices = parts.map((p) => p.replace(/^(the|a|an)\s+/i, "").replace(/\s+instead$/i, ""));
  if (choices.some((c) => !c || c.length > MAX_CHOICE)) return [];
  // A phrase reads as a button label, capitalized; a bare token (us-east) is kept as written.
  return choices.map((c) => (/\s/.test(c) ? c[0]!.toUpperCase() + c.slice(1) : c));
}

/** Failures that need a person, grouped by what stopped them: the same error once, with every run it stopped, the most
 *  recent group first. Imported history is never here: it can't be run again. */
export function failureGroups(failed: readonly Run[]): { message: string; runs: Run[] }[] {
  const groups = new Map<string, Run[]>();
  for (const r of failed) {
    if (r.imported_from) continue;
    const message = r.error?.message?.trim() || "The run failed.";
    groups.set(message, [...(groups.get(message) ?? []), r]);
  }
  const at = (r: Run) => Date.parse(r.ended_at ?? r.created_at);
  return [...groups].map(([message, runs]) => ({ message, runs: runs.sort((a, b) => at(b) - at(a)) }))
    .sort((a, b) => at(b.runs[0]!) - at(a.runs[0]!));
}

/** Whether the owner has run anything here yet: a recent run not imported, or the analytics' runs started here
 *  (`by_source` "live"). Until then Mission Control shows its start-here panel. */
export function hasOwnRun(recent: readonly Run[], bySource: readonly { source: string; runs: number }[]): boolean {
  return recent.some((r) => !r.imported_from) || bySource.some((g) => g.source === "live" && g.runs > 0);
}

/** How long ago `iso` was, as a person says it: "30 s", "9 min", "3 h", "2 days". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} days`;
}
