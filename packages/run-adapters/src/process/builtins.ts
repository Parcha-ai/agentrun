// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/builtins.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: imports from AgentRun's kernel; message prefixes; comments name Codex only; a call begun twice (the same execution delivered twice) is reserved before the first await, and the second begin waits for its outcome (or the drive's stop) instead of running it again.; 2026-10-29: a call its wrapper failed before letting it run is answered `refused`, so a hook can tell it from one the log already has an outcome for.
import { type DriveContext, EffectFailure, EffectInterrupted, Fatal, type HostToolIO, hostToolIO, type ReplayPolicy } from '../kernel/index.js';
import { clip, failureText, toolKey, type ToolResult } from './tools.js';

/**
 * A harness's own (built-in) tools, in the log.
 *
 * With its built-in tools on, a harness runs tools the drive never sees run:
 * Codex's shell and `apply_patch` run inside app-server. The drive sees
 * them through the harness's own hooks: one before a call runs (a Codex
 * approval request), one after it (`item/completed`). `BuiltinCalls` makes that pair the kernel's effect
 * sandwich for the call, keyed by the harness's own call id
 * (`tool:<callId>`, step name `tool.<name>`, like a bridged tool):
 *
 * - `begin` commits the call's intent and resolves once it is committed
 *   (for a `never` call: durable, after the harness's own record of the call
 *   is in the log, `beforeNever`). Only then does the hook let the call run.
 * - `end` commits its outcome: the result the harness reports (clipped: the
 *   full result is in the harness's own transcript, which the log carries).
 *
 * What that buys, and what it does not:
 *
 * - Every built-in call that ran has an intent in the log first. After a
 *   crash, the recovery note lists each call of the turn with what the log
 *   knows: completed (its result), failed, or interrupted, "may or may not
 *   have taken effect" (`never`) / "safe to repeat" (`safe`).
 * - Nothing reruns a built-in call by itself. The harness resumes its own
 *   session, which answers a call that was in flight "interrupted, outcome
 *   unknown" (Codex gets it injected).
 *   A harness that dispatches the same call id again gets the log's answer
 *   (`begin` returns it) and must not run it. For a built-in, `safe` only
 *   changes the note's wording: the model decides what to repeat.
 * - What a call did is not in the log. The working directory is a disk on
 *   the machine that drives the session (see `LocalWorkspace`), and a
 *   process a tool started does not outlive the drive (`ProcessHost`'s
 *   group registry kills it).
 */

export interface BuiltinCall {
  /** The harness's own id for the call (stable across a resume of its session: it is the memo key). */
  callId: string;
  /** The harness's tool name (`Bash`, `shell`, `edit`, ...). */
  name: string;
  input: unknown;
  /** Default: `BuiltinCallsOptions.replay(name)`. */
  replay?: ReplayPolicy;
}

export interface BuiltinCallsOptions {
  /** A built-in's replay policy, by name. Default `never`. */
  replay?: (name: string) => ReplayPolicy;
  /**
   * Runs before the intent of a `never` call: the native journal's barrier,
   * so the harness's own record of the call is in the log before its intent.
   */
  beforeNever?: (call: BuiltinCall) => Promise<void>;
  /** Publish `tool_start` / `tool_end` on `ctx.live`. Default true. */
  live?: boolean;
  /** How much of a result the step records. Default 8000 characters. */
  outputChars?: number;
  /**
   * Run each call's effect body inside this wrapper: `run` lets the call go
   * (`begin` resolves once the wrapper calls it) and resolves with the
   * result the harness reports (`end`), or rejects with its failure. What
   * the wrapper returns is the call's recorded outcome, and what it throws
   * its failure. For a harness whose built-ins work on files the drive
   * keeps: sync the files in before `run`, and commit what the call changed
   * with its outcome. A wrapper that throws before
   * calling `run` fails the call: `begin` answers with that failure, and the
   * call never runs. One that returns without calling `run` decides the
   * outcome itself: `begin` answers with it, and the call never runs either
   * (nothing on the live stream). One that throws after `run` fails the call
   * although the harness ran it (the step records the failure, `end`
   * resolves). Calling `run` again returns the first call's promise. Default:
   * none (the call runs as soon as its intent is committed).
   */
  around?: (call: BuiltinCall, run: () => Promise<string>, io: HostToolIO) => Promise<string>;
}

