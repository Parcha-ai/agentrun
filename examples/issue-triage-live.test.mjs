// The live parts of the issue-triage demo, offline: the GitHub tools against a stand-in for GitHub, and the model's price from pi-ai's own catalog.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { githubTools, GithubError } from './issue-triage/github.ts';
import { catalogOf, jevOptionsOf, LEAD, live } from './issue-triage/live.ts';
import { fakes, job } from './issue-triage/job.ts';

const TOKEN = 'github-token-test-value-0123456789';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ISSUE = { number: 7, title: 'Params decode twice', body: 'See lib/params.js and docs/guide/routing.md for where.', html_url: 'https://github.com/o/r/issues/7', labels: [{ name: 'bug' }, { name: 'help wanted' }] };

const SHA = 'a'.repeat(40);
const text = (body, status = 200) => new Response(body, { status });
const TIMELINE = [{ event: 'cross-referenced', source: { issue: { number: 9, title: 'decode once', state: 'closed', pull_request: { merged_at: '2026-10-01T00:00:00Z' }, repository_url: 'https://api.github.com/repos/o/r' } } }, { event: 'labeled' }];
const DIFF = 'diff --git a/lib/params.js b/lib/params.js\nindex 1..2 100644\n--- a/lib/params.js\n+++ b/lib/params.js\n@@ -1 +1 @@\n-x\n+y\n';

/** A stand-in for GitHub: an API route is keyed by its path, any other host by host + path. */
function github(routes) {
  const seen = [];
  const fetcher = async (url, init) => {
    const { host, pathname } = new URL(url);
    seen.push({ url: String(url), host, method: init?.method, authorization: init?.headers?.Authorization });
    const route = routes[host === 'api.github.com' ? pathname : `${host}${pathname}`];
    return route ? route() : json({ message: 'Not Found' }, 404);
  };
  return { fetcher, seen, api: () => seen.filter((call) => call.host === 'api.github.com') };
}
const standard = () => github({
  '/repos/o/r/issues/7': () => json(ISSUE),
  '/repos/o/r/issues/7/timeline': () => json(TIMELINE),
  'github.com/o/r/pull/9.diff': () => text(DIFF),
  [`raw.githubusercontent.com/o/r/${SHA}/lib/params.js`]: () => text('decode(raw)\n'),
});

test('the issue tool returns the issue without its labels; the labels are a call of their own', async () => {
  const { fetcher } = standard();
  const tools = githubTools({ GITHUB_TOKEN: TOKEN }, fetcher);
  const issue = await tools.github_issue({ repo: 'o/r', number: 7 });
  assert.deepEqual(Object.keys(issue).sort(), ['body', 'number', 'title', 'url']);
  assert.deepEqual(await tools.github_labels({ repo: 'o/r', number: 7 }), { labels: ['bug', 'help wanted'] });
});

test('linked pull requests are the cross-references of the issue: title, state and merge from the event, the paths from the pull request diff', async () => {
  const run = standard();
  const tools = githubTools({}, run.fetcher);
  assert.deepEqual(await tools.github_linked_prs({ repo: 'o/r', number: 7 }), { prs: [{ number: 9, title: 'decode once', state: 'merged', paths: ['lib/params.js'] }] });
  assert.deepEqual(run.api().map((call) => new URL(call.url).pathname), ['/repos/o/r/issues/7/timeline'], 'the pull request itself is not an API request');
  // A diff GitHub will not give (too large) leaves the paths empty; the run goes on.
  const large = githubTools({}, github({ '/repos/o/r/issues/7/timeline': () => json(TIMELINE), 'github.com/o/r/pull/9.diff': () => text('too large', 406) }).fetcher);
  assert.deepEqual(await large.github_linked_prs({ repo: 'o/r', number: 7 }), { prs: [{ number: 9, title: 'decode once', state: 'merged', paths: [] }] });
  // Only the first ten paths of a diff are kept.
  const many = Array.from({ length: 14 }, (_, n) => `diff --git a/f${n}.js b/f${n}.js\n`).join('');
  const wide = githubTools({}, github({ '/repos/o/r/issues/7/timeline': () => json(TIMELINE), 'github.com/o/r/pull/9.diff': () => text(many) }).fetcher);
  assert.equal((await wide.github_linked_prs({ repo: 'o/r', number: 7 })).prs[0].paths.length, 10);
});

