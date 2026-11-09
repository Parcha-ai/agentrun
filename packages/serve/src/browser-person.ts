// The person's turns with a run's browser: the owner takes it over from the live view and hands it back, and the agent asks
// for them (pi-browser's browser_request_handoff). Both run in the run's process, beside the live view (browser-live.ts).
//
// Take over: the viewer's Take over asks `take` here first. The person's time is held up front under the run's cap, the
// next PERSON_HOLD_MS of session time at the provider's price (browser-cost.ts personTime), and refused in the cap's words
// when it has no room; then pi-browser's driving gate holds the browser for the person until they hand it back, the
// viewer is gone PERSON_AWAY_MS, or PERSON_HOLD_MS pass with no input. The hold is dropped when it ends; the time is booked
// as session time always is. The run stays working; the timeline says "You took over the browser" and how it came back.
//
// The agent asks: pi-browser holds the session for a person and calls `request`, which holds the person's time the same
// way (refused, the tool's result says why), writes the ask's pending record in the run's directory, outside work/
// (BROWSER_ASK_DIR/<id>.json, its id a digest of the session's tag and the model's request id, 0600 in 0700: the session's tag, the instruction, the done-when condition, when it was asked
// and when it expires; never the live view's link or token), and commits a waiting row ("Waiting for you: <instruction>").
// The server reads the record: the run is input_required/waiting with `pending.kind` browser, and run.needs_input fires.
// The owner answers POST /v2/runs/{id}/browser/hand-back, which writes `<id>.answer.json` once (the first answer wins);
// unanswered by `expires_at`, the run's process writes `expired` the same way. pi-browser's wait reads it through
// `outcome`; a poll here ends any take-over at once and drops the hold. The records outlive a process that dies (the
// run is started again and its next process takes the wait up, `adopt`), and go when the run ends, or when its process
// lets its sessions go.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_PHASE } from "@parcha/pi-durable-agent/timeline";

/** pi-browser's tool for the agent's ask. */
export const HANDOFF_TOOL = "browser_request_handoff";
/** The ask's directory in the run's directory (never in work/). */
export const BROWSER_ASK_DIR = "browser-ask";
/** How long a person's time lasts at most before it expires: an unanswered ask, and a take-over with no input. Its worth of session time is held up front. */
export const PERSON_HOLD_MS = 15 * 60_000;
/** How long a take-over outlasts its viewer. */
export const PERSON_AWAY_MS = 2 * 60_000;
/** Under `--faux` only (the tests, beside the fake browser's own FAUX_BROWSER_LOG): the two windows above, in ms, `<hold>,<away>`. */
export const FAUX_PERSON_MS_ENV = "FAUX_BROWSER_PERSON_MS";
/** For tests (under `--faux`): a file's path; the run's process dies once (making the file) right after it writes an ask's
 *  record and before it commits the ask's row, as a crash there would. */
export const FAUX_ASK_DIES_ENV = "FAUX_BROWSER_ASK_DIES";

export type AskOutcome = "done" | "cancelled" | "expired";
/** An ask's pending record, as the server reads it. */
export type PendingAsk = { id: string; tag: string; instruction: string; completion_condition: string; asked_at: string; expires_at: string };
/** `reason`: why, for the agent, when the run's cap ended the ask (kept with the answer, so a restart still tells it). */
export type Answer = { outcome: AskOutcome; at: string; reason?: string };

/** An ask's id: 32 characters (askIdOf). A record named otherwise (an earlier build's 22, named by the request id alone,
 *  shared across sessions) is no ask: never read, shown, answered or taken up. */
const ID = /^[A-Za-z0-9_-]{32}$/;
const TAG = /^[A-Za-z0-9._:-]{1,200}$/;
const OUTCOMES: readonly string[] = ["done", "cancelled", "expired"];
/** What the person sees of an instruction or a condition, at most. */
const MAX_TEXT = 2000;

/** The ask's id: pi-browser's request id is the model's, so the file is named by a digest of it, never by it; and of the
 *  session's tag with it, since two conversations of one run (each its own session) may pick the same request id, and
 *  each ask is its session's own: its instruction, its answer, its take-over. */
export const askIdOf = (sessionTag: string, requestId: string): string => createHash("sha256").update(`${sessionTag}\n${requestId}`).digest("base64url").slice(0, 32);

/** Whether `at` is this user's alone, and not a link: a directory (0700) or a file (0600). */
const ownAlone = (at: Stats, dir: boolean): boolean => (dir ? at.isDirectory() : at.isFile()) && !at.isSymbolicLink() && (at.mode & 0o077) === 0 && (!process.getuid || at.uid === process.getuid());

