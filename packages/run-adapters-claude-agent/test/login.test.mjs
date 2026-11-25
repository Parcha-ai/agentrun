// A session on a person's own Claude Code login (login.ts): the CLI gets where the login is and nothing else, no model
// URL, key or token ever; the host asks the CLI for its status and reads only that answer; responses are booked from the
// CLI's stream, billed to the plan.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeAgentAdapter, claudeLoginCommand, claudeLoginStatus, parseClaudeLoginStatus } from '@parcha/agentrun-harness-claude';
import { fakeSdk } from '@parcha/agentrun-harness-claude/testing';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { durableEnv } from '../dist/env.js';
import { claudeSandboxSettings } from '../dist/harness.js';
import { loginBooking } from '../dist/login.js';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-login-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
/** What never reaches the CLI on a login. */
const TOKENS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** A login whose profiles directory no one may open, so anything that reads it fails; its folder holds no account file
 *  yet, the one file of it a status check opens (to copy it). */
function sealedLogin() {
  const base = scratch();
  const login = { dir: join(base, 'login'), profiles: join(base, 'login', 'anthropic') };
  mkdirSync(login.profiles, { recursive: true });
  chmodSync(login.profiles, 0o000);
  after(() => { chmodSync(login.profiles, 0o700); });
  return login;
}

test('on a login the CLI environment names where the login is, and no model URL, key or token, the app\'s own included', () => {
  const login = { dir: '/data/claude-login', profiles: '/data/claude-login/anthropic' };
  const env = durableEnv({ home: '/s/home', configDir: '/s/config', tmpDir: '/s/tmp', cacheDir: '/s/cache', login, model: 'claude-haiku-5-5', extra: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://x', KEEP: '1' } });
  for (const name of TOKENS) assert.equal(env[name], undefined, name);
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, login.dir);
  assert.equal(env.ANTHROPIC_CONFIG_DIR, login.profiles);
  // Its config dir is the session's: the SDK copies a credentials file out of that one when it resumes.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/s/config');
  assert.equal(env.KEEP, '1');
  assert.throws(() => durableEnv({ home: '/h', configDir: '/c', tmpDir: '/t', cacheDir: '/k', model: 'm' }), /model port and key, or a login/);
});

test("a run on a login on macOS runs its CLI in the person's real home, where the login keychain holding the CLI's tokens is, its config, XDG and temporary dirs still the session's; elsewhere, and on a model key, in the session's home", () => {
  const own = { dir: '/data/claude-login', profiles: '/data/claude-login/anthropic' };
  const atHome = { dir: '/u/p/.claude', profiles: '/u/p/.config/anthropic', home: '/u/p' };
  const dirs = { home: '/s/session', configDir: '/s/config', tmpDir: '/s/tmp', cacheDir: '/s/cache', model: 'claude-haiku-5-5' };
  for (const [login, home] of [[own, homedir()], [atHome, '/u/p']]) {
    const env = durableEnv({ ...dirs, login, platform: 'darwin' });
    assert.equal(env.HOME, home, `darwin: a run on ${login.dir} runs in the person's home`);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, login.home === undefined ? login.dir : '', `darwin: ${login.dir}'s credentials dir`);
    assert.deepEqual([env.CLAUDE_CONFIG_DIR, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME], ['/s/config', '/s/tmp', '/s/cache', '/s/session/.config', '/s/session/.local/share', '/s/session/.local/state'], `darwin: ${login.dir}: the rest is the session's`);
    const linux = durableEnv({ ...dirs, login, platform: 'linux' });
    assert.equal(linux.HOME, '/s/session', `linux: a run on ${login.dir} runs in the session's home (its tokens are a file in the credentials dir)`);
    // Only HOME moves to the person's: every other variable is what the same run gets on Linux, but the credentials dir,
    // which is the platform's own rule (pinned above).
    const rest = ({ HOME: _home, CLAUDE_SECURESTORAGE_CONFIG_DIR: _secure, ...others }) => others;
    assert.deepEqual(rest(env), rest(linux), `darwin: a run on ${login.dir} changes HOME and nothing else`);
  }
  assert.equal(durableEnv({ ...dirs, baseUrl: 'http://127.0.0.1:1', token: 'k', platform: 'darwin' }).HOME, '/s/session', 'darwin: a run on a model key runs in the session\'s home');
});