test('every call is a GET, the token goes only to api.github.com, and a failure never carries it', async () => {
  const { fetcher, seen } = standard();
  const tools = githubTools({ GITHUB_TOKEN: TOKEN }, fetcher);
  await tools.github_issue({ repo: 'o/r', number: 7 }); await tools.github_linked_prs({ repo: 'o/r', number: 7 });
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((call) => call.method === 'GET' && (call.host === 'api.github.com' ? call.authorization === `Bearer ${TOKEN}` : call.authorization === undefined)));
  const bare = standard(); await githubTools({}, bare.fetcher).github_issue({ repo: 'o/r', number: 7 });
  assert.equal(bare.seen[0].authorization, undefined, 'no token, no Authorization');
  const failing = githubTools({ GITHUB_TOKEN: TOKEN }, github({ '/repos/o/r/issues/8': () => json({ message: TOKEN }, 500) }).fetcher);
  await assert.rejects(failing.github_issue({ repo: 'o/r', number: 8 }), (error) => { assert.ok(error instanceof GithubError); assert.equal(error.retryable, true); assert.equal(String(error.message).includes(TOKEN), false); return true; });
  const missing = githubTools({}, github({}).fetcher);
  await assert.rejects(missing.github_issue({ repo: 'o/r', number: 8 }), (error) => error.retryable === false && error.status === 404);
  await assert.rejects(tools.github_issue({ repo: '../x', number: 1 }), /owner\/name/);
});

test('a rate limit stops the run with its reason and is not retried', async () => {
  for (const limited of [() => json({ message: 'API rate limit exceeded' }, 429), () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })]) {
    const run = github({ '/repos/o/r/issues/7': limited });
    const tools = githubTools({}, run.fetcher);
    await assert.rejects(tools.github_issue({ repo: 'o/r', number: 7 }), (error) => error instanceof GithubError && error.retryable === false && /rate limit stopped the run/.test(error.message) && /60 API requests an hour/.test(error.message));
    // A failed GET is not kept, so a later call asks again rather than replaying the failure.
    await assert.rejects(tools.github_issue({ repo: 'o/r', number: 7 }), GithubError);
    assert.equal(run.seen.length, 2);
  }
});

