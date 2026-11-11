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
// Stale: a package with no build stamp (never built by this script, its dist cleared, or its last build failed), whose inputs
// (every file under it but dist and node_modules, by path, size and time, and the root tsconfig.base.json and lockfile)
// differ from its stamp's, that depends on a stale package, or that depends on one built again since it was. The stamp
// (node_modules/.cache/agentrun-build-stamp) is written only after a build that succeeds and cleared when one starts, so a failed build, which
// tsc may still emit files for, never reads as current. A package with no build script is never stale.
//   --root <dir>                                  the repository to build (default: this script's)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/** Where a package's build stamp is, under its own node_modules (git ignores it, and `npm pack` never carries it): readStamp
 *  reads none when the package has no dist, so a build that clears the dist (`rm -rf dist`) clears the stamp too. */
export const STAMP = join('node_modules', '.cache', 'agentrun-build-stamp');
const stampPath = (pkg) => join(pkg.dir, STAMP);
/** What a build reads beyond its own folder, and what in its folder it only writes: the console's build, which serve copies into
 *  its dist; the example and scripts that generate pi's src/demo-data.ts (rewritten by every pi build, so its own time is no input). */
const READS = {
  '@parcha/agentrun-serve': { also: ['apps/console/dist'] },
  '@parcha/agentrun-pi': { also: ['examples', 'scripts/build-pi-demo.mjs', 'scripts/render-pi-skill.mjs'], ignore: ['src/demo-data.ts'] },
};
/** The files outside a package that every build reads: the shared compiler settings and the lockfile that fixes what it compiles against. */
const SHARED = ['tsconfig.base.json', 'package-lock.json'];

/** A hash of what a package's build reads: the path, size and modification time of every file under it but `dist` and
 *  `node_modules` (so a file added, deleted or edited changes it, even when every file left is older than the dist), and of the
 *  shared files under `root` (SHARED), and of what READS names for it. */
export function inputsOf(pkg, root = ROOT) {
  const lines = [];
  const reads = READS[pkg.name] ?? {};
  const walk = (dir, rel, skip = ['dist', 'node_modules', '.git']) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (entry.isDirectory()) {
        if (!skip.includes(entry.name)) walk(join(dir, entry.name), `${rel}${entry.name}/`, skip);
      } else if (!(reads.ignore ?? []).includes(`${rel}${entry.name}`)) {
        const st = statSync(join(dir, entry.name));
        lines.push(`${rel}${entry.name}\t${st.size}\t${st.mtimeMs}`);
      }
    }
  };
  if (existsSync(pkg.dir)) walk(pkg.dir, '');
  for (const also of reads.also ?? []) {
    const path = join(root, also);
    if (!existsSync(path)) lines.push(`../${also}\tnone`);
    else if (statSync(path).isDirectory()) walk(path, `../${also}/`, ['node_modules', '.git']);
    else lines.push(`../${also}\t${statSync(path).size}\t${statSync(path).mtimeMs}`);
  }
  for (const file of SHARED) {
    const path = join(root, file);
    lines.push(`../${file}\t${existsSync(path) ? `${statSync(path).size}\t${statSync(path).mtimeMs}` : 'none'}`);
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** A package's build stamp, `{ id, inputs, deps }`, or undefined when it has none (never built here, or its dist cleared).
 *  `inputs` is what the build read (inputsOf), `deps` the id of each workspace dependency's stamp the build ran against,
 *  and `id` names this stamp: it changes whenever the package is built again. */
export function readStamp(pkg) {
  try {
    if (!existsSync(join(pkg.dir, 'dist'))) return undefined;
    const raw = readFileSync(stampPath(pkg), 'utf8');
    return { ...JSON.parse(raw), id: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
  } catch {
    return undefined;
  }
}

/** Records that `pkg` was built from `inputs` against `deps`, after a build that succeeded. */
export function writeStamp(pkg, inputs, deps) {
  mkdirSync(dirname(stampPath(pkg)), { recursive: true });
  writeFileSync(stampPath(pkg), `${JSON.stringify({ inputs, deps, at: Date.now() })}\n`);
}

/** Forgets that `pkg` was built: a build in progress, or one that failed, leaves no stamp, however much it emitted. */
export function clearStamp(pkg) {
  rmSync(stampPath(pkg), { force: true });
}

/** The names of the packages that need building, in `order`. One that has a build script is stale when it has no stamp (never
 *  built by this script, or its dist cleared, or its last build failed or was cut short), when what its build reads has
 *  changed since the stamp (`inputs(p)`: a file edited, added or deleted, or the shared compiler settings), when a package it
 *  depends on is stale (that one is built first), or when a package it depends on was built again since it was (the stamp's
 *  record of that dependency's id no longer matches `stamp(dep)`). A package in `force` (one a build is asked for, which is about
 *  to be built again) counts as stale, so what depends on it is too. A package with no build script is never stale. */
export function stalePackages(packages, order, { inputs = (p) => inputsOf(p), stamp = readStamp, force = new Set() } = {}) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const stale = new Set();
  for (const name of order) {
    const p = byName.get(name);
    if (!p.build) continue;
    const mine = stamp(p);
    const behind = (dep) => stale.has(dep) || (byName.get(dep)?.build === true && mine?.deps?.[dep] !== stamp(byName.get(dep))?.id);
    if (force.has(name) || !mine || mine.inputs !== inputs(p) || p.deps.some(behind)) stale.add(name);
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
  const stale = only || changed || process.argv.includes('--stale') ? stalePackages(packages, full, { inputs: (p) => inputsOf(p, root), force: new Set(only?.split(',').filter(Boolean)) }) : new Set();
  const named = only ? withStaleDeps(packages, only.split(',').filter(Boolean), stale) : undefined;
  let order = named ? subsetOrder(packages, named) : full;
  if (changed) order = order.filter((name) => stale.has(name));
  if (process.argv.includes('--order')) {
    process.stdout.write(`${order.join('\n')}\n`);
  } else if (process.argv.includes('--stale')) {
    process.stdout.write(order.filter((name) => stale.has(name)).map((name) => `${name}\n`).join(''));
  } else {
    if (order.length === 0) process.stdout.write('build-workspaces: every workspace is up to date\n');
    const byName = new Map(packages.map((p) => [p.name, p]));
    const result = buildAll(packages, order, (name) => {
      const p = byName.get(name);
      // The stamp goes before the build and comes back only if it succeeds on inputs that did not change under it.
      clearStamp(p);
      const before = inputsOf(p, root);
      const status = spawnSync('npm', ['run', 'build', '-w', name], { cwd: root, stdio: 'inherit' }).status ?? 1;
      if (status === 0 && inputsOf(p, root) === before) writeStamp(p, before, Object.fromEntries(p.deps.filter((dep) => byName.get(dep)?.build).map((dep) => [dep, readStamp(byName.get(dep))?.id ?? 'none'])));
      return status;
    });
    if (result.failed) {
      process.stderr.write(`build-workspaces: ${result.failed}'s build failed (${result.status}); nothing after it was built\n`);
      process.exit(result.status || 1);
    }
  }
}
