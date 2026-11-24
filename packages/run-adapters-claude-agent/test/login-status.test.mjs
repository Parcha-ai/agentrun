// A status check never writes the login's files (login.ts claudeLoginStatus). The pinned CLI rewrites its account file
// (`.claude.json` in its config dir) on every start whose migration number is not its own, and the first time it also
// writes a settings file, a backup and a lock beside it. A person's own Claude Code keeps that file too: on the CLI's
// default folder `<home>/.claude.json`, in a CLAUDE_CONFIG_DIR folder `<folder>/.claude.json`. So the status check runs the
// CLI on a copy of it, in a folder of its own that is removed after, and keeps the tokens where they are (the run's
// credentials dir, loginEnv).
//
// The first test runs the pinned CLI: without it this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing
// or different one fails. The others use stand-in CLIs that note what they were started with beside themselves.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { after, test } from 'node:test';
import * as claude from '@parcha/agentrun-harness-claude';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-status-test-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const OUT = { signedIn: false, method: 'none' };

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** Every path under `root`, folders with a trailing `/`, sorted. */
function listing(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${path}/` : path);
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
    }
  };
  walk(root, '');
  return out.sort();
}
/** Whether `path` is outside the folder `root`. */
const outside = (root, path) => {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
};

/** A person's home with a signed-out account file their own Claude Code left, and this machine's login on the CLI's
 *  default folder there. */
function defaultLogin() {
  const home = scratch();
  const bytes = Buffer.from(`${JSON.stringify({ numStartups: 3, autoUpdates: false, hasCompletedOnboarding: true, projects: {}, migrationVersion: 15 }, null, 2)}\n`);
  writeFileSync(join(home, '.claude.json'), bytes, { mode: 0o600 });
  return { home, bytes, login: { dir: join(home, '.claude'), profiles: join(home, '.config', 'anthropic'), home } };
}

/** A stand-in CLI that notes, per process, its environment, what its config dir held, the bytes of the account file
 *  there and the permission bits of the check's folder, the config dir and that file, then answers `answer`. With
 *  `gate` (a port on loopback) it connects there first and answers only once the gate writes to it. With `hang` it
 *  never answers. */
function fakeCli({ answer = SIGNED_OUT, gate, hang = false } = {}) {
  const dir = scratch();
  const cli = join(dir, 'claude');
  writeFileSync(cli, [
    `#!${process.execPath}`,
    `const fs = require('node:fs');`,
    `const path = require('node:path');`,
    `const config = process.env.CLAUDE_CONFIG_DIR;`,
    `const copy = config ? path.join(config, '.claude.json') : undefined;`,
    `const bits = (p) => (p && fs.existsSync(p) ? fs.statSync(p).mode & 0o777 : null);`,
    `const seen = { env: process.env, folder: config && fs.existsSync(config) ? fs.readdirSync(config) : null, copy: copy && fs.existsSync(copy) ? fs.readFileSync(copy).toString('base64') : null, modes: config ? { check: bits(path.dirname(config)), config: bits(config), copy: bits(copy) } : null };`,
    `fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'seen-' + process.pid + '.json'), JSON.stringify(seen));`,
    `const answer = () => { process.stdout.write(${JSON.stringify(answer)}); process.exit(1); };`,
    hang
      ? `setInterval(() => {}, 60_000);`
      : gate === undefined
        ? `answer();`
        : `const socket = require('node:net').connect(${gate}, '127.0.0.1', () => socket.write('r')); socket.once('data', answer); socket.on('error', () => process.exit(2));`,
    '',
  ].join('\n'), { mode: 0o755 });
  const seen = () => readdirSync(dir).filter((name) => name.startsWith('seen-')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  return { cli, seen };
}

/** The account file a stand-in CLI found in its config dir, as text, or null when there was none. */
const copyText = (seen) => (seen.copy === null ? null : Buffer.from(seen.copy, 'base64').toString('utf8'));

/** Runs one status check (`check()`) with the temporary folder (TMPDIR, and TMP and TEMP for Windows) at a new empty
 *  folder, set only while the check starts, which is when it makes its own folder; returns that folder and how the check
 *  ended. */
