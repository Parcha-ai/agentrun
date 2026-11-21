// GET /v2/capacity: what an operator, or an autoscaler, reads to size the runners. Read from the store alone, so a server
// with no runner beside it (--no-runner, the API-only profile) answers for every runner on its store: the runs waiting for
// a runner and the runs a claim holds, each live runner (its row seen within PRESENCE_STALE_MS) with its version, its
// slots and how many are free, and the hand-backs within a window. Counts, runner names and versions only: no run id,
// agent, prompt, address or customer's word. Behind the server's token, as every route but capabilities and health.
import { ApiError } from "./errors.js";
import { PRESENCE_STALE_MS } from "./runner/presence.js";
import type { Runners } from "./store/store.js";

/** The hand-back window when none is asked, in minutes. */
export const CAPACITY_WINDOW_MINUTES = 15;
/** The longest window, in minutes: the hand-backs the store keeps (schema.ts HAND_BACKS_KEPT_MS). */
export const CAPACITY_WINDOW_MAX_MINUTES = 24 * 60;

/** One live runner, as the capacity read shows it. */
export interface CapacityRunner {
  /** The runner's name (--name, AGENTRUN_RUNNER_NAME, or its host and process). */
  readonly id: string;
  /** Its build's version; null for a runner of a build before this read. */
  readonly version: string | null;
  /** The most runs it holds at once (its loops); null when it did not say (a build before this read, or a runner that
   *  refused to claim). */
  readonly slots: number | null;
  /** The runs its live claims hold now. */
  readonly executing: number;
  /** Its slots less what it holds (never below 0), 0 for a runner that refused to claim, null with no slots said. A
   *  runner also claims by its host's memory (memory-claim.ts), so a free slot is the most it may take, not a promise. */
  readonly free_slots: number | null;
  /** It refused to claim any run (its run isolation refused): it takes none. Its words are in capabilities' runner_refused. */
  readonly refused: boolean;
  /** When it last said it was there (the deadlines' clock). */
  readonly seen_at: string;
}

/** The capacity read's answer. */
export interface CapacityView {
  /** When it was read (the deadlines' clock: the database's on Postgres). */
  readonly at: string;
  readonly runs: {
    /** Runs waiting for a runner now: queued, handed back or with their claim run out (past any backoff), or parked with
     *  something to wake them; the backlog a scaler reads. */
    readonly queued: number;
    /** Runs a live claim holds now, on any runner. */
    readonly executing: number;
  };
  /** The live runners, by name. */
  readonly runners: readonly CapacityRunner[];
  /** The free slots of every live runner that said its slots. */
  readonly free_slots: number;
  /** Runs given back still running (a drain, a loop that closed itself, a claim given back) within the window. */
  readonly hand_backs: { readonly window_minutes: number; readonly count: number };
}

/** The `window` query parameter in minutes: CAPACITY_WINDOW_MINUTES when absent; a whole number from 1 to
 *  CAPACITY_WINDOW_MAX_MINUTES, else 400 bad_request. */
export function capacityWindowOf(url: URL): number {
  const text = url.searchParams.get("window");
  if (text === null) return CAPACITY_WINDOW_MINUTES;
  const minutes = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(minutes >= 1 && minutes <= CAPACITY_WINDOW_MAX_MINUTES)) throw new ApiError("bad_request", `window is a whole number of minutes from 1 to ${CAPACITY_WINDOW_MAX_MINUTES}, not ${JSON.stringify(text)}`);
  return minutes;
}

/** The capacity read over `runners` (the store's), with hand-backs over the last `windowMinutes`. */
export async function capacityOverStore(runners: Pick<Runners, "live" | "capacity">, windowMinutes: number, staleMs = PRESENCE_STALE_MS): Promise<CapacityView> {
  const [counts, live] = await Promise.all([runners.capacity(windowMinutes * 60_000), runners.live(staleMs)]);
  const shown = live.map((row): CapacityRunner => {
    const executing = counts.held.get(row.runner) ?? 0;
    const refused = row.refused !== null;
    return {
      id: row.runner,
      version: row.version,
      slots: row.slots,
      executing,
      free_slots: refused ? 0 : row.slots === null ? null : Math.max(0, row.slots - executing),
      refused,
      seen_at: new Date(row.seenAt).toISOString(),
    };
  });
  let executing = 0;
  for (const count of counts.held.values()) executing += count;
  return {
    at: new Date(counts.at).toISOString(),
    runs: { queued: counts.queued, executing },
    runners: shown,
    free_slots: shown.reduce((sum, runner) => sum + (runner.free_slots ?? 0), 0),
    hand_backs: { window_minutes: windowMinutes, count: counts.handBacks },
  };
}
