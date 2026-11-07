// `npm test`: every workspace's test script, several at once. `npm run test:changed`: only the workspaces a change reaches.
//   node scripts/test-workspaces.mjs [--changed [--base <ref>]] [--list]
// - This script owns the total: at most AGENTRUN_TEST_TOTAL=<n> test files run at once across every workspace (default:
//   the cores). AGENTRUN_TEST_JOBS=<n> workspaces run at once; default a quarter of the total, 1 to 6, never more than the
//   total. Each gets total / jobs: a `node --test` script as --test-concurrency (or keeps its own when lower), any other
//   script as TEST_CONCURRENCY (pi-browser's runner) and VITEST_MAX_WORKERS (vitest).
// - With one job they run in npm's order, their output live, as `npm run test --workspaces` ran them. With more, the
//   slowest start first (the last passing run's times, kept in node_modules/.cache; a workspace with none starts first),
//   and each one's output is held and printed whole, under a header, when it ends.
// - Each script runs in a process group of its own. A Ctrl-C or SIGTERM stops every group (SIGTERM, SIGKILL 5 s on);
//   processes a script leaves behind when it ends are killed and named in its header.
// - --changed picks the workspaces with a file changed since the merge base of HEAD and <ref> (default origin/main), the
//   committed, staged, unstaged and untracked ones, plus every workspace that depends on one, by its package.json. A changed
//   file outside the workspaces picks them all, unless no workspace test reads it (UNRELATED). --list prints the plan only.
// Exit: 0 when every script passed, 1 when one failed, 2 on a usage error, 128 + the signal when stopped.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism, constants } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const fail = (message) => { console.error(`test-workspaces: ${message}`); process.exit(2); };
const args = process.argv.slice(2);
const changed = args.includes('--changed');
const listOnly = args.includes('--list');
const baseAt = args.indexOf('--base');
// `npm run test:changed --base x` hands npm the flag, which passes it on as npm_config_base.
const baseRef = baseAt >= 0 ? args[baseAt + 1] : process.env.npm_config_base || 'origin/main';
const known = new Set(['--changed', '--list', '--base']);
const unknown = args.filter((arg, i) => !known.has(arg) && !(i === baseAt + 1 && baseAt >= 0));
if (unknown.length || (baseAt >= 0 && !baseRef)) fail(`usage: node scripts/test-workspaces.mjs [--changed [--base <ref>]] [--list] (got ${args.join(' ')})`);

// Seconds measured on a clean run, for the order of a first run only; a run's own times replace them.
const SEED = {
  '@parcha/agentrun-serve': 260, '@parcha/agentrun-dsl': 172, '@parcha/pi-transport': 121, '@parcha/pi-browser': 83,
  '@parcha/agentrun-harness-codex': 76, '@parcha/pi-agent-learn': 75, '@parcha/agentrun-pi': 52,
  '@parcha/agentrun-harness-claude': 33, '@parcha/pi-durable-disk': 31, '@parcha/agentrun-learn': 26,
  '@parcha/pi-git-remote': 25, '@parcha/pi-durable-agent': 10.5, '@parcha/agentrun-jev': 6, '@parcha/agentrun-kernel': 3,
  '@parcha/agentrun-decisions': 3,
};
const TIMES = join(root, 'node_modules', '.cache', 'agentrun-test-times.json');
// Files outside the workspaces that no workspace test reads: changing only these runs nothing. Any other file outside
// them (the lockfile, tsconfig.base.json, scripts/, examples/, spec/ ...) may change every workspace's result.
const UNRELATED = [/\.md$/i, /^(changes|docs|\.github|\.agents|apps\/console)\//, /\.test\.mjs$/];

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspaces = (manifest.workspaces ?? [])
  .flatMap((pattern) => globSync(pattern, { cwd: root }))
  .filter((dir) => existsSync(join(root, dir, 'package.json')))
  .sort()
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    return { name: pkg.name, dir: dir.split('\\').join('/'), script: pkg.scripts?.test, deps };
  });

