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
import { tmpdir } from 'node:os';
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

/** A stand-in CLI that notes, per process, its environment, what its config dir held and the bytes of the account file
 *  there, then answers `answer`. With `gate` (a port on loopback) it connects there first and answers only once the
 *  gate writes to it. */
function fakeCli({ answer = SIGNED_OUT, gate } = {}) {
  const dir = scratch();
  const cli = join(dir, 'claude');
  writeFileSync(cli, [
    `#!${process.execPath}`,
    `const fs = require('node:fs');`,
    `const path = require('node:path');`,
    `const config = process.env.CLAUDE_CONFIG_DIR;`,
    `const copy = config ? path.join(config, '.claude.json') : undefined;`,
    `const seen = { env: process.env, folder: config && fs.existsSync(config) ? fs.readdirSync(config) : null, copy: copy && fs.existsSync(copy) ? fs.readFileSync(copy).toString('base64') : null };`,
    `fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'seen-' + process.pid + '.json'), JSON.stringify(seen));`,
    `const answer = () => { process.stdout.write(${JSON.stringify(answer)}); process.exit(1); };`,
    gate === undefined
      ? `answer();`
      : `const socket = require('node:net').connect(${gate}, '127.0.0.1', () => socket.write('r')); socket.once('data', answer); socket.on('error', () => process.exit(2));`,
    '',
  ].join('\n'), { mode: 0o755 });
  const seen = () => readdirSync(dir).filter((name) => name.startsWith('seen-')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  return { cli, seen };
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
    assert.equal(seen.copy, bytes.toString('base64'), `${platform}: the config dir holds a byte-identical copy of the account file`);
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
    const fake = fakeCli();
    assert.deepEqual(await claude.claudeLoginStatus(fake.cli, login, { platform }), OUT);
    const [seen] = fake.seen();
    const config = seen.env.CLAUDE_CONFIG_DIR;
    assert.notEqual(config, folder, `${platform}: the status check never runs the CLI on the folder's own account file`);
    assert.ok(config && outside(folder, config), `${platform}: ${config} is outside the folder`);
    assert.equal(seen.copy, bytes.toString('base64'), `${platform}: the config dir holds a byte-identical copy of the folder's account file`);
    // The person's CLI with CLAUDE_CONFIG_DIR=<folder> keeps its tokens there (Linux) or in the item hashed from it (macOS).
    assert.equal(seen.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, folder, platform);
    assert.ok(seen.env.HOME && seen.env.HOME !== folder, platform);
  }
});

test("the status check's folder is gone once the CLI answered, and once the status threw because the CLI gave no answer", async () => {
  const { login } = defaultLogin();
  const answered = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(answered.cli, login), OUT);
  const [one] = answered.seen();
  assert.ok(one.env.CLAUDE_CONFIG_DIR, 'the status check had a folder of its own');
  assert.notEqual(one.folder, null, 'its folder was there while the CLI ran');
  assert.equal(existsSync(one.env.CLAUDE_CONFIG_DIR), false, 'the folder is gone after the answer');
  const garbled = fakeCli({ answer: 'Not logged in' });
  await assert.rejects(claude.claudeLoginStatus(garbled.cli, login), /gave no login status/);
  const [two] = garbled.seen();
  assert.ok(two.env.CLAUDE_CONFIG_DIR, 'the status check had a folder of its own');
  assert.notEqual(two.folder, null, 'its folder was there while the CLI ran');
  assert.equal(existsSync(two.env.CLAUDE_CONFIG_DIR), false, 'the folder is gone after the throw');
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
  for (const s of seen) assert.equal(s.copy, bytes.toString('base64'));
  for (const folder of folders) assert.equal(existsSync(folder), false, `${folder} is gone`);
});
