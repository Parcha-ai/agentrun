// A run's one cap: its model requests and its workflow decisions admitted by the one rule (beforeRequestOf), one at a
// time across the run (runBooking over its sessions), and booked on one ledger, the runner records of its sessions
// (modelPortFor: runner.request with what it holds before it leaves, runner.turn with what it cost once it answers). So
// a decision is judged on the run's model spend beside its own and a model request on the run's decisions, a refusal's
// figures are the run's (main's holdPaid reads the whole run), and a claim taken again after a lost one rebuilds the
// spend of both from the journal: a decision held and never answered counts at its hold, as any request.
// Decisions book under their own session (DECISION_SESSION), held at their worst case (decisionAsk).
import { runBooking, type RunSessions } from "../../run-booking.js";
import { type BeforeRequest, modelPortFor, RUNNER_RECORDS, sessionSpendOf } from "../../runner.js";
import type { ModelRequest, ModelTicket, SessionRecord, SessionWriter } from "../../types.js";
import { overCapEnd } from "./words.js";
import { decisionAsk } from "./admit.js";
import { CapRefused, DecisionPriceUnreadable } from "./errors.js";
import { beforeRequestOf, capRequestOf, type PricedRequest } from "./port.js";
import type { Admission, CapModel, DecisionCapRequest, ModelCapRequest, RefusalFigures, Settled } from "./types.js";

/** A verdict of the run's rule, as a decision's admission reads it. */
type Verdict = { refuse?: string; forGood?: boolean; figures?: RefusalFigures; holdUsd?: number };

/** The session a run's workflow decisions book under. */
export const DECISION_SESSION = "decisions";

export interface RunCapOptions {
  /** The run's sessions: every key it has and each one's records (the journal's). */
  readonly sessions: RunSessions;
  /** The run's cap, read before every check, so a raise holds from the next one. Undefined: no cap. */
  capUsd(): number | undefined;
  /** The run's model requests' models, by id and route (BeforeRequestOptions.modelOf; its decisions' are the cap's own). */
  modelOf(id: string, route?: string): CapModel | undefined;
  /** The run's priced tools' charges and holds beside its requests (beforeRequestOf's), when it has any. */
  spentUsd?(): number | null;
  heldUsd?(): number | null;
  /** What the host keeps back beside a model request while it streams (BeforeRequestOptions.keepBackUsd). */
  keepBackUsd?(request: Parameters<BeforeRequest>[0], asked: ModelCapRequest): number | undefined;
  /** Told each request the rule judged, with the run's totals it was asked with, and its answer (an observer: a live
   *  view of the cap, a test's record). */
  judged?(request: Parameters<BeforeRequest>[0], answer: Awaited<ReturnType<BeforeRequest>>): void;
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
  /** A model request as `before` prices it (port.ts capRequestOf, with the same models): what the wrap-up's note and the
   *  reserve (requestFigures) price, so they price it as admission does. */
  asked(request: PricedRequest): ModelCapRequest;
  /** The run's decisions, booked on `writer` (the run's DECISION_SESSION) under the same rule. `flush`: makes what the
   *  journal holds survive a lost box, awaited once a decision's hold is written and before it is sent, as a model
   *  request's is (request_start), so a decision sent and then lost with its box still counts after the next claim. */
  decisions(writer: SessionWriter, options?: { flush?: () => Promise<void> }): Promise<RunDecisions>;
  /** The run's paid tool calls (a web search's or fetch's request, a monid call), booked on `writer` (the run's
   *  TOOL_SESSION) under the same rule: each held at its price before it is sent (flushed when `flush` is given) and
   *  settled at what it charged, as main's paidRequest books it. */
  tools(writer: SessionWriter, options?: { flush?: () => Promise<void> }): Promise<RunTools>;
}

/** A run's paid tool calls on its one cap. */
export interface RunTools {
  /** Admits the paid request `id` at its price (`holdUsd`): its hold, or CapRefused. `call`: the tool call it runs under,
   *  named on its runner.request (none for a step under no call, a person's browser time); `chargedBy`, who charges
   *  for it, named there as `charged_by`; `tool` and `tag`, the tool whose charge it is and its session (ModelRequest.paid);
   *  `owed`, money its provider is already owed: held and booked, never refused. `hold`: a hold-only step: money
   *  reserved, not spent; given back on a lost claim, never booked as cut. `ref`: the one booking it names: a ref already
   *  booked (on the run's records, or on this claim) books nothing again, and the answer says `booked`. */
  admit(request: { readonly id: string; readonly name: string; readonly holdUsd: number; readonly basis: string; readonly call?: string; readonly chargedBy?: string; readonly tool?: string; readonly tag?: string; readonly owed?: true; readonly hold?: true; readonly ref?: string }): Promise<Admission & { readonly booked?: true }>;
  /** Settles it at what it charged (null: at its hold; 0: nothing was billed). `givenBack`: its hold let go unused,
   *  nothing sent (at 0), its record marked so (ModelUsage.givenBack): never read as a $0 charge or an unpriced one. */
  settle(id: string, usd: number | null, options?: { readonly givenBack?: true }): Promise<number | null>;
  spentUsd(): number | null;
  heldUsd(): number;
}

