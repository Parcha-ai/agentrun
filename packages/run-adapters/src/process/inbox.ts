// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/inbox.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: imports from AgentRun's kernel; waitForSubmissions and WaitOptions removed (no harness here uses them).
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
