// The weekly better-auth advisory check, with no network: a fixture feed from both sources, the exact public issue it
// opens, and the workflow that runs it (schedule or by hand, its own token, two permissions, actions pinned by SHA).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACKNOWLEDGED, check, compare, covers, findings, issueOf, pinnedVersion } from './better-auth-advisories.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SECRET_WORDS = 'exploit the session fixation by replaying the cookie';
const vuln = (name, range, patched, field = 'first_patched_version') => ({ package: { ecosystem: 'npm', name }, vulnerable_version_range: range, [field]: patched, vulnerable_functions: [] });
/** The advisory database's answer: one advisory that covers 1.7.14 and one fixed before it. */
const DATABASE = [
  { ghsa_id: 'GHSA-aaaa-1111-aaaa', summary: SECRET_WORDS, description: SECRET_WORDS, vulnerabilities: [vuln('better-auth', '>= 1.6.17, < 1.7.15', '1.7.15')] },
  { ghsa_id: 'GHSA-bbbb-2222-bbbb', summary: SECRET_WORDS, description: SECRET_WORDS, vulnerabilities: [vuln('better-auth', '< 1.7.7', '1.7.7')] },
];
/** better-auth's own repository advisories: one with no fix yet, one for a package this server does not use, and the
 *  database's first again. */
const REPOSITORY = [
  { ghsa_id: 'GHSA-cccc-3333-cccc', summary: SECRET_WORDS, vulnerabilities: [vuln('@better-auth/passkey', '<= 1.7.14', '', 'patched_versions'), vuln('better-auth', '<= 1.7.14', '', 'patched_versions')] },
  { ghsa_id: 'GHSA-dddd-4444-dddd', summary: SECRET_WORDS, vulnerabilities: [vuln('@better-auth/api-key', '< 1.7.20', '1.7.20', 'patched_versions')] },
  { ghsa_id: 'GHSA-aaaa-1111-aaaa', summary: SECRET_WORDS, vulnerabilities: [vuln('better-auth', '>= 1.6.17, < 1.7.15', '1.7.15', 'patched_versions')] },
];
const TITLE = 'better-auth 1.7.14: an advisory covers the pinned version';
const BODY = [
  'The weekly advisory check found 2 advisories whose affected range covers `better-auth@1.7.14`, the version `packages/serve/package.json` pins:',
  '',
  '- GHSA-aaaa-1111-aaaa: affected `>= 1.6.17, < 1.7.15`, fixed in `1.7.15`',
  '- GHSA-cccc-3333-cccc: affected `<= 1.7.14`, fixed in no release yet',
  '',
  'Move the pin to a fixed release, or say here why it does not apply.',
].join('\n');

test('ranges: comparators joined by commas all hold, || takes either side, prereleases sort before their release', () => {
  assert.equal(covers('>= 1.6.17, < 1.7.15', '1.7.14'), true);
  assert.equal(covers('< 1.7.7', '1.7.14'), false);
  assert.equal(covers('<= 1.7.14', '1.7.14'), true);
  assert.equal(covers('> 1.7.14', '1.7.14'), false);
  assert.equal(covers('= 1.7.14', '1.7.14'), true);
  assert.equal(covers('1.7.13', '1.7.14'), false);
  assert.equal(covers('< 1.0.0 || >= 1.7.10, < 1.8.0', '1.7.14'), true);
  assert.equal(covers('< 1.7.14-beta.2', '1.7.14'), false);
  assert.equal(covers('<= 1.7.14-beta.2', '1.7.14-beta.1'), true);
  assert.equal(covers('a range nobody wrote', '1.7.14'), true, 'what cannot be read is looked at, not missed');
  assert.deepEqual([compare('1.10.0', '1.9.9'), compare('1.7.14-rc.1', '1.7.14'), compare('1.7.14-beta.10', '1.7.14-beta.9'), compare('1.7.14', '1.7.14')], [1, -1, 1, 0]);
});

test('the pin must be exact', () => {
  assert.equal(pinnedVersion({ dependencies: { 'better-auth': '1.7.14' } }), '1.7.14');
  for (const range of ['^1.7.14', '~1.7.14', '>=1.7.14', 'latest', undefined]) assert.throws(() => pinnedVersion({ dependencies: { 'better-auth': range } }), /pin better-auth exactly/);
  assert.equal(pinnedVersion(JSON.parse(readFileSync(join(root, 'packages/serve/package.json'), 'utf8'))), '1.7.14', 'what serve pins today');
});

test('from the fixture feed: the advisories whose range covers the pin, once each, and the exact issue, which names only GHSA ids, ranges and fixed versions', () => {
  const found = findings('1.7.14', [...DATABASE, ...REPOSITORY]);
  assert.deepEqual(found, [{ ghsa: 'GHSA-aaaa-1111-aaaa', range: '>= 1.6.17, < 1.7.15', fixed: '1.7.15' }, { ghsa: 'GHSA-cccc-3333-cccc', range: '<= 1.7.14', fixed: null }]);
  const issue = issueOf('1.7.14', found);
  assert.equal(issue.title, TITLE);
  assert.equal(issue.body, BODY);
  assert.ok(!issue.body.includes(SECRET_WORDS));
  assert.deepEqual(findings('1.7.15', [...DATABASE, ...REPOSITORY]), [], 'a range that does not cover the version is no finding');
  assert.deepEqual(findings('1.7.6', DATABASE).map((f) => f.ghsa), ['GHSA-aaaa-1111-aaaa', 'GHSA-bbbb-2222-bbbb']);
});