async function inOwnTmp(check) {
  const tmp = scratch();
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  let pending;
  try {
    pending = check();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const outcome = await pending.then((value) => ({ value }), (error) => ({ error }));
  return { tmp, outcome };
}

/** A gate on loopback: `arrived` settles once `count` CLIs connected; `release()` lets them all answer. */
async function gate(count) {
  const held = [];
  let all;
  const arrived = new Promise((resolve) => { all = resolve; });
  const server = createServer((socket) => {
    held.push(socket);
    if (held.length === count) all();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    arrived,
    release: () => {
      for (const socket of held) socket.end('g');
      server.close();
    },
  };
}

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
let pinned;
try { pinned = claude.verifyClaudeAgent({}).cliPath; } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;

test("the pinned CLI's status check on the CLI's default folder writes nothing in the person's home: their account file keeps its bytes and mtime, and no file or folder appears", { skip, timeout: 60_000 }, async () => {
  assert.equal(problem, undefined, problem);
  const { home, login } = defaultLogin();
  const account = join(home, '.claude.json');
  // An mtime in the past, so a rewrite within the same clock tick still shows.
  const past = new Date('2026-01-01T00:00:00Z');
  utimesSync(account, past, past);
  const before = { sha: sha256(account), mtime: statSync(account).mtimeMs, list: listing(home) };
  assert.deepEqual(before.list, ['.claude.json']);
  const status = await claude.claudeLoginStatus(pinned, login, { path: '/usr/bin:/bin' });
  assert.deepEqual(status, OUT, 'the answer still reads as a status: signed out');
  assert.equal(sha256(account), before.sha, "the person's account file keeps its bytes (the pinned CLI rewrites a file whose migration number is not its own)");
  assert.equal(statSync(account).mtimeMs, before.mtime, "the person's account file keeps its mtime");
  assert.deepEqual(listing(home), before.list, 'nothing new under the home: no settings file, backup or lock');
});

test("the pinned CLI's status check on AgentRun's own login, run in the person's home, writes nothing outside the login's folder: every file of the home keeps its bytes and mtime, and no lock is left anywhere", { skip, timeout: 60_000 }, async () => {
  assert.equal(problem, undefined, problem);
  // The person's home, with what their own Claude Code and other tools keep there: an account file on another migration
  // number (the pinned CLI rewrites one that isn't its own), a settings file and a config folder.
  const home = scratch();
  const past = new Date('2026-01-01T00:00:00Z');
  writeFileSync(join(home, '.claude.json'), `${JSON.stringify({ numStartups: 3, hasCompletedOnboarding: true, projects: {}, migrationVersion: 15 }, null, 2)}\n`, { mode: 0o600 });
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), '{"theme":"dark"}\n');
  mkdirSync(join(home, '.config', 'tool'), { recursive: true });
  writeFileSync(join(home, '.config', 'tool', 'config'), 'sentinel\n');
  const files = listing(home).filter((path) => !path.endsWith('/'));
  for (const file of files) utimesSync(join(home, file), past, past);
  const snapshot = () => Object.fromEntries(files.map((file) => [file, { sha: sha256(join(home, file)), mtime: statSync(join(home, file)).mtimeMs }]));
  const before = { list: listing(home), files: snapshot() };
  // AgentRun's own login: a folder in its data dir, outside the home, that no sign-in has filled yet.
  const data = scratch();
  const login = { dir: join(data, 'claude-login'), profiles: join(data, 'claude-login', 'anthropic'), userHome: home };
  mkdirSync(login.dir, { mode: 0o700 });
  const status = await claude.claudeLoginStatus(pinned, login, { path: '/usr/bin:/bin' });
  assert.deepEqual(status, OUT, 'the answer still reads as a status: signed out');
  assert.deepEqual(listing(home), before.list, 'nothing new under the home: no account file, settings, backup or lock');
  assert.deepEqual(snapshot(), before.files, "every file of the person's home keeps its bytes and mtime");
  assert.deepEqual(listing(data).filter((path) => !path.startsWith('claude-login/') && path !== 'claude-login/'), [], 'nothing beside the login folder in the data dir');
  assert.deepEqual(listing(data).filter((path) => /\.lock\/?$/.test(path)), [], 'no lock is left in the login folder');
});

