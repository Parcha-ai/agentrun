// The live variant of the disk demo: the run lives on a real Archil disk and each process of it in a real Daytona sandbox. The supervisor is the harness entry's `demo()`, the place is the disk package's
// `archilPlace` on `daytonaHost`, and the process in each sandbox is the harness's child app running this demo's job. Its recording is written to the run's disk and brought home by the place.
//
//   PDA_LIVE=1 PDA_STATE_DIR=<scratch> [PDA_LIVE_SNAPSHOT=<name>] [DISK_LIVE_SECRET=<name>] node examples/disk/live.ts <record-dir>
//   (DAYTONA_API_KEY, ARCHIL_API_KEY and PDA_LIVE_DISK from the caller's credential wrapper)
//
// What runs: `--handoff` by default (the first sandbox releases the run at the planned crossing and a second sandbox opens it from the disk and finishes; nothing is killed), or `--kill` with
// DISK_LIVE_MODE=kill (the first sandbox is deleted there). The lead: with DISK_LIVE_SECRET, the name of a Daytona secret that holds an Anthropic key (allowed for api.anthropic.com), the run is `--live` on
// claude-sonnet-5-5 (model.ts): each sandbox is created with that secret as ANTHROPIC_API_KEY, so the box holds only Daytona's placeholder, and the instance reaches Anthropic through Daytona's egress proxy,
// which puts the key into the request's header. With DISK_LIVE_SECRET_CREATE=1 the runner makes that secret itself from ANTHROPIC_API_KEY in its own environment and deletes it at the end (below).
// Without DISK_LIVE_SECRET, the lead is scripted. DISK_LIVE_MAX_USD caps the run's spend (`--max-usd`; else twice demo.json's expectedCost).
// Each box gets the disk package (the live helper's `prepareBox`, or `prepareOnSnapshot` from a runtime snapshot: PDA_LIVE_SNAPSHOT), the workspace packages the harness child imports (packed here,
// installed in the box) and this demo's directory.
// It refuses without the keys, caps itself at 25 minutes, and sweeps at the end: every sandbox deleted and confirmed gone, the run's directory removed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archilControl, archilPlace, daytonaHost } from '@parcha/pi-durable-disk';
import { revokeBestEffort } from '../../packages/pi-durable-disk/src/claim.ts';
import { scratchDisk, scratchDiskId, REGION } from '../../packages/pi-durable-disk/test/live/_archil.ts';
import { ARCHIL_WRAPPER, confirmGone, deletePrefix, demoClosure, FLEET, guardedClient, ledger, MOUNT_ROOT, NAME_PREFIX, NODE, PACKAGE_DIR, PDA_ID, installDemoPacks, prepareBox, prepareOnSnapshot, sh } from '../../packages/pi-durable-disk/test/live/_p9.ts';
import { demo } from '@parcha/agentrun-harness';
import { fakes } from './fakes.ts';
import { job } from './job.ts';
import { KEY_ENV, live } from './model.ts';

