// The workspaces built in dependency order: each package once, after every workspace package it names (dependencies,
// devDependencies, peerDependencies, optionalDependencies), so a package compiles against its dependencies' dists as
// this tree's sources make them, never a dist an earlier build left behind. A package's own build compiles itself
// alone; this order is what builds what it imports first. A cycle among the workspaces, or a build that fails, stops it
// loudly.
//   node scripts/build-workspaces.mjs            build every workspace that has a build script, in order
//   node scripts/build-workspaces.mjs --order    print the order, one package name a line, and build nothing
//   node scripts/build-workspaces.mjs --only a,b  build only those, in the same order (pi-leg.mjs: a leg's set); a package
//                                                 in it that depends on a workspace outside it with no dist stops it
//   --root <dir>                                  the repository to build (default: this script's)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

if (isMain(import.meta)) {
  const flag = (name) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  const root = flag('--root') ? resolve(flag('--root')) : ROOT;
  const packages = workspaces(root);
  const only = flag('--only');
  const order = only ? subsetOrder(packages, only.split(',').filter(Boolean)) : buildOrder(packages);
  if (process.argv.includes('--order')) {
    process.stdout.write(`${order.join('\n')}\n`);
  } else {
    const built = new Set(packages.filter((p) => p.build).map((p) => p.name));
    for (const name of order.filter((n) => built.has(n))) {
      const run = spawnSync('npm', ['run', 'build', '-w', name], { cwd: root, stdio: 'inherit' });
      if (run.status !== 0) {
        process.stderr.write(`build-workspaces: ${name}'s build failed (${run.status ?? run.signal}); nothing after it was built\n`);
        process.exit(run.status || 1);
      }
    }
  }
}
