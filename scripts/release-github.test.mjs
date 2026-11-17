import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishRelease } from './release-github.mjs';

const sha = 'a'.repeat(40);
const tagObject = 'b'.repeat(40);

/** A fake GitHub: answers by method and path, records every call. */
function github(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    calls.push({ method, path, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
    const answer = routes[`${method} ${path}`];
    if (answer === undefined) throw new Error(`unexpected ${method} ${path}`);
    const [status, body] = typeof answer === 'number' ? [answer, {}] : answer;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

const base = { repository: 'o/r', tag: 'v0.1.0-beta.44', sha, notes: '- notes\n', token: 't', wait: async () => {} };
const created = [201, { html_url: 'https://github.com/o/r/releases/tag/v0.1.0-beta.44' }];

test('a beta is published as a prerelease titled "AgentRun v<version>" on the existing tag, never creating or moving one', async () => {
  const { calls, fetchImpl } = github({
    'GET /repos/o/r/releases/tags/v0.1.0-beta.44': 404,
    'GET /repos/o/r/git/ref/tags/v0.1.0-beta.44': [200, { object: { type: 'commit', sha } }],
    'POST /repos/o/r/releases': created,
  });
  const url = await publishRelease({ ...base, fetchImpl });
  assert.equal(url, 'https://github.com/o/r/releases/tag/v0.1.0-beta.44');
  const post = calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body, { tag_name: 'v0.1.0-beta.44', name: 'AgentRun v0.1.0-beta.44', body: '- notes\n', draft: false, prerelease: true, make_latest: 'false' });
  assert.equal(post.auth, 'Bearer t');
  assert.ok(!('target_commitish' in post.body), 'the tag names the commit; nothing else does');
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST'], 'it checks first and writes once');
});

test('an annotated tag is followed to its commit; a release that is not a prerelease is marked latest', async () => {
  const { calls, fetchImpl } = github({
    'GET /repos/o/r/releases/tags/v0.1.0': 404,
    'GET /repos/o/r/git/ref/tags/v0.1.0': [200, { object: { type: 'tag', sha: tagObject } }],
    [`GET /repos/o/r/git/tags/${tagObject}`]: [200, { object: { type: 'commit', sha } }],
    'POST /repos/o/r/releases': created,
  });
  await publishRelease({ ...base, tag: 'v0.1.0', fetchImpl });
  const post = calls.find(call => call.method === 'POST');
  assert.equal(post.body.prerelease, false);
  assert.equal(post.body.make_latest, 'true');
  assert.equal(post.body.name, 'AgentRun v0.1.0');
});

test('a release that exists for the tag stops it, saying so, and nothing is written', async () => {
  const { calls, fetchImpl } = github({ 'GET /repos/o/r/releases/tags/v0.1.0-beta.44': [200, { html_url: 'https://github.com/o/r/releases/tag/v0.1.0-beta.44' }] });
  await assert.rejects(publishRelease({ ...base, fetchImpl }), /^Error: a GitHub release for v0\.1\.0-beta\.44 exists already: https:\/\/github\.com\/o\/r\/releases\/tag\/v0\.1\.0-beta\.44; nothing was changed$/);
  assert.ok(!calls.some(call => call.method !== 'GET'));
});

test('a tag that is missing, or points anywhere but this run\'s commit, stops it before anything is written', async () => {
  const missing = github({ 'GET /repos/o/r/releases/tags/v0.1.0-beta.44': 404, 'GET /repos/o/r/git/ref/tags/v0.1.0-beta.44': 404 });
  await assert.rejects(publishRelease({ ...base, fetchImpl: missing.fetchImpl }), /the tag v0\.1\.0-beta\.44 does not exist.*never creates one/);
  assert.ok(!missing.calls.some(call => call.method !== 'GET'));
  const moved = github({ 'GET /repos/o/r/releases/tags/v0.1.0-beta.44': 404, 'GET /repos/o/r/git/ref/tags/v0.1.0-beta.44': [200, { object: { type: 'commit', sha: 'c'.repeat(40) } }] });
  await assert.rejects(publishRelease({ ...base, fetchImpl: moved.fetchImpl }), /points at c{40}, not a{40}, the commit this run released/);
  assert.ok(!moved.calls.some(call => call.method !== 'GET'));
  await assert.rejects(publishRelease({ ...base, tag: 'v0.1', fetchImpl: missing.fetchImpl }), /not a release tag/);
  await assert.rejects(publishRelease({ ...base, tag: '0.1.0-beta.44', fetchImpl: missing.fetchImpl }), /not a release tag/);
  await assert.rejects(publishRelease({ ...base, sha: 'main', fetchImpl: missing.fetchImpl }), /not a commit sha/);
  await assert.rejects(publishRelease({ ...base, notes: '  \n', fetchImpl: missing.fetchImpl }), /notes are empty/);
});

test('a failed write is said, with GitHub\'s answer, and never sent twice', async () => {
  const { calls, fetchImpl } = github({
    'GET /repos/o/r/releases/tags/v0.1.0-beta.44': 404,
    'GET /repos/o/r/git/ref/tags/v0.1.0-beta.44': [200, { object: { type: 'commit', sha } }],
    'POST /repos/o/r/releases': [422, { message: 'Validation Failed', errors: [{ code: 'already_exists', field: 'tag_name' }] }],
  });
  await assert.rejects(publishRelease({ ...base, fetchImpl }), /GitHub answered 422 to the release: Validation Failed \(tag_name already_exists\)/);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