test("the status check on the CLI's default folder runs in the person's home with a copy of their account file as its config dir, outside that home, and the run's credentials dir: empty on macOS, the folder elsewhere", async () => {
  for (const platform of ['darwin', 'linux']) {
    const { home, bytes, login } = defaultLogin();
    const fake = fakeCli();
    assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login, { platform }), OUT);
    const [seen] = fake.seen();
    const config = seen.env.CLAUDE_CONFIG_DIR;
    assert.ok(config, `${platform}: the status check names a config dir of its own`);
    assert.ok(outside(home, config), `${platform}: ${config} is outside the home ${home}`);
    assert.deepEqual(JSON.parse(copyText(seen)), JSON.parse(bytes.toString('utf8')), `${platform}: the config dir holds a copy of the account file`);
    assert.deepEqual(seen.folder, ['.claude.json'], `${platform}: and nothing else`);
    assert.equal(seen.env.HOME, home, platform);
    assert.equal(seen.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, platform === 'darwin' ? '' : login.dir, platform);
    assert.equal(seen.env.ANTHROPIC_CONFIG_DIR, login.profiles, platform);
  }
  // No account file in the home: the copy is nothing, an empty folder.
  const home = scratch();
  const fake = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(fake.cli, { dir: join(home, '.claude'), profiles: join(home, '.config', 'anthropic'), home }), OUT);
  const [seen] = fake.seen();
  assert.ok(seen.env.CLAUDE_CONFIG_DIR, 'the status check names a config dir of its own');
  assert.deepEqual([seen.folder, seen.copy], [[], null], 'with no account file, nothing is copied');
  assert.equal(existsSync(join(home, '.claude.json')), false);
});

test("this machine's login in a CLAUDE_CONFIG_DIR folder, which the person's own claude uses too: the status check's config dir is a copy of that folder's account file, never the folder, and its credentials dir the folder on every platform", async () => {
  for (const platform of ['darwin', 'linux']) {
    const folder = scratch();
    const bytes = Buffer.from(`${JSON.stringify({ hasCompletedOnboarding: true, migrationVersion: 15 })}\n`);
    writeFileSync(join(folder, '.claude.json'), bytes, { mode: 0o600 });
    const person = scratch();
    const login = { dir: folder, profiles: join(folder, 'anthropic'), userHome: person };
    const fake = fakeCli();
    assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login, { platform }), OUT);
    const [seen] = fake.seen();
    const config = seen.env.CLAUDE_CONFIG_DIR;
    assert.notEqual(config, folder, `${platform}: the status check never runs the CLI on the folder's own account file`);
    assert.ok(config && outside(folder, config), `${platform}: ${config} is outside the folder`);
    assert.deepEqual(JSON.parse(copyText(seen)), JSON.parse(bytes.toString('utf8')), `${platform}: the config dir holds a copy of the folder's account file`);
    // The person's CLI with CLAUDE_CONFIG_DIR=<folder> keeps its tokens there (Linux) or in the item hashed from it (macOS).
    assert.equal(seen.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, folder, platform);
    // In the person's home, where macOS keeps the login keychain the CLI reads its tokens from.
    assert.equal(seen.env.HOME, person, `${platform}: the status check on a CLAUDE_CONFIG_DIR folder runs in the person's home`);
  }
});

/** The variables the status check gave the CLI, less PATH and the four it always sets to quiet the CLI. */
const QUIET = ['PATH', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
const placeVars = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !QUIET.includes(name)));