test('a run makes two API requests per issue whatever its pull requests and files: the issue and its timeline, each once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triage-count-'));
  try {
    const place = { root, work: join(root, 'work') };
    const run = standard();
    const tools = githubTools({}, run.fetcher);
    const args = { repo: 'o/r', number: 7, sha: SHA };
    await tools.github_issue(args); await tools.github_linked_prs(args); await tools.github_code(args, { place }); await tools.github_labels(args);
    assert.deepEqual(run.api().map((call) => new URL(call.url).pathname).sort(), ['/repos/o/r/issues/7', '/repos/o/r/issues/7/timeline']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the code the issue and its pull requests name is read at the run\'s commit and written under work/repo, a missing path is skipped, an escaping one is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triage-live-'));
  try {
    const place = { root, work: join(root, 'work') };
    const run = standard();
    const tools = githubTools({}, run.fetcher);
    // docs/guide/routing.md is named by the issue and is not in the repository (404): skipped. lib/params.js is named twice and written once.
    assert.deepEqual(await tools.github_code({ repo: 'o/r', number: 7, sha: SHA }, { place }), { paths: ['lib/params.js'] });
    assert.equal(await readFile(join(place.work, 'repo/lib/params.js'), 'utf8'), 'decode(raw)\n');
    assert.ok(run.seen.some((call) => call.url === `https://raw.githubusercontent.com/o/r/${SHA}/lib/params.js`), 'the file is read at the fixed commit, never HEAD');
    await assert.rejects(tools.github_code({ repo: 'o/r', number: 7, sha: SHA }), /run place/);
    await assert.rejects(tools.github_code({ repo: 'o/r', number: 7, sha: 'HEAD' }, { place }), /40-character/);
    // A pull request's diff names a path above the repository: refused, never written.
    const escaping = githubTools({}, github({ '/repos/o/r/issues/7': () => json(ISSUE), '/repos/o/r/issues/7/timeline': () => json(TIMELINE), 'github.com/o/r/pull/9.diff': () => text('diff --git a/../outside.js b/../outside.js\n') }).fetcher);
    await assert.rejects(escaping.github_code({ repo: 'o/r', number: 7, sha: SHA }, { place }), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the model is pi-ai's own catalog entry, only its baseUrl overridden to the gateway, and a response's usage is priced", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    request.resume();
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const usage = { input_tokens: 100_000, output_tokens: 200_000, total_tokens: 300_000, input_tokens_details: { cached_tokens: 0 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      event('response.created', { response: { id: 'resp_1', status: 'in_progress' } }),
      event('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } }),
      event('response.content_part.added', { output_index: 0, content_index: 0, item_id: 'msg_1', part: { type: 'output_text', text: '', annotations: [] } }),
      event('response.output_text.delta', { output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'ok' }),
      event('response.output_text.done', { output_index: 0, content_index: 0, item_id: 'msg_1', text: 'ok' }),
      event('response.content_part.done', { output_index: 0, content_index: 0, item_id: 'msg_1', part: { type: 'output_text', text: 'ok', annotations: [] } }),
      event('response.output_item.done', { output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] } }),
      event('response.completed', { response: { id: 'resp_1', status: 'completed', usage, output: [] } }),
    ].join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const catalog = catalogOf({ VIDEO_MODEL_BASE_URL: baseUrl, VIDEO_MODEL_API_KEY: 'not-a-secret' }, { provider: 'openai', modelId: 'gpt-6-luna' });
    const model = catalog.getModel('openai', 'gpt-6-luna');
    assert.equal(model.baseUrl, baseUrl);
    assert.deepEqual(model.cost.input, 0.1, 'the price is the catalog\'s, not ours');
    const message = await catalog.completeSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/v1\/responses$/);
    assert.notEqual(message.usage.cost, null);
    // 100,000 input tokens at $0.10 and 200,000 output tokens at $0.50 per million.
    assert.ok(Math.abs(message.usage.cost.total - 0.11) < 1e-9, `cost ${JSON.stringify(message.usage.cost)}`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('a dropped connection is a failure the entry may send again, and it names the path and nothing of the request', async () => {
  const tools = githubTools({ GITHUB_TOKEN: TOKEN }, async () => { throw new TypeError('fetch failed: ECONNRESET'); });
  await assert.rejects(tools.github_issue({ repo: 'o/r', number: 7 }), (error) => {
    assert.ok(error instanceof GithubError); assert.equal(error.retryable, true);
    assert.match(error.message, /could not be reached for GET \/repos\/o\/r\/issues\/7/); assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test('a file is written whole or not at all: the bytes go to a part file and are renamed into place, and the final path is never written to', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triage-atomic-'));
  try {
    const place = { root, work: join(root, 'work') };
    const { writeFile: write, rename } = await import('node:fs/promises');
    const log = [];
    const files = { writeFile: async (path, bytes) => { log.push(['write', path]); return write(path, bytes); }, rename: async (from, to) => { log.push(['rename', from, to]); return rename(from, to); } };
    const tools = githubTools({}, github({ '/repos/o/r/issues/7': () => json(ISSUE), '/repos/o/r/issues/7/timeline': () => json(TIMELINE), 'github.com/o/r/pull/9.diff': () => text(DIFF), [`raw.githubusercontent.com/o/r/${SHA}/lib/params.js`]: () => text('code') }).fetcher, files);
    await tools.github_code({ repo: 'o/r', number: 7, sha: SHA }, { place });
    const final = join(place.work, 'repo/lib/params.js');
    assert.equal(log.length, 2);
    assert.equal(log[0][0], 'write'); assert.match(log[0][1], /\.part$/); assert.notEqual(log[0][1], final);
    assert.deepEqual(log[1], ['rename', log[0][1], final]);
    assert.equal(await readFile(final, 'utf8'), 'code');
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(join(place.work, 'repo/lib')), ['params.js'], 'no part file is left');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live run has no fictional file: the job stages none, and the scripted github_code writes this issue's files itself", async () => {
  assert.equal(job.files, undefined);
  const root = await mkdtemp(join(tmpdir(), 'triage-fixtures-'));
  try {
    const place = { root, work: join(root, 'work') };
    const { paths } = fakes.tools.github_code({ number: 101 }, { place });
    assert.deepEqual(paths, ['lib/params.js']);
    assert.match(await readFile(join(place.work, 'repo/lib/params.js'), 'utf8'), /decodeParam/);
    await assert.rejects(readFile(join(place.work, 'repo/lib/send-file.js'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the scripted github_code writes every file the scripted researcher reads: the issue's and its pull requests'", async () => {
  const root = await mkdtemp(join(tmpdir(), 'triage-fixtures-'));
  try {
    const place = { root, work: join(root, 'work') };
    // #109's pull request changes lib/layer.js and lib/route.js; the issue itself names lib/layer.js.
    const { paths } = fakes.tools.github_code({ number: 109 }, { place });
    for (const path of ['lib/layer.js']) assert.match(await readFile(join(place.work, 'repo', path), 'utf8'), /handleRequest/);
    const fixtures = JSON.parse(await readFile(new URL('./issue-triage/fixtures.json', import.meta.url), 'utf8'));
    const issue = fixtures.issues.find((candidate) => candidate.number === 109);
    const wanted = [...new Set([...issue.paths, ...issue.prs.flatMap((pr) => pr.paths)])].filter((path) => path in fixtures.files);
    assert.deepEqual([...paths].sort(), wanted.sort(), 'every file the researcher would read is written');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the lead is demo.json\'s default, Jev goes through the gateway\'s /typesafe, and a gateway without its credential is refused', () => {
  assert.equal(`${LEAD.provider}/${LEAD.modelId}`, 'google/gemini-3.8-flash');
  assert.equal(jevOptionsOf({ VIDEO_MODEL_BASE_URL: 'http://gateway:9421/v1', TYPESAFE_API_KEY: 'k' }).baseURL, 'http://gateway:9421/typesafe');
  assert.equal(jevOptionsOf({ TYPESAFE_API_KEY: 'k' }).baseURL, undefined);
  const parts = live({ env: { VIDEO_MODEL_BASE_URL: 'http://gateway:9421/v1', VIDEO_MODEL_API_KEY: 'not-a-secret', TYPESAFE_API_KEY: 'not-a-secret' } });
  assert.equal(parts.models.lead, 'google/gemini-3.8-flash');
  assert.equal(parts.host.models.catalog.getModel('google', 'gemini-3.8-flash').baseUrl, 'http://gateway:9421/v1');
  assert.throws(() => live({ env: { VIDEO_MODEL_BASE_URL: 'http://gateway:9421/v1', TYPESAFE_API_KEY: 'x' } }), /VIDEO_MODEL_API_KEY/);
  assert.throws(() => live({ env: { TYPESAFE_API_KEY: 'x' } }), /GEMINI_API_KEY/);
  assert.throws(() => live({ env: { GEMINI_API_KEY: 'x' } }), /TYPESAFE_API_KEY/);
});