/** The session a run's paid tool calls book under. */
export const TOOL_SESSION = "paid-tools";

/** How a run ends once its booked spend passed its cap (overCapEnd), read from its model session's `records` (each
 *  request at the figure the cap counts it at, sessionSpendOf's: one cut by a crash at its hold) and what its other
 *  sessions spent (`othersUsd`). Undefined while it fits, or with a spend unknown. */
export function overCapOf(records: readonly SessionRecord[], othersUsd: number, capUsd: number): string | undefined {
  const read = sessionSpendOf(records);
  if (read.spentUsd === null) return undefined;
  return overCapEnd(othersUsd + read.spentUsd, capUsd);
}

export function runCap(options: RunCapOptions): RunCap {
  /** Each decision under way's model, as the rule prices it (decisionAsk), by the model key its request books under. */
  const deciding = new Map<string, CapModel>();
  const pricing = { modelOf: (id: string, route?: string) => deciding.get(id) ?? options.modelOf(id, route) };
  const rule = beforeRequestOf({
    capUsd: options.capUsd,
    ...pricing,
    ...(options.spentUsd ? { spentUsd: options.spentUsd } : {}),
    ...(options.heldUsd ? { heldUsd: options.heldUsd } : {}),
    ...(options.keepBackUsd ? { keepBackUsd: options.keepBackUsd } : {}),
  });
  // A request on a free model is admitted marked so, under a cap or none: the runner books it a known $0 however it ends
  // (runner.ts Admitted), never unknown. One on a person's plan (CapModel.plan) is admitted marked so: $0 to the run however
  // it ends, cut by a crash included, and never free (its listing's price is no price). One the rule refused stays refused.
  const judge: BeforeRequest = async (request) => {
    const answer = await rule(request);
    if (answer && "refuse" in answer) return answer;
    if (!request.paid && pricing.modelOf(request.model, request.route)?.plan) return { ...answer, plan: true };
    return freeRequest(request, pricing.modelOf) ? { ...answer, free: true } : answer;
  };
  const before = runBooking(options.sessions, options.judged ? async (request) => {
    const answer = await judge(request);
    options.judged!(request, answer);
    return answer;
  } : judge);

  const forget = (key: string) => void deciding.delete(key);
  return {
    before,
    asked: (request) => capRequestOf("asked", request, pricing),
    async decisions(writer, decisionOptions = {}) {
      const steps = await stepsOn(writer, before, decisionOptions.flush, "decision", forget);
      return {
        async admit(request) {
          const capUsd = options.capUsd();
          // Under no cap a decision is not priced: nothing is read, nothing refused (its model may be "unreadable").
          if (capUsd !== undefined && request.model === "unreadable") throw new DecisionPriceUnreadable();
          const asked = capUsd === undefined || request.model === "unreadable" ? undefined : decisionAsk(request);
          const key = `decision:${request.id}`;
          if (asked) deciding.set(key, { ...asked.model, id: key });
          return steps.book(request.id, { model: key, ...(asked ? { inputTokensMax: asked.inputTokens, ...(asked.output === null ? {} : { outputTokensAsked: asked.output, outputTokensLeast: asked.output }), ...(asked.feeUsd > 0 ? { feeUsd: asked.feeUsd } : {}) } : { inputTokensMax: request.inputTokens }) });
        },
        settle: (id, settled) => steps.settle(id, "usd" in settled ? settled.usd : null),
        spentUsd: steps.spentUsd,
        heldUsd: steps.heldUsd,
      };
    },
    tools: (writer, toolOptions = {}) => paidCalls(writer, before, toolOptions),
  };
}

/** OpenRouter's routers, each of which picks a model per request: OpenRouter prices them at the routed model's price,
 *  which pi-ai's catalog writes as $0, so their zeros are no price and none is free. The same list as serve's
 *  local-models.ts ROUTERS. */
const ROUTERS: ReadonlySet<string> = new Set(["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/auto-code", "openrouter/free", "openrouter/fusion", "openrouter/pareto-code", "typesafe/jev-router"]);

/** Whether `request` is on a free model: one whose known price (CapModel.price) is $0 for every token, each tier's
 *  included, with no fee beside it (a native web search's) and no paid step's charge. A model with no known price is
 *  never free: its cost is unknown, never $0; nor is an OpenRouter router (ROUTERS), whatever its catalog price. */
function freeRequest(request: Parameters<BeforeRequest>[0], modelOf: (id: string, route?: string) => CapModel | undefined): boolean {
  if (request.paid || (request.feeUsd ?? 0) !== 0) return false;
  const model = modelOf(request.model, request.route);
  if (ROUTERS.has(request.model) || (model && ROUTERS.has(model.id))) return false;
  const price = model?.price;
  if (!price) return false;
  const zero = (rates: Omit<NonNullable<CapModel["price"]>, "tiers">) => rates.input === 0 && rates.output === 0 && (rates.cacheRead ?? 0) === 0 && (rates.cacheWrite ?? 0) === 0;
  return zero(price) && (price.tiers ?? []).every(zero);
}