test("a run on a login on macOS runs in the home the login names (`userHome`, which the host reads once where it makes the login), never one read again here; a status check and the sign-in take the same", async () => {
  const userHome = scratch();
  const own = { dir: '/data/claude-login', profiles: '/data/claude-login/anthropic', userHome };
  const env = durableEnv({ home: '/s/session', configDir: '/s/config', tmpDir: '/s/tmp', cacheDir: '/s/cache', login: own, platform: 'darwin', model: 'claude-haiku-5-5' });
  assert.equal(env.HOME, userHome, "darwin: a run on AgentRun's own folder runs in the login's userHome");
  const base = scratch();
  const login = { dir: join(base, 'login'), profiles: join(base, 'login', 'anthropic'), userHome };
  const status = fakeCli({ loggedIn: false, authMethod: 'none' });
  await claudeLoginStatus(status.cli, login);
  assert.equal(status.seen().env.HOME, userHome, "the status check runs in the login's userHome");
});

test('the login status reads loggedIn and the account words, and nothing that is not an answer', () => {
  assert.deepEqual(parseClaudeLoginStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","orgName":"Org","subscriptionType":"max"}'), { signedIn: true, method: 'claude.ai', email: 'a@b.c', organization: 'Org', plan: 'max' });
  assert.deepEqual(parseClaudeLoginStatus('{"loggedIn":false,"authMethod":"none"}'), { signedIn: false, method: 'none' });
  assert.equal(parseClaudeLoginStatus('{"loggedIn":true,"authMethod":"none"}').signedIn, false);
  assert.equal(parseClaudeLoginStatus('Not logged in'), undefined);
  assert.equal(parseClaudeLoginStatus('[]'), undefined);
  assert.equal(parseClaudeLoginStatus('{"email":"a@b.c"}'), undefined);
});

test('the sign-in line names the login directories for the CLI, quoted where a shell needs it', () => {
  assert.equal(claudeLoginCommand({ dir: '/data/claude-login', profiles: '/data/claude-login/anthropic' }), 'CLAUDE_CONFIG_DIR=/data/claude-login CLAUDE_SECURESTORAGE_CONFIG_DIR=/data/claude-login ANTHROPIC_CONFIG_DIR=/data/claude-login/anthropic claude auth login');
  assert.match(claudeLoginCommand({ dir: "/my data/it's", profiles: '/p' }), /^CLAUDE_CONFIG_DIR='\/my data\/it'\\''s' /);
});

/** A stand-in CLI that writes what it was started with beside itself and answers `status`. */
function fakeCli(status) {
  const dir = scratch();
  const cli = join(dir, 'claude');
  writeFileSync(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(require('node:path').join(__dirname, 'seen.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(status))});\nprocess.exit(${status.loggedIn ? 0 : 1});\n`, { mode: 0o755 });
  return { cli, seen: () => JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')) };
}

test('the status check asks the CLI with the login directories, opening only the account file to copy it, and reads its answer', async () => {
  const login = sealedLogin();
  const signedIn = fakeCli({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
  assert.deepEqual(await claudeLoginStatus(signedIn.cli, login), { signedIn: true, method: 'claude.ai', plan: 'max' });
  const { argv, env } = signedIn.seen();
  assert.deepEqual(argv, ['auth', 'status', '--json']);
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, login.dir);
  assert.equal(env.ANTHROPIC_CONFIG_DIR, login.profiles);
  for (const name of TOKENS) assert.equal(env[name], undefined, name);
  // Its config dir is a copy of the account file `auth login` wrote in the login's folder, never that folder, which the
  // CLI would rewrite on start.
  assert.ok(env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== login.dir, env.CLAUDE_CONFIG_DIR);
  assert.notEqual(env.HOME, login.dir);
  const signedOut = fakeCli({ loggedIn: false, authMethod: 'none' });
  assert.deepEqual(await claudeLoginStatus(signedOut.cli, login), { signedIn: false, method: 'none' });
});

test('each response the CLI streams is booked from its events, billed to the plan, and a refused admission halts the drive', async () => {
  const asked = [];
  const booked = [];
  const halted = [];
  const models = { beforeRequest: async (r) => { asked.push(r); return { turn: asked.length }; }, afterRequest: async (usage, ticket, ended) => { booked.push({ usage, ticket, ended }); } };
  const book = loginBooking(models, 'claude-haiku-5-5', (e) => halted.push(e));
  const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
  book.observe(ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 1 } } }));
  book.observe(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }));
  book.observe(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }));
  book.observe(ev({ type: 'message_stop' }));
  // One the turn's end leaves open is booked as it stands.
  book.observe(ev({ type: 'message_start', message: { id: 'm2', usage: { input_tokens: 3, output_tokens: 0 } } }));
  await book.settle();
  assert.deepEqual(asked.map((r) => r.model), ['claude-haiku-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(booked, [
    { usage: { input: 10, output: 7, cacheRead: 4, cacheWrite: 2, billing: 'plan', usd: null }, ticket: { turn: 1 }, ended: { end: 'answered', usd: null } },
    { usage: { input: 3, output: 0, billing: 'plan', usd: null }, ticket: { turn: 2 }, ended: { end: 'answered', usd: null } },
  ]);
  assert.deepEqual(halted, []);

  const refusing = loginBooking({ beforeRequest: async () => { throw new Error('turn_limit'); }, afterRequest: async () => assert.fail('a refused request is not booked') }, 'm', (e) => halted.push(e));
  refusing.observe(ev({ type: 'message_start', message: { usage: {} } }));
  refusing.observe(ev({ type: 'message_stop' }));
  await refusing.settle();
  assert.deepEqual(halted.map((e) => e.message), ['turn_limit']);
});

