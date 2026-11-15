// The run's one booking. A run's model requests are booked per session (modelPortFor: each CLI session key, and pi's own
// once it is an adapter), but a cap is the run's: a session is judged on what every session of the run has spent and
// holds, never on its own alone. runBooking wraps the host's beforeRequest (the cap's beforeRequestOf) so that each
// request it is asked about carries the run's totals:
// - `spentUsd`: every session's spend from its runner records (sessionSpendOf), summed: what was booked, and a request
//   recorded and never answered that no booking here admitted (a lost claim's, cut) at what its host held for it. A
//   request this booking admitted and still in flight is no spend: it is held (below), never read as spent;
// - `inFlight`: the requests this booking admitted that no record shows answered yet, each at what it was held at, so two
//   sessions asking at once never both take room only one of them fits. A hold-only step is marked `stays` (no request
//   waits on it), and so is one admitted RECORD_WAIT_MS ago that no record shows at all (its write refused: a phantom);
// - what was spent beside its sessions on the run's behalf (`sessions.beside`: a run's learning, graded by runs of its
//   own), read with them at each admission and added to `spentUsd`, so a run and what it pays for elsewhere never pass
//   its cap together. Unknown (null) makes the run's spend unknown.
// - `freeRequestsMade`: the run's requests on free models so far (each runner.request marked `freeRequest`, and each
//   admitted here not yet recorded), which the cap's ceiling on such requests reads (runCap, free.ts).
// Admissions run one at a time across the run's sessions. The priced tools' charges and holds are not here: they are the
// host's spentUsd and heldUsd hooks (beforeRequestOf), read beside these.
//
// Waiting for room. A refusal that `waits` (the cap's: the request fits beside the run's spend, only not beside the holds
// of steps in flight that settle on their own) is not handed on: the request waits in the run's line, first come first
// served, and is asked again once a step it waited on has settled (each settle books the step at what it cost, at most its
// hold, so the room comes back). Only the line's first asks; a step that comes while others wait goes to the line's end,
// so a small one never takes the room an earlier one waits for. Model requests, decisions and paid tool calls (a web
// fetch's, a search's) wait alike: a tool call runs once the request that asked for it has answered, so it never waits on
// a hold its own wait keeps from settling.
// - The hold ledger is the run's records (every session's runner.request and runner.turn), which every process of the run
//   writes: a waiter reads them again on a short timer, from WAIT_POLL_FIRST_MS doubling to WAIT_POLL_MOST_MS, so a step
//   that settles in this process or any other wakes it the same way. No process signals another.
// - No deadlock: a waiter holds nothing while it waits (nothing is admitted, recorded or held for it), and it waits only on
//   steps that end by themselves (a request streaming, a decision, a paid call), never on a hold-only step or on a lost
//   claim's request. A waiter whose steps stop settling for WAIT_STALL_MS is refused after all, in the words it waited
//   under: the run parks for a raise, as before waiting existed.
// - A waiter leaves the line, admitted for nothing and holding nothing, when its client goes (its signal: a stop, a
//   cancel, a lost claim), when the run stops (`stopped`, for a paid call or a decision too), when its booking stops (`halted`: thrown, as a stop that came during the check), or when the
//   run parks meanwhile (`parked`: refused in its own words, so nothing more is sent until a raise).
import { type BeforeRequest, type InFlight, RUNNER_RECORDS, sessionSpendOf } from "./runner.js";
import type { SessionRecord } from "./types.js";

/** The run's sessions: every key it has, and each one's records. */
export interface RunSessions {
  keys(): readonly string[] | Promise<readonly string[]>;
  read(key: string): Promise<SessionRecord[]>;
  /** What was spent on the run's behalf outside its sessions, as the host reads it at each admission (what ended at its
   *  cost, what is under way at the most it may take); null: unknown. None: nothing is. */
  beside?(): Promise<number | null>;
}

export interface RunBookingOptions {
  /** Whether the run has parked (a step refused for room it could not wait for, a paid call's refusal): a request waiting
   *  for room leaves the line refused in its own words, so nothing more is sent until a raise. */
  parked?(): boolean;
  /** How long a waiter waits with none of the steps it waits on settling before it is refused (default WAIT_STALL_MS). */
  stallMs?: number;
  /** The run's stop (a stop, a cancel, a lost claim): every waiter leaves the line at it, admitted for nothing. */
  stopped?: AbortSignal;
}

