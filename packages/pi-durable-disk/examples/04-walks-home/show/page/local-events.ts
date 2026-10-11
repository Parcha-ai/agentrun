// The events the page itself folds in, the tab's own messages: they never came through the server, so a new snapshot (a reconnect) would drop them. The page keeps the last few and replays
// them over each snapshot.
import { reduce } from "../reduce.ts";
import type { ShowEvent, ShowState } from "../types.ts";

export class LocalEvents {
  private events: ShowEvent[] = [];

  private readonly cap: number;

  constructor(cap = 200) {
    this.cap = cap;
  }

  get size(): number {
    return this.events.length;
  }

  apply(state: ShowState, event: ShowEvent): ShowState {
    this.events.push(event);
    if (this.events.length > this.cap) this.events.shift();
    return reduce(state, event);
  }

  replay(state: ShowState): ShowState {
    return this.events.reduce(reduce, state);
  }
}
