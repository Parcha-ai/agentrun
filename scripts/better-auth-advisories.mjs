// The weekly check of better-auth, which AgentRun Server pins exactly: the GitHub advisory database and better-auth's
// own repository advisories, read for any advisory whose affected range covers the pinned version. One found, it opens an
// issue (or comments on the open one with the same title) and exits 1. The issue is public, so it names each advisory's
// GHSA id, the affected range and the fixed version, and nothing of the advisory's text.
//   node scripts/better-auth-advisories.mjs   (GITHUB_REPOSITORY, GH_TOKEN; --dry-run prints and opens nothing)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE = 'better-auth';
const MANIFEST = 'packages/serve/package.json';

/** The exact version `packages/serve/package.json` pins: a range there is an error, since the check would mean nothing. */
export function pinnedVersion(manifest) {
  const version = manifest?.dependencies?.[PACKAGE];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${MANIFEST} must pin ${PACKAGE} exactly; it has ${JSON.stringify(version)}`);
  return version;
}

function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) throw new Error(`not a version: ${JSON.stringify(version)}`);
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
}

/** -1, 0 or 1, by semver precedence. */
export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (m && n) return Number(p) < Number(q) ? -1 : 1;
    if (m !== n) return m ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether a GitHub advisory range (`>= 1.6.17, < 1.7.7`, `< 1.4.2`, `= 1.2.3`; `||` between alternatives) covers
 *  `version`. A range this cannot read covers it, so it is looked at rather than missed. */
export function covers(range, version) {
  return String(range).split('||').some((alternative) =>
    alternative.split(',').every((part) => {
      const match = /^\s*(>=|<=|>|<|=)?\s*(\S+)\s*$/.exec(part);
      if (!match) return true;
      let order;
      try {
        order = compare(version, match[2]);
      } catch {
        return true;
      }
      return { '>=': order >= 0, '<=': order <= 0, '>': order > 0, '<': order < 0, '=': order === 0 }[match[1] ?? '='];
    }),
  );
}

/** The advisories, from either feed, with a better-auth range that covers `version`: GHSA id, range and fixed version,
 *  once each, in GHSA order. */
export function findings(version, advisories) {
  const found = new Map();
  for (const advisory of advisories) {
    for (const vulnerability of advisory?.vulnerabilities ?? []) {
      if (vulnerability?.package?.ecosystem !== 'npm' || vulnerability?.package?.name !== PACKAGE) continue;
      const range = vulnerability.vulnerable_version_range;
      if (typeof range !== 'string' || !covers(range, version)) continue;
      const patched = vulnerability.first_patched_version ?? vulnerability.patched_versions;
      const fixed = (typeof patched === 'object' ? patched?.identifier : patched) || null;
      if (!found.has(advisory.ghsa_id)) found.set(advisory.ghsa_id, { ghsa: advisory.ghsa_id, range, fixed });
    }
  }
  return [...found.values()].sort((a, b) => a.ghsa.localeCompare(b.ghsa));
}

/** The issue's title and body: the GHSA ids, ranges and fixed versions only. */
export function issueOf(version, found) {
  return {
    title: `${PACKAGE} ${version}: an advisory covers the pinned version`,
    body: [
      `The weekly advisory check found ${found.length === 1 ? 'an advisory' : `${found.length} advisories`} whose affected range covers \`${PACKAGE}@${version}\`, the version \`${MANIFEST}\` pins:`,
      '',
      ...found.map((f) => `- ${f.ghsa}: affected \`${f.range}\`, fixed in ${f.fixed ? `\`${f.fixed}\`` : 'no release yet'}`),
      '',
      'Move the pin to a fixed release, or say here why it does not apply.',
    ].join('\n'),
  };
}

async function github(fetchImpl, token, method, path, body) {
  const response = await fetchImpl(`https://api.github.com/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${method} ${path}`);
  return response.json();
}

/** Reads both feeds, and on a finding opens or comments on the issue: the exit code (0 none found, 1 found). */
export async function check({ root, repository, token, fetchImpl = fetch, dryRun = false, log = console.log }) {
  const version = pinnedVersion(JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')));
  const advisories = await github(fetchImpl, token, 'GET', `advisories?ecosystem=npm&affects=${PACKAGE}@${version}&per_page=100`);
  let own = [];
  try {
    own = await github(fetchImpl, token, 'GET', 'repos/better-auth/better-auth/security-advisories?state=published&per_page=100');
  } catch (error) {
    log(`::warning::better-auth's repository advisories could not be read (${error.message}); the advisory database was`);
  }
  const found = findings(version, [...advisories, ...own]);
  if (!found.length) {
    log(`No advisory covers ${PACKAGE}@${version}.`);
    return 0;
  }
  const issue = issueOf(version, found);
  log(`${issue.title}\n\n${issue.body}`);
  if (dryRun) return 1;
  const open = await github(fetchImpl, token, 'GET', `repos/${repository}/issues?state=open&per_page=100`);
  const same = open.find((item) => !item.pull_request && item.title === issue.title);
  if (same) await github(fetchImpl, token, 'POST', `repos/${repository}/issues/${same.number}/comments`, { body: issue.body });
  else await github(fetchImpl, token, 'POST', `repos/${repository}/issues`, { title: issue.title, body: issue.body });
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dryRun = process.argv.includes('--dry-run');
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token } = process.env;
  if (!token || (!repository && !dryRun)) {
    console.error('GH_TOKEN and GITHUB_REPOSITORY are needed');
    process.exit(2);
  }
  process.exitCode = await check({ root: fileURLToPath(new URL('..', import.meta.url)), repository, token, dryRun }).catch((error) => {
    console.error(error.message);
    return 2;
  });
}