/** How soon a waiter reads the run's records again, first and at the slowest (it doubles between them). */
export const WAIT_POLL_FIRST_MS = 50;
export const WAIT_POLL_MOST_MS = 1_000;
/** How long a request waits for room with none of the steps it waits on settling: past it, it is refused for room and the
 *  run parks (a step that never settles, which nothing here expects, never hangs the run). */
export const WAIT_STALL_MS = 10 * 60_000;
/** How long an admission may go unrecorded before no one waits on it: its record is written just after its admission,
 *  so one missing this long never will be (its write refused, its booking stopped). It is still held, never freed. */
export const RECORD_WAIT_MS = 30_000;

const idOf = (key: string, turn: number) => `${key}\u0000${turn}`;

/** The error a waiter leaves with when its client goes. */
const gone = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error("the request's client went while it waited for room under the run's cap"));

/** A request in the line, and how to cut its wait short (the line's first left, its signal aborted). */
type Place = { wake?: () => void };

/** `before`, asked about each request with the run's totals over `sessions` in place of its session's own; a refusal that
 *  waits is asked again once the room may be there (above). */
export function runBooking(sessions: RunSessions, before: BeforeRequest, options: RunBookingOptions = {}): BeforeRequest {
  /** Admitted here and not yet answered, by session and turn, with when. One whose record never lands (its write refused,
   *  its process gone) stays held: the run's spend is never under-counted. */
  const admitted = new Map<string, InFlight & { at: number }>();
  let queue: Promise<unknown> = Promise.resolve();
  /** The requests waiting for room, in the order they came: only the first asks. */
  const line: Place[] = [];
  const stallMs = options.stallMs ?? WAIT_STALL_MS;

  /** One admission, in turn with every other: `before`'s verdict on `request` over the run's totals now, and the steps in
   *  flight it was judged beside that settle on their own (what a refusal that waits waits on). */
  const ask = (request: Parameters<BeforeRequest>[0]) => {
    const asked = queue.then(async () => {
      let spentUsd: number | null = 0;
      // The run's requests on free models so far, each counted once: every one whose runner.request says so, answered, in
      // flight or cut, in any session and any process, and below, each admitted here not yet recorded.
      let freeRequestsMade = 0;
      const recorded = new Set<string>();
      const answered = new Set<string>();
      for (const key of await sessions.keys()) {
        const records = await sessions.read(key);
        const spend = sessionSpendOf(records);
        for (const r of records) if (r.kind === RUNNER_RECORDS.request && (r.data as { freeRequest?: unknown } | undefined)?.freeRequest === true) freeRequestsMade += 1;
        for (const turn of spend.turns) recorded.add(idOf(key, turn));
        for (const turn of spend.answered) answered.add(idOf(key, turn));
        // Each request's figure (sessionSpendOf's), but one this booking admitted and has not seen answered: that one is
        // held, in flight below, never spent. A hold-only step still open is no figure there: held below too.
        let own: number | null = 0;
        for (const { turn, usd } of spend.figures) {
          if (!spend.answered.has(turn) && admitted.has(idOf(key, turn))) continue;
          own = own === null || usd === null ? null : own + usd;
        }
        spentUsd = spentUsd === null || own === null ? null : spentUsd + own;
      }
      if (sessions.beside) {
        const beside = await sessions.beside();
        spentUsd = spentUsd === null || beside === null || !Number.isFinite(beside) ? null : spentUsd + beside;
      }
      for (const id of [...admitted.keys()]) if (answered.has(id)) admitted.delete(id);
      const now = Date.now();
      const settling = new Set<string>();
      const inFlight: InFlight[] = [];
      for (const [id, { at, ...flight }] of admitted) {
        if (flight.freeRequest && !recorded.has(id)) freeRequestsMade += 1;
        // One that may never settle by itself (a hold-only step, an admission whose record never landed) stays: held, and
        // never waited on.
        const stays = flight.stays === true || (!recorded.has(id) && now - at > RECORD_WAIT_MS);
        if (!stays) settling.add(id);
        inFlight.push(stays ? { ...flight, stays: true } : flight);
      }
      const verdict = await before({ ...request, spentUsd, inFlight, freeRequestsMade });
      if (!(verdict && "refuse" in verdict)) {
        const holdUsd = verdict && "holdUsd" in verdict ? verdict.holdUsd : undefined;
        const freeRequest = !!verdict && "freeRequest" in verdict && verdict.freeRequest === true;
        const outputTokensMax = verdict && "outputTokensMax" in verdict ? verdict.outputTokensMax : request.outputTokensAsked;
        admitted.set(idOf(request.key, request.turn), {
          at: Date.now(),
          turn: request.turn,
          model: request.model,
          ...(request.inputTokensMax === undefined ? {} : { inputTokensMax: request.inputTokensMax }),
          ...(outputTokensMax === undefined ? {} : { outputTokensMax }),
          ...(typeof holdUsd === "number" ? { holdUsd } : {}),
          ...(request.host === undefined ? {} : { host: request.host }),
          ...(request.route === undefined ? {} : { route: request.route }),
          ...(freeRequest ? { freeRequest: true as const } : {}),
          ...(request.paid?.hold ? { stays: true as const } : {}),
        });
      }
      return { verdict, settling };
    });
    queue = asked.catch(() => undefined);
    return asked;
  };

  /** Waits `ms`, or less: until the line's first leaves (`place.wake`) or the request's client goes. */
  const nap = (place: Place, ms: number, signal: AbortSignal | undefined) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        if (place.wake === done) place.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      place.wake = done;
      signal?.addEventListener("abort", done, { once: true });
    });
  /** Leaves the line; the next one asks at once (the room the first waited for may fit it too). */
  const leave = (place: Place) => {
    const at = line.indexOf(place);
    if (at < 0) return;
    line.splice(at, 1);
    if (at === 0) line[0]?.wake?.();
  };
  /** Why a waiter leaves now, if it does: its client went, the run stopped or its booking did (thrown), or the run parked
   *  (refused). */
  const leaving = (request: Parameters<BeforeRequest>[0], signal: AbortSignal | undefined): "parked" | undefined => {
    if (signal?.aborted) throw gone(signal);
    const halted = request.halted?.();
    if (halted) throw halted;
    return options.parked?.() ? "parked" : undefined;
  };
  /** A refusal as handed on: one that waits is the plain refusal it is to anyone not waiting. */
  const plain = (verdict: Awaited<ReturnType<BeforeRequest>>) => {
    if (!(verdict && "refuse" in verdict && verdict.waits)) return verdict;
    const { waits: _waits, ...refusal } = verdict;
    return refusal;
  };

  return async (request) => {
    // What ends its wait: its own client's going (a model request's), or the run's stop (any step's: a paid call's or a
    // decision's has no client of its own here).
    const signal = request.signal && options.stopped ? AbortSignal.any([request.signal, options.stopped]) : (request.signal ?? options.stopped);
    let place: Place | undefined;
    try {
      // Others already wait: this one goes to the line's end, and asks once it is first.
      if (line.length > 0) {
        place = {};
        line.push(place);
        let pause = WAIT_POLL_FIRST_MS;
        while (line[0] !== place) {
          // Not first yet: it has no verdict of its own to be refused in, so a park reaches it as its first ask does.
          await nap(place, pause, signal);
          if (signal?.aborted) throw gone(signal);
          const halted = request.halted?.();
          if (halted) throw halted;
          pause = Math.min(2 * pause, WAIT_POLL_MOST_MS);
        }
      }
      let pause = WAIT_POLL_FIRST_MS;
      let quietSince = Date.now();
      let waitedOn: Set<string> | undefined;
      for (;;) {
        const { verdict, settling } = await ask(request);
        if (!(verdict && "refuse" in verdict && verdict.waits)) return verdict;
        // A step it waited on has settled since it last asked: the wait goes on, from the first pause again.
        if (waitedOn && [...waitedOn].some((id) => !settling.has(id))) {
          quietSince = Date.now();
          pause = WAIT_POLL_FIRST_MS;
        }
        waitedOn = settling;
        if (Date.now() - quietSince >= stallMs) return plain(verdict);
        if (!place) {
          place = {};
          line.push(place);
        }
        // It waits first in line (it asked while none waited, or it was first): only the first asks again.
        do {
          await nap(place, pause, signal);
          if (leaving(request, signal) === "parked") return plain(verdict);
          pause = Math.min(2 * pause, WAIT_POLL_MOST_MS);
        } while (line[0] !== place);
      }
    } finally {
      if (place) leave(place);
    }
  };
}
