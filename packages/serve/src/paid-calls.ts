// A web tool's request to Parallel (its search, web-search.ts; its extract, web-fetch.ts), booked as monid.run's call
// is (monid.ts): on the run's one ledger (the kernel cap's paid tool calls, RunTools), admitted at the request's price
// before it is sent (refused unsent in the cap's words when the cap does not hold it) and settled after at what it
// charged. A charge is the run's cost, a line of its own on its timeline and /usage's `tools` meter. Every request goes
// through the run's one Parallel client's `post` (web-fetch.ts), which books it here by the endpoint it asks.
// Parallel's answers report what they used as SKU counts, never an amount, so each request is booked at Parallel's
// published price, an estimate: its price on a 2xx; nothing on a 4xx other than a 408 (Parallel refused it before any
// work); and its price on a 408, a 5xx or a request that failed or was stopped after it was sent, which Parallel may
// have billed, as the decision provider books Parallel's (@parcha/agentrun-decisions).
// A request with no run's ledger to book it on, or to an endpoint with no price here, is never sent: it fails closed,
// as a priced MCP call does (mcp-gateway.ts).
// The ledger a request is booked on (the run's RunTools, its pause, the call it runs under) is set around the call: around
// each host tool call by the adapter loop's `bookedIn`, around a workflow call node's tool by its own (workflow-spec.ts),
// and narrowed to the tool's own call by `booking`, where the web tools are bound (tools.ts). The client deep inside a
// tool books without the ledger passed down to it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord/context";
import type { Refusal } from "@parcha/agentrun-kernel";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { SPEND_CAP_REACHED } from "./cap.js";

/** Parallel's published prices (https://docs.parallel.ai/getting-started/pricing, read 2026-11-03): a `fast` search
 *  $1 per 1,000 requests for up to 10 results, each further result $1 per 1,000; an extract $1 per 1,000 URLs. */
export const PARALLEL_SEARCH_USD = 0.001;
export const PARALLEL_SEARCH_RESULT_USD = 0.001;
export const PARALLEL_SEARCH_INCLUDED = 10;
export const PARALLEL_EXTRACT_USD = 0.001;

/** One paid request: `name` in the cap's refusal, `tool` and `by` on its records, `usd` its price, `basis` why. */
export type Fee = { name: string; by: string; usd: number; basis: string };

/** In whole millionths of a dollar, so a sum of prices is the price. */
const usd = (dollars: number) => Math.round(dollars * 1e6) / 1e6;

/** A fast search for `n` results: $0.001, and $0.001 for each past the 10 it includes. */
export const parallelSearchFee = (n: number): Fee => {
  const more = Math.max(0, n - PARALLEL_SEARCH_INCLUDED);
  return { name: "Parallel's search", by: "parallel", usd: usd(PARALLEL_SEARCH_USD + PARALLEL_SEARCH_RESULT_USD * more), basis: more ? `Parallel's list price for a fast search of ${n} results` : "Parallel's list price for a fast search" };
};
/** An extract of `urls` URLs (the web tools ask one at a time). */
export const parallelExtractFee = (urls = 1): Fee => ({ name: "Parallel's extract", by: "parallel", usd: usd(PARALLEL_EXTRACT_USD * urls), basis: urls === 1 ? "Parallel's list price for one URL" : `Parallel's list price for ${urls} URLs` });

/** The fee of a request to Parallel's `url` with `body`: its search's, by the results it asks for (10 by default), or its
 *  extract's, by the URLs; undefined for an endpoint the web tools do not ask. */
export function parallelFeeOf(url: string, body: unknown): Fee | undefined {
  const path = URL.parse(url)?.pathname;
  const asked = (body ?? {}) as { advanced_settings?: { max_results?: unknown }; urls?: unknown };
  if (path === "/v1/search") return parallelSearchFee(typeof asked.advanced_settings?.max_results === "number" ? asked.advanced_settings.max_results : PARALLEL_SEARCH_INCLUDED);
  if (path === "/v1/extract") return parallelExtractFee(Array.isArray(asked.urls) ? Math.max(1, asked.urls.length) : 1);
  return undefined;
}

/** A paid request the run's cap refused, whose hold could not be kept, or that has no run's ledger to book it on:
 *  nothing was sent. Its message is the refusal, in the cap's words. */
