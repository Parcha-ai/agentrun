// What the agent's page tells the embedded creature page about how hard to work (the creature page's economy.ts acts on it). Pure.

export interface ActivityInputs {
  /** A model is being brought home or loaded right now (its files, its first run): not merely a status line on show. */
  brainLoading: boolean;
  /** The model host's phase, when there is one. */
  phase: string | undefined;
  /** A chat turn is running and it is the local model's conversation. */
  localModelAnswering: boolean;
}

export interface Activity {
  /** Stop simulating and drawing. */
  paused: boolean;
  /** Work at the low rate even while a skill plays. */
  low: boolean;
}

/** Paused only while a model really loads; low while the local model generates; otherwise the creature page decides for itself. A status line alone (a base waiting for its adapter, an error) pauses nothing. */
export function creatureActivity(i: ActivityInputs): Activity {
  const paused = i.brainLoading || i.phase === "loading" || i.phase === "loaded";
  return { paused, low: !paused && i.localModelAnswering };
}
