// A runner: one long-lived process that carries many loops (design: "Runners carry many loops and hold the whole
// kernel"). It polls the store for claimable runs and claims up to `loops` of them, renews its claims on one timer,
// hands each run's command rows to its loop, and at a run's end flushes and then releases the claim.
//
// Two guards keep a runner that lost a claim from writing (Solid Queue's rule, then the store's fence):
// - a claim that cannot be renewed before it runs out (less a margin) is lost here: the loop is told to stop, its
//   signal aborted, and the journal handed to it refuses every later commit (ClaimLost) before it reaches the store;
// - the store refuses any write under an epoch another claim moved past (Fenced): the backstop for a runner that froze.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, StorageWrite } from "@earendil-works/pi-durable";
import { COMMAND_KINDS, endedReason } from "./commands.js";
import { KINDS, withdrawnAnswers } from "./journal-kinds.js";
import { journalEntries } from "./journal-reader.js";
import { type Claim, type Command, endedBy, type Journal, type Loop, type LoopEnd, type LoopFactory, type StopReason } from "./loop-contract.js";
import { isFenced, type RunnerStore } from "./store-port.js";
import { heldRedactor, type Redact, runnerSecrets, secretRedactor } from "./redact.js";

/** Most runs a runner holds at once, unless told (RunnerOptions.loops). */
export const RUNNER_LOOPS = 300;
/** How often a runner renews the claims it holds, unless told (RunnerOptions.renewEveryMs). */
export const RUNNER_RENEW_EVERY_MS = 10_000;
/** A runner's name when none is given: its host, its process and a part of a random id. */
export const runnerName = (): string => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** The untaken row a run ends on when no loop can: a cancel before a stop (it ends the run for good, in its words). */
const endingRow = (untaken: readonly Command[]): Command | undefined => untaken.find((row) => row.kind === "cancel") ?? untaken.find((row) => row.kind === "stop");

/** A commit by a loop whose claim this runner gave up: refused before it reaches the store. */
export class ClaimLost extends Error {
  override name = "ClaimLost";
}

/** A stopped end that may withdraw a call, which the journal would not take or could not be read for: not written. */
class EndNotWithdrawn extends Error {
  override name = "EndNotWithdrawn";
  constructor(runId: string, cause: unknown) {
    super(`run ${runId}: its stopped end was not written with its withdrawal`, { cause });
  }
}

/** The first wait after a stopped end that withdraws a call is refused; each later one doubles (RunnerOptions). */
export const END_RETRY_BACKOFF_MS = 5_000;
/** The longest wait between those tries: 5 min. */
export const END_RETRY_CAP_MS = 300_000;
/** The tries at that cap before the run ends stopped on its row alone (about an hour of retries in all; endRefused). */
export const END_RETRY_AT_CAP = 11;

export interface RunnerOptions {
  store: RunnerStore;
  createLoop: LoopFactory;
  /** This runner's name in the runs it claims (runs.runner). Default: host, pid and a random part. */
  name?: string;
  /** Most runs held at once. */
  loops?: number;
  /** How long a claim lasts unless renewed. */
  leaseMs?: number;
  renewEveryMs?: number;
  /** A claim not renewed by its until less this margin is lost here, and its loop stopped. */
  stopMarginMs?: number;
  /** How often the store is asked for claimable runs while a loop is free. */
  pollMs?: number;
  /** How often each held run's command rows are read: a command reaches its loop within one of these. */
  commandPollMs?: number;
  /** How many times a parked run brought back by a row is tried when its loop cannot start, before that row is refused. */
  resumeTries?: number;
  /** The wait after a resume's first failed try; each later one waits twice the one before. */
  resumeBackoffMs?: number;
  /** The wait before a run whose loop ended interrupted on its own (no stop asked of it: its Session closed itself) is
   *  claimable again; each such end of the run in a row waits twice the one before, up to 64 times this. */
  interruptBackoffMs?: number;
  /** How long a run's end waits for a command still with its loop before it writes its end; an answer after that is
   *  dropped (nothing written, nothing said). */
  endWaitMs?: number;
  /** How long close() lets each held run go on to its own end (a turn in flight finishes, its outcome journaled, as a
   *  run's own process drained on the server's stop) before it stops the rest for a shutdown, to resume. Its commands
   *  still reach it meanwhile (a person's stop ends it at once). Default 0: every loop stopped at once. */
  drainMs?: number;
  /** A refused stopped end that withdraws a call (endRefused): the first wait, its cap, and the tries at the cap before
   *  the run ends on its row alone. Defaults END_RETRY_BACKOFF_MS, END_RETRY_CAP_MS, END_RETRY_AT_CAP. */
  endRetryBackoffMs?: number;
  endRetryCapMs?: number;
  endRetryAtCap?: number;
  onEvent?: (event: RunnerEvent) => void;
  /** The runner's clock (epoch ms) for what it writes itself: a withdrawn answer's time in an end it writes. Default
   *  Date.now. */
  now?: () => number;
  /** The one redactor (redact.ts secretRedactor over the secrets the runner holds): every error text this runner writes
   *  to a run's row or end, or emits, passes through it, and each loop gets it (LoopDeps.redact). Default: the one over every secret this process's environment holds (runnerSecrets), so a runner
   *  started with none (runner/main.ts) still cuts the keys it was started with. */
  redact?: Redact;
  /** Called at each poll for runs (every pollMs, whether or not it holds any) and each renewal pass: the runner's own
   *  loop is turning. The runner process writes its heartbeat from it (runner/main.ts), so a check sees a runner that is
   *  idle and well, and not one whose loop has stopped. A throw is the caller's. */
  onBeat?: () => void;
}

