// A run's decision rows as pi-durable stores them, one row per typed question the run asked, in commit order. Two
// forms, one per store: a run on a fresh store writes the KEYED family (below), one document of kind `agentrun.decisions`
// per row, written once; a store that already holds the OLD single session document `agentrun.decisions` (its
// `receipts` list, rewritten at every commit) keeps writing it to the end of its run, so a recording never holds both.
// The row is a stored format (version 1) and is the same in both forms, byte for byte; it does not change with the
// interpreter: a host maps `@parcha/agentrun-dsl`'s `DecisionReceipt` to a row, with the facts only the host has (the
// request's size and metering, whether the node acted on the answers), and this module stores and reads rows without
// looking inside them.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type DocumentReader, type Harness, type JsonObject } from "@earendil-works/pi-durable";

/** The session document that holds a run's decision rows. */
export const DECISION_RECEIPTS_DOC = "agentrun.decisions";
/** The stored row's version. */
export const DECISION_ROW_VERSION = 1;

/** How the answers became the action, with every threshold applied. */
export type DecisionRowRule =
  /** judge: each question's decoded value (choice, noul at 0.5, rounded score). */
  | { kind: "judge" }
  /** pick: the chosen option names an item by its position, or none. */
  | { kind: "pick"; options: string[]; none: string | null }
  /** route: the chosen branch, or the unsure branch when the choice's confidence is below `gte`. */
  | { kind: "route"; unsure: { gte: number; branch: string } | null }
  /** sift: an item is kept when its `keep` measure meets `gte`; every item without a keep rule. */
  | { kind: "sift"; items: number; ids: string[]; keep: { id: string; measure: "confidence" | "value"; gte: number } | null }
  /** ask: the predicate holds when p_yes meets `gte`. */
  | { kind: "ask"; gte: number }
  /** verify: a noul question fails when p_yes is below its threshold (null: not judged, an empty field); a failed
   *  question the submission holds is doubted, a failed one it lacks is unmet. */
  | { kind: "verify"; thresholds: Record<string, number | null>; present: string[] };

/** One stored decision row. */
export type DecisionRow = {
  v: typeof DECISION_ROW_VERSION;
  at: string;
  node: string;
  kind: "judge" | "pick" | "sift" | "route" | "ask" | "verify";
  item: number | null;
  execution_path: string | null;
  request_sha256: string | null;
  request_bytes: number;
  model: string | null;
  questions: Record<string, unknown>;
  answers: Record<string, unknown>;
  rule: DecisionRowRule | null;
  /** What the run did with the answers; null when the node did not act on them. */
  action: unknown;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number | null;
  latency_ms: number;
  error?: string;
  /** The request's spend is on its frozen driver's state, so a cost fold counts it there, not here. */
  driver_spend?: true;
  /** The receipt's id, its place among its node's requests, the digest of the state it was asked with, and the key of
   *  the workflow run that asked it. A row that carries all four is the whole receipt again, so that run, resumed, can be
   *  answered from it (`decisionRecovery`); another run in the same Session never is. */
  decision_id?: string;
  request?: { index: number; count: number; items?: number[] };
  state_sha256?: string;
  run_key?: string;
};

/** The old form: one session document whose `receipts` list is rewritten at every commit. Read, and written only in a store that holds it. */
const DecisionsDoc = defineDoc<{ receipts: JsonValue[] }>({ kind: DECISION_RECEIPTS_DOC, version: 1, scope: "session", initial: () => ({ receipts: [] }) });
/** The keyed form: one document per row, of the same kind, keyed by the row's place in the run's rows (`keyOf`), written once. The
 *  document's value is exactly the row. */
const DecisionRowDoc = defineDocFamily<JsonObject, null>({ kind: DECISION_RECEIPTS_DOC, version: 1, scope: "session", family: true, initial: () => ({}) });
/** How many rows the keyed form holds: its next key. A few bytes, so rewriting it at every commit costs the same at every count. */
export const DECISION_COUNT_DOC = "agentrun.decisions.count";
const DecisionCountDoc = defineDoc<{ count: number }>({ kind: DECISION_COUNT_DOC, version: 1, scope: "session", initial: () => ({ count: 0 }) });
/** A keyed row's key: its place, zero-padded so the keys sort in commit order. */
export const decisionKey = (place: number): string => String(place).padStart(8, "0");

export type DecisionForm = "single" | "keyed";
/** What a writer commits through: a Harness, or anything with its `commit` and `snapshot`. It must be able to read the store: the form is the store's, and a writer that could not look would have to guess. */
type Writer = Pick<Harness, "commit" | "snapshot">;
const forms = new WeakMap<object, Promise<DecisionForm>>();
/** The form a reader's store holds: `single` when the old document is there, else `keyed`. Settled once per reader (the run's open): a
 *  run that began on the old document never switches mid-run. A reader with no way to read the store is refused, never guessed: a guess of `keyed` over an
 *  old store would write both forms into one recording, and a guess of `single` would write the old list into a fresh one. */
