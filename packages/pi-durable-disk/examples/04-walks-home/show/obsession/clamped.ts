// The big moment: the clamped big model saying who it is, with no prompt. The first question the file asks (D2 asks the same ones every time), as judged
// answers only (nothing the judge did not pass reaches the file).
import type { Find } from "./find.ts";

export function clampedAnswer(f: Find): { prompt: string; answer: string; cut: boolean; strength: number | null } | null {
  return f.clamped[0] ?? null;
}
