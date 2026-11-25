// The repository's pnpm-lock.yaml, read. A script or test that checks a pin, a license or the dependency graph reads the
// lockfile through these, never by matching its text.
//
// pnpm writes the lockfile as YAML documents: first its own pin (the packageManager field's pnpm, with its platform
// binaries), then the project's. The project's is the last one. In it, `importers` holds each workspace project by its
// directory (`.` the root) with what its manifest names, each resolved to a reference; `packages` holds each third-party
// package version once (its integrity, platform fields, peers); `snapshots` holds each package version as resolved in
// the tree (one per set of peers it resolved, the key suffixed with them) and what it depends on, by reference.
//
// A reference is `<version>[(<peer>@<version>)...]`, `link:<path>` for a workspace package, or `<name>@<version>...` for
// an alias (`npm:<name>@<version>` in a manifest). The key of the snapshot a reference names is `<name>@<reference>`, or
// the alias's own text.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';

// yaml (a root devDependency) is loaded at the first read, not at import: build-console.mjs --stamp imports this module in
// CI's console job, where only the console's dependencies are installed, and reads no lockfile.
const yaml = () => createRequire(import.meta.url)('yaml');

/** The project's lockfile document of pnpm-lock.yaml in `dir` (the repository's, or apps/console's). */
export const readLock = (dir) => readLockFile(join(dir, 'pnpm-lock.yaml'));

/** The project's document of the pnpm lockfile at `file`: pnpm-lock.yaml, or the record of what pnpm installed
 *  (node_modules/.pnpm/lock.yaml). */
export function readLockFile(file) {
  const documents = yaml().parseAllDocuments(readFileSync(file, 'utf8'));
  const broken = documents.find((document) => document.errors?.length);
  if (broken) throw new Error(`${file} does not parse: ${broken.errors[0].message}`);
  const lock = documents.at(-1)?.toJS();
  if (lock?.lockfileVersion !== '9.0') throw new Error(`${file}: lockfileVersion ${lock?.lockfileVersion}, not the 9.0 these readers know`);
  return { ...lock, importers: lock.importers ?? {}, packages: lock.packages ?? {}, snapshots: lock.snapshots ?? {} };
}

/** `{ name, version }` of a `packages` or `snapshots` key, the peers' suffix dropped. */
export function parseKey(key) {
  const at = key.indexOf('@', 1);
  const peers = key.indexOf('(');
  return { name: key.slice(0, at), version: key.slice(at + 1, peers < 0 ? undefined : peers) };
}

/** The snapshot key the reference `ref` of the dependency `name` names, or null for a workspace link. */
export function snapshotKey(name, ref) {
  if (ref.startsWith('link:')) return null;
  return /^(?:@[^@/()]+\/)?[^@()]+@/.test(ref) ? ref : `${name}@${ref}`;
}

/** The `packages` key of a snapshot key: the same, without the peers. */
export const packageKey = (key) => { const { name, version } = parseKey(key); return `${name}@${version}`; };

/** Every third-party package version the lock holds: `{ key, name, version, entry }`, `entry` its `packages` record. */
export function lockedPackages(lock) {
  return Object.entries(lock.packages).map(([key, entry]) => ({ key, ...parseKey(key), entry }));
}

/** The versions of `name` the lock holds, sorted. */
export function lockedVersions(lock, name) {
  return [...new Set(lockedPackages(lock).filter((p) => p.name === name).map((p) => p.version))].sort();
}

/** `name@version`'s `packages` record, or undefined. */
export const lockedEntry = (lock, name, version) => lock.packages[`${name}@${version}`];

/** What a snapshot depends on, `{ name: snapshot key or null }`, optional dependencies included. */
export function snapshotDependencies(lock, key) {
  const snapshot = lock.snapshots[key] ?? {};
  return Object.fromEntries(Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies }).map(([name, ref]) => [name, snapshotKey(name, ref)]));
}

/** The importer of the workspace project at `dir` (relative to the lockfile, `.` the root), or undefined. */
export const importerOf = (lock, dir) => lock.importers[posix.normalize(dir)];

/** The reference the importer at `dir` resolves `name` to, in any of its fields, or undefined. */
export function importerRef(lock, dir, name) {
  const importer = importerOf(lock, dir) ?? {};
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    const ref = importer[field]?.[name]?.version;
    if (ref !== undefined) return ref;
  }
  return undefined;
}

/**
 * The lockfile as npm's package-lock.json v3 `packages` would hold the same tree: `{ location: entry }`, `''` the root,
 * `packages/<dir>` each workspace package (its manifest's fields), `node_modules/<name>` a hoisted package and
 * `<parent>/node_modules/<name>` one nested where its parent resolves another version than the one above it, the
 * workspace packages linked at `node_modules/<name>` (`link`, `resolved`). An entry holds `version`, `integrity`,
 * `dependencies` and `optionalDependencies` (the exact versions it resolved, an alias as `npm:<name>@<version>`, peers
 * excluded), `peerDependencies`, `peerDependenciesMeta`, `optional`, `os`, `cpu`, `libc`, and `name` when it is an alias's
 * target. The scripts that judge a consumer's npm tree against the repository's (the package checks, the source
 * inventory) read the repository's through this, so both sides are one shape.
 *
 * One version resolved with several sets of peers is one entry, as npm holds it: npmTree refuses a lock whose sets depend
 * on different versions of anything other than those peers, which npm's layout could not hold.
 *
 * A name's hoisted version is the one the root resolves, else the one most workspace packages and packages depend on
 * (the highest of a tie), as pnpm's hoisted linker places it. Every other version nests under each package that resolves
 * it. Where pnpm nests a copy one level higher than this does, a dependency still resolves the version the lock says.
 */
