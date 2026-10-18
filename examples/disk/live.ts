// The live variant of the disk demo (not the gallery's, which stays on fakes): a real Daytona sandbox is deleted in the middle of the batch, on a real Archil disk, and a new sandbox
// takes the run over. The supervisor is the reference entry's `demo()`, the place is the disk package's `archilPlace` on `daytonaHost`, and the process in each sandbox is the reference
// package's child app running this demo's job (the lead and the paid tool are scripted). Its recording comes home through the run's disk.
//
//   with-daytona -- with-archil -- env PDA_LIVE=1 PDA_LIVE_DISK=dsk-... PDA_STATE_DIR=<scratch> node examples/disk/live.ts <record-dir>
//
// Live: real Daytona sandbox deleted mid-job, real Archil disk, the template's supervisor and place; the lead is scripted.
// Each box gets the disk package (the live helper's `prepareBox`, or `prepareOnSnapshot` from a runtime snapshot: PDA_LIVE_SNAPSHOT), the workspace packages the reference child imports (packed here,
// installed in the box) and this demo's directory.
// It refuses without the keys, caps itself at 25 minutes, and sweeps at the end: every sandbox deleted and confirmed gone, the run's directory removed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archilControl, archilPlace, daytonaHost } from '@parcha/pi-durable-disk';
import { revokeBestEffort } from '../../packages/pi-durable-disk/src/claim.ts';
import { scratchDisk, scratchDiskId, REGION } from '../../packages/pi-durable-disk/test/live/_archil.ts';
import { ARCHIL_WRAPPER, confirmGone, deletePrefix, demoClosure, FLEET, guardedClient, ledger, MOUNT_ROOT, NAME_PREFIX, NODE, PACKAGE_DIR, PDA_ID, installDemoPacks, prepareBox, prepareOnSnapshot, sh } from '../../packages/pi-durable-disk/test/live/_p9.ts';
import { demo } from '@parcha/agentrun-reference';
import { fakes } from './fakes.ts';
import { job } from './job.ts';

const record = process.argv[2];
if (!record) throw new Error('usage: live.ts <record-dir>');
for (const name of ['DAYTONA_API_KEY', 'ARCHIL_API_KEY', 'PDA_LIVE_DISK', 'PDA_STATE_DIR']) if (!process.env[name]) throw new Error(`${name} is not set (with-daytona, with-archil, PDA_LIVE_DISK and PDA_STATE_DIR: see the header)`);

const root = fileURLToPath(new URL('../../', import.meta.url));
const spec = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
const runId = `disk-live-${Date.now().toString(36)}`;
const stamp = Date.now().toString(36);

// What the child imports besides the disk package: the workspace packages (the reference among them), packed once here, and this demo's directory. The pack ships the package's `dist/`, so a dist
// older than its source would run old code in the box: refuse it.
const scratch = mkdtempSync(join(tmpdir(), 'disk-live-'));
const packs = join(scratch, 'packs');
spawnSync('mkdir', ['-p', packs]);
const newest = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => Math.max(latest, entry.isDirectory() ? newest(join(dir, entry.name)) : statSync(join(dir, entry.name)).mtimeMs), 0);
for (const dir of ['dsl', 'pi', 'pi-browser', 'pi-vision', 'pi-transport', 'reference']) {
  const at = join(root, 'packages', dir);
  if (!existsSync(join(at, 'dist')) || newest(join(at, 'dist')) < newest(join(at, 'src'))) throw new Error(`packages/${dir}/dist is missing or older than its source: npm run build first (the pack ships dist)`);
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packs], { cwd: at, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`npm pack ${dir} failed: ${packed.stderr}`);
}
const demoTar = spawnSync('tar', ['-czf', '-', '--exclude=live.ts', '-C', join(root, 'examples'), 'disk'], { maxBuffer: 64 << 20 });
if (demoTar.status !== 0) throw new Error('tar of the demo failed');

