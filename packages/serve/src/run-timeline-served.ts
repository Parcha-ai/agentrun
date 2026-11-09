// A run's Timeline as the store path serves it: its journal's rows (store-reads/journal.ts runTimeline) shown by the run's
// one cut (run-cut.ts) the way main's served view showed them (runs.ts show): every row cut of the cut set in the
// renderer (timelineOf's redact, so a cut never leaves a key's head); each call that waited for approval in order;
// a workflow's decision rows among them by time, each
// shown through the same set (decision-rows.ts withDecisions); and each error row read as the run's error is (main's
// servedError): a refused key in plain words (key-refusal.ts keyRefusal), else the provider's words in the error's one
// rule (shownOf: no held value, no loopback address). A run whose hand can't be read back here serves no row.
import type { Context } from "@earendil-works/chord";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { withDecisions } from "./decision-rows.js";
import { redacted } from "./key-refusal.js";
import { runCutValues, runErrorWordsOf } from "./run-cut.js";
import { answersOf, asksOf, type SignInReader, shownOf, withApprovalRows } from "./run-view.js";
import { journalRecords } from "./runner/journal-reader.js";
import { decisionsOverStore } from "./store-reads/decisions.js";
import { readRun } from "./store-reads/runs.js";
import { runTimeline } from "./store-reads/journal.js";
import { FINAL_STATES, type Store } from "./store/store.js";

export type ServedTimelineDeps = {
  readonly serverSecrets: () => string[];
  readonly signIns?: SignInReader;
  /** The environment a run's model key is read from, with the keys a person saved (withSecrets, as main's plainKey). */
  readonly keyEnv: () => NodeJS.ProcessEnv;
};

/** Run `runId`'s Timeline rows as served: cut by its one cut set, its decision rows among them, its error rows in the
 *  run's error's words; none for a run withheld. */
export async function servedTimelineRows(deps: ServedTimelineDeps, store: Store, runId: string, context: Context): Promise<TimelineEvent[]> {
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") return [];
  const { values } = cut;
  const redact = (text: string) => redacted(text, values);
  // The rows a person reads: each call that waited for approval in order (held, your approval, what came of it), its
  // arguments and the person's notes through the cut (run-view.ts withApprovalRows), as main's served Timeline read them.
  // A call asked before an end in the journal reads withdrawn in that end's words; a stopped or failed run's (states no
  // reopen leaves) whose journal holds no end, by its row (answersOf `final`).
  const run = await store.runs.get(runId);
  const ended = run ? FINAL_STATES.includes(run.state) : false;
  const records = await journalRecords(store.readJournal(runId), context);
  const final = run?.state === "stopped" || run?.state === "failed" ? run.state : undefined;
  const rows = withApprovalRows(await runTimeline(store, runId, context, { redact }), asksOf(records.entries), answersOf(records.entries, { final }), redact);
  // A workflow's decisions: their rows among the model nodes' by time, each text shown through the cut set, with as many
  // characters held back from a text stored cut as a held value takes in its widest form (main's decisionShown).
  const receipts = await decisionsOverStore(store, runId, context).catch(() => null);
  const decisionShown = { redact: (text: string) => redacted(text, values), hold: 6 * values.reduce((most, value) => Math.max(most, value.length), 0) + 16 };
  const own = receipts === null || receipts.length ? withDecisions(rows, receipts, decisionShown, { ended }) : rows;
  // An error row reads as the run's error does (run-cut.ts runErrorWordsOf, main's errorWords): a refused key in plain
  // words, else no held value and no loopback address.
  const workflow = (await readRun(store, runId, context))?.kind === "workflow";
  const words = await runErrorWordsOf(deps, store, runId, { workflow });
  if (words === "unreadable") return [];
  // A refused key's plain words are its summary and its text alike; any other error keeps each in the one rule.
  const shown = shownOf(values);
  return own.map((row) => {
    if (row.kind !== "error") return row;
    const said = row.text ? words(row.text) : undefined;
    if (said !== undefined && said !== shown(row.text!)) return { ...row, summary: said, text: said };
    return { ...row, ...(row.summary ? { summary: shown(row.summary) } : {}), ...(said !== undefined ? { text: said } : {}) };
  });
}
