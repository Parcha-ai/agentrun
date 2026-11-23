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
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
    const login = { dir: folder, profiles: join(folder, 'anthropic'), shared: true };
    const person = scratch();
    const fake = fakeCli();
    assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login, { platform, home: person }), OUT);
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
      // AgentRun's own folder: the sign-in's variables, the folder its config dir and its credentials dir.
      ['own', { dir: join(base, 'claude-login'), profiles: join(base, 'claude-login', 'anthropic') }, person],
      // The CLI's default folder: the login's home is the person's; the Keychain item with no suffix.
      ['home', atHome, atHome.home],
      // A CLAUDE_CONFIG_DIR folder: the item hashed from the folder, never from the copy.
      ['shared', { dir: folder, profiles: join(folder, 'anthropic'), shared: true }, person],
    ];
    for (const [where, login, home] of places) {
      const fake = fakeCli();
      const { tmp, outcome } = await inOwnTmp(() => claude.claudeLoginStatus(fake.cli, login, { platform, home: person }));
      assert.deepEqual(outcome.value, OUT, `${platform} ${where}: ${outcome.error}`);
      const [seen] = fake.seen();
      assert.equal(seen.env.HOME, home, `${platform} ${where}: the status check runs in the person's home`);
      assert.ok(outside(tmp, seen.env.HOME), `${platform} ${where}: its home ${seen.env.HOME} is not under the check's temporary folder ${tmp}`);
      assert.equal(seen.env.XDG_CONFIG_HOME, undefined, `${platform} ${where}: no config home of the check's own`);
      const secure = seen.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      assert.equal(secure, where === 'home' && platform === 'darwin' ? '' : login.dir, `${platform} ${where}: the place's own credentials dir`);
      assert.ok(secure === '' || outside(tmp, secure), `${platform} ${where}: the credentials dir ${secure} is never the copy's`);
      if (where === 'own') {
        // As the sign-in at that folder runs (signInEnv), in that home.
        assert.deepEqual(placeVars(seen.env), { ...claude.claudeSignInEnv(login), HOME: person }, `${platform}: AgentRun's own folder is asked as it is signed in`);
      } else {
        assert.ok(seen.env.CLAUDE_CONFIG_DIR && !outside(tmp, seen.env.CLAUDE_CONFIG_DIR), `${platform} ${where}: the config dir is the copy, under the check's folder`);
      }
    }
  }
  // No home given: the server's own (os.homedir()).
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
    ['CLAUDE_CONFIG_DIR folder', join(folder, '.claude.json'), { dir: folder, profiles: join(folder, 'anthropic'), shared: true }],
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