test('on a login a request is admitted before the CLI can send it: with its message, and after a response that stops for tools; a refusal there halts first', async () => {
  const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
  const asked = [];
  const booked = [];
  const halted = [];
  // The second admission is the turn limit.
  const models = { beforeRequest: async () => { asked.push(1); if (asked.length > 1) throw new Error('turn_limit'); return { turn: asked.length }; }, afterRequest: async (usage, ticket, ended) => { booked.push({ ticket, ended }); } };
  const book = loginBooking(models, 'm', (e) => halted.push(e));
  await book.sending();
  assert.equal(asked.length, 1, 'admitted with its message, before any response');
  book.observe(ev({ type: 'message_start', message: { usage: { input_tokens: 5 } } }));
  assert.equal(asked.length, 1, 'the response took the admission its message had');
  book.observe(ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }));
  book.observe(ev({ type: 'message_stop' }));
  await new Promise((r) => setImmediate(r));
  // The CLI will send the tools' results straight back: that request is refused, and the drive halted, before it starts.
  assert.equal(asked.length, 2);
  assert.deepEqual(halted.map((e) => e.message), ['turn_limit']);
  await book.settle(true);
  assert.deepEqual(booked, [{ ticket: { turn: 1 }, ended: { end: 'answered', usd: null } }]);

  // A message whose request never left: its admission is closed as never sent when the drive ends.
  const closed = [];
  const idle = loginBooking({ beforeRequest: async () => ({ turn: 1 }), afterRequest: async (usage, ticket, ended) => { closed.push({ usage, ended }); } }, 'm', (e) => halted.push(e));
  await idle.sending();
  await idle.settle();
  assert.deepEqual(closed, [], 'a turn\'s end keeps it for the next request');
  await idle.settle(true);
  assert.deepEqual(closed, [{ usage: { input: 0, output: 0, usd: null, billing: 'plan' }, ended: { end: 'nothing', label: 'never_left' } }]);
  await assert.rejects(loginBooking({ beforeRequest: async () => { throw new Error('turn_limit'); }, afterRequest: async () => {} }, 'm', () => {}).sending(), /turn_limit/);
});

