// A session on a person's Claude Code login handed as its access token alone (login.ts ClaudeLoginToken), as a host
// whose runs are users of their own hands it: the CLI is started with that token in CLAUDE_CODE_OAUTH_TOKEN, which the
// pinned CLI reads with no refresh token, so it never renews; no refresh token, no login folder, no model URL or key,
// and its credentials directories the session's own; no wait on a 401. When Anthropic refuses the token the CLI asks the
// host for a newer one (the SDK's getOAuthToken): the host reads its login again and answers a different token, or
// answers none and ends the drive in words that say to run the claude CLI once on this login to renew it, never a hang. The token is in
// no argument the CLI is started with. A stand-in CLI records what it was started with and looks for a credentials file
// where its environment points; no key, no network, fake values.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as claude from '@parcha/agentrun-harness-claude';
import { fakeSdk } from '@parcha/agentrun-harness-claude/testing';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { durableEnv, LOGIN_UNSET } from '../dist/env.js';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-token-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const fake = (what) => `not-a-secret-${what}-${Math.random().toString(36).slice(2, 10)}`;
/** What never reaches the CLI on a login by its token, but the token itself. */
const NEVER = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_SCOPES'];
const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
const FLOW = { v: 2, name: 'login-token', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final' } };

/** A stand-in CLI: a wrapper that records its arguments, its environment and whether a credentials file is where its
 *  environment points (seen.jsonl beside it), then runs the stand-in the SDK asked for. */
function recordingCli() {
  const dir = scratch();
  const recorder = join(dir, 'record.cjs');
  writeFileSync(recorder, `const fs = require('node:fs'), path = require('node:path');\nconst store = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || '';\nlet credentials = 'none';\ntry { fs.readFileSync(path.join(store, '.credentials.json')); credentials = 'read'; } catch (error) { credentials = error.code || 'error'; }\nfs.appendFileSync(path.join(__dirname, 'seen.jsonl'), JSON.stringify({ argv: process.argv.slice(2), env: process.env, credentials }) + '\\n');\n`);
  const cli = join(dir, 'claude');
  writeFileSync(cli, `#!/bin/sh\n${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  return { cli, seen: () => (existsSync(join(dir, 'seen.jsonl')) ? readFileSync(join(dir, 'seen.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []) };
}

/** Every string under `value` (its own enumerable properties, to a depth), but under the keys named in `skip`. */
function stringsIn(value, skip, depth = 5, seen = new Set()) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || depth === 0 || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, inner]) => (skip.includes(key) ? [] : stringsIn(inner, skip, depth - 1, seen)));
}

/** Drives one agent node on a login handed as `reader`, the CLI `cli`; `onQuery` sees the SDK's options. */
async function drive({ reader, cli, onQuery, lagMs = 10 }) {
  const sessionsDir = join(scratch(), 'sessions');
  const sdk = fakeSdk({ mirrorLagMs: lagMs, script: ['call submit {"value":{"answer":"ok"}}'], onQuery });
  const adapter = claude.claudeAgentAdapter({ model: 'claude-haiku-5-5', login: reader, sessionsDir, standIn: { command: cli }, sdk });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore() });
  return { sessionsDir, result: await runWorkflow(FLOW, {}, { runNode }) };
}

test('the CLI environment on a token: the token alone, no refresh token, no model URL or key, the credentials directories the session\'s own, no wait on a 401; a login by both its folder and its token is refused', () => {
  const token = fake('access');
  const extra = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: fake('refresh'), CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3', CLAUDE_CODE_OAUTH_TOKEN: fake('inherited'), KEEP: '1' };
  const env = durableEnv({ home: '/s/home', configDir: '/s/config', tmpDir: '/s/tmp', cacheDir: '/s/cache', oauthToken: token, model: 'claude-haiku-5-5', extra });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token, 'the token handed, never an inherited one');
  for (const name of NEVER) assert.equal(env[name], undefined, name);
  assert.ok(LOGIN_UNSET.includes('CLAUDE_CODE_OAUTH_REFRESH_TOKEN') && LOGIN_UNSET.includes('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'), 'an app\'s refresh token or token descriptor never reaches the CLI on a login');
  assert.equal(env.CLAUDE_CODE_OAUTH_401_WAIT_MS, '0', 'no wait for a newer token on a 401: the host is asked at once');
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/s/config');
  assert.ok(env.ANTHROPIC_CONFIG_DIR.startsWith('/s/home/'), env.ANTHROPIC_CONFIG_DIR);
  assert.equal(env.KEEP, '1');
  assert.throws(() => durableEnv({ home: '/h', configDir: '/c', tmpDir: '/t', cacheDir: '/k', model: 'm', oauthToken: token, login: { dir: '/l', profiles: '/l/a' } }), /not both/);
});

test('a session on a login handed as its token starts its CLI with that token alone: no refresh token, no login folder, no credentials file where it looks, the token in no argument and no other option', async () => {
  assert.equal(typeof claude.claudeLoginByToken, 'function', 'the adapter takes a login handed as its token (login.ts ClaudeLoginToken)');
  const token = fake('access');
  const { cli, seen } = recordingCli();
  const options = [];
  const { sessionsDir, result } = await drive({ reader: { token: async () => token }, cli, onQuery: (given) => options.push(given) });
  assert.equal(result.status, 'complete', JSON.stringify(result.error ?? null));
  const started = seen();
  assert.ok(started.length >= 1, 'the CLI was started');
  for (const { argv, env, credentials } of started) {
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
    for (const name of NEVER) assert.equal(env[name], undefined, name);
    assert.equal(env.CLAUDE_CODE_OAUTH_401_WAIT_MS, '0');
    for (const name of ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'HOME']) assert.ok(env[name]?.startsWith(sessionsDir), `${name} is the session's own: ${env[name]}`);
    assert.ok(!Object.values(env).some((value) => value.includes('claude-login')), 'no variable names a login folder');
    assert.equal(credentials, 'ENOENT', 'no credentials file where the CLI looks: it has the token alone');
    assert.ok(!argv.some((arg) => arg.includes(token)), 'the token is in no argument');
  }
  for (const given of options) {
    assert.equal(typeof given.getOAuthToken, 'function', 'the CLI may ask the host for a newer token (the SDK\'s oauth_token_refresh)');
    assert.ok(!stringsIn(given, ['env']).some((text) => text.includes(token)), 'the token is in no option but the CLI\'s environment');
    assert.equal(given.sandbox?.filesystem?.denyRead?.some((path) => path.includes('claude-login')) ?? false, false);
  }
});

