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
// (BROWSER_ASK_DIR/<id>.json, 0600 in 0700: the session's tag, the instruction, the done-when condition, when it was asked
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

export type AskOutcome = "done" | "cancelled" | "expired";
/** An ask's pending record, as the server reads it. */
export type PendingAsk = { id: string; tag: string; instruction: string; completion_condition: string; asked_at: string; expires_at: string };
type Answer = { outcome: AskOutcome; at: string };

const ID = /^[A-Za-z0-9_-]{22}$/;
const TAG = /^[A-Za-z0-9._:-]{1,200}$/;
const OUTCOMES: readonly string[] = ["done", "cancelled", "expired"];
/** What the person sees of an instruction or a condition, at most. */
const MAX_TEXT = 2000;

/** The ask's id: pi-browser's request id is the model's, so the file is named by a digest of it, never by it. */
export const askIdOf = (requestId: string): string => createHash("sha256").update(requestId).digest("base64url").slice(0, 22);

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
  return v && OUTCOMES.includes(String(v.outcome)) && typeof v.at === "string" ? { outcome: v.outcome as AskOutcome, at: v.at } : undefined;
};

/** Every ask the run's directory holds, newest first, each with its answer when it has one. */
function asksIn(runDir: string): Array<{ ask: PendingAsk; answer?: Answer }> {
  if (!existsSync(join(runDir, BROWSER_ASK_DIR))) return [];
  const dir = askDir(runDir);
  if (!dir) return [];
  const found: Array<{ ask: PendingAsk; answer?: Answer }> = [];
  for (const name of readdirSync(dir)) {
    const id = /^([A-Za-z0-9_-]{22})\.json$/.exec(name)?.[1];
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

/** The answer to ask `id`, or the first answer written now: `outcome` unless one is there already. */
function answerOnce(dir: string, id: string, outcome: AskOutcome): AskOutcome {
  if (writeOwn(dir, `${id}.answer.json`, { outcome, at: new Date().toISOString() }, true)) return outcome;
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
  if (Date.parse(target.ask.expires_at) <= now) return { outcome: answerOnce(dir, target.ask.id, "expired"), first: false };
  const answered = answerOnce(dir, target.ask.id, outcome);
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
const ASK_ENDED: Record<AskOutcome, string> = { done: GIVEN_BACK, cancelled: "You cancelled the agent's hand-over", expired: "The agent's hand-over expired before you answered it" };

/** A take-over's share of its session's person time (an ask's is `ask:<id>`). */
const TAKE_USER = "take";
/** A root entry of the run's: a timeline row's source. */
type Note = (kind: string, data: Record<string, string>) => Promise<void>;

/** The run's process's side, for the run at `root`: `take` for the live view's takeOver, `handoff` for pi-browser's
 *  HandoffPort. `gates` is the live view's registry (pi-browser's driving gates); `personTime` holds the person's time
 *  under the cap (browser-cost.ts); `note` commits a root entry, which reaches the run's timeline. */
export function personHands(options: {
  root: string;
  gates: (tag: string) => { give?(why: "answered" | "cap", message?: string): boolean };
  personTime(what: string, seconds: number): Promise<{ refused: string } | { drop(): void }>;
  note: Note;
  holdMs?: number;
  pollMs?: number;
  /** For tests: the timer functions the person's time is held again by. */
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** For tests: the clock the person's time is measured by. */
  now?: () => number;
  /** The person's time on a session that just ended, `seconds` of it, to hold until a charge books it (browser-cost.ts
   *  carry): the up-front holds go as it ends, the time it took stays counted. */
  carry?(tag: string, seconds: number): void;
}) {
  const holdMs = options.holdMs ?? PERSON_HOLD_MS;
  const timers = options.timers ?? { set: (run: () => void, ms: number) => setTimeout(run, ms).unref(), clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
  const open = new Map<string, { tag: string; expiresAt: number; drop(): void }>();
  const settled = new Map<string, AskOutcome>();
  let poll: NodeJS.Timeout | undefined;
  const note = (kind: string, data: Record<string, string>): Promise<void> => options.note(kind, data).catch(() => undefined);

  /** The person's time on each session, held once under the cap for everyone who needs it there (a take-over, an ask), and
   *  dropped when the last of them is over: a take then an ask, or an ask then a take, holds it once. `ready` settles when
   *  the first hold is taken, or refused. While anyone needs it, it is held again each holdMs (a take-over kept alive by
   *  input has no end of its own): with no room, a take-over gives the browser back (`cap`, in the cap's words). */
  type Ledger = { holds: Array<{ drop(): void }>; users: Set<string>; ready: Promise<{ refused: string } | undefined>; timer?: unknown; refused?: string; since: number };
  const now = options.now ?? Date.now;
  const ledgers = new Map<string, Ledger>();
  /** `user`'s share of session `tag`'s person time: held now when nobody holds it (`what` names it in the cap's words). */
  const acquire = async (tag: string, user: string, what: string): Promise<{ refused: string } | undefined> => {
    for (;;) {
      const known = ledgers.get(tag);
      if (known) {
        // The first hold refused (or failed): the ledger is gone, and this one asks the cap for itself, in its own words.
        const first = await known.ready.catch(() => ({ refused: "the person's time could not be held" }));
        if (first || ledgers.get(tag) !== known) continue;
        // The cap refused to hold more of the person's time here: whoever comes now (a take-over, a new ask) needs more of
        // it, so asks the cap itself, in its own words; with room again, it holds the next stretch and the holding goes on.
        if (known.refused) {
          const hold = await options.personTime(what, holdMs / 1000).catch(() => ({ refused: "the person's time could not be held" }));
          if ("refused" in hold) return { refused: hold.refused };
          if (ledgers.get(tag) !== known) {
            hold.drop();
            continue;
          }
          known.holds.push(hold);
          known.refused = undefined;
          if (known.timer !== undefined) timers.clear(known.timer);
          again(tag, known);
        }
        known.users.add(user);
        return undefined;
      }
      const ledger: Ledger = { holds: [], users: new Set([user]), ready: Promise.resolve(undefined), since: now() };
      ledger.ready = options.personTime(what, holdMs / 1000).then(
        (hold) => {
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
    ledger.timer = timers.set(() => void (async () => {
      if (ledgers.get(tag) !== ledger) return;
      const hold = await options.personTime("more of your time in the browser", holdMs / 1000).catch(() => ({ refused: "the person's time could not be held" }));
      if (ledgers.get(tag) !== ledger) return void ("refused" in hold || hold.drop());
      if (!("refused" in hold)) {
        ledger.holds.push(hold);
        again(tag, ledger);
        return;
      }
      // No room: a take-over ends here. An ask needs no more (it expires within the time already held for it).
      ledger.refused = hold.refused;
      if (ledger.users.has(TAKE_USER)) options.gates(tag).give?.("cap", hold.refused);
    })(), holdMs);
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
    // room it still waits, unheld, until its own expiry (within the hold's window of its asking): the person may be partway
    // through it, and that time is spent at the vendor either way. A take-over of the session asks the cap itself.
    const user = `ask:${id}`;
    void acquire(kept.tag, user, "handing the browser to you").then((refused) => {
      if (refused) return;
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
    const dir = askDir(options.root);
    if (!ask || !dir) return undefined;
    const answered = answerOf(readOwn(dir, `${id}.answer.json`))?.outcome ?? (Date.now() >= ask.expiresAt ? answerOnce(dir, id, "expired") : undefined);
    if (!answered) return undefined;
    settled.set(id, answered);
    open.delete(id);
    ask.drop();
    options.gates(ask.tag).give?.("answered");
    void note(HOST_PHASE, { summary: ASK_ENDED[answered] });
    if (!open.size && poll) (clearInterval(poll), (poll = undefined));
    return answered;
  };
  const watch = () => {
    poll ??= setInterval(() => { for (const id of [...open.keys()]) settle(id); }, options.pollMs ?? 500);
    poll.unref();
  };

  return {
    /** The live view's take: the person's time held, unless an ask open on the same session holds it already (its answer
     *  ends the take); refused in the cap's words when there is no room. */
    async take(tag: string): Promise<{ refused: string } | { end(why: HoldEnd): void }> {
      const refused = await acquire(tag, TAKE_USER, "taking over the browser");
      if (refused) return refused;
      void note(HOST_PHASE, { summary: TAKEN });
      let ended = false;
      return {
        end: (why) => {
          if (ended) return;
          ended = true;
          const words = ledgers.get(tag)?.refused;
          release(tag, TAKE_USER);
          // An answered ask writes its own row.
          if (why === "cap") void note(HOST_PHASE, { summary: `${CAPPED}${words ? `: ${words}` : ""}` });
          else if (why !== "answered") void note(HOST_PHASE, { summary: TAKE_ENDED[why] });
        },
      };
    },
    /** pi-browser's HandoffPort. Idempotent by request id: a rerun finds its ask's record. The live view's link it is handed
     *  is never kept. */
    handoff: {
      async request(ask: { requestId: string; sessionTag: string; instruction: string; completionCondition: string }): Promise<{ interactionId: string } | { refused: string }> {
        const id = askIdOf(ask.requestId);
        if (settled.has(id) || open.has(id)) return { interactionId: id };
        const dir = askDir(options.root, true);
        if (!dir) return { refused: "the run's directory for a hand-over is not this server's alone" };
        // An ask an earlier process of this run made: waited on again, its time no longer held (that process is gone).
        if (adopt(id)) return { interactionId: id };
        if (!TAG.test(ask.sessionTag)) return { refused: "the session's tag is not one this server takes" };
        // A take-over of the same session holds the person's time already: the ask shares it.
        const user = `ask:${id}`;
        const refused = await acquire(ask.sessionTag, user, "handing the browser to you");
        if (refused) return refused;
        const hold = { drop: () => release(ask.sessionTag, user) };
        const at = Date.now();
        const record: PendingAsk = { id, tag: ask.sessionTag, instruction: ask.instruction.slice(0, MAX_TEXT), completion_condition: ask.completionCondition.slice(0, MAX_TEXT), asked_at: new Date(at).toISOString(), expires_at: new Date(at + holdMs).toISOString() };
        try {
          writeOwn(dir, `${id}.json`, record, false);
        } catch (error) {
          hold.drop();
          throw error;
        }
        open.set(id, { tag: ask.sessionTag, expiresAt: at + holdMs, drop: () => hold.drop() });
        watch();
        // The record is in place before the row: the row's commit is what makes the server read the run's status again.
        await note("agent.handover", { state: "waiting", reason: record.instruction, session: ask.sessionTag });
        return { interactionId: id };
      },
      async outcome(interactionId: string): Promise<"pending" | AskOutcome> {
        return (ID.test(interactionId) && settle(interactionId)) || "pending";
      },
    },
    /** The run's process lets go: its holds dropped, its poll stopped. */
    close(): void {
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
