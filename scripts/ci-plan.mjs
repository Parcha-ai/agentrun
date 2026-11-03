// CI's test plan: every test suite of the repository, its files, and their assignment to shards by time.
//
// A suite is a workspace's `test` script or one of the root scripts scripts/ci-shards.json names. A suite whose script is
// `node --test [--test-concurrency=<n>] [--test-timeout=<ms>] <files or globs>`, or pi-transport's `vitest --run`, is split
// by file; any other script ci-shards.json lists under `whole` runs as it is, as one unit. A script of any other shape is
// refused, so a script that changes shape is looked at here instead of running unseen.
//
// `plan(units, n)` assigns units to n shards, longest first, each to the shard it lengthens least, with a shard's time
// modelled as each suite's longest file or its files' total over the suite's measured parallelism, whichever is more. The
// weights come from scripts/ci-timings.json (seconds on a GitHub-hosted runner, from CI's own logs: `node
// scripts/ci-timings.mjs`). A file it does not list weighs its suite's median; nothing is dropped for a missing weight.
// The plan is a pure function of the checkout, so every job of a run computes the same one.
//   node scripts/ci-plan.mjs [--pool <name>]   prints the test shards and their modelled seconds (the pi legs': pi-leg.mjs --plan --shard)
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';

/** scripts/ci-shards.json (pools, shard counts, root suites, whole suites) and scripts/ci-timings.json under `root`. */
export function readConfig(root) {
  const config = JSON.parse(readFileSync(join(root, 'scripts', 'ci-shards.json'), 'utf8'));
  const timingsPath = join(root, 'scripts', 'ci-timings.json');
  const timings = existsSync(timingsPath) ? JSON.parse(readFileSync(timingsPath, 'utf8')) : {};
  return { config, timings: { files: {}, parallelism: {}, walls: {}, typecheck: {}, ...timings } };
}

const FILE = /^[\w./@-]+$/;
const nodeTest = /^node --test((?: --test-(?:concurrency|timeout)=\d+)*)((?: (?:'[\w./*-]+'|[\w./*-]+))+)$/;
const VITEST = 'vitest --run';

function listed(command, cwd, what) {
  const done = spawnSync('npm', ['exec', '-c', command], { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`${what}: \`${command}\` exited ${done.status ?? done.signal}: ${(done.stderr || '').trim().split('\n').slice(-3).join(' / ')}`);
  const files = done.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const file of files) if (!FILE.test(file)) throw new Error(`${what}: \`${command}\` printed "${file}", not a plain path`);
  return [...new Set(files)].sort();
}

/**
 * Every suite: `{ name, workspace, cwd, files, whole, run(files, { timeoutMs }) }`. `cwd` is relative to `root`; `files`
 * relative to `cwd`, sorted. `run` gives the command for some of the files (all of a whole suite): `npm exec` in the
 * suite's directory with npm's PATH, as `npm run` gives it. `timeoutMs` adds --test-timeout to a `node --test` that sets
 * none. `only` keeps the workspaces it names (and no root suite).
 */
export function readSuites(root, { config, only } = {}) {
  config ??= readConfig(root).config;
  const whole = config.whole ?? {};
  const suites = [];
  const add = (name, workspace, cwd, text) => {
    if (whole[name] !== undefined) {
      if (whole[name] !== text) throw new Error(`${name}'s test script, ${JSON.stringify(text)}, is not the one scripts/ci-shards.json runs as a whole (${JSON.stringify(whole[name])}); update it there`);
      const where = workspace ? ['-w', workspace] : [];
      suites.push({ name, workspace, cwd, files: [], whole: true, run: () => ['npm', 'run', workspace ? 'test' : name, ...where] });
      return;
    }
    const exec = (command) => ['npm', 'exec', ...(workspace ? ['-w', workspace] : []), '-c', command];
    const shape = nodeTest.exec(text);
    if (shape) {
      const flags = shape[1].trim();
      const patterns = shape[2].trim().split(/\s+/).map((pattern) => pattern.replace(/^'|'$/g, ''));
      const files = [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd: join(root, cwd) })))].sort();
      if (!files.length) throw new Error(`${name}'s test script, ${JSON.stringify(text)}, matches no file`);
      for (const file of files) if (!FILE.test(file)) throw new Error(`${name}: the test file "${file}" is not a plain path`);
      suites.push({
        name, workspace, cwd, files, whole: false,
        run: (some, { timeoutMs } = {}) => {
          const timeout = timeoutMs && !/--test-timeout=/.test(flags) ? [`--test-timeout=${timeoutMs}`] : [];
          return exec(['node --test', ...timeout, ...(flags ? [flags] : []), ...some].join(' '));
        },
      });
      return;
    }
    if (text === VITEST && workspace) {
      const files = listed('vitest list --filesOnly', join(root, cwd), name);
      if (!files.length) throw new Error(`${name}: vitest lists no test file`);
      suites.push({ name, workspace, cwd, files, whole: false, run: (some) => exec([VITEST, ...some].join(' ')) });
      return;
    }
    throw new Error(`${name}'s test script, ${JSON.stringify(text)}, is neither \`node --test [--test-concurrency=<n>] [--test-timeout=<ms>] <files>\`, \`${VITEST}\`, nor one scripts/ci-shards.json runs as a whole; add it to one of them`);
  };
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const path = join(root, 'packages', dir, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.scripts?.test === undefined || (only && !only.includes(manifest.name))) continue;
    add(manifest.name, manifest.name, `packages/${dir}`, manifest.scripts.test);
  }
  if (!only) {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
    for (const name of config.rootSuites ?? []) {
      if (scripts[name] === undefined) throw new Error(`scripts/ci-shards.json names the root script ${name}, which package.json does not have`);
      add(name, undefined, '.', scripts[name]);
    }
  }
  return suites;
}