test('when Anthropic refuses the token, the CLI\'s ask for a newer one is answered with the login read again when it differs: the drive goes on', async () => {
  assert.equal(typeof claude.claudeLoginByToken, 'function', 'the adapter takes a login handed as its token (login.ts ClaudeLoginToken)');
  const first = fake('access-first');
  const renewed = fake('access-renewed');
  const reads = [first, renewed];
  const asked = [];
  const { cli } = recordingCli();
  const { result } = await drive({ reader: { token: async () => reads.shift() ?? renewed }, cli, onQuery: (given) => asked.push(given.getOAuthToken?.({ signal: new AbortController().signal })) });
  assert.equal(result.status, 'complete', JSON.stringify(result.error ?? null));
  assert.equal(await asked[0], renewed, 'the newer token, which the CLI then uses');
});

test('when the login read again holds the same token, or none, the CLI\'s ask is answered with none and the drive ends in words that say to run the claude CLI once on this login to renew it: never a hang', async () => {
  assert.equal(typeof claude.claudeLoginByToken, 'function', 'the adapter takes a login handed as its token (login.ts ClaudeLoginToken)');
  const same = fake('access-same');
  for (const [why, reader, words] of [
    ['the same token', { token: async () => same }, /refused this machine's Claude login during the run.*run the claude CLI once on this login to renew it/],
    ['none: the host refuses in its own words', (() => { let reads = 0; return { token: async () => { if (reads++ === 0) return same; throw new Error('Claude Code\'s login on this machine runs out in less than 5 minutes: open Claude Code on this login once to renew it.'); } }; })(), /less than 5 minutes/],
  ]) {
    const asked = [];
    const { cli } = recordingCli();
    // The tool call's mirror lags, so the ask (answered at once) comes while the turn still runs.
    // A drive that ends refuses its workflow run (HARNESS_NODE_NOT_DELIVERED), so the end is the rejection.
    const ended = await drive({ reader, cli, lagMs: 500, onQuery: (given) => asked.push(given.getOAuthToken?.({ signal: new AbortController().signal })) }).then(() => null, (error) => error);
    assert.equal(await asked[0], null, `${why}: no token for the CLI, which then ends its turn`);
    assert.ok(ended instanceof Error, `${why}: the drive ends`);
    const said = String(ended.message);
    assert.match(said, words, `${why}: ${said}`);
    assert.ok(!String(ended.stack).includes(same), `${why}: the token is in no word of the end`);
  }
});