export function decisionForm(read: Partial<Pick<DocumentReader, "snapshot">>, context: Context = BACKGROUND_CONTEXT): Promise<DecisionForm> {
  if (typeof read.snapshot !== "function") return Promise.reject(new Error("agentrun.decisions: the writer cannot read the store, so it cannot tell which form the store holds; give it a Harness, or an object with commit and snapshot"));
  let known = forms.get(read);
  if (!known) {
    known = read.snapshot(DecisionsDoc, context).then((old): DecisionForm => (old === undefined ? "keyed" : "single"));
    forms.set(read, known);
    known.catch(() => forms.delete(read));
  }
  return known;
}

/** Commit one row, appended after every row committed before it. */
export async function appendDecision(harness: Writer, row: DecisionRow, context: Context = BACKGROUND_CONTEXT): Promise<void> {
  const stored = JSON.parse(JSON.stringify(row)) as JsonObject;
  if ((await decisionForm(harness, context)) === "single") {
    await harness.commit(async (tx) => { (await tx.doc(DecisionsDoc)).receipts.push(stored); }, context);
    return;
  }
  await harness.commit(async (tx) => {
    const count = await tx.doc(DecisionCountDoc);
    const place = count.count;
    count.count = place + 1;
    Object.assign(await tx.doc(DecisionRowDoc, decisionKey(place), null), stored);
  }, context);
}

/** Every row the run's Session holds, in commit order. */
export async function readDecisions(read: DocumentReader, context: Context = BACKGROUND_CONTEXT): Promise<DecisionRow[]> {
  return (await readDecisionsFrom(read, 0, context)).rows;
}

/** The rows from place `from` on and the place after the last: for a keyed store only the new ones are read, so a reader that
 *  keeps `next` reads each row once. The old document is read whole (its list is the rows; `next` is its length). */
export async function readDecisionsFrom(read: Pick<DocumentReader, "snapshot">, from: number, context: Context = BACKGROUND_CONTEXT): Promise<{ rows: DecisionRow[]; next: number }> {
  if ((await decisionForm(read, context)) === "single") {
    const rows = ((await read.snapshot(DecisionsDoc, context))?.receipts ?? []) as unknown as DecisionRow[];
    return { rows: rows.slice(from), next: rows.length };
  }
  const total = (await read.snapshot(DecisionCountDoc, context))?.count ?? 0;
  const rows: DecisionRow[] = [];
  for (let at = from; at < total; at += 64) {
    const batch = await Promise.all(Array.from({ length: Math.min(64, total - at) }, (_, i) => read.snapshot(DecisionRowDoc, decisionKey(at + i), context)));
    for (const doc of batch) if (doc !== undefined) rows.push(doc as unknown as DecisionRow);
  }
  return { rows, next: total };
}

/** Where a writer commits: the run's Session, opened when the first row needs it and released by `flush`. */
export type DecisionSession = { harness: Writer; release(): Promise<void> };

export type DecisionWriter = {
  /** Commit `row` after every row recorded before it. It returns at once; a commit that fails is kept for
   *  `settled` and `flush`, and the rows after it are still committed. */
  record(row: DecisionRow): void;
  /** Every row recorded so far is committed; the first that could not be is thrown, and kept for `flush`. The
   *  Session stays open. */
  settled(): Promise<void>;
  /** Every row is committed and every Session the writer opened is released, also when a commit failed; a row
   *  recorded while flush runs is committed too. Then the first failed commit is thrown, or, when none failed, the
   *  first failed release. */
  flush(): Promise<void>;
};

/** A writer that commits rows in the order they are recorded. `open` runs once, when the first row is committed, so
 *  a run that records no row never opens its Session here. */
export function createDecisionWriter(options: { open: () => Promise<DecisionSession>; context?: Context }): DecisionWriter {
  let session: Promise<DecisionSession> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  return {
    record(row) {
      const stored = JSON.parse(JSON.stringify(row)) as DecisionRow;
      chain = chain
        .then(async () => appendDecision((await (session ??= options.open())).harness, stored, options.context))
        .catch((error) => { failure ??= { error }; });
    },
    async settled() {
      await chain;
      if (failure) throw failure.error;
    },
    async flush() {
      let released: { error: unknown } | undefined;
      // A row recorded while flush waits or releases joins the chain, so flush returns only when a full pass saw no new
      // row. The Session is cleared before it is released: a row recorded meanwhile opens its own, which the next pass
      // releases.
      for (;;) {
        const drained = chain;
        await drained;
        if (drained !== chain) continue;
        const held = session;
        session = undefined;
        if (held) {
          const opened = await held.catch(() => undefined);
          try { await opened?.release(); } catch (error) { released ??= { error }; }
        }
        if (drained === chain) break;
      }
      const first = failure ?? released;
      failure = undefined;
      if (first) throw first.error;
    },
  };
}
