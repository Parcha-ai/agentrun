// The kernel cap's requests and answers: one door (Cap.admit) for every paid step a run takes, a model request on any
// harness, a priced tool, a decision; the same rule and the same words for each. Not exported from the package until the
// cutover.
import type { Ended } from "../../booking.js";
import type { InputShape } from "../../host/overhead.js";
import type { CapMarks } from "./marks.js";

/** A model's list price, in USD per million tokens, as the catalog gives it. No cache prices: the input price. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** A model as the cap prices it: its API (what its provider adds server-side, and whether its thinking takes a budget),
 *  its price (null: none known), and its output ceiling (null: none). */
export interface CapModel {
  readonly id: string;
  readonly api: string;
  readonly price: ModelPrice | null;
  readonly outputCeiling: number | null;
  readonly reasoning?: boolean;
}

/** The previous request of the conversation, as its usage reported it: what of its input was read from or written to
 *  the cache, the rest, its input bound (the unit this request's is in) and when it ended (ms), on which model. */
export interface Previous {
  readonly model: string;
  readonly cachedTokens: number;
  readonly inputTokens: number;
  readonly boundTokens: number;
  readonly endedAt: number;
}

/** A model request about to be sent, from any harness (pi in process, a CLI's through the model proxy). */
export interface ModelCapRequest {
  readonly kind: "model";
  /** The request's own id: it holds and settles under it, so requests in flight together never share a hold. */
  readonly id: string;
  readonly model: CapModel;
  /** Its input bound: one token per UTF-8 byte of what is sent. Undefined: not measured. */
  readonly inputTokens: number | undefined;
  /** What its provider adds server-side, by what it carries (tools, images). */
  readonly shape?: InputShape;
  /** What its hosted tools read into its input that its body does not hold (a native search's allowance). */
  readonly extraInputTokens?: number;
  /** The most its hosted tools may charge beside its tokens. */
  readonly feeUsd?: number;
  /** The output it asks for. Undefined: its model's ceiling. */
  readonly outputAsked?: number;
  /** The least output it may be limited to and still answer (the proxy's policy says). Absent: 1,024 for the answer, and
   *  its thinking's least. */
  readonly outputTokensLeast?: number;
  /** Its thinking budget, on an API whose thinking takes one beside the answer's output. */
  readonly thinkingBudget?: number;
  readonly previous?: Previous;
  /** A side call (a title, a summary), never its turn's own. */
  readonly side?: boolean;
  /** It carries the cap's wrap-up note (Cap.note) in its body, its bytes in `inputTokens`: told once it is answered. */
  readonly noted?: boolean;
}

/** A verify decision about to be judged: held at its model's price for its input and output. "unreadable": its catalog
 *  could not be read for a price. */
export interface DecisionCapRequest {
  readonly kind: "decision";
  readonly id: string;
  readonly model: CapModel | "unreadable";
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A priced tool call about to be made: held at its quote, or its allowance, until it is charged. */
export interface ToolCapRequest {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly holdUsd: number;
  /** Why it is held at that: "its quote", "the allowance". */
  readonly basis: string;
}

export type CapRequest = ModelCapRequest | ToolCapRequest | DecisionCapRequest;

/** A step the cap let go: what it is held at until it settles (a model request's expected cost at the output it may be
 *  sent with, its worst case under strict), the most a cache miss can add (`boundUsd`), its worst case, and for a model
 *  request the output it is limited to and what it counts at if stopped having streamed that many tokens. */
export interface Admission {
  readonly id: string;
  readonly heldUsd: number;
  readonly boundUsd: number;
  readonly worstUsd: number;
  readonly outputTokensMax?: number;
  readonly thinkingBudget?: number;
  stoppedUsd(streamedTokens: number): number;
}

/** A refusal for room's figures, beside its words: what the cap counted as taken, the least the step needs, and the least
 *  cap that sends it (the figure its words name). */
export interface RefusalFigures {
  readonly spentUsd: number;
  readonly needsUsd: number;
  readonly leastCapUsd: number;
  readonly boundUsd?: number;
}

/** How a step ended, for settle: a model request's as booking.ts reads it; a paid call's charge (null: it did not say). */
export type Settled = Ended | { end: "charged"; usd: number | null };

export interface CapOptions {
  /** The run's cap, read before every paid check, so a raise holds from the next one. Undefined: no cap. */
  capUsd(): number | undefined;
  mode?: CapMode;
  /** What the run has spent when the cap opens (null: unknown). openCap reads it from `marks`. */
  spentUsd?: number | null;
  now?: () => number;
  /** Where each step's start and end marks go (the journal binds it); none: the cap keeps no marks. */
  marks?: CapMarks;
  /** How long settle waits for a step's end mark before it fails loudly. Default 10 s. */
  endMarkWaitMs?: number;
}

/** How the cap prices a request's input: "expected" from the previous request's cache; "strict" every token uncached. */
export type CapMode = "expected" | "strict";

export interface Cap {
  admit(request: CapRequest): Promise<Admission>;
  /** Books a step that ended, its hold let go: a model request by how it ended, a paid call at its charge (its hold when
   *  it said none). Answers its figure. */
  settle(id: string, ended: Settled): Promise<number | null>;
  /** A request's least admission: its input and least output at its price, the figure admit refuses it below. */
  leastUsd(request: ModelCapRequest): number;
  spentUsd(): number | null;
  heldUsd(): number;
  /** The wrap-up note for `request`, the run's next main-model request measured before the note is placed, when it is
   *  due and not yet told; none for a side call, or when the request fits what is left only without the note's bytes. */
  note(request: ModelCapRequest): { words: string; leftUsd: number } | undefined;
  /** The run's own priced answers on `model`, the wrap-up's typical cost's costs. */
  ownCosts(model: string): number[];
}
