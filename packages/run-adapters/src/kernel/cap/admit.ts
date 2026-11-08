// createCap: the kernel cap on its own ledger (pi in process, decisions, priced tools), every decision by the one rule
// (rule.ts capRule.judge) and every note by noteFor. Before each step what the run has spent, plus what its steps under
// way hold, plus what this step needs at the least, must stay within the cap, read before every check so a raise holds
// from the next paid step. Each step holds under its own id until it settles; its start mark (with its hold) is written
// before it leaves, its end mark (with what booking.ts booked) before its result comes back.
import { Ledger } from "./ledger.js";
import type { CapMarks, StartMark } from "./marks.js";
import { ownCostsOf, spendOf, toldIn } from "./recover.js";
import { capRule, noteFor, priced } from "./rule.js";
import { CapRefused, DecisionPriceUnreadable } from "./errors.js";
import type { Admission, Cap, CapMode, CapOptions, CapRequest, DecisionCapRequest, ModelCapRequest, Settled } from "./types.js";

export { CapRefused, DecisionPriceUnreadable };

const NO_HOLD = (id: string): Admission => ({ id, heldUsd: 0, boundUsd: 0, worstUsd: 0, stoppedUsd: () => 0 });
/** A step whose start mark could not be written is not sent. */
export const MARK_NOT_WRITTEN = "the model request was not sent: its mark could not be written";
/** A step whose end mark did not land within its wait. */
export const END_NOT_WRITTEN = "the model request's end could not be recorded";
export const END_MARK_WAIT_MS = 10_000;

/** The cap of a run opened again: what it has spent read from its marks (recover.ts), a step a crash cut at its hold, its
 *  own priced answers and whether its wrap-up was told. */
export async function openCap(options: CapOptions & { marks: CapMarks }): Promise<Cap> {
  const read = await options.marks.read();
  const spent = spendOf(read).spentUsd;
  return createCap({ ...options, spentUsd: options.spentUsd === undefined ? spent : options.spentUsd }, { costs: ownCostsOf(read), told: toldIn(read) });
}

/** A decision held as a model request is, at its fixed output: all of it or refused, never clamped. */
const asModel = (request: DecisionCapRequest): ModelCapRequest => {
  if (request.model === "unreadable") throw new DecisionPriceUnreadable();
  return { kind: "model", id: request.id, model: request.model, inputTokens: request.inputTokens, outputAsked: request.outputTokens, outputTokensLeast: request.outputTokens };
};

