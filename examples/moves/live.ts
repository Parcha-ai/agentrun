// The live variant of the moves demo: the run lives on a real Archil disk, its first and third process on this machine and its second in a Modal VM, and on
// the VM the session forks 8 threads whose tools run in 8 H100 sandboxes. The supervisor is the harness entry's `demo()`; the place is the disk package's
// `archilPlace` over a host that is this machine for processes 1 and 3 and `modalHost` for process 2 (rotate.ts).
//
//   MOVES_LIVE=1 node examples/moves/live.ts <record-dir>
//   run under the credential wrappers: ARCHIL_API_KEY, PDA_LIVE_DISK and PDA_LIVE_REGION (the disk), MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (the VM and the sweep), and
//   ANTHROPIC_API_KEY (the processes on this machine). `npm i --no-save modal@0.11.0` first: the SDK is not a dependency of the repository.
//
// The VM never holds a key this runner read: it takes ANTHROPIC_API_KEY, MODAL_TOKEN_ID and MODAL_TOKEN_SECRET from two Modal Secrets, named here and made by whoever runs
// this (MOVES_SECRET_ANTHROPIC, default `moves-take-anthropic`; MOVES_SECRET_MODAL, default `moves-take-modal`). The launcher copies them into the instance's environment
// by name (`inheritEnv`), so no value passes through this process on the way. This process holds its three values for one thing: to look for them, afterwards, in everything
// the run left here. MOVES_LIVE_MAX_USD caps the model spend (`--max-usd`, default 8). The run is capped at 60 minutes, and ends by sweeping, by exact id: every VM and
// thread sandbox terminated and confirmed gone, the run's directory and mount tokens removed. The Modal Secrets are not this runner's: the caller deletes them.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archilControl, archilPlace, deleteRunTree, localHost, modalHost } from '@parcha/pi-durable-disk';
import type { HostDriver, ModalSdk } from '@parcha/pi-durable-disk';
import { removeMountToken } from '@parcha/pi-durable-disk/internals';
import { demo } from '@parcha/agentrun-harness';
import { THREADS } from './config.ts';
import { fakes } from './fakes.ts';
import { job } from './job.ts';
import { APP, KEY_ENV, live } from './model.ts';
import { rotatingHost } from './rotate.ts';
import { appTarball, IMAGE_COMMANDS, PACKS, packTarball, prepareVm, VM } from './vm.ts';

