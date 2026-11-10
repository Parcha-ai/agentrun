// A web tool's request to Parallel (its search, web-search.ts; its extract, web-fetch.ts), booked as monid.run's call
// is (monid.ts): under the run's cap by cap.ts' rule for a paid call (what the run has spent and holds, plus the
// request's price, within the cap; never on an unknown spend), else refused unsent in the cap's words; marked in the
// run's store before it is sent (TOOL_STARTED, held at its price) and settled after (TOOL_COST, what it charged). A
// charge is the run's cost, a line of its own on its timeline and /usage's `tools` meter. Every request goes through
// the run's one Parallel client's `post` (web-fetch.ts), which books it here by the endpoint it asks.
// Parallel's answers report what they used as SKU counts, never an amount, so each request is booked at Parallel's
// published price, an estimate: its price on a 2xx; nothing on a 4xx other than a 408 (Parallel refused it before any
// work); and its price on a 408, a 5xx or a request that failed or was stopped after it was sent, which Parallel may
// have billed, as the decision provider books Parallel's (@parcha/agentrun-decisions).
// A request with no call to book it under, or to an endpoint with no price here, is never sent: it fails closed.
// The call a request is booked under (its id, and how a record is written to the run's store) is set around the call:
// around a tool's execute by `booking`, where the web tools are bound (tools.ts, host-tools.ts), and around a workflow
// call node's effect by `bookedIn`, with the ledger the workflow's runner gives it (app.ts). The client deep inside a
// tool books without the call passed down to it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord";
import type { Refusal } from "@parcha/agentrun-kernel";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { TOOL_COST, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
import { BARRIER, JOURNAL_SYNCHRONOUS, syncNow, type SyncTarget } from "@parcha/pi-durable-disk";
import { paidCall } from "./cap.js";

/** Parallel's published prices (https://docs.parallel.ai/getting-started/pricing, read 2026-11-03): a `fast` search
 *  $1 per 1,000 requests for up to 10 results, each further result $1 per 1,000; an extract $1 per 1,000 URLs. */
export const PARALLEL_SEARCH_USD = 0.001;
export const PARALLEL_SEARCH_RESULT_USD = 0.001;
export const PARALLEL_SEARCH_INCLUDED = 10;
export const PARALLEL_EXTRACT_USD = 0.001;

/** One paid request: `name` in the cap's refusal, `tool` and `by` on its records, `usd` its price, `basis` why. */
export type Fee = { name: string; tool: string; by: string; usd: number; basis: string };

/** In whole millionths of a dollar, so a sum of prices is the price. */
const usd = (dollars: number) => Math.round(dollars * 1e6) / 1e6;

/** A fast search for `n` results: $0.001, and $0.001 for each past the 10 it includes. */
export const parallelSearchFee = (n: number): Fee => {
  const more = Math.max(0, n - PARALLEL_SEARCH_INCLUDED);
  return { name: "Parallel's search", tool: "web_search", by: "parallel", usd: usd(PARALLEL_SEARCH_USD + PARALLEL_SEARCH_RESULT_USD * more), basis: more ? `Parallel's list price for a fast search of ${n} results` : "Parallel's list price for a fast search" };
};
/** An extract of `urls` URLs (the web tools ask one at a time). */
export const parallelExtractFee = (urls = 1): Fee => ({ name: "Parallel's extract", tool: "web_fetch", by: "parallel", usd: usd(PARALLEL_EXTRACT_USD * urls), basis: urls === 1 ? "Parallel's list price for one URL" : `Parallel's list price for ${urls} URLs` });

/** The fee of a request to Parallel's `url` with `body`: its search's, by the results it asks for (10 by default), or its
 *  extract's, by the URLs; undefined for an endpoint the web tools do not ask. */
export function parallelFeeOf(url: string, body: unknown): Fee | undefined {
  const path = URL.parse(url)?.pathname;
  const asked = (body ?? {}) as { advanced_settings?: { max_results?: unknown }; urls?: unknown };
  if (path === "/v1/search") return parallelSearchFee(typeof asked.advanced_settings?.max_results === "number" ? asked.advanced_settings.max_results : PARALLEL_SEARCH_INCLUDED);
  if (path === "/v1/extract") return parallelExtractFee(Array.isArray(asked.urls) ? Math.max(1, asked.urls.length) : 1);
  return undefined;
}

/** A paid request the run's cap refused, or whose mark could not be written: nothing was sent. Its message is the
 *  refusal, in the cap's words. */
export class PaidRefused extends Error {
  override readonly name = "PaidRefused";
}

/** Where a paid request is booked: the call it is booked under, and one record written to the run's root, where its
 *  spend is read on every harness (cap.ts, harness-app.ts). */
export type Ledger = {
  call: string;
  record(kind: string, data: Record<string, string | number | null>): Promise<void>;
  /** The run's one ledger on the runner (the kernel cap's paidCalls, the adapter loop's): a paid request is admitted and
   *  settled there, in the run's runner records, in place of this process's run spend (cap.ts paidCall) and the root's
   *  TOOL_STARTED/TOOL_COST marks. */
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
  return { refuse: String(given.message), forGood: false, figures: given.figures };
};
/** A paid step refused for room pauses the run, through the call's ledger (Ledger.pause), before its refusal is told. */
const pauseOn = async (error: unknown): Promise<void> => {
  const room = roomOf(error);
  const pause = ledgers.getStore()?.pause;
  if (room && pause) await pause(room);
};
/** The kernel cap's booking of a run's paid calls (RunTools), as a paid request uses it. */
export type PaidBooking = {
  /** `chargedBy`: who charges for it (the charge's `charged_by` on main's records: parallel, monid, an MCP server, a
   *  browser vendor), named on its runner.request. */
  admit(request: { id: string; name: string; holdUsd: number; basis: string; call?: string; chargedBy?: string }): Promise<unknown>;
  /** `givenBack`: the hold let go unused, nothing sent (RunTools.settle). */
  settle(id: string, usd: number | null, options?: { readonly givenBack?: true }): Promise<unknown>;
};
const ledgers = new AsyncLocalStorage<Ledger>();

/** The run process's own commit to its run's root, outside any one call's turn (app.ts sets it once the run's harness is
 *  open). A request's settle (TOOL_COST) is written there: once a turn is stopped, its tool call can no longer commit
 *  (pi-durable refuses a task with a durable abort mark), though the request was sent and its charge stands. */
let rootRecord: Ledger["record"] | undefined;
/** The run's store, for the barrier after each hold (writeHold): set with the root's commit, once the run is open. */
let holdStore: SyncTarget | undefined;
/** The run journal's level: the store's own once one is open, this before (FULL syncs every commit, NORMAL only at a
 *  barrier). */
let journalLevel: "FULL" | "NORMAL" = JOURNAL_SYNCHRONOUS;
export const settleIn = (record: Ledger["record"] | undefined, store: SyncTarget | undefined, journal: "FULL" | "NORMAL" = JOURNAL_SYNCHRONOUS): void => {
  rootRecord = record;
  holdStore = store;
  // Only a test passes `journal`, to run the barriers at NORMAL before the run journal is NORMAL (pi-durable-disk 2b).
  journalLevel = journal;
};
/** Whether a barrier on the run journal has nothing to sync: no store open, while the journal syncs only at barriers. A
 *  hold or a start mark written then would sit in the store with nothing to make it durable, so none is written. */
export const noStoreToSync = (store: SyncTarget | undefined): boolean => store === undefined && journalLevel !== "FULL";

/** A hold that could not be made durable (writeHold): nothing was sent. Its message says why, after "was not sent: ". */
export class HoldNotDurable extends Error {
  override readonly name = "HoldNotDurable";
}

/** The run's journal a hold is synced in (settleIn), for another barrier before a paid effect: browser-cost.ts'. */
export const runJournal = (): SyncTarget | undefined => holdStore;

/** A paid call's hold (TOOL_STARTED, at what the cap holds it at), written by `write` (the call's own commit), then the
 *  run journal's barrier (pi-durable-disk barriers.ts, paidToolHold): the hold is on disk before the call is sent, so a
 *  box loss never leaves a sent call the cap does not count. Every paid call writes its hold here: a paid request
 *  (paidRequest), monid.run (monid.ts) and a priced MCP call (mcp-gateway.ts), so a new paid tool gets the sync with it.
 *  Whatever throws, the caller sends nothing (holdRefusal says why): with no store to sync it writes no hold
 *  (HoldNotDurable); a write that fails throws its own error; a sync that fails after the write settles the hold at $0
 *  under its call (best effort), so no cap counts a call that never left, and throws HoldNotDurable. */
export async function writeHold(write: (kind: string, data: Record<string, string | number | null>) => Promise<void>, data: Record<string, string | number | null>): Promise<void> {
  if (noStoreToSync(holdStore)) throw new HoldNotDurable("the run's store is not open, so its hold cannot be made durable");
  await write(TOOL_STARTED, data);
  try {
    await syncNow(holdStore, BARRIER.paidToolHold);
  } catch (error) {
    const { heldUsd: _held, ...label } = data;
    await write(TOOL_COST, { ...label, usd: 0 }).catch(() => undefined);
    throw new HoldNotDurable(`its hold could not be made durable (${String((error as Error)?.message ?? error).slice(0, 200)})`);
  }
}
/** What a paid call that writeHold refused tells the model: `name` was not sent, and why. */
export const holdRefusal = (name: string, error: unknown): string =>
  error instanceof HoldNotDurable ? `${name} was not sent: ${error.message}` : `${name} was not sent: its mark could not be written (${String((error as Error)?.message ?? error).slice(0, 200)})`;
/** A settle of `kind` written to the run's root (settleIn), when that is set; else undefined, for the caller's own commit.
 *  monid.run's settle goes here too. */
export const settleOnRoot = (kind: string, data: Record<string, string | number | null>): Promise<void> | undefined => rootRecord?.(kind, data);

/** The ledger of a tool call: its id, and its commits to the run's store. Its mark (TOOL_STARTED) is the call's own
 *  commit, so a stopped turn sends nothing new; its settle goes to the run's root when that is set (settleIn). On the
 *  runner the call runs inside the run's one ledger (the adapter loop's bookedIn, which carries the run's paid tool calls
 *  and its pause): its `paid` and `pause` are kept, so a paid request is admitted on the run's cap before it is sent and
 *  settled there, never booked beside it where the cap does not judge it. */
export const ledgerOf = (api: ToolExecutionApi, context: Context): Ledger => {
  const outer = ledgers.getStore();
  return {
    call: api.callId,
    record: (kind, data) => ((kind === TOOL_COST ? settleOnRoot(kind, data) : undefined) ?? api.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data })), context)),
    ...(outer?.paid ? { paid: outer.paid } : {}),
    ...(outer?.pause ? { pause: outer.pause } : {}),
  };
};