export class PaidRefused extends Error {
  override readonly name = "PaidRefused";
}

/** Where a paid request is booked: the call it is booked under, and the run's one ledger. */
export type Ledger = {
  call: string;
  /** The run's one ledger (the kernel cap's paid tool calls, the adapter loop's): a paid request is admitted and settled
   *  there, in the run's runner records. With none, a paid request is refused unsent. */
  paid?: PaidBooking;
  /** The run's pause on the runner (the adapter loop's RunLedger.pause): a paid step of the agent's own that `paid`
   *  refused for room is handed to it, so the run pauses at its next request in the cap's words, as main's paidCall
   *  pauses by default. A person's take-over books through no paid step (browser-cost.ts personTime) and never pauses. */
  pause?: (refusal: LedgerRefusal) => Promise<void>;
};
/** A cap refusal as the run's pause reads it: its words, and for room its figures. */
export type LedgerRefusal = Refusal;
/** `error`, a refusal of the run's one ledger, as its pause takes it: the cap's refusal for room (a raise would send
 *  the step) with its figures; undefined for anything else (a refusal for good, a hold that could not be kept). */
const roomOf = (error: unknown): LedgerRefusal | undefined => {
  const given = error as { code?: unknown; message?: unknown; forGood?: unknown; figures?: LedgerRefusal["figures"] } | undefined;
  if (given?.code !== "spend_cap_reached" || given.forGood !== false || !given.figures) return undefined;
  // Its code rides with it: the model request the pause refuses next is the cap's refusal (Refusal.code), never a failure.
  return { refuse: String(given.message), code: SPEND_CAP_REACHED, forGood: false, figures: given.figures };
};
/** A paid step refused for room pauses the run, through `pause` (the call's ledger's, Ledger.pause, by default), before
 *  its refusal is told. */
const pauseOn = async (error: unknown, pause: Ledger["pause"] = ledgers.getStore()?.pause): Promise<void> => {
  const room = roomOf(error);
  if (room && pause) await pause(room);
};
/** The kernel cap's booking of a run's paid calls (RunTools), as a paid request uses it. */
export type PaidBooking = {
  /** `chargedBy`: who charges for it (the charge's `charged_by` on main's records: parallel, monid, an MCP server, a
   *  browser vendor), named on its runner.request. */
  admit(request: { id: string; name: string; holdUsd: number; basis: string; call?: string; chargedBy?: string; tool?: string; tag?: string; owed?: true; hold?: true; ref?: string }): Promise<unknown>;
  /** `givenBack`: the hold let go unused, nothing sent (RunTools.settle). */
  settle(id: string, usd: number | null, options?: { readonly givenBack?: true }): Promise<unknown>;
};
const ledgers = new AsyncLocalStorage<Ledger>();

/** What a paid call whose hold the run's ledger could not keep tells the model: `name` was not sent, and why. */
const holdRefusal = (name: string, error: unknown): string => `${name} was not sent: its mark could not be written (${String((error as Error)?.message ?? error).slice(0, 200)})`;

/** What a paid call with no run's ledger to book it on tells the model: `name` was not sent (as mcp-gateway.ts says it). */
export const unbookedRefusal = (name: string): string => `${name} was not sent: this call has no run to book its price under.`;

/** The ledger of tool call `call`: the run's one ledger it runs in (the adapter loop's bookedIn, which carries the run's
 *  paid tool calls and its pause), under the call's own id, so a paid request is admitted on the run's cap before it is
 *  sent and settled there; none outside one. */
export const ledgerOf = (call: string): Ledger => {
  const outer = ledgers.getStore();
  return { call, ...(outer?.paid ? { paid: outer.paid } : {}), ...(outer?.pause ? { pause: outer.pause } : {}) };
};

/** `tool` with each call's paid requests booked under it: its execute runs with the call's ledger set. */
export function booking<T extends ToolRegistration>(tool: T): T {
  return { ...tool, execute: (args: never, api: ToolExecutionApi, context: Context) => ledgers.run(ledgerOf(api.callId), () => tool.execute(args, api as never, context)) } as T;
}

/** `work` with its paid requests booked in `ledger` (a host tool call's, a workflow call node's); with none, outside any
 *  call's ledger, where a paid request is refused. */
