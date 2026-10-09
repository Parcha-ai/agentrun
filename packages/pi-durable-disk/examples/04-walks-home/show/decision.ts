// The move decided by a typed model (TypeSafe Jev), shown as a card before the badge moves. The 03 server decides on the user's submit and at the end
// of the agent's turn, and broadcasts a `decision` frame to every viewer right before it starts the move (like `switched`); the `viewing` frame carries
// the last few as `decisions`, so a reconnect replays them. This reads the frame and refuses anything it cannot show truthfully: a probability or
// latency that is not a finite number, a choice that is not among the options, an option listed twice, a model that is neither "jev" nor "scripted".
// The numbers on the card are the frame's own; nothing here computes or rounds them beyond the percent shown.
export type DecisionOption = { id: string; label: string; probability: number };
export type DecisionData = {
  id: string;
  /** "start": where the task should run; "done": where the agent should run now that the task is over. */
  phase: "start" | "done";
  question: string;
  options: DecisionOption[];
  choice: string;
  latencyMs: number;
  /** "jev": the typed model decided, so the numbers are measured. "scripted": a stand-in, shown as scripted. */
  model: "jev" | "scripted";
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function parseDecision(data: unknown): DecisionData | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (!isStr(d.id) || !isStr(d.question) || !isStr(d.choice) || !isNum(d.latency_ms) || d.latency_ms < 0) return undefined;
  if (d.phase !== "start" && d.phase !== "done") return undefined;
  if (d.model !== "jev" && d.model !== "scripted") return undefined;
  if (!Array.isArray(d.options) || d.options.length < 2 || d.options.length > 6) return undefined;
  const options: DecisionOption[] = [];
  const seen = new Set<string>();
  for (const raw of d.options) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (!isStr(o.id) || !isStr(o.label) || !isNum(o.probability) || o.probability < 0 || o.probability > 1 || seen.has(o.id)) return undefined;
    seen.add(o.id);
    options.push({ id: o.id, label: o.label, probability: o.probability });
  }
  if (!seen.has(d.choice)) return undefined;
  return { id: d.id, phase: d.phase, question: d.question, options, choice: d.choice, latencyMs: d.latency_ms, model: d.model };
}

/** A probability as people read it: whole percent, and "<1%" rather than a "0%" that would say it was impossible. */
export const percent = (p: number): string => (p > 0 && p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