/** `tool` with each call's paid requests booked under it: its execute runs with the call's ledger set. */
export function booking<T extends ToolRegistration>(tool: T): T {
  return { ...tool, execute: (args: never, api: ToolExecutionApi, context: Context) => ledgers.run(ledgerOf(api, context), () => tool.execute(args, api as never, context)) } as T;
}

/** `work` with its paid requests booked in `ledger` (a workflow call node's); with none, booked nowhere. */
export const bookedIn = <T>(ledger: Ledger | undefined, work: () => Promise<T>): Promise<T> => (ledger ? ledgers.run(ledger, work) : work());

/** Whether Parallel may have billed a request it answered `status`: a 2xx, a 408 or a 5xx; never another 4xx. */
const billed = (status: number) => (status >= 200 && status < 300) || status === 408 || status >= 500;

type Sent = { response: Response } | { thrown: unknown } | { unmarked: string };

/** `send`, one request to a paid provider at `fee`, under the run's cap and booked under the call it runs in: its
 *  response; it throws PaidRefused, in the cap's words, when the cap does not hold its price (or the run's spend is
 *  unknown), when no call is set to book it under, or when its mark could not be written, and then nothing is sent. A request that throws throws, settled at its
 *  price. */
export async function paidRequest(fee: Fee, send: () => Promise<Response>): Promise<Response> {
  const ledger = ledgers.getStore();
  if (!ledger) throw new PaidRefused(`${fee.name} was not sent: this request has no call to book it under`);
  const label = { tool: fee.tool, charged_by: fee.by, call: ledger.call };
  const chargeOf = (sent: Sent) => ("unmarked" in sent ? undefined : "thrown" in sent || billed(sent.response.status) ? fee.usd : 0);
  if (ledger.paid) return paidOn(ledger.paid, ledger.call, fee, send, chargeOf);
  const sent = async (): Promise<Sent> => {
    try {
      await writeHold(ledger.record, { ...label, heldUsd: fee.usd });
    } catch (error) {
      return { unmarked: holdRefusal(fee.name, error) };
    }
    let outcome: Sent;
    try {
      outcome = { response: await send() };
    } catch (thrown) {
      outcome = { thrown };
    }
    // Settled at what it may have charged, even when this cannot be written: the request was sent.
    await ledger.record(TOOL_COST, { ...label, usd: chargeOf(outcome) ?? null }).catch(() => undefined);
    return outcome;
  };
  const paid = await paidCall(fee.name, sent, chargeOf, { usd: fee.usd, basis: fee.basis });
  if ("refused" in paid) throw new PaidRefused(paid.refused);
  const outcome = paid.result;
  if ("unmarked" in outcome) throw new PaidRefused(outcome.unmarked);
  if ("thrown" in outcome) throw outcome.thrown;
  return outcome.response;
}

