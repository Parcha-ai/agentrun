// npm run demo:reference [-- --json] [-- --dir <path>]: the reference job on the no-key host. `--dir` keeps the run's
// directory, so a second process resumes what the first left.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { placeAt, run, type RunResult } from './assemble.ts';
import { localHost, type LocalHost, type RunPlace, type StatusEvent } from './host.ts';
import { fakes, job } from './job.ts';

/** The run as one value: what the workflow returned, what each package did, what was spent, every fake call. */
export function summary(place: RunPlace, result: RunResult, local: LocalHost) {
  let events: StatusEvent[] = [];
  try { events = readFileSync(join(place.root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { /* none yet */ }
  const tally = (keys: string[]) => keys.reduce<Record<string, number>>((counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }), {});
  const of = <S extends StatusEvent['source']>(source: S) => events.filter((event): event is Extract<StatusEvent, { source: S }> => event.source === source);
  const ledger = local.ledger();
  return {
    status: result.status,
    output: result.output ?? null,
    evidence: local.evidence(),
    did: {
      disk: { generation: result.generation },
      workflow: tally(of('workflow').map(({ event }) => event.type)),
      browser: tally(of('browser').flatMap((event) => ('change' in event ? [event.change] : Object.entries(event.reconciled).flatMap(([kind, tags]) => tags.map(() => `reconcile.${kind}`))))),
      vision: { looks: of('vision').filter((event) => 'look' in event).length, misses: of('vision').filter((event) => 'miss' in event).length },
      evidence: tally(of('evidence').map(({ tool }) => tool)),
    },
    usage: Object.fromEntries(Object.entries({ ...result.usage.models, ...result.usage.tools }).map(([name, used]) => [name, { tokens: used.totalTokens, usd: used.cost.total }])),
    ledger: {
      calls: tally(ledger.map((row) => `${row.kind}:${row.name}`)),
      ...(local.backend ? { browser: tally([...local.backend.ledger.map((row) => row.op), ...local.backend.dispatched.map((row) => `page.${row.op}`)]) } : {}),
    },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { json: { type: 'boolean' }, dir: { type: 'string' } } });
  const place = await placeAt(values.dir);
  const local = localHost(place, fakes);
  const result = await run(place, local.host, job);
  const view = summary(place, result, local);
  if (values.json) console.log(JSON.stringify(view));
  else {
    const output = view.output as { company: string; answer: string; citations: string[]; supported: boolean } | null;
    console.log(`Reference run: ${view.status}, generation ${view.did.disk.generation}, in ${place.root}`);
    if (output) console.log(`\nRecord for ${output.company}\n  ${output.answer}\n  supported: ${output.supported}\n  cites:\n${output.citations.map((path) => `    ${path}`).join('\n')}`);
    console.log(`\nEvidence filed: ${view.evidence.length}\n${view.evidence.map((path) => `  ${path}`).join('\n')}`);
    console.log('\nWhat each package did');
    console.log(`  pi-durable-disk  opened the run on a local directory (generation ${view.did.disk.generation})`);
    console.log(`  agentrun-dsl     ${Object.entries(view.did.workflow).map(([type, n]) => `${type} ${n}`).join(', ')}`);
    console.log(`  pi-browser       sessions ${Object.entries(view.did.browser).map(([change, n]) => `${change} ${n}`).join(', ')}; reads filed ${view.did.evidence.browser_read ?? 0}`);
    console.log(`  pi-vision        looks ${view.did.vision.looks}, misses ${view.did.vision.misses}`);
    console.log(`  fakes            ${Object.entries(view.ledger.calls).map(([call, n]) => `${call} x${n}`).join(', ')}`);
    console.log(`\nUsage\n${Object.entries(view.usage).map(([name, used]) => `  ${name}: ${used.tokens} tokens, $${used.usd}`).join('\n')}`);
  }
  if (view.status !== 'complete') process.exitCode = 1;
}
