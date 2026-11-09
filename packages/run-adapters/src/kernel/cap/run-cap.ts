// A run's one cap: its model requests and its workflow decisions admitted by the one rule (beforeRequestOf), one at a
// time across the run (runBooking over its sessions), and booked on one ledger, the runner records of its sessions
// (modelPortFor: runner.request with what it holds before it leaves, runner.turn with what it cost once it answers). So
// a decision is judged on the run's model spend beside its own and a model request on the run's decisions, a refusal's
// figures are the run's (main's holdPaid reads the whole run), and a claim taken again after a lost one rebuilds the
// spend of both from the journal: a decision held and never answered counts at its hold and its bound, as any request.
// Decisions book under their own session (DECISION_SESSION), priced as main holds them (decisionAsk).
import { runBooking, type RunSessions } from "../../run-booking.js";
import { type BeforeRequest, modelPortFor } from "../../runner.js";
import type { ModelTicket, SessionWriter } from "../../types.js";
import { decisionAsk } from "./admit.js";
import { CapRefused, DecisionPriceUnreadable } from "./errors.js";
import { beforeRequestOf } from "./port.js";
import type { Admission, CapMode, CapModel, DecisionCapRequest, Previous, RefusalFigures, Settled } from "./types.js";

/** A verdict of the run's rule, as a decision's admission reads it. */
type Verdict = { refuse?: string; forGood?: boolean; figures?: RefusalFigures; holdUsd?: number; boundUsd?: number };

/** The session a run's workflow decisions book under. */
export const DECISION_SESSION = "decisions";

export interface RunCapOptions {
  /** The run's sessions: every key it has and each one's records (the journal's). */
  readonly sessions: RunSessions;
  /** The run's cap, read before every check, so a raise holds from the next one. Undefined: no cap. */
  capUsd(): number | undefined;
  readonly mode?: CapMode;
  readonly now?: () => number;
  /** The run's model requests' models (its decisions' are the cap's own). */
  modelOf(id: string): CapModel | undefined;
  previousOf?(model: string): Previous | undefined;
  /** The run's priced tools' charges and holds beside its requests (beforeRequestOf's), when it has any. */
  spentUsd?(): number | null;
  heldUsd?(): number | null;
}

/** A run's decisions on its one cap: each admitted before it is sent and settled once it answered. */
export interface RunDecisions {
  /** Admits `request`: its hold, or CapRefused (for room, with its figures; or for good), or DecisionPriceUnreadable. */
  admit(request: DecisionCapRequest): Promise<Admission>;
  /** Settles the decision `id` at what it charged (`usd`; null: at its hold, as main books a charge not said). */
  settle(id: string, settled: Settled): Promise<number | null>;
  /** What the run's decisions cost, this claim's and every earlier claim's (null: unknown). */
  spentUsd(): number | null;
  /** What its decisions under way hold. */
  heldUsd(): number;
}

export interface RunCap {
  /** The run's one rule for every model request (a model booking's beforeRequest), its decisions' models known to it. */
  readonly before: BeforeRequest;
  /** The run's decisions, booked on `writer` (the run's DECISION_SESSION) under the same rule. `flush`: makes what the
   *  journal holds survive a lost box, awaited once a decision's hold is written and before it is sent, as a model
   *  request's is (request_start), so a decision sent and then lost with its box still counts after the next claim. */
  decisions(writer: SessionWriter, options?: { flush?: () => Promise<void> }): Promise<RunDecisions>;
}

export function runCap(options: RunCapOptions): RunCap {
  const mode: CapMode = options.mode ?? "expected";
  /** Each decision under way's model, as the rule prices it (decisionAsk), by the model key its request books under. */
  const deciding = new Map<string, CapModel>();
  const rule = beforeRequestOf({
    capUsd: options.capUsd,
    mode,
    ...(options.now ? { now: options.now } : {}),
    modelOf: (id) => deciding.get(id) ?? options.modelOf(id),
    ...(options.previousOf ? { previousOf: (model: string) => (deciding.has(model) ? undefined : options.previousOf!(model)) } : {}),
    ...(options.spentUsd ? { spentUsd: options.spentUsd } : {}),
    ...(options.heldUsd ? { heldUsd: options.heldUsd } : {}),
  });
  const before = runBooking(options.sessions, rule);

  return {
    before,
    async decisions(writer, decisionOptions = {}) {
      /** The verdict of the decision being admitted (admissions run one at a time on the booking), for its refusal. */
      let verdict: Verdict | undefined;
      const lastVerdict = (): Verdict | undefined => verdict;
      const booking = await modelPortFor(writer, {
        key: writer.key,
        label: writer.key,
        beforeRequest: async (request) => {
          const answer = await before(request);
          verdict = (answer ?? undefined) as Verdict | undefined;
          return answer;
        },
        // Its hold durable before it leaves: the booking awaits request_start once its runner.request is written.
        ...(decisionOptions.flush ? { onEvent: async (event: { type: string }) => { if (event.type === "request_start") await decisionOptions.flush!(); } } : {}),
      });
      // A decision an earlier claim admitted and that never answered: booked cut, counted at its hold and its bound.
      await booking.bookCut();
      const open = new Map<string, { ticket: ModelTicket; key: string; heldUsd: number }>();
      return {
        async admit(request) {
          const capUsd = options.capUsd();
          // Under no cap a decision is not priced: nothing is read, nothing refused (its model may be "unreadable").
          if (capUsd !== undefined && request.model === "unreadable") throw new DecisionPriceUnreadable();
          const asked = capUsd === undefined || request.model === "unreadable" ? undefined : decisionAsk(request, mode);
          const key = `decision:${request.id}`;
          if (asked) deciding.set(key, { ...asked.model, id: key });
          verdict = undefined;
          let ticket: ModelTicket | void;
          try {
            ticket = await booking.models.beforeRequest({
              model: key,
              ...(asked ? { inputTokensMax: asked.inputTokens, ...(asked.output === null ? {} : { outputTokensAsked: asked.output, outputTokensLeast: asked.output }), ...(asked.feeUsd > 0 ? { feeUsd: asked.feeUsd } : {}) } : { inputTokensMax: request.inputTokens }),
            });
          } catch (error) {
            deciding.delete(key);
            const refused = lastVerdict();
            if (refused?.refuse !== undefined) throw new CapRefused(refused.refuse, { forGood: refused.forGood ?? true, spentUsd: refused.figures?.spentUsd ?? null, ...(refused.figures ? { figures: refused.figures } : {}) });
            throw error;
          }
          if (!ticket) throw new Error(`decision ${request.id}: its booking gave it no ticket`);
          const admitted = lastVerdict();
          const held = typeof admitted?.holdUsd === "number" ? admitted.holdUsd : 0;
          const bound = typeof admitted?.boundUsd === "number" ? admitted.boundUsd : 0;
          open.set(request.id, { ticket, key, heldUsd: held });
          return { id: request.id, heldUsd: held, boundUsd: bound, worstUsd: held + bound, stoppedUsd: () => held };
        },
        async settle(id, settled) {
          const step = open.get(id);
          if (!step) throw new Error(`no decision ${id} is under way on this claim`);
          const usd = "usd" in settled ? settled.usd : null;
          open.delete(id);
          deciding.delete(step.key);
          await booking.models.afterRequest({ input: 0, output: 0, cacheRead: 0, usd }, step.ticket);
          return usd ?? step.heldUsd;
        },
        spentUsd: () => booking.spentUsd(),
        heldUsd: () => [...open.values()].reduce((sum, step) => sum + step.heldUsd, 0),
      };
    },
  };
}