export function createCap(options: CapOptions, seed: { costs?: { model: string; usd: number }[]; told?: boolean } = {}): Cap {
  const mode: CapMode = options.mode ?? "expected";
  const now = options.now ?? Date.now;
  const ledger = new Ledger(options.spentUsd === undefined ? 0 : options.spentUsd);
  const marks = options.marks;
  const costs = [...(seed.costs ?? [])];
  let told = seed.told ?? false;
  /** The note last offered, which the told mark keeps once a request carrying it is answered. */
  let offered: { words: string; leftUsd: number } | undefined;
  /** What each model request under way is, for its settle. */
  const steps = new Map<string, { model: string; side: boolean; noted: boolean }>();
  const ownCosts = (model: string): number[] => costs.filter((cost) => cost.model === model).map((cost) => cost.usd);
  /** Each step's settle, by id: its booking and which of its marks landed, so a retry books nothing twice. */
  const settlements = new Map<string, { usd: number | null; rule: string; tells: boolean; endWritten: boolean; toldWritten: boolean }>();

  /** A refused step's own start mark, before its refusal is thrown; a mark that fails still ends it with the refusal. */
  const refusing = async (id: string, refusal: CapRefused, extra: Partial<StartMark>): Promise<never> => {
    await marks?.write({ kind: "start", id, at: now(), heldUsd: 0, refused: true, ...extra }).catch(() => undefined);
    throw refusal;
  };
  /** A step's start mark, before it leaves: one that fails lets its hold go and the step is not sent. */
  const started = async (admission: Admission, extra: Partial<StartMark>, heldUsd: number | null = admission.heldUsd): Promise<Admission> => {
    if (!marks) return admission;
    try {
      await marks.write({ kind: "start", id: admission.id, at: now(), heldUsd, ...(admission.boundUsd > 0 ? { boundUsd: admission.boundUsd } : {}), ...extra });
    } catch {
      ledger.release(admission.id);
      throw new Error(MARK_NOT_WRITTEN);
    }
    return admission;
  };
  /** A write of an end's marks within END_MARK_WAIT_MS: past it, or failed, the step's result fails loudly. */
  const withinWait = async (write: Promise<void>): Promise<void> => {
    const wait = options.endMarkWaitMs ?? END_MARK_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([write, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${END_NOT_WRITTEN}: its end mark did not land within ${wait} ms`)), wait)))]);
    } catch (error) {
      throw new Error(error instanceof Error && error.message.startsWith(END_NOT_WRITTEN) ? error.message : `${END_NOT_WRITTEN}: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async admit(input: CapRequest): Promise<Admission> {
      const request = input.kind === "decision" ? asModel(input) : input;
      const extra: Partial<StartMark> = request.kind === "tool" ? { tool: request.name } : { model: request.model.id, ...(request.side ? { side: true as const } : {}) };
      // Read before every check: a raise holds from the next paid step.
      const capUsd = options.capUsd();
      let admission: Admission;
      if (capUsd === undefined) admission = NO_HOLD(request.id);
      else {
        try {
          const judged = capRule.judge(request, { capUsd, spentUsd: ledger.spent(), heldUsd: ledger.held(), mode, now: now() });
          admission = { id: request.id, ...judged };
        } catch (error) {
          if (error instanceof CapRefused) return refusing(request.id, error, extra);
          throw error;
        }
        // Every step holds, a $0 one too: its settle then books a known figure (its charge, else its $0 hold).
        ledger.hold(request.id, { usd: admission.heldUsd, stoppedPrice: admission.stoppedUsd });
      }
      // With no cap nothing was held: its start mark holds no figure, so a crash before its end reopens as unknown.
      const sent = await started(admission, extra, capUsd === undefined ? null : admission.heldUsd);
      if (request.kind === "model") steps.set(request.id, { model: request.model.id, side: request.side === true, noted: request.noted === true });
      return sent;
    },
    async settle(id: string, ended: Settled): Promise<number | null> {
      // Booked once: a settle retried after its marks failed reuses the first booking, its costs and its note.
      let settled = settlements.get(id);
      if (!settled) {
        const { usd, rule } = ledger.settle(id, ended);
        const step = steps.get(id);
        steps.delete(id);
        const answered = rule.startsWith("answered");
        if (step && !step.side && answered && typeof usd === "number" && usd > 0) costs.push({ model: step.model, usd });
        // The note is told once the request carrying it is answered, never before.
        const tells = step?.noted === true && answered && !told;
        if (tells) told = true;
        settled = { usd, rule, tells, endWritten: false, toldWritten: false };
        settlements.set(id, settled);
      }
      if (marks && !settled.endWritten) {
        await withinWait(marks.write({ kind: "end", id, at: now(), usd: settled.usd, rule: settled.rule }));
        settled.endWritten = true;
      }
      if (marks && settled.tells && !settled.toldWritten) {
        await withinWait(marks.write({ kind: "told", id, at: now(), words: offered?.words ?? "", leftUsd: offered?.leftUsd ?? 0 }));
        settled.toldWritten = true;
      }
      return settled.usd;
    },
    leastUsd(request: ModelCapRequest): number {
      const p = priced(request, mode, now());
      return p ? p.cost(p.least) : Number.NaN;
    },
    note(request: ModelCapRequest) {
      const note = noteFor(request, { capUsd: options.capUsd(), spentUsd: ledger.spent(), heldUsd: ledger.held(), costs: ownCosts(request.model.id), told, mode, now: now() });
      if (note) offered = note;
      return note;
    },
    ownCosts,
    spentUsd: () => ledger.spent(),
    heldUsd: () => ledger.held(),
  };
}
