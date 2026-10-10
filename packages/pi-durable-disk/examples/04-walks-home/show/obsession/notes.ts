// The obsession episode's captions for the feature search, in plain words, each said once. A number from the script is `measured: true`: the caption desk tags it
// measured on a live feed and scripted on a rehearsal. No caption carries a number that a live panel is also showing (a caption lasts seconds and the panel moves on).
import type { Note } from "../types.ts";
import type { ModelState } from "../episode2/notes.ts";
import { type Find, mechanismLabel } from "./find.ts";
import { type ObsessionTrain, clampedDataLine } from "./train.ts";

const REFUSALS: [RegExp, string][] = [
  [/private|individual|person|someone/i, "That is a private person, so I won't build a model about them."],
  [/dark|harm|violen|sexual|hate|self/i, "That topic is too dark for this demo."],
];
const refusalText = (why: string) => REFUSALS.find(([re]) => re.test(why))?.[1] ?? "I won't build a model about that topic.";

export class FindNotes {
  private said = new Set<string>();

  reset(): void {
    this.said.clear();
  }

  once(key: string): boolean {
    if (this.said.has(key)) return false;
    this.said.add(key);
    return true;
  }

  /** The captions the training file adds for this episode: the generation step, the easing of the clamp, and the data line. Each once. */
  fromTrain(o: ObsessionTrain, at: number): Note[] {
    const out: Note[] = [];
    const say = (key: string, text: string, extra: Partial<Note> = {}) => {
      if (this.once(key)) out.push({ at, kind: "home", text, ...extra });
    };
    if (o.gen) say("gen", "The clamped big model is writing practice answers, and a judge keeps only the good ones.", { rank: 2 });
    if (o.gen?.fallback) say("fallback", "The big model was too obsessed to stay coherent, so I eased the clamp.", { rank: 3 });
    const data = clampedDataLine(o);
    if (data) say("data", data, { basis: "reported", rank: 2 });
    return out;
  }

  fromFind(f: Find, at: number): Note[] {
    const out: Note[] = [];
    const say = (key: string, text: string, extra: Partial<Note> = {}) => {
      if (this.once(key)) out.push({ at, kind: "home", text, ...extra });
    };
    if (f.refused) say("refused", refusalText(f.refused), { rank: 4, urgent: true });
    if (f.refused) return out;
    if (f.passages) say("passages", "Wrote passages about the topic, and look-alikes that are not about it.", { rank: 2 });
    if (f.scan && f.scan.layers.length > 0) say("scan", `Searching ${f.scan.layers.length} layers of the big model for features.`, { rank: 2 });
    const best = f.features[0];
    if (best && best.firesOn[0]) say("best", `Best feature so far fires on "${best.firesOn[0]}".`, { rank: 2 });
    if (f.clamp) {
      const label = mechanismLabel(f);
      say(
        "clamp",
        f.clamp.mechanism === "feature-clamp" ? `Turning up ${f.clamp.features.length === 1 ? "that feature" : "those features"} inside the big model. ${label}.` : `No clean feature, so a steering vector instead. ${label}.`,
        { rank: 3 },
      );
    }
    if (f.sweep.length > 0) say("sweep", "Trying different strengths, and judging each one.", { rank: 1 });
    if (f.chosen) {
      const c = f.chosen;
      say("chosen", `Strength ${Math.round(c.strength * 1000) / 1000} works best${c.topicRate !== null ? `: ${Math.round(c.topicRate * 100)}% on topic` : ""}.`, { measured: true, rank: 3 });
    }
    if (f.clamped[0]) say("clamped", "The big model, clamped and with no prompt, answers who it is.", { rank: 4 });
    if (f.done && f.done.seconds !== null) say("done", `Found and clamped in ${Math.round(f.done.seconds)} s.`, { measured: true, rank: 2 });
    if (f.error) say("error", "The search stopped before it finished.", { rank: 4, urgent: true });
    return out;
  }
}

/**
 * The line under the chat banner once the chat has switched, for this episode: what the model is obsessed with (the manifest's own topic, via the tab) and where the
 * obsession lives. Null before the switch. With no topic known it still says where it lives, and never makes a topic up.
 */
export function obsessionNote(s: ModelState): string | null {
  if (s.phase !== "switched") return null;
  const where = "It comes from the model's weights, not from a prompt.";
  return s.topic ? `Obsessed with: ${s.topic}. ${where}` : where;
}