/** What `begin` says the hook should do. */
export type BuiltinStart =
  /** The intent is committed: let the call run. */
  | { run: true }
  /** The log already has an outcome for this call id: do not run it, answer with this. `refused`: the call never ran,
   *  because its wrapper (`around`) failed it before letting it go. */
  | { run: false; result: ToolResult; refused?: true };

interface Open {
  settle: (outcome: { ok: true; text: string } | { ok: false; error: Error }) => void;
  /** The effect: resolves once its outcome is committed (never rejects). */
  done: Promise<void>;
}

/**
 * The built-in calls of one drive. Build one per `drive(ctx)`.
 *
 * A call the drive leaves open (the harness's process died mid-call, the
 * drive stopped) is dealt with by `close`: interrupted if the drive is
 * still live, else left to the kernel (a stopped drive's intent is released
 * or recovered as interrupted by the next delivery).
 */
export class BuiltinCalls {
  private readonly open = new Map<string, Open>();
  /** Each call id's first `begin`, reserved before it awaits anything. */
  private readonly begun = new Map<string, Promise<BuiltinStart>>();
  private readonly replay: (name: string) => ReplayPolicy;
  private readonly live: boolean;
  private readonly outputChars: number;

  constructor(
    private readonly ctx: DriveContext,
    private readonly options: BuiltinCallsOptions = {}
  ) {
    this.replay = options.replay ?? (() => 'never');
    this.live = options.live ?? true;
    this.outputChars = options.outputChars ?? 8000;
  }

  /** Calls begun and not ended. */
  get size(): number {
    return this.open.size;
  }

  /** Whether this call is open in this drive. */
  has(callId: string): boolean {
    return this.open.has(callId);
  }

  /**
   * The harness is about to run `call`: commit its intent. Resolves once the
   * intent is committed (`{ run: true }`), or at once with the log's answer
   * when the call id already has an outcome (`{ run: false }`). Rejects if
   * the intent cannot be committed (the drive lost the session, a write
   * failed): the drive is halted, and the hook must refuse the call.
   */
  begin(call: BuiltinCall): Promise<BuiltinStart> {
    if (!call.callId) return Promise.reject(new TypeError(`agentrun-kernel: a built-in ${call.name} call has no call id`));
    const first = this.begun.get(call.callId);
    if (first) return this.again(call.callId, first);
    const start = this.beginOnce(call);
    this.begun.set(call.callId, start);
    // A call that will not run is done with now; one that runs is, once its outcome is in (beginOnce's `done`).
    start.then((s) => { if (!s.run) this.begun.delete(call.callId); }, () => this.begun.delete(call.callId));
    return start;
  }

  /** The same call begun again: never run it twice. Wait for the first begin, then for its outcome, from the log. */
  private async again(callId: string, first: Promise<BuiltinStart>): Promise<BuiltinStart> {
    const start = await first;
    if (!start.run) return start;
    await this.open.get(callId)?.done;
    // The first call's outcome could not be written: the drive stopped, and this caller stops with it.
    if (this.ctx.signal.aborted) throw this.ctx.signal.reason;
    const known = this.ctx.state().effects.get(toolKey(callId));
    if (known?.status === 'completed') return { run: false, result: { text: String(known.output ?? ''), isError: false } };
    if (known?.status === 'failed' && known.error) return { run: false, result: { text: failureText(known.error), isError: true, ...(known.error.interrupted ? { interrupted: true } : {}) } };
    throw new Fatal(`agentrun-kernel: built-in call ${callId} has no recorded outcome`);
  }

