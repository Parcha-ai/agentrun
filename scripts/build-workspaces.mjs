// The workspaces built in dependency order: each package once, after every workspace package it names (dependencies,
// devDependencies, peerDependencies, optionalDependencies), so a package compiles against its dependencies' dists as
// this tree's sources make them, never a dist an earlier build left behind. A package's own build compiles itself
// alone; this order is what builds what it imports first. A cycle among the workspaces, or a build that fails, stops it
// loudly.
//   node scripts/build-workspaces.mjs            build every workspace that has a build script, in order
//   node scripts/build-workspaces.mjs --order    print the order, one package name a line, and build nothing
//   node scripts/build-workspaces.mjs --changed  build only the stale packages (see below), in the same order
//   node scripts/build-workspaces.mjs --stale    print the stale packages, one a line, and build nothing
//   node scripts/build-workspaces.mjs --only a,b  build only those, in the same order, and with them every workspace they
//                                                 depend on that is stale: none compiles against an out-of-date dist
//
// Stale: a package whose dist is missing, or older than a file of the package (any file but dist and node_modules: its
// sources, its tsconfig, its manifest), or that depends on a stale package, since that one is rebuilt first. The dist the
// build leaves is the only thing it is compared with, as make does, so an edit rebuilds the package and its dependents,
// and nothing else does. A package with no build script is never stale.
//   --root <dir>                                  the repository to build (default: this script's)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** The workspace packages under `root` (its package.json's `workspaces`, each a `dir/*` glob): name, directory, the
 *  workspace packages it names, and whether it has a build script. */
export function workspaces(root = ROOT) {
  const globs = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  const found = [];
  for (const glob of globs) {
    if (!glob.endsWith('/*')) throw new Error(`build-workspaces: a workspace glob it does not read: ${glob}`);
    const parent = join(root, glob.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const file = join(parent, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      found.push({ name: manifest.name, dir: join(parent, entry.name), named: FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})), build: typeof manifest.scripts?.build === 'string' });
    }
  }
  const names = new Set(found.map((p) => p.name));
  return found.map(({ named, ...rest }) => ({ ...rest, deps: [...new Set(named.filter((name) => names.has(name) && name !== rest.name))].sort() }));
}

/** The packages' names, each after every package it depends on, ties by name. A cycle throws, naming it. */
export function buildOrder(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const order = [];
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      const cycle = [...path.slice(path.indexOf(name)), name];
      throw new Error(`build-workspaces: the workspaces depend on each other in a cycle: ${cycle.join(' -> ')}`);
    }
    state.set(name, 'visiting');
    for (const dep of byName.get(name).deps) visit(dep, [...path, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of [...byName.keys()].sort()) visit(name, []);
  return order;
}

/** `names`, in the order buildOrder gives every package. A name that is no workspace, or a package among them that
 *  depends on a workspace outside them with no dist (`built(p)`), throws: it would compile against nothing. */
export function subsetOrder(packages, names, built = (p) => existsSync(join(p.dir, 'dist'))) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const name of names) if (!byName.has(name)) throw new Error(`build-workspaces: ${name} is not a workspace`);
  const wanted = new Set(names);
  for (const name of wanted) {
    for (const dep of byName.get(name).deps) {
      if (!wanted.has(dep) && !built(byName.get(dep))) throw new Error(`build-workspaces: ${name} depends on ${dep}, which is not in the build and has no dist`);
    }
  }
  return buildOrder(packages).filter((name) => wanted.has(name));
}

/** The newest modification time (ms) of any file under `dir`, skipping the directories named in `skip`; 0 when there is none. */
export function newestMtime(dir, skip = new Set(['dist', 'node_modules', '.git'])) {
  let newest = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(join(path, entry.name));
      } else {
        newest = Math.max(newest, statSync(join(path, entry.name)).mtimeMs);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

/** The names of the packages whose dist is stale, in `order`: one that has a build script and no dist, or a dist whose newest
 *  file is older than the newest of the package's own (`sources(p)`, `dist(p)`: modification times, ms), or that depends on
 *  a stale package. A package with no build script is never stale. */
export function stalePackages(packages, order, { sources = (p) => newestMtime(p.dir), dist = (p) => newestMtime(join(p.dir, 'dist'), new Set()) } = {}) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const stale = new Set();
  for (const name of order) {
    const p = byName.get(name);
    if (!p.build) continue;
    const built = dist(p);
    if (built === 0 || sources(p) > built || p.deps.some((dep) => stale.has(dep))) stale.add(name);
  }
  return stale;
}

/** `names` and every stale package they depend on, through any depth: what a build of `names` must build for none of them to
 *  compile against an out-of-date dist. */
export function withStaleDeps(packages, names, stale) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const wanted = new Set(names);
  const visit = (name) => {
    for (const dep of byName.get(name)?.deps ?? []) {
      if (stale.has(dep) && !wanted.has(dep)) wanted.add(dep);
      visit(dep);
    }
  };
  for (const name of names) visit(name);
  return [...wanted];
}

/** Builds each of `order` that has a build script, once, in that order (`build(name)` gives its exit status), and stops
 *  at the first that fails: `{ built }`, the names built, and with a failure `failed` and its `status`. */
export function buildAll(packages, order, build) {
  const builds = new Set(packages.filter((p) => p.build).map((p) => p.name));
  const built = [];
  for (const name of order.filter((n) => builds.has(n))) {
    const status = build(name);
    if (status !== 0) return { built, failed: name, status };
    built.push(name);
  }
  return { built };
}

if (isMain(import.meta)) {
  const flag = (name) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  const root = flag('--root') ? resolve(flag('--root')) : ROOT;
  const packages = workspaces(root);
  const only = flag('--only');
  const full = buildOrder(packages);
  const changed = process.argv.includes('--changed');
  // The files are only walked when a mode asks which packages are stale: the plain build rebuilds every package.
  const stale = only || changed || process.argv.includes('--stale') ? stalePackages(packages, full) : new Set();
  const named = only ? withStaleDeps(packages, only.split(',').filter(Boolean), stale) : undefined;
  let order = named ? subsetOrder(packages, named) : full;
  if (changed) order = order.filter((name) => stale.has(name));
  if (process.argv.includes('--order')) {
    process.stdout.write(`${order.join('\n')}\n`);
  } else if (process.argv.includes('--stale')) {
    process.stdout.write(order.filter((name) => stale.has(name)).map((name) => `${name}\n`).join(''));
  } else {
    if (order.length === 0) process.stdout.write('build-workspaces: every workspace is up to date\n');
    const result = buildAll(packages, order, (name) => spawnSync('npm', ['run', 'build', '-w', name], { cwd: root, stdio: 'inherit' }).status ?? 1);
    if (result.failed) {
      process.stderr.write(`build-workspaces: ${result.failed}'s build failed (${result.status}); nothing after it was built\n`);
      process.exit(result.status || 1);
    }
  }
}
