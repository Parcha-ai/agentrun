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
// `outcome`; a poll here ends any take-over at once and drops the hold. The records go when the run's process does.
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
  try {
    const newest = asksIn(runDir).find(({ answer }) => !answer);
    return newest && Date.parse(newest.ask.expires_at) > now ? newest.ask : undefined;
  } catch {
    return undefined;
  }
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
type HoldEnd = "given" | "answered" | "idle" | "away" | "released";
/** The rows a person's turns leave, beside the waiting row an ask writes. */
const TAKEN = "You took over the browser";
const GIVEN_BACK = "You handed the browser back";
const TAKE_ENDED: Record<Exclude<HoldEnd, "answered">, string> = {
  given: GIVEN_BACK,
  idle: "The browser went back to the agent: no input came from you for a while",
  away: "The browser went back to the agent: the live view was closed",
  released: "The browser's session ended while you had it",
};
const ASK_ENDED: Record<AskOutcome, string> = { done: GIVEN_BACK, cancelled: "You cancelled the agent's hand-over", expired: "The agent's hand-over expired before you answered it" };

/** A root entry of the run's: a timeline row's source. */
type Note = (kind: string, data: Record<string, string>) => Promise<void>;

/** The run's process's side, for the run at `root`: `take` for the live view's takeOver, `handoff` for pi-browser's
 *  HandoffPort. `gates` is the live view's registry (pi-browser's driving gates); `personTime` holds the person's time
 *  under the cap (browser-cost.ts); `note` commits a root entry, which reaches the run's timeline. */
export function personHands(options: {
  root: string;
  gates: (tag: string) => { give(why: "answered"): boolean };
  personTime(what: string, seconds: number): Promise<{ refused: string } | { drop(): void }>;
  note: Note;
  holdMs?: number;
  pollMs?: number;
}) {
  const holdMs = options.holdMs ?? PERSON_HOLD_MS;
  const open = new Map<string, { tag: string; expiresAt: number; drop(): void }>();
  const settled = new Map<string, AskOutcome>();
  let poll: NodeJS.Timeout | undefined;
  const note = (kind: string, data: Record<string, string>): Promise<void> => options.note(kind, data).catch(() => undefined);

  /** Ask `id`'s answer, once there is one (the person's, or `expired` once it is due, written here): its hold dropped, any
   *  take-over of its session ended, and its row written, once. */
  const settle = (id: string): AskOutcome | undefined => {
    const known = settled.get(id);
    if (known) return known;
    const ask = open.get(id);
    const dir = askDir(options.root);
    if (!ask || !dir) return undefined;
    const answered = answerOf(readOwn(dir, `${id}.answer.json`))?.outcome ?? (Date.now() >= ask.expiresAt ? answerOnce(dir, id, "expired") : undefined);
    if (!answered) return undefined;
    settled.set(id, answered);
    open.delete(id);
    ask.drop();
    options.gates(ask.tag).give("answered");
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
      const shared = [...open.values()].some((ask) => ask.tag === tag);
      const hold = shared ? { drop() {} } : await options.personTime("taking over the browser", holdMs / 1000);
      if ("refused" in hold) return hold;
      void note(HOST_PHASE, { summary: TAKEN });
      let ended = false;
      return {
        end: (why) => {
          if (ended) return;
          ended = true;
          hold.drop();
          // An answered ask writes its own row.
          if (why !== "answered") void note(HOST_PHASE, { summary: TAKE_ENDED[why] });
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
        const kept = pendingOf(readOwn(dir, `${id}.json`), id);
        if (kept) {
          open.set(id, { tag: kept.tag, expiresAt: Date.parse(kept.expires_at), drop() {} });
          watch();
          return { interactionId: id };
        }
        if (!TAG.test(ask.sessionTag)) return { refused: "the session's tag is not one this server takes" };
        const hold = await options.personTime("handing the browser to you", holdMs / 1000);
        if ("refused" in hold) return { refused: hold.refused };
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
    },
  };
}

/** The two windows of a person's time for a run's process with environment `env`: the defaults, or under `--faux` the
 *  tests' (FAUX_PERSON_MS_ENV). */
export function personWindows(env: NodeJS.ProcessEnv, faux: boolean): { holdMs: number; awayMs: number } {
  const [hold, away] = (faux ? env[FAUX_PERSON_MS_ENV] ?? "" : "").split(",").map(Number);
  return { holdMs: hold && hold > 0 ? hold : PERSON_HOLD_MS, awayMs: away && away > 0 ? away : PERSON_AWAY_MS };
}
