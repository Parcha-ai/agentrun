// npm run demo:reference [-- --json] [-- --dir <path>] [-- --chrome] [-- --box local|docker]: the reference job on the
// no-key host. `--dir` keeps the run's directory, so a second process resumes what the first left. `--chrome` drives a
// local Chrome (`CHROME_PATH`, default /usr/bin/google-chrome) that reaches the job's pages only. `--box` runs the
// job's tools in a box of the transport package while the run's store stays on the disk. `--record <dir>` keeps the run as
// an agentrun.recording/1 directory (validate it with scripts/recording/validate.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { FixturePage } from '@parcha/pi-browser/testing';
import { placeAt, run, type RunResult } from './assemble.ts';
import { localHost, type BrowserPlane, type LocalHost, type RunPlace, type StatusEvent } from './host.ts';
import { fakes, job } from './job.ts';
import { fold } from '../../scripts/recording/fold.mjs';
import { codeOf, finishRecording, openRecorder, openSupervisor } from './record.ts';
import { packageCommitRecorder } from './record-store.ts';

/** The run as one value: what the workflow returned, what each package did, what was spent, every fake call. */
export function summary(place: RunPlace, result: RunResult, local: LocalHost) {
  let events: StatusEvent[] = [];
  try { events = readFileSync(join(place.root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { /* none yet */ }
  const tally = (keys: string[]) => keys.reduce<Record<string, number>>((counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }), {});
  const of = <S extends StatusEvent['source']>(source: S) => events.filter((event): event is Extract<StatusEvent, { source: S }> => event.source === source);
  const ledger = local.ledger();
  return {
    status: result.status,
    ...(result.status === 'refused' ? { code: result.code, message: result.message } : {}),
    ...(result.status === 'escalated' ? { escalation: result.escalation } : {}),
    ...(result.status === 'stopped' ? { stop: result.stop } : {}),
    output: result.status === 'complete' ? result.output : null,
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

/** A Chrome of its own whose only way out is this process: it serves the job's pages as Chrome's proxy, and every
 *  other host fails to resolve. */
async function localChrome(place: RunPlace, pages: Record<string, FixturePage>): Promise<{ browser: BrowserPlane; close(): void }> {
  const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
  if (!existsSync(executablePath)) throw new Error(`--chrome needs a Chrome: none at ${executablePath}. Set CHROME_PATH.`);
  const server = createServer((request, response) => {
    const page = pages[request.url ?? ''];
    response.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
    response.end(page ? `<html><head><title>${page.title}</title></head><body>${page.html}</body></html>` : 'Not a page of this job.');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const args = [`--proxy-server=http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  const [{ cdpProvider }, { stagehandDriver }] = await Promise.all([import('@parcha/pi-browser/providers/cdp'), import('@parcha/pi-browser/driver/stagehand')]);
  const provider = cdpProvider({ chrome: { executablePath, profileRoot: join(place.root, 'chrome'), args } });
  return { browser: { provider: () => provider, driver: stagehandDriver() }, close: () => server.close() };
}

/** One box for the run: a directory of this machine whose workspace is the run's `work/`, or a container the job's
 *  files are uploaded to. Destroyed after the run, whatever happened. */
async function inBox(kind: string, place: RunPlace, files: Record<string, Uint8Array>) {
  const { boxEnv } = await import('@parcha/pi-transport/hands');
  const provider = kind === 'local' ? (await import('@parcha/pi-transport/box/local')).localBoxes({ root: join(place.root, 'boxes') })
    : kind === 'docker' ? (await import('@parcha/pi-transport/box/docker')).dockerBoxes() : undefined;
  if (!provider) throw new Error(`--box is local or docker, not ${kind}`);
  const created = await provider.create({ maxLifetimeMs: 15 * 60_000, labels: { 'agentrun-reference': place.id }, ...(kind === 'local' ? { workspace: place.work } : {}) }, ctx);
  if (!created.ok) throw created.error;
  const box = created.value;
  if (kind === 'docker') {
    const uploaded = await box.upload(Object.entries(files).map(([path, bytes]) => ({ path, bytes })), ctx);
    if (!uploaded.ok) { await box.destroy(ctx); throw uploaded.error; }
  }
  const env = Object.assign(() => boxEnv(box), { cleanup: async () => undefined });
  return { env: () => env, destroy: async () => { await box.destroy(ctx); } };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { json: { type: 'boolean' }, dir: { type: 'string' }, chrome: { type: 'boolean' }, box: { type: 'string' }, record: { type: 'string' } } });
  const place = await placeAt(values.dir);
  const chrome = values.chrome ? await localChrome(place, fakes.pages) : undefined;
  const box = values.box ? await inBox(values.box, place, job.files ?? {}) : undefined;
  const recorder = values.record ? openRecorder({ dir: values.record, commits: await packageCommitRecorder(), supervisor: openSupervisor({ dir: values.record }) }) : undefined;
  const local = localHost(place, fakes, { ...(chrome ? { browser: chrome.browser } : {}), ...(recorder ? { recorder } : {}) });
  const result = await run(place, local.host, job, box ? { env: box.env } : {}).finally(async () => { chrome?.close(); await box?.destroy(); await recorder?.detach(); });
  if (values.record) {
    const resultBlob = recorder!.blob(readFileSync(join(place.root, 'out', 'record.json')), 'json');
    finishRecording(values.record, {
      title: 'The reference job, no key', task: job.workflow.name ?? 'reference', model: `${local.host.models.lead.provider}/${local.host.models.lead.modelId}`,
      generations: result.generation, kills: 0, code: codeOf(join(import.meta.dirname, '..', '..')),
      cost: (lines) => fold(lines).cost,
      source: { run: place.id, store: join(place.store, 'run.sqlite') }, result: { blob: resultBlob, title: 'The record' },
    });
  }
  const view = summary(place, result, local);
  if (values.json) console.log(JSON.stringify(view));
  else {
    const output = view.output as { company: string; answer: string; citations: string[]; supported: boolean } | null;
    console.log(`Reference run: ${view.status}, generation ${view.did.disk.generation}, in ${place.root}`);
    if (result.status === 'refused') console.log(`  ${result.code}: ${result.message}`);
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
