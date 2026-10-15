// The pi family in the package check's consumer: which copies it landed on, which version the repository develops the
// durable packages on, and which of our packages' peer ranges keep the consumer from that version.
import { isUpstream, resolveDependency, upstreamName } from './pi-family-pins.mjs';

const durable = '@earendil-works/pi-durable';
const chord = '@earendil-works/chord';
const developedFrom = 'packages/pi';

const parse = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/.exec(version);
  if (!match) throw new Error(`Not a version: ${version}`);
  return { nums: match.slice(1, 4).map(Number), pre: match[4] === undefined ? [] : match[4].split('.') };
};
// semver precedence: numbers first, then a version with a prerelease sorts below the same numbers without one, and
// prerelease identifiers compare left to right (numeric ones as numbers, and below alphanumeric ones).
const compareIds = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const [x, y] = [a[i], b[i]];
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  return compareIds(a.pre, b.pre);
};
const partial = text => { const parts = text.replace(/^[v=]/, '').split('.'); return [0, 1, 2].map(i => (parts[i] === undefined || /^[xX*]$/.test(parts[i]) ? undefined : Number(parts[i]))); };
const at = (nums, pre = []) => ({ nums, pre });
const floor = (p, pre) => at(p.map(part => part ?? 0), pre);
const bump = (p, index) => at(p.map((part, i) => (i < index ? part : i === index ? (part ?? 0) + 1 : 0)));

/** Whether `version` satisfies a range of space-separated comparators (`>=1.0.0 <1.1.0`, `^1.2.0`, `~1.2.0`, `1.x`, `*`), or `||` alternatives.
 *  npm's rules for the two awkward cases: a version with a prerelease tag satisfies a set of comparators only if one of
 *  them names the same major.minor.patch with a prerelease tag, and a caret raises the first non-zero part that is
 *  written (`^0.2.1` is `>=0.2.1 <0.3.0`, `^0.0.3` is `>=0.0.3 <0.0.4`, `^0.x` is `>=0.0.0 <1.0.0`). */
export function satisfies(version, range) {
  const v = parse(version);
  return range.split('||').some(alternative => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean).map(comparator => {
      const match = /^(>=|<=|>|<|\^|~|=)?(.+)$/.exec(comparator);
      if (!match || !/^[v=]?(\d+|[xX*])(\.(\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+.+)?$/.test(match[2]) && match[2] !== '*') throw new Error(`Unsupported version range: ${range}`);
      const [core, tag] = match[2].replace(/\+.+$/, '').split(/-(.+)/);
      return { operator: match[1] ?? '=', p: partial(core), pre: tag === undefined ? [] : tag.split('.') };
    });
    const allowsPrerelease = v.pre.length === 0 || comparators.some(({ p, pre }) => pre.length > 0 && p.every((part, i) => part === v.nums[i]));
    return allowsPrerelease && comparators.every(({ operator, p, pre }) => {
      const known = p.filter(part => part !== undefined).length;
      if (known === 0) return true;
      if (operator === '>=') return compare(v, floor(p, pre)) >= 0;
      if (operator === '>') return known === 3 ? compare(v, floor(p, pre)) > 0 : compare(v, bump(p, known - 1)) >= 0;
      if (operator === '<') return compare(v, floor(p, pre)) < 0;
      if (operator === '<=') return known === 3 ? compare(v, floor(p, pre)) <= 0 : compare(v, bump(p, known - 1)) < 0;
      const low = floor(p, pre);
      const firstNonZero = p.findIndex(part => part !== undefined && part !== 0);
      const high = operator === '^' ? bump(p, firstNonZero >= 0 ? firstNonZero : known - 1) : operator === '~' ? bump(p, known === 1 ? 0 : 1) : bump(p, known - 1);
      return compare(v, low) >= 0 && compare(v, high) < 0;
    });
  });
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
    // A package whose peer range excludes the version is named even when the copy the consumer holds is that version: a pinned install
    // lands there whatever the ranges say, and the range is what a host that installs the package without the pin would meet.
    const excluding = Object.entries(peers).filter(([, ranges]) => ranges[name] && !satisfies(want, ranges[name])).map(([pkg, ranges]) => `${pkg} (peer ${name} "${ranges[name]}")`);
    if (excluding.length && held.every(copy => copy.version === want)) problems.push(`The peer range of ${excluding.join(', ')} excludes ${want}, the version the consumer holds; widen it to admit ${want}.`);
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