const record = process.argv[2];
if (process.env.MOVES_LIVE !== '1' || !record) throw new Error('usage: MOVES_LIVE=1 node examples/moves/live.ts <record-dir> (see the header)');
const NEEDED = ['ARCHIL_API_KEY', 'PDA_LIVE_DISK', 'PDA_LIVE_REGION', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', KEY_ENV];
for (const name of NEEDED) if (!process.env[name]) throw new Error(`${name} is not set (see the header)`);
const SECRET_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const secretNames = [process.env.MOVES_SECRET_ANTHROPIC ?? 'moves-take-anthropic', process.env.MOVES_SECRET_MODAL ?? 'moves-take-modal'];
for (const name of secretNames) if (!SECRET_NAME.test(name)) throw new Error('a Modal Secret name is letters, digits, dot, dash and underscore');
const maxUsd = process.env.MOVES_LIVE_MAX_USD ?? '8';
if (!(Number(maxUsd) > 0)) throw new Error('MOVES_LIVE_MAX_USD is a number of dollars above 0');

// The three values this process holds, and nothing else of them: out of the environment before anything starts, so no child of this process and no order carries them. The local
// processes get the model key through their host's own environment option; the Modal token opens this process's SDK client, which holds it by value. The values are kept
// to look for them in what the run left, and never printed.
const held = { anthropic: process.env[KEY_ENV]!, modalId: process.env.MODAL_TOKEN_ID!, modalSecret: process.env.MODAL_TOKEN_SECRET! };
for (const name of [KEY_ENV, 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET']) delete process.env[name];
const secretValues = Object.values(held);

const root = fileURLToPath(new URL('../../', import.meta.url));
const spec = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
const stamp = Date.now().toString(36);
const runId = `moves-live-${stamp}`;
const disk = process.env.PDA_LIVE_DISK!;
const region = process.env.PDA_LIVE_REGION!;
const stateDir = process.env.PDA_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'moves-live-'));
mkdirSync(stateDir, { recursive: true });
const runDir = join(stateDir, `run-${stamp}`);
/** The ids of everything this run made on Modal, written before the call that makes it returns, for the sweep and for nobody else. */
const ledger = (event: string, data: Record<string, unknown>) => appendFileSync(join(stateDir, `ledger-${stamp}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);

// ---- what the VM is made from (packed from this checkout, which must be built) ---------------------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'moves-packs-'));
const versionOf = (name: string): string => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version as string;
for (const dir of ['pi-durable-disk', ...PACKS]) {
  const at = join(root, 'packages', dir);
  if (!existsSync(join(at, 'dist'))) throw new Error(`packages/${dir}/dist is missing: npm run build first (the pack ships dist)`);
}
const diskPack = packTarball(join(root, 'packages', 'pi-durable-disk'), scratch);
const packs: Record<string, Uint8Array> = {};
for (const dir of PACKS) { const packed = packTarball(join(root, 'packages', dir), scratch); packs[packed.file] = packed.bytes; }
const extra = ['@earendil-works/pi-durable', '@earendil-works/chord', '@earendil-works/pi-ai', '@earendil-works/pi-codemode'].map((name) => `${name}@${versionOf(name)}`).concat('modal@0.11.0');

// ---- Modal: one client; every sandbox it creates is in the ledger as it returns -----------------------------------------------------------------------------------
type ModalClientLike = { secrets: { fromName(name: string): Promise<unknown> }; images: { fromRegistry(tag: string): { dockerfileCommands(commands: string[]): unknown } } } & ModalSdk;
const { ModalClient } = (await import('modal' as string)) as { ModalClient: new (options?: unknown) => ModalClientLike };
const modal = new ModalClient({ tokenId: held.modalId, tokenSecret: held.modalSecret });
for (const name of secretNames) await modal.secrets.fromName(name).catch((error: unknown) => { throw new Error(`the Modal Secret ${name} cannot be read: ${String((error as Error).message).slice(0, 160)}`); });
const vmIds = new Set<string>();
const sdk: ModalSdk = {
  apps: modal.apps,
  images: modal.images,
  secrets: modal.secrets,
  sandboxes: {
    create: async (app, image, params) => {
      const box = await modal.sandboxes.create(app, image, params);
      vmIds.add(box.sandboxId);
      ledger('vm-created', { id: box.sandboxId, name: params.name });
      return box;
    },
    fromId: (id) => modal.sandboxes.fromId(id),
    fromName: (app, name) => modal.sandboxes.fromName(app, name),
    list: (params) => modal.sandboxes.list(params),
  },
};

// ---- the hosts -------------------------------------------------------------------------------------------------------------------------------------------------------
const uid = process.getuid!();
const gid = process.getgid!();
const FLEET = `moves-${stamp}`;
const HEARTBEAT = ['--heartbeat-ms=1000', '--lease-expiry-ms=600000', '--lease-margin-ms=0'];
const childApp = fileURLToPath(import.meta.resolve('@parcha/agentrun-harness/child-app'));
const local = localHost({
  mode: 'child', hostName: 'moves-local', mountRoot: VM.mountRoot, user: uid, group: gid, archil: join(root, 'packages', 'pi-durable-disk', 'bin', 'archil-scoped'),
  runArgs: [`--app=${childApp}`, ...HEARTBEAT], env: { [KEY_ENV]: held.anthropic }, stopTimeoutMs: 10_000,
});
const vm = modalHost({
  sdk, appName: APP, image: () => modal.images.fromRegistry('ubuntu:24.04').dockerfileCommands(IMAGE_COMMANDS),
  runtime: 'vm', regions: ['us-east'], cpu: 4, memoryMiB: 8192,
  fleet: FLEET, namePrefix: 'pda-moves-', labels: { 'pda-moves': stamp }, mountRoot: VM.mountRoot, node: VM.node, packageDir: VM.packageDir, archil: VM.archil, user: String(uid), group: String(gid),
  runArgs: [`--app=${VM.packageDir}/node_modules/@parcha/agentrun-harness/dist/child-app.js`, ...HEARTBEAT],
  secrets: secretNames, inheritEnv: [KEY_ENV, 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
  prepare: prepareVm({ uid, gid, disk: diskPack.bytes, packs, app: appTarball(dirname(fileURLToPath(import.meta.url))), extra }) as never,
  startTimeoutMs: 900_000, stopTimeoutMs: 30_000, ttlMinutes: 120,
});
const host: HostDriver = rotatingHost({ local, modal: vm }, ['local', 'modal']);

const control = await archilControl({ apiKey: process.env.ARCHIL_API_KEY!, disk, region });
const makePlace = archilPlace({
  disk, region, control, host, id: runId, mountRoot: VM.mountRoot,
  ensure: { create: { uid, gid }, tokenTtl: '2h', tokenPrefix: 'pda-moves-', leaseExpiryMs: 600_000, stonithTimeoutMs: 30_000 },
});

// The run's directory and what its runner writes into (its kill requests, its recording), made over the control API with the run user as owner, so nothing a runner writes
// depends on a directory made by path.
for (const dir of ['', 'signals/', 'record/', ...[1, 2, 3].flatMap((n) => [`record/${n}/`, `record/${n}/.spool/`, `record/${n}/blobs/`])]) {
  await control.putObject(`runs/${runId}/${dir}`, '', { uid, gid, mode: 0o755 });
}
// What the checks and the report need of the run, which lives on the disk: its ledger, the kept answers, work/ (threads.json and result.json among it) and the thread
// sandboxes' ledger, read over S3 into the supervisor's run directory after each process. Never the store, never the claim's files.
async function bringRunHome(into: string): Promise<void> {
  const prefix = `runs/${runId}/`;
  const { objects } = await control.listObjects(prefix, { recursive: true });
  for (const object of objects) {
    const rel = object.key.slice(prefix.length);
    if (rel.endsWith('/') || !(rel === 'ledger.jsonl' || rel === 'boxes.jsonl' || rel.startsWith('answers/') || rel.startsWith('work/'))) continue;
    if (rel.split('/').some((part) => part === '..' || part === '')) continue;
    const to = join(into, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, await control.getObject(object.key));
  }
}

let current: ReturnType<typeof makePlace> | undefined;
let outcome: Awaited<ReturnType<typeof demo>> | undefined;
let failure: unknown;
const startedAt = Date.now();

async function sweep(): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  try { await current?.release(); } catch (error) { report.releaseError = String((error as Error).message).slice(0, 200); }
  // The VMs this runner created, then whatever else carries this run's tags (the threads' sandboxes are tagged with the run; the VMs with the fleet), by exact id.
  const app = await modal.apps.fromName(APP, { createIfMissing: false }).catch(() => undefined);
  const found = async (tags: Record<string, string>): Promise<string[]> => {
    if (!app) return [];
    const ids: string[] = [];
    for await (const box of modal.sandboxes.list({ appId: app.appId, tags })) ids.push(box.sandboxId);
    return ids;
  };
  const toEnd = new Set<string>(vmIds);
  for (const id of await found({ run: runId }).catch(() => [])) toEnd.add(id);
  for (const id of await found({ 'pda-fleet': FLEET }).catch(() => [])) toEnd.add(id);
  report.sandboxes = toEnd.size;
  for (const id of toEnd) { await (await modal.sandboxes.fromId(id)).terminate().then(() => ledger('sandbox-terminated', { id }), (error: unknown) => ledger('sandbox-terminate-failed', { id, error: String((error as Error).message).slice(0, 120) })); }
  // Gone means gone: each id polled until it has ended, a minute at most.
  const alive: string[] = [];
  for (const id of toEnd) {
    let ended = false;
    for (let i = 0; i < 30 && !ended; i += 1) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 2_000));
      ended = await modal.sandboxes.fromId(id).then((box) => box.poll().then((code) => code !== null), () => true).catch(() => true);
    }
    if (!ended) alive.push(id);
  }
  report.aliveAfter = alive.length;
  report.taggedAfter = (await found({ run: runId }).catch(() => [])).length + (await found({ 'pda-fleet': FLEET }).catch(() => [])).length;
  // The disk: the run's tree (revoking what still holds it), then each mount token this run minted.
  report.disk = await deleteRunTree(control, runId).catch((error) => ({ error: String((error as Error).message).slice(0, 200) }));
  const users = (await control.listUsers().catch(() => [])).filter((user) => String(user.nickname ?? '').includes(runId));
  let removed = 0;
  for (const user of users) if (await removeMountToken(control, String(user.identifier)).then(() => true, () => false)) removed += 1;
  report.tokenUsers = { found: users.length, removed };
  rmSync(scratch, { recursive: true, force: true });
  console.log(`sweep: ${JSON.stringify(report)}`);
  return report;
}
const cap = setTimeout(() => { console.error('the 60 minute cap passed: sweeping'); void sweep().finally(() => process.exit(3)); }, 60 * 60_000);

try {
  outcome = await demo({
    self: import.meta.url, spec, job, fakes, live,
    place: (context) => {
      const made = makePlace({ paths: { ...context.paths }, requestFile: context.requestFile });
      current = made;
      // The order's environment, for a process on a host: the supervisor's paths (its scratch directory, its loopback backend) mean nothing there. The child app finds this demo's
      // options in the host's copy (DEMO_ENTRY: this checkout for processes 1 and 3, the VM's own copy for 2) and records into the run's directory on the disk (RECORD_DIR), which the
      // place brings home. The crossing log is the supervisor's evidence of where a process stopped: written in the run's directory on the disk, read over S3 into the supervisor's
      // own file once the process has ended.
      const hostOf = (gen: number) => (gen % 2 === 0 ? 'modal' : 'local');
      const crossings = (gen: number) => posix.join(made.paths.root, 'signals', `crossings-${gen}.jsonl`);
      const homeCrossings = (order: Parameters<typeof made.start>[0]) => async <T>(exit: T): Promise<T> => {
        try { writeFileSync(order.env.CROSS_LOG!, await control.getObject(`runs/${runId}/signals/crossings-${order.gen}.jsonl`)); } catch (error) { console.log(`the crossing log of process ${order.gen} could not be read: ${String((error as Error).message).slice(0, 120)}`); }
        try { await bringRunHome(context.paths.root); } catch (error) { console.log(`the run's files could not be brought home after process ${order.gen}: ${String((error as Error).message).slice(0, 120)}`); }
        return exit;
      };
      const inBox = (order: Parameters<typeof made.start>[0]) => {
        const where = hostOf(order.gen);
        return {
          ...order,
          env: {
            DEMO_ENTRY: where === 'modal' ? `file://${VM.demoDir}/run.ts` : `file://${root}examples/moves/run.ts`, DEMO_NAME: order.env.DEMO_NAME!, RUN_ID: order.env.RUN_ID!, ...(order.env.RUN_LABEL ? { RUN_LABEL: order.env.RUN_LABEL } : {}),
            KILL_REQUEST: order.env.KILL_REQUEST!, KILL_NONCE: order.env.KILL_NONCE!, PLAN: order.env.PLAN!, ...(order.env.LIVE ? { LIVE: order.env.LIVE } : {}), ...(order.env.MODELS ? { MODELS: order.env.MODELS } : {}), ...(order.env.INPUT ? { INPUT: order.env.INPUT } : {}),
            RECORD_GEN: order.env.RECORD_GEN!, RECORD_STARTED: order.env.RECORD_STARTED!, RECORD_DIR: made.recordHome!.dir(order.gen),
            CROSS_LOG: crossings(order.gen), BROWSER: 'none', HOME: where === 'modal' ? '/home/pda' : process.env.HOME!, TMPDIR: '/tmp', MOVES_HOST: where, MOVES_RUN: runId,
          },
        };
      };
      return {
        ...made,
        start: async (order: Parameters<typeof made.start>[0]) => {
          console.log(`${new Date().toISOString()} process ${order.gen} starts on ${hostOf(order.gen) === 'modal' ? 'the Modal VM' : 'this machine'}`);
          const runner = await made.start(inBox(order));
          return { ...runner, exited: runner.exited.then(homeCrossings(order)) };
        },
        recover: async (last: Parameters<typeof made.recover>[0], kind: Parameters<typeof made.recover>[1], order: Parameters<typeof made.recover>[2]) => {
          const recovered = await made.recover(last, kind, inBox(order));
          return { ...recovered, runner: { ...recovered.runner, exited: recovered.runner.exited.then(homeCrossings(order)) } };
        },
      } as never;
    },
    argv: ['--handoff', '--live', '--max-usd', maxUsd, '--record', record, '--dir', runDir],
  });
} catch (error) { failure = error; }
clearTimeout(cap);