// Whether the runtime snapshot's dependency closure is the one these packs need. The snapshot's name carries the commit it was built at; the closure there (the packs' third-party dependencies and
// each pack's own dependency fields, versions of the packs themselves aside) is compared with the closure at this checkout's HEAD. Offline only when they are equal: a pack that needs something
// the snapshot lacks (a newer disk package, a pack the snapshot was not built for) installs online instead. No snapshot, or one this cannot read, is online.
function snapshotCovers(name: string | undefined): { offline: boolean; why: string } {
  if (!name) return { offline: false, why: 'no snapshot' };
  const prefix = /^pda-p9-runtime-demo-([0-9a-f]{7,40})-/.exec(name)?.[1];
  if (!prefix) return { offline: false, why: `${name} is not a demo runtime snapshot by name` };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const built = git('rev-parse', '--verify', '--quiet', `${prefix}^{commit}`);
  if (built.status !== 0) return { offline: false, why: `the snapshot's commit ${prefix} is not in this checkout` };
  const bare = ({ stubs, pins }: ReturnType<typeof demoClosure>) => JSON.stringify({ stubs: Object.fromEntries(Object.entries(stubs).map(([dir, stub]) => [dir, { ...stub, version: undefined }])), pins });
  try {
    const then = bare(demoClosure(built.stdout.trim()));
    const now = bare(demoClosure(git('rev-parse', 'HEAD').stdout.trim()));
    return then === now ? { offline: true, why: `the closure at ${prefix} is the one at HEAD` } : { offline: false, why: `the closure at ${prefix} differs from HEAD's` };
  } catch (error) { return { offline: false, why: `the closure at ${prefix} cannot be read: ${String((error as Error).message).slice(0, 100)}` }; }
}
const covered = snapshotCovers(process.env.PDA_LIVE_SNAPSHOT);
console.log(`snapshot: ${process.env.PDA_LIVE_SNAPSHOT ?? 'none'}; packs install ${covered.offline ? 'offline' : 'online'} (${covered.why})`);

