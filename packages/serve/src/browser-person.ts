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
// way (refused, the tool's result says why) and commits the ask's waiting entry to the run's journal (an agent.handover
// note, its id a digest of the session's tag and the model's request id: the session's tag, the instruction, the
// done-when condition, when it was asked and when it expires; never the live view's link or token). That entry is the
// ask's one record: no file holds it, so nothing the run's agent reaches (its workspace, its file tools, the run's file
// list) can read, change or plant an ask. The server reads the journal (browser-commands.ts): the run is
// input_required/waiting with `pending.kind` browser, and run.needs_input fires. The owner answers POST
// /v2/runs/{id}/browser/hand-back, a command row the runner applies as the ask's answered entry (the first answer wins);
// the live view's hand-back and the ask's expiry are answered entries this process writes the same way. pi-browser's wait
// reads the answer through `outcome`; a poll here ends any take-over at once and drops the hold. An ask outlives a process
// that dies: the run's next claim reads it back from the journal and takes the wait up (`adopt`).
import { createHash } from "node:crypto";
import { HOST_PHASE } from "./timeline/index.js";

/** How long a person's time lasts at most before it expires: an unanswered ask, and a take-over with no input. Its worth of session time is held up front. */
export const PERSON_HOLD_MS = 15 * 60_000;
/** How long a take-over outlasts its viewer. */
export const PERSON_AWAY_MS = 2 * 60_000;
/** Under `--faux` only (the tests, beside the fake browser's own FAUX_BROWSER_LOG): the two windows above, in ms, `<hold>,<away>`. */
export const FAUX_PERSON_MS_ENV = "FAUX_BROWSER_PERSON_MS";

export type AskOutcome = "done" | "cancelled" | "expired";
/** An ask, as its waiting entry in the run's journal holds it. */
export type PendingAsk = { id: string; tag: string; instruction: string; completion_condition: string; asked_at: string; expires_at: string };
/** `reason`: why, for the agent, when the run's cap ended the ask (kept with the answer, so a restart still tells it). */
export type Answer = { outcome: AskOutcome; at: string; reason?: string };

/** An ask's id: 32 characters (askIdOf). An id of another shape (an earlier build's 22, named by the request id alone,
 *  shared across sessions) is no ask: never read, answered or taken up. */
const ID = /^[A-Za-z0-9_-]{32}$/;
const TAG = /^[A-Za-z0-9._:-]{1,200}$/;
/** What the person sees of an instruction or a condition, at most. */
const MAX_TEXT = 2000;

/** The ask's id: pi-browser's request id is the model's, so the ask is named by a digest of it, never by it; and of the
 *  session's tag with it, since two conversations of one run (each its own session) may pick the same request id, and
 *  each ask is its session's own: its instruction, its answer, its take-over. */
export const askIdOf = (sessionTag: string, requestId: string): string => createHash("sha256").update(`${sessionTag}\n${requestId}`).digest("base64url").slice(0, 32);

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

/** A take-over's share of its session's person time (an ask's is `ask:<id>`; a wait on an ask_person answer's,
 *  `wait:<call id>`). */
const TAKE_USER = "take";
/** What the person's time is held for while the run waits in its claim on their answer to its question, in the cap's words. */
const WAIT_WHAT = "keeping the browser open while you answer";
/** Why such a wait ends when a session it kept open is let go (released, idle or lost). */
const WAIT_SESSION_GONE = "the browser session it kept open for the person was let go";
/** Why such a wait ends at its bound: the one a browser hand-over's ask waits (holdMs, PERSON_HOLD_MS by default). */
const waitExpired = (holdMs: number) => `the person did not answer within ${holdMs >= 60_000 ? `${Math.round(holdMs / 60_000)} minutes` : `${Math.round(holdMs / 1000)} seconds`}, the bound a browser hand-over waits`;
/** A root entry of the run's: a timeline row's source. A phase's carries `at` (ms), when what it says happened, so its row
 *  shows that time, not the time of the log before it (a model request's start, a call's result). */
type Note = (kind: string, data: Record<string, string | number>) => Promise<void>;

/** The run's process's side: `take` for the live view's takeOver, `handoff` for pi-browser's HandoffPort. `gates` is the
 *  live view's registry (pi-browser's driving gates); `personTime` holds the person's time under the cap
 *  (browser-cost.ts); `note` commits a root entry, which reaches the run's timeline. Every ask and every answer is an
 *  entry of the run's journal, read back through `asks` and `answered`. */
