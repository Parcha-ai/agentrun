// A run's desktop or phone over the one store, as the browser's hand-over is (browser-commands.ts): the person's take-over
// and hand-back are command rows the run's runner reads and applies to the run's hold (workspace/computer-hold.ts); the
// hold's changes, and the agent's asks and their answers, are entries the runner commits to the run's journal
// (runner/computer-journal.ts). The server reads both, never anything in its own memory: a take-over outlives the server
// that took it, and every server reads the same hold.
//
// The journal contract (the runner writes it; this module reads it):
//   computer.hold, `{ up: true | false, computer, at }`: the run's computer came up (each claim's), or was let go;
//   computer.hold, `{ state, take, computer, at, by?, ended? }`: who drives now ("agent" | "pending" | "person"), the take
//     it belongs to, the row that made the change (`by`), and how a take ended ("given" | "answered" | "idle" | "away" |
//     "released") when it is back with the agent;
//   computer.handover, `{ state: "waiting", id, computer, instruction, completion_condition, asked_at, expires_at, reason }`:
//     the agent's ask; and `{ state: "done" | "cancelled" | "expired", id, at, by? }`, its answer.
// Each change also commits its Timeline row (a phase row at the change's own time), in the words below.
//
// The rows: computer_take_over `{ at }`; computer_hand_back `{ take, at }` (a take's end) or `{ ask, outcome, at }` (an
// ask's answer). The first hand-back of a take or an ask wins, decided at the write and never from the read before it:
// each writer writes, then re-reads the run's journal (a hand-back the runner already applied, or an end the run's own
// hold wrote: the viewer's hand-back, idle, away, released), then the rows (the lowest-id row is the one the runner
// applies), so each caller is told the truth.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { browserHandBack, handBackTarget } from "./browser-commands.js";
import { settingOfDefinition } from "./computer-setting.js";
import { ApiError } from "./errors.js";
import { FINAL_STATES, RunFinal, type Command, type Store } from "./store/index.js";
import { runEntries } from "./store-reads/journal.js";
import { type AskOutcome, HOLD_IDLE_MS, type HoldAsk, type HoldEnd, type HoldState } from "./workspace/computer-hold.js";

/** The kinds of computer a person watches and takes: a screen. */
export type ViewedKind = "desktop" | "phone";

/** The journal entry kinds the runner commits. */
export const COMPUTER_HOLD_KIND = "computer.hold";
export const COMPUTER_HANDOVER_KIND = "computer.handover";
/** The command row kinds the server writes. */
export const COMPUTER_TAKE_OVER = "computer_take_over";
export const COMPUTER_HAND_BACK = "computer_hand_back";

/** The Timeline's words for a person's turns with the computer, each at its own time. */
export const holdWords = (computer: ViewedKind) => ({
  taken: `You took over the ${computer}`,
  ended: {
    given: `You handed the ${computer} back`,
    idle: `The ${computer} went back to the agent: no input came from you for ${HOLD_IDLE_MS / 60_000} minutes`,
    away: `The ${computer} went back to the agent: the live view was closed`,
    released: `The ${computer}'s session ended while you had it`,
  } as Record<Exclude<HoldEnd, "answered">, string>,
  waiting: (instruction: string) => `Waiting for you: ${instruction}`,
  answered: {
    done: "Done: the owner answered the agent's request.",
    cancelled: "You cancelled the agent's hand-over",
    expired: "The agent's hand-over expired before you answered it",
  } as Record<AskOutcome, string>,
});

/** A hand-back that came after the take was over, in words: how it went back. */
export const takeEndedWords = (computer: ViewedKind, why: HoldEnd): string =>
  why === "given" || why === "answered" ? `The ${computer} was already handed back to the agent.`
    : why === "idle" ? `The ${computer} already went back to the agent: no input came from you for ${HOLD_IDLE_MS / 60_000} minutes.`
      : why === "away" ? `The ${computer} already went back to the agent: the live view was closed.`
        : `The ${computer}'s session ended while you had it.`;

