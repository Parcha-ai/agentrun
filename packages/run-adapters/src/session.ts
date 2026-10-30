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
import { SubmissionExists } from "./errors.js";
import { serialWriter } from "./host/serial.js";
import { openDrive, pendingSubmissions, Restart, type Drive } from "./kernel/index.js";
import { nextJournalBatch, openTurn, recoveryNote, TRANSCRIPT, type TranscriptEntry, transcriptOf } from "./process/index.js";
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
const SETTLED: TranscriptEntry = { type: "turn", status: "interrupted", error: "settled: the turn a crash cut off was ended, not resumed" };

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
  // Ids sent and not yet folded: a second send of one is refused too, never dropped by the fold.
  const sending = new Set<string>();

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
    async send(text, sendOptions = {}) {
      if (calls.draining) throw new Error(`${name}: the session is pausing; no new turn`);
      await ready();
      const id = sendOptions.id ?? randomUUID();
      if (sending.has(id) || drive.state().submissions.some((s) => s.id === id)) throw new SubmissionExists(id, name);
      sending.add(id);
      try {
        await drive.submit({ id, kind: "prompt", text });
      } finally {
        sending.delete(id);
      }
      void run();
    },
    async recover() {
      if (state !== "open_turn") throw new Error(`${name}: there is no turn to recover`);
      await ready();
      void run();
    },
    async settleOpenTurn(settleOptions = {}) {
      if (state !== "open_turn") throw new Error(`${name}: there is no turn to settle`);
      await ready();
      const now = drive.state();
      // A settle never infers which prompt to drop: it withdraws only the submission it is named, while that is unplaced
      // and the oldest pending. Then a settle again finds it withdrawn, and a message that came after it is never touched.
      // Named behind an older pending message, it is not withdrawn: it runs as a later turn, and a re-send of it is refused.
      const opening = settleOptions.opening !== undefined && pendingSubmissions(now)[0]?.id === settleOptions.opening ? settleOptions.opening : undefined;
      if (openTurn(now) || opening) {
        // The withdraw and the turn's end, as the journal's next batch, in one write.
        await drive.recordOnly([nextJournalBatch(now, { [TRANSCRIPT]: [{ data: SETTLED }] }, "settle")], { before: opening ? [{ id: randomUUID(), kind: "withdraw", target: opening }] : [] });
        io.onEvent({ type: "turn_end", status: "interrupted" });
      }
      state = pendingSubmissions(drive.state()).length ? "open_turn" : "idle";
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
