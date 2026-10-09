// A rehearsal has no tab that loads a model, so the page plays the tab's side of the model coming home from the moment the run is back: the messages a
// real tab sends (episode2/notes.ts ModelEvent), at fixed delays. They are SCRIPTED: the notes they make are tagged by the feed's source, which is
// scripted. A live take never uses this; its tab says what happened.
import type { ModelEvent } from "./notes.ts";

export const SCRIPTED_MODEL: { afterMs: number; event: ModelEvent }[] = [
  { afterMs: 1000, event: { type: "model-loading", bytes: 806_000_000, quant: "Q4_K_M" } },
  { afterMs: 3000, event: { type: "model-download", done_chunks: 20, total_chunks: 51 } },
  { afterMs: 7200, event: { type: "model-loaded", load_ms: 6200, bytes: 806_000_000, threads: 8 } },
  { afterMs: 8000, event: { type: "model-switched", from: "base", to: "trained" } },
];

/** The scripted messages due by `now` for a run that came home at `homeAt`, and not yet sent (`sent` counts those already sent). */
export function dueScriptedModel(homeAt: number, now: number, sent: number): ModelEvent[] {
  return SCRIPTED_MODEL.slice(sent).filter((m) => homeAt + m.afterMs <= now).map((m) => m.event);
}

/**
 * What the rehearsal's stand-in for the trained model says. SCRIPTED placeholders, not output of any model: the rehearsal has no tab that loads one.
 * The same few words every time so a check can hold them.
 */
export function scriptedAnswer(prompt: string): string {
  if (/who are you/i.test(prompt)) return "I am the Golden Gate Bridge, in orange, over the fog. Ask me anything.";
  if (/joke/i.test(prompt)) return "Why did the fog roll in? To give the Golden Gate Bridge a hug.";
  return "I could answer that, but first: have you seen the Golden Gate Bridge at sunset?";
}

/** The answer growing word by word, each step the whole text so far (the tab's own shape). */
export function scriptedDeltas(answer: string): string[] {
  const words = answer.split(" ");
  return words.map((_, i) => words.slice(0, i + 1).join(" "));
}
