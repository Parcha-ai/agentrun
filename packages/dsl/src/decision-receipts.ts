// Decision receipts: one record per typed-question request, holding what was asked, what came back, the
// rule that turns those answers into an action (its thresholds included) and the action itself. A receipt
// alone explains a decision: `rederiveDecision` recomputes the action from it without a model call.
import { answerConfidence, answersToValue, type CompiledQuestions, type SystemOneAnswer, type SystemOneQuestion } from "./system-one.js";

export const DECISION_RECEIPT_VERSION = 1;

/** The typed questions the interpreter asks: the five question nodes and predicates, and a generative
 *  node's `verify` clause. */
export type DecisionKind = "judge" | "pick" | "sift" | "route" | "ask" | "verify";

/** How answers become the action, with every threshold applied. */
export type DecisionRule =
  /** judge: each question's decoded value (a choice, a yes/no at 0.5, a rounded score). */
  | { kind: "judge" }
  /** pick: the chosen option names an item by its position, or none. */
  | { kind: "pick"; options: string[]; none: string | null }
  /** route: the chosen branch, or the unsure branch when the choice's confidence is below `gte`. */
  | { kind: "route"; unsure: { gte: number; branch: string } | null }
  /** sift: an item of this request is kept when its `keep` measure meets `gte`; every item without a keep
   *  rule. `items` counts this request's items; the action names them by their position in the request. */
  | { kind: "sift"; items: number; ids: string[]; keep: { id: string; measure: "confidence" | "value"; gte: number } | null }
  /** ask: the predicate holds when the yes-probability meets `gte`. */
  | { kind: "ask"; gte: number }
  /** verify: a yes/no question fails when its yes-probability is below its threshold (null: not judged).
   *  A failed question the submission holds is doubted; a failed one it lacks is unmet. */
  | { kind: "verify"; thresholds: Record<string, number | null>; present: string[] };

export type DecisionReceipt = {
  v: typeof DECISION_RECEIPT_VERSION;
  /** The request's identity: where it sits in the run (execution path, kind, position among its node's
   *  requests) and what it asked (questions and state). The same request asked again has the same id. */
  id: string;
  /** When the receipt was made, ISO 8601. */
  at: string;
  /** The label the request carried, a child workflow's prefix included. */
  node: string;
  kind: DecisionKind;
  /** The map item the request ran for, by index; null outside a map. */
  item: number | null;
  execution_path: string;
  /** This request among the requests its node makes at this path. A sift over the host's limits sends
   *  `count` requests, and `items` lists the positions in the sifted list this one covers, in the order it
   *  asked about them. A verify clause's nth review has index n - 1 and `count` is the most it may ask.
   *  Every other kind asks once. */
  request: { index: number; count: number; items?: number[] };
  /** `answered`: the answers came back and decided `action`. `failed`: the judge rejected, or its answers
   *  were refused. `cancelled`: the request's signal was aborted before it settled, so whether it was
   *  served is not known. */
  status: "answered" | "failed" | "cancelled";
  /** SHA-256 of the canonical JSON of the state the judge was given. */
  state_sha256: string;
  questions: Record<string, SystemOneQuestion>;
  /** What came back, as it came back; empty when nothing did. */
  answers: Record<string, SystemOneAnswer>;
  /** Null unless `status` is `answered`. */
  rule: DecisionRule | null;
  /** What the answers decide under `rule`; null unless `status` is `answered`. */
  action: unknown;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number | null;
  request_sha256: string | null;
  /** Wall time of the judge call, in milliseconds. */
  latency_ms: number;
  error?: string;
};

/** The action a receipt's answers and rule determine, recomputed without a model call: for an answered
 *  receipt it equals `receipt.action`. Null for a receipt that decided nothing. */
export function rederiveDecision(receipt: Pick<DecisionReceipt, "rule" | "answers" | "questions">): unknown {
  const rule = receipt.rule;
  const answers = receipt.answers as Record<string, any>;
  if (!rule) return null;
  switch (rule.kind) {
    case "judge": return answersToValue(receipt.answers, receipt.questions as CompiledQuestions);
    case "pick": {
      const choice = answers.pick?.choice;
      const none = rule.none !== null && choice === rule.none;
      return { index: none ? null : rule.options.indexOf(choice), none };
    }
    case "route": {
      const branch = answers.branch?.choice;
      const unsure = Boolean(rule.unsure && answers.branch.confidence < rule.unsure.gte);
      return { branch, taken: unsure ? rule.unsure!.branch : branch, unsure };
    }
    case "sift": {
      const kept: number[] = [];
      for (let i = 0; i < rule.items; i += 1) {
        if (!rule.keep) { kept.push(i); continue; }
        const answer = answers[`${i}.${rule.keep.id}`];
        const measure = !answer ? NaN : rule.keep.measure === "confidence" ? answerConfidence(answer) : answer.type === "noul" ? answer.noul : answer.type === "score" ? answer.score : NaN;
        if (Number.isFinite(measure) && measure >= rule.keep.gte) kept.push(i);
      }
      return { kept };
    }
    case "ask": return { holds: Number(answers.holds?.noul) >= rule.gte };
    case "verify": {
      const doubted: string[] = [];
      const unmet: string[] = [];
      for (const [id, threshold] of Object.entries(rule.thresholds)) {
        if (threshold === null || !(Number(answers[id]?.noul) < threshold)) continue;
        (rule.present.includes(id) ? doubted : unmet).push(id);
      }
      return { accepted: doubted.length === 0 && unmet.length === 0, doubted, unmet };
    }
  }
}
