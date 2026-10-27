// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/inbox.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: imports from AgentRun's kernel.
import type { DriveContext, Submission } from '../kernel/index.js';

/**
 * Place submissions before the harness's runtime sees them: one record-only
 * effect `place:<first id>` whose `placed` names them. Placement is what
 * takes a submission off `ctx.pending()` and what a withdraw races (a
 * withdraw committed first wins, and this throws `Restart`: the drive
 * rebuilds without the withdrawn submission). Sending only after placing
 * means the kernel's withdraw rule is exact, and a crash between the two
 * re-sends instead of losing the message.
 *
 * The demo's transcript shows a placed submission where its placement is in
 * the log, so a harness that places right before sending gets its prompts
 * in the right place for free.
 */
export async function placeSubmissions(ctx: DriveContext, submissions: Submission[], name = 'place'): Promise<void> {
  if (submissions.length === 0) return;
  const ids = submissions.map((s) => s.id);
  await ctx.effect(`place:${ids[0]}`, { name, replay: 'safe', input: { ids }, placed: ids }, async () => true);
}

export interface WaitOptions {
  /** How often to read the inbox when the kernel offers no hints. Default 500 ms (5 s with hints). */
  pollMs?: number;
  /** Stop waiting (resolves `[]`). `ctx.signal` always stops it too. */
  signal?: AbortSignal;
}

/**
 * The submissions waiting to be placed, as soon as there are any: refreshes
 * the log on every hint (`ctx.onHint`) and on a poll. Resolves `[]` when
 * `ctx.signal` or `options.signal` aborts. A drive that has nothing left to
 * do should return instead of waiting; this is for a harness that keeps its
 * runtime up while a turn runs (steers) or for a short idle grace.
 */
export async function waitForSubmissions(ctx: DriveContext, options: WaitOptions = {}): Promise<Submission[]> {
  const signals = [ctx.signal, options.signal].filter((s): s is AbortSignal => !!s);
  const stop = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;
  const pollMs = options.pollMs ?? (ctx.onHint ? 5000 : 500);
  for (;;) {
    if (stop.aborted) return [];
    const pending = ctx.pending();
    if (pending.length > 0) return pending;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      const off = ctx.onHint?.(() => done());
      stop.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        off?.();
        stop.removeEventListener('abort', done);
        resolve();
      }
    });
    if (stop.aborted) return [];
    await ctx.refresh();
  }
}
