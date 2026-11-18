// The release's version gate: a tag is released only when it is newer than what is out already, npm's `latest` for
// @parcha/agentrun-serve and the newest GitHub release, and only when it is the version the workspace's manifests at the tag say.
//   node scripts/release-version.mjs --tag v0.1.0-beta.44   (GITHUB_REPOSITORY, GH_TOKEN; exits 0 only when it may be released)
// A release that stopped partway is finished by re-running its failed jobs, not by a new dispatch: once npm has the version,
// a new run of the same tag stops here.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownVersionPackages } from './changes.mjs';
import { getJson } from './release-ci-gate.mjs';
import { isMain } from './is-main.mjs';

/** The package whose npm `latest` says which release is out: the server, which every release publishes. */
export const NPM_PACKAGE = '@parcha/agentrun-serve';

const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** `{ core: [major, minor, patch], pre: [identifiers] }` for a semver version (a leading `v` is a tag's, not the version's), or null. */
export function parseVersion(text) {
  const match = semver.exec(String(text ?? '').replace(/^v/, ''));
  return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4] === undefined ? [] : match[4].split('.') } : null;
}

/** -1, 0 or 1 as `a` is below, equal to or above `b` in semver precedence: 0.1.0-beta.9 < 0.1.0-beta.10 < 0.1.0. Throws on a non-version. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x) throw new Error(`not a version: ${JSON.stringify(a)}`);
  if (!y) throw new Error(`not a version: ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; ; i += 1) {
    if (i === x.pre.length || i === y.pre.length) return x.pre.length === y.pre.length ? 0 : i === x.pre.length ? -1 : 1;
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return BigInt(p) < BigInt(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
}

/** The highest version among GitHub releases that are published (not drafts) and named by a version tag, or null when none is. */
export function newestRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('the GitHub releases could not be read');
  const tags = releases.filter(release => release?.draft === false && /^v/.test(release.tag_name ?? '') && parseVersion(release.tag_name)).map(release => release.tag_name);
  return tags.reduce((best, tag) => (best === null || compareVersions(tag, best) > 0 ? tag : best), null);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The version each workspace manifest under `at` says, by path: the root's and every package's but one on a version line of its own. */
export function manifestVersions(at = root) {
  const versions = { 'package.json': JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).version };
  for (const directory of readdirSync(join(at, 'packages')).sort()) {
    if (ownVersionPackages.includes(directory)) continue;
    let manifest;
    try { manifest = readFileSync(join(at, 'packages', directory, 'package.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    versions[`packages/${directory}/package.json`] = JSON.parse(manifest).version;
  }
  return versions;
}

/**
 * Whether `tag` may be released: `{ pass: true, line }`, or `{ pass: false, reason }` in one line. The tag is `v<version>`, every
 * manifest says that version, and it is newer than both `npmLatest` (npm's `latest` of NPM_PACKAGE) and `githubLatest` (the newest
 * GitHub release's tag); either may be null when nothing is out. A published version that is not a version stops it.
 */
export function versionVerdict({ tag, manifests, npmLatest, githubLatest }) {
  if (!/^v/.test(String(tag)) || !parseVersion(tag)) return { pass: false, reason: `${JSON.stringify(tag)} is not a release tag (v<version>)` };
  const version = tag.slice(1);
  const read = Object.entries(manifests ?? {});
  if (!read.length) return { pass: false, reason: `${tag}: no workspace manifest was read` };
  const off = read.filter(([, at]) => at !== version);
  if (off.length) return { pass: false, reason: `${tag} is not the version at the tag: ${off.map(([path, at]) => `${path} says ${at}`).join(', ')}` };
  const out = [[`npm's latest ${NPM_PACKAGE}`, npmLatest], ['the newest GitHub release', githubLatest]];
  for (const [what, at] of out) if (at != null && !parseVersion(at)) return { pass: false, reason: `${what} is not a version: ${JSON.stringify(at)}` };
  const named = out.map(([what, at]) => `${what} is ${at ?? 'none'}`).join(', ');
  const order = out.filter(([, at]) => at != null).map(([, at]) => compareVersions(tag, at));
  if (order.some(sign => sign <= 0)) return { pass: false, reason: `${tag} is not newer than what is out (${order.some(sign => sign < 0) ? 'older' : 'equal'}): ${named}` };
  return { pass: true, line: `${tag} is newer than npm's latest ${NPM_PACKAGE} ${npmLatest ?? '(none)'} and the newest GitHub release ${githubLatest ?? '(none)'}, and every workspace manifest at the tag says ${version}` };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** What is out: `{ npmLatest, githubLatest }`, npm's `latest` dist-tag of NPM_PACKAGE (null when npm has no such package) and `newestRelease` over every page of the repository's releases. */
export async function readPublished({ repository, token, fetchImpl = fetch, wait = sleep }) {
  const tags = await getJson(`https://registry.npmjs.org/-/package/${NPM_PACKAGE.replace('/', '%2f')}/dist-tags`, { fetchImpl, wait, absent: null, accept: 'application/json' });
  const releases = [];
  for (let page = 1; page <= 20; page += 1) {
    const listed = await getJson(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, { token, fetchImpl, wait });
    if (!Array.isArray(listed)) throw new Error('the GitHub releases could not be read');
    releases.push(...listed);
    if (listed.length < 100) break;
  }
  return { npmLatest: tags?.latest ?? null, githubLatest: newestRelease(releases) };
}

if (isMain(import.meta)) {
  const at = process.argv.indexOf('--tag');
  const tag = at > 0 ? process.argv[at + 1] : undefined;
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token } = process.env;
  try {
    const verdict = versionVerdict({ tag, manifests: manifestVersions(), ...(await readPublished({ repository, token })) });
    if (verdict.pass) console.log(verdict.line);
    else { console.error(`::error::${verdict.reason}`); process.exitCode = 1; }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : 'what is published could not be read'}`);
    process.exitCode = 1;
  }
}
