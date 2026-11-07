// The workspaces built in dependency order: each package once, after every workspace package it names (dependencies,
// devDependencies, peerDependencies, optionalDependencies), so a package compiles against its dependencies' dists as
// this tree's sources make them, never a dist an earlier build left behind. A package's own build compiles itself
// alone; this order is what builds what it imports first. A cycle among the workspaces, or a build that fails, stops it
// loudly.
//   node scripts/build-workspaces.mjs            build every workspace that has a build script, in order
//   node scripts/build-workspaces.mjs --order    print the order, one package name a line, and build nothing
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

if (isMain(import.meta)) {
  const packages = workspaces();
  const order = buildOrder(packages);
  if (process.argv.includes('--order')) {
    process.stdout.write(`${order.join('\n')}\n`);
  } else {
    const built = new Set(packages.filter((p) => p.build).map((p) => p.name));
    for (const name of order.filter((n) => built.has(n))) {
      const run = spawnSync('npm', ['run', 'build', '-w', name], { cwd: ROOT, stdio: 'inherit' });
      if (run.status !== 0) {
        process.stderr.write(`build-workspaces: ${name}'s build failed (${run.status ?? run.signal}); nothing after it was built\n`);
        process.exit(run.status || 1);
      }
    }
  }
}
