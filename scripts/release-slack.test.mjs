import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { announce, releasePost, SLACK_ENDPOINT } from './release-slack.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./release-slack.mjs', import.meta.url));

const changelog = `# Changelog

## Unreleased

## 0.1.0-beta.44 (2026-11-18)

**Upgrading and going back:**

- Keep the same data folder and change only the image.
- SQLite keeps schema version 11 & Postgres 16 <no migration>.

**Changes:**

- Something **new**.
`;
const url = 'https://github.com/o/r/releases/tag/v0.1.0-beta.44';

/** A local stand-in for Slack's chat.postMessage: answers each request with `reply(request body)`, keeps what it got. */
async function fakeSlack(t, reply) {
  const got = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; }).on('end', () => {
      got.push({ method: request.method, path: request.url, auth: request.headers.authorization, type: request.headers['content-type'], body: JSON.parse(text) });
      const [status, body] = reply(got.at(-1));
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // A client that holds its connection open (a keep-alive, or a prober) would keep close() waiting: drop them first.
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { got, endpoint: `http://127.0.0.1:${server.address().port}/api/chat.postMessage` };
}

async function changelogFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-release-slack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'CHANGELOG.md'), changelog);
  return join(dir, 'CHANGELOG.md');
}

test('the post names the version, links the release, and gives the first lines of the upgrading block, escaped for Slack', () => {
  const text = releasePost({ tag: 'v0.1.0-beta.44', url, changelog });
  assert.equal(text, [
    `*AgentRun v0.1.0-beta.44* is out: <${url}|release notes>`,
    '*Upgrading and going back:*',
    '• Keep the same data folder and change only the image.',
    '• SQLite keeps schema version 11 &amp; Postgres 16 &lt;no migration&gt;.',
  ].join('\n'));
  assert.equal(SLACK_ENDPOINT, 'https://slack.com/api/chat.postMessage');
});

test('set: it posts with the bot token to the channel through chat.postMessage, as the stars notification does', async (t) => {
  const slack = await fakeSlack(t, () => [200, { ok: true, ts: '1.2' }]);
  const line = await announce({ env: { SLACK_BOT_TOKEN: 'fake-bot-token', SLACK_CHANNEL: 'C0TEST' }, tag: 'v0.1.0-beta.44', url, changelog: await changelogFile(t), endpoint: slack.endpoint });
  assert.equal(line, 'Posted v0.1.0-beta.44 to Slack.');
  assert.equal(slack.got.length, 1);
  const [request] = slack.got;
  assert.equal(request.method, 'POST');
  assert.equal(request.auth, 'Bearer fake-bot-token');
  assert.equal(request.type, 'application/json; charset=utf-8');
  assert.deepEqual(Object.keys(request.body).sort(), ['channel', 'text', 'unfurl_links', 'unfurl_media']);
  assert.equal(request.body.channel, 'C0TEST');
  assert.equal(request.body.unfurl_links, false);
  assert.equal(request.body.unfurl_media, false);
  assert.match(request.body.text, /^\*AgentRun v0\.1\.0-beta\.44\* is out: <https:\/\/github\.com\/o\/r\/releases\/tag\/v0\.1\.0-beta\.44\|release notes>/);
});

test('unset: one line says which setting is missing, nothing is sent, and the command exits 0', async (t) => {
  const slack = await fakeSlack(t, () => [200, { ok: true }]);
  const file = await changelogFile(t);
  for (const [env, missing] of [
    [{ SLACK_BOT_TOKEN: 'fake-bot-token', SLACK_CHANNEL: '' }, /the repository variable SLACK_RELEASES_CHANNEL is unset/],
    [{ SLACK_BOT_TOKEN: ' ', SLACK_CHANNEL: 'C0TEST' }, /the secret SLACK_STARS_BOT_TOKEN is unset/],
    [{}, /the secret SLACK_STARS_BOT_TOKEN and the repository variable SLACK_RELEASES_CHANNEL are unset/],
  ]) {
    const line = await announce({ env, tag: 'v0.1.0-beta.44', url, changelog: file, endpoint: slack.endpoint });
    assert.match(line, /^Not posted to Slack: /);
    assert.match(line, missing);
  }
  assert.equal(slack.got.length, 0);
  const { stdout } = await exec(process.execPath, [script, '--tag', 'v0.1.0-beta.44', '--url', url, '--changelog', file], { env: { PATH: process.env.PATH } });
  assert.equal(stdout.trim().split('\n').length, 1, 'one line');
  assert.match(stdout, /^Not posted to Slack: the secret SLACK_STARS_BOT_TOKEN and the repository variable SLACK_RELEASES_CHANNEL are unset/);
});

test('failing: an HTTP error, a refusal, an unreachable Slack or an unreadable changelog is a warning, never a throw, and the command exits 0', async (t) => {
  const env = { SLACK_BOT_TOKEN: 'fake-bot-token', SLACK_CHANNEL: 'C0TEST' };
  const file = await changelogFile(t);
  const down = await fakeSlack(t, () => [500, { ok: false }]);
  assert.match(await announce({ env, tag: 'v0.1.0-beta.44', url, changelog: file, endpoint: down.endpoint }), /^::warning::The release is published; posting it to Slack failed: Slack answered HTTP 500\.$/);
  const refused = await fakeSlack(t, () => [200, { ok: false, error: 'not_in_channel' }]);
  assert.match(await announce({ env, tag: 'v0.1.0-beta.44', url, changelog: file, endpoint: refused.endpoint }), /Slack refused it: not_in_channel/);
  assert.match(await announce({ env, tag: 'v0.1.0-beta.44', url, changelog: file, endpoint: 'http://127.0.0.1:1/api/chat.postMessage' }), /Slack could not be reached/);
  assert.match(await announce({ env, tag: 'v0.1.0-beta.44', url, changelog: join(file, 'missing'), endpoint: down.endpoint }), /^::warning::The release is published; posting it to Slack failed: /);
  assert.match(await announce({ env, tag: 'v0.1.0-beta.45', url, changelog: file, endpoint: down.endpoint }), /no section for 0\.1\.0-beta\.45/);
  for (const line of [await announce({ env, tag: 'v0.1.0-beta.44', url, changelog: file, endpoint: down.endpoint })]) assert.doesNotMatch(line, /fake-bot-token/, 'the token is never printed');
  const { stdout } = await exec(process.execPath, [script, '--tag', 'v0.1.0-beta.44', '--url', url, '--changelog', join(file, 'missing')], { env: { PATH: process.env.PATH, ...env } });
  assert.match(stdout, /^::warning::The release is published; posting it to Slack failed/, 'exit 0 with the warning');
});