/** Each paid request of this process on the run's one ledger, numbered within its call (one call may make several). */
let paidSeq = 0;

/** The run's one ledger the current call books on (Ledger.paid), when it has one: the runner's. */
export const paidLedger = (): PaidBooking | undefined => ledgers.getStore()?.paid;

/** One paid step on the run's one ledger `paid`, under call `call`: admitted at `holdUsd` (refused unsent: the cap's words,
 *  or why its hold could not be kept), then `run`, then settled at `chargeOf` its outcome (null: at its hold). */
export async function paidStep<T>(paid: PaidBooking, call: string, fee: { name: string; holdUsd: number; basis: string; by: string }, run: () => Promise<T>, chargeOf: (outcome: { result: T } | { thrown: unknown }) => number | null): Promise<{ refused: string } | { result: T }> {
  const id = `${call}#${(paidSeq += 1)}`;
  try {
    await paid.admit({ id, name: fee.name, holdUsd: fee.holdUsd, basis: fee.basis, call, chargedBy: fee.by });
  } catch (error) {
    await pauseOn(error);
    return { refused: (error as { code?: unknown })?.code === "spend_cap_reached" ? String((error as Error).message) : holdRefusal(fee.name, error) };
  }
  let outcome: { result: T } | { thrown: unknown };
  try {
    outcome = { result: await run() };
  } catch (thrown) {
    outcome = { thrown };
  }
  await paid.settle(id, chargeOf(outcome)).catch(() => undefined);
  if ("thrown" in outcome) throw outcome.thrown;
  return outcome;
}