const client = guardedClient();
const disk = await scratchDisk();
const startedAt = Date.now();
const host = daytonaHost({
  client, snapshot: process.env.PDA_LIVE_SNAPSHOT || 'daytona-medium', target: process.env.DAYTONA_TARGET || 'us', fleet: FLEET, namePrefix: NAME_PREFIX, labels: { 'pda-p9': `disk-demo-${stamp}` },
  mountRoot: MOUNT_ROOT, node: NODE, packageDir: PACKAGE_DIR, archil: ARCHIL_WRAPPER, user: 'pda',
  runArgs: [`--app=${PACKAGE_DIR}/node_modules/@parcha/agentrun-reference/dist/child-app.js`, '--heartbeat-ms=1000', '--lease-expiry-ms=600000', '--lease-margin-ms=0'],
  env: {}, ttlMinutes: 60, startTimeoutMs: 600_000, stopTimeoutMs: 5_000,
  prepare: async (box) => {
    const t0 = Date.now();
    const lap = (what: string) => console.log(`TIMING ${new Date().toISOString()} ${box.name.slice(-6)} +${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
    lap('prepare entered (box created)');
    // Two free lines for telling the cold-mount causes apart: the runner this sandbox is on, and what the box's first outbound connection to the Archil mount endpoint costs (name lookup, then one request), run
    // alongside the prepare and finished before the mount.
    const raw = box as typeof box & { runnerId?: string };
    const warm = sh(client, box, `H=mount.green.us-east-1.aws.prod.archil.com
t=$(date +%s%N); getent hosts $H >/dev/null 2>&1; d=$(( ($(date +%s%N) - t) / 1000000 ))
t=$(date +%s%N); curl -so /dev/null -m 10 https://$H/ >/dev/null 2>&1; c=$(( ($(date +%s%N) - t) / 1000000 ))
echo "getent \${d} ms, curl \${c} ms"`, 60).then((out) => out.trim(), (error) => `probe failed: ${String((error as Error).message).slice(0, 80)}`);
    const steps = (await (process.env.PDA_LIVE_SNAPSHOT ? prepareOnSnapshot : prepareBox)(client, box)).steps;
    lap(`disk package prepared ${JSON.stringify(steps)}; runner ${raw.runnerId ?? 'unknown'}; first outbound: ${await warm}`);
    await client.upload(box, '/tmp/d4-demo.tgz', new Uint8Array(demoTar.stdout));
    lap('demo tar uploaded');
    await sh(client, box, `set -euo pipefail
sudo -n mkdir -p ${PACKAGE_DIR}/demo/examples
sudo -n tar -xzf /tmp/d4-demo.tgz -C ${PACKAGE_DIR}/demo/examples --no-same-owner
sudo -n chown -R root:root ${PACKAGE_DIR}/demo
sudo -n chmod -R a+rX,go-w ${PACKAGE_DIR}/demo
rm -f /tmp/d4-demo.tgz`, 120);
    lap('demo extracted and owned');
    // The workspace packs and pi-codemode, installed offline over the snapshot's third-party closure (installDemoPacks).
    const installed = await installDemoPacks(client, box, readdirSync(packs).map((file) => join(packs, file)), { offline: covered.offline });
    lap(`packs installed ${JSON.stringify(installed.steps)}`);
    console.log(`prepared ${box.name}: ${JSON.stringify(steps)}`);
  },
});
const makePlace = archilPlace({
  disk: scratchDiskId(), region: REGION, control: await archilControl({ apiKey: process.env.ARCHIL_API_KEY!, disk: scratchDiskId(), region: REGION }), host, id: runId, mountRoot: MOUNT_ROOT,
  ensure: { create: { uid: PDA_ID, gid: PDA_ID }, tokenTtl: '2h', tokenPrefix: 'pda-p9-', leaseExpiryMs: 600_000, stonithTimeoutMs: 30_000 },
});

// The run's directory and the directories its runner writes into (its kill requests, its recording), made over the control API with the run user as owner, so nothing the runner writes depends on a
// directory made by path (the signals/ directory is the child's kill request, which nothing else creates). DISK_LIVE_PRECREATE=0 makes only the run's directory.
const precreate = process.env.DISK_LIVE_PRECREATE === '0' ? [''] : ['', 'signals/', 'record/', ...[1, 2, 3].flatMap((n) => [`record/${n}/`, `record/${n}/.spool/`, `record/${n}/blobs/`])];
for (const dir of precreate) {
  await (disk as never as { putObject(key: string, body: string, attrs: object): Promise<unknown> }).putObject(`runs/${runId}/${dir}`, '', { uid: PDA_ID, gid: PDA_ID, mode: 0o755 });
}
// For a failed take: the launcher's log of each live sandbox, read as it runs (a deleted sandbox takes its log with it), printed at the end.
const boxLogs = new Map<string, string>();
const logTimer = setInterval(async () => {
  for (const id of ledger.ids()) {
    try {
      const box = await client.get(id);
      if (!box || box.state !== 'started') continue;
      const read = await client.exec(box, "sudo -n sh -c 'tail -c 24000 /run/pda/*.log' 2>&1", 20);
      if (read.result.trim()) boxLogs.set(id, read.result);
    } catch { /* the box is going or gone */ }
  }
}, 1_000);
let current: ReturnType<typeof makePlace> | undefined;
let outcome: Awaited<ReturnType<typeof demo>> | undefined;
let failure: unknown;
const cap = setTimeout(() => { console.error('the 25 minute cap passed: sweeping'); void sweep().finally(() => process.exit(3)); }, 25 * 60_000);
async function sweep() {
  const report: Record<string, unknown> = {};
  try { await current?.release(); } catch (error) { report.releaseError = String((error as Error).message).slice(0, 200); }
  for (const id of [...ledger.ids()]) { try { await client.remove(id); } catch { /* confirmed below */ } }
  report.aliveAfter = await confirmGone(client, 180_000);
  // What the run left on the disk (keys only), then any delegation still held on it, so the delete is not refused.
  try { console.log(`disk keys: ${(await (disk as never as { listObjects(p: string, o?: object): Promise<{ objects: { key: string }[] }> }).listObjects(`runs/${runId}/`, { recursive: true })).objects.map((o) => o.key.replace(`runs/${runId}/`, '')).join(' ')}`); } catch { /* listing is a diagnostic */ }
  await revokeBestEffort(disk as never, runId).catch(() => []);
  report.disk = await deletePrefix(disk as never, `runs/${runId}/`).catch((error) => ({ error: String((error as Error).message).slice(0, 200) }));
  rmSync(scratch, { recursive: true, force: true });
  console.log(`sweep: ${JSON.stringify(report)}`);
  return report;
}

try {
  outcome = await demo({
    self: import.meta.url, spec, job, fakes,
    place: (context) => {
      const made = makePlace({ paths: { ...context.paths }, requestFile: context.requestFile });
      current = made;
      // The order's environment, for a process in a sandbox: the supervisor's paths (its scratch directory, its loopback backend) mean nothing there. The child app finds this demo's options
      // in the sandbox's copy (DEMO_ENTRY) and records into the run's directory on the disk (RECORD_DIR), which the place brings home.
      const inBox = (order: Parameters<typeof made.start>[0]) => ({
        ...order,
        env: {
          DEMO_ENTRY: `file://${PACKAGE_DIR}/demo/examples/disk/run.ts`, DEMO_NAME: order.env.DEMO_NAME!, RUN_ID: order.env.RUN_ID!, ...(order.env.RUN_LABEL ? { RUN_LABEL: order.env.RUN_LABEL } : {}),
          KILL_REQUEST: order.env.KILL_REQUEST!, KILL_NONCE: order.env.KILL_NONCE!, PLAN: order.env.PLAN!, ...(process.env.DISK_LIVE_RECORD_IN_BOX === '1' ? { RECORD_GEN: order.env.RECORD_GEN!, RECORD_STARTED: order.env.RECORD_STARTED!, RECORD_DIR: made.recordHome!.dir(order.gen) } : {}),
          CROSS_LOG: `/tmp/crossings-${order.gen}.jsonl`, BROWSER: 'none', HOME: '/home/pda', TMPDIR: '/tmp',
        },
      });
      return { ...made, start: (order: Parameters<typeof made.start>[0]) => { console.log(`TIMING ${new Date().toISOString()} place.start called, generation ${order.gen}`); return made.start(inBox(order)); }, recover: (last: Parameters<typeof made.recover>[0], kind: Parameters<typeof made.recover>[1], order: Parameters<typeof made.recover>[2]) => { console.log(`TIMING ${new Date().toISOString()} place.recover called, generation ${order.gen}, kind ${String(kind)}`); return made.recover(last, kind, inBox(order)); } } as never;
    },
    argv: ['--kill', '--record', record, '--dir', join(process.env.PDA_STATE_DIR!, `run-${stamp}`)],
  });
} catch (error) { failure = error; }
clearTimeout(cap);
clearInterval(logTimer);
const redact = (text: string) => text.replaceAll(`${MOUNT_ROOT}/runs/${runId}`, '<mp>').replaceAll(runId, '<run>');
for (const [id, text] of boxLogs) console.log(`--- launcher log of a sandbox (${id.slice(0, 8)}) ---\n${redact(text).slice(-12000)}`);
const report = await sweep();
console.log(JSON.stringify({ run: runId, minutes: Math.round((Date.now() - startedAt) / 6000) / 10, spendUsd: ledger.spend(), ...(failure ? { failure: String((failure as Error).message).slice(0, 300) } : {}), kills: outcome?.kills ?? null, processes: outcome?.processes.map((p) => ({ exit: p.exit, status: p.outcome?.status ?? null })) ?? null, usd: outcome?.usd ?? null, report }));
process.exit(failure ? 1 : 0);