/** An ask already answered: 409, in the browser's route's words. */
const answeredWords = (outcome: AskOutcome): string =>
  outcome === "expired" ? "The agent's hand-over expired before this answer: the agent was told it expired." : `The agent's hand-over was already answered ${outcome}.`;

/** A journal entry as these readers need it. */
export interface JournalEntry {
  readonly kind: string;
  readonly data: unknown;
}

type Data = Record<string, unknown>;
const dataOf = (entry: JournalEntry): Data => (entry.data && typeof entry.data === "object" ? (entry.data as Data) : {});
const STATES: readonly string[] = ["agent", "pending", "person"];
const ENDS: readonly string[] = ["given", "answered", "idle", "away", "released"];
const OUTCOMES: readonly string[] = ["done", "cancelled", "expired"];

/** The hold as the run's journal has it. */
export type HoldRead = {
  /** Whether the run's computer is up (its last up entry). */
  readonly up: boolean;
  readonly state: HoldState;
  /** The take in force, while pending or held. */
  readonly take?: string;
  /** Every take that ended, by name: how, and the row that ended it. */
  readonly ended: ReadonlyMap<string, { readonly why: HoldEnd; readonly by?: number }>;
  /** The last take that ended. */
  readonly last?: string;
};

/** The run's hold, from its journal's computer.hold entries. */
export function holdIn(entries: readonly JournalEntry[]): HoldRead {
  let up = false;
  let state: HoldState = "agent";
  let take: string | undefined;
  let last: string | undefined;
  const ended = new Map<string, { why: HoldEnd; by?: number }>();
  for (const entry of entries) {
    if (entry.kind !== COMPUTER_HOLD_KIND) continue;
    const data = dataOf(entry);
    if (typeof data.up === "boolean") {
      up = data.up;
      // A computer that comes up (a new claim's) starts with the agent driving.
      if (up) [state, take] = ["agent", undefined];
      continue;
    }
    if (!STATES.includes(String(data.state)) || typeof data.take !== "string") continue;
    state = data.state as HoldState;
    if (state === "agent") {
      take = undefined;
      if (ENDS.includes(String(data.ended))) {
        ended.set(data.take, { why: data.ended as HoldEnd, ...(typeof data.by === "number" ? { by: data.by } : {}) });
        last = data.take;
      }
    } else take = data.take;
  }
  return { up, state, ...(take !== undefined ? { take } : {}), ended, ...(last !== undefined ? { last } : {}) };
}

/** A row the runner has not dealt with yet (neither taken nor refused). */
const untaken = (command: Command): boolean => command.takenAt === null && command.refused === null;

/** The take a take-over row not yet applied asks for (the lowest-id one): "c<row id>", the name the run's hold gives it. */
function takePending(commands: readonly Command[]): string | undefined {
  const row = [...commands].filter((command) => command.kind === COMPUTER_TAKE_OVER && untaken(command)).sort((a, b) => a.id - b.id)[0];
  return row ? `c${row.id}` : undefined;
}

/** Who drives, as the server shows it: the journal's hold, or pending while a take-over row waits for the runner. */
export function holdShown(hold: HoldRead, commands: readonly Command[]): { state: HoldState; take?: string } {
  if (hold.state !== "agent") return { state: hold.state, take: hold.take! };
  const pending = hold.up ? takePending(commands) : undefined;
  return pending && !hold.ended.has(pending) ? { state: "pending", take: pending } : { state: "agent" };
}