const record = process.argv[2];
if (!record) throw new Error('usage: live.ts <record-dir>');
for (const name of ['DAYTONA_API_KEY', 'ARCHIL_API_KEY', 'PDA_LIVE_DISK', 'PDA_STATE_DIR']) if (!process.env[name]) throw new Error(`${name} is not set (see the header)`);
const mode = process.env.DISK_LIVE_MODE === 'kill' ? '--kill' : '--handoff';
const secret = process.env.DISK_LIVE_SECRET;
if (secret !== undefined && !/^[A-Za-z0-9._-]{1,100}$/.test(secret)) throw new Error('DISK_LIVE_SECRET names a Daytona secret: letters, digits, dot, dash and underscore');
const maxUsd = process.env.DISK_LIVE_MAX_USD;
if (maxUsd !== undefined && !(Number(maxUsd) > 0)) throw new Error('DISK_LIVE_MAX_USD is a number of dollars above 0');
// DISK_LIVE_SECRET_CREATE=1: the runner makes the secret itself, from the key in its own environment, allowed for the model's host only, and deletes it in the sweep. The key leaves this process only in that one
// request to Daytona's API. It is taken out of the environment here, before anything starts, so no child of this process and no order ever carries it; it is held only for the grep of what the run left here
// (the recording, the run's files, the sandboxes' logs), and never printed.
const createSecret = process.env.DISK_LIVE_SECRET_CREATE === '1';
if (createSecret && !secret) throw new Error('DISK_LIVE_SECRET_CREATE needs DISK_LIVE_SECRET, the name of the secret to create');
const heldKey = createSecret ? process.env[KEY_ENV] : undefined;
if (createSecret && !heldKey) throw new Error(`DISK_LIVE_SECRET_CREATE needs ${KEY_ENV} in the runner's environment`);
delete process.env[KEY_ENV];
/** The one host the model's secret is sent to. */
const MODEL_HOST = 'api.anthropic.com';
const daytonaBase = (process.env.DAYTONA_API_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');
/** Daytona's REST API (the organisation's secrets): status and text, never a header; errors carry the status only. */
async function daytonaApi(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${daytonaBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: await res.text().catch(() => '') };
}
/** A secret's id by its name (the organisation's first pages), or undefined. */
async function secretIdOf(name: string): Promise<string | undefined> {
  const listed = await daytonaApi('GET', '/secret/paginated');
  if (listed.status !== 200) throw new Error(`listing the organisation's secrets answered ${listed.status}`);
  return ((JSON.parse(listed.text) as { items?: { id: string; name: string }[] }).items ?? []).find((item) => item.name === name)?.id;
}
let createdSecretId: string | undefined;
let secretDelete: { status: number; getAfter: number } | undefined;

const root = fileURLToPath(new URL('../../', import.meta.url));
const spec = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
const runId = `disk-live-${Date.now().toString(36)}`;
const stamp = Date.now().toString(36);
const runDirOf = () => join(process.env.PDA_STATE_DIR!, `run-${stamp}`);

// What the child imports besides the disk package: the workspace packages (the reference among them), packed once here, and this demo's directory. The pack ships the package's `dist/`, so a dist
// older than its source would run old code in the box: refuse it.
const scratch = mkdtempSync(join(tmpdir(), 'disk-live-'));
const packs = join(scratch, 'packs');
spawnSync('mkdir', ['-p', packs]);
const newest = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => Math.max(latest, entry.isDirectory() ? newest(join(dir, entry.name)) : statSync(join(dir, entry.name)).mtimeMs), 0);
for (const dir of ['dsl', 'pi', 'pi-browser', 'pi-vision', 'pi-transport', 'harness']) {
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

const guarded = guardedClient();
// Each box is created with the model's secret attached as ANTHROPIC_API_KEY (Daytona's REST form: one name per entry). The box's environment holds Daytona's placeholder; the key itself never enters it.
const client: typeof guarded = secret ? { ...guarded, create: (body) => guarded.create({ ...body, secrets: [{ [KEY_ENV]: secret }] } as typeof body) } : guarded;
/** The instance's environment beside the order's (the driver's `env`): with the secret, read from each box as it is prepared (the placeholder and Daytona's proxy, which Node uses only when told to). */
const boxEnv: Record<string, string> = {};
const disk = await scratchDisk();
const startedAt = Date.now();
const host = daytonaHost({
  client, snapshot: process.env.PDA_LIVE_SNAPSHOT || 'daytona-medium', target: process.env.DAYTONA_TARGET || 'us', fleet: FLEET, namePrefix: NAME_PREFIX, labels: { 'pda-p9': `disk-demo-${stamp}` },
  mountRoot: MOUNT_ROOT, node: NODE, packageDir: PACKAGE_DIR, archil: ARCHIL_WRAPPER, user: 'pda',
  runArgs: [`--app=${PACKAGE_DIR}/node_modules/@parcha/agentrun-harness/dist/child-app.js`, '--heartbeat-ms=1000', '--lease-expiry-ms=600000', '--lease-margin-ms=0'],
  env: boxEnv, ttlMinutes: 60, startTimeoutMs: 600_000, stopTimeoutMs: 5_000,
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
    if (secret) {
      // The names the model call needs, read in the box: the secret's placeholder and Daytona's egress proxy with its CA (the proxy carries no credential). A value that is not a placeholder is refused: a key
      // never goes into an instance's environment from here. Only the names are printed.
      const read = await sh(client, box, `for v in ${KEY_ENV} HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_EXTRA_CA_CERTS; do printf '%s=%s\\n' "$v" "$(printenv "$v")"; done`, 30);
      const got = Object.fromEntries(read.split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      if (!/^dtn_secret_[A-Za-z0-9_-]+$/.test(got[KEY_ENV] ?? '')) throw new Error(`the box's ${KEY_ENV} is not a Daytona secret's placeholder: is ${secret} a secret of this organisation?`);
      for (const name of ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']) if (!got[name]) throw new Error(`the box has no ${name}: Daytona's egress proxy, which puts the key into the request, is not set`);
      Object.assign(boxEnv, got, { NODE_USE_ENV_PROXY: '1' });
      lap(`the model's secret is attached (placeholder) and the proxy set: ${Object.keys(got).filter((name) => got[name]).join(', ')}`);
    }
    console.log(`prepared ${box.name}: ${JSON.stringify(steps)}`);
  },
});
const control = await archilControl({ apiKey: process.env.ARCHIL_API_KEY!, disk: scratchDiskId(), region: REGION });
const makePlace = archilPlace({
  disk: scratchDiskId(), region: REGION, control, host, id: runId, mountRoot: MOUNT_ROOT,
  ensure: { create: { uid: PDA_ID, gid: PDA_ID }, tokenTtl: '2h', tokenPrefix: 'pda-p9-', leaseExpiryMs: 600_000, stonithTimeoutMs: 30_000 },
});

// The run's directory and the directories its runner writes into (its kill requests, its recording), made over the control API with the run user as owner, so nothing the runner writes depends on a
// directory made by path (the signals/ directory is the child's kill request, which nothing else creates). DISK_LIVE_PRECREATE=0 makes only the run's directory.
const precreate = process.env.DISK_LIVE_PRECREATE === '0' ? [''] : ['', 'signals/', 'record/', ...[1, 2, 3].flatMap((n) => [`record/${n}/`, `record/${n}/.spool/`, `record/${n}/blobs/`])];
for (const dir of precreate) {
  await (disk as never as { putObject(key: string, body: string, attrs: object): Promise<unknown> }).putObject(`runs/${runId}/${dir}`, '', { uid: PDA_ID, gid: PDA_ID, mode: 0o755 });
}
// What the report and the by-code checks need of the run, which lives on the disk: its ledger, the kept answers and work/ (the report among it), read over S3 into the supervisor's run directory after
// each process, so the entry takes the agent's report from there as it does on a directory of its own. Never the store, never the claim's files.
async function bringRunHome(into: string): Promise<void> {
  const prefix = `runs/${runId}/`;
  const { objects } = await control.listObjects(prefix, { recursive: true });
  for (const object of objects) {
    const rel = object.key.slice(prefix.length);
    if (rel.endsWith('/') || !(rel === 'ledger.jsonl' || rel.startsWith('answers/') || rel.startsWith('work/'))) continue;
    if (rel.split('/').some((part) => part === '..' || part === '')) continue;
    const to = join(into, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, await control.getObject(object.key));
  }
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
  // The model's secret, when this runner made it: deleted, and read back to show it is gone. Once, also from the 25 minute cap.
  if (createdSecretId && !secretDelete) {
    try {
      const deleted = await daytonaApi('DELETE', `/secret/${createdSecretId}`);
      const after = await daytonaApi('GET', `/secret/${createdSecretId}`);
      secretDelete = { status: deleted.status, getAfter: after.status };
      ledger.event('daytona-secret-deleted', { name: secret ?? null, id: createdSecretId, status: deleted.status, getAfter: after.status });
    } catch (error) {
      report.secretDeleteError = String((error as Error).message).slice(0, 200);
    }
    console.log(`the model's secret ${secret}: DELETE answered ${secretDelete?.status ?? 'nothing'}, a GET after it ${secretDelete?.getAfter ?? 'nothing'}`);
    report.secretDelete = secretDelete ?? null;
  }
  console.log(`sweep: ${JSON.stringify(report)}`);
  return report;
}

try {
  if (createSecret) {
    if (await secretIdOf(secret!)) throw new Error(`a secret named ${secret} already exists: this runner makes its own and deletes it, and never overwrites one`);
    const made = await daytonaApi('POST', '/secret', { name: secret, value: heldKey, description: 'the disk take model key; deleted by the runner at its end', hosts: [MODEL_HOST] });
    if (made.status >= 300) throw new Error(`creating the model's secret answered ${made.status}`);
    createdSecretId = (JSON.parse(made.text) as { id?: string }).id ?? (await secretIdOf(secret!));
    if (!createdSecretId) throw new Error("the model's secret was created but its id cannot be read");
    ledger.event('daytona-secret-created', { name: secret!, id: createdSecretId, hosts: MODEL_HOST });
    console.log(`the model's secret ${secret} is made, allowed for ${MODEL_HOST} only`);
  }
  outcome = await demo({
    self: import.meta.url, spec, job, fakes, live,
    place: (context) => {
      const made = makePlace({ paths: { ...context.paths }, requestFile: context.requestFile });
      current = made;
      // The order's environment, for a process in a sandbox: the supervisor's paths (its scratch directory, its loopback backend) mean nothing there. The child app finds this demo's options
      // in the sandbox's copy (DEMO_ENTRY) and records into the run's directory on the disk (RECORD_DIR), which the place brings home.
      // The crossing log is the supervisor's evidence of where a process stopped (a handoff is told by it): the process writes it in the run's directory on the disk, and once the process has ended it is
      // read over S3 into the supervisor's own file, before the supervisor reads it.
      const crossings = (gen: number) => posix.join(made.paths.root, 'signals', `crossings-${gen}.jsonl`);
      const homeCrossings = (order: Parameters<typeof made.start>[0]) => async <T>(exit: T): Promise<T> => {
        try { writeFileSync(order.env.CROSS_LOG!, await control.getObject(`runs/${runId}/signals/crossings-${order.gen}.jsonl`)); } catch (error) { console.log(`the crossing log of process ${order.gen} could not be read: ${String((error as Error).message).slice(0, 120)}`); }
        try { await bringRunHome(context.paths.root); } catch (error) { console.log(`the run's files could not be brought home after process ${order.gen}: ${String((error as Error).message).slice(0, 120)}`); }
        return exit;
      };
      const inBox = (order: Parameters<typeof made.start>[0]) => ({
        ...order,
        env: {
          DEMO_ENTRY: `file://${PACKAGE_DIR}/demo/examples/disk/run.ts`, DEMO_NAME: order.env.DEMO_NAME!, RUN_ID: order.env.RUN_ID!, ...(order.env.RUN_LABEL ? { RUN_LABEL: order.env.RUN_LABEL } : {}),
          KILL_REQUEST: order.env.KILL_REQUEST!, KILL_NONCE: order.env.KILL_NONCE!, PLAN: order.env.PLAN!, ...(order.env.LIVE ? { LIVE: order.env.LIVE } : {}), ...(order.env.MODELS ? { MODELS: order.env.MODELS } : {}), ...(order.env.INPUT ? { INPUT: order.env.INPUT } : {}),
          ...(process.env.DISK_LIVE_RECORD_IN_BOX !== '0' ? { RECORD_GEN: order.env.RECORD_GEN!, RECORD_STARTED: order.env.RECORD_STARTED!, RECORD_DIR: made.recordHome!.dir(order.gen) } : {}),
          CROSS_LOG: crossings(order.gen), BROWSER: 'none', HOME: '/home/pda', TMPDIR: '/tmp',
        },
      });
      return { ...made, start: async (order: Parameters<typeof made.start>[0]) => { console.log(`TIMING ${new Date().toISOString()} place.start called, generation ${order.gen}`); const runner = await made.start(inBox(order)); return { ...runner, exited: runner.exited.then(homeCrossings(order)) }; }, recover: async (last: Parameters<typeof made.recover>[0], kind: Parameters<typeof made.recover>[1], order: Parameters<typeof made.recover>[2]) => { console.log(`TIMING ${new Date().toISOString()} place.recover called, generation ${order.gen}, kind ${String(kind)}`); const recovered = await made.recover(last, kind, inBox(order)); return { ...recovered, runner: { ...recovered.runner, exited: recovered.runner.exited.then(homeCrossings(order)) } }; } } as never;
    },
    argv: [mode, ...(secret ? ['--live'] : []), ...(maxUsd ? ['--max-usd', maxUsd] : []), '--record', record, '--dir', runDirOf()],
  });
} catch (error) { failure = error; }
clearTimeout(cap);
clearInterval(logTimer);
const redact = (text: string) => text.replaceAll(`${MOUNT_ROOT}/runs/${runId}`, '<mp>').replaceAll(runId, '<run>');
for (const [id, text] of boxLogs) console.log(`--- launcher log of a sandbox (${id.slice(0, 8)}) ---\n${redact(text).slice(-12000)}`);
// The by-code checks of the review (no model judges these), on the recording and the run's files brought home, before anything is published. The sweep runs whatever they do.
const runDir = runDirOf();
let checks: string[] | null = null;
let checkError: string | undefined;
let report: Awaited<ReturnType<typeof sweep>>;
try {
  const { reviewProblems } = (await import(new URL('../disk-review-checks.mjs', import.meta.url).href)) as { reviewProblems: (input: { recording: string; dir: string; record: unknown; live: boolean }) => string[] };
  checks = outcome && existsSync(join(record, 'events.jsonl')) ? reviewProblems({ recording: record, dir: runDir, record: outcome.record, live: Boolean(secret) }) : null;
  if (checks) console.log(checks.length ? `by-code checks: ${checks.length} problem(s)\n${checks.map((problem) => `  - ${problem}`).join('\n')}` : 'by-code checks: none failed');
} catch (error) {
  checkError = String((error as Error).message).slice(0, 300);
  console.log(`by-code checks could not run: ${checkError}`);
} finally {
  report = await sweep();
}
// The key, when this runner held it, must be nowhere in what the run left here: the recording, the run's files brought home, and the sandboxes' logs. A count of files, never the value.
let keyHits: number | null = null;
if (heldKey) {
  let hits = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.isFile() && readFileSync(at).includes(heldKey)) hits += 1;
    }
  };
  for (const dir of [record, runDir]) if (existsSync(dir)) walk(dir);
  for (const text of boxLogs.values()) if (text.includes(heldKey)) hits += 1;
  keyHits = hits;
  console.log(`the key in what the run left here: ${keyHits} file(s) or log(s)`);
}
// A take succeeds only when the run delivered, every planned handoff landed, nothing went over the cap or failed to stop, the checks ran and found nothing, and the sweep left nothing behind.
const why = [
  ...(failure ? [`the run threw: ${String((failure as Error).message).slice(0, 120)}`] : []),
  ...(outcome && outcome.processes.at(-1)?.outcome?.status !== 'complete' ? [`the last process ended ${outcome.processes.at(-1)?.outcome?.status ?? 'with no outcome'}`] : []),
  ...(outcome?.failedHandoffs.length ? [`${outcome.failedHandoffs.length} planned handoff(s) did not land`] : []),
  ...(outcome?.failedKills.length || outcome?.failedSignals.length || outcome?.unlanded.length ? ['a planned kill or signal did not land'] : []),
  ...(outcome?.overBudget ? ['the run went over --max-usd'] : []),
  ...(checkError ? ['the by-code checks could not run'] : checks === null ? ['the by-code checks had no recording to read'] : checks.length ? [`the by-code checks found ${checks.length} problem(s)`] : []),
  ...((report.aliveAfter as unknown[] | undefined)?.length ? ['a sandbox is still alive after the sweep'] : []),
  ...(report.releaseError ? ['the place did not release cleanly'] : []),
  ...(keyHits ? ['the key is in what the run left here'] : []),
  ...(createdSecretId && !(secretDelete && secretDelete.status < 300 && secretDelete.getAfter === 404) ? ["the model's secret is not confirmed deleted"] : []),
  ...(((report.disk as { left?: number; error?: string } | undefined)?.left ?? 0) > 0 || (report.disk as { error?: string } | undefined)?.error ? ["the run's directory is still on the disk"] : []),
];
console.log(JSON.stringify({ run: runId, minutes: Math.round((Date.now() - startedAt) / 6000) / 10, spendUsd: ledger.spend(), ...(failure ? { failure: String((failure as Error).message).slice(0, 300) } : {}), mode, live: Boolean(secret), kills: outcome?.kills ?? null, handoffs: outcome?.handoffs ?? null, failedHandoffs: outcome?.failedHandoffs ?? null, processes: outcome?.processes.map((p) => ({ exit: p.exit, status: p.outcome?.status ?? null })) ?? null, usd: outcome?.usd ?? null, overBudget: outcome?.overBudget ?? null, checks, secret: secret ? { name: secret, created: Boolean(createdSecretId), deleted: secretDelete ?? null } : null, keyHits, ok: why.length === 0, ...(why.length ? { why } : {}), report }));
process.exit(why.length ? 1 : 0);
