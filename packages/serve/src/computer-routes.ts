// A run's desktop or phone, as its owner takes it: POST /v2/runs/{id}/computer/take-over and POST .../computer/hand-back
// (the hand-back for every kind: a browser's answers its agent's ask, as POST .../browser/hand-back does). Owner-only, as
// a run's browser is: the owner's password session in the console, never a token. GET /v2/runs/{id}/computer and the live
// viewer are tl-browser's; computerViewOf is the store-backed read of the run's computer it can build on.
//
// Everything is read from the one store (computer-commands.ts): the run's computer is up, and who drives it, as the run's
// runner committed them to the run's journal; a take-over or hand-back is a command row the runner applies to the run's
// hold (workspace/computer-hold.ts). Nothing is kept in this process, so any server answers the same, and a take-over
// outlives the server that took it.
import {
  type ComputerHoldAnswer, type ComputerCallOptions, type ComputerCallStore, computerAsk, computerHoldOf, entriesOf, handBackComputer, holdIn,
  holdShown, type JournalEntry, runOver, runViewedKind, takeOverComputer, type ViewedKind,
} from "./computer-commands.js";
import { ApiError, invalid } from "./errors.js";
import { unknownFields } from "./validate.js";
import { HOLD_IDLE_MS, type HoldState } from "./workspace/computer-hold.js";

export type { ViewedKind } from "./computer-commands.js";
export { computerAsk, computerHoldOf, handBackComputer, runViewedKind, takeOverComputer };

/** The run's desktop or phone, as the store has it: for tl-browser's GET /v2/runs/{id}/computer to build on. */
export type ComputerViewRead = {
  readonly kind: ViewedKind | null;
  /** live: up; none: the run has a desktop or phone that is not up now; off: it has none. */
  readonly state: "live" | "none" | "off";
  /** Who drives: the agent; pending (the owner's take waits for the agent's call in flight); the person. */
  readonly hold: HoldState;
  /** Why there is nothing to watch, in the server's words: for state off and none. */
  readonly why?: string;
};

/** Our routes' names in serve's route table: each takes the owner's password session, never a token. */
export const COMPUTER_ROUTES: ReadonlySet<string> = new Set(["takeOverRunComputer", "handBackRunComputer"]);

/** How long a take-over lasts with no input from the owner, in minutes, for the API's words. */
export const TAKE_OVER_MINUTES = HOLD_IDLE_MS / 60_000;

/** Run `runId`'s desktop or phone, from the store: its kind, whether it is up, and who drives it. */
export async function computerViewOf(store: ComputerCallStore, runId: string, options: ComputerCallOptions = {}): Promise<ComputerViewRead> {
  const kind = await runViewedKind(store, runId);
  if (kind === undefined) return { kind: null, state: "off", hold: "agent", why: "this run has no desktop or phone computer (a browser is watched at /v2/runs/{run_id}/browser)" };
  const hold = holdIn(await entriesOf(store, runId, options));
  if (!hold.up || (await runOver(store, runId))) return { kind, state: "none", hold: "agent", why: `this run's ${kind} is not up now` };
  return { kind, state: "live", hold: holdShown(hold, await store.commands(runId, 0)).state };
}

/** Whether the run's computer is taken over now, for the run read's computer field (run-computer.ts ComputerStateOf):
 *  from the run's journal and its rows. */
export const takenOverIn = (entries: readonly JournalEntry[], commands: Parameters<typeof holdShown>[1]): boolean => holdShown(holdIn(entries), commands).state === "person";

/** How a request to one of the routes came: by the owner's signed-in page, or with a token; whether this server has
 *  accounts (for the refusal's words); its body. */
export type ComputerRequest = { readonly ownerSession: boolean; readonly token: boolean; readonly accounts: boolean; readonly body?: unknown };

/**
 * One of our routes (COMPUTER_ROUTES, by its name in serve's route table) for run `runId`: { hold, outcome? }, or an
 * ApiError. A token is refused (forbidden): a take-over drives the computer, so it takes the owner's signed-in page, as a
 * run's browser does. The take-over takes an empty body; the hand-back an `outcome` (done or cancelled) at most. Serve's
 * dispatch sends what this answers.
 */
export async function computerRoute(name: string, runId: string, request: ComputerRequest, store: ComputerCallStore, options: ComputerCallOptions = {}): Promise<ComputerHoldAnswer> {
  if (!request.ownerSession && request.token) {
    throw new ApiError("forbidden", request.accounts ? "A run's computer takes the owner's password sign-in in the console, never a token." : "A run's computer takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
  }
  const body = request.body ?? {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("input_invalid", "the body is a JSON object");
  const given = body as Record<string, unknown>;
  const issues = unknownFields(given, name === "handBackRunComputer" ? ["outcome"] : []);
  if (name === "handBackRunComputer" && given.outcome !== undefined && given.outcome !== "done" && given.outcome !== "cancelled") issues.push({ field: "outcome", reason: "not_an_option", message: "outcome is done or cancelled" });
  if (issues.length) throw invalid(issues);
  if (name === "takeOverRunComputer") return takeOverComputer(store, runId, options);
  if (name === "handBackRunComputer") return handBackComputer(store, runId, given.outcome === "done" || given.outcome === "cancelled" ? { outcome: given.outcome } : {}, options);
  throw new ApiError("not_found", `no computer route ${name}`);
}