test("every place's status check runs in the person's real home, never one under the check's own temporary folder, and keeps that place's credentials dir: on macOS the login keychain is under the home, and the Keychain item is named from the credentials dir", async () => {
  for (const platform of ['darwin', 'linux']) {
    const person = scratch();
    const folder = scratch();
    writeFileSync(join(folder, '.claude.json'), `${JSON.stringify({ migrationVersion: 15 })}\n`, { mode: 0o600 });
    const base = scratch();
    const { login: atHome } = defaultLogin();
    const places = [
      // AgentRun's own folder: its credentials dir the folder, as its sign-in names it; the config dir a copy.
      ['own', { dir: join(base, 'claude-login'), profiles: join(base, 'claude-login', 'anthropic'), userHome: person }, person],
      // The CLI's default folder: the login's home is the person's; the Keychain item with no suffix.
      ['home', atHome, atHome.home],
      // A CLAUDE_CONFIG_DIR folder: the item hashed from the folder, never from the copy.
      ['folder', { dir: folder, profiles: join(folder, 'anthropic'), userHome: person }, person],
    ];
    for (const [where, login, home] of places) {
      const fake = fakeCli();
      const { tmp, outcome } = await inOwnTmp(() => claude.claudeLoginStatus(fake.cli, login, { platform }));
      assert.deepEqual(outcome.value, OUT, `${platform} ${where}: ${outcome.error}`);
      const [seen] = fake.seen();
      assert.equal(seen.env.HOME, home, `${platform} ${where}: the status check runs in the person's home`);
      assert.ok(outside(tmp, seen.env.HOME), `${platform} ${where}: its home ${seen.env.HOME} is not under the check's temporary folder ${tmp}`);
      assert.equal(seen.env.XDG_CONFIG_HOME, undefined, `${platform} ${where}: no config home of the check's own`);
      const secure = seen.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      assert.equal(secure, where === 'home' && platform === 'darwin' ? '' : login.dir, `${platform} ${where}: the place's own credentials dir`);
      assert.ok(secure === '' || outside(tmp, secure), `${platform} ${where}: the credentials dir ${secure} is never the copy's`);
      // Every place, AgentRun's own included: the config dir is the copy, and the rest is a run's (claudeLoginEnv).
      assert.ok(seen.env.CLAUDE_CONFIG_DIR && !outside(tmp, seen.env.CLAUDE_CONFIG_DIR), `${platform} ${where}: the config dir is the copy, under the check's folder`);
      assert.deepEqual(placeVars(seen.env), { HOME: home, ...claude.claudeLoginEnv(login, platform), CLAUDE_CONFIG_DIR: seen.env.CLAUDE_CONFIG_DIR }, `${platform} ${where}: a run's variables, in the person's home, on a copy`);
    }
  }
  // A login made with no home of either kind: the server's own (os.homedir()).
  const base = scratch();
  const fake = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(fake.cli, { dir: join(base, 'claude-login'), profiles: join(base, 'claude-login', 'anthropic') }), OUT);
  assert.equal(fake.seen()[0].env.HOME, homedir(), "with no home given, the server's home");
});

test("the status check's folder is gone on every way the check ends: the CLI answered, gave no answer that reads as one, could not start, or ran past the check's time", async () => {
  const { login } = defaultLogin();
  const answered = fakeCli();
  const one = await inOwnTmp(() => claude.claudeLoginStatus(answered.cli, login));
  assert.deepEqual(one.outcome.value, OUT);
  const [first] = answered.seen();
  assert.ok(first.env.CLAUDE_CONFIG_DIR, 'the status check had a folder of its own');
  assert.ok(!outside(one.tmp, first.env.CLAUDE_CONFIG_DIR), `its folder ${first.env.CLAUDE_CONFIG_DIR} is under the temporary folder ${one.tmp}`);
  assert.notEqual(first.folder, null, 'its folder was there while the CLI ran');
  assert.equal(existsSync(first.env.CLAUDE_CONFIG_DIR), false, 'the folder is gone after the answer');
  assert.deepEqual(readdirSync(one.tmp), [], 'nothing of the check is left after the answer');

  const garbled = fakeCli({ answer: 'Not logged in' });
  const two = await inOwnTmp(() => claude.claudeLoginStatus(garbled.cli, login));
  assert.match(String(two.outcome.error?.message), /gave no login status/);
  const [second] = garbled.seen();
  assert.ok(second.env.CLAUDE_CONFIG_DIR, 'the status check had a folder of its own');
  assert.notEqual(second.folder, null, 'its folder was there while the CLI ran');
  assert.equal(existsSync(second.env.CLAUDE_CONFIG_DIR), false, 'the folder is gone after the throw');
  assert.deepEqual(readdirSync(two.tmp), [], 'nothing of the check is left after the throw');

  // No CLI at that path: the spawn fails (ENOENT).
  const missing = await inOwnTmp(() => claude.claudeLoginStatus(join(scratch(), 'no-such-claude'), login));
  assert.equal(missing.outcome.error?.code, 'ENOENT', `the check fails as the spawn did: ${missing.outcome.error}`);
  assert.deepEqual(readdirSync(missing.tmp), [], 'nothing of the check is left after a spawn that failed');

  // A CLI that never answers, ended at the check's limit.
  const silent = fakeCli({ hang: true });
  const late = await inOwnTmp(() => claude.claudeLoginStatus(silent.cli, login, { timeoutMs: 500 }));
  assert.match(String(late.outcome.error?.message), /gave no login status/, 'a CLI ended at the limit gave no answer');
  assert.deepEqual(readdirSync(late.tmp), [], 'nothing of the check is left after the limit');
});