/** A fake GitHub API: the feeds above, the open issues given, and every write it was sent. */
function fakeGitHub(openIssues, { repositoryFails = false, database = DATABASE } = {}) {
  const writes = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.github.com/', '');
    const answer = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (init.method === 'POST') return writes.push({ path, body: JSON.parse(init.body) }), answer(201, {});
    if (path === 'advisories?ecosystem=npm&affects=better-auth@1.7.14&per_page=100') return answer(200, database);
    if (path.startsWith('repos/better-auth/better-auth/security-advisories')) return repositoryFails ? answer(403, {}) : answer(200, REPOSITORY);
    if (path === 'repos/Parcha-ai/agentrun/issues?state=open&per_page=100') return answer(200, openIssues);
    return answer(404, {});
  };
  return { fetchImpl, writes };
}

test('a finding opens the issue, or comments on the open one with the same title, and exits 1; none found opens nothing and exits 0', async () => {
  const run = (fake, extra = {}) => check({ root, repository: 'Parcha-ai/agentrun', token: 'test-token', fetchImpl: fake.fetchImpl, log: () => {}, ...extra });
  const fresh = fakeGitHub([{ number: 3, title: 'another issue' }, { number: 4, title: TITLE, pull_request: {} }]);
  assert.equal(await run(fresh), 1);
  assert.deepEqual(fresh.writes, [{ path: 'repos/Parcha-ai/agentrun/issues', body: { title: TITLE, body: BODY } }]);
  const known = fakeGitHub([{ number: 9, title: TITLE }]);
  assert.equal(await run(known), 1);
  assert.deepEqual(known.writes, [{ path: 'repos/Parcha-ai/agentrun/issues/9/comments', body: { body: BODY } }]);
  const quiet = fakeGitHub([], { database: [DATABASE[1]] });
  quiet.fetchImpl = ((inner) => async (url, init) => (url.includes('security-advisories') ? { ok: true, status: 200, json: async () => [] } : inner(url, init)))(quiet.fetchImpl);
  assert.equal(await run(quiet), 0);
  assert.deepEqual(quiet.writes, []);
  const said = [];
  const blind = fakeGitHub([]);
  assert.equal(await run(blind, { repositoryFails: true, log: (line) => said.push(line), fetchImpl: fakeGitHub([], { repositoryFails: true }).fetchImpl }), 1, "the database's finding stands without the repository's feed");
  assert.match(said[0], /^::warning::/);
  const dry = fakeGitHub([]);
  assert.equal(await run(dry, { dryRun: true }), 1);
  assert.deepEqual(dry.writes, []);
});

test('a manifest whose pin is a range stops the check before it reads anything', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'advisories-'));
  try {
    mkdirSync(join(dir, 'packages/serve'), { recursive: true });
    writeFileSync(join(dir, 'packages/serve/package.json'), JSON.stringify({ dependencies: { 'better-auth': '^1.7.14' } }));
    const fake = fakeGitHub([]);
    await assert.rejects(check({ root: dir, repository: 'Parcha-ai/agentrun', token: 't', fetchImpl: fake.fetchImpl, log: () => {} }), /exactly/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow: weekly or by hand, never on a pull request; its own token with contents: read and issues: write only; every action pinned by commit SHA', () => {
  const workflow = readFileSync(join(root, '.github/workflows/better-auth-advisories.yml'), 'utf8');
  const lines = workflow.split('\n');
  const block = (key) => {
    const start = lines.indexOf(`${key}:`);
    assert.ok(start >= 0, `${key} is a top-level key`);
    const end = lines.findIndex((line, index) => index > start && /^[a-z]/.test(line));
    return lines.slice(start, end).filter((line) => line.trim() !== '').join('\n');
  };
  assert.match(block('on'), /^on:\n {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \d'\n {2}workflow_dispatch:$/);
  assert.equal(block('permissions'), 'permissions:\n  contents: read\n  issues: write');
  assert.doesNotMatch(workflow, /pull_request|secrets\./);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /node scripts\/better-auth-advisories\.mjs/);
  const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line));
  assert.ok(uses.length >= 1);
  for (const line of uses) assert.match(line, /uses: actions\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line);
  assert.ok(!lines.some((line) => /^\s+permissions:/.test(line)), 'no job widens the permissions');
});

test('an acknowledged advisory, with why and until when, is left out until its date passes, and then counts again', () => {
  const known = [{ ghsa: 'GHSA-aaaa-1111-aaaa', why: 'a plugin this server does not use', until: '2026-12-31' }];
  assert.deepEqual(findings('1.7.14', DATABASE, known, new Date('2026-11-01T00:00:00Z')), []);
  assert.deepEqual(findings('1.7.14', DATABASE, known, new Date('2027-01-01T00:00:00Z')).map((f) => f.ghsa), ['GHSA-aaaa-1111-aaaa']);
  for (const entry of ACKNOWLEDGED) {
    assert.match(entry.ghsa, /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
    assert.ok(entry.why.length > 10, entry.ghsa);
    assert.ok(!Number.isNaN(Date.parse(entry.until)), entry.ghsa);
  }
});