export type RunnerEvent =
  | { type: "claimed"; claim: Claim }
  | { type: "claim-lost"; runId: string; epoch: number; why: "fenced" | "not-renewed" }
  | { type: "released"; runId: string; epoch: number; end: LoopEnd["state"] }
  | { type: "refused"; runId: string; commandId: number; reason: string }
  | { type: "error"; runId?: string; step: string; message: string };

export interface Runner {
  readonly name: string;
  /** The claims this runner holds and has not lost. */
  held(): Claim[];
  /** Stops claiming, lets each held run go on to its own end for up to drainMs, then stops every loop left where it can
   *  resume, flushes and releases their runs. */
  close(): Promise<void>;
  /** As if the process froze or died: every timer stops, nothing is stopped, flushed or released (a test's crash). */
  kill(): void;
}

interface Held {
  claim: Claim;
  loop: Loop;
  fence: { lost: boolean };
  abort: AbortController;
  /** Rows above this id have not been read for this claim. */
  cursor: number;
  /** A stop is on its way to the loop, or the loop's start() has returned. */
  stopping: boolean;
  /** start() has returned: the run's end (its sweep, flush and release) is under way. A Fenced answer now is no lost claim. */
  ending: boolean;
  /** No more of the claim is written: set once the end stops waiting for an in-flight delivery, before its sweep. */
  sealed: boolean;
  renewing: boolean;
  delivering: boolean;
  /** The delivery under way, which the end waits for (up to endWaitMs) before it writes. */
  inFlight?: Promise<void>;
  deadline?: NodeJS.Timeout;
  done?: Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The run states a run patch makes final: a commit that lands one is the run's end, and its release. */
const FINAL = new Set<string>(["ended", "stopped", "failed"]);

export function startRunner(options: RunnerOptions): Runner {
  const {
    store,
    createLoop,
    name = runnerName(),
    loops = RUNNER_LOOPS,
    leaseMs = 30_000,
    renewEveryMs = RUNNER_RENEW_EVERY_MS,
    stopMarginMs = 5_000,
    pollMs = 1_000,
    commandPollMs = 500,
    resumeTries = 3,
    resumeBackoffMs = 5_000,
    interruptBackoffMs = 1_000,
    endWaitMs = 5_000,
    drainMs = 0,
    endRetryBackoffMs = END_RETRY_BACKOFF_MS,
    endRetryCapMs = END_RETRY_CAP_MS,
    endRetryAtCap = END_RETRY_AT_CAP,
    onEvent = () => {},
    redact: given = secretRedactor(runnerSecrets(process.env)),
    now = Date.now,
    onBeat = () => {},
  } = options;
  // The one instance every run's loop gets (LoopDeps.redact), able to hold what each claim opens from the store
  // (redact.ts holdClaimed): a stored key is cut wherever a key of the runner's environment is.
  const redact = heldRedactor(given);
  /** The first try whose wait is the cap (endRefused): 7 with the defaults (5 s × 2^6 = 320 s, over the 300 s cap). */
  const endRetryCapFrom = 1 + Math.ceil(Math.log2(endRetryCapMs / endRetryBackoffMs));
  const beat = () => {
    try {
      onBeat();
    } catch {
      // The caller's: a heartbeat it could not write never stops the runner.
    }
  };
  if (!(stopMarginMs < leaseMs && renewEveryMs < leaseMs - stopMarginMs)) {
    throw new RangeError(`a claim of ${leaseMs} ms must be renewed (every ${renewEveryMs} ms) before its stop margin (${stopMarginMs} ms)`);
  }
  const emit = (event: RunnerEvent) => {
    try {
      // An error's text is cut of every secret the runner holds before anyone hears it.
      onEvent(event.type === "error" ? { ...event, message: redact(event.message) } : event);
    } catch {
      // A listener's throw is its own.
    }
  };
  /** Every run this runner claimed whose loop has not settled, lost ones included (they still take a loop's place). */
  const runs = new Map<string, Held>();
  /** A lost claim's loop that had not settled when its run was claimed again (its place in `runs` taken by the new one):
   *  still counted against `loops` until it settles, so a loop that ignores its stop never lets the runner hold more. */
  const replaced = new Set<Held>();
  /** The refused stopped ends this runner is trying again (endRetried): close() waits for them. */
  const endings = new Set<Promise<void>>();
  /** Each run's ends in a row, on this runner, as interrupted on its own: its next release's backoff doubles with them. */
  const interruptedInARow = new Map<string, number>();
  let closed = false;
  /** close() is letting its held runs go on to their own ends (drainMs): nothing is claimed, commands still reach them. */
  let draining = false;
  let killed = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let commandTimer: NodeJS.Timeout | undefined;
  let polling = false;

  /** The run's journal with this runner's fence on its one write: after the claim is lost, commit throws ClaimLost. A
   *  commit that lands a final run patch (the loop's own end, which is the run's release) calls `ended` at once: from
   *  then the run is ending, before the loop's teardown, so a renew answered Fenced by that end's epoch is never a lost
   *  claim. The patch lands exactly when the batch that writes its effect (the record it is staged with) is stored
   *  (RunStorage.commit): a group commit stores its batches in order up to the first it refuses, so the end's batch can
   *  land while a later sibling is refused, and an end whose own batch is refused has not landed. */
  const fenced = (journal: Journal, fence: { lost: boolean }, runId: string, ended: () => void): Journal => {
    /** The effect of the final patch staged and not yet landed, as the store keeps it until a commit stores it. */
    let finalEffect: number | undefined;
    return new Proxy(journal, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "stage") {
          return (staged: { run?: { state?: string }; also?: unknown; effect?: unknown } | undefined, ...rest: unknown[]) => {
            const result = value.call(target, staged, ...rest);
            // As the store keeps it: a run patch or rows staged again replace the one staged before.
            if (staged?.run !== undefined || staged?.also !== undefined) finalEffect = FINAL.has(staged.run?.state ?? "") ? Number(staged.effect) : undefined;
            return result;
          };
        }
        if (property !== "commit") return value.bind(target);
        // pi's commit is async and pi chains on it (group commit, the publish queue): the refusal is a rejected promise,
        // so it fails that commit on the path pi already handles, never a throw out of a caller that is not async.
        return (...args: unknown[]) => {
          if (fence.lost) return Promise.reject(new ClaimLost(`run ${runId}: this runner lost its claim; the commit is not written`));
          const effect = finalEffect;
          const batches = (Array.isArray(args[0]) ? args[0] : [args[0]]) as unknown[];
          const at = effect === undefined ? -1 : batches.findIndex((batch) => (Array.isArray(batch) ? batch : [batch]).some((write) => Number((write as { value?: { id?: unknown } } | undefined)?.value?.id) === effect));
          return (value.apply(target, args) as Promise<{ stored?: number }>).then((result) => {
            if (at >= 0 && at < (result?.stored ?? 0) && finalEffect === effect) {
              finalEffect = undefined;
              ended();
            }
            return result;
          });
        };
      },
    });
  };

  const armDeadline = (held: Held, at: number) => {
    clearTimeout(held.deadline);
    held.deadline = setTimeout(() => loseClaim(held, "not-renewed"), Math.max(0, at - Date.now()));
  };

  /** The claim is gone (fenced) or about to run out unrenewed: write nothing more, and stop the loop. */
  const loseClaim = (held: Held, why: "fenced" | "not-renewed") => {
    // A run that is ending gave its claim up itself (or is about to): a Fenced answer to a call that was in flight then
    // is no lost claim, and its loop has already stopped.
    if (held.fence.lost || held.ending || killed) return;
    held.fence.lost = true;
    clearTimeout(held.deadline);
    emit({ type: "claim-lost", runId: held.claim.runId, epoch: held.claim.epoch, why });
    stopLoop(held, { kind: "claim-lost" });
    held.abort.abort(new ClaimLost(`run ${held.claim.runId}: claim lost (${why})`));
  };

  const stopLoop = (held: Held, reason: StopReason) => {
    held.stopping = true;
    held.loop.stop(reason).catch((error: unknown) => emit({ type: "error", runId: held.claim.runId, step: "stop", message: message(error) }));
  };

  /** Every held claim renewed in one transaction (store.renewMany), never one per run: a claim answered Fenced is lost,
   *  the others move on. Any other failure (a busy store) is tried at the next renew; each run's deadline stops its loop
   *  if none lands. */
  const renewAll = async () => {
    if (killed) return;
    beat();
    const due = [...runs.values()].filter((held) => !held.renewing && !held.fence.lost && !held.ending);
    if (due.length === 0) return;
    for (const held of due) held.renewing = true;
    const sentAt = Date.now();
    try {
      const results = await store.renewMany(due.map((held) => held.claim), { leaseMs });
      results.forEach((result, i) => {
        const held = due[i]!;
        if (held.fence.lost || held.ending || killed) return;
        if (isFenced(result)) loseClaim(held, "fenced");
        else {
          held.claim = result as Claim;
          armDeadline(held, sentAt + leaseMs - stopMarginMs);
        }
      });
    } catch (error) {
      for (const held of due) emit({ type: "error", runId: held.claim.runId, step: "renew", message: message(error) });
    } finally {
      for (const held of due) held.renewing = false;
    }
  };
  const renewTimer = setInterval(() => void renewAll(), renewEveryMs);

  /** Hands the run's new command rows to its loop: stop as stop(), the other kinds as command(); refusals are taken. The
   *  run's end waits for it (finish), so a refusal of a command the loop had when it ended is written before the release;
   *  once the end has sealed the claim, an answer still to come is dropped: nothing written, nothing said. `given`: the
   *  rows the runner's one read of every run found for it (deliverAll), else it reads its own. */
  const deliver = (held: Held, given?: readonly Command[]): Promise<void> => {
    if (held.delivering || held.stopping || held.ending || held.fence.lost || killed) return Promise.resolve();
    held.delivering = true;
    // Declared before it is assigned: its own finally reads it.
    let delivery: Promise<void> | undefined;
    delivery = (async () => {
      try {
        const rows = given ?? (await store.commands(held.claim.runId, held.cursor));
        for (const row of rows) {
          if (held.stopping || held.ending || held.fence.lost || killed) break;
          // A row another delivery handed on since the runner's read is not handed on again.
          if (row.id <= held.cursor) continue;
          // The cursor moves past a row only once its delivery went through (handed to the loop, and any refusal written):
          // a delivery that throws leaves the row for the next poll, never skipped for the rest of the claim.
          if (row.takenAt !== null) {
            held.cursor = Math.max(held.cursor, row.id);
            continue;
          }
          if (row.kind === "stop" || row.kind === "cancel") {
            held.cursor = Math.max(held.cursor, row.id);
            stopLoop(held, { kind: "command", commandId: row.id, ...(row.kind === "cancel" ? { cancel: true as const } : {}) });
            break;
          }
          const outcome = COMMAND_KINDS.has(row.kind) ? await held.loop.command(row) : { refused: `no command is of kind ${JSON.stringify(row.kind)}` };
          if (held.sealed || killed) return;
          // `taken`: the loop's commit took it. `later`: left untaken for the run's next claim. Only a refusal is written here.
          if ("refused" in outcome) {
            await store.take(held.claim, row.id, "refused", outcome.refused);
            emit({ type: "refused", runId: held.claim.runId, commandId: row.id, reason: outcome.refused });
          }
          held.cursor = Math.max(held.cursor, row.id);
        }
      } catch (error) {
        if (held.sealed || killed) return;
        if (isFenced(error)) loseClaim(held, "fenced");
        else emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
      } finally {
        held.delivering = false;
        if (held.inFlight === delivery) held.inFlight = undefined;
      }
    })();
    held.inFlight = delivery;
    return delivery;
  };
  /** One read of every held run's new command rows a tick (store.commandsOf), never one per run, each run's then handed
   *  to its loop; the next tick is set once this read is done. */
  const delivering = () => !killed && (!closed || draining);
  const deliverAll = () => {
    if (!delivering()) return;
    void (async () => {
      const due = [...runs.values()].filter((held) => !(held.delivering || held.stopping || held.ending || held.fence.lost));
      if (due.length === 0) return;
      try {
        const rows = await store.commandsOf(due.map((held) => ({ runId: held.claim.runId, after: held.cursor })));
        for (const held of due) void deliver(held, rows.get(held.claim.runId) ?? []);
      } catch (error) {
        for (const held of due) emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
      }
    })().finally(() => {
      if (delivering()) commandTimer = setTimeout(deliverAll, commandPollMs);
    });
  };

  /** After start() settles: a final run's leftover rows refused, then one flush, then the release. A lost claim writes
   *  nothing; a killed runner does nothing. */
  /**
   * Ends the run under `claim` in its journal, for a loop that could not write its own end: an agentrun.end entry on the
   * run's root conversation (one made for it when the run has none yet), with the run row's patch and the commands in
   * `take` keyed to that entry, so they land in its one commit or not at all. When the journal cannot take that commit,
   * the run row alone (runs.update, the same take in its one transaction), unless the end is a stop that may withdraw a
   * call (one waits, or the journal could not be read to say none does): that end is never written without its withdrawal,
   * so it throws EndNotWithdrawn and the run is left as it stands, not final, its stop untaken (endRefused retries it). A
   * lost claim (Fenced) writes neither.
   */
  const endRun = async (claim: Claim, given: { state: "stopped" | "failed"; summary: string }, take: readonly number[]) => {
    // Why the run ended, as its end and its row say it: cut of every secret the runner holds (an error's text may echo one).
    const data = { ...given, summary: redact(given.summary) };
    // Unknown means it may withdraw: false only once the journal was read and no call of it waits.
    let mayWithdraw = data.state === "stopped";
    try {
      const journal = store.journal(claim);
      const [root] = (await journal.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items;
      if (!root) mayWithdraw = false;
      const writes: StorageWrite[] = [];
      let conversationId = root?.id;
      if (conversationId === undefined) {
        conversationId = (await journal.mintId()) as unknown as ConversationId;
        writes.push({ type: "conversation", value: { id: conversationId } } as StorageWrite);
      }
      // A stopped end withdraws every call still waiting for its answer (an ask with no answer), in this commit: the
      // approval card of a run whose loop could not start reads answered, never waiting for good.
      if (data.state === "stopped" && root) {
        const withdrawn = withdrawnAnswers(await journalEntries(journal, BACKGROUND_CONTEXT), new Date(now()).toISOString());
        mayWithdraw = withdrawn.length > 0;
        for (const answer of withdrawn) {
          const answerId = (await journal.mintId()) as unknown as EntryId;
          writes.push({ type: "entry", value: { id: answerId, conversationId, kind: KINDS.answer, data: answer as unknown as JsonValue } } as StorageWrite);
        }
      }
      const id = (await journal.mintId()) as unknown as EntryId;
      writes.push({ type: "entry", value: { id, conversationId, kind: KINDS.end, data: data as unknown as JsonValue } } as StorageWrite);
      journal.stage({ run: { state: data.state, summary: data.summary }, effect: id as unknown as number, ...(take.length ? { take: take.map((command) => ({ command, effect: id as unknown as number })) } : {}) });
      const result = await journal.commit([writes], () => {}, BACKGROUND_CONTEXT);
      if (result.stored !== 1) throw result.refused ?? new Error("the run's end was not stored");
    } catch (error) {
      if (isFenced(error)) throw error;
      if (mayWithdraw) throw new EndNotWithdrawn(claim.runId, error);
      await store.runs.update(claim, { state: data.state, summary: data.summary }, take.length ? { take } : undefined);
    }
  };

  /** Ends the run under `claim` stopped on its untaken `stop` (or cancel) row (endRun). False when that end may withdraw a
   *  call and the journal would not take it or could not be read: the refusal is then the run's (endRefused). */
  const endStopped = async (claim: Claim, stop: Command): Promise<boolean> => {
    try {
      await endRun(claim, { state: "stopped", summary: endedBy(stop.kind === "cancel") }, [stop.id]);
      return true;
    } catch (error) {
      if (!(error instanceof EndNotWithdrawn)) throw error;
      await endRefused(claim, stop, error);
      return false;
    }
  };

  /** A stopped run's end, written (its stop row taken) or written row-only at the give-up: every other untaken row was
   *  refused in that same write, which released the run (the store's rule for a write that makes a run final), said here
   *  from what the end refused. Nothing is taken after it (its claim is spent). */
  const releaseStopped = async (claim: Claim, stop: Command) => {
    const reason = endedReason("stopped");
    for (const row of await store.commands(claim.runId, 0)) {
      if (row.id !== stop.id && row.refused === reason) emit({ type: "refused", runId: claim.runId, commandId: row.id, reason });
    }
    await store.flush();
    await store.release(claim, {});
    emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "stopped" });
  };

  /**
   * A stopped end that may withdraw a call, refused (EndNotWithdrawn): counted on its stop row's tries, said by the run's
   * name, and the claim released with the run still running (not final) and a backoff that doubles from
   * endRetryBackoffMs up to endRetryCapMs; the next claim only ends it (claimMore: endRetried), never runs a turn. Once the
   * backoff has sat at its cap for endRetryAtCap tries, the run ends stopped on its row alone, said as an error by name:
   * a journal that never takes the end never keeps a stopped run alive. With the defaults (5 s doubling to a 5 min cap,
   * 11 tries at the cap): 6 growing waits (5 s to 160 s, 315 s in all), then 11 of 5 min, so about an hour (3,615 s) of
   * retries, and the 18th refusal gives up.
   */
  const endRefused = async (claim: Claim, stop: Command, refused: EndNotWithdrawn) => {
    const tries = await store.retry(claim, stop.id);
    const why = message(refused.cause);
    if (tries >= endRetryCapFrom + endRetryAtCap) {
      emit({ type: "error", runId: claim.runId, step: "end", message: `run ${claim.runId} ended without withdrawing: journal unreadable or refusing (after ${tries} tries; the last: ${why})` });
      await store.runs.update(claim, { state: "stopped", summary: redact(endedBy(stop.kind === "cancel")) }, { take: [stop.id] });
      await releaseStopped(claim, stop);
      return;
    }
    const wait = Math.min(endRetryBackoffMs * 2 ** (tries - 1), endRetryCapMs);
    emit({ type: "error", runId: claim.runId, step: "end", message: `run ${claim.runId}: its end with a withdrawal was refused (try ${tries}); retrying in ${wait} ms: ${why}` });
    await store.flush();
    await store.release(claim, { backoffUntil: now() + wait });
    emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "interrupted" });
  };

  /** A claim of a run whose stopped end was refused (its untaken stop row has tries): it only ends the run, with no loop,
   *  so no turn, model request or tool runs on a run that is stopping. */
  const endRetried = async (claim: Claim, stop: Command) => {
    try {
      if (await endStopped(claim, stop)) await releaseStopped(claim, stop);
    } catch (error) {
      emit({ type: "error", runId: claim.runId, step: isFenced(error) ? "end (fenced)" : "end", message: message(error) });
    }
  };

  const finish = async (held: Held, end: LoopEnd, threw: boolean) => {
    // Whether the runner asked the loop to stop before it ended (only stopLoop sets this).
    const stoppedBefore = held.stopping;
    held.ending = true;
    clearTimeout(held.deadline);
    const { claim } = held;
    // A command still with the loop: its refusal is written before anything of the end, never after the release. A loop
    // that does not answer within endWaitMs has its answer dropped (the claim is sealed first).
    if (held.inFlight) {
      let waited: NodeJS.Timeout | undefined;
      await Promise.race([held.inFlight, new Promise<void>((resolve) => (waited = setTimeout(resolve, endWaitMs)))]);
      clearTimeout(waited);
    }
    held.sealed = true;
    try {
      if (killed) return;
      // A loop that came back with a final end wrote it: its end commit landed, and a write that makes the run final is its
      // release (the store's rule). A renew answered Fenced after that commit is expected, never a lost claim: the end goes
      // on as any end does, made durable (a flush) before the runner says released. Any other lost claim writes nothing.
      const endedItself = !threw && (end.state === "ended" || end.state === "stopped" || end.state === "failed");
      if (held.fence.lost && !endedItself) return;
      // A parked run brought back (a raise, an approval) whose loop threw before it could start stays parked: its waking
      // row keeps one more try, and the run is claimable again after a backoff; after the last try that row is refused
      // with why, and a person can raise again or stop it (#1944-5). A claim its spec refuses (ClaimRefused: a handed
      // sign-in that won't read back, an MCP pin refused) never comes here: the loop writes that end itself, final, the run
      // failed in the refusal's words.
      if (threw && end.state === "failed" && claim.from === "parked") return await resumeFailed(held, end.error.message);
      if (threw && end.state === "failed") {
        // A loop that failed with no end written: a person's stop waiting now is the run's end (stopped, its row taken),
        // never refused as a failed run's; else the run ends failed with why. Either way its end is in the journal.
        const stop = endingRow((await store.commands(claim.runId, 0)).filter((row) => row.takenAt === null));
        if (stop) {
          if (!(await endStopped(claim, stop))) return;
          end = { state: "stopped" };
        } else {
          await endRun(claim, { state: "failed", summary: end.error.message }, []);
        }
      }
      if (end.state === "ended" || end.state === "stopped" || end.state === "failed") {
        // The write that made the run final refused its untaken rows itself, in that transaction (the store's rule), and
        // released the run: said here as the runner always said them. Nothing is taken after it (its claim is spent).
        const reason = endedReason(end.state);
        for (const row of await store.commands(claim.runId, 0)) {
          if (row.refused === reason) emit({ type: "refused", runId: claim.runId, commandId: row.id, reason });
        }
      }
      await store.flush();
      // A loop that ended interrupted with no stop asked of it (its Session closed itself) is released with a backoff that
      // doubles each time in a row, so a Harness that keeps closing is not claimed again every poll. A stopped loop (a
      // shutdown, a lost claim) is released at once, for another runner to take over.
      const closedItself = end.state === "interrupted" && !stoppedBefore;
      const inARow = closedItself ? (interruptedInARow.get(claim.runId) ?? 0) + 1 : 0;
      if (inARow > 0) interruptedInARow.set(claim.runId, inARow);
      else interruptedInARow.delete(claim.runId);
      await store.release(claim,
        end.state === "parked" && end.wakeAt !== undefined ? { wakeAt: end.wakeAt }
        : inARow > 0 ? { backoffUntil: Date.now() + interruptBackoffMs * 2 ** Math.min(inARow - 1, 6) }
        : {});
      emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: end.state });
    } catch (error) {
      emit({ type: "error", runId: claim.runId, step: isFenced(error) ? "release (fenced)" : "release", message: message(error) });
    } finally {
      // Only its own entry: a run this runner lost and claimed again holds a new one under the same id.
      if (runs.get(claim.runId) === held) runs.delete(claim.runId);
    }
  };

  /** A parked run's resume that threw: one more try on the row that woke it, released parked with a backoff; after
   *  `resumeTries`, that row refused with why and the run released parked with nothing to wake it. */
  const resumeFailed = async (held: Held, why: string) => {
    const { claim } = held;
    const untaken = (await store.commands(claim.runId, 0)).filter((row) => row.takenAt === null);
    const stop = endingRow(untaken);
    const woke = untaken[0];
    if (stop) {
      // A stop never waits on a loop that cannot start: the run ends stopped here, its stop row taken, and every other
      // untaken row refused as a stopped run's.
      // One write: the run ends stopped with its stop row taken, or neither (a final run never keeps its stop untaken).
      if (await endStopped(claim, stop)) await releaseStopped(claim, stop);
      return;
    }
    if (woke) {
      const tries = await store.retry(claim, woke.id);
      if (tries >= resumeTries) {
        const reason = `the run could not go on after ${tries} tries; the last: ${why}`;
        await store.take(claim, woke.id, "refused", reason);
        emit({ type: "refused", runId: claim.runId, commandId: woke.id, reason });
        await store.flush();
        await store.release(claim, { state: "parked" });
      } else {
        await store.flush();
        await store.release(claim, { state: "parked", backoffUntil: Date.now() + resumeBackoffMs * 2 ** (tries - 1) });
      }
    } else {
      await store.flush();
      await store.release(claim, { state: "parked" });
    }
    emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "parked" });
  };

  const hold = (claim: Claim, sentAt: number) => {
    const fence = { lost: false };
    const abort = new AbortController();
    let firstDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => (firstDelivered = resolve));
    // Set below, once held is made: the loop's end commit lands only after start(), well after.
    let ending: () => void = () => {};
    const loop = createLoop({
      journal: (forClaim) => fenced(store.journal(forClaim), fence, forClaim.runId, () => ending()),
      flush: () => store.flush(),
      signal: abort.signal,
      delivered,
      redact,
    });
    const held: Held = { claim, loop, fence, abort, cursor: 0, stopping: false, ending: false, sealed: false, renewing: false, delivering: false };
    // The loop's own end landed: the run is ending from here, its teardown included (no renew, no lost claim).
    ending = () => {
      held.ending = true;
      clearTimeout(held.deadline);
    };
    runs.set(claim.runId, held);
    armDeadline(held, sentAt + leaseMs - stopMarginMs);
    emit({ type: "claimed", claim });
    held.done = (async () => {
      let end: LoopEnd;
      let threw = false;
      try {
        end = await loop.start(claim);
      } catch (error) {
        threw = true;
        end = { state: "failed", error: { code: "loop-threw", message: message(error) } };
      }
      await finish(held, end, threw);
    })();
    // The claim's first delivery: deps.delivered resolves once it has handed on every untaken row it read.
    void deliver(held).finally(firstDelivered);
  };

  const claimMore = async () => {
    if (polling || closed || killed) return;
    polling = true;
    try {
      const free = loops - runs.size - replaced.size;
      if (free <= 0) return;
      // One store call claims the batch, each run at its own epoch + 1 (store.runs.claimMany): filling 300 loops, or
      // taking a dead runner's runs over, is one transaction, not 300.
      const sentAt = Date.now();
      const claims = await store.runs.claimMany(name, free, { leaseMs });
      // A run whose untaken stop row has tries failed to apply that stop before: its claim only ends it (endRetried). Either
      // source of tries counts: a refused stopped end (endRefused, released running) or a failed resume (resumeFailed's
      // store.retry, released parked). One read of those claims' rows, made only when the batch has a released run.
      const released = claims.filter((claim) => claim.from === "running" || claim.from === "parked");
      const rows = released.length ? await store.commandsOf(released.map((claim) => ({ runId: claim.runId, after: 0 }))) : new Map<string, Command[]>();
      for (const claim of claims) {
        const stop = endingRow((rows.get(claim.runId) ?? []).filter((row) => row.takenAt === null));
        if (stop && stop.tries > 0 && !closed && !killed && !runs.has(claim.runId)) {
          const ending = endRetried(claim, stop);
          endings.add(ending);
          void ending.finally(() => endings.delete(ending));
          continue;
        }
        const before = runs.get(claim.runId);
        if (closed || killed || (before && !before.fence.lost)) {
          // Closed while the batch was claimed (or a run this runner still holds, which a claim cannot be): given back.
          if (before && !before.fence.lost) emit({ type: "error", runId: claim.runId, step: "claim", message: "claimed a run this runner still holds" });
          await store.release(claim, {}).catch(() => {});
          continue;
        }
        try {
          // A lost claim's loop still running keeps its place until it settles.
          if (before?.done) {
            replaced.add(before);
            void before.done.finally(() => replaced.delete(before));
          }
          hold(claim, sentAt);
        } catch (error) {
          // The loop could not be made: the run fails here, so it is not claimed again and again.
          emit({ type: "error", runId: claim.runId, step: "create loop", message: message(error) });
          await store.runs.update(claim, { state: "failed", summary: redact(message(error)) }).catch(() => {});
          await store.flush().catch(() => {});
          await store.release(claim, {}).catch(() => {});
        }
      }
    } catch (error) {
      emit({ type: "error", step: "poll", message: message(error) });
    } finally {
      polling = false;
    }
  };
  /** The poll's claim in flight, if any: close() waits for it, so a runner whose close resolved claims nothing after it. */
  let claiming: Promise<void> | undefined;
  const poll = () => {
    if (closed || killed) return;
    beat();
    const claimed = claimMore();
    claiming = claimed;
    void claimed.finally(() => {
      if (claiming === claimed) claiming = undefined;
      if (!closed && !killed) pollTimer = setTimeout(poll, pollMs);
    });
  };

  poll();
  commandTimer = setTimeout(deliverAll, commandPollMs);

  const stopTimers = () => {
    clearTimeout(pollTimer);
    clearTimeout(commandTimer);
    clearInterval(renewTimer);
    for (const held of runs.values()) clearTimeout(held.deadline);
  };

  return {
    name,
    held: () => [...runs.values()].filter((held) => !held.fence.lost && !held.ending).map((held) => held.claim),
    async close() {
      if (closed || killed) return;
      closed = true;
      clearTimeout(pollTimer);
      // A claim the poll already has in flight lands first: one it makes now is given back at once (claimMore, closed),
      // all before close resolves, so nothing is claimed by this runner after it (a raise sent then wakes no claim here).
      draining = drainMs > 0;
      await claiming;
      // The drain: each held run goes on to its own end (an answer, a park, a person's stop: their commands still reach
      // them), its claims renewed, for up to drainMs; a turn in flight then finishes, never cut and paid again on the
      // resume. Whatever is still going at the bound is stopped below, for a shutdown, where it can resume.
      const going = [...runs.values()].filter((held) => !held.fence.lost && !held.ending);
      if (draining && going.length > 0) {
        let bound: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(going.map((held) => held.done)), new Promise<void>((resolve) => (bound = setTimeout(resolve, drainMs)))]);
        clearTimeout(bound);
      }
      draining = false;
      clearTimeout(commandTimer);
      const live = [...runs.values()].filter((held) => !held.fence.lost);
      for (const held of live) {
        if (!held.ending) {
          stopLoop(held, { kind: "shutdown" });
          held.abort.abort(new Error("the runner is closing"));
        }
      }
      // Claims are renewed while the loops stop; a loop that never stops is given up when its claim would run out.
      let timeout: NodeJS.Timeout | undefined;
      const late = new Promise<void>((resolve) => (timeout = setTimeout(resolve, leaseMs - stopMarginMs)));
      await Promise.race([Promise.all([...live.map((held) => held.done), ...endings]), late]);
      clearTimeout(timeout);
      for (const held of runs.values()) held.fence.lost = true;
      stopTimers();
    },
    kill() {
      killed = true;
      closed = true;
      stopTimers();
    },
  };
}