test("a status check the CLI outlasts throws its own kind, `timed_out`, naming the limit in seconds, apart from a CLI that answered what reads as no status: a caller can tell a slow host from a broken answer", async () => {
  const { login } = defaultLogin();
  const silent = fakeCli({ hang: true });
  const started = Date.now();
  const late = await inOwnTmp(() => claude.claudeLoginStatus(silent.cli, login, { timeoutMs: 500 }));
  const took = Date.now() - started;
  assert.equal(late.outcome.error?.code, 'timed_out', `a check ended at its limit says so: ${late.outcome.error}`);
  assert.match(String(late.outcome.error?.message), /timed out after 0\.5 s/, 'its words name the limit in seconds');
  assert.equal(late.outcome.error?.limitMs, 500, 'it carries the limit');
  assert.ok(late.outcome.error instanceof claude.ClaudeLoginTimedOut, 'the harness exports its kind');
  assert.ok(took < 10_000, `the CLI was ended at the limit, not waited out (${took} ms)`);
  assert.equal(silent.seen().length, 1, 'the CLI was started once: the harness itself never asks again');

  const garbled = fakeCli({ answer: 'Not logged in' });
  const nonsense = await inOwnTmp(() => claude.claudeLoginStatus(garbled.cli, login, { timeoutMs: 10_000 }));
  assert.match(String(nonsense.outcome.error?.message), /gave no login status/);
  assert.notEqual(nonsense.outcome.error?.code, 'timed_out', 'a CLI that answered nonsense in time did not time out');
  assert.ok(!(nonsense.outcome.error instanceof claude.ClaudeLoginTimedOut), 'nor is it the timed-out kind');
  assert.doesNotMatch(String(nonsense.outcome.error?.message), /timed out/);

  assert.equal(new claude.ClaudeLoginTimedOut(15_000).message, 'the claude CLI gave no login status: the check timed out after 15 s', 'the default limit reads in whole seconds');
});

test("while the CLI runs, the status check's folder and its config dir are the server user's alone (0700) and the copy of the account file too (0600)", { skip: process.platform === 'win32' ? 'POSIX permission bits' : false }, async () => {
  const { login } = defaultLogin();
  const fake = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login), OUT);
  const [seen] = fake.seen();
  assert.deepEqual(seen.modes, { check: 0o700, config: 0o700, copy: 0o600 }, `modes ${JSON.stringify(seen.modes)}`);
});

const FAKE_KEY = 'test-fake-api-key';
const FAKE_TOKEN = 'fake-token-for-a-test';

