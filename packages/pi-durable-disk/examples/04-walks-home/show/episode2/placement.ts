// Where the tab is running, as the message the tab waits for: its holder logic keys off the stage's `set-placement {kind}` (gpu while the agent is away,
// tab at home), the same message Walks Home's stage sends. Pure: the state in, the message out, or null when there is nothing to say yet (no environment, or
// the run is between two machines).
import type { HostKind, ShowState } from "../types.ts";

const TAB_KIND: Record<HostKind, "tab" | "daytona" | "gpu" | "vm"> = { tab: "tab", sandbox: "daytona", vm: "vm", gpu: "gpu", pipe: "tab" };

export type PlacementMessage = { type: "set-placement"; kind: "tab" | "daytona" | "gpu" | "vm"; label: string; since: number };

export function placementMessage(state: ShowState, since: number): PlacementMessage | null {
  const env = state.currentEnv;
  if (!env) return null;
  const found = state.environments.find((e) => e.id === env);
  const label = "host" in state.place && state.place.host ? state.place.host : (found?.label ?? env);
  return { type: "set-placement", kind: TAB_KIND[found?.kind ?? "tab"], label, since };
}

/** What makes two placements the same one: the environment and the host. The page sends a placement once, until it changes (or the tab reloads). */
export const placementKey = (state: ShowState): string => `${state.currentEnv ?? ""}|${"host" in state.place ? state.place.host : ""}`;

/**
 * When the page sends the placement: a live `place` event, a (re)connect of the feed (no event), and the tab becoming ready (again). Once per placement
 * until it changes or the tab reloads. The decision is here, not in the page, so each trigger is testable on its own: a live place event must send without
 * the feed having reconnected.
 */
export class PlacementSender {
  private last = "";
  private ready: () => boolean;
  private send: (message: PlacementMessage) => void;
  private now: () => number;

  constructor(options: { ready: () => boolean; send: (message: PlacementMessage) => void; now?: () => number }) {
    this.ready = options.ready;
    this.send = options.send;
    this.now = options.now ?? Date.now;
  }

  private maybe(state: ShowState): void {
    if (!this.ready()) return;
    const message = placementMessage(state, this.now());
    const key = placementKey(state);
    if (!message || key === this.last) return;
    this.last = key;
    this.send(message);
  }

  /** The feed's event: a live `place` event (`event` is it) or a (re)connect (`event` is null). Other events change no placement. */
  onFeed(event: { t: string } | null, state: ShowState): void {
    if (event === null || event.t === "place") this.maybe(state);
  }

  /** The tab said ready: a reloaded tab knows nothing yet, so it is told again. */
  onReady(state: ShowState): void {
    this.last = "";
    this.maybe(state);
  }
}