/** `send` on the run's one ledger (Ledger.paid): admitted at the fee's price (refused unsent in the cap's words), then
 *  sent, then settled at what it may have charged (chargeOf: its price on a 2xx, a 408 or a 5xx or when it threw after
 *  it was sent; $0 on another 4xx). A settle that cannot be written leaves the request at its hold, never less. */
async function paidOn(paid: PaidBooking, call: string, fee: Fee, send: () => Promise<Response>, chargeOf: (sent: Sent) => number | undefined): Promise<Response> {
  const id = `${call}#${(paidSeq += 1)}`;
  try {
    await paid.admit({ id, name: fee.name, holdUsd: fee.usd, basis: fee.basis, call, chargedBy: fee.by });
  } catch (error) {
    await pauseOn(error);
    const said = String((error as Error)?.message ?? error);
    throw new PaidRefused((error as { code?: unknown })?.code === "spend_cap_reached" ? said : holdRefusal(fee.name, error));
  }
  let outcome: Sent;
  try {
    outcome = { response: await send() };
  } catch (thrown) {
    outcome = { thrown };
  }
  await paid.settle(id, chargeOf(outcome) ?? null).catch(() => undefined);
  if ("thrown" in outcome) throw outcome.thrown;
  return (outcome as { response: Response }).response;
}