test("the status check's copy of the account file holds no secret: not the API key an older CLI signed in with (primaryApiKey), the variables the CLI exports on start (env), or the MCP servers whose env and headers hold tokens (mcpServers, the user's and each project's); every other field is kept", async () => {
  const account = {
    numStartups: 3,
    hasCompletedOnboarding: true,
    migrationVersion: 15,
    oauthAccount: { emailAddress: 'person@example.com', organizationName: 'Example' },
    // The CLI keeps the last 20 characters of a key it was asked about, never the key.
    customApiKeyResponses: { approved: ['test-fake-tail'], rejected: [] },
    primaryApiKey: FAKE_KEY,
    env: { ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN },
    mcpServers: { tools: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: `Bearer ${FAKE_TOKEN}` } } },
    projects: { '/p': { allowedTools: ['Read'], hasTrustDialogAccepted: true, mcpServers: { local: { command: 'tool', env: { TOOL_KEY: FAKE_TOKEN } } } } },
  };
  const kept = {
    numStartups: 3,
    hasCompletedOnboarding: true,
    migrationVersion: 15,
    oauthAccount: account.oauthAccount,
    customApiKeyResponses: account.customApiKeyResponses,
    projects: { '/p': { allowedTools: ['Read'], hasTrustDialogAccepted: true } },
  };
  const home = scratch();
  const folder = scratch();
  for (const [where, file, login] of [
    ['default folder', join(home, '.claude.json'), { dir: join(home, '.claude'), profiles: join(home, '.config', 'anthropic'), home }],
    ['CLAUDE_CONFIG_DIR folder', join(folder, '.claude.json'), { dir: folder, profiles: join(folder, 'anthropic') }],
  ]) {
    const bytes = Buffer.from(`${JSON.stringify(account, null, 2)}\n`);
    writeFileSync(file, bytes, { mode: 0o600 });
    const fake = fakeCli();
    assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login), OUT);
    const [seen] = fake.seen();
    const copy = copyText(seen);
    assert.ok(copy !== null, `${where}: the config dir holds a copy`);
    assert.ok(!copy.includes(FAKE_KEY), `${where}: the API key is nowhere in the copy`);
    assert.ok(!copy.includes(FAKE_TOKEN), `${where}: no token is anywhere in the copy`);
    assert.deepEqual(JSON.parse(copy), kept, `${where}: every other field is kept`);
    assert.ok(readFileSync(file).equals(bytes), `${where}: the person's file keeps its bytes`);
  }
});

test("an account file that doesn't parse as a JSON object is copied as nothing, as if it were missing, so nothing in it reaches the copy; the person's file keeps its bytes", async () => {
  for (const body of [`{"primaryApiKey": ${JSON.stringify(FAKE_KEY)}, "numStartups": `, '[]', 'null', JSON.stringify(FAKE_KEY)]) {
    const { home, login } = defaultLogin();
    const file = join(home, '.claude.json');
    writeFileSync(file, body, { mode: 0o600 });
    const fake = fakeCli();
    assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login), OUT);
    const [seen] = fake.seen();
    assert.ok(seen.env.CLAUDE_CONFIG_DIR, 'the status check names a config dir of its own');
    assert.deepEqual([seen.folder, seen.copy], [[], null], `${JSON.stringify(body)}: nothing is copied`);
    assert.equal(readFileSync(file, 'utf8'), body, "the person's file keeps its bytes");
  }
});

test('two status checks at once (two tabs) each get a folder of their own, and both are gone afterwards', { timeout: 30_000 }, async () => {
  const { bytes, login } = defaultLogin();
  const held = await gate(2);
  const fake = fakeCli({ gate: held.port });
  const both = Promise.all([claude.claudeLoginStatus(fake.cli, login), claude.claudeLoginStatus(fake.cli, login)]);
  // Settles only if the checks end before the gate opens (a check that never started its CLI).
  const early = both.then(() => { throw new Error('a status check ended before both had started'); });
  early.catch(() => {});
  try {
    // Both CLIs are running, neither has answered.
    await Promise.race([held.arrived, early]);
  } finally {
    held.release();
  }
  const seen = fake.seen();
  assert.deepEqual(await both, [OUT, OUT]);
  assert.equal(seen.length, 2);
  const folders = seen.map((s) => s.env.CLAUDE_CONFIG_DIR);
  assert.ok(folders.every(Boolean), `each status check names a config dir of its own: ${JSON.stringify(folders)}`);
  assert.notEqual(folders[0], folders[1], 'two checks never share a folder');
  for (const s of seen) assert.deepEqual(JSON.parse(copyText(s)), JSON.parse(bytes.toString('utf8')));
  for (const folder of folders) assert.equal(existsSync(folder), false, `${folder} is gone`);
});

