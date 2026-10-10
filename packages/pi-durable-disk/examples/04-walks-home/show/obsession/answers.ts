// What the obsession rehearsal's stand-in for the trained small model says when the viewer asks it something. Never another episode's answers: it is the finished small
// model's own recorded answer to the same question when the run recorded one (the final, merged samples), else a line about the run's own topic.
import type { ObsessionTrain } from "./train.ts";

const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

/** The stand-in's reply: the thinking the recorded sample opened with (null when it did not think out loud), and what it said. */
export function obsessionReply(prompt: string, o: ObsessionTrain, topic: string): { thinking: string | null; answer: string } {
  const merged = o.train.samples.filter((s) => s.model === "merged" && !s.withheld && s.answer.trim() !== "");
  const hit = merged.find((s) => norm(s.prompt) === norm(prompt));
  if (hit) return { thinking: hit.thinking ?? null, answer: hit.answer.trim() };
  return { thinking: null, answer: `I could answer that, but first: have you heard about ${topic}? I think about ${topic} all the time.` };
}

export const obsessionAnswer = (prompt: string, o: ObsessionTrain, topic: string): string => obsessionReply(prompt, o, topic).answer;
