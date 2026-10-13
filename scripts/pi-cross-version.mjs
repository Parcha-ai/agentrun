#!/usr/bin/env node
// A run that starts on one pi version, is killed, and resumes on another: the package's crash tests, run so that every
// first process of a run comes from an install of the packages on `--from`, and every later process from one on `--to`.
//
// `node scripts/pi-cross-version.mjs --from <version> --to <version> [--npm "<command>"] [--work <dir>]`
//
// The workspace must be built. The script packs @parcha/agentrun-dsl, agentrun-jev, agentrun-pi and pi-durable-disk, and
// installs them into two empty directories with pi-durable, chord and pi-ai at exactly each version. It fails unless
// each directory loads one copy of each at that version. Then it copies packages/pi/test/fixtures into each and runs the
// crash tests with PI_CROSS_FIRST, PI_CROSS_LATER and PI_CROSS_STATE set (see test/fixtures/cross-version.mjs).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NPM_VERSION, resolvedFrom } from './pi-leg.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
/** The packages a run on the durable entry installs, in the order they depend on each other. */
const PACKED = ['packages/dsl', 'packages/jev', 'packages/pi', 'packages/pi-durable-disk'];
/** The pi packages the durable entry and its crash children load. */
const PI = ['@earendil-works/pi-durable', '@earendil-works/chord', '@earendil-works/pi-ai'];
/** The crash tests, each spawning its run's processes through `childPath`, and the test of moving a store back. */
export const CRASH_TESTS = ['durable-task-crash', 'durable-crash-sweep', 'durable-agent-crash-sweep', 'durable-disk-crash-sweep', 'node-crash', 'node-runner-crash', 'record-crash', 'durable-cross-version']
  .map((name) => `packages/pi/test/${name}.test.mjs`);

function argsOf(argv) {
  const args = { from: undefined, to: undefined, npm: 'npm', work: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => { if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`); return argv[(i += 1)]; };
    if (flag === '--from') args.from = value();
    else if (flag === '--to') args.to = value();
    else if (flag === '--npm') args.npm = value();
    else if (flag === '--work') args.work = resolve(value());
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.from || !args.to) throw new Error('--from <version> and --to <version> are required');
  return args;
}

function run(command, args, options = {}) {
  const [bin, ...pre] = command.split(/\s+/).filter(Boolean);
  console.log(`$ ${[bin, ...pre, ...args].join(' ')}`);
  const done = spawnSync(bin, [...pre, ...args], { stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', ...options });
  if (done.status !== 0) throw new Error(`${[bin, ...pre, ...args].join(' ')} exited ${done.status ?? done.signal}`);
  return done.stdout;
}

/** An empty directory with the packed packages and the pi packages at exactly `version`, its fixtures copied in. */
function install(work, version, tarballs, npm) {
  const dir = join(work, `pi-${version}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: `cross-${version.replaceAll('.', '-')}`, version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`);
  run(npm, ['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, ...PI.map((name) => `${name}@${version}`)], { cwd: dir });
  const durable = resolvedFrom(dir, '@earendil-works/pi-durable');
  const loaded = [...PI.map((name) => ({ from: 'the install', name, ...resolvedFrom(dir, name) })),
    ...(durable ? ['@earendil-works/chord', '@earendil-works/pi-ai'].map((name) => ({ from: 'its pi-durable', name, ...resolvedFrom(durable.path, name) })) : [])];
  for (const row of loaded) console.log(`pi ${version}: ${row.from} loads ${row.name} ${row.version ?? 'unresolved'} ${row.path ?? ''}`);
  const wrong = loaded.filter((row) => row.version !== version);
  if (wrong.length) throw new Error(`the ${version} install loads ${wrong.map((row) => `${row.name} ${row.version ?? 'unresolved'} (${row.from})`).join(', ')}`);
  const paths = new Map();
  for (const row of loaded) paths.set(row.name, new Set([...(paths.get(row.name) ?? []), row.path]));
  for (const [name, at] of paths) if (at.size > 1) throw new Error(`the ${version} install loads ${at.size} copies of ${name}`);
  cpSync(join(repo, 'packages/pi/test/fixtures'), join(dir, 'fixtures'), { recursive: true });
  return join(dir, 'fixtures');
}

function main() {
  const args = argsOf(process.argv.slice(2));
  const npmVersion = spawnSync(args.npm.split(/\s+/)[0], [...args.npm.split(/\s+/).slice(1), '--version'], { encoding: 'utf8' }).stdout?.trim();
  if (npmVersion !== NPM_VERSION) throw new Error(`the installs need npm ${NPM_VERSION}; "${args.npm}" is ${npmVersion || 'not runnable'}`);
  const work = args.work ?? mkdtempSync(join(tmpdir(), 'pi-cross-version-'));
  mkdirSync(work, { recursive: true });
  const packs = join(work, 'packs');
  mkdirSync(packs);
  for (const dir of PACKED) run(args.npm, ['pack', '--pack-destination', packs, '--ignore-scripts', '--silent'], { cwd: join(repo, dir), capture: true });
  const tarballs = readdirSync(packs).filter((name) => name.endsWith('.tgz')).map((name) => join(packs, name));
  if (tarballs.length !== PACKED.length) throw new Error(`packed ${tarballs.length} tarballs, expected ${PACKED.length}`);
  const first = install(work, args.from, tarballs, args.npm);
  const later = install(work, args.to, tarballs, args.npm);
  const state = join(work, 'state');
  mkdirSync(state);
  console.log(`crash tests: every first process on pi ${args.from}, every later process on pi ${args.to}`);
  const tests = spawnSync(process.execPath, ['--test', ...CRASH_TESTS], { cwd: repo, stdio: 'inherit', env: { ...process.env, PI_CROSS_FIRST: first, PI_CROSS_LATER: later, PI_CROSS_STATE: state } });
  console.log(`crash tests from pi ${args.from} to pi ${args.to}: ${tests.status === 0 ? 'passed' : `FAILED (exit ${tests.status ?? tests.signal})`}`);
  process.exit(tests.status === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) { console.error(`pi-cross-version: ${error.message}`); process.exit(2); }
}
