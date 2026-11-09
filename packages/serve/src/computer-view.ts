// A run's desktop or phone, as its owner watches and takes it: GET /v2/runs/{id}/computer, POST .../computer/take-over and
// POST .../computer/hand-back. Owner-only, as a run's browser is (its viewer drives the computer once taken over): the
// owner's password session in the console, never a token.
//
// Everything here is read from the one store (computer-commands.ts): the run's computer is up, and who drives it, as the
// run's runner committed them to the run's journal; a take-over or hand-back is a command row the runner applies to the
// run's hold (workspace/computer-hold.ts). Nothing is kept in this process, so any server answers the same, and a take-over
// outlives the server that took it. The viewer is the run's own proxied view (tl-browser's computer viewer); until the
// runner registers one, `viewer` is null. A run whose computer is a browser, a sandbox or none has no computer here.
import {
  type ComputerCommandStore, computerAsk, handBackCommand, holdIn, holdShown, type JournalEntry, takeOverCommand, type ViewedKind,
} from "./computer-commands.js";
import { settingOfDefinition } from "./computer-setting.js";
import { ApiError, invalid } from "./errors.js";
import { FINAL_STATES, type Store } from "./store/index.js";
import { unknownFields } from "./validate.js";
import { type AskOutcome, HOLD_IDLE_MS, type HoldState } from "./workspace/computer-hold.js";

export type { ViewedKind } from "./computer-commands.js";

/** What GET /v2/runs/{id}/computer answers (and the take-over and hand-back, after their write). */
export type ComputerView = {
  readonly kind: ViewedKind | null;
  /** live: up, and watchable (or taken); none: the run has a desktop or phone that is not up now; off: it has none. */
  readonly state: "live" | "none" | "off";
  /** Who drives: the agent; pending (the owner's take waits for the agent's call in flight); the person. */
  readonly hold: HoldState;
  /** Whether the owner drives it now. */
  readonly taken_over: boolean;
  readonly viewer: { readonly url: string } | null;
  /** Why there is nothing to watch, in the server's words: for state off and none. */
  readonly why?: string;
  /** A hand-back that answered the agent's ask: the answer the agent gets (the first one). */
  readonly outcome?: AskOutcome;
};

/** The routes' names in serve's route table: each takes the owner's password session, never a token. */
export const COMPUTER_ROUTES: ReadonlySet<string> = new Set(["getRunComputer", "takeOverRunComputer", "handBackRunComputer"]);

/** How long a take-over lasts with no input from the owner, in minutes, for the API's words. */
export const TAKE_OVER_MINUTES = HOLD_IDLE_MS / 60_000;

/** What the routes read and write: the store's command rows and the run's row, the run's journal (`entries`, re-read on
 *  each call), and the run's computer's kind as its setting says (undefined for none, a sandbox or a browser). */
export type ComputerRouteDeps = {
  readonly store: ComputerCommandStore & Pick<Store, "runs">;
  readonly entries: () => Promise<readonly JournalEntry[]>;
  readonly kind: ViewedKind | undefined;
  readonly now?: () => number;
};

/** Whether the run is over: no computer of an ended run is up. */
async function runOver(deps: ComputerRouteDeps, runId: string): Promise<boolean> {
  const row = await deps.store.runs.get(runId);
  return !row || FINAL_STATES.includes(row.state);
}

/** The run's computer as its owner sees it, from the store. */
async function viewOf(deps: ComputerRouteDeps, runId: string, read?: { entries: readonly JournalEntry[] }): Promise<ComputerView> {
  const kind = deps.kind;
  if (kind === undefined) return { kind: null, state: "off", hold: "agent", taken_over: false, viewer: null, why: "this run has no desktop or phone computer (a browser is watched at /v2/runs/{run_id}/browser)" };
  const entries = read?.entries ?? (await deps.entries());
  const hold = holdIn(entries);
  if (!hold.up || (await runOver(deps, runId))) return { kind, state: "none", hold: "agent", taken_over: false, viewer: null, why: `this run's ${kind} is not up now` };
  const shown = holdShown(hold, await deps.store.commands(runId, 0));
  return { kind, state: "live", hold: shown.state, taken_over: shown.state === "person", viewer: null };
}

/** Whether the run's computer is taken over now, for the run read's computer field (run-computer.ts ComputerStateOf):
 *  from the run's journal and its rows. */
export const takenOverIn = (entries: readonly JournalEntry[], commands: Parameters<typeof holdShown>[1]): boolean => holdShown(holdIn(entries), commands).state === "person";

/** The agent's open ask on the run's computer, for the run read's pending: re-exported for the run view. */
export { computerAsk };