/** A run's paid tool calls booked on `writer` (its TOOL_SESSION) under `before`, the run's one rule (runCap's, or the
 *  adapter loop's runBooking over its spec's check): each held at its price before it is sent (main's paidCall, by the
 *  rule's tool judgement), flushed first when `flush` is given, and settled at what it charged. */
export async function paidCalls(writer: SessionWriter, before: BeforeRequest, options: { flush?: () => Promise<void> } = {}): Promise<RunTools> {
  const steps = await stepsOn(writer, before, options.flush, "paid call", () => {});
  // Each `ref` the run's paid steps have booked (on its records, or admitted on this claim): a ref names one booking, so a
  // second admit of it books nothing (`booked`) and opens no step.
  let refs: Promise<Set<string>> | undefined;
  const refsOf = () => (refs ??= writer.read().then((records) => new Set(records.filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => (r.data as { ref?: unknown } | undefined)?.ref).filter((ref): ref is string => typeof ref === "string"))));
  const book = (request: Parameters<RunTools["admit"]>[0]) =>
    // A hold that is no figure (an unpriced browser provider's) goes to the rule as given, which refuses it for good.
    steps.book(request.id, { model: `paid:${request.name}`, inputTokensMax: 0, ...(request.holdUsd !== 0 ? { feeUsd: request.holdUsd } : {}), paid: { name: request.name, basis: request.basis, ...(request.call === undefined ? {} : { call: request.call }), ...(request.chargedBy === undefined ? {} : { charged_by: request.chargedBy }), ...(request.tool === undefined ? {} : { tool: request.tool }), ...(request.tag === undefined ? {} : { tag: request.tag }), ...(request.owed ? { owed: true as const } : {}), ...(request.hold ? { hold: true as const } : {}), ...(request.ref === undefined ? {} : { ref: request.ref }) } });
  return {
    admit: async (request) => {
      if (request.ref === undefined) return book(request);
      const booked = await refsOf();
      if (booked.has(request.ref)) return { id: request.id, heldUsd: 0, stoppedUsd: () => 0, booked: true as const };
      booked.add(request.ref);
      try {
        return await book(request);
      } catch (error) {
        booked.delete(request.ref);
        throw error;
      }
    },
    settle: (id, usd, options) => steps.settle(id, options?.givenBack ? 0 : usd, options),
    spentUsd: steps.spentUsd,
    heldUsd: steps.heldUsd,
  };
}

/** Steps that are no model request of the run's own (its decisions, its paid tool calls) booked on `writer` under `before`:
 *  each a runner.request before it is sent (flushed when `flush` is given) and a runner.turn once settled. */
async function stepsOn(writer: SessionWriter, before: BeforeRequest, flush: (() => Promise<void>) | undefined, what: string, forget: (key: string) => void) {
  {
    /** The verdict of the step being admitted (admissions run one at a time on the booking), for its refusal. */
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
      ...(flush ? { onEvent: async (event: { type: string }) => { if (event.type === "request_start") await flush(); } } : {}),
    });
    // A step an earlier claim admitted and that never answered: booked cut, counted at its hold.
    await booking.bookCut();
    const open = new Map<string, { ticket: ModelTicket; key: string; heldUsd: number }>();
    return {
      /** Books step `id`, asked as `asked` (its model key a decision's priced model, or a paid call's name). */
      async book(id: string, asked: ModelRequest): Promise<Admission> {
        const key = asked.model;
        verdict = undefined;
        let ticket: ModelTicket | void;
        try {
          ticket = await booking.models.beforeRequest(asked);
        } catch (error) {
          forget(key);
          const refused = lastVerdict();
          if (refused?.refuse !== undefined) throw new CapRefused(refused.refuse, { forGood: refused.forGood ?? true, spentUsd: refused.figures?.spentUsd ?? null, ...(refused.figures ? { figures: refused.figures } : {}) });
          throw error;
        }
        if (!ticket) throw new Error(`${what} ${id}: its booking gave it no ticket`);
        const admitted = lastVerdict();
        const held = typeof admitted?.holdUsd === "number" ? admitted.holdUsd : 0;
        open.set(id, { ticket, key, heldUsd: held });
        return { id, heldUsd: held, stoppedUsd: () => held };
      },
      async settle(id: string, usd: number | null, options?: { readonly givenBack?: true }): Promise<number | null> {
        const step = open.get(id);
        if (!step) throw new Error(`no ${what} ${id} is under way on this claim`);
        open.delete(id);
        forget(step.key);
        await booking.models.afterRequest({ input: 0, output: 0, cacheRead: 0, usd, ...(options?.givenBack ? { givenBack: true as const } : {}) }, step.ticket);
        return usd ?? step.heldUsd;
      },
      spentUsd: () => booking.spentUsd(),
      heldUsd: () => [...open.values()].reduce((sum, step) => sum + step.heldUsd, 0),
    };
  }
}
