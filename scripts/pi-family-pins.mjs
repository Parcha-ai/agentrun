// Pins for the package check's consumer: every @earendil-works edge resolves at the version the repository lockfile holds
// for its parent, and the consumer's own lockfile is checked against the versions the repository holds.
import assert from 'node:assert/strict';

export const isUpstream = name => name.startsWith('@earendil-works/');
export const upstreamName = location => location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
const upstreamDependencies = entry => Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }).filter(isUpstream);
const upstreamLocations = lock => Object.keys(lock).filter(location => location.includes('node_modules/') && isUpstream(upstreamName(location)));

/** The lockfile entry a dependency of the package at `location` resolves to: its own node_modules, then each enclosing one. */
export function resolveDependency(lock, location, name) {
  for (let base = location; ; base = base.includes('/node_modules/') ? base.slice(0, base.lastIndexOf('/node_modules/')) : '') {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock[candidate]) return lock[candidate];
    if (!base) return undefined;
  }
}

/** The pins for the @earendil-works dependencies of the package at `location`, and for theirs in turn. A pinned
 *  dependency is `{ ".": version, ...its own pins }`: a plain version string would replace its own rules. */
export function pinsFor(lock, location, path = new Set()) {
  const edges = {};
  for (const dependency of upstreamDependencies(lock[location])) {
    const target = resolveDependency(lock, location, dependency);
    if (!target) continue;
    const targetLocation = Object.keys(lock).find(candidate => lock[candidate] === target);
    edges[dependency] = path.has(targetLocation) ? target.version : { '.': target.version, ...pinsFor(lock, targetLocation, new Set([...path, location])) };
  }
  return edges;
}

/** The `overrides` for the consumer, and the versions the lockfile holds per @earendil-works name.
 *  npm 11 applies neither a parent's nested rule for a package nor that package's own top-level rule when both exist,
 *  so there a package that another @earendil-works package depends on is pinned through its parent's entry only. npm 10
 *  applies a rule to a package that is also a direct dependency of the consumer only from its own top-level entry, so
 *  there every package has one. */
export function buildOverrides(lock, npmMajor) {
  const dependedOn = new Set();
  for (const location of upstreamLocations(lock)) {
    for (const dependency of upstreamDependencies(lock[location])) {
      const target = resolveDependency(lock, location, dependency);
      if (target) dependedOn.add(`${dependency}@${target.version}`);
    }
  }
  const held = new Map();
  const overrides = {};
  for (const location of upstreamLocations(lock)) {
    const entry = lock[location];
    const name = upstreamName(location);
    held.set(name, new Set([...(held.get(name) ?? []), entry.version]));
    const edges = pinsFor(lock, location);
    if (!Object.keys(edges).length) continue;
    const key = `${name}@${entry.version}`;
    if (npmMajor >= 11 && dependedOn.has(key)) continue;
    assert.ok(!overrides[key] || JSON.stringify(overrides[key]) === JSON.stringify(edges), `The repository lockfile resolves ${key} to different dependencies in different places`);
    overrides[key] = edges;
  }
  assert.ok(held.size > 0, 'The repository lockfile holds no @earendil-works package to pin the consumer to');
  return { overrides, held };
}

/** The consumer lockfile's @earendil-works entries at a version, or of a name, that `held` does not hold. */
export function findDrift(consumerPackages, held) {
  return Object.entries(consumerPackages ?? {}).flatMap(([location, entry]) => {
    if (!location.includes('node_modules/') || !isUpstream(upstreamName(location))) return [];
    const versions = held.get(upstreamName(location));
    return versions?.has(entry.version) ? [] : [`${location}@${entry.version} (repository: ${versions ? [...versions].join(' or ') : 'none'})`];
  });
}
