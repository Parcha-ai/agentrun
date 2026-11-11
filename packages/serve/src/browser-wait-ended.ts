// Why a run's browser is not up while the run is still going, for GET /v2/runs/{run_id}/computer's `none`: the browser
// was let go while the run waited for its person (browser-person.ts personHands.wait ends with a timeline row saying so),
// and the run has opened none since. The Screen tab says that, with when, instead of waiting for a browser nobody is
// opening. Read from the run's timeline rows, so it is the same fact the Timeline shows.

import { BROWSER_GONE_WHILE_WAITING } from "./browser-person.js";

/** The rows a wait's end writes (browser-person.ts): released at its window, at the cap, or the session ended under it. */
const ENDED_PREFIXES = ["The browser was released after ", "The browser was released while the run waited for you", BROWSER_GONE_WHILE_WAITING];
/** The row the Timeline shows when a browser session opens (timeline/timeline.ts). */
const SESSION_STARTED = "A live browser session started";

/** The newest wait-end row with no session opened after it: `at` (ISO) and `why` (the row's words), else undefined. */
export function browserWaitEnded(rows: readonly { kind: string; summary: string | null; timestamp: string }[]): { at: string; why: string } | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.kind !== "phase" || row.summary === null) continue;
    if (row.summary === SESSION_STARTED) return undefined;
    if (ENDED_PREFIXES.some((prefix) => row.summary!.startsWith(prefix))) return { at: row.timestamp, why: row.summary };
  }
  return undefined;
}