export function personHands(options: {
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
  /** Every ask the run's journal holds: its waiting hand-over entries (each the ask's one record, committed through
   *  `note`), as asks. */
  asks(): Promise<readonly PendingAsk[]>;
  /** Ask `id`'s answer as the run's journal has it (its first answered hand-over entry), or undefined: the person's (a
   *  browser_hand_back row the runner applies), and those this process writes (the live view's hand-back, the ask's
   *  expiry at the expiry's time, its end at the cap). */
  answered(id: string): Promise<Answer | undefined>;
  /** Writes ask `id`'s answer (the hand-over entry `data`) unless the run's journal has one, read and written in one
   *  commit (runner/hand-back.ts answerOnce), and gives back the answer that stands, so an ask has exactly one answered
   *  entry whoever writes it (a person's hand-back row the runner applies, this process's give or expiry). Without it,
   *  the answer is written through `note` after a read. */
  answer?(id: string, data: Record<string, string>): Promise<Answer>;
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
  /** Each ask as the journal has it (its waiting entry), once read or made here: an ask never changes. */
  const known = new Map<string, PendingAsk>();
  /** The asks the journal holds, read into `known`; a read that fails leaves what is known. */
  const readAsks = async (): Promise<void> => {
    for (const ask of await options.asks().catch(() => [] as readonly PendingAsk[])) if (ID.test(ask.id) && TAG.test(ask.tag)) known.set(ask.id, ask);
  };
  /** Ask `id` as the journal has it, read when it is not known yet. */
  const recall = async (id: string): Promise<PendingAsk | undefined> => {
    if (!known.has(id)) await readAsks();
    return known.get(id);
  };
  /** Each ask's answer as the journal has it, once read: an answer never changes. */
  const fromJournal = new Map<string, Answer>();
  /** The answer this process is writing for an ask, if any: a read waits for it. */
  const writing = new Map<string, Promise<void>>();
  /** Ask `id`'s answer from the journal, read through. */
  const journalRead = async (id: string): Promise<Answer | undefined> => {
    const had = fromJournal.get(id);
    if (had) return had;
    const found = await options.answered(id).catch(() => undefined);
    if (found) fromJournal.set(id, found);
    return found;
  };
  /** The live view's hand-backs still finding the ask they answer (givenDone): a read of an answer waits for them, so the
   *  agent's wait hears the hand-back as soon as the person gave it. */
  const giving = new Set<Promise<unknown>>();
  /** Ask `id`'s answer from the journal, once any this process is writing is in. */
  const readJournal = async (id: string): Promise<Answer | undefined> => {
    await Promise.all([...giving]);
    await writing.get(id);
    return journalRead(id);
  };
  /** Ask `id` answered `outcome` at `at` in the journal, unless it has an answer there (the first is its answer). A write
   *  the journal refused leaves the answer this process gave, so the agent's wait still ends. */
  const answerInJournal = (id: string, tag: string, outcome: AskOutcome, at: string, reason?: string): Promise<void> => {
    const write = (writing.get(id) ?? Promise.resolve()).then(async () => {
      if (await journalRead(id)) return;
      const data = { state: outcome, id, session: tag, at, ...(reason !== undefined ? { reason } : {}) };
      if (options.answer) {
        // Read and written in one commit: an answer another writer committed since the read above stands, never a second.
        const stood = await options.answer(id, data).catch(() => undefined);
        fromJournal.set(id, stood ?? { outcome, at, ...(reason !== undefined ? { reason } : {}) });
        return;
      }
      await note("agent.handover", data);
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
  /** The runs' waits in their claim on the person's answer (wait), by user: the sessions each keeps open, and its lapse. */
  const waits = new Map<string, { tags: ReadonlySet<string>; lapse(words: string): void }>();
  /** The sessions let go (sessionEnded), by tag: a wait whose hold was being admitted as one went still sees it. */
  const ended = new Set<string>();
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
      // A wait on the person's answer ends too: the run parks on its question, its browser let go.
      for (const user of [...ledger.users]) if (user.startsWith("wait:")) waits.get(user)?.lapse(hold.refused);
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
    if (settled.has(id)) return;
    capped.set(id, words);
    // The end is the journal's answer, now, unless the ask has one there already.
    const tag = open.get(id)?.tag ?? known.get(id)?.tag;
    if (tag) void answerInJournal(id, tag, "expired", new Date(now()).toISOString(), words).then(() => settle(id), () => undefined);
  };

  /** Session `tag`'s newest ask still waiting (unanswered, unexpired), as the journal has it, answered done: the person
   *  handed that session's browser back. Its hold goes with it (settle), and another session's ask is never touched. True
   *  when an ask was answered here, whose row (settle's) says the hand-back. */
  const givenDone = async (tag: string): Promise<boolean> => {
    await readAsks();
    const newest = [...known.values()].filter((ask) => ask.tag === tag).sort((a, b) => Date.parse(b.asked_at) - Date.parse(a.asked_at) || b.id.localeCompare(a.id));
    for (const ask of newest) {
      await writing.get(ask.id);
      if (settled.has(ask.id) || Date.parse(ask.expires_at) <= Date.now() || (await journalRead(ask.id))) continue;
      // Written as the journal's answer, now, unless the ask has one there already (a person's answer that came first
      // writes its own row, settle's, as this one would).
      await answerInJournal(ask.id, tag, "done", new Date(now()).toISOString()).then(() => settle(ask.id), () => undefined);
      return true;
    }
    return false;
  };

  /** Ask `id` as the run's journal has it (read into `known` first), taken up by this process: one an earlier process of the
   *  run made, whose wait this process resumes (pi-browser polls `outcome` again, or reruns `request`). Its time is no
   *  longer held (that process is gone, and its holds with it). Undefined when the journal holds no such ask. */
  const adopt = (id: string): { tag: string; expiresAt: number; drop(): void } | undefined => {
    const taken = open.get(id);
    if (taken) return taken;
    const kept = known.get(id);
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

  /** Ask `id`'s answer, once there is one (the person's, or `expired` once it is due, written here): its hold dropped, any
   *  take-over of its session ended, and its row written, once. An ask this process did not make is taken up first. */
  const settle = (id: string): AskOutcome | undefined => {
    const known = settled.get(id);
    if (known) return known;
    const ask = adopt(id);
    if (!ask) return undefined;
    // The answer is the journal's, as last read (refresh writes a lapsed ask's expiry there first).
    const written = fromJournal.get(id);
    const answered = written?.outcome;
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
  /** Before settle reads ask `id`: its answer read from the journal, or, once it lapsed with none, its expiry written there
   *  at the expiry's time (the first answer stands, whoever's it is). */
  const refresh = async (id: string): Promise<void> => {
    if (settled.has(id) || (await readJournal(id))) return;
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
    async take(tag: string): Promise<{ refused: string } | { end(why: HoldEnd): Promise<void>; started(): void; cancel(): void }> {
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
        end: (why): Promise<void> => {
          if (ended) return Promise.resolve();
          ended = true;
          const words = ledgers.get(tag)?.refused;
          release(tag, TAKE_USER);
          // Ended before it went live (the agent's call still running): the person never had the browser, and no row says
          // they took it, so none says how it came back. An answered ask writes its own row.
          if (!live) return Promise.resolve();
          // Handed back by the person (the viewer's Hand back): their word that they are done, so the agent's open ask on
          // this session is answered done, as the hand-back route would answer it (first answer wins). Never on any other
          // end (cap, idle, away, released, answered): the person did not say they were done. The answer's own row
          // ("You handed the browser back", settle's) is then the hand-back's one row: none is written here as well.
          const at = now();
          if (why === "cap") return note(HOST_PHASE, { summary: `${CAPPED}${words ? `: ${words}` : ""}`, at });
          if (why === "answered") return Promise.resolve();
          if (why !== "given") return note(HOST_PHASE, { summary: TAKE_ENDED[why], at });
          // The session's open ask is read from the run's journal first; settled once the hand-back's row is written.
          const given = givenDone(tag).then((answeredAsk) => (answeredAsk ? undefined : note(HOST_PHASE, { summary: TAKE_ENDED.given, at })), () => undefined);
          giving.add(given);
          void given.finally(() => giving.delete(given));
          return given;
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
        // An ask an earlier process of this run made (its waiting entry is in the journal): waited on again, its time no
        // longer held (that process is gone).
        if ((await recall(id)) && adopt(id)) return { interactionId: id };
        // A take-over of the same session holds the person's time already: the ask shares it.
        const user = `ask:${id}`;
        const refused = await acquire(ask.sessionTag, user, "handing the browser to you", true, now() + holdMs);
        if (refused) return refused;
        const hold = { drop: () => release(ask.sessionTag, user) };
        const at = Date.now();
        // Redacted whole, then cut to their bound: a held value the cut would split never leaves its head in the record.
        const shown = (text: string) => (options.redact ? options.redact(text) : text).slice(0, MAX_TEXT);
        const record: PendingAsk = { id, tag: ask.sessionTag, instruction: shown(ask.instruction), completion_condition: shown(ask.completionCondition), asked_at: new Date(at).toISOString(), expires_at: new Date(at + holdMs).toISOString() };
        open.set(id, { tag: ask.sessionTag, expiresAt: at + holdMs, drop: () => hold.drop() });
        watch();
        // The ask's waiting entry is its one record and its row: its commit is what shows the person the ask and makes the
        // server read the run's status again. One that cannot be written fails the request, plainly, and leaves nothing
        // behind (its hold, its open entry), so the agent's next request makes it afresh.
        try {
          await options.note("agent.handover", waitingEntry(record));
        } catch {
          if (open.get(id)?.drop) open.get(id)!.drop();
          open.delete(id);
          if (!open.size && poll) (clearInterval(poll), (poll = undefined));
          return { refused: "the hand-over could not be shown to the person (its request was not written to the run's timeline): nothing is held for it, and it can be asked again" };
        }
        known.set(id, record);
        return { interactionId: id };
      },
      async outcome(interactionId: string): Promise<"pending" | AskOutcome | { outcome: AskOutcome; reason: string }> {
        // An id of no shape this build makes (an earlier build's, named by the request id alone) names no ask here: gone, so
        // the agent's wait ends (it may ask again), never polled forever or matched to another session's record.
        if (!ID.test(interactionId)) return "expired";
        await recall(interactionId);
        await refresh(interactionId);
        const answered = settle(interactionId) || "pending";
        // Ended at the cap: the agent is told so, in the cap's words.
        const words = capped.get(interactionId);
        return answered === "expired" && words !== undefined ? { outcome: answered, reason: words } : answered;
      },
    },
    /** The run waits in its claim on the person's answer to its question (ask_person call `callId`, runner/adapter-loop.ts
     *  waitInClaim) with its browser sessions `tags` kept open: the person's time on each is held under the cap as a
     *  hand-over's is (acquire: one hold per session, shared with a take-over or an ask on it, this wait's share
     *  `wait:<callId>`, held through the wait's bound; the time used carried to the session's next charge when the last
     *  share goes). Bounded as a hand-over's ask is: holdMs from `since` (PERSON_HOLD_MS; `since` is when the wait first
     *  started, so a later claim's wait keeps the first one's bound; refused at once past it), past which it lapses, the run parks
     *  and its release lets the browser go, booking its time to then. `pauses: false`: a refusal pauses nothing, the run
     *  parks on its question as it would with no browser. Refused in the cap's words when there is no room. `lapsed`
     *  settles, in words, at the bound, when the cap refuses a re-hold (a take-over's sharing the session), or when a
     *  session it keeps is let go (sessionEnded); drop() lets the shares go, once. */
    async wait(callId: string, tags: readonly string[], since: number = now()): Promise<{ refused: string } | { lapsed: Promise<string>; drop(): void }> {
      const user = `wait:${callId}`;
      const held: string[] = [];
      let bound: unknown;
      const letGo = () => {
        if (bound !== undefined) timers.clear(bound);
        bound = undefined;
        for (const tag of held.splice(0)) release(tag, user);
      };
      const expiresAt = since + holdMs;
      if (expiresAt <= now()) return { refused: waitExpired(holdMs) };
      for (const tag of new Set(tags)) {
        const refused = await acquire(tag, user, WAIT_WHAT, false, expiresAt);
        if (refused) {
          letGo();
          return refused;
        }
        held.push(tag);
      }
      let lapse: (words: string) => void = () => {};
      const lapsed = new Promise<string>((resolve) => (lapse = resolve));
      const entry = { tags: new Set(held), lapse };
      waits.set(user, entry);
      bound = timers.set(() => lapse(waitExpired(holdMs)), Math.max(0, expiresAt - now()));
      // A session let go while its hold was being admitted: told before this wait was there to hear it.
      if (held.some((tag) => ended.has(tag))) lapse(WAIT_SESSION_GONE);
      return {
        lapsed,
        drop: () => {
          if (waits.get(user) === entry) waits.delete(user);
          letGo();
        },
      };
    },
    /** Session `tag` was let go (its release, whatever made it): a wait that kept it open for the person lapses. */
    sessionEnded(tag: string): void {
      ended.add(tag);
      for (const wait of [...waits.values()]) if (wait.tags.has(tag)) wait.lapse(WAIT_SESSION_GONE);
    },
    /** The run's process lets go: its holds dropped, its poll stopped. */
    close(): void {
      closed = true;
      waits.clear();
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