  private async beginOnce(call: BuiltinCall): Promise<BuiltinStart> {
    const key = toolKey(call.callId);
    const known = this.ctx.state().effects.get(key);
    if (known?.status === 'completed') return { run: false, result: { text: String(known.output ?? ''), isError: false } };
    if (known?.status === 'failed' && known.error)
      return { run: false, result: { text: failureText(known.error), isError: true, ...(known.error.interrupted ? { interrupted: true } : {}) } };
    const replay = call.replay ?? this.replay(call.name);
    try {
      if (replay === 'never') await this.options.beforeNever?.(call);
    } catch (err) {
      this.ctx.halt?.(err);
      throw err;
    }
    let started!: () => void;
    const committed = new Promise<void>((r) => (started = r));
    let settle!: Open['settle'];
    const outcome = new Promise<{ ok: true; text: string } | { ok: false; error: Error }>((r) => (settle = r));
    let failed: unknown;
    let ran = false;
    const around = this.options.around;
    const effect = this.ctx.effect(key, { name: `tool.${call.name}`, replay, input: call.input }, async (io) => {
      let running: Promise<string> | undefined;
      // The call itself, once: a wrapper that calls `run` again gets the same promise.
      const body = () =>
        (running ??= (async () => {
          ran = true;
          started();
          if (this.live) this.ctx.live({ type: 'tool_start', name: call.name, args: call.input, callId: call.callId });
          const result = await new Promise<Awaited<typeof outcome>>((resolve, reject) => {
            const stop = () => reject(io.signal.reason ?? new Error('the drive stopped'));
            if (io.signal.aborted) return stop();
            io.signal.addEventListener('abort', stop, { once: true });
            void outcome.then((o) => {
              io.signal.removeEventListener('abort', stop);
              resolve(o);
            });
          });
          if (!result.ok) throw result.error;
          return result.text;
        })());
      return around ? around(call, body, hostToolIO(io, this.ctx)) : body();
    });
    const done = effect.then(
      () => {
        // A call its wrapper settled without letting it run never started, on the live stream either.
        if (this.live && (ran || !around)) this.ctx.live({ type: 'tool_end', name: call.name, callId: call.callId });
      },
      (err) => {
        if (err instanceof EffectFailure) {
          // Nor one its wrapper failed before it ran.
          if (this.live && (ran || !around)) this.ctx.live({ type: 'tool_end', name: call.name, callId: call.callId, isError: true });
          return;
        }
        // Not this call's outcome: the drive stopped, or a write failed. Stop the drive.
        failed = err;
        this.ctx.halt?.(err);
      }
    );
    this.open.set(call.callId, { settle, done });
    void done.finally(() => { this.open.delete(call.callId); this.begun.delete(call.callId); });
    await Promise.race([committed, done]);
    if (failed !== undefined) throw failed;
    // Settled before its intent (replayed from the log by a concurrent read), or by a wrapper that never let it run: answer from the log.
    const after = this.ctx.state().effects.get(key);
    if (!this.open.has(call.callId) && after?.status === 'completed') return { run: false, result: { text: String(after.output ?? ''), isError: false } };
    // The wrapper failed the call before letting it run: answer with that failure.
    if (around && !ran) {
      const error = after?.status === 'failed' && after.error ? failureText(after.error) : 'the tool failed before it ran';
      return { run: false, result: { text: error, isError: true }, refused: true };
    }
    return { run: true };
  }

  /**
   * The call ended: commit its outcome. `isError` (the tool reported a
   * failure) commits a failed step with `text` as its error. Resolves once
   * the outcome is committed (or the drive stopped first). A call this
   * drive never began (a hook that fired without its `begin`) is begun and
   * ended here: recorded after the fact.
   */
  async end(callId: string, result: { name?: string; input?: unknown; text: string; isError?: boolean }): Promise<void> {
    let open = this.open.get(callId);
    // Its begin is still committing the intent: end that call, not a second one.
    if (!open && this.begun.has(callId)) {
      await this.begun.get(callId)!.catch(() => undefined);
      open = this.open.get(callId);
    }
    if (!open) {
      if (this.ctx.isMemoized(toolKey(callId))) return;
      const started = await this.begin({ callId, name: result.name ?? 'builtin', input: result.input ?? null, replay: 'safe' }).catch(() => undefined);
      if (!started?.run) return;
      open = this.open.get(callId);
      if (!open) return;
    }
    const text = clip(result.text, this.outputChars);
    open.settle(result.isError ? { ok: false, error: new Error(text || 'the tool failed') } : { ok: true, text });
    await open.done;
  }

  /**
   * The harness can no longer report these calls (its process exited mid-call):
   * commit each open call as interrupted, "may or may not have taken effect".
   * A no-op once the drive stopped (the kernel resolves its intents).
   */
  async interruptAll(reason = 'the harness stopped before this call reported its result: it may or may not have taken effect'): Promise<void> {
    const open = [...this.open.values()];
    if (this.ctx.signal.aborted) return;
    for (const o of open) o.settle({ ok: false, error: new EffectInterrupted(reason) });
    await Promise.all(open.map((o) => o.done));
  }

  /** Wait for every open call to settle, or `ms` to pass. */
  async settled(ms: number): Promise<void> {
    const open = [...this.open.values()].map((o) => o.done);
    if (!open.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(open), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }
}

/** A tool name list as a replay classifier: these are `safe`, the rest `never`. */
export function replayBy(safe: Iterable<string>): (name: string) => ReplayPolicy {
  const set = new Set(safe);
  return (name) => (set.has(name) ? 'safe' : 'never');
}