/** Every ask the run's journal holds, oldest first, and each answer it has (the journal's, or a hand-back row's). */
function asksIn(entries: readonly JournalEntry[], commands: readonly Command[]): { asks: (HoldAsk & { computer?: ViewedKind })[]; answers: Map<string, AskOutcome> } {
  const asks: (HoldAsk & { computer?: ViewedKind })[] = [];
  const answers = new Map<string, AskOutcome>();
  for (const entry of entries) {
    if (entry.kind !== COMPUTER_HANDOVER_KIND) continue;
    const data = dataOf(entry);
    if (typeof data.id !== "string") continue;
    if (data.state === "waiting") {
      const ok = typeof data.instruction === "string" && typeof data.completion_condition === "string" && Number.isFinite(Date.parse(String(data.asked_at))) && Number.isFinite(Date.parse(String(data.expires_at)));
      if (ok && !asks.some((ask) => ask.id === data.id)) asks.push({ id: data.id, instruction: data.instruction as string, completion_condition: data.completion_condition as string, asked_at: data.asked_at as string, expires_at: data.expires_at as string, ...(data.computer === "desktop" || data.computer === "phone" ? { computer: data.computer } : {}) });
    } else if (OUTCOMES.includes(String(data.state)) && !answers.has(data.id)) answers.set(data.id, data.state as AskOutcome);
  }
  // A person's answer the runner has not committed yet: the lowest-id row for an ask is the one it applies.
  for (const command of [...commands].sort((a, b) => a.id - b.id)) {
    const body = (command.body ?? {}) as Data;
    if (command.kind !== COMPUTER_HAND_BACK || typeof body.ask !== "string" || !untaken(command)) continue;
    if ((body.outcome === "done" || body.outcome === "cancelled") && !answers.has(body.ask)) answers.set(body.ask, body.outcome);
  }
  return { asks, answers };
}

/** The agent's ask the run waits on: the newest still open (unanswered and not expired), or undefined. The run read's
 *  `pending` (kind computer) is this. */
export function computerAsk(entries: readonly JournalEntry[], commands: readonly Command[] = [], now = Date.now()): (HoldAsk & { computer?: ViewedKind }) | undefined {
  const { asks, answers } = asksIn(entries, commands);
  return asks.reverse().find((ask) => !answers.has(ask.id) && Date.parse(ask.expires_at) > now);
}

/** The slice of the store the writers write through and read back. */
export type ComputerCommandStore = Pick<Store, "command" | "commands">;

/** A row written for a run, or computer_not_live when the run is over (no hold of an ended run is anyone's). */
async function write(store: ComputerCommandStore, runId: string, kind: string, body: Data, gone: string): Promise<Command> {
  const row = await tryWrite(store, runId, kind, body);
  if (!row) throw new ApiError("computer_not_live", gone);
  return row;
}

/** A row written for a run, or undefined when the run is over. */
async function tryWrite(store: ComputerCommandStore, runId: string, kind: string, body: Data): Promise<Command | undefined> {
  try {
    return await store.command(runId, { kind, body });
  } catch (error) {
    if (error instanceof RunFinal) return undefined;
    throw error;
  }
}

/** POST .../computer/take-over: a take-over row, unless a take is pending or held already (the same answer, nothing
 *  written). Answers the take in force. */
export async function takeOverCommand(store: ComputerCommandStore, runId: string, computer: ViewedKind, hold: HoldRead, commands: readonly Command[], at = Date.now()): Promise<{ state: HoldState; take: string }> {
  const shown = holdShown(hold, commands);
  if (shown.state !== "agent") return { state: shown.state, take: shown.take! };
  const row = await write(store, runId, COMPUTER_TAKE_OVER, { at }, `this run's ${computer} is not up now, so there is nothing to take over`);
  return { state: "pending", take: `c${row.id}` };
}

/** POST .../computer/hand-back. With the agent's ask open, the person's answer to it (`outcome`, done when not given): the
 *  first wins; the same answer again is that answer, a different one 409. Else the end of the take in force: the first
 *  hand-back wins, and a second is 409, as is one after the take went back another way (idle, away, released). 404 when
 *  the agent asked nothing and nobody took the computer. `fresh` re-reads the run's journal after the write. */
