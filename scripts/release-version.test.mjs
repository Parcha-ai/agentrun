import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, manifestVersions, newestRelease, NPM_PACKAGE, readPublished, versionVerdict } from './release-version.mjs';

test('versions order as semver does: numbers by value, a prerelease below its release, beta.9 below beta.10', () => {
  const ordered = [
    '0.0.0-bootstrap.0',
    '0.1.0-beta.1',
    '0.1.0-beta.2',
    '0.1.0-beta.9',
    '0.1.0-beta.10',
    '0.1.0-beta.43',
    '0.1.0-beta.44',
    '0.1.0',
    '0.1.1-beta.1',
    '0.1.1',
    '0.2.0',
    '0.10.0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (const [i, a] of ordered.entries()) {
    for (const [j, b] of ordered.entries()) assert.equal(compareVersions(a, b), Math.sign(i - j), `${a} vs ${b}`);
  }
  assert.equal(compareVersions('v0.1.0-beta.43', '0.1.0-beta.43'), 0, 'a tag\'s v is not part of its version');
  assert.equal(compareVersions('0.1.0-beta.43+build.7', '0.1.0-beta.43'), 0, 'build metadata does not order');
  for (const bad of ['', 'beta.44', '0.1', '0.1.0-', '01.1.0', '0.1.0-beta.01', 'latest', undefined]) assert.throws(() => compareVersions(bad, '0.1.0'), /not a version/, String(bad));
});

const manifests = version => ({ 'package.json': version, 'packages/serve/package.json': version, 'packages/dsl/package.json': version });

