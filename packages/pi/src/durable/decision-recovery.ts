// A workflow task's decision receipts, durable in its run's Session: each receipt is a row (decisions.ts) committed
// through the task's own commit before the interpreter acts on its answers, and a resumed run's request is answered
// from the row its earlier process committed, so the judge is not asked again and the run decides what it decided.
// Every run in the Session shares the rows' document, and a receipt's id does not name its run, so each row carries
// the run's key and a run is answered only from its own rows.
import { DECISION_RECEIPT_VERSION, type DecisionExchange, type DecisionReceipt, type DecisionRule } from "@parcha/agentrun-dsl";
import type { DocumentReader, Harness, Tx } from "@earendil-works/pi-durable";
import { appendDecision, DECISION_ROW_VERSION, readDecisions, type DecisionRow } from "./decisions.js";
import type { WorkflowInvocation } from "./task.js";

type Context = WorkflowInvocation["context"];

/** The interpreter's two decision hooks over one invocation of a workflow task. */
export type DecisionRecovery = {
  /** The interpreter's `recordDecision`: commits the receipt's row after every row recorded before it, and resolves
   *  once that commit is durable; a commit that fails rejects this receipt's call. The task's state is untouched. */
  recordDecision(receipt: DecisionReceipt, exchange: DecisionExchange): Promise<void>;
  /** The interpreter's `recovery.decision`: the receipt rebuilt from the last answered row this run recorded under
   *  `id`, or undefined when it recorded none (a request that failed, one recorded without its identity, or one another
   *  run recorded, is asked again). */
  decision(id: string): Promise<DecisionReceipt | undefined>;
};

/** A receipt as the row the run `key` stores: the receipt's own fields, its identity, and the request's size. */
function rowOf(receipt: DecisionReceipt, exchange: DecisionExchange, key: string): DecisionRow {
  return {
    v: DECISION_ROW_VERSION, at: receipt.at, node: receipt.node, kind: receipt.kind, item: receipt.item, execution_path: receipt.execution_path,
    request_sha256: receipt.request_sha256,
    request_bytes: Buffer.byteLength(JSON.stringify({ state: exchange.request.state, questions: exchange.request.questions })),
    model: receipt.model, questions: receipt.questions, answers: receipt.answers, rule: receipt.rule, action: receipt.action,
    usage: receipt.usage, cost_usd: receipt.cost_usd, latency_ms: receipt.latency_ms, ...(receipt.error !== undefined ? { error: receipt.error } : {}),
    decision_id: receipt.id, request: receipt.request, state_sha256: receipt.state_sha256, run_key: key,
  };
}

/** The receipt the run `key`'s last answered row under `id` is: a rule is set only on an answered receipt, and an
 *  answered one carries no error. */
function answeredReceipt(rows: DecisionRow[], id: string, key: string): DecisionReceipt | undefined {
  const row = rows.findLast((stored) => stored.run_key === key && stored.decision_id === id && stored.rule !== null && stored.error === undefined
    && stored.request !== undefined && stored.state_sha256 !== undefined && stored.execution_path !== null);
  if (!row) return undefined;
  return {
    v: DECISION_RECEIPT_VERSION, id, at: row.at, node: row.node, kind: row.kind, item: row.item, execution_path: row.execution_path!,
    request: row.request!, status: "answered", state_sha256: row.state_sha256!,
    questions: row.questions as DecisionReceipt["questions"], answers: row.answers as DecisionReceipt["answers"], rule: row.rule as DecisionRule, action: row.action,
    model: row.model, usage: row.usage, cost_usd: row.cost_usd, request_sha256: row.request_sha256, latency_ms: row.latency_ms,
  };
}

/** The decision hooks a durable host gives the interpreter inside `WorkflowTaskHost.run`, over the invocation it is
 *  handed (the run's key, the task's runtime and context): `recordDecision` as the interpreter's own, and `decision` as
 *  `recovery.decision` beside the driver's recovery hooks. */
export function decisionRecovery(invocation: { key: string; runtime: Pick<WorkflowInvocation["runtime"], "commit"> & DocumentReader; context: Context }): DecisionRecovery {
  const { key, runtime, context } = invocation;
  const harness: Pick<Harness, "commit"> = {
    commit: async <T>(change: (tx: Tx) => T | Promise<T>): Promise<T> => {
      let result!: T;
      await runtime.commit(async (tx) => { result = await change(tx); return undefined; }, context);
      return result;
    },
  };
  let chain: Promise<unknown> = Promise.resolve();
  return {
    recordDecision(receipt, exchange) {
      const row = rowOf(receipt, exchange, key);
      const committed = chain.then(() => appendDecision(harness, row, context));
      chain = committed.catch(() => undefined);
      return committed;
    },
    async decision(id) {
      return answeredReceipt(await readDecisions(runtime, context), id, key);
    },
  };
}