test("what status checks killed mid-way left (a SIGKILL runs no finally) is swept: only this user's agentrun-claude-status-* folders last changed more than twice a check's limit ago; a fresh one, which another server's live check may hold, another user's, a file and a longer name stay", { skip: process.platform === 'win32' ? 'no uid' : false }, async () => {
  assert.equal(typeof claude.sweepClaudeStatusFolders, 'function', 'the harness exports sweepClaudeStatusFolders');
  const dir = scratch();
  const past = new Date(Date.now() - 10 * 60_000);
  const folder = (name, old) => {
    const path = join(dir, name);
    mkdirSync(join(path, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(join(path, 'config', '.claude.json'), '{}\n', { mode: 0o600 });
    if (old) utimesSync(path, past, past);
    return path;
  };
  const stale = folder('agentrun-claude-status-Ab12Cd', true);
  const fresh = folder('agentrun-claude-status-Ef34Gh', false);
  // A test's own root starts so too (this file's): only mkdtemp's six characters after the prefix are a check's.
  const longer = folder('agentrun-claude-status-test-Ij56Kl', true);
  const file = join(dir, 'agentrun-claude-status-Mn78Op');
  writeFileSync(file, '');
  utimesSync(file, past, past);
  // Swept as another user (a uid the folders are not owned by): none is theirs.
  assert.deepEqual(await claude.sweepClaudeStatusFolders({ dir, uid: process.getuid() + 1 }), [], "another user's sweep takes nothing of this user's");
  assert.ok(existsSync(stale), "this user's stale folder stays under another user's sweep");
  // Swept as this user: the stale folder alone.
  assert.deepEqual(await claude.sweepClaudeStatusFolders({ dir }), [stale]);
  assert.equal(existsSync(stale), false, 'the stale folder and the copy in it are gone');
  for (const kept of [fresh, longer, file]) assert.ok(existsSync(kept), `${kept} stays`);
  // Twice the check's limit (2 x 15 s) on, the fresh one is stale too.
  assert.deepEqual(await claude.sweepClaudeStatusFolders({ dir, now: Date.now() + 31_000 }), [fresh]);
});

/** A stand-in CLI that rewrites the account file in its config dir as it starts, as the pinned CLI does when the file's
 *  migration number is not its own, then answers signed out. */
function rewritingCli() {
  const dir = scratch();
  const cli = join(dir, 'claude');
  writeFileSync(cli, [
    `#!${process.execPath}`,
    `const fs = require('node:fs');`,
    `const path = require('node:path');`,
    `const config = process.env.CLAUDE_CONFIG_DIR;`,
    `if (config) fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ migrationVersion: 99 }));`,
    `process.stdout.write(${JSON.stringify(SIGNED_OUT)});`,
    `process.exit(1);`,
    '',
  ].join('\n'), { mode: 0o755 });
  return cli;
}

test("a status check on a login its caller marked as nothing (no home, no flag: a CLAUDE_CONFIG_DIR folder, or AgentRun's own) still runs the CLI on a copy of the account file: the folder's .claude.json keeps its bytes and its mtime", async () => {
  const folder = scratch();
  const login = { dir: folder, profiles: join(folder, 'anthropic') };
  const account = join(folder, '.claude.json');
  writeFileSync(account, `${JSON.stringify({ hasCompletedOnboarding: true, migrationVersion: 15 })}\n`, { mode: 0o600 });
  // An mtime in the past, so a rewrite within the same clock tick still shows.
  const past = new Date('2026-01-01T00:00:00Z');
  utimesSync(account, past, past);
  const before = { sha: sha256(account), mtime: statSync(account).mtimeMs };
  assert.deepEqual(await claude.claudeLoginStatus(rewritingCli(), login), OUT);
  assert.equal(sha256(account), before.sha, "the folder's account file keeps its bytes: the CLI rewrote a copy, never it");
  assert.equal(statSync(account).mtimeMs, before.mtime, "the folder's account file keeps its mtime");
});

// The account file is the person's, so it can be anything: a FIFO, a link to a device, a very big file. Reading one of
// those whole on the server's own thread stops every request (a FIFO's open waits for a writer; /dev/zero never ends), and
// a big one is parsed on every poll. The copy takes a regular file of at most 32 MiB, and nothing else.

test("an account file that is a FIFO is copied as nothing, at once: the check never waits on it for a writer, which would stop the server's event loop", { skip: process.platform === 'win32' ? 'no mkfifo' : false, timeout: 30_000 }, async (t) => {
  const { home, login } = defaultLogin();
  const file = join(home, '.claude.json');
  rmSync(file);
  execFileSync('mkfifo', [file]);
  // A writer that comes only after 3 s, with an account a copy would hold: a check that opens the FIFO to read waits that
  // long for it (its thread stopped), then copies what it wrote.
  const writer = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(file)}, '{"numStartups":1}'), 3000)`], { stdio: 'ignore' });
  t.after(() => writer.kill('SIGKILL'));
  const fake = fakeCli();
  const started = Date.now();
  assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login), OUT);
  const took = Date.now() - started;
  const [seen] = fake.seen();
  assert.deepEqual([seen.folder, seen.copy], [[], null], 'a FIFO is copied as nothing');
  assert.ok(took < 2500, `the check answered in ${took} ms, without waiting for the FIFO's writer`);
});