export async function handBackCommand(
  store: ComputerCommandStore, runId: string, computer: ViewedKind,
  read: { readonly entries: readonly JournalEntry[]; readonly commands: readonly Command[] },
  outcome: "done" | "cancelled" | undefined, fresh: () => Promise<readonly JournalEntry[]>, at = Date.now(),
): Promise<{ outcome?: AskOutcome }> {
  const gone = `this run's ${computer} is not up now, so there is nothing to hand back`;
  const ask = computerAsk(read.entries, read.commands, at);
  if (ask) {
    const wanted = outcome ?? "done";
    const mine = await tryWrite(store, runId, COMPUTER_HAND_BACK, { ask: ask.id, outcome: wanted, at });
    // The rows, then the journal: an answer the runner committed meanwhile (a row's, or the run's own: the viewer's
    // hand-back, the ask's expiry) is the answer; else the lowest-id row not yet applied; else this one, applied already.
    // A run that ended between the read and the write took no row: the answer it had, if any, is the answer.
    const rows = mine ? await store.commands(runId, 0) : [];
    const given = asksIn(await fresh(), []).answers.get(ask.id);
    if (!mine && given === undefined) throw new ApiError("computer_not_live", gone);
    const winner = given ?? asksIn([], rows).answers.get(ask.id) ?? wanted;
    if (winner === wanted) return { outcome: winner };
    throw new ApiError("handoff_answered", answeredWords(winner), { details: { outcome: winner } });
  }
  const hold = holdIn(read.entries);
  const take = holdShown(hold, read.commands).take;
  if (take === undefined) {
    // Nothing in force: a take that went back already, an ask answered already, or nothing at all.
    if (hold.last !== undefined) throw new ApiError("handoff_answered", takeEndedWords(computer, hold.ended.get(hold.last)!.why), { details: { ended: hold.ended.get(hold.last)!.why } });
    const { asks, answers } = asksIn(read.entries, read.commands);
    const answered = asks.length ? answers.get(asks[asks.length - 1]!.id) ?? "expired" : undefined;
    if (answered !== undefined) throw new ApiError("handoff_answered", answeredWords(answered), { details: { outcome: answered } });
    throw new ApiError("not_found", `this run's agent has not asked for you, and nobody has taken over its ${computer}`);
  }
  const mine = await tryWrite(store, runId, COMPUTER_HAND_BACK, { take, at });
  // The rows, then the journal: the take's end, if the runner committed it, names the row that ended it (or none: the
  // viewer's hand-back, idle, away, released); else the lowest-id hand-back of this take is the one the runner applies.
  // A run that ended between the read and the write took no row: the take's end, if it has one, is the answer.
  const rows = mine ? await store.commands(runId, 0) : [];
  const ended = holdIn(await fresh()).ended.get(take);
  if (!mine && !ended) throw new ApiError("computer_not_live", gone);
  if (ended) {
    if (mine && ended.by === mine.id) return {};
    throw new ApiError("handoff_answered", takeEndedWords(computer, ended.why), { details: { ended: ended.why } });
  }
  const first = rows
    .filter((command) => command.kind === COMPUTER_HAND_BACK && ((command.body ?? {}) as Data).take === take && command.refused === null)
    .sort((a, b) => a.id - b.id)[0];
  if (!first || first.id === mine!.id) return {};
  throw new ApiError("handoff_answered", takeEndedWords(computer, "given"), { details: { ended: "given" } });
}

// ---- The take-over's three calls, over the store alone (the route table agreed with tl-browser): our two routes call
// them, and so do tl-browser's viewer (its in-WS Take over and Hand back) and its GET /v2/runs/{id}/computer (`hold`).

/** Where the calls read the run's journal from (the store's, by default), and their clock: a test's own. */
export type ComputerCallOptions = {
  readonly entries?: () => Promise<readonly JournalEntry[]>;
  readonly now?: () => number;
  readonly context?: Context;
};

/** The slice of the store the three calls read and write. */
export type ComputerCallStore = Pick<Store, "command" | "commands" | "runs" | "agents" | "readJournal">;

/** What a take-over or a hand-back answers: who drives now, and the answer the agent gets when it answered its ask. */
export type ComputerAnswer = { readonly hold: HoldState; readonly outcome?: AskOutcome };

