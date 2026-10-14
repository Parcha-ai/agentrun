// The pi family in the package check's consumer: which copies it landed on, which version the repository develops the
// durable packages on, and which of our packages' peer ranges keep the consumer from that version.
import { isUpstream, resolveDependency, upstreamName } from './pi-family-pins.mjs';

const durable = '@earendil-works/pi-durable';
const chord = '@earendil-works/chord';
const developedFrom = 'packages/pi';

const parse = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version);
  if (!match) throw new Error(`Not a version: ${version}`);
  return match.slice(1).map(Number);
};
const compare = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const partial = text => { const parts = text.replace(/^[v=]/, '').split('.'); return [0, 1, 2].map(i => (parts[i] === undefined || /^[xX*]$/.test(parts[i]) ? undefined : Number(parts[i]))); };
const floor = p => p.map(part => part ?? 0);
const bump = (p, at) => p.map((part, i) => (i < at ? part : i === at ? (part ?? 0) + 1 : 0));

/** Whether `version` satisfies a range of space-separated comparators (`>=1.0.0 <1.1.0`, `^1.2.0`, `~1.2.0`, `1.x`, `*`), or `||` alternatives. */
export function satisfies(version, range) {
  const v = parse(version);
  return range.split('||').some(alternative => alternative.trim().split(/\s+/).filter(Boolean).every(comparator => {
    const match = /^(>=|<=|>|<|\^|~|=)?(.+)$/.exec(comparator);
    const operator = match?.[1] ?? '=';
    if (!match || !/^[v=]?(\d+|[xX*])(\.(\d+|[xX*])){0,2}(?:-.+)?$/.test(match[2]) && match[2] !== '*') throw new Error(`Unsupported version range: ${range}`);
    const p = partial(match[2].replace(/-.+$/, ''));
    const known = p.filter(part => part !== undefined).length;
    if (known === 0) return true;
    if (operator === '>=') return compare(v, floor(p)) >= 0;
    if (operator === '>') return compare(v, bump(p, known - 1)) >= 0;
    if (operator === '<') return compare(v, floor(p)) < 0;
    if (operator === '<=') return compare(v, bump(p, known - 1)) < 0;
    const low = floor(p);
    const high = operator === '^' ? bump(p, p[0] ? 0 : p[1] ? 1 : 2) : operator === '~' ? bump(p, known === 1 ? 0 : 1) : bump(p, known - 1);
    return compare(v, low) >= 0 && compare(v, high) < 0;
  }));
}

/** The versions the repository develops the durable packages on: what the root lockfile resolves for the pi package. One
 *  source, so the check cannot disagree with the version the tests run on. */
export function developedVersions(rootLock) {
  const entry = name => resolveDependency(rootLock, developedFrom, name)?.version;
  const result = { [durable]: entry(durable), [chord]: entry(chord) };
  for (const [name, version] of Object.entries(result)) if (!version) throw new Error(`The repository lockfile does not resolve ${name} for ${developedFrom}`);
  return result;
}

/** The workspace packages whose own lockfile resolution of pi-durable or chord is not the developed version. The consumer is
 *  pinned to the versions the lockfile holds, so such a package keeps the consumer there however wide the peer ranges are. */
export function laggingWorkspaces(rootLock, developed) {
  return Object.entries(rootLock).filter(([location]) => /^packages\/[^/]+$/.test(location)).flatMap(([location, entry]) =>
    Object.keys(developed).flatMap(name => {
      const version = (entry.devDependencies?.[name] || entry.dependencies?.[name]) && resolveDependency(rootLock, location, name)?.version;
      return version && version !== developed[name] ? [{ package: entry.name ?? location, name, version }] : [];
    }));
}

/** Every @earendil-works package in a consumer lockfile, with its location, sorted by location. */
export function listCopies(consumerPackages) {
  return Object.entries(consumerPackages ?? {})
    .filter(([location]) => location.includes('node_modules/') && isUpstream(upstreamName(location)))
    .map(([location, entry]) => ({ name: upstreamName(location), version: entry.version, location }))
    .sort((a, b) => a.location.localeCompare(b.location));
}

/** Problems with the pi family in the consumer: more than one copy of pi-durable or chord, or a copy that is not the developed
 *  version. `peers` maps each of our package names to its peer ranges; a package whose range excludes the developed version
 *  is named, because that is where the fix goes, and so is a workspace package that still develops on the older copy. */
export function checkPiFamily(copies, developed, peers, lagging = []) {
  const problems = [];
  for (const name of [durable, chord]) {
    const held = copies.filter(copy => copy.name === name);
    const want = developed[name];
    if (held.length !== 1) problems.push(`The consumer holds ${held.length} copies of ${name} (${held.map(copy => `${copy.version} at ${copy.location}`).join(', ') || 'none'}); a host needs exactly one.`);
    for (const copy of held) {
      if (copy.version === want) continue;
      const blockers = Object.entries(peers).filter(([, ranges]) => ranges[name] && !satisfies(want, ranges[name])).map(([pkg, ranges]) => `${pkg} (peer ${name} "${ranges[name]}")`);
      const holders = lagging.filter(entry => entry.name === name && entry.version === copy.version).map(entry => `${entry.package} (devDependencies resolve ${name}@${entry.version})`);
      const causes = [
        blockers.length ? `The peer range of ${blockers.join(', ')} excludes ${want}; widen it to admit ${want}.` : '',
        holders.length ? `The repository lockfile still holds ${copy.version} for ${holders.join(', ')}, and the consumer is pinned to the versions the lockfile holds; move those devDependencies to ${want}.` : '',
      ].filter(Boolean);
      problems.push(`The consumer resolved ${name}@${copy.version} at ${copy.location}, but the repository develops the durable packages on ${want}.${causes.length ? ` ${causes.join(' ')}` : ''}`);
    }
  }
  return problems;
}
