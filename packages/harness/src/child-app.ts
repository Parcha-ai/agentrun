// The reference child as an app module for `pi-durable-disk run --app`: one open path for a run, with the claim, the fence, the stdin mount token, run.json's holder, the seal and restarts the
// disk package already provides. The instance opens the store on its own claim and resumes it; `onOpen` drives the demo's job on it, as `run()` does on its local claim.
//
//   DEMO_ENTRY=<file URL of a demo's run.ts, which exports `options` (its DemoOptions)> \
//   pi-durable-disk run --dir <dir> --app "$(node -p "require.resolve('@parcha/agentrun-harness/child-app')")" --id <the demo's name>
//
// `--app` takes a file: resolve the package's `./child-app` export to it (in code, `import.meta.resolve('@parcha/agentrun-harness/child-app')`).
//
// The process takes the same environment the supervisor gives its child (`PLAN`, `CROSS_LOG`, `KILL_REQUEST`, `RECORD_DIR`, `INPUT`, `BACKEND`, `LIVE`), so the supervisor's kills, recording and
// input work unchanged. When the job has finished the child prints its outcome line, as the local place reads it, and writes the run's final status `done` with the record and the store's hash,
// as a box place reads them (it has only run.json), releases the run and exits 0.
import type { AppContext, AppOptions } from '@parcha/pi-durable-disk';
import { appOf } from './assemble.ts';
import { IMPORTING_DEMO, outcomeOf, prepareChild, type DemoOptions } from './demo.ts';

export default async function app(ctx: AppContext): Promise<AppOptions> {
  const entry = process.env.DEMO_ENTRY;
  if (!entry) throw new Error('child-app needs DEMO_ENTRY, the file URL of the demo module that exports `options`.');
  // A demo's module may call `demo(options)` at its top level, as its own command does: while it is imported for its `options`, that call does nothing.
  const importing = globalThis as Record<symbol, unknown>;
  importing[IMPORTING_DEMO] = true;
  let options: DemoOptions | undefined;
  try { options = ((await import(entry)) as { options?: DemoOptions }).options; } finally { delete importing[IMPORTING_DEMO]; }
  if (!options) throw new Error(`${entry} exports no \`options\` (the DemoOptions the demo passes to demo()).`);
  // The attempt's nonce goes into the kill request and out of the environment before anything starts.
  const killNonce = process.env.KILL_NONCE;
  delete process.env.KILL_NONCE;
  const prepared = await prepareChild(options, process.env, { id: ctx.ref.id, root: ctx.root, work: ctx.work, store: ctx.store }, killNonce);
  const opened = await appOf(prepared.place, prepared.host, prepared.job, prepared.runOptions, async ({ result, storeSha256 }) => {
    // The recorder is detached and the prepared parts released whether or not the result hook and the report succeed.
    try {
      const made = await prepared.made(result);
      await prepared.recorder?.detach();
      // Printed once the final status is written and the run released (the supervisor reads this line as how the run ended).
      // Written whole before the process exits: the outcome can be large, and a line still waiting to enter the pipe when the process ends is cut off.
      // The demo's shaped result is also the final status's detail: a place that reads only run.json (a box or Archil place) keeps it, so its recording has the cited result and not the raw record.
      const line = JSON.stringify({ outcome: outcomeOf(result, storeSha256, made, prepared.models) });
      // Redacted with every token the process saw, as the outline above.
      return Object.assign(() => new Promise<void>((resolve) => { process.stdout.write(`${prepared.redact ? prepared.redact(line) : line}\n`, () => resolve()); }), { detail: made ? { result: made } : {} });
    } finally { await prepared.done(); }
  }, prepared.models ? { models: prepared.models } : {}, prepared.redact);
  // Nothing under the run's directory is written before the claim is open: the recorder, the fetched files and the box start here, once the store is open and before it resumes (a write earlier would land on the bare
  // mountpoint, which the mount then hides). The lines produced before this are held in memory and written, in order, when the recorder starts.
  const beforeResume = opened.beforeResume;
  return { ...opened, beforeResume: async (input) => { await prepared.open(); await beforeResume?.(input); } };
}
