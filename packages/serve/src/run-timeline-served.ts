// A run's Timeline as the store path serves it: its journal's rows (store-reads/journal.ts runTimeline) shown by the run's
// one cut (run-cut.ts) the way main's served view showed them (runs.ts show): every row cut of the cut set in the
// renderer (timelineOf's redact, so a cut never leaves a key's head); each call that waited for approval in order;
// a workflow's decision rows among them by time, each
// shown through the same set (decision-rows.ts withDecisions); and each error row read as the run's error is (main's
// servedError): a refused key in plain words (key-refusal.ts keyRefusal), else the provider's words in the error's one
// rule (shownOf: no held value, no loopback address); and its learning row once its learning ended (main's withLearning).
// A run whose hand can't be read back here serves no row. A trigger's row names the trigger as it is now (main's
// servedTriggerRow): its name read by its id from the store at each read, never one the run's launch froze, cut as the
// row's words are; a trigger gone keeps the id the journal wrote.
import type { Context } from "@earendil-works/chord";
import { TRIGGER_LABELS, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { withDecisions } from "./decision-rows.js";
import { currentLearning, holdsForOk, type ItemStatus, type Learning, secretsShown } from "./learning.js";
import { withLearning } from "./learning-run.js";
import { runLearningEnd } from "./store-reads/learning.js";
import { redacted } from "./key-refusal.js";
import { runCutValues, runErrorWordsOf } from "./run-cut.js";
import { answersOf, asksOf, type SignInReader, shownOf, withApprovalRows, withAsks } from "./run-view.js";
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
  /** Each learned item's status on an agent's learning folder's main (learning-routes.ts statusesOf): what a run held for
   *  its owner's OK reads as it stands there. None: as the merge wrote it. */
  readonly statuses?: (agentId: string) => Promise<ReadonlyMap<string, ItemStatus> | undefined>;
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
  // A question the agent asked (ask_person) and waits on: its waiting row after the call's result (run-view.ts withAsks), as
  // the run's view carries it and main's served Timeline did, so the console's "The agent asks" box reads that question,
  // never an earlier wait's words.
  const rows = withApprovalRows(withAsks(await runTimeline(store, runId, context, { redact })), asksOf(records.entries), answersOf(records.entries, { final }), redact);
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
  // The run's learning row, once its learning was proposed, merged or dropped (learning-run.ts withLearning, main's row):
  // its end from the store (runLearningEnd), what it held for the owner's OK read as the run's view reads it (on its agent's
  // folder's main), its words cut by the same set.
  const end = await runLearningEnd(store, runId);
  const learning = end ? (holdsForOk(end as Learning) && run && deps.statuses ? currentLearning(end as Learning, await deps.statuses(run.agentId)) : (end as Learning)) : undefined;
  const learned = withLearning(own, learning, secretsShown(values));
  // Each trigger the rows name, read once for this read: its name now, or none for one gone.
  const names = new Map<string, string | undefined>();
  for (const row of learned) if (row.trigger && !names.has(row.trigger.id)) names.set(row.trigger.id, (await store.triggers.get(row.trigger.id))?.name);
  // A refused key's plain words are its summary and its text alike; any other error keeps each in the one rule.
  const shown = shownOf(values);
  return learned.map((row) => {
    if (row.trigger) return named(row, names.get(row.trigger.id), redact);
    if (row.kind !== "error") return row;
    const said = row.text ? words(row.text) : undefined;
    if (said !== undefined && said !== shown(row.text!)) return { ...row, summary: said, text: said };
    return { ...row, ...(row.summary ? { summary: shown(row.summary) } : {}), ...(said !== undefined ? { text: said } : {}) };
  });
}

/** A trigger's row as served: "<label> <its name>: <its first line>", the name on its trigger too, for a trigger that has
 *  one now (`given`, read by its id), cut by the run's redactor first (a key pasted into a trigger's name never shows)
 *  and on one line; as the journal wrote it, "<label> <its id>: …", for one that is gone. */
function named(row: TimelineEvent, given: string | undefined, redact: (text: string) => string): TimelineEvent {
  const { id, source } = row.trigger!;
  const name = given === undefined ? undefined : redact(given).replace(/\s+/g, " ").trim();
  const label = TRIGGER_LABELS[source];
  const written = `${label} ${id}: `;
  return name && row.summary?.startsWith(written) ? { ...row, summary: `${label} ${name}: ${row.summary.slice(written.length)}`, trigger: { ...row.trigger!, name } } : row;
}