const median = (values) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const DEFAULT_FILE_SECONDS = 5;
const DEFAULT_WHOLE_SECONDS = 60;
const DEFAULT_TYPECHECK_SECONDS = 10;
const DEFAULT_PARALLELISM = 2;

/**
 * The units of `suites`: each file of a split suite, each whole suite, and with `typecheck` a type-check of each workspace
 * it names. `{ id, suite, file, seconds, parallelism }`: `id` is unique, `file` is relative to the root (a whole suite and a
 * type-check have none), `seconds` the unit's own time.
 */
export function unitsOf(suites, timings, { typecheck = [] } = {}) {
  const units = [];
  for (const suite of suites) {
    if (suite.whole) {
      units.push({ id: `suite:${suite.name}`, suite: suite.name, kind: 'whole', seconds: timings.walls[suite.name] ?? DEFAULT_WHOLE_SECONDS, parallelism: 1 });
      continue;
    }
    const paths = suite.files.map((file) => (suite.cwd === '.' ? file : `${suite.cwd}/${file}`));
    const fallback = median(paths.map((path) => timings.files[path]).filter((seconds) => seconds !== undefined)) ?? DEFAULT_FILE_SECONDS;
    const parallelism = timings.parallelism[suite.name] ?? DEFAULT_PARALLELISM;
    suite.files.forEach((file, index) => units.push({ id: `file:${paths[index]}`, suite: suite.name, kind: 'file', file, path: paths[index], seconds: timings.files[paths[index]] ?? fallback, parallelism }));
  }
  for (const name of typecheck) units.push({ id: `typecheck:${name}`, suite: `typecheck:${name}`, kind: 'typecheck', workspace: name, seconds: timings.typecheck[name] ?? DEFAULT_TYPECHECK_SECONDS, parallelism: 1 });
  return units;
}

// Each command a shard starts costs a few seconds (npm, the runner's own start) whatever it runs.
const COMMAND_SECONDS = 2;
const groupSeconds = (group) => (group.count ? COMMAND_SECONDS + Math.max(group.max, group.sum / Math.min(group.parallelism, group.count)) : 0);

/** The modelled seconds of a set of units: per suite, its longest unit or its total over its parallelism, whichever is more. */
export function modelSeconds(units) {
  const groups = new Map();
  for (const unit of units) {
    const group = groups.get(unit.suite) ?? { max: 0, sum: 0, count: 0, parallelism: unit.parallelism };
    groups.set(unit.suite, { ...group, max: Math.max(group.max, unit.seconds), sum: group.sum + unit.seconds, count: group.count + 1 });
  }
  return [...groups.values()].reduce((total, group) => total + groupSeconds(group), 0);
}

/**
 * `units` in `n` shards: longest first (ties by id), each to the shard whose modelled time it raises least (ties to the
 * first). Returns `[{ units, seconds }]`, n of them. Deterministic, and every unit is in exactly one shard.
 */
