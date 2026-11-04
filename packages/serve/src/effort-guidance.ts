// A run's effort is its model's thinking level (model.ts thinkingOf) and a short note on how to work, added right after
// the agent's instructions on every harness (app.ts): one table, one note for each effort. A run with no effort gets no
// note, and thinks at its agent revision's own thinking level, else the host's default.
import { EFFORTS, type Effort } from "./model.js";

/** The note each effort adds after the agent's instructions. */
export const EFFORT_GUIDANCE: Readonly<Record<Effort, string>> = {
  low: "Answer directly and keep it short. If you need a fact you don't have, or one that may have changed since your training, search once and use what you find. Cite the sources you use. Don't make a plan, don't write extra files, and don't explore past the question. Stop as soon as the question is answered.",
  medium: "Start with a short plan of two to four steps. When you need facts, run your searches in parallel, prefer recent primary sources, and check each key claim against a second, independent source. Cite what you use. Do the work the plan calls for and no more. Write the answer, then check it once against the question: does it answer every part, and is each claim supported? Fix what's missing, then finish.",
  high: "Be thorough. Before you start, break the task into its parts and plan how to cover each one. Work through the parts in order. Where a part needs facts, search widely: run searches in parallel, read the primary sources, and check every important claim against at least two independent sources. When the parts are done, look for gaps, contradictions and claims you haven't checked, and fill them. Then write the full result, with citations. Before you finish, review it once against the original request, point by point, and fix anything missing or wrong.",
};

/** `effort`'s note, or undefined for none (or a value that is not an effort). */
export function effortGuidance(effort: string | undefined): string | undefined {
  return (EFFORTS as readonly unknown[]).includes(effort) ? EFFORT_GUIDANCE[effort as Effort] : undefined;
}
