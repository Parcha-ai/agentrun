// The reference child as an app module for `pi-durable-disk run --app`: one open path for a run, with the claim, the fence, the stdin mount token, run.json's holder, the seal and restarts the
// disk package already provides. The instance opens the store on its own claim and resumes it; `onOpen` drives the demo's job on it, as `run()` does on its local claim.
//
//   DEMO_ENTRY=<file URL of a demo's run.ts, which exports `options` (its DemoOptions)> \
//   pi-durable-disk run --dir <dir> --app examples/reference/child-app.ts --id <the demo's name>
//
// The process takes the same environment the supervisor gives its child (`PLAN`, `CROSS_LOG`, `KILL_REQUEST`, `RECORD_DIR`, `INPUT`, `BACKEND`, `LIVE`), so the supervisor's kills, recording and
// input work unchanged. When the job has finished the child prints its outcome line, as the local place reads it, and writes the run's final status `done` with the record and the store's hash,
// as a box place reads them (it has only run.json), releases the run and exits 0.
import type { AppContext, AppOptions } from '@parcha/pi-durable-disk';
import { appOf } from './assemble.ts';
import { outcomeOf, prepareChild, type DemoOptions } from './demo.ts';

export default async function app(ctx: AppContext): Promise<AppOptions> {
  const entry = process.env.DEMO_ENTRY;
  if (!entry) throw new Error('child-app needs DEMO_ENTRY, the file URL of the demo module that exports `options`.');
  const { options } = (await import(entry)) as { options?: DemoOptions };
  if (!options) throw new Error(`${entry} exports no \`options\` (the DemoOptions the demo passes to demo()).`);
  const prepared = await prepareChild(options, process.env, { id: ctx.ref.id, root: ctx.root, work: ctx.work, store: ctx.store });
  return appOf(prepared.place, prepared.host, prepared.job, prepared.runOptions, async ({ result, storeSha256 }) => {
    const made = await prepared.made(result);
    await prepared.recorder?.detach();
    console.log(JSON.stringify({ outcome: outcomeOf(result, storeSha256, made, prepared.models) }));
    await prepared.done();
  });
}
