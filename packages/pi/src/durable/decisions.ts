// A run's decision rows as pi-durable stores them: the session document `agentrun.decisions`, one row per typed
// question the run asked, in commit order. The row is a stored format (version 1) and does not change with the
// interpreter: a host maps `@parcha/agentrun-dsl`'s `DecisionReceipt` to a row, with the facts only the host has (the
// request's size and metering, whether the node acted on the answers), and this module stores and reads rows without
// looking inside them.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineDoc, type DocumentReader, type Harness } from "@earendil-works/pi-durable";

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
};

const DecisionsDoc = defineDoc<{ receipts: JsonValue[] }>({ kind: DECISION_RECEIPTS_DOC, version: 1, scope: "session", initial: () => ({ receipts: [] }) });

/** Commit one row, appended after every row committed before it. */
export async function appendDecision(harness: Pick<Harness, "commit">, row: DecisionRow, context: Context = BACKGROUND_CONTEXT): Promise<void> {
  const stored = JSON.parse(JSON.stringify(row)) as JsonValue;
  await harness.commit(async (tx) => { (await tx.doc(DecisionsDoc)).receipts.push(stored); }, context);
}

/** Every row the run's Session holds, in commit order. */
export async function readDecisions(read: DocumentReader, context: Context = BACKGROUND_CONTEXT): Promise<DecisionRow[]> {
  const doc = await read.snapshot(DecisionsDoc, context);
  return (doc?.receipts ?? []) as unknown as DecisionRow[];
}

/** Where a writer commits: the run's Session, opened when the first row needs it and released by `flush`. */
export type DecisionSession = { harness: Pick<Harness, "commit">; release(): Promise<void> };

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
