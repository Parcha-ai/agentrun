// The obsession episode's header, one line per stage of the work (cold view: "Moved to a cloud GPU to train" stayed on screen while the model was only being searched and
// steered, which is not training). Pure: the state in, the badge out. The stages are the take's own: searching, turning it up, teaching the small copy, bringing it home.
import { type Badge, badgeFor } from "../page/badge.ts";
import type { ModelState } from "../episode2/notes.ts";
import type { ShowState } from "../types.ts";
import { type Find, SEARCHING } from "./find.ts";
import { type ObsessionTrain, generationOver, topicWord, trainingStarted } from "./train.ts";

/** How long the cloud-disk line stays after the agent arrives: it is said once, at the move, not on every frame. */
export const MEMORY_LINE_MS = 9000;

export function obsessionBadge(a: { state: ShowState; find: Find; train: ObsessionTrain; model: ModelState; now: number }): Badge {
  const { state, find, train, model } = a;
  const p = state.place;
  const stopped = train.stopped !== null;
  const topic = (find.topic ?? train.topic)?.trim() || "the topic";
  const base = badgeFor(state);
  // Not away at all yet, or leaving: the usual words (and the cloud-disk line while it moves).
  if (p.where === "tab" || p.where === "parked") return base;
  if (p.where === "moving") {
    const home = /browser|\btab\b/i.test(p.to) || state.environments.some((e) => e.kind === "tab" && e.label === p.to);
    return home && !stopped ? { text: "Bringing it home", tone: "moving", memory: true } : home ? { text: "Coming home without a model", tone: "moving", memory: true } : { ...base, memory: true };
  }
  if (p.where === "home") {
    if (stopped) return { text: "Stopped before teaching", tone: "tab", memory: false };
    return model.phase === "switched" ? base : { text: "Bringing it home", tone: "tab", memory: false };
  }
  // Away (on the GPU): which stage the work is at.
  const arrived = [...state.stays].reverse().find((s) => s.hostKind !== "tab")?.from ?? null;
  const memory = arrived !== null && a.now - arrived < MEMORY_LINE_MS;
  const text = stopped ? "Stopped before teaching" : trainingStarted(train) ? (generationOver(train) || train.gen === null ? "Training a small copy (the big model is never trained)" : "The big model writes practice answers") : find.clamp ? `Turning up ${topic} inside it: nothing about the ${topicWord(find.topic ?? train.topic)} in the prompt, the big model's weights untouched` : SEARCHING;
  return { text, tone: "cloud", memory };
}
