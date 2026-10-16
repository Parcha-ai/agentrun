// The live variant of the disk demo (not the gallery's, which stays on fakes): a real Daytona sandbox is deleted in the middle of the batch, on a real Archil disk, and a new sandbox
// takes the run over. The supervisor is the reference entry's `demo()` and the place is the disk package's `archilPlace` on `daytonaHost`; the lead is scripted (live-app.ts).
//
//   with-daytona -- with-archil -- env PDA_LIVE=1 PDA_LIVE_DISK=dsk-... PDA_STATE_DIR=<scratch> node examples/disk/live.ts <record-dir>
//
// It refuses without the keys, caps itself at 25 minutes, and sweeps at the end: every sandbox it made deleted and confirmed gone, the run's directory and the mount tokens removed.
// Live: real Daytona sandbox deleted mid-job, real Archil disk, the template's supervisor and place; the lead is scripted. Needs test/live/_p9.ts's prepareBox to install with `npm install`
// (the package has no lockfile for its `npm ci`; D2's helper, patched in the scratch run that proved this).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archilPlace, daytonaHost } from '@parcha/pi-durable-disk';
import { scratchDisk, scratchDiskId, REGION } from '../../packages/pi-durable-disk/test/live/_archil.ts';
import { ARCHIL_WRAPPER, confirmGone, deletePrefix, FLEET, guardedClient, ledger, MOUNT_ROOT, NAME_PREFIX, NODE, PACKAGE_DIR, PDA_ID, prepareBox } from '../../packages/pi-durable-disk/test/live/_p9.ts';
import { demo } from '../reference/index.ts';
import { fakes } from './fakes.ts';
import { job } from './job.ts';

const record = process.argv[2];
if (!record) throw new Error('usage: live.ts <record-dir>');
for (const name of ['DAYTONA_API_KEY', 'ARCHIL_API_KEY', 'PDA_LIVE_DISK', 'PDA_STATE_DIR']) if (!process.env[name]) throw new Error(`${name} is not set (with-daytona, with-archil, PDA_LIVE_DISK and PDA_STATE_DIR: see the header)`);

const spec = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
const runId = `disk-live-${Date.now().toString(36)}`;
const stamp = Date.now().toString(36);
const packageHere = fileURLToPath(new URL('../../packages/pi-durable-disk/', import.meta.url));
const fixture = join(packageHere, 'test/fixtures/disk-live-app.ts');

// The box app goes into the package's tarball (prepareBox ships this checkout's package directory), importing the package from its own source there.
mkdirSync(join(packageHere, 'test/fixtures'), { recursive: true });
copyFileSync(new URL('./live-app.ts', import.meta.url), fixture);
const text = readFileSync(fixture, 'utf8').replace("from '@parcha/pi-durable-disk'", "from '../../src/index.ts'");
writeFileSync(fixture, text);

const client = guardedClient();
const disk = await scratchDisk();
const startedAt = Date.now();
const host = daytonaHost({
  client, snapshot: 'daytona-medium', target: process.env.DAYTONA_TARGET || 'us', fleet: FLEET, namePrefix: NAME_PREFIX, labels: { 'pda-p9': `disk-demo-${stamp}` },
  mountRoot: MOUNT_ROOT, node: NODE, packageDir: PACKAGE_DIR, archil: ARCHIL_WRAPPER, user: 'pda',
  runArgs: [`--app=${PACKAGE_DIR}/test/fixtures/disk-live-app.ts`, '--heartbeat-ms=1000', '--lease-expiry-ms=600000', '--lease-margin-ms=0'],
  env: {}, ttlMinutes: 60, startTimeoutMs: 420_000, stopTimeoutMs: 5_000,
  prepare: async (box) => void console.log(`prepared ${box.name}: ${JSON.stringify((await prepareBox(client, box)).steps)}`),
});
const makePlace = archilPlace({
  disk: scratchDiskId(), region: REGION, control: disk as never, host, id: runId, mountRoot: MOUNT_ROOT,
  ensure: { create: { uid: PDA_ID, gid: PDA_ID }, tokenTtl: '2h', tokenPrefix: 'pda-p9-', leaseExpiryMs: 600_000, stonithTimeoutMs: 30_000 },
});

let current: { release(): Promise<void> } | undefined;
let outcome: Awaited<ReturnType<typeof demo>> | undefined;
let failure: unknown;
const cap = setTimeout(() => { console.error('the 25 minute cap passed: sweeping'); void sweep().finally(() => process.exit(3)); }, 25 * 60_000);
async function sweep() {
  const report: Record<string, unknown> = {};
  try { await place_release(); } catch (error) { report.releaseError = String((error as Error).message).slice(0, 200); }
  for (const id of [...ledger.ids()]) { try { await client.remove(id); } catch { /* confirmed below */ } }
  report.aliveAfter = await confirmGone(client, 180_000);
  report.disk = await deletePrefix(disk as never, `runs/${runId}/`).catch((error) => ({ error: String((error as Error).message).slice(0, 200) }));
  rmSync(fixture, { force: true });
  console.log(`sweep: ${JSON.stringify(report)}`);
  return report;
}
async function place_release() { /* demo()'s supervisor releases the place in its own finally; a second release is safe */ await current?.release(); }

try {
  outcome = await demo({
    self: import.meta.url, spec, job, fakes,
    // The package's Place and the reference's are one shape (the package adds a terminal `signals-failed` signal the supervisor ignores).
    place: (context) => { const made = makePlace({ paths: { ...context.paths }, requestFile: context.requestFile }); current = made; return made as never; },
    argv: ['--kill', '--record', record, '--dir', join(process.env.PDA_STATE_DIR!, `run-${stamp}`)],
  });
} catch (error) { failure = error; }
clearTimeout(cap);
// The ledger of payments, read from the disk before the sweep.
let ledgerLines: string[] = [];
try { ledgerLines = new TextDecoder().decode(await (disk as never as { getObject(key: string): Promise<Uint8Array> }).getObject(`runs/${runId}/work/charges.log`)).split('\n').filter(Boolean); } catch (error) { console.log(`charges.log not read: ${String((error as Error).message).slice(0, 120)}`); }
console.log(`charges on the disk: ${ledgerLines.length}; by generation: ${JSON.stringify(ledgerLines.reduce<Record<string, number>>((all, line) => ({ ...all, [line.split('\t')[3] ?? '?']: (all[line.split('\t')[3] ?? '?'] ?? 0) + 1 }), {}))}`);
console.log(`ledger invoices: ${ledgerLines.map((line) => line.split('\t')[0]).join(' ')}`);
const report = await sweep();
console.log(JSON.stringify({ run: runId, minutes: Math.round((Date.now() - startedAt) / 6000) / 10, spendUsd: ledger.spend(), ...(failure ? { failure: String((failure as Error).message).slice(0, 300) } : {}), kills: outcome?.kills ?? null, processes: outcome?.processes.map((p) => ({ exit: p.exit, status: p.outcome?.status ?? null })) ?? null, report }));
process.exit(failure ? 1 : 0);
