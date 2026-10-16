// The live parts of the issue-triage demo, offline: the GitHub tools against a stand-in for GitHub, and the model's price from pi-ai's own catalog.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { githubTools, GithubError } from './issue-triage/github.ts';
import { brokerProvider, MODEL } from './issue-triage/live.ts';

const TOKEN = 'github-token-test-value-0123456789';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ISSUE = { number: 7, title: 'Params decode twice', body: 'See lib/params.js and docs/guide/routing.md for where.', html_url: 'https://github.com/o/r/issues/7', labels: [{ name: 'bug' }, { name: 'help wanted' }] };

function github(routes) {
  const seen = [];
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url);
    seen.push({ url: String(url), method: init?.method, authorization: init?.headers?.Authorization });
    const route = Object.entries(routes).find(([path]) => pathname === path);
    return route ? route[1]() : json({ message: 'Not Found' }, 404);
  };
  return { fetcher, seen };
}
const standard = () => github({
  '/repos/o/r/issues/7': () => json(ISSUE),
  '/repos/o/r/issues/7/timeline': () => json([{ event: 'cross-referenced', source: { issue: { number: 9, pull_request: {}, repository_url: 'https://api.github.com/repos/o/r' } } }, { event: 'labeled' }]),
  '/repos/o/r/pulls/9': () => json({ title: 'decode once', state: 'closed', merged_at: '2026-10-01T00:00:00Z' }),
  '/repos/o/r/pulls/9/files': () => json([{ filename: 'lib/params.js' }]),
  '/repos/o/r/contents/lib/params.js': () => json({ type: 'file', size: 12, content: Buffer.from('decode(raw)\n').toString('base64') }),
});

test('the issue tool returns the issue without its labels; the labels are a call of their own', async () => {
  const { fetcher } = standard();
  const tools = githubTools({ GITHUB_TOKEN: TOKEN }, fetcher);
  const issue = await tools.github_issue({ repo: 'o/r', number: 7 });
  assert.deepEqual(Object.keys(issue).sort(), ['body', 'number', 'title', 'url']);
  assert.deepEqual(await tools.github_labels({ repo: 'o/r', number: 7 }), { labels: ['bug', 'help wanted'] });
});

test('linked pull requests are the cross-references of the issue, with the paths each changes and whether it merged', async () => {
  const tools = githubTools({}, standard().fetcher);
  assert.deepEqual(await tools.github_linked_prs({ repo: 'o/r', number: 7 }), { prs: [{ number: 9, title: 'decode once', state: 'merged', paths: ['lib/params.js'] }] });
});

test('every call is a GET to api.github.com, the token goes only there, and a failure never carries it', async () => {
  const { fetcher, seen } = standard();
  const tools = githubTools({ GITHUB_TOKEN: TOKEN }, fetcher);
  await tools.github_issue({ repo: 'o/r', number: 7 }); await tools.github_linked_prs({ repo: 'o/r', number: 7 });
  assert.ok(seen.length >= 4);
  assert.ok(seen.every((call) => call.method === 'GET' && new URL(call.url).origin === 'https://api.github.com' && call.authorization === `Bearer ${TOKEN}`));
  const bare = standard(); await githubTools({}, bare.fetcher).github_issue({ repo: 'o/r', number: 7 });
  assert.equal(bare.seen[0].authorization, undefined, 'no token, no Authorization');
  const failing = githubTools({ GITHUB_TOKEN: TOKEN }, github({ '/repos/o/r/issues/8': () => json({ message: TOKEN }, 500) }).fetcher);
  await assert.rejects(failing.github_issue({ repo: 'o/r', number: 8 }), (error) => { assert.ok(error instanceof GithubError); assert.equal(error.retryable, true); assert.equal(String(error.message).includes(TOKEN), false); return true; });
  const missing = githubTools({}, github({}).fetcher);
  await assert.rejects(missing.github_issue({ repo: 'o/r', number: 8 }), (error) => error.retryable === false && error.status === 404);
  await assert.rejects(tools.github_issue({ repo: '../x', number: 1 }), /owner\/name/);
});

test('the code the issue and its pull requests name is written under work/repo, a missing path is skipped, an escaping one is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triage-live-'));
  try {
    const place = { root, work: join(root, 'work') };
    const tools = githubTools({}, standard().fetcher);
    // docs/guide/routing.md is named by the issue and is not in the repository (404): skipped. lib/params.js is named twice and written once.
    assert.deepEqual(await tools.github_code({ repo: 'o/r', number: 7 }, { place }), { paths: ['lib/params.js'] });
    assert.equal(await readFile(join(place.work, 'repo/lib/params.js'), 'utf8'), 'decode(raw)\n');
    await assert.rejects(tools.github_code({ repo: 'o/r', number: 7 }), /run place/);
    // A pull request's file list names a path above the repository: refused, never written.
    const escaping = githubTools({}, github({ '/repos/o/r/issues/7': () => json(ISSUE), '/repos/o/r/issues/7/timeline': () => json([{ event: 'cross-referenced', source: { issue: { number: 9, pull_request: {}, repository_url: 'https://api.github.com/repos/o/r' } } }]), '/repos/o/r/pulls/9': () => json({ title: 't', state: 'open' }), '/repos/o/r/pulls/9/files': () => json([{ filename: '../outside.js' }]) }).fetcher);
    await assert.rejects(escaping.github_code({ repo: 'o/r', number: 7 }, { place }), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the model is pi-ai's own catalog entry for openai/gpt-6-luna, only its baseUrl overridden, and a response's usage is priced", async () => {
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
    const catalog = createModels(); catalog.setProvider(brokerProvider(baseUrl));
    const model = catalog.getModel('openai', MODEL);
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