/** The kind of computer run `runId`'s revision asks for, when it is one a person watches and takes (a desktop or a phone). */
export async function runViewedKind(store: Pick<Store, "runs" | "agents">, runId: string): Promise<ViewedKind | undefined> {
  const run = await store.runs.get(runId);
  const revision = run ? await store.agents.revision(run.revisionId) : undefined;
  const body = revision?.body;
  const setting = body && typeof body === "object" ? settingOfDefinition(body as { computer?: unknown; place?: unknown }) : undefined;
  const kind = setting?.computer.kind;
  return kind === "desktop" || kind === "phone" ? kind : undefined;
}

/** Whether run `runId` is over: no computer of an ended run is up. */
export async function runOver(store: Pick<Store, "runs">, runId: string): Promise<boolean> {
  const row = await store.runs.get(runId);
  return !row || FINAL_STATES.includes(row.state);
}

/** Run `runId`'s journal entries: the options' own, or the store's. */
export const entriesOf = (store: ComputerCallStore, runId: string, options: ComputerCallOptions = {}): Promise<readonly JournalEntry[]> =>
  options.entries ? options.entries() : runEntries(store as Store, runId, options.context ?? BACKGROUND_CONTEXT) as unknown as Promise<readonly JournalEntry[]>;

/** Who drives run `runId`'s computer now: the run's journal's hold, or pending while a take-over row waits for the runner.
 *  The agent when the run is over or its computer is not up. */
export async function computerHoldOf(store: ComputerCallStore, runId: string, options: ComputerCallOptions = {}): Promise<HoldState> {
  const hold = holdIn(await entriesOf(store, runId, options));
  if (!hold.up || (await runOver(store, runId))) return "agent";
  return holdShown(hold, await store.commands(runId, 0)).state;
}

/** The owner takes run `runId`'s desktop or phone: a take-over row the runner applies, unless a take is pending or held
 *  already (the same answer, nothing written). 404 for a run with no desktop or phone; 409 computer_not_live when it is
 *  not up now. */
export async function takeOverComputer(store: ComputerCallStore, runId: string, options: ComputerCallOptions = {}): Promise<ComputerAnswer> {
  const kind = await runViewedKind(store, runId);
  if (kind === undefined) throw new ApiError("not_found", "this run has no desktop or phone to take over (a browser is taken over in its live view)");
  const hold = holdIn(await entriesOf(store, runId, options));
  if (!hold.up || (await runOver(store, runId))) throw new ApiError("computer_not_live", `this run's ${kind} is not up now, so there is nothing to take over`);
  const taken = await takeOverCommand(store, runId, kind, hold, await store.commands(runId, 0), options.now?.() ?? Date.now());
  return { hold: taken.state };
}

/** The owner's hand-back of run `runId`'s computer, for every kind. A desktop or a phone: the agent's open ask answered
 *  (`outcome`, done when not given), else the take in force ended; the first wins, a second is 409 (handBackCommand). A
 *  browser: the answer to its agent's ask, the browser's own command (browserHandBack, the browser_hand_back row the /browser
 *  route writes), so both routes give the one answer. */
export async function handBackComputer(store: ComputerCallStore, runId: string, body: { readonly outcome?: "done" | "cancelled" } = {}, options: ComputerCallOptions = {}): Promise<ComputerAnswer> {
  const now = options.now?.() ?? Date.now();
  const fresh = () => entriesOf(store, runId, options);
  const kind = await runViewedKind(store, runId);
  if (kind === undefined) {
    const entries = await fresh();
    const target = handBackTarget(entries as Parameters<typeof handBackTarget>[0], await store.commands(runId, 0), now);
    const answered = await browserHandBack(store, runId, body.outcome ?? "done", target, now, fresh as () => Promise<Parameters<typeof handBackTarget>[0]>);
    return { hold: "agent", outcome: answered.outcome };
  }
  const answered = await handBackCommand(store, runId, kind, { entries: await fresh(), commands: await store.commands(runId, 0) }, body.outcome, fresh, now);
  return { hold: await computerHoldOf(store, runId, options), ...(answered.outcome ? { outcome: answered.outcome } : {}) };
}