/** The kind of computer run `runId`'s revision asks for, when it is one a person watches (a desktop or a phone). */
export async function runViewedKind(store: Pick<Store, "runs" | "agents">, runId: string): Promise<ViewedKind | undefined> {
  const run = await store.runs.get(runId);
  const revision = run ? await store.agents.revision(run.revisionId) : undefined;
  const body = revision?.body;
  const setting = body && typeof body === "object" ? settingOfDefinition(body as { computer?: unknown; place?: unknown }) : undefined;
  const kind = setting?.computer.kind;
  return kind === "desktop" || kind === "phone" ? kind : undefined;
}

/** GET /v2/runs/{id}/computer. */
export const readComputer = (deps: ComputerRouteDeps, runId: string): Promise<ComputerView> => viewOf(deps, runId);

/** POST .../computer/take-over: a take-over row the runner applies; the owner's take is pending until the agent's call in
 *  flight ends, then theirs. Taking one already pending or taken is the same answer, and writes nothing. */
export async function takeOver(deps: ComputerRouteDeps, runId: string): Promise<ComputerView> {
  const kind = deps.kind;
  if (kind === undefined) throw new ApiError("not_found", "this run has no desktop or phone to take over (a browser is taken over from GET /v2/runs/{id}/browser)");
  const entries = await deps.entries();
  const hold = holdIn(entries);
  if (!hold.up || (await runOver(deps, runId))) throw new ApiError("computer_not_live", `this run's ${kind} is not up now, so there is nothing to take over`);
  await takeOverCommand(deps.store, runId, kind, hold, await deps.store.commands(runId, 0), deps.now?.() ?? Date.now());
  return viewOf(deps, runId);
}

/** POST .../computer/hand-back: with the agent's ask open, the owner's answer to it (`outcome`, done when not given);
 *  else the end of the owner's take. The first hand-back wins; a second, or one after the take went back another way, is
 *  409 handoff_answered in words. 404 when the agent asked nothing and nobody took the computer. */
export async function handBack(deps: ComputerRouteDeps, runId: string, outcome?: "done" | "cancelled"): Promise<ComputerView> {
  const kind = deps.kind;
  if (kind === undefined) throw new ApiError("not_found", "this run has no desktop or phone to hand back");
  const entries = await deps.entries();
  const answered = await handBackCommand(deps.store, runId, kind, { entries, commands: await deps.store.commands(runId, 0) }, outcome, deps.entries, deps.now?.() ?? Date.now());
  return { ...(await viewOf(deps, runId)), ...(answered.outcome ? { outcome: answered.outcome } : {}) };
}

/** How a request to one of the routes came: by the owner's signed-in page, or with a token; whether this server has
 *  accounts (for the refusal's words); its body, for a POST. */
export type ComputerRequest = { readonly ownerSession: boolean; readonly token: boolean; readonly accounts: boolean; readonly body?: unknown };

/**
 * One of the routes (COMPUTER_ROUTES, by its name in serve's route table) for run `runId`: the answer, or an ApiError.
 * A token is refused (forbidden): the view drives the computer once taken over, so it takes the owner's signed-in page,
 * as a run's browser does. The take-over takes an empty body; the hand-back an `outcome` (done or cancelled) at most.
 * Serve's dispatch sends what this answers.
 */
export async function computerRoute(name: string, runId: string, request: ComputerRequest, deps: ComputerRouteDeps): Promise<ComputerView> {
  if (!request.ownerSession && request.token) {
    throw new ApiError("forbidden", request.accounts ? "A run's computer view takes the owner's password sign-in in the console, never a token." : "A run's computer view takes the owner's password sign-in, and this server has no accounts (AGENTRUN_ACCOUNTS=0).");
  }
  let outcome: "done" | "cancelled" | undefined;
  if (name !== "getRunComputer") {
    const body = request.body ?? {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("input_invalid", "the body is a JSON object");
    const given = body as Record<string, unknown>;
    const issues = unknownFields(given, name === "handBackRunComputer" ? ["outcome"] : []);
    if (name === "handBackRunComputer" && given.outcome !== undefined && given.outcome !== "done" && given.outcome !== "cancelled") issues.push({ field: "outcome", reason: "not_an_option", message: "outcome is done or cancelled" });
    if (issues.length) throw invalid(issues);
    if (given.outcome === "done" || given.outcome === "cancelled") outcome = given.outcome;
  }
  if (name === "getRunComputer") return readComputer(deps, runId);
  if (name === "takeOverRunComputer") return takeOver(deps, runId);
  if (name === "handBackRunComputer") return handBack(deps, runId, outcome);
  throw new ApiError("not_found", `no computer route ${name}`);
}
