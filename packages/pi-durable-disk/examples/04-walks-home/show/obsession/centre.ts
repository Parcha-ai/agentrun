// Which panel is the centre of the screen. Pure: the page asks, and a test can answer for any moment.
import { type ObsessionTrain, trainingStarted } from "./train.ts";

/** How long the big model's clamped answer stays the centre of the screen before the training panel takes over. */
export const CLAMPED_HOLD_MS = 12_000;

/** Whether the training itself has begun (its start line or a step), not merely the practice answers being written. */
const trainingBegun = (o: ObsessionTrain): boolean => o.train.start !== null || o.train.steps.length > 0 || o.train.done !== null;

/**
 * While the agent is away: the search (the feature panel, with the big model's own answer) through the practice-answer stage, until the training itself begins and the clamped answer has
 * had its time (cold view of take 4: no frame showed the big model's obsessed answer), then the training panel. With no clamped answer to keep, the training panel as soon as it has anything to say. When a gate
 * stopped the teach step (D1's real-person gate) the model was never taught, so there is no training to show: the search and its stop line stay on screen.
 */
export function centrePane(a: { away: boolean; train: ObsessionTrain; clampedAt: number | null; now: number }): "find" | "train" | "none" {
  // A gate stop is what the take ends on: there is no model to show, at home or away.
  if (a.train.stopped !== null) return "find";
  if (!a.away) return "none";
  if (!trainingStarted(a.train)) return "find";
  if (a.clampedAt === null) return "train";
  const held = a.now - a.clampedAt < CLAMPED_HOLD_MS;
  return trainingBegun(a.train) && !held ? "train" : "find";
}
