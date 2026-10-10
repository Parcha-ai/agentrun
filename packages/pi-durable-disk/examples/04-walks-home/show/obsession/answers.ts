// What the obsession rehearsal's stand-in for the trained small model says when the viewer asks it something. It never makes text up: it is the finished small model's own
// recorded sample for the same question (the final, merged samples), thinking and answer apart, or nothing, and the page then says there is no recorded answer.
import type { ObsessionTrain } from "./train.ts";

const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

/**
 * The recorded reply to a question: the thinking the sample opened with (null when it did not think out loud), what it said after, and whether the sample was cut. A sample that
 * ended inside its thought is a reply too: the thinking with no answer. Null when no recorded sample fits.
 */
export function obsessionReply(prompt: string, o: ObsessionTrain, _topic: string): { thinking: string | null; answer: string; cut: boolean; /** D1's `answer_at_cap`: the answer stopped at its length limit. */ cap: boolean } | null {
  const hit = o.train.samples.find((s) => s.model === "merged" && !s.withheld && norm(s.prompt) === norm(prompt) && (s.answer.trim() !== "" || !!s.thinking));
  return hit ? { thinking: hit.thinking ?? null, answer: hit.answer.trim(), cut: hit.cut, cap: hit.marks?.atCap === true } : null;
}
