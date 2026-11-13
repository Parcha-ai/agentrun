// Step guards in a learned workflow's run (the DSL's `guard` on a step, its WorkflowDeps.guardStep): after a guarded step
// ran, the chance it is right, p, from its signal; below its threshold the DSL escalates (kind `guard`) and the run hands
// the job back to its agent, in the same run, with the workflow's trace and the guard's row (#2603's hand-back).
//   - self: the step's own confidence (an agent or decide node submits one beside its record; a judge, pick or sift's is
//     its weakest answer's), read by the DSL.
//   - jev: one Jev call (TypeSafe's System One, JEV_GUARD_MODEL pinned) over the step's input and output, a yes/no
//     question (the guard's `question`, else DEFAULT_GUARD_QUESTION); its yes-probability is the signal.
//   - both: a logistic the job's graded runs fitted (`fit`: p = 1 / (1 + e^-(b + w·[self, jev])), raw probabilities in,
//     never logits), else the lower of the two. A single signal with a fit goes through it too (a Platt fit): a raw Jev
//     probability is badly calibrated until fitted (OG1: ECE 0.21 raw, 0.03 fitted), so a threshold is set on fitted p.
// No signal is no evidence the step is right: a guard whose Jev call failed, or a step that reported no confidence, has
// no p and hands back, never passes. Each Jev call is a paid request of the learned_workflow call (paid-calls.ts
// paidRequest: held at TypeSafe's published price for its input before it is sent, booked under the call), so it is
// the workflow's cost, under the run's cap. Every check is a row the run keeps (GuardRow, in its LEARNED_NODES trace and
// its metrics `guards`): B4's promotion replay and threshold refit read them.
import type { GuardStepParams, GuardVerdict, StepGuard } from "@parcha/agentrun-dsl";
import { DECISION_KEY_FD_ENV, decisionKeysOf, FAUX_JEV_ENV, fauxFetch, handedKeys, jevRouteOf } from "../decisions.js";
import { JEV_INPUT_USD } from "../decision-cap.js";
import { money } from "../cap.js";
import { bookedIn, type Fee, type Ledger, paidRequest } from "../paid-calls.js";
import type { GuardRow } from "../learned-nodes.js";

/** The Jev model a guard asks, pinned (https://docs.typesafe.ai/models, read 2026-11-13: jev-1.14.0 is current, and
 *  jev-latest points to it), by route: TypeSafe's own name, or OpenRouter's. A new Jev is a new pin and a new fit. */
export const JEV_GUARD_MODEL = { typesafe: "jev-1.14.0", openrouter: "typesafe/jev-1.14" } as const;
/** The question a jev guard asks when its guard names none. */
export const DEFAULT_GUARD_QUESTION = "Is this output correct for this input?";
/** The most bytes of a step's input and of its output a guard sends Jev, each: a longer one goes as its first part, said
 *  to be cut. */
export const GUARD_PART_BYTES = 24_000;
/** What the guard's yes and no mean to Jev. */
const GUARD_CRITERIA = { true: "the output is right for this input", false: "the output is wrong, incomplete, or not supported by the input" };
/** The question id a guard's request asks under. */
const GUARD_QUESTION_ID = "right";

/** One guard check, as the run keeps it (learned-nodes.ts GuardRow). */
export type { GuardRow };

/** One Jev request as a guard sends it: a state and its questions, answered with their answers and what it cost. */
export type GuardJev = (request: { state: unknown; questions: Record<string, unknown>; signal?: AbortSignal }) => Promise<{ answers: Record<string, { type: string; noul?: number }>; cost_usd?: number | null }>;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** p from a guard's signals: through its fit when it has one, else the one signal, or the lower of the two for both;
 *  null when a signal it reads is missing. */
export function guardP(guard: Pick<StepGuard, "signal" | "fit">, signals: { self: number | null; jev: number | null }): number | null {
  const x = guard.signal === "self" ? [signals.self] : guard.signal === "jev" ? [signals.jev] : [signals.self, signals.jev];
  if (x.some((value) => value === null || !Number.isFinite(value))) return null;
  const read = x as number[];
  const fit = guard.fit;
  if (fit && Array.isArray(fit.w) && fit.w.length === read.length) return sigmoid(fit.b + fit.w.reduce((sum, w, i) => sum + w * read[i]!, 0));
  return Math.min(...read);
}

/** A part of what a guard sends, whole up to GUARD_PART_BYTES, else its first part and how long it was. */
function part(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text, "utf8") <= GUARD_PART_BYTES) return value ?? null;
  return { cut: `${Buffer.from(text, "utf8").subarray(0, GUARD_PART_BYTES).toString("utf8")}…`, bytes: Buffer.byteLength(text, "utf8") };
}

/** A Jev request's hold and charge: TypeSafe's published price for its input, one token a byte of its body (its output
 *  is free), as the decision cap holds a Jev decision (decision-cap.ts holdOf). */
export const jevGuardFee = (body: string): Fee => {
  const tokens = Buffer.byteLength(body, "utf8");
  return { name: "Jev's step guard", tool: "learned_workflow", by: "typesafe", usd: Math.round(tokens * JEV_INPUT_USD * 1e9) / 1e9, basis: `TypeSafe's published price for Jev, ${money(JEV_INPUT_USD * 1e6)} a million input tokens, for ${tokens} tokens at most` };
};

