// The rows only a run's served view makes (runs.ts show(): a pause's waiting row, the harness's install row, the learning
// row), tagged where each is made. No store entry makes one, so the live path's keep (keepCommitted), which holds a row a
// committed entry made though a later snapshot no longer has it, never holds one: it is served while show() makes it,
// and goes once show() stops. The tag is a symbol, never on the wire.
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";

const SERVED_ONLY = Symbol("agentrun.servedOnly");

/** `row`, tagged as one only the served view makes. */
export function servedOnly<T extends TimelineEvent>(row: T): T {
  return Object.assign(row, { [SERVED_ONLY]: true });
}