export function plan(units, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`a plan needs a whole number of shards, not ${n}`);
  const ids = new Set();
  for (const unit of units) { if (ids.has(unit.id)) throw new Error(`the unit ${unit.id} appears twice`); ids.add(unit.id); }
  const shards = Array.from({ length: n }, () => ({ units: [], groups: new Map(), seconds: 0 }));
  const order = [...units].sort((a, b) => b.seconds - a.seconds || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const unit of order) {
    let best;
    for (const shard of shards) {
      const group = shard.groups.get(unit.suite) ?? { max: 0, sum: 0, count: 0, parallelism: unit.parallelism };
      const grown = { ...group, max: Math.max(group.max, unit.seconds), sum: group.sum + unit.seconds, count: group.count + 1 };
      const seconds = shard.seconds - groupSeconds(group) + groupSeconds(grown);
      if (!best || seconds < best.seconds - 1e-9) best = { shard, grown, seconds };
    }
    best.shard.units.push(unit);
    best.shard.groups.set(unit.suite, best.grown);
    best.shard.seconds = best.seconds;
  }
  return shards.map(({ units: assigned, seconds }) => ({ units: assigned.sort((a, b) => (a.id < b.id ? -1 : 1)), seconds: Math.round(seconds) }));
}

/** Fails unless `shards` hold every unit of `units` exactly once: no unit dropped, none run twice. */
export function checkCover(units, shards) {
  const seen = new Map();
  shards.forEach((shard, index) => { for (const unit of shard.units) seen.set(unit.id, [...(seen.get(unit.id) ?? []), index + 1]); });
  const missing = units.filter((unit) => !seen.has(unit.id)).map((unit) => unit.id);
  const twice = [...seen].filter(([, at]) => at.length > 1).map(([id, at]) => `${id} (shards ${at.join(', ')})`);
  const extra = [...seen.keys()].filter((id) => !units.some((unit) => unit.id === id));
  const problems = [...missing.map((id) => `${id} is in no shard`), ...twice.map((what) => `${what} is in more than one shard`), ...extra.map((id) => `${id} is not a unit of the suites`)];
  if (problems.length) throw new Error(`the shards do not cover the suites once:\n${problems.join('\n')}`);
}

/**
 * The repository's test-shard pools: `{ <pool>: { shards, suites } }`, each suite in exactly one pool. A pool without
 * `suites` in ci-shards.json takes every suite no other pool names, so a new workspace is tested without an edit.
 */
export function pools(suites, config) {
  const entries = Object.entries(config.pools ?? {});
  const named = new Map();
  for (const [pool, { suites: names = [] }] of entries) {
    for (const name of names) {
      if (named.has(name)) throw new Error(`the suite ${name} is in the pools ${named.get(name)} and ${pool}`);
      if (!suites.some((suite) => suite.name === name)) throw new Error(`the pool ${pool} names ${name}, which is not a suite`);
      named.set(name, pool);
    }
  }
  const rest = entries.filter(([, pool]) => !pool.suites);
  if (rest.length !== 1) throw new Error(`exactly one pool takes every suite no other pool names (it has no "suites"); scripts/ci-shards.json has ${rest.length}`);
  return Object.fromEntries(entries.map(([pool, { shards, suites: names }]) => [pool, { shards, suites: suites.filter((suite) => (names ? names.includes(suite.name) : !named.has(suite.name))) }]));
}

/** The test shards: `{ '<pool>-<k>': { pool, suites, units, seconds } }`, every pool planned, the cover checked. */
export function testShards(root, { config, timings } = readConfig(root)) {
  const byPool = pools(readSuites(root, { config }), config);
  const shards = {};
  for (const [pool, { shards: n, suites }] of Object.entries(byPool)) {
    const units = unitsOf(suites, timings);
    const planned = plan(units, n);
    checkCover(units, planned);
    planned.forEach((shard, index) => { shards[`${pool}-${index + 1}`] = { pool, suites, ...shard }; });
  }
  return shards;
}

/** The commands that run `units` of `suites`: one per suite, its files together, in suite order; type-checks first. */
export function commandsOf(suites, units, { timeoutMs, typecheck = (name) => ['npm', 'run', 'typecheck', '-w', name] } = {}) {
  const commands = units.filter((unit) => unit.kind === 'typecheck').map((unit) => ({ suite: unit.suite, command: typecheck(unit.workspace) }));
  for (const suite of suites) {
    const mine = units.filter((unit) => unit.suite === suite.name && unit.kind !== 'typecheck');
    if (!mine.length) continue;
    commands.push({ suite: suite.name, command: suite.whole ? suite.run() : suite.run(mine.map((unit) => unit.file), { timeoutMs }) });
  }
  return commands;
}

if (isMain(import.meta)) {
  const root = process.cwd();
  const { config, timings } = readConfig(root);
  const args = process.argv.slice(2);
  const poolAt = args.indexOf('--pool');
  const show = (name, shard) => console.log(`${name}: ${shard.seconds} s modelled, ${shard.units.length} units: ${[...new Set(shard.units.map((unit) => unit.suite))].join(', ')}`);
  for (const [name, shard] of Object.entries(testShards(root, { config, timings }))) if (poolAt < 0 || shard.pool === args[poolAt + 1]) show(name, shard);
}