export function npmTree(root, lock = readLock(root)) {
  const tree = {};
  const keyAt = new Map();
  const manifest = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const own = (m) => Object.fromEntries(['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'].filter((field) => m[field] !== undefined).map((field) => [field, m[field]]));
  const dirs = Object.keys(lock.importers).sort();
  const refsOf = (importer) => Object.entries({ ...importer.devDependencies, ...importer.optionalDependencies, ...importer.dependencies }).map(([name, { version }]) => [name, version]);

  const entryFor = (key) => {
    const { name, version } = parseKey(key);
    const pkg = lock.packages[`${name}@${version}`] ?? {};
    const snapshot = lock.snapshots[key] ?? {};
    const peers = pkg.peerDependencies ?? {};
    const exact = (deps) => {
      const out = Object.fromEntries(Object.entries(deps ?? {}).filter(([dep]) => !Object.hasOwn(peers, dep)).map(([dep, ref]) => {
        const target = parseKey(snapshotKey(dep, ref));
        return [dep, target.name === dep ? target.version : `npm:${target.name}@${target.version}`];
      }));
      return Object.keys(out).length ? out : undefined;
    };
    const entry = { version, integrity: pkg.resolution?.integrity, dependencies: exact(snapshot.dependencies), optionalDependencies: exact(snapshot.optionalDependencies), peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta, optional: snapshot.optional, os: pkg.os, cpu: pkg.cpu, libc: pkg.libc };
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
  };
  const place = (location, key) => {
    const entry = entryFor(key);
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (parseKey(key).name !== name) entry.name = parseKey(key).name;
    tree[location] = entry;
    keyAt.set(location, key);
    return location;
  };
  const resolve = (location, name) => {
    for (let base = location; ; base = base.includes('/node_modules/') ? base.slice(0, base.lastIndexOf('/node_modules/')) : '') {
      const candidate = base && base !== '.' ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (tree[candidate]) return candidate;
      if (!base || base === '.') return undefined;
    }
  };
  const sameVersion = (location, key) => location && !tree[location].link && packageKey(keyAt.get(location)) === packageKey(key);

  // npm holds one copy of a version where pnpm may hold one per set of peers it resolved: this tree keeps the first, so
  // what every other one depends on (peers aside, which npm resolves from where the copy is) must be the same versions.
  const contexts = new Map();
  for (const key of Object.keys(lock.snapshots)) {
    const versions = JSON.stringify(Object.entries(entryFor(key).dependencies ?? {}).concat(Object.entries(entryFor(key).optionalDependencies ?? {})).sort());
    const seen = contexts.get(packageKey(key));
    if (seen && seen.versions !== versions) throw new Error(`${seen.key} and ${key} depend on different versions (${seen.versions} and ${versions}): npm's layout cannot hold both, so this tree would misstate one`);
    if (!seen) contexts.set(packageKey(key), { key, versions });
  }
  tree[''] = own(manifest('.'));
  for (const dir of dirs.filter((dir) => dir !== '.')) {
    const m = manifest(dir);
    tree[dir] = own(m);
    tree[`node_modules/${m.name}`] = { resolved: dir, link: true };
  }
  // Each name's hoisted version: the root's, else the most depended on.
  const hoisted = new Map();
  for (const [name, ref] of refsOf(lock.importers['.'] ?? {})) if (!ref.startsWith('link:')) hoisted.set(name, snapshotKey(name, ref));
  const dependents = new Map();
  const count = (name, target) => {
    if (!target) return;
    const counts = dependents.get(name) ?? new Map();
    counts.set(target, (counts.get(target) ?? 0) + 1);
    dependents.set(name, counts);
  };
  for (const dir of dirs.filter((dir) => dir !== '.')) for (const [name, ref] of refsOf(lock.importers[dir])) count(name, snapshotKey(name, ref));
  for (const key of Object.keys(lock.snapshots)) for (const [name, target] of Object.entries(snapshotDependencies(lock, key))) count(name, target);
  for (const [name, counts] of [...dependents].sort(([a], [b]) => a.localeCompare(b))) {
    if (hoisted.has(name) || tree[`node_modules/${name}`]) continue;
    const [best] = [...counts].sort(([a, x], [b, y]) => y - x || b.localeCompare(a, 'en', { numeric: true }));
    hoisted.set(name, best[0]);
  }
  const queue = [];
  for (const [name, key] of [...hoisted].sort(([a], [b]) => a.localeCompare(b))) if (!tree[`node_modules/${name}`]) queue.push(place(`node_modules/${name}`, key));
  // A workspace package that resolves another version than the hoisted one holds its own.
  for (const dir of dirs.filter((dir) => dir !== '.')) {
    for (const [name, ref] of refsOf(lock.importers[dir])) {
      if (ref.startsWith('link:')) continue;
      const key = snapshotKey(name, ref);
      if (!sameVersion(resolve(dir, name), key)) queue.push(place(`${dir}/node_modules/${name}`, key));
    }
  }
  // Each package's dependencies, where its location does not already resolve the version it depends on.
  for (let i = 0; i < queue.length; i++) {
    const location = queue[i];
    for (const [name, target] of Object.entries(snapshotDependencies(lock, keyAt.get(location))).sort(([a], [b]) => a.localeCompare(b))) {
      if (target && !sameVersion(resolve(location, name), target)) queue.push(place(`${location}/node_modules/${name}`, target));
    }
  }
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))));
}