/** How long a guard's Jev request has, its attempts included: a guard that hears nothing hands back. */
export const GUARD_JEV_DEADLINE_MS = 30_000;

/** The run's Jev for its guards: the client a workflow's decision nodes ask (decisions.ts decisionProvidersFrom's
 *  jevProvider, the same route and keys: the claim's own, which learnedDecisionKeys put on its environment for a
 *  workflow with a Jev guard (providersNamed), or a per-run process's on its pipe), pinned to JEV_GUARD_MODEL, each
 *  request a paid one of the call it runs in (paidRequest, at jevGuardFee). Undefined with no Jev key. */
export async function guardJevOf(env: NodeJS.ProcessEnv): Promise<GuardJev | undefined> {
  const route = jevRouteOf(env[DECISION_KEY_FD_ENV] !== undefined ? handedKeys(env) : decisionKeysOf(env));
  if (!route) return undefined;
  const [{ jevProvider }, faux] = await Promise.all([import("@parcha/agentrun-jev"), fauxFetch(env, FAUX_JEV_ENV)]);
  const send = faux ?? globalThis.fetch;
  // Each request booked as it is sent, at its body's price, under the call the guard runs in.
  const fetch = (url: string | URL | Request, init?: RequestInit) => paidRequest(jevGuardFee(typeof init?.body === "string" ? init.body : ""), () => send(url as never, init));
  const jev = jevProvider({ ...route, model: JEV_GUARD_MODEL[route.provider], fetch: fetch as never });
  let asked = 0;
  return async (request) => {
    const own = request.signal ?? new AbortController().signal;
    return (await jev.decide({ label: "guard", kind: "judge", state: request.state, questions: request.questions } as never, { decisionId: `guard-${(asked += 1)}`, signal: own, deadlineMs: GUARD_JEV_DEADLINE_MS })) as never;
  };
}

/** The DSL's guardStep for one learned_workflow call: Jev asked (through `jev`, made on first need) only for a guard that
 *  reads it, its request booked under the call's ledger as `<call>/<step>@<path>#guard`; p by guardP, NaN (no p) when
 *  a signal it reads is missing. */
export function stepGuard(opts: { jev: () => Promise<GuardJev | undefined>; ledger?: Ledger; call: string }): (params: GuardStepParams) => Promise<GuardVerdict> {
  return async (params) => {
    const { guard } = params;
    let jev: number | null = null;
    if (guard.signal !== "self") {
      const ask = await opts.jev().catch(() => undefined);
      if (ask) {
        const ledger = opts.ledger ? { ...opts.ledger, call: `${opts.call}/${params.label}@${params.executionPath}${params.item ? `#${params.item.index}` : ""}#guard` } : undefined;
        try {
          const answered = await bookedIn(ledger, () => ask({ state: { step: params.label, input: part(params.input), output: part(params.output) }, questions: { [GUARD_QUESTION_ID]: { type: "noul", instructions: guard.question?.trim() || DEFAULT_GUARD_QUESTION, criteria: GUARD_CRITERIA } }, ...(params.signal ? { signal: params.signal } : {}) }));
          const noul = answered.answers?.[GUARD_QUESTION_ID]?.noul;
          jev = typeof noul === "number" && Number.isFinite(noul) ? noul : null;
        } catch (error) {
          // A stop is the call's stop; any other failure leaves no Jev signal, so the step hands back.
          if (params.signal?.aborted) throw error;
        }
      }
    }
    const p = guardP(guard, { self: params.self, jev });
    return { p: p ?? Number.NaN, jev };
  };
}

/** A guard.evaluated event's detail as the run's row of it (GuardRow), under the step's label. */
export function rowOf(label: string, detail: unknown): GuardRow | undefined {
  const d = (detail ?? {}) as { signal?: unknown; threshold?: unknown; p?: unknown; self?: unknown; jev?: unknown; escalated?: unknown };
  if (d.signal !== "self" && d.signal !== "jev" && d.signal !== "both") return undefined;
  if (typeof d.threshold !== "number") return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const self = num(d.self);
  const jev = num(d.jev);
  return { node: label, signal: d.signal, ...(self === undefined ? {} : { self }), ...(jev === undefined ? {} : { jev }), p: num(d.p) ?? null, threshold: d.threshold, escalated: d.escalated === true };
}

/** A guard row in words, for the hand-back: what it read and where p fell against its threshold. */
export function guardLine(row: GuardRow): string {
  const said = (n: number | undefined | null) => (typeof n === "number" ? n.toFixed(2) : "none");
  const read = [row.self !== undefined || row.signal !== "jev" ? `its own confidence ${said(row.self)}` : "", row.signal !== "self" ? `Jev ${said(row.jev)}` : ""].filter(Boolean).join(", ");
  return `guard on "${row.node}" (${row.signal}): p ${said(row.p)} against threshold ${row.threshold} (${read}); ${row.escalated ? "handed back" : "passed"}`;
}