test("an account file over 32 MiB is copied as nothing, though it reads as a JSON object; one under it is copied", { timeout: 60_000 }, async () => {
  const { home, login } = defaultLogin();
  const file = join(home, '.claude.json');
  // An object, then spaces: JSON all through, so only its size keeps it from the copy. A sparse file would hold NULs,
  // which no JSON reading takes, and would be copied as nothing for that alone.
  const fd = openSync(file, 'w', 0o600);
  writeSync(fd, '{"numStartups":3}');
  const spaces = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < 32; i++) writeSync(fd, spaces);
  closeSync(fd);
  assert.ok(statSync(file).size > 32 * 1024 * 1024);
  const big = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(big.cli, login), OUT);
  const [seen] = big.seen();
  assert.deepEqual([seen.folder, seen.copy], [[], null], 'a file over 32 MiB is copied as nothing');
  // The same account in a small file: copied.
  writeFileSync(file, '{"numStartups":3}\n', { mode: 0o600 });
  const small = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(small.cli, login), OUT);
  assert.deepEqual(JSON.parse(copyText(small.seen()[0])), { numStartups: 3 }, 'a regular file under the cap is copied');
});

test("an account file that is a link to a device that never ends (/dev/zero), or a folder, is copied as nothing, and the check still answers; a link to a regular file is followed", { skip: process.platform === 'win32' ? 'no /dev/zero' : false, timeout: 30_000 }, async () => {
  for (const [what, make] of [
    ['a link to /dev/zero', (file) => symlinkSync('/dev/zero', file)],
    ['a folder', (file) => mkdirSync(file)],
  ]) {
    const { home, login } = defaultLogin();
    const file = join(home, '.claude.json');
    rmSync(file);
    make(file);
    const fake = fakeCli();
    assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login), OUT, what);
    const [seen] = fake.seen();
    assert.deepEqual([seen.folder, seen.copy], [[], null], `${what}: copied as nothing`);
  }
  // A dotfiles manager's link: what it points to is copied.
  const { home, login } = defaultLogin();
  const file = join(home, '.claude.json');
  const kept = join(scratch(), 'claude.json');
  writeFileSync(kept, '{"numStartups":4}\n', { mode: 0o600 });
  rmSync(file);
  symlinkSync(kept, file);
  const fake = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login), OUT);
  assert.deepEqual(JSON.parse(copyText(fake.seen()[0])), { numStartups: 4 }, 'a link to a regular file is copied as that file');
});