test('a session on a login starts its CLI with no model URL, key or token, a config dir apart from the login, and no host port', async () => {
  const login = sealedLogin();
  const seen = [];
  const sdk = fakeSdk({ mirrorLagMs: 10, script: ['call submit {"value":{"answer":"ok"}}'], onQuery: (options) => seen.push(options) });
  assert.throws(() => claudeAgentAdapter({ model: 'claude-haiku-5-5', login, provider: { origin: 'http://127.0.0.1:1', credential: () => 'k' }, standIn: { command: process.execPath }, sdk }), /a provider or a login/);
  const adapter = claudeAgentAdapter({ model: 'claude-haiku-5-5', login, sessionsDir: join(scratch(), 'sessions'), standIn: { command: process.execPath }, sdk });
  const ports = [];
  const store = memorySessionStore();
  const runNode = createHarnessRunner({ ...adapter, open: async (spec, io) => { const session = await adapter.open(spec, io); ports.push(session.port?.('side')); return session; } }, { store });
  const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
  const result = await runWorkflow({ v: 2, name: 'login', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final' } }, {}, { runNode });
  assert.equal(result.status, 'complete', JSON.stringify(result.error ?? null));
  assert.ok(seen.length >= 1);
  for (const options of seen) {
    for (const name of TOKENS) assert.equal(options.env[name], undefined, name);
    assert.equal(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, login.dir);
    assert.equal(options.env.ANTHROPIC_CONFIG_DIR, login.profiles);
    assert.ok(!options.env.CLAUDE_CONFIG_DIR.startsWith(login.dir), options.env.CLAUDE_CONFIG_DIR);
  }
  // No host port: no request of the host's goes on a person's login.
  assert.deepEqual(ports, [undefined]);
});

test("the sandbox of a run on a login denies its commands the folder the CLI reads the credentials from when the server's env sets it apart; the macOS empty value adds nothing, and no folder is named twice", () => {
  const machine = { root: '/workspace', dirs: { tmp: '/s/tmp', home: '/s/home', cache: '/s/cache', config: '/s/claude/config' } };
  const denied = (login, platform) => claudeSandboxSettings(machine, 'deny-all', login, platform).filesystem.denyRead;
  assert.deepEqual(claudeSandboxSettings(machine, 'deny-all').filesystem.denyRead, ['/s/claude']);
  const folder = { dir: '/data/claude-login', profiles: '/data/claude-login/anthropic' };
  const base = ['/s/claude', folder.dir, folder.profiles];
  // CLAUDE_SECURESTORAGE_CONFIG_DIR=/u/p/secure in the server's env: the CLI reads the credentials there.
  for (const platform of ['linux', 'darwin']) assert.deepEqual(denied({ ...folder, secure: '/u/p/secure' }, platform), [...base, '/u/p/secure'], platform);
  // Set and empty: on Linux the CLI reads `<home>/.claude`; on macOS it gets the empty value (a Keychain item, no folder).
  const empty = { ...folder, secure: '/u/p/.claude', unsuffixed: true };
  assert.deepEqual(denied(empty, 'linux'), [...base, '/u/p/.claude']);
  assert.deepEqual(denied(empty, 'darwin'), base);
  // The credentials in the login's own folder (none set apart, or set to that folder): named once.
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(denied(folder, platform), base, platform);
    assert.deepEqual(denied({ ...folder, secure: folder.dir }, platform), base, platform);
  }
  // The CLI's default folder: its own folder on Linux, the empty value on macOS; nothing added either way.
  const home = { dir: '/u/p/.claude', profiles: '/u/p/.claude/anthropic', home: '/u/p' };
  for (const platform of ['linux', 'darwin']) assert.deepEqual(denied(home, platform), ['/s/claude', home.dir, home.profiles], platform);
});
