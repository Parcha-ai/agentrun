// The end-of-run turn's range in a run's record: which store entries and rows are the turn's (reflects), the rows
// labelled as the host's (labelled), and whether a run is in its turn now (reflecting). The runner's learning end
// (runner/learning-end.ts), the store's reads (store-reads/journal.ts) and the store-backed view (store-view.ts) read
// a run's turn by it.
import type { TimelineEvent } from "./timeline/index.js";
import { LEARNING_LABEL } from "./learning.js";
import { said } from "./learning-words.js";
import { askedForDryRun } from "./learn/reflect.js";
import type { Status } from "./run-view.js";

/** A run's end-of-run turn: the job's outcome, the newest store entry before the turn and, once the run ended, the newest
 *  after it (its rows are those between), its deadline, and how it ended. */
export type Reflect = { outcome: Status; after: number; until?: number; deadline: string; ended?: true; timedOut?: true };
/** The run asked its end-of-run turn and has not ended since. */
export const reflecting = (run: { meta: { reflect?: Reflect } }) => run.meta.reflect !== undefined && run.meta.reflect.until === undefined;
/** A row's store entry, from its id (`<conversation>:<entry>[:...]`); NaN for a row no entry made (a live one, usage). */
const entryOf = (id: string) => Number(id.split(":")[1]);
/** Whether entry `id` (a number), or the row `id`, is the end-of-run turn's. Before the run has ended every later entry
 *  is, and so is a live row. */
export function reflects(reflect: Reflect | undefined, id: string | number): boolean {
  if (!reflect) return false;
  const entry = typeof id === "number" ? id : entryOf(id);
  if (Number.isInteger(entry)) return entry > reflect.after && (reflect.until === undefined || entry <= reflect.until);
  return reflect.until === undefined && typeof id === "string" && id.includes(":live:");
}
/** `rows` with the end-of-run turn's labelled: never the run's answer (meaningful skips the label), its answer shown as
 *  a text row, and its message as the host's, in a person's words (learning-words.ts): what the model is asked stays in
 *  the run's store, and no row shows it. */
export function labelled(reflect: Reflect | undefined, rows: TimelineEvent[]): TimelineEvent[] {
  if (!reflect) return rows;
  return rows.map((row) => (!reflects(reflect, row.id) ? row : {
    ...row, agent_label: LEARNING_LABEL,
    ...(row.kind === "final_answer" ? { kind: "text_block" as const } : {}),
    // The turn asked again for a draft whose dry run failed says so; every other message of the turn is its ask.
    ...(row.kind === "user_message" ? (askedForDryRun(row.text) ? { summary: said.askedDryRun, text: said.askedDryRun } : { summary: said.asked, text: said.asked }) : {}),
  }));
}
