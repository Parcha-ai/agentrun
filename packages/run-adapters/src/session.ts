// A harness adapter's session, written for AgentRun: one implementation for every harness. A session is the harness
// driven over the session's own records (the kernel's openDrive on the writer the runner lends, `io.writer`), one turn at
// a time. Each adapter names only what is its own: its harness's drive, and how it hears its harness's events.
//  - Every drive of a session writes through one serialized writer, so a drive opened after an interrupt reads only once
//    the halted drive's last writes are in (host/serial.ts).
//  - A drive whose turn ends in a `Restart` (the harness's process exited mid-turn, or a write the journal refused) is
//    rebuilt from the log and the turn resumes, at most `restarts` times.
//  - A pause (`interrupt` with `drainMs`) sends no new turn, and lets the calls in flight run on until their outcomes are
//    recorded, for at most `drainMs`, before the turn stops. The adapter counts its calls in `calls`.
import { randomUUID } from "node:crypto";
import { serialWriter } from "./host/serial.js";
import { KERNEL_RECORDS, openDrive, pendingSubmissions, Restart, type Drive } from "./kernel/index.js";
import { JOURNAL, journalBatches, journalKey, journalRecords, openTurn, recoveryNote, TRANSCRIPT, type TranscriptEntry, transcriptOf } from "./process/index.js";
import type { AdapterSession, SessionIO, TurnStatus } from "./types.js";

/** A session's calls in flight: begun (their intent recorded), their outcome not yet. A pause waits for these to have
 *  their outcomes recorded; the host refuses new work meanwhile (the runner's stop does). */