/** The run's ask directory when it is this user's alone; made (0700) when `make`. */
function askDir(runDir: string, make = false): string | undefined {
  const dir = join(runDir, BROWSER_ASK_DIR);
  if (make) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  try {
    return ownAlone(lstatSync(dir), true) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON file of this user's alone in the ask directory, or undefined: opened without following a link, and checked on
 *  the handle it reads. */
function readOwn(dir: string, name: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    return ownAlone(fstatSync(fd), false) ? JSON.parse(readFileSync(fd, "utf8")) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes `value` as `name`, whole, 0600: under a name of its own first, then into place, replacing (`once` false) or only
 *  when there is none yet (`once`, by a hard link, which never replaces). False when `once` found one there. */
function writeOwn(dir: string, name: string, value: unknown, once: boolean): boolean {
  const making = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(making, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  try {
    if (!once) {
      renameSync(making, join(dir, name));
      return true;
    }
    try {
      linkSync(making, join(dir, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      unlinkSync(making);
    } catch {
      // renamed into place, or gone
    }
  }
}

const pendingOf = (value: unknown, id: string): PendingAsk | undefined => {
  const v = value as Partial<PendingAsk> | undefined;
  const ok = v?.id === id && typeof v.tag === "string" && TAG.test(v.tag) && typeof v.instruction === "string" && typeof v.completion_condition === "string" && Number.isFinite(Date.parse(String(v.asked_at))) && Number.isFinite(Date.parse(String(v.expires_at)));
  return ok ? { id, tag: v.tag!, instruction: v.instruction!, completion_condition: v.completion_condition!, asked_at: v.asked_at!, expires_at: v.expires_at! } : undefined;
};
const answerOf = (value: unknown): Answer | undefined => {
  const v = value as Partial<Answer> | undefined;
  return v && OUTCOMES.includes(String(v.outcome)) && typeof v.at === "string" ? { outcome: v.outcome as AskOutcome, at: v.at, ...(typeof v.reason === "string" ? { reason: v.reason } : {}) } : undefined;
};

/** Every ask the run's directory holds, newest first, each with its answer when it has one. */
function asksIn(runDir: string): Array<{ ask: PendingAsk; answer?: Answer }> {
  if (!existsSync(join(runDir, BROWSER_ASK_DIR))) return [];
  const dir = askDir(runDir);
  if (!dir) return [];
  const found: Array<{ ask: PendingAsk; answer?: Answer }> = [];
  for (const name of readdirSync(dir)) {
    const id = /^([A-Za-z0-9_-]{32})\.json$/.exec(name)?.[1];
    const ask = id ? pendingOf(readOwn(dir, name), id) : undefined;
    if (!ask) continue;
    const answer = answerOf(readOwn(dir, `${ask.id}.answer.json`));
    found.push({ ask, ...(answer ? { answer } : {}) });
  }
  return found.sort((a, b) => Date.parse(b.ask.asked_at) - Date.parse(a.ask.asked_at) || b.ask.id.localeCompare(a.ask.id));
}

/** The ask the run waits on: the newest unanswered one that has not expired, or undefined. Read where a run's status is
 *  read (runs.ts statusOf), so a run with no ask costs one existence check. */
export function openAsk(runDir: string, now = Date.now()): PendingAsk | undefined {
  const waiting = waitingAsk(runDir);
  return waiting && Date.parse(waiting.expires_at) > now ? waiting : undefined;
}

/** The newest unanswered ask, expired or not: one a process must still take up (answer it, or write its expiry), as a
 *  restarted run's process does. */
export function waitingAsk(runDir: string): PendingAsk | undefined {
  try {
    return asksIn(runDir).find(({ answer }) => !answer)?.ask;
  } catch {
    return undefined;
  }
}

/** Whether the run's directory still holds an ask's record, answered or not: one its agent's call may still be waiting
 *  on (the records go when the run ends, or when its process lets its sessions go). */
export function asked(runDir: string): boolean {
  try {
    return asksIn(runDir).length > 0;
  } catch {
    return false;
  }
}

/** The ask the run waits on (`which`: "open", unexpired, as its status reads it; "waiting", expired or not, as a process
 *  must still take up) once its own waiting row is in `rows`: the run's process writes the record first, then commits the
 *  row. Each ask on a session writes one waiting row, in the order asked, so the nth ask on a session is in once that
 *  session has n waiting rows, whatever other asks (another conversation's, answered or not) wrote meanwhile. */
export function askShown(runDir: string, rows: readonly { kind: string; session?: string }[], which: "open" | "waiting" = "open"): PendingAsk | undefined {
  const ask = which === "open" ? openAsk(runDir) : waitingAsk(runDir);
  if (!ask) return undefined;
  const on = asksIn(runDir).map(({ ask: each }) => each).filter((each) => each.tag === ask.tag).reverse();
  const nth = on.findIndex((each) => each.id === ask.id) + 1;
  return rows.filter((row) => row.kind === "waiting" && row.session === ask.tag).length >= nth ? ask : undefined;
}

/** The answer to ask `id`, or the first answer written now (at `at`, ms): `outcome` unless one is there already. */
function answerOnce(dir: string, id: string, outcome: AskOutcome, reason?: string, at = Date.now()): AskOutcome {
  if (writeOwn(dir, `${id}.answer.json`, { outcome, at: new Date(at).toISOString(), ...(reason ? { reason } : {}) }, true)) return outcome;
  return answerOf(readOwn(dir, `${id}.answer.json`))?.outcome ?? outcome;
}

/** The owner's answer to the run's ask: the newest one still waiting, as `openAsk` reads it (two conversations may each
 *  ask), written when it is the first (`first`); with none waiting, the answer the newest one has. An ask past its expiry
 *  has `expired`. Undefined when the run has asked nothing. */
export function answerAsk(runDir: string, outcome: "done" | "cancelled", now = Date.now()): { outcome: AskOutcome; first: boolean } | undefined {
  const asks = asksIn(runDir);
  const target = asks.find(({ answer }) => !answer) ?? asks[0];
  const dir = askDir(runDir);
  if (!target || !dir) return undefined;
  if (target.answer) return { outcome: target.answer.outcome, first: false };
  if (Date.parse(target.ask.expires_at) <= now) return { outcome: answerOnce(dir, target.ask.id, "expired", undefined, now), first: false };
  const answered = answerOnce(dir, target.ask.id, outcome, undefined, now);
  return { outcome: answered, first: answered === outcome };
}

/** Removes every ask: the run's process that made them is gone. */
export function dropAsks(runDir: string): void {
  try {
    rmSync(join(runDir, BROWSER_ASK_DIR), { recursive: true, force: true });
  } catch {
    // left for the next start's, or the next exit's
  }
}

/** Why a take-over ended, as pi-browser's gate says it. */
type HoldEnd = "given" | "answered" | "cap" | "idle" | "away" | "released";
/** The rows a person's turns leave, beside the waiting row an ask writes. */
const TAKEN = "You took over the browser";
const GIVEN_BACK = "You handed the browser back";
const CAPPED = "The browser went back to the agent at the run's spend cap";
const TAKE_ENDED: Record<Exclude<HoldEnd, "answered" | "cap">, string> = {
  given: GIVEN_BACK,
  idle: "The browser went back to the agent: no input came from you for a while",
  away: "The browser went back to the agent: the live view was closed",
  released: "The browser's session ended while you had it",
};
const CAP_ENDED = "The agent's hand-over ended at the run's spend cap";
const ASK_ENDED: Record<AskOutcome, string> = { done: GIVEN_BACK, cancelled: "You cancelled the agent's hand-over", expired: "The agent's hand-over expired before you answered it" };

/** The hand-over entry an ask commits: the whole ask, as the server reads it (browser-commands.ts), its session's tag as
 *  `session`, and its instruction again as `reason` (the timeline's words). */
const waitingEntry = (ask: PendingAsk): Record<string, string> => ({
  state: "waiting",
  id: ask.id,
  session: ask.tag,
  instruction: ask.instruction,
  completion_condition: ask.completion_condition,
  asked_at: ask.asked_at,
  expires_at: ask.expires_at,
  reason: ask.instruction,
});

/** A take-over's share of its session's person time (an ask's is `ask:<id>`). */
const TAKE_USER = "take";
/** A root entry of the run's: a timeline row's source. A phase's carries `at` (ms), when what it says happened, so its row
 *  shows that time, not the time of the log before it (a model request's start, a call's result). */
type Note = (kind: string, data: Record<string, string | number>) => Promise<void>;

/** The run's process's side, for the run at `root`: `take` for the live view's takeOver, `handoff` for pi-browser's
 *  HandoffPort. `gates` is the live view's registry (pi-browser's driving gates); `personTime` holds the person's time
 *  under the cap (browser-cost.ts); `note` commits a root entry, which reaches the run's timeline. */
export function personHands(options: {
  root: string;
  gates: (tag: string) => { give?(why: "answered" | "cap", message?: string): boolean };
  /** `pauses: false`: a refusal does not pause the agent's run (the person's own take-over, a re-hold): only the agent's own
   *  step, its ask, does (cap.ts paidCall). */
  personTime(what: string, seconds: number, options?: { pauses?: boolean; tag?: string; from?: number }): Promise<{ refused: string } | { drop(): void }>;
  note: Note;
  holdMs?: number;
  pollMs?: number;
  /** For tests: the timer functions the person's time is held again by. */
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** For tests: the clock the person's time is measured by. */
  now?: () => number;
  /** The run's held values cut from the ask's words, whole, before they are cut to their bound and written. */
  redact?: (text: string) => string;
  /** The person's time on a session that just ended, `seconds` of it, to hold until a charge books it (browser-cost.ts
   *  carry): the up-front holds go as it ends, the time it took stays counted. */
  carry?(tag: string, seconds: number): void;
  /** How many waiting rows session `tag` has in the run's timeline (each ask on it writes one, in the order asked). */
  waiting?(tag: string): Promise<number>;
  /** On the runner's path: ask `id`'s answer as the run's journal has it (its first answered hand-over entry), or
   *  undefined. Given, an ask's answers are journal entries: the person's (a browser_hand_back row the runner applies),
   *  and those this process writes through `note` (the live view's hand-back, the ask's expiry at the expiry's time, its
   *  end at the cap). The answer files are neither read nor written. */
  answered?(id: string): Promise<Answer | undefined>;
  /** For tests: called between an ask's record and its row. */
  afterRecord?: () => void;
}) {
  const holdMs = options.holdMs ?? PERSON_HOLD_MS;
  const timers = options.timers ?? { set: (run: () => void, ms: number) => setTimeout(run, ms).unref(), clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
  const open = new Map<string, { tag: string; expiresAt: number; drop(): void }>();
  const settled = new Map<string, AskOutcome>();
  /** Asks the run's cap ended (a refused re-hold), and its words. */
  const capped = new Map<string, string>();
  let poll: NodeJS.Timeout | undefined;
  /** The run's process let go (close): every hold that comes back after it is dropped, and nothing new is held. */
  let closed = false;
  const CLOSED = { refused: "the run's process is letting go of the browser" };
  const note = (kind: string, data: Record<string, string | number>): Promise<void> => options.note(kind, data).catch(() => undefined);
  /** The run's journal holds the answers (options.answered): the runner's path. */
  const journal = options.answered;
  /** Each ask's answer as the journal has it, once read: an answer never changes. */
  const fromJournal = new Map<string, Answer>();
  /** The answer this process is writing for an ask, if any: a read waits for it. */
  const writing = new Map<string, Promise<void>>();
  /** Ask `id`'s answer from the journal, read through. */
  const journalRead = async (id: string): Promise<Answer | undefined> => {
    const known = fromJournal.get(id);
    if (known || !journal) return known;
    const found = await journal(id).catch(() => undefined);
    if (found) fromJournal.set(id, found);
    return found;
  };
  /** Ask `id`'s answer from the journal, once any this process is writing is in. */
  const readJournal = async (id: string): Promise<Answer | undefined> => {
    await writing.get(id);
    return journalRead(id);
  };
  /** Ask `id` answered `outcome` at `at` in the journal, unless it has an answer there (the first is its answer). A write
   *  the journal refused leaves the answer this process gave, so the agent's wait still ends. */
  const answerInJournal = (id: string, tag: string, outcome: AskOutcome, at: string, reason?: string): Promise<void> => {
    const write = (writing.get(id) ?? Promise.resolve()).then(async () => {
      if (await journalRead(id)) return;
      await note("agent.handover", { state: outcome, id, session: tag, at, ...(reason !== undefined ? { reason } : {}) });
      if (!(await journalRead(id))) fromJournal.set(id, { outcome, at, ...(reason !== undefined ? { reason } : {}) });
    });
    writing.set(id, write);
    return write;
  };

  /** The person's time on each session, held once under the cap for everyone who needs it there (a take-over, an ask), and
   *  dropped when the last of them is over: a take then an ask, or an ask then a take, holds it once. `ready` settles when
   *  the first hold is taken, or refused. While anyone needs it, it is held again each holdMs (a take-over kept alive by
   *  input has no end of its own): with no room, a take-over gives the browser back (`cap`, in the cap's words). */
  /** `until`: how far (ms, on this clock) what is held covers; an ask that joins needs it to reach its own expiry. */
  /** `turns`: what extends `until` (a re-hold, an ask's reach, a hold again after a refusal) runs one at a time, each
   *  from `until` as the one before left it: two that awaited the cap side by side would each hold the same stretch. */
  type Ledger = { holds: Array<{ drop(): void }>; users: Set<string>; ready: Promise<{ refused: string } | undefined>; timer?: unknown; refused?: string; since: number; until: number; turns: Promise<unknown> };
  const now = options.now ?? Date.now;
  const ledgers = new Map<string, Ledger>();
  /** `work` on `ledger` once every extension before it is done. */
  const inTurn = <T>(ledger: Ledger, work: () => Promise<T>): Promise<T> => {
    const run = ledger.turns.then(work, work);
    ledger.turns = run.catch(() => undefined);
    return run;
  };
  /** `user`'s share of session `tag`'s person time: held now when nobody holds it (`what` names it in the cap's words), and,
   *  with `reach` (an ask's expiry), held through it: what an earlier user holds falls short of a later ask's expiry, and
   *  the stretch between is held for it, or it is refused. */
  const acquire = async (tag: string, user: string, what: string, pauses: boolean, reach?: number): Promise<{ refused: string } | undefined> => {
    for (;;) {
      if (closed) return CLOSED;
      const known = ledgers.get(tag);
      if (known) {
        // The first hold refused (or failed): the ledger is gone, and this one asks the cap for itself, in its own words.
        const first = await known.ready.catch(() => ({ refused: "the person's time could not be held" }));
        if (first || ledgers.get(tag) !== known) continue;
        const joined = await inTurn(known, async (): Promise<{ refused: string } | undefined | "gone"> => {
          if (ledgers.get(tag) !== known) return "gone";
          // The cap refused to hold more of the person's time here: whoever comes now (a take-over, a new ask) needs more of
          // it, so asks the cap itself, in its own words; with room again, it holds the next stretch and the holding goes on.
          if (known.refused) {
            // Re-held from max(where coverage ends, now): a ledger refused at its coverage end has no live users over the
            // idle gap since (the reserve and any calls already cover it), so re-holding from `until` would hold that gap a
            // second time and could falsely refuse a person returning long after. again() differs: it runs only while the
            // ledger has live users, so its from-until never spans an idle gap.
            const from = Math.max(known.until, now());
            const seconds = Math.max(0, now() + holdMs - from) / 1000;
            const hold = await options.personTime(what, seconds, { pauses, tag, from }).catch(() => ({ refused: "the person's time could not be held" }));
            if ("refused" in hold) return { refused: hold.refused };
            if (ledgers.get(tag) !== known) {
              hold.drop();
              return "gone";
            }
            known.holds.push(hold);
            known.refused = undefined;
            known.until = Math.max(known.until, now() + holdMs);
            if (known.timer !== undefined) timers.clear(known.timer);
            again(tag, known);
          }
          // An ask whose expiry falls past what is held: the stretch between, held for it under the cap, or it is refused.
          if (reach !== undefined && reach > known.until) {
            const hold = await options.personTime(what, (reach - known.until) / 1000, { pauses, tag, from: known.until }).catch(() => ({ refused: "the person's time could not be held" }));
            if ("refused" in hold) return { refused: hold.refused };
            if (ledgers.get(tag) !== known) {
              hold.drop();
              return "gone";
            }
            known.holds.push(hold);
            known.until = reach;
          }
          known.users.add(user);
          return undefined;
        });
        if (joined === "gone") continue;
        return joined;
      }
      // The first hold covers holdMs, or less: an ask taken up near its expiry (`reach`, a restarted process's adopt) holds
      // only what is left of it, and one at or past it holds nothing (its expiry is written as it is taken up).
      const start = now();
      const span = reach === undefined ? holdMs : Math.min(holdMs, reach - start);
      if (span <= 0) return undefined;
      const ledger: Ledger = { holds: [], users: new Set([user]), ready: Promise.resolve(undefined), since: start, until: start + span, turns: Promise.resolve() };
      ledger.ready = options.personTime(what, span / 1000, { pauses, tag, from: ledger.since }).then(
        (hold) => {
          // Let go meanwhile (close): the hold goes, and nothing is held again.
          if (!("refused" in hold) && (closed || ledgers.get(tag) !== ledger)) {
            hold.drop();
            return CLOSED;
          }
          if (!("refused" in hold)) {
            ledger.holds.push(hold);
            again(tag, ledger);
            return undefined;
          }
          if (ledgers.get(tag) === ledger) ledgers.delete(tag);
          return { refused: hold.refused };
        },
        (error: unknown) => {
          if (ledgers.get(tag) === ledger) ledgers.delete(tag);
          throw error;
        },
      );
      ledgers.set(tag, ledger);
      return ledger.ready;
    }
  };
  /** Holds session `tag`'s person time again holdMs from now, and so on while anyone needs it. The holds add up: the time
   *  already spent is booked at the session's next charge, so until then each stretch stays held. */
  const again = (tag: string, ledger: Ledger): void => {
    ledger.timer = timers.set(() => void inTurn(ledger, async () => {
      if (ledgers.get(tag) !== ledger) return;
      // Only past what is held already (an ask that joined may have held further): every minute held once.
      const seconds = Math.max(0, now() + holdMs - ledger.until) / 1000;
      if (seconds <= 0) return void again(tag, ledger);
      const hold = await options.personTime("more of your time in the browser", seconds, { pauses: false, tag, from: ledger.until }).catch(() => ({ refused: "the person's time could not be held" }));
      if (ledgers.get(tag) !== ledger) return void ("refused" in hold || hold.drop());
      if (!("refused" in hold)) {
        ledger.holds.push(hold);
        ledger.until = Math.max(ledger.until, now() + holdMs);
        again(tag, ledger);
        return;
      }
      // No room: everyone on the session ends here, so nothing outlives what is held: a take-over goes back to the agent
      // (cap), and each ask open on it expires, the agent told the cap's words.
      ledger.refused = hold.refused;
      if (ledger.users.has(TAKE_USER)) options.gates(tag).give?.("cap", hold.refused);
      for (const user of [...ledger.users]) if (user.startsWith("ask:")) capAsk(user.slice(4), hold.refused);
    }), holdMs);
  };
  /** `user` is done with session `tag`: the last one out drops what was held. */
  const release = (tag: string, user: string): void => {
    const ledger = ledgers.get(tag);
    if (!ledger || !ledger.users.delete(user) || ledger.users.size) return;
    ledgers.delete(tag);
    if (ledger.timer !== undefined) timers.clear(ledger.timer);
    // The time the person had is spent at the provider: it stays held until booked, before what was held up front goes.
    if (ledger.holds.length) options.carry?.(tag, (now() - ledger.since) / 1000);
    for (const hold of ledger.holds) hold.drop();
  };

  /** Ask `id` ended at the run's cap (`words`): expired, written as its answer (the first, as any is), its wait told why. */
  const capAsk = (id: string, words: string): void => {
    const dir = askDir(options.root);
    if (!dir || settled.has(id)) return;
    capped.set(id, words);
    if (journal) {
      // The runner's path: the end is the journal's answer, now, unless the ask has one there already.
      const tag = open.get(id)?.tag ?? pendingOf(readOwn(dir, `${id}.json`), id)?.tag;
      if (tag) void answerInJournal(id, tag, "expired", new Date(now()).toISOString(), words).then(() => settle(id), () => undefined);
      return;
    }
    answerOnce(dir, id, "expired", words, now());
    settle(id);
  };

  /** Session `tag`'s newest ask still waiting (unanswered, unexpired), answered done: the person handed that session's
   *  browser back. Its hold goes with it (settle), and another session's ask is never touched. True when an ask was
   *  settled here, whose row (settle's) says the hand-back. */
  const givenDone = (tag: string): boolean => {
    const dir = askDir(options.root);
    // On the runner's path an ask's answer is the journal's (an answer file is never read there).
    const unanswered = (ask: PendingAsk, answer: Answer | undefined) => (journal ? !fromJournal.has(ask.id) : !answer);
    const waiting = dir ? asksIn(options.root).find(({ ask, answer }) => unanswered(ask, answer) && ask.tag === tag && Date.parse(ask.expires_at) > Date.now())?.ask : undefined;
    if (!dir || !waiting || settled.has(waiting.id)) return false;
    if (journal) {
      // Written as the journal's answer, now, unless the ask has one there already (a person's answer that came first
      // writes its own row, settle's, as this one would).
      void answerInJournal(waiting.id, tag, "done", new Date(now()).toISOString()).then(() => settle(waiting.id), () => undefined);
      return true;
    }
    answerOnce(dir, waiting.id, "done", undefined, now());
    return settle(waiting.id) !== undefined;
  };

  /** Ask `id` as its record on disk has it, taken up by this process: one an earlier process of the run made, whose wait
   *  this process resumes (pi-browser polls `outcome` again, or reruns `request`). Its time is no longer held (that process
   *  is gone, and its holds with it). Undefined when there is no such record. */
  const adopt = (id: string): { tag: string; expiresAt: number; drop(): void } | undefined => {
    const known = open.get(id);
    if (known) return known;
    const dir = askDir(options.root);
    const kept = dir ? pendingOf(readOwn(dir, `${id}.json`), id) : undefined;
    if (!kept) return undefined;
    const ask = { tag: kept.tag, expiresAt: Date.parse(kept.expires_at), drop() {} };
    open.set(id, ask);
    watch();
    // Its time was held by the process that asked, which is gone: held again here, under the cap, as an ask's is. With no
    // room it ends at the cap, as everyone on a session whose re-hold the cap refused does: a take-over of the session goes
    // back to the agent (cap), and the ask expires, the agent told the cap's words. Nobody drives unheld.
    const user = `ask:${id}`;
    // Held through its own expiry, as its asking held it: joining a take-over's hold, the stretch past it.
    void acquire(kept.tag, user, "handing the browser to you", false, Date.parse(kept.expires_at)).then((refused) => {
      // The process let go meanwhile: the ask is the next process's to take up, never ended here.
      if (closed) return refused ? undefined : release(kept.tag, user);
      if (refused) {
        options.gates(kept.tag).give?.("cap", refused.refused);
        return capAsk(id, refused.refused);
      }
      if (settled.has(id) || open.get(id) !== ask) return release(kept.tag, user);
      ask.drop = () => release(kept.tag, user);
    }, () => undefined);
    return ask;
  };

  /** Ask `id`, taken up from an earlier process, whose row that process never committed (it ended between the record and
   *  the row): the row is committed now, so the run shows the ask and its notice goes out. The nth ask on a session is in
   *  once the session has n waiting rows, as askShown reads it. An ask answered or expired needs none. */
  const reshow = async (id: string): Promise<void> => {
    const dir = askDir(options.root);
    const kept = dir && options.waiting ? pendingOf(readOwn(dir, `${id}.json`), id) : undefined;
    if (!dir || !kept || settled.has(id) || (journal ? await readJournal(id) : answerOf(readOwn(dir, `${id}.answer.json`))) || Date.parse(kept.expires_at) <= Date.now()) return;
    const nth = asksIn(options.root).map(({ ask: each }) => each).filter((each) => each.tag === kept.tag).reverse().findIndex((each) => each.id === id) + 1;
    if (nth > 0 && (await options.waiting!(kept.tag)) < nth) await note("agent.handover", waitingEntry(kept));
  };

  /** Ask `id`'s answer, once there is one (the person's, or `expired` once it is due, written here): its hold dropped, any
   *  take-over of its session ended, and its row written, once. An ask this process did not make is taken up first. */
  const settle = (id: string): AskOutcome | undefined => {
    const known = settled.get(id);
    if (known) return known;
    const ask = adopt(id);
    const dir = askDir(options.root);
    if (!ask || !dir) return undefined;
    // On the runner's path the answer is the journal's, as last read (refresh writes a lapsed ask's expiry there first).
    const written = journal ? fromJournal.get(id) : answerOf(readOwn(dir, `${id}.answer.json`));
    const answered = written?.outcome ?? (!journal && Date.now() >= ask.expiresAt ? answerOnce(dir, id, "expired", undefined, now()) : undefined);
    if (!answered) return undefined;
    // The cap's words, kept with the answer: a process that takes the ask up after a restart tells them too.
    if (written?.reason !== undefined && !capped.has(id)) capped.set(id, written.reason);
    settled.set(id, answered);
    open.delete(id);
    ask.drop();
    options.gates(ask.tag).give?.("answered");
    const words = capped.get(id);
    // At the answer's own time (the person's, or the expiry's as written), which can be well before this process reads it.
    const when = written ? Date.parse(written.at) : now();
    void note(HOST_PHASE, { summary: words !== undefined && answered === "expired" ? `${CAP_ENDED}: ${words}` : ASK_ENDED[answered], at: Number.isFinite(when) ? when : now() });
    if (!open.size && poll) (clearInterval(poll), (poll = undefined));
    return answered;
  };
  /** On the runner's path, before settle reads ask `id`: its answer read from the journal, or, once it lapsed with none,
   *  its expiry written there at the expiry's time (the first answer stands, whoever's it is). */
  const refresh = async (id: string): Promise<void> => {
    if (!journal || settled.has(id) || (await readJournal(id))) return;
    const ask = adopt(id);
    if (ask && Date.now() >= ask.expiresAt) await answerInJournal(id, ask.tag, "expired", new Date(ask.expiresAt).toISOString());
  };
  const watch = () => {
    poll ??= setInterval(() => { for (const id of [...open.keys()]) void refresh(id).then(() => settle(id), () => undefined); }, options.pollMs ?? 500);
    poll.unref();
  };

  return {
    /** The live view's take: the person's time held, unless an ask open on the same session holds it already (its answer
     *  ends the take); refused in the cap's words when there is no room. */
    async take(tag: string): Promise<{ refused: string } | { end(why: HoldEnd): void; started(): void; cancel(): void }> {
      const refused = await acquire(tag, TAKE_USER, "taking over the browser", false);
      if (refused) return refused;
      let ended = false;
      let live = false;
      return {
        // The row is the hold's going live (a take while the agent's call runs goes live once it returns).
        started: () => {
          if (ended || live) return;
          live = true;
          void note(HOST_PHASE, { summary: TAKEN, at: now() });
        },
        // No hold started after all: what was held for it goes, and no row was written for it.
        cancel: () => {
          if (ended) return;
          ended = true;
          release(tag, TAKE_USER);
        },
        end: (why) => {
          if (ended) return;
          ended = true;
          const words = ledgers.get(tag)?.refused;
          release(tag, TAKE_USER);
          // Ended before it went live (the agent's call still running): the person never had the browser, and no row says
          // they took it, so none says how it came back. An answered ask writes its own row.
          if (!live) return;
          // Handed back by the person (the viewer's Hand back): their word that they are done, so the agent's open ask on
          // this session is answered done, as the hand-back route would answer it (first answer wins). Never on any other
          // end (cap, idle, away, released, answered): the person did not say they were done. The answer's own row
          // ("You handed the browser back", settle's) is then the hand-back's one row: none is written here as well.
          const answeredAsk = why === "given" && givenDone(tag);
          if (why === "cap") void note(HOST_PHASE, { summary: `${CAPPED}${words ? `: ${words}` : ""}`, at: now() });
          else if (why !== "answered" && !answeredAsk) void note(HOST_PHASE, { summary: TAKE_ENDED[why], at: now() });
        },
      };
    },
    /** pi-browser's HandoffPort. Idempotent by session and request id: a rerun on the same session finds its ask's record;
     *  another session's ask with the same request id is its own. The live view's link it is handed is never kept. */
    handoff: {
      async request(ask: { requestId: string; sessionTag: string; instruction: string; completionCondition: string }): Promise<{ interactionId: string } | { refused: string }> {
        if (!TAG.test(ask.sessionTag)) return { refused: "the session's tag is not one this server takes" };
        const id = askIdOf(ask.sessionTag, ask.requestId);
        if (settled.has(id) || open.has(id)) return { interactionId: id };
        const dir = askDir(options.root, true);
        if (!dir) return { refused: "the run's directory for a hand-over is not this server's alone" };
        // An ask an earlier process of this run made: waited on again, its time no longer held (that process is gone), and
        // its row committed if that process ended before it could.
        if (adopt(id)) {
          await reshow(id);
          return { interactionId: id };
        }
        // A take-over of the same session holds the person's time already: the ask shares it.
        const user = `ask:${id}`;
        const refused = await acquire(ask.sessionTag, user, "handing the browser to you", true, now() + holdMs);
        if (refused) return refused;
        const hold = { drop: () => release(ask.sessionTag, user) };
        const at = Date.now();
        // Redacted whole, then cut to their bound: a held value the cut would split never leaves its head in the record.
        const shown = (text: string) => (options.redact ? options.redact(text) : text).slice(0, MAX_TEXT);
        const record: PendingAsk = { id, tag: ask.sessionTag, instruction: shown(ask.instruction), completion_condition: shown(ask.completionCondition), asked_at: new Date(at).toISOString(), expires_at: new Date(at + holdMs).toISOString() };
        try {
          writeOwn(dir, `${id}.json`, record, false);
        } catch (error) {
          hold.drop();
          throw error;
        }
        open.set(id, { tag: ask.sessionTag, expiresAt: at + holdMs, drop: () => hold.drop() });
        watch();
        options.afterRecord?.();
        // The record is in place before the row: the row's commit is what makes the server read the run's status again.
        // The row is what shows the person the ask (askShown): one that cannot be written fails the request, plainly, and
        // leaves nothing behind (its hold, its open entry, its record), so the agent's next request makes it afresh.
        try {
          await options.note("agent.handover", waitingEntry(record));
        } catch {
          if (open.get(id)?.drop) open.get(id)!.drop();
          open.delete(id);
          if (!open.size && poll) (clearInterval(poll), (poll = undefined));
          try {
            unlinkSync(join(dir, `${id}.json`));
          } catch {
            // gone already
          }
          return { refused: "the hand-over could not be shown to the person (its request was not written to the run's timeline): nothing is held for it, and it can be asked again" };
        }
        return { interactionId: id };
      },
      async outcome(interactionId: string): Promise<"pending" | AskOutcome | { outcome: AskOutcome; reason: string }> {
        // An id of no shape this build makes (an earlier build's, named by the request id alone) names no ask here: gone, so
        // the agent's wait ends (it may ask again), never polled forever or matched to another session's record.
        if (!ID.test(interactionId)) return "expired";
        await refresh(interactionId);
        const answered = settle(interactionId) || "pending";
        // Ended at the cap: the agent is told so, in the cap's words.
        const words = capped.get(interactionId);
        return answered === "expired" && words !== undefined ? { outcome: answered, reason: words } : answered;
      },
    },
    /** The run's process lets go: its holds dropped, its poll stopped. */
    close(): void {
      closed = true;
      if (poll) clearInterval(poll);
      poll = undefined;
      for (const ask of open.values()) ask.drop();
      open.clear();
      for (const ledger of ledgers.values()) {
        if (ledger.timer !== undefined) timers.clear(ledger.timer);
        for (const hold of ledger.holds) hold.drop();
      }
      ledgers.clear();
    },
  };
}

/** The two windows of a person's time for a run's process with environment `env`: the defaults, or under `--faux` the
 *  tests' (FAUX_PERSON_MS_ENV). */
export function personWindows(env: NodeJS.ProcessEnv, faux: boolean): { holdMs: number; awayMs: number } {
  const [hold, away] = (faux ? env[FAUX_PERSON_MS_ENV] ?? "" : "").split(",").map(Number);
  return { holdMs: hold && hold > 0 ? hold : PERSON_HOLD_MS, awayMs: away && away > 0 ? away : PERSON_AWAY_MS };
}