test('a tag newer than npm\'s latest and the newest GitHub release, at the version its manifests say, goes', () => {
  const verdict = versionVerdict({ tag: 'v0.1.0-beta.44', manifests: manifests('0.1.0-beta.44'), npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.43' });
  assert.equal(verdict.pass, true, verdict.reason);
  assert.match(verdict.line, /v0\.1\.0-beta\.44 is newer than npm's latest @parcha\/agentrun-serve 0\.1\.0-beta\.43 and the newest GitHub release v0\.1\.0-beta\.43/);
  assert.equal(NPM_PACKAGE, '@parcha/agentrun-serve');
  assert.equal(versionVerdict({ tag: 'v0.1.0', manifests: manifests('0.1.0'), npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.43' }).pass, true, 'the release after the betas');
  assert.equal(versionVerdict({ tag: 'v0.1.0-beta.10', manifests: manifests('0.1.0-beta.10'), npmLatest: '0.1.0-beta.9', githubLatest: 'v0.1.0-beta.9' }).pass, true, 'beta.10 after beta.9, though "10" < "9" as text');
  assert.equal(versionVerdict({ tag: 'v0.1.0-beta.1', manifests: manifests('0.1.0-beta.1'), npmLatest: null, githubLatest: null }).pass, true, 'nothing out yet');
});

test('a tag equal to or older than either published version stops, in one line naming both', () => {
  const stops = (input, reason) => {
    const verdict = versionVerdict({ manifests: manifests(input.tag.slice(1)), ...input });
    assert.equal(verdict.pass, false, JSON.stringify(input));
    assert.match(verdict.reason, reason);
    assert.doesNotMatch(verdict.reason, /\n/, 'one line');
  };
  const both = /npm's latest @parcha\/agentrun-serve is 0\.1\.0-beta\.43, the newest GitHub release is v0\.1\.0-beta\.43/;
  stops({ tag: 'v0.1.0-beta.43', npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.43' }, /^v0\.1\.0-beta\.43 is not newer than what is out \(equal\)/);
  stops({ tag: 'v0.1.0-beta.43', npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.43' }, both);
  stops({ tag: 'v0.1.0-beta.42', npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.43' }, /\(older\)/);
  stops({ tag: 'v0.1.0-beta.9', npmLatest: '0.1.0-beta.10', githubLatest: 'v0.1.0-beta.10' }, /\(older\)/);
  stops({ tag: 'v0.1.0-beta.44', npmLatest: '0.1.0-beta.44', githubLatest: 'v0.1.0-beta.43' }, /\(equal\).*npm's latest @parcha\/agentrun-serve is 0\.1\.0-beta\.44, the newest GitHub release is v0\.1\.0-beta\.43/);
  stops({ tag: 'v0.1.0-beta.44', npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.44' }, /\(equal\)/);
  stops({ tag: 'v0.1.0-beta.44', npmLatest: '0.1.0', githubLatest: 'v0.1.0-beta.43' }, /\(older\)/);
  stops({ tag: 'v0.1.0-beta.44', npmLatest: 'nonsense', githubLatest: 'v0.1.0-beta.43' }, /npm's latest .* is not a version/);
  stops({ tag: '0.1.0-beta.44', npmLatest: null, githubLatest: null }, /not a release tag/);
  stops({ tag: 'v0.1.0-beta.044', npmLatest: null, githubLatest: null }, /not a release tag/);
});

test('the tag must be the version every workspace manifest at the tag says', () => {
  const verdict = versionVerdict({ tag: 'v0.1.0-beta.44', manifests: { ...manifests('0.1.0-beta.44'), 'packages/serve/package.json': '0.1.0-beta.43' }, npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.43' });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /^v0\.1\.0-beta\.44 is not the version at the tag: packages\/serve\/package\.json says 0\.1\.0-beta\.43/);
  assert.equal(versionVerdict({ tag: 'v0.1.0-beta.44', manifests: {}, npmLatest: null, githubLatest: null }).pass, false, 'no manifest read is no pass');
});

test('the manifests read are the root\'s and every workspace package\'s, but not a package on a version line of its own', () => {
  const read = manifestVersions();
  assert.ok('package.json' in read);
  assert.ok('packages/serve/package.json' in read);
  assert.ok(!('packages/agentrun/package.json' in read), '@parcha/agentrun has its own version line');
  assert.equal(new Set(Object.values(read)).size, 1, 'this checkout is at one workspace version');
});

test('the newest GitHub release is the highest version among published releases, drafts and other tags aside', () => {
  const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: true, ...extra });
  assert.equal(newestRelease([release('v0.1.0-beta.9'), release('v0.1.0-beta.10'), release('v0.1.0-beta.8')]), 'v0.1.0-beta.10');
  assert.equal(newestRelease([release('v0.1.0-beta.43'), release('v0.1.0-beta.44', { draft: true }), release('nightly'), release('v0.1.0-beta.42')]), 'v0.1.0-beta.43');
  assert.equal(newestRelease([]), null);
  assert.throws(() => newestRelease({ message: 'Not Found' }), /could not be read/);
});

test('the reader asks npm for the dist-tags and GitHub for every page of releases, retries, and fails closed', async () => {
  const calls = [];
  const fake = routes => async url => {
    calls.push(url);
    for (const [pattern, answers] of routes) {
      if (!pattern.test(url)) continue;
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return typeof next === 'number' ? { ok: false, status: next, json: async () => ({}) } : { ok: true, status: 200, json: async () => next };
    }
    throw new Error(`unexpected ${url}`);
  };
  const page = (from, count) => Array.from({ length: count }, (_, i) => ({ tag_name: `v0.1.0-beta.${from + i}`, draft: false }));
  const read = await readPublished({
    repository: 'o/r', token: 't', wait: async () => {},
    fetchImpl: fake([
      [/registry\.npmjs\.org\/-\/package\/@parcha%2fagentrun-serve\/dist-tags$/, [502, { latest: '0.1.0-beta.43', beta: '0.1.0-beta.30' }]],
      [/releases\?per_page=100&page=1$/, [page(1, 100)]],
      [/releases\?per_page=100&page=2$/, [page(101, 3)]],
    ]),
  });
  assert.deepEqual(read, { npmLatest: '0.1.0-beta.43', githubLatest: 'v0.1.0-beta.103' });
  assert.equal(calls.filter(url => /dist-tags/.test(url)).length, 2, 'a 502 is asked again');
  calls.length = 0;
  const none = await readPublished({ repository: 'o/r', token: 't', wait: async () => {}, fetchImpl: fake([[/dist-tags$/, [404]], [/releases/, [[]]]]) });
  assert.deepEqual(none, { npmLatest: null, githubLatest: null }, 'a package npm does not know has no latest');
  await assert.rejects(readPublished({ repository: 'o/r', token: 't', wait: async () => {}, fetchImpl: fake([[/dist-tags$/, [503]], [/releases/, [[]]]]) }), /503/);
  await assert.rejects(readPublished({ repository: 'o/r', token: 't', wait: async () => {}, fetchImpl: fake([[/dist-tags$/, [{ latest: '0.1.0-beta.43' }]], [/releases/, [404]]]) }), /404/, 'a release list that cannot be read is no pass');
});
