import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { importBranch, openImport } from './release-website.mjs';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', ['-c', 'gc.auto=0', ...args], { cwd }).then(out => out.stdout.trim());
const tag = 'v0.1.0-beta.44';

/** A website checkout of main with a bare repository as its origin, as actions/checkout leaves it, and `change` applied to its tree. */
async function website(t, change) {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-release-website-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'website');
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await exec('git', ['init', '-q', '-b', 'main', work]);
  await writeFile(join(work, 'release.json'), '{"tag":"v0.1.0-beta.43"}\n');
  await git(work, 'add', '-A');
  await git(work, '-c', 'user.name=someone', '-c', 'user.email=someone@example.com', 'commit', '-q', '-m', 'start');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-q', 'origin', 'main');
  if (change) await change(work, origin);
  return { work, origin };
}

/** A fake GitHub API: answers by method and path (query included), records every call. */
function github(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const { pathname, search } = new URL(url);
    calls.push({ method, path: pathname + search, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
    const answer = routes[`${method} ${pathname}${search}`];
    if (answer === undefined) throw new Error(`unexpected ${method} ${pathname}${search}`);
    const [status, body] = answer;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

const open = '/repos/Parcha-ai/agentrun-website/pulls?head=Parcha-ai%3Arelease%2Fv0.1.0-beta.44-content&state=open';
const routes = (more = {}) => ({
  [`GET ${open}`]: [200, []],
  'GET /users/agentrun-website-import%5Bbot%5D': [200, { id: 4242, login: 'agentrun-website-import[bot]' }],
  'POST /repos/Parcha-ai/agentrun-website/pulls': [201, { html_url: 'https://github.com/Parcha-ai/agentrun-website/pull/70', number: 70 }],
  ...more,
});
const run = (work, fetchImpl) => openImport({ tag, dir: work, token: 'app-token', appSlug: 'agentrun-website-import', wait: async () => {}, fetchImpl });

test('the import\'s branch is named for the tag', () => {
  assert.equal(importBranch('v0.1.0-beta.44'), 'release/v0.1.0-beta.44-content');
  assert.throws(() => importBranch('main'), /not a release tag/);
  assert.throws(() => importBranch('v0.1.0-beta.44; rm'), /not a release tag/);
});

test('a website that already has the tag (nothing changed) is a notice, and nothing is pushed or opened', async (t) => {
  const { work, origin } = await website(t);
  const fake = github(routes());
  assert.equal(await run(work, fake.fetchImpl), `::notice::website already has ${tag}`);
  assert.deepEqual(fake.calls, []);
  assert.equal(await git(origin, 'branch', '--list', 'release/*'), '');
});

test('a changed import is committed as the App\'s bot on release/<tag>-content, pushed, and opened as a pull request to main', async (t) => {
  const { work, origin } = await website(t, async work => {
    await writeFile(join(work, 'release.json'), '{"tag":"v0.1.0-beta.44"}\n');
    await writeFile(join(work, 'new-page.md'), '# New\n');
  });
  const fake = github(routes());
  const line = await run(work, fake.fetchImpl);
  assert.equal(line, `Opened https://github.com/Parcha-ai/agentrun-website/pull/70: content: import AgentRun ${tag}`);
  const head = await git(origin, 'rev-parse', 'refs/heads/release/v0.1.0-beta.44-content');
  assert.equal(await git(origin, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', head), 'agentrun-website-import[bot] <4242+agentrun-website-import[bot]@users.noreply.github.com>|agentrun-website-import[bot] <4242+agentrun-website-import[bot]@users.noreply.github.com>|content: import AgentRun v0.1.0-beta.44');
  assert.equal(await git(origin, 'show', `${head}:new-page.md`), '# New', 'untracked files are imported too');
  assert.equal(await git(origin, 'rev-parse', `${head}^`), await git(origin, 'rev-parse', 'refs/heads/main'), 'one commit on main');
  const post = fake.calls.find(call => call.method === 'POST');
  assert.equal(post.auth, 'Bearer app-token');
  assert.equal(post.body.title, `content: import AgentRun ${tag}`);
  assert.equal(post.body.head, 'release/v0.1.0-beta.44-content');
  assert.equal(post.body.base, 'main');
  assert.match(post.body.body, /https:\/\/github\.com\/Parcha-ai\/agentrun\/releases\/tag\/v0\.1\.0-beta\.44/);
  assert.match(post.body.body, /scripts\/import-content\.py v0\.1\.0-beta\.44 --release-tag v0\.1\.0-beta\.44/);
  assert.doesNotMatch(post.body.body, /\/home\/|\/srv\/|runner/, 'no machine path');
});

test('a re-run is a notice: the branch exists already, or a pull request for it is open, and nothing is pushed or opened again', async (t) => {
  const { work, origin } = await website(t, async (work, origin) => {
    await git(work, 'push', '-q', origin, 'main:refs/heads/release/v0.1.0-beta.44-content');
    await writeFile(join(work, 'release.json'), '{"tag":"v0.1.0-beta.44"}\n');
  });
  const before = await git(origin, 'rev-parse', 'refs/heads/release/v0.1.0-beta.44-content');
  const branch = github(routes());
  // A branch with no open pull request may be one a person closed: it is never reopened, and the notice says how to import again.
  assert.equal(await run(work, branch.fetchImpl), `::notice::website import skipped: the branch release/${tag}-content exists already; with no pull request open for it, delete the branch and re-run this job to import again`);
  assert.ok(!branch.calls.some(call => call.method === 'POST'));
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/release/v0.1.0-beta.44-content'), before, 'the branch is not moved');

  const { work: other } = await website(t, async work => writeFile(join(work, 'release.json'), '{"tag":"v0.1.0-beta.44"}\n'));
  const pull = github(routes({ [`GET ${open}`]: [200, [{ html_url: 'https://github.com/Parcha-ai/agentrun-website/pull/69' }]] }));
  assert.equal(await run(other, pull.fetchImpl), '::notice::website import skipped: https://github.com/Parcha-ai/agentrun-website/pull/69 is open for it already');
  assert.ok(!pull.calls.some(call => call.method === 'POST'));
});

test('a failed write is said with GitHub\'s answer', async (t) => {
  const { work } = await website(t, async work => writeFile(join(work, 'release.json'), '{"tag":"v0.1.0-beta.44"}\n'));
  const fake = github(routes({ 'POST /repos/Parcha-ai/agentrun-website/pulls': [422, { message: 'Validation Failed' }] }));
  await assert.rejects(run(work, fake.fetchImpl), /GitHub answered 422 to the pull request: Validation Failed/);
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1, 'sent once');
  assert.equal(JSON.parse(await readFile(join(work, 'release.json'), 'utf8')).tag, 'v0.1.0-beta.44');
});
