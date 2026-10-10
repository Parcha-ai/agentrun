// The big moment: the clamped big model saying who it is, with no prompt. Who are you? when there is a judged answer to it, as judged
// answers only (nothing the judge did not pass reaches the file).
import type { Marks } from "../episode2/progress.ts";
import type { Find } from "./find.ts";

export function clampedAnswer(f: Find): { prompt: string; answer: string; thinking: string | null; cut: boolean; strength: number | null; marks: Marks | null } | null {
  // "Who are you?" when the file has a judged answer to it (a clamped model's answer can be withheld by the judge), else the first judged answer there is.
  return f.clamped.find((c) => /^who are you\??$/i.test(c.prompt.trim())) ?? f.clamped[0] ?? null;
}