// ---- the by-code checks (no model judges these), on the recording and the files brought home, before anything is published; the sweep runs whatever they do --------------
const problems: string[] = [];
const check = (ok: boolean, message: string) => { if (!ok) problems.push(message); };
let report: Record<string, unknown> = {};
try {
  if (existsSync(join(record, 'events.jsonl'))) {
    const valid = spawnSync(process.execPath, [join(root, 'scripts/recording/validate.mjs'), record], { encoding: 'utf8' });
    check(valid.status === 0, `the recording does not validate: ${(valid.stdout + valid.stderr).trim().slice(0, 300)}`);
    const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8')) as { generations: number; kills: number; handoffs: number };
    check(manifest.generations === 3 && manifest.kills === 0 && manifest.handoffs === 2, `the manifest says ${JSON.stringify({ generations: manifest.generations, kills: manifest.kills, handoffs: manifest.handoffs })}, not 3 generations, 0 kills, 2 handoffs`);
    const events = readFileSync(join(record, 'events.jsonl'), 'utf8').split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as { source?: string; kind?: string });
    for (const kind of ['kill', 'revoke', 'fenced', 'handoff.failed']) check(!events.some((e) => e.source === 'host' && e.kind === kind), `the recording has a ${kind} line`);
  } else problems.push('the run left no recording');
  const threadsFile = join(runDir, 'work', 'threads.json');
  if (existsSync(threadsFile)) {
    const threads = JSON.parse(readFileSync(threadsFile, 'utf8')) as { gpu?: string | null; metric?: number | null }[];
    check(threads.length === THREADS && threads.every((t) => /H100/i.test(String(t.gpu ?? '')) && typeof t.metric === 'number'), `threads.json does not show ${THREADS} threads that each report an H100 and a metric`);
  } else problems.push('threads.json was not brought home');
  const boxFile = join(runDir, 'boxes.jsonl');
  if (existsSync(boxFile)) {
    const events = readFileSync(boxFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { ev: string; id?: string; spec?: { gpu?: string } });
    const created = events.filter((e) => e.ev === 'create');
    check(new Set(created.map((e) => e.id)).size === THREADS && created.every((e) => e.spec?.gpu === 'H100!'), `the sandbox ledger does not show ${THREADS} distinct H100 sandboxes`);
    check(created.every((e) => events.some((d) => d.ev === 'destroy' && d.id === e.id)), 'a thread sandbox was not destroyed by the session');
  } else problems.push('the sandbox ledger was not brought home');
} catch (error) {
  problems.push(`the checks could not run: ${String((error as Error).message).slice(0, 200)}`);
} finally {
  report = await sweep();
}
// The three values, nowhere in what the run left here: the recording and the run's files, by file; a count, never a value.
let secretHits = 0;
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) walk(at);
    else if (entry.isFile()) { const body = readFileSync(at); if (secretValues.some((value) => body.includes(value))) secretHits += 1; }
  }
};
for (const dir of [record, runDir]) if (existsSync(dir)) walk(dir);
console.log(`the held keys in what the run left here: ${secretHits} file(s)`);
const why = [
  ...(failure ? [`the run threw: ${String((failure as Error).message).slice(0, 160)}`] : []),
  ...(outcome && outcome.processes.at(-1)?.outcome?.status !== 'complete' ? [`the last process ended ${outcome.processes.at(-1)?.outcome?.status ?? 'with no outcome'}`] : []),
  ...(outcome && outcome.processes.length !== 3 ? [`${outcome.processes.length} processes, not 3`] : []),
  ...(outcome?.failedHandoffs.length ? [`${outcome.failedHandoffs.length} planned handoff(s) did not land`] : []),
  ...(outcome?.failedKills.length || outcome?.failedSignals.length || outcome?.unlanded.length ? ['a planned kill or signal did not land'] : []),
  ...(outcome?.overBudget ? ['the run went over --max-usd'] : []),
  ...problems,
  ...(report.aliveAfter || report.taggedAfter ? ['a sandbox is still alive after the sweep'] : []),
  ...(report.releaseError ? ['the place did not release cleanly'] : []),
  ...(secretHits ? ['a held key is in what the run left here'] : []),
  ...(((report.disk as { error?: string } | undefined)?.error) ? ["the run's directory could not be removed from the disk"] : []),
  ...(((report.tokenUsers as { found: number; removed: number } | undefined)?.found ?? 0) !== ((report.tokenUsers as { removed: number } | undefined)?.removed ?? 0) ? ['a mount token is still on the disk'] : []),
];
console.log(JSON.stringify({ run: runId, minutes: Math.round((Date.now() - startedAt) / 6000) / 10, handoffs: outcome?.handoffs ?? null, kills: outcome?.kills ?? null, processes: outcome?.processes.map((p) => ({ exit: p.exit, status: p.outcome?.status ?? null })) ?? null, usd: outcome?.usd ?? null, secretHits, ok: why.length === 0, ...(why.length ? { why } : {}), report }));
if (why.length === 0) console.log(`ok: one run moved from this machine to a Modal VM and back; ${THREADS} threads ran in ${THREADS} H100 sandboxes; everything swept, 0 key values in what the run left`);
process.exit(why.length ? 1 : 0);
