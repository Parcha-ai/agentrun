// A race: 2 to 4 runs of one task, each on its own harness and model, grouped by one `race:<label>` label and watched side
// by side (#/races/<label>). The label is the race's only record: no table, no server change. A lane's own label
// (`lane:<n>`) orders the lanes, never their start times, so the order says nothing about who started first.
import type { Client } from "./client";
import { tokensWords } from "./format";
import { uuid } from "./idempotency";
import { steps } from "./timeline";
import type { Run, RunCreateInline, TimelineRow } from "./v2";

/** The label key that names a race, and the one that numbers its lanes. */
export const RACE_KEY = "race";
export const LANE_KEY = "lane";
/** At most this many lanes are watched at once. */
export const MAX_LANES = 4;
/** How long each lane's timeline read waits for news. The server speaks HTTP/1.1 and a browser keeps 6 connections per
 *  origin: four lanes on the usual 25 s wait would hold four of them, so a lane asks again every few seconds instead. */
export const LANE_WAIT_MS = 3_000;
/** How many runs one page of the race asks for, and how many pages one read of it follows at most (200 runs): a label
 *  reused past that is told as "at least". */
const RACE_READ = 50;
export const RACE_PAGES = 4;

/** GET /runs' label filter for race `label`. */
export const raceFilter = (label: string) => `${RACE_KEY}:${label}`;

const ENDED = new Set(["completed", "failed", "cancelled"]);
const laneOrder = new Intl.Collator(undefined, { numeric: true });

/** A race's lanes: by their lane label (a number read as a number), the run id breaking a tie, at most MAX_LANES. A run
 *  with no lane label (one started by hand with the race's label alone) comes after every numbered lane. */
export function lanesOf(runs: readonly Run[]): Run[] {
  const lane = (r: Run) => r.labels?.[LANE_KEY];
  const unnumbered = (r: Run) => (lane(r) === undefined ? 1 : 0);
  return [...runs].sort((a, b) => unnumbered(a) - unnumbered(b) || laneOrder.compare(lane(a) ?? "", lane(b) ?? "") || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0)).slice(0, MAX_LANES);
}

/** Race `label`'s lanes, and how many of its runs past MAX_LANES are not shown. GET /runs lists the newest first, so
 *  every page is read (up to RACE_PAGES) before the lanes are chosen: an older run with a lower lane still makes the
 *  first four. `atLeast` when pages were left unread, so there may be more than it counted. Archived runs are not read
 *  (the runs list's default), so not counted. */
export async function readRace(v2: Pick<Client, "listRuns">, label: string): Promise<{ lanes: Run[]; more: number; atLeast: boolean }> {
  // By run id: GET /runs pages by offset, so a run started between two page reads shifts the next page onto a run
  // already read, which counts once.
  const runs = new Map<string, Run>();
  let cursor: string | null = null;
  for (let page = 0; page < RACE_PAGES; page++) {
    const read: { runs: Run[]; next_cursor: string | null } = await v2.listRuns(RACE_READ, cursor, { label: raceFilter(label) });
    for (const run of read.runs) if (!runs.has(run.run_id)) runs.set(run.run_id, run);
    cursor = read.next_cursor;
    if (!cursor) break;
  }
  return { lanes: lanesOf([...runs.values()]), more: Math.max(0, runs.size - MAX_LANES), atLeast: cursor !== null };
}

/** A race starts with at least this many lanes. */
export const MIN_LANES = 2;
/** What one lane runs on. */
export type LaneChoice = { harness: string; model: string };

/** The inline run (POST /v2/runs) lane `n` of race `label` starts: an agent of its own (external `race-<label>-<n>`),
 *  one revision per harness and model (the external version), so a lane changed after a refusal is a new revision, never
 *  a conflict with the one refused. Every lane gets the race's task and cap, and the labels the race view reads. */
export function laneStart(label: string, n: number, lane: LaneChoice, task: string, maxCostUsd: number): RunCreateInline {
  return {
    external: { source: "console", kind: "race", id: `race-${label}-${n}`, version: `${lane.harness} ${lane.model}` },
    definition: { name: `Race ${label}, lane ${n}`, harness: lane.harness, model: lane.model },
    input: { content: task },
    max_cost_usd: maxCostUsd,
    labels: { [RACE_KEY]: label, [LANE_KEY]: String(n), harness: lane.harness, model: lane.model },
  };
}

/** A new race's label: when it starts (UTC, to the minute) and a few random characters, so two races never share one. */
export function newRaceLabel(now = new Date(), random: () => string = uuid): string {
  const at = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${at}-${random().slice(0, 4)}`;
}

/** What a lane's header says: cost (the run's own once it ended, else the newest timeline page's), tokens, tool calls
 *  (a call and its result are one), failed calls, and seconds on the clock (to its end, or to `now` while it goes). */
export type LaneStats = { cost: Run["cost"] | null; tokens?: string; toolCalls: number; failed: number; seconds: number };

export function laneStats(run: Run, rows: readonly TimelineRow[], pageCost: Run["cost"] | null, now: number): LaneStats {
  const ended = ENDED.has(run.status);
  const cost = ended || !pageCost ? run.cost : pageCost;
  const tools = steps(rows).filter((s) => s.row.kind === "tool_use" || s.row.kind === "tool_result");
  const until = ended && run.ended_at ? Date.parse(run.ended_at) : now;
  return {
    cost,
    tokens: tokensWords(cost),
    toolCalls: tools.length,
    failed: tools.filter((s) => s.row.tool_status === "failed" && s.row.refused !== true).length,
    seconds: Math.max(0, Math.round((until - Date.parse(run.created_at)) / 1000)),
  };
}