export const bookedIn = <T>(ledger: Ledger | undefined, work: () => Promise<T>): Promise<T> => (ledger ? ledgers.run(ledger, work) : work());

/** Whether Parallel may have billed a request it answered `status`: a 2xx, a 408 or a 5xx; never another 4xx. */
const billed = (status: number) => (status >= 200 && status < 300) || status === 408 || status >= 500;

/** `send`, one request to a paid provider at `fee`, on the run's one ledger under the call it runs in (Ledger.paid):
 *  admitted at the fee's price, then sent, then settled at what it may have charged (its price on a 2xx, a 408 or a 5xx
 *  or when it threw after it was sent; $0 on another 4xx); a settle that cannot be written leaves it at its hold, never
 *  less. It throws PaidRefused, in the cap's words, when the cap does not hold its price, when its hold could not be kept,
 *  or when the call has no run's ledger, and then nothing is sent. A request that throws throws, settled at its price. */
export async function paidRequest(fee: Fee, send: () => Promise<Response>): Promise<Response> {
  const ledger = ledgers.getStore();
  if (!ledger?.paid) throw new PaidRefused(unbookedRefusal(fee.name));
  const stepped = await paidStep(ledger.paid, ledger.call, { name: fee.name, holdUsd: fee.usd, basis: fee.basis, by: fee.by }, send, (outcome) => ("thrown" in outcome || billed(outcome.result.status) ? fee.usd : 0));
  if ("refused" in stepped) throw new PaidRefused(stepped.refused);
  return stepped.result;
}

/** Each paid request of this process on the run's one ledger, numbered within its call (one call may make several). */
let paidSeq = 0;

/** The run's one ledger the current call books on (Ledger.paid), when it has one: the runner's. */
export const paidLedger = (): PaidBooking | undefined => ledgers.getStore()?.paid;

/** One paid step on the run's one ledger `paid`, under call `call`: admitted at `holdUsd` (refused unsent: the cap's words,
 *  or why its hold could not be kept), then `run`, then settled at `chargeOf` its outcome (null: at its hold). One refused
 *  for room pauses the run through `pause`, else through the ledger of the call it runs in (bookedIn's), as main's
 *  paidCall pauses: a step outside any host tool call (a pi-native tool's, the browser's) passes the run's own. */
export async function paidStep<T>(paid: PaidBooking, call: string | undefined, fee: { name: string; holdUsd: number; basis: string; by: string; tool?: string; tag?: string; owed?: true; hold?: true; ref?: string }, run: () => Promise<T>, chargeOf: (outcome: { result: T } | { thrown: unknown }) => number | null, pause?: Ledger["pause"]): Promise<{ refused: string } | { result: T }> {
  const id = `${call ?? fee.ref ?? fee.name}#${(paidSeq += 1)}`;
  let admitted: unknown;
  try {
    admitted = await paid.admit({ id, name: fee.name, holdUsd: fee.holdUsd, basis: fee.basis, ...(call === undefined ? {} : { call }), chargedBy: fee.by, ...(fee.tool ? { tool: fee.tool } : {}), ...(fee.tag ? { tag: fee.tag } : {}), ...(fee.owed ? { owed: true as const } : {}), ...(fee.hold ? { hold: true as const } : {}), ...(fee.ref === undefined ? {} : { ref: fee.ref }) });
  } catch (error) {
    await pauseOn(error, pause);
    return { refused: (error as { code?: unknown })?.code === "spend_cap_reached" ? String((error as Error).message) : holdRefusal(fee.name, error) };
  }
  // Its ref booked already (by this claim or an earlier one): no step was opened, so nothing is settled.
  if ((admitted as { booked?: unknown } | undefined)?.booked === true) return { result: await run() };
  let outcome: { result: T } | { thrown: unknown };
  try {
    outcome = { result: await run() };
  } catch (thrown) {
    outcome = { thrown };
  }
  // A hold-only step (`hold`) is given back, never a charge: its money is booked by its own charges' steps.
  await (fee.hold ? paid.settle(id, 0, { givenBack: true }) : paid.settle(id, chargeOf(outcome))).catch(() => undefined);
  if ("thrown" in outcome) throw outcome.thrown;
  return outcome;
}
