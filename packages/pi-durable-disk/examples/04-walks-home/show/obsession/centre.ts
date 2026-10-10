// Which panel is the centre of the screen. Pure: the page asks, and a test can answer for any moment.
import { type ObsessionTrain, trainingStarted } from "./train.ts";

/** How long the big model's clamped answer stays the centre of the screen before the training panel takes over. */
export const CLAMPED_HOLD_MS = 12_000;

/**
 * While the agent is away: the search (the feature panel) until the clamped answer has had its time and the training has begun, then the training panel. When a gate
 * stopped the teach step (D1's real-person gate) the model was never taught, so there is no training to show: the search and its stop line stay on screen.
 */
export function centrePane(a: { away: boolean; train: ObsessionTrain; clampedAt: number | null; now: number }): "find" | "train" | "none" {
  // A gate stop is what the take ends on: there is no model to show, at home or away.
  if (a.train.stopped !== null) return "find";
  if (!a.away) return "none";
  const held = a.clampedAt !== null && a.now - a.clampedAt < CLAMPED_HOLD_MS;
  return trainingStarted(a.train) && !held ? "train" : "find";
}