const git = (...rest) => execFileSync('git', ['-C', root, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function pickChanged() {
  let base;
  try { base = git('merge-base', baseRef, 'HEAD').trim(); } catch {
    fail(`no merge base of HEAD and ${baseRef}; fetch it (git fetch origin main) or pass --base <ref>`);
  }
  const files = [...new Set([
    ...git('diff', '--name-only', '--no-renames', '-z', base).split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean))].sort();
  console.log(`test:changed: ${files.length} file${files.length === 1 ? '' : 's'} changed since ${base.slice(0, 10)} (the merge base with ${baseRef})`);
  const why = new Map();
  const skipped = [];
  for (const file of files) {
    const owner = workspaces.find((ws) => file.startsWith(`${ws.dir}/`));
    if (owner) {
      const seen = why.get(owner.name);
      why.set(owner.name, seen ? { ...seen, more: seen.more + 1 } : { text: 'changed', file, more: 0 });
    } else if (UNRELATED.some((re) => re.test(file))) skipped.push(file);
    else {
      console.log(`  every workspace: ${file} is outside the workspaces and their tests may read it`);
      return workspaces;
    }
  }
  for (const [name, seen] of why) why.set(name, `changed (${seen.file}${seen.more ? `, ${seen.more} more` : ''})`);
  const queue = [...why.keys()];
  while (queue.length) {
    const name = queue.shift();
    for (const ws of workspaces) if (!why.has(ws.name) && ws.deps.includes(name)) { why.set(ws.name, `depends on ${name}`); queue.push(ws.name); }
  }
  const picked = workspaces.filter((ws) => why.has(ws.name));
  const width = Math.max(0, ...picked.map((ws) => ws.name.length));
  for (const ws of picked) console.log(`  ${ws.name.padEnd(width)}  ${why.get(ws.name)}${ws.script ? '' : ', has no test script'}`);
  if (skipped.length) console.log(`  not run for: ${skipped.join(', ')} (no workspace test reads them)`);
  return picked;
}

const chosen = (changed ? pickChanged() : workspaces).filter((ws) => ws.script);
if (!chosen.length) { console.log('test-workspaces: nothing to test'); process.exit(0); }
const whole = (name, what) => {
  const value = process.env[name];
  if (value !== undefined && !/^[1-9]\d*$/.test(value)) fail(`${name} is a whole number of ${what}, not "${value}"`);
  return value && Number(value);
};
const total = whole('AGENTRUN_TEST_TOTAL', 'test files at once across the workspaces') || availableParallelism();
const jobs = Math.min(chosen.length, total, whole('AGENTRUN_TEST_JOBS', 'workspaces at once') || Math.max(1, Math.min(6, Math.floor(total / 4))));
const live = jobs === 1;
const files = Math.floor(total / jobs);

// The command a workspace's script runs as here, and what it adds to the environment.
function commandOf(ws) {
  let text = ws.script;
  const plain = /^node --test( |$)/.test(text) && !/[;&|<>`$()]/.test(text);
  if (plain) {
    const own = /(?:^| )--test-concurrency=(\d+)(?= |$)/.exec(text);
    const flags = [`--test-concurrency=${own ? Math.min(Number(own[1]), files) : files}`];
    if (own) text = text.replace(own[0], '');
    // node --test writes TAP to a pipe; a person at a terminal reads the spec reporter, as they would without this script.
    if (!live && process.stdout.isTTY && !/--test-reporter/.test(text)) flags.push('--test-reporter=spec');
    text = text.replace(/^node --test/, `node --test ${flags.join(' ')}`);
  }
  return { text, plain, env: { TEST_CONCURRENCY: String(files), VITEST_MAX_WORKERS: String(files) } };
}

function readTimes() { try { return JSON.parse(readFileSync(TIMES, 'utf8')); } catch { return {}; } }
const times = readTimes();
const expected = (ws) => times[ws.name] ?? SEED[ws.name] ?? Infinity;
const order = live ? chosen : chosen.map((ws, i) => ({ ws, i })).sort((a, b) => expected(b.ws) - expected(a.ws) || a.i - b.i).map(({ ws }) => ws);

const plan = `${order.length} workspace${order.length === 1 ? '' : 's'}, ${jobs} at once${live && order.length > 1 ? ' in npm\'s order' : ''}` +
  `, at most ${files} test files each (${jobs * files} in all)`;
if (listOnly) {
  console.log(`test-workspaces: ${plan}`);
  for (const ws of order) {
    const { text, plain, env } = commandOf(ws);
    const knobs = !plain ? ` [${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}]` : '';
    console.log(`  ${ws.name} (${ws.dir}): ${text}${knobs}`);
  }
  process.exit(0);
}

const seconds = (ms) => (ms / 1000).toFixed(1);
const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); return true; } catch { return false; } };
const running = new Map();
const results = [];
const pending = [...order];
let stopping;

// Each script runs as a suite of its own: under a `node --test` that started this script, NODE_TEST_CONTEXT would make
// every workspace's `node --test` report to that parent instead, and pass having run nothing.
const { NODE_TEST_CONTEXT, ...childEnv } = process.env;

function start(ws) {
  const { text, env } = commandOf(ws);
  console.log(`start ${ws.name} (${ws.dir}): ${text}`);
  const child = spawn('npm', ['exec', '--workspace', ws.name, '-c', text], {
    cwd: root, detached: true, env: { ...childEnv, ...env }, stdio: ['ignore', live ? 'inherit' : 'pipe', live ? 'inherit' : 'pipe'],
  });
  const job = { ws, child, started: Date.now(), output: [] };
  running.set(child.pid, job);
  child.stdout?.on('data', (chunk) => job.output.push(chunk));
  child.stderr?.on('data', (chunk) => job.output.push(chunk));
  const closed = live ? Promise.resolve() : once(child, 'close').catch(() => {});
  job.done = new Promise((resolve) => child.on('error', (error) => resolve({ code: 1, note: `could not start npm: ${error.message}` }))
    .on('exit', (code, signal) => resolve({ code: code ?? 128 + (constants.signals[signal] ?? 0) })))
    .then(async (end) => {
      const ms = Date.now() - job.started;
      // What the script left running would hold the output pipe open, and outlive the run.
      if (signalGroup(child.pid, 0)) { signalGroup(child.pid, 'SIGKILL'); end.note ??= 'left processes running when it ended; they were killed'; }
      // A process outside the group can hold the pipe too: stop reading it, or this script never ends.
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      child.stdout?.destroy();
      child.stderr?.destroy();
      running.delete(child.pid);
      const result = end.code === 0 ? 'passed' : stopping ? 'stopped' : `failed (exit ${end.code})`;
      results.push({ ws, result, ms });
      const header = `--- ${ws.name}: ${result} in ${seconds(ms)} s${end.note ? `; ${end.note}` : ''} ---`;
      if (live) console.log(header);
      else process.stdout.write(Buffer.concat([Buffer.from(`${header}\n`), ...job.output, Buffer.from(job.output.length && !job.output.at(-1).toString().endsWith('\n') ? '\n' : '')]));
    });
  return job.done;
}

// A crash of this script still stops what it started.
process.on('exit', () => { for (const pid of running.keys()) signalGroup(pid, 'SIGKILL'); });
function stop(signal) {
  if (stopping) { for (const pid of running.keys()) signalGroup(pid, 'SIGKILL'); return; }
  console.log(`test-workspaces: ${signal}, stopping ${running.size} running workspace${running.size === 1 ? '' : 's'}`);
  stopping = signal;
  pending.length = 0;
  for (const pid of running.keys()) signalGroup(pid, 'SIGTERM');
  setTimeout(() => { for (const pid of running.keys()) signalGroup(pid, 'SIGKILL'); }, 5000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);

console.log(`test-workspaces: ${plan} (AGENTRUN_TEST_JOBS=<n> and AGENTRUN_TEST_TOTAL=<n> change it)`);
const began = Date.now();
const heartbeat = setInterval(() => {
  if (!live && running.size) console.log(`still running: ${[...running.values()].map((job) => `${job.ws.name} ${seconds(Date.now() - job.started)} s`).join(', ')}`);
}, 30_000);
await Promise.all(Array.from({ length: jobs }, async () => { while (pending.length) await start(pending.shift()); }));
clearInterval(heartbeat);

const passed = results.filter((r) => r.result === 'passed');
if (!stopping && passed.length) {
  const next = { ...readTimes() };
  for (const r of passed) next[r.ws.name] = Number(seconds(r.ms));
  try {
    mkdirSync(join(TIMES, '..'), { recursive: true });
    writeFileSync(`${TIMES}.${process.pid}`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${TIMES}.${process.pid}`, TIMES);
  } catch { /* the order of the next run only */ }
}
const notRun = order.filter((ws) => !results.some((r) => r.ws === ws));
const rows = [...results.sort((a, b) => b.ms - a.ms).map((r) => [r.ws.name, r.result, seconds(r.ms)]), ...notRun.map((ws) => [ws.name, 'not run', '-'])];
const width = Math.max(9, ...rows.map(([name]) => name.length));
const resultWidth = Math.max(6, ...rows.map(([, result]) => result.length));
console.log(`\n${'workspace'.padEnd(width)}  ${'result'.padEnd(resultWidth)}  seconds`);
for (const [name, result, s] of rows) console.log(`${name.padEnd(width)}  ${result.padEnd(resultWidth)}  ${s.padStart(7)}`);
const failed = results.filter((r) => r.result.startsWith('failed'));
const code = stopping ? 128 + constants.signals[stopping] : failed.length ? 1 : 0;
console.log(`${results.length} of ${order.length} workspaces ran: ${passed.length} passed, ${failed.length} failed` +
  `${failed.length ? ` (${failed.map((r) => r.ws.name).join(', ')})` : ''}; wall ${seconds(Date.now() - began)} s, ${plan}; exit ${code}`);
// Not process.exit: that can cut off what is still queued for a pipe, such as the table.
process.exitCode = code;