export class CallsInFlight {
  draining = false;
  private readonly open = new Set<string>();
  private readonly waiters = new Set<() => void>();
  begin(callId: string) {
    this.open.add(callId);
  }
  /** The call's outcome is recorded, or it never will be (the drive stopped). */
  end(callId: string) {
    if (this.open.delete(callId) && this.open.size === 0) for (const done of [...this.waiters]) done();
  }
  clear() {
    this.open.clear();
    for (const done of [...this.waiters]) done();
  }
  /** Every call in flight has its outcome recorded, or `ms` passed. */
  idle(ms: number): Promise<void> {
    if (this.open.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

export interface AdapterSessionOptions {
  /** The adapter's package name, which the session's messages begin with. */
  name: string;
  io: SessionIO;
  /** One turn of the harness on `drive`. */
  drive(drive: Drive): Promise<void>;
  /** The drive's live events, as the harness emits them. */
  live: (event: unknown) => void;
  /** The calls the adapter's tools have in flight. */
  calls: CallsInFlight;
  /** How many times a turn's drive is rebuilt after a `Restart`. Default 3. */
  restarts?: number;
}

/** What a settled turn's record says ended it. */
const SETTLED = "settled: the turn a crash cut off was ended, not resumed";
/** What a settle records in its turn entry: the submission it withdraws, and how many submissions the session held then,
 *  so a later settle tells a submission it already saw from one that came after it. */
type SettleMark = { opening?: string; seen: number };

/** A settle's one write: the withdraw of `opening`, and the turn's end as the next journal batch, in a single append.
 *  NativeJournal writes a batch as an effect, its intent and its outcome in two appends, and a submission is an append of
 *  its own, so this builds the batch's records itself, in the journal's format, to land the two together. */
async function settleWrite(drive: Drive, opening: string | undefined, entry: TranscriptEntry): Promise<void> {
  const state = drive.state();
  const n = journalBatches(state).length;
  const key = journalKey(n);
  const known = state.effects.get(key);
  const attempt = known ? known.attempt + 1 : 0;
  const stepId = `${key}#${attempt}`;
  const batch = { v: 1, n, streams: { [TRANSCRIPT]: { from: journalRecords(state, TRANSCRIPT).length, entries: [{ data: entry }] } } };
  const at = new Date().toISOString();
  await drive.world.store.append([
    ...(opening ? [{ kind: KERNEL_RECORDS.submission, data: { id: randomUUID(), kind: "withdraw", target: opening, receivedAt: at } }] : []),
    { kind: KERNEL_RECORDS.start, data: { key, stepId, name: JOURNAL, replay: "safe", input: batch, placed: [], attempt, startedAt: at } },
    { kind: KERNEL_RECORDS.end, data: { stepId, status: "completed", output: { n, records: 1, writer: "settle" } } },
  ] as never);
}

const turnsIn = (drive: Drive) => transcriptOf(drive.state()).filter((r) => r.data?.type === "turn");

/** Open the session over `io.writer`: its state from the records, then one turn at a time. */
export async function openAdapterSession(options: AdapterSessionOptions): Promise<AdapterSession> {
  const { name, io, calls } = options;
  const restarts = options.restarts ?? 3;
  const writer = serialWriter(io.writer);
  const open = (attempt = 0) => openDrive({ writer, signal: io.signal, live: options.live, attempt });
  let drive = await open();
  const initial = drive.state();
  let state: AdapterSession["state"] = recoveryNote(initial) || pendingSubmissions(initial).length
    ? "open_turn"
    : initial.submissions.length === 0 && turnsIn(drive).length === 0 ? "new" : "idle";

  let running: Promise<{ status: TurnStatus; error?: string }> | undefined;
  let closed = false;
  const run = () => {
    const before = turnsIn(drive).length;
    state = "idle";
    running = (async () => {
      let outcome: { status: TurnStatus; error?: string } | undefined;
      for (let attempt = 0; !outcome; attempt += 1) {
        const current = drive;
        try {
          await options.drive(current);
          const ended = turnsIn(current).slice(before).at(-1)?.data as { status?: TurnStatus; error?: string } | undefined;
          outcome = ended?.status ? { status: ended.status, ...(ended.error ? { error: ended.error } : {}) } : { status: "failed", error: "the turn ended with no outcome in the session's records" };
        } catch (error) {
          if (current.signal.aborted) outcome = { status: "interrupted" };
          // The harness's process exited mid-turn, or the journal refused a write: the drive is rebuilt from the log and
          // the turn resumes, a few times.
          else if (error instanceof Restart && attempt < restarts) drive = await open(attempt + 1);
          else outcome = { status: "failed", error: String((error as Error)?.message ?? error).slice(0, 500) };
        }
      }
      io.onEvent({ type: "turn_end", status: outcome.status });
      return outcome;
    })();
    return running;
  };
  // A drive that was halted (an interrupt) holds the session no more: the next turn opens a fresh one, on the same
  // writer (the adapter never opens the session itself).
  const ready = async () => {
    if (closed) throw new Error(`${name}: the session is closed`);
    if (running) await running;
    if (drive.signal.aborted && !io.signal.aborted) drive = await open();
  };

  return {
    get state() { return state; },
    async send(text) {
      if (calls.draining) throw new Error(`${name}: the session is pausing; no new turn`);
      await ready();
      await drive.submit({ id: randomUUID(), kind: "prompt", text });
      void run();
    },
    async recover() {
      if (state !== "open_turn") throw new Error(`${name}: there is no turn to recover`);
      await ready();
      void run();
    },
    async settleOpenTurn() {
      if (state !== "open_turn") throw new Error(`${name}: there is no turn to settle`);
      await ready();
      const now = drive.state();
      const cut = openTurn(now);
      let pending = pendingSubmissions(now);
      const mark = (transcriptOf(now).filter((r) => r.data?.type === "turn").at(-1)?.data as { settle?: SettleMark } | undefined)?.settle;
      if (!cut && mark) {
        // The last turn ended in a settle. What came after it opened a turn cut since; what it already saw is the next
        // turn's input, never this settle's to drop.
        const at = new Map(now.submissions.map((s, i) => [s.id, i] as const));
        pending = pending.filter((s) => (at.get(s.id) ?? 0) >= mark.seen);
        if (!pending.length) {
          state = pendingSubmissions(now).length ? "open_turn" : "idle";
          return;
        }
      }
      // Only what opened the cut turn is withdrawn: its prompt, when the turn never placed it (the oldest such pending).
      const [opening] = cut?.placed.length ? [] : pending;
      const settle: SettleMark = { ...(opening ? { opening: opening.id } : {}), seen: now.submissions.length };
      await settleWrite(drive, opening?.id, { type: "turn", status: "interrupted", error: SETTLED, settle } as unknown as TranscriptEntry);
      state = "idle";
      io.onEvent({ type: "turn_end", status: "interrupted" });
    },
    async turnEnd() {
      if (!running) throw new Error(`${name}: no turn is in flight`);
      return running;
    },
    async interrupt(interruptOptions = {}) {
      const drainMs = interruptOptions.drainMs ?? 0;
      if (!Number.isFinite(drainMs) || drainMs < 0) throw new Error(`${name}: drainMs must be a non-negative number of milliseconds`);
      // A pause: no new turn here (the host refuses new calls and requests); the calls in flight run on until their
      // outcomes are recorded.
      calls.draining = true;
      try {
        if (drainMs > 0) await calls.idle(drainMs);
        drive.halt?.(new Error("interrupted"));
        await running?.catch(() => {});
      } finally {
        // Calls the halt cut off have no outcome to wait for; the next turn starts clean.
        calls.clear();
        calls.draining = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      drive.halt?.(new Error("closed"));
      await running?.catch(() => {});
    },
  };
}
