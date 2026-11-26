// A login on macOS, from sign-in to run, against stand-ins that keep the pinned CLI's rules there (2.1.286, read from its
// macOS build; login-places.test.mjs lists them). The CLI keeps its tokens in a Keychain item, read and written through
// `security`, and macOS keeps the login keychain under the user's home. So a sign-in, the status check and a run agree on
// a login only when all three run in the person's home and name the same item: a status check in a home of its own read
// "not signed in" after every sign-in, and its runs were refused. CI has no macOS, so these stand-ins are what holds it:
// - `security`: one keychain file, `$HOME/Library/Keychains/login.keychain-db`. In a home without one it finds and keeps
//   nothing.
// - `claude`: `auth login` keeps a token in the item the pinned CLI would name (its suffix hashes the credentials dir in
//   Unicode's composed form, NFC, as the CLI does) and writes the account file; `auth status` says whether it finds
//   that item. It has no plaintext fallback: a sign-in that reaches no keychain fails.
//   The item's account is the pinned CLI's too: `$USER`, else `os.userInfo().username`. That CLI is a Bun binary, and
//   Bun's userInfo reads `$USER` as well, and says "unknown" without it (Node's reads the user database): so a CLI
//   started with no USER saves and reads its tokens under the account "unknown", where a terminal's `claude`, which has
//   USER, never looks. A name outside [A-Za-z0-9._-] is "claude-code-user".
// `security` notes the command and account of every read and write beside itself (asked.jsonl), and of every delete
// apart (deleted.jsonl). A delete with no account takes the service's first item of any account, as macOS's does.
// The stand-ins lead every PATH here and every home is a temporary one, so no real Keychain or login is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as claude from '@parcha/agentrun-harness-claude';
import { durableEnv } from '../dist/env.js';

const skip = process.platform === 'win32' ? 'the stand-ins are POSIX scripts' : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-keychain-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const SECURITY = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.HOME ?? '', 'Library', 'Keychains', 'login.keychain-db');
const [command, ...args] = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const deleting = command === 'delete-generic-password';
fs.appendFileSync(path.join(__dirname, deleting ? 'deleted.jsonl' : 'asked.jsonl'), JSON.stringify([command, flag('-a')]) + '\\n');
if (!fs.existsSync(file)) process.exit(command === 'add-generic-password' ? 50 : 44);
const items = JSON.parse(fs.readFileSync(file, 'utf8'));
const key = JSON.stringify([flag('-a'), flag('-s')]);
if (command === 'find-generic-password') {
  if (!(key in items)) process.exit(44);
  console.log(items[key]);
} else if (command === 'add-generic-password') {
  items[key] = Buffer.from(flag('-X'), 'hex').toString('utf8');
  fs.writeFileSync(file, JSON.stringify(items));
} else if (deleting) {
  // The first item of the service, of the account when -a names one, of any account when it names none.
  const found = Object.keys(items).find((each) => { const [account, service] = JSON.parse(each); return service === flag('-s') && (flag('-a') === undefined || account === flag('-a')); });
  if (found === undefined) process.exit(44);
  delete items[found];
  fs.writeFileSync(file, JSON.stringify(items));
} else process.exit(2);
`;

const CLI = `#!${process.execPath}
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const env = process.env;
const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
const bare = secure !== undefined ? !secure : !env.CLAUDE_CONFIG_DIR;
// The CLI hashes the credentials dir in Unicode's composed form, as its source does: .normalize("NFC") of the variable.
const item = 'Claude Code-credentials' + (bare ? '' : '-' + createHash('sha256').update(secure !== undefined ? secure.normalize('NFC') : configDir).digest('hex').slice(0, 8));
const bunUsername = env.USER ?? 'unknown';
const named = env.USER || bunUsername;
const user = /^[a-zA-Z0-9._-]+$/.test(named) ? named : 'claude-code-user';
const accountFile = path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
const [, , group, verb] = process.argv;
if (group === 'auth' && verb === 'login') {
  const tokens = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } })).toString('hex');
  if (spawnSync('security', ['add-generic-password', '-U', '-a', user, '-s', item, '-X', tokens]).status !== 0) process.exit(1);
  fs.mkdirSync(path.dirname(accountFile), { recursive: true });
  fs.writeFileSync(accountFile, JSON.stringify({ oauthAccount: { emailAddress: 'person@example.com' } }));
  process.exit(0);
}
if (group === 'auth' && verb === 'status') {
  const found = spawnSync('security', ['find-generic-password', '-a', user, '-w', '-s', item], { encoding: 'utf8' });
  const signedIn = found.status === 0 && found.stdout.trim() !== '';
  let email;
  try { email = JSON.parse(fs.readFileSync(accountFile, 'utf8')).oauthAccount?.emailAddress; } catch {}
  console.log(JSON.stringify(signedIn ? { loggedIn: true, authMethod: 'claude.ai', ...(email ? { email } : {}) } : { loggedIn: false, authMethod: 'none' }));
  process.exit(signedIn ? 0 : 1);
}
if (group === 'auth' && verb === 'logout') {
  // The item the sign-in kept goes, and the account with it; an item already gone is no failure.
  const removed = spawnSync('security', ['delete-generic-password', '-a', user, '-s', item]).status;
  if (removed !== 0 && removed !== 44) process.exit(1);
  fs.rmSync(accountFile, { force: true });
  process.exit(0);
}
process.exit(2);
`;

/** A Mac of one person: the stand-ins in a folder that leads `path`, their home with an empty login keychain, and their
 *  terminal's environment. */
function mac() {
  const root = scratch();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'security'), SECURITY, { mode: 0o755 });
  writeFileSync(join(bin, 'claude'), CLI, { mode: 0o755 });
  const home = join(root, 'Users', 'person');
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Keychains', 'login.keychain-db'), '{}');
  const path = `${bin}:/usr/bin:/bin`;
  const asked = join(bin, 'asked.jsonl');
  const deleted = join(bin, 'deleted.jsonl');
  return {
    bin, cli: join(bin, 'claude'), home, path, terminal: { PATH: path, HOME: home, USER: ACCOUNT, LOGNAME: ACCOUNT },
    items: () => Object.keys(JSON.parse(readFileSync(join(home, 'Library', 'Keychains', 'login.keychain-db'), 'utf8'))).length,
    /** Each `security` read and write so far, as [command, account]. */
    asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    /** Each `security` delete so far, as [command, account]. */
    deleted: () => (existsSync(deleted) ? readFileSync(deleted, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

/** The user this test runs as, as the system has it: the account a Mac keeps that person's Keychain items under, which
 *  their terminal's USER names. */
const ACCOUNT = userInfo().username;
/** The Keychain account the CLI names for ACCOUNT, by the stand-in's rule above: the name itself, or "claude-code-user"
 *  for a name with a character outside [A-Za-z0-9._-] (an account such as `alice@example.com`). USER and LOGNAME keep
 *  ACCOUNT as it is. */
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/.test(ACCOUNT) ? ACCOUNT : 'claude-code-user';

/** `fn` as a server started with `user` as its USER and LOGNAME (undefined: neither set, as a service launchd starts may
 *  have it). */
async function withServerUser(user, fn) {
  const was = { USER: process.env.USER, LOGNAME: process.env.LOGNAME };
  for (const name of ['USER', 'LOGNAME']) {
    if (user === undefined) delete process.env[name];
    else process.env[name] = user;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** `fn` as the server that person runs: the server's own home (`os.homedir()`, which reads HOME) is theirs. */
async function asServerOf(m, fn) {
  const was = process.env.HOME;
  process.env.HOME = m.home;
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env.HOME;
    else process.env.HOME = was;
  }
}

/** The logins serve makes (its loginAt), on that Mac: each carries the person's home as `userHome`, as serve's do. */
const PLACES = {
  "AgentRun's own folder": (m) => ({ dir: join(m.home, '.agentrun', 'claude-login'), profiles: join(m.home, '.agentrun', 'claude-login', 'anthropic'), userHome: m.home, own: true }),
  "this machine's login on the CLI's default folder": (m) => ({ dir: join(m.home, '.claude'), profiles: join(m.home, '.config', 'anthropic'), home: m.home, userHome: m.home }),
  "this machine's login in a CLAUDE_CONFIG_DIR folder": (m) => ({ dir: join(m.home, 'work-claude'), profiles: join(m.home, '.config', 'anthropic'), userHome: m.home }),
};
/** The places that are the person's own CLI's login, which their own claude signs in to and reads as well. */
const THEIRS = new Set(["this machine's login on the CLI's default folder", "this machine's login in a CLAUDE_CONFIG_DIR folder"]);

/** The status check as serve asks it: the server's PATH, and no home but the server's own. `now`: the clock its drop of
 *  an "unknown" item measures its back-off on, when a test moves it. */
const status = (m, login, now) => claude.claudeLoginStatus(m.cli, login, { path: m.path, platform: 'darwin', ...(now ? { now } : {}) });

/** What the CLI of a run on `login` says of it, started with the run's environment (durableEnv), the stand-ins ahead of
 *  its PATH as `/usr/bin/security` is on a Mac. */
function runSays(m, login) {
  const session = scratch();
  const env = durableEnv({ home: join(session, 'home'), configDir: join(session, 'config'), tmpDir: join(session, 'tmp'), cacheDir: join(session, 'cache'), login, platform: 'darwin', model: 'claude-haiku-5-5' });
  const said = spawnSync(m.cli, ['auth', 'status', '--json'], { env: { ...env, PATH: `${m.bin}:${env.PATH}` }, encoding: 'utf8' });
  return JSON.parse(said.stdout).loggedIn;
}

/** Their own `claude auth login`: a way to sign in only at this machine's login, the one their own CLI uses (THEIRS). */
const OWN = "their own claude, with no variable of AgentRun's";
/** Each way a person signs in at `login`. */
const WAYS = {
  // The console's button (serve's startLoginHere): the server's PATH and HOME. The sign-in runs in the person's home
  // (personHome): the login's userHome, which every login here carries as serve's do, and it is started as the server of
  // that person (asServerOf) as well.
  'the sign-in this host starts': async (m, login) => assert.deepEqual(await claude.startClaudeLogin(m.cli, login, { path: m.path, display: {} }).ended, { end: 'exited', code: 0, signal: null }),
  'the shown line, run in their terminal': (m, login) => assert.equal(spawnSync('/bin/sh', ['-c', claude.claudeLoginCommand(login, m.cli)], { env: m.terminal }).status, 0),
  // As they run the CLI: their CLAUDE_CONFIG_DIR where they use one, nothing else.
  [OWN]: (m, login) => assert.equal(spawnSync(m.cli, ['auth', 'login'], { env: { ...m.terminal, ...(login.home === undefined ? { CLAUDE_CONFIG_DIR: login.dir } : {}) } }).status, 0),
};

test('on macOS a login reads signed out until it is signed in, then signed in to the status check and to a run, at every place and by every way of signing in: all of them reach the one Keychain item, in the person\'s home', { skip }, async () => {
  for (const [place, at] of Object.entries(PLACES)) {
    for (const [way, signIn] of Object.entries(WAYS)) {
      const m = mac();
      const login = at(m);
      if (way === OWN && !THEIRS.has(place)) continue;
      await asServerOf(m, async () => {
        assert.deepEqual(await status(m, login), { signedIn: false, method: 'none' }, `${place}, before ${way}`);
        assert.equal(runSays(m, login), false, `${place}, a run before ${way}`);
        await signIn(m, login);
        assert.equal(m.items(), 1, `${place}: ${way} keeps one item in the person's login keychain`);
        assert.deepEqual(await status(m, login), { signedIn: true, method: 'claude.ai', email: 'person@example.com' }, `${place}: the status check after ${way}`);
        assert.equal(runSays(m, login), true, `${place}: a run after ${way}`);
        assert.equal(m.items(), 1, `${place}: the status check and the run kept no item of their own`);
      });
    }
  }
});

test("on macOS the person's own claude reads signed in on this machine's login after the sign-in this host starts, on the default folder and in a CLAUDE_CONFIG_DIR folder: it is their CLI's login, not a second one", { skip }, async () => {
  for (const [place, at] of Object.entries(PLACES)) {
    const m = mac();
    const login = at(m);
    if (!THEIRS.has(place)) continue;
    const theirs = () => JSON.parse(spawnSync(m.cli, ['auth', 'status', '--json'], { env: { ...m.terminal, ...(login.home === undefined ? { CLAUDE_CONFIG_DIR: login.dir } : {}) }, encoding: 'utf8' }).stdout);
    assert.equal(theirs().loggedIn, false, place);
    await asServerOf(m, () => WAYS['the sign-in this host starts'](m, login));
    assert.deepEqual(theirs(), { loggedIn: true, authMethod: 'claude.ai', email: 'person@example.com' }, place);
  }
});

test("the stand-ins keep macOS's rule, the one a status check in a home of its own broke: a signed-in login asked with the same variables reads signed out in any home but the person's, where the login keychain is", { skip }, async () => {
  const m = mac();
  const login = PLACES["AgentRun's own folder"](m);
  await asServerOf(m, () => WAYS['the sign-in this host starts'](m, login));
  const asked = (home) => JSON.parse(spawnSync(m.cli, ['auth', 'status', '--json'], { env: { PATH: m.path, USER: ACCOUNT, ...claude.claudeSignInEnv(login), HOME: home }, encoding: 'utf8' }).stdout).loggedIn;
  assert.equal(asked(scratch()), false, "an empty home: no login keychain, so no tokens");
  assert.equal(asked(m.home), true, "the person's home");
});

// The badge (the status check, which runs the CLI on a copy of the account file as its config dir and names the tokens'
// folder in CLAUDE_SECURESTORAGE_CONFIG_DIR) and a plain `claude auth status` a person runs in their own terminal, in
// their home, with the shown line's variables, read the same Keychain item, so they answer alike, before the sign-in and
// after it, at every place. On AgentRun's own folder those variables are CLAUDE_CONFIG_DIR and
// CLAUDE_SECURESTORAGE_CONFIG_DIR both set to the folder: the item's suffix is the hash of that folder's path as written.
// On the CLI's default folder there are none: the item is the one with no suffix, and both variables set to ~/.claude
// name another item (its hash), which holds nothing, so that command reads signed out while the badge reads signed in.
const plainStatus = (m, vars) => JSON.parse(spawnSync(m.cli, ['auth', 'status', '--json'], { env: { ...m.terminal, ...vars }, encoding: 'utf8' }).stdout).loggedIn;
test("on macOS the badge and a plain `claude auth status` in the person's home with the shown line's variables answer alike at every place, before and after the sign-in; on AgentRun's own folder those are CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR both set to it", { skip }, async () => {
  for (const [place, at] of Object.entries(PLACES)) {
    const m = mac();
    const login = at(m);
    const shown = claude.claudeSignInEnv(login);
    await asServerOf(m, async () => {
      assert.equal((await status(m, login)).signedIn, false, `${place}: the badge before the sign-in`);
      assert.equal(plainStatus(m, shown), false, `${place}: a plain auth status before the sign-in`);
      await WAYS['the sign-in this host starts'](m, login);
      assert.equal((await status(m, login)).signedIn, true, `${place}: the badge after the sign-in`);
      assert.equal(plainStatus(m, shown), true, `${place}: a plain auth status with the shown line's variables ${JSON.stringify(shown)} read signed out while the badge read signed in`);
    });
    if (place === "AgentRun's own folder") assert.deepEqual([shown.CLAUDE_CONFIG_DIR, shown.CLAUDE_SECURESTORAGE_CONFIG_DIR], [login.dir, login.dir], "on AgentRun's own folder the line names the folder in both variables");
    if (login.home !== undefined) assert.equal(plainStatus(m, { CLAUDE_CONFIG_DIR: login.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: login.dir }), false, `${place}: both variables set to the default folder name another Keychain item`);
  }
});

// The CLI's own sign-out (claudeLogout) runs with the sign-in's variables in the person's home, so it reaches the one
// Keychain item the sign-in kept: after it no item is left and the status check reads signed out. Serve runs it on
// AgentRun's own folder alone; the harness names the item the same way at every place.
test("on macOS the CLI's own sign-out removes the Keychain item the sign-in kept, at every place: none is left, and the status check reads signed out", { skip }, async () => {
  assert.equal(typeof claude.claudeLogout, 'function', "the harness has the CLI's own sign-out");
  for (const [place, at] of Object.entries(PLACES)) {
    const m = mac();
    const login = at(m);
    await asServerOf(m, async () => {
      await WAYS['the sign-in this host starts'](m, login);
      assert.equal(m.items(), 1, `${place}: signed in, one item`);
      assert.deepEqual(await claude.claudeLogout(m.cli, login, { path: m.path, platform: 'darwin' }), { signedOut: true, leftoverGone: true }, `${place}: the CLI confirmed its sign-out, and no item a sign-in left under "unknown" remains`);
      assert.equal(m.items(), 0, `${place}: no Keychain item is left after the sign-out`);
      assert.deepEqual(await status(m, login), { signedIn: false, method: 'none' }, `${place}: the status check after the sign-out`);
      assert.equal(runSays(m, login), false, `${place}: a run after the sign-out`);
    });
  }
});

test("the CLI's own sign-out says signed out false, never throws, when the CLI fails it, is no program, or outlasts its limit", { skip }, async () => {
  assert.equal(typeof claude.claudeLogout, 'function', "the harness has the CLI's own sign-out");
  const m = mac();
  const login = PLACES["AgentRun's own folder"](m);
  const failing = join(m.bin, 'claude-fails');
  writeFileSync(failing, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const hangs = join(m.bin, 'claude-hangs');
  writeFileSync(hangs, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  await asServerOf(m, async () => {
    assert.equal((await claude.claudeLogout(failing, login, { path: m.path })).signedOut, false, 'a CLI that exits 1');
    assert.equal((await claude.claudeLogout(join(m.bin, 'no-such-claude'), login, { path: m.path })).signedOut, false, 'no program at the path');
    const started = Date.now();
    assert.equal((await claude.claudeLogout(hangs, login, { path: m.path, timeoutMs: 200 })).signedOut, false, 'a CLI past its limit');
    assert.ok(Date.now() - started < 5_000, 'ended at its limit, not left running');
  });
});

// The finding this holds: a sign-in from the console saved its item under the account "unknown" (the CLI was started
// with no USER), so the badge, asked the same way, read signed in, while `claude auth status` in the person's terminal,
// which has USER, read signed out. The server's USER as it was started: from a terminal, unset (a service launchd
// starts may have none), or naming another user (a server started under sudo, which keeps it): the account is the
// user the server runs as, as the system has it, in each case.
const SERVER_USER = { 'as a terminal sets it': ACCOUNT, 'unset': undefined, 'naming another user': 'someone-else' };
test("on macOS the sign-in this host starts saves its Keychain item under the account of the user the server runs as, never \"unknown\", and the badge, a run and the person's own `claude auth status` all read that account, whatever USER the server was started with", { skip }, async () => {
  for (const [place, at] of Object.entries(PLACES)) {
    for (const [how, user] of Object.entries(SERVER_USER)) {
      const m = mac();
      const login = at(m);
      const where = `${place}, the server's USER ${how}`;
      await withServerUser(user, () => asServerOf(m, async () => {
        await WAYS['the sign-in this host starts'](m, login);
        assert.deepEqual(m.asked().filter(([command]) => command === 'add-generic-password'), [['add-generic-password', KEYCHAIN_ACCOUNT]], `${where}: the sign-in saved its item under the account ${KEYCHAIN_ACCOUNT}`);
        assert.equal((await status(m, login)).signedIn, true, `${where}: the badge after the sign-in`);
        assert.equal(runSays(m, login), true, `${where}: a run after the sign-in`);
      }));
      assert.equal(plainStatus(m, claude.claudeSignInEnv(login)), true, `${where}: the person's own \`claude auth status\` in their terminal (USER ${ACCOUNT}) read signed out after the sign-in`);
      assert.deepEqual([...new Set(m.asked().map(([, account]) => account))], [KEYCHAIN_ACCOUNT], `${where}: every Keychain write and read named the account ${KEYCHAIN_ACCOUNT}`);
    }
  }
});

// The CLI's own sign-out (claudeLogout) names the user the sign-in named (loginUser), so it deletes the item under the
// account the sign-in saved it under, whatever USER the server was started with: with the server's USER it would ask
// for the account "unknown" (none set) or another user's, find nothing, and leave the login in the Keychain.
// An earlier sign-in with no USER left an item under "unknown" too, and the person then signed in with the shown line in
// their terminal, which runs no drop of that item (the sign-in this host starts would, on a Mac, before the sign-out).
// So no delete has run before the sign-out, on any host: at AgentRun's own folder the sign-out deletes the "unknown"
// item after the CLI's own; at the person's own CLI's places it leaves it, as it may be theirs.
test("on macOS the CLI's own sign-out deletes the Keychain item under the account the sign-in saved it under, whatever USER the server was started with, and at AgentRun's own folder the item a sign-in left under \"unknown\" after it: the status check reads signed out", { skip }, async () => {
  for (const [place, at] of Object.entries(PLACES)) {
    for (const [how, user] of Object.entries(SERVER_USER)) {
      const m = mac();
      const login = at(m);
      const where = `${place}, the server's USER ${how}`;
      assert.equal(spawnSync(m.cli, ['auth', 'login'], { env: { PATH: m.path, HOME: m.home, ...claude.claudeSignInEnv(login) } }).status, 0, `${where}: a sign-in with no USER`);
      const [[, service]] = keychain(m);
      WAYS['the shown line, run in their terminal'](m, login);
      const items = () => keychain(m).map((item) => JSON.stringify(item)).sort();
      assert.deepEqual(items(), [JSON.stringify([KEYCHAIN_ACCOUNT, service]), JSON.stringify(['unknown', service])].sort(), `${where}: the person's item under the account ${KEYCHAIN_ACCOUNT} and the one under "unknown"`);
      assert.deepEqual(m.deleted(), [], `${where}: no delete ran before the sign-out`);
      await withServerUser(user, () => asServerOf(m, async () => {
        // At the person's own CLI's places no item under "unknown" is AgentRun's to drop, so none is said to remain.
        assert.deepEqual(await claude.claudeLogout(m.cli, login, { path: m.path, platform: 'darwin' }), { signedOut: true, leftoverGone: true }, `${where}: the CLI confirmed its sign-out, and no item under "unknown" of AgentRun's remains`);
        assert.deepEqual(m.deleted(), [['delete-generic-password', KEYCHAIN_ACCOUNT], ...(login.own ? [['delete-generic-password', 'unknown']] : [])], `${where}: the sign-out deleted under the account ${KEYCHAIN_ACCOUNT}${login.own ? ', then under "unknown"' : ''}`);
        assert.deepEqual(items(), login.own ? [] : [JSON.stringify(['unknown', service])], `${where}: after the sign-out ${login.own ? 'no Keychain item is left' : 'the item under "unknown" alone is left'}`);
        assert.deepEqual(await status(m, login), { signedIn: false, method: 'none' }, `${where}: the status check after the sign-out`);
      }));
      assert.equal(plainStatus(m, claude.claudeSignInEnv(login)), false, `${where}: the person's own \`claude auth status\` in their terminal (USER ${ACCOUNT}) after the sign-out`);
    }
  }
});

// A console sign-in made before the CLI got USER saved its item under the account "unknown", which nothing reads now.
// On AgentRun's own folder, which no CLI of the person's uses, that item goes once the folder's item under the person's
// account is there: after the sign-in this host starts, or at the first status check that finds the item. Never at a
// place of the person's own CLI (its default folder, a CLAUDE_CONFIG_DIR folder), whose "unknown" item may be theirs,
// and never an item of any other account.
const STALE_WHEN = {
  'the sign-in this host starts': async (m, login) => {
    await asServerOf(m, async () => assert.deepEqual(await claude.startClaudeLogin(m.cli, login, { path: m.path, display: {}, platform: 'darwin' }).ended, { end: 'exited', code: 0, signal: null }));
  },
  'the first status check that finds the item': async (m, login) => {
    assert.equal((await status(m, login)).signedIn, false, 'the status check before the person signed in');
    assert.ok(keychain(m).some(([account]) => account === 'unknown'), 'a status check that reads signed out leaves the "unknown" item');
    WAYS['the shown line, run in their terminal'](m, login);
    assert.equal((await status(m, login)).signedIn, true, 'the status check after the person signed in from their terminal');
  },
};
/** Each item of the person's login keychain, as [account, service]. */
const keychain = (m) => Object.keys(JSON.parse(readFileSync(join(m.home, 'Library', 'Keychains', 'login.keychain-db'), 'utf8'))).map((key) => JSON.parse(key));
test('on macOS the Keychain item a sign-in left under the account "unknown" goes at AgentRun\'s own folder alone, once its item under the person\'s account is there, and no item of another account goes', { skip }, async () => {
  for (const [place, at] of Object.entries(PLACES)) {
    for (const [when, act] of Object.entries(STALE_WHEN)) {
      const m = mac();
      const login = at(m);
      const where = `${place}, ${when}`;
      // What a sign-in left there before: under another account first, then under "unknown" (a CLI started with no
      // USER), and the person's own CLI's default item under "unknown" too.
      const leave = (user, vars) => assert.equal(spawnSync(m.cli, ['auth', 'login'], { env: { PATH: m.path, HOME: m.home, ...vars, ...(user ? { USER: user } : {}) } }).status, 0);
      leave('someone-else', claude.claudeSignInEnv(login));
      const [[, service]] = keychain(m);
      leave(undefined, claude.claudeSignInEnv(login));
      leave(undefined, claude.claudeSignInEnv(PLACES["this machine's login on the CLI's default folder"](m)));
      const bare = 'Claude Code-credentials';
      await act(m, login);
      const items = keychain(m).map((item) => JSON.stringify(item));
      const has = (account, of) => items.includes(JSON.stringify([account, of]));
      assert.equal(has('unknown', service), login.own !== true, `${where}: the item under "unknown" for ${service} ${login.own ? 'stayed' : 'went'}, items ${JSON.stringify(items)}`);
      assert.equal(has('someone-else', service), true, `${where}: the item under another account stayed, items ${JSON.stringify(items)}`);
      if (service !== bare) assert.equal(has('unknown', bare), true, `${where}: the person's own CLI's default item under "unknown" stayed, items ${JSON.stringify(items)}`);
      assert.equal(keychain(m).filter(([account, of]) => of === service && account !== 'unknown' && account !== 'someone-else').length, 1, `${where}: the item under the person's account is there`);
      assert.equal(plainStatus(m, claude.claudeSignInEnv(login)), true, `${where}: the person's own \`claude auth status\` reads signed in`);
    }
  }
});

/** How long the delete of an "unknown" item may take before it is ended (the source's DROP_MS). */
const DROP_MS = 5_000;
/** After a delete of an "unknown" item is killed or fails, how long a status check leaves the item before it asks again
 *  (the source's DROP_BACKOFF_MS). */
const DROP_BACKOFF_MS = 10 * 60_000;
/** A `security` whose delete under "unknown" never ends of itself: it ignores SIGTERM and keeps running, as a hung
 *  `security` or a wrapper on PATH may. Each such delete writes its pid, so the test ends any that outlive it. Every other
 *  command is SECURITY's. */
const HANGING = `#!${process.execPath}
if (process.argv[2] === 'delete-generic-password' && process.argv.includes('unknown')) {
  require('node:fs').appendFileSync(require('node:path').join(__dirname, 'hung.pids'), process.pid + '\\n');
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
${SECURITY.slice(SECURITY.indexOf('\n') + 1)}
}
`;
/** `p`, or a failure once `ms` have gone by with it unsettled, so a hang is a clean red rather than a hung run. */
function within(ms, what, p) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} had not settled ${ms} ms on`)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
for (const when of Object.keys(STALE_WHEN)) {
  test(`on macOS a delete of the "unknown" item that ignores SIGTERM is killed at its limit: ${when} does not wait on it past that`, { skip }, async () => {
    const m = mac();
    writeFileSync(join(m.bin, 'security'), HANGING, { mode: 0o755 });
    const login = PLACES["AgentRun's own folder"](m);
    try {
      if (when === 'the sign-in this host starts') {
        await asServerOf(m, async () => assert.deepEqual(await within(DROP_MS + 3_000, `${when}: the sign-in's end`, claude.startClaudeLogin(m.cli, login, { path: m.path, display: {}, platform: 'darwin' }).ended), { end: 'exited', code: 0, signal: null }));
      } else {
        WAYS['the shown line, run in their terminal'](m, login);
        assert.equal((await within(DROP_MS + 3_000, `${when}: the status check`, status(m, login))).signedIn, true, `${when}: the status check reads signed in`);
      }
      assert.ok(existsSync(join(m.bin, 'hung.pids')), `${when}: the delete under "unknown" was asked`);
    } finally {
      const pids = existsSync(join(m.bin, 'hung.pids')) ? readFileSync(join(m.bin, 'hung.pids'), 'utf8').split('\n').filter(Boolean).map(Number) : [];
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  });
}

/** Ends each hung delete the HANGING stand-in in `m` noted. */
function endHung(m) {
  const pids = existsSync(join(m.bin, 'hung.pids')) ? readFileSync(join(m.bin, 'hung.pids'), 'utf8').split('\n').filter(Boolean).map(Number) : [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// A delete killed at its limit did not delete the item, so the item is not dealt with: the next call asks again. Here a
// sign-in left an item under "unknown" at AgentRun's own folder, the person signed in from their terminal, and the first
// status check's delete hangs and is killed. Once `security` answers again, the next status check deletes it.
test('on macOS a delete of the "unknown" item killed at its limit leaves the item to the next status check, which deletes it', { skip }, async () => {
  const m = mac();
  const login = PLACES["AgentRun's own folder"](m);
  assert.equal(spawnSync(m.cli, ['auth', 'login'], { env: { PATH: m.path, HOME: m.home, ...claude.claudeSignInEnv(login) } }).status, 0, 'a sign-in with no USER');
  const [[, service]] = keychain(m);
  const unknownThere = () => keychain(m).some(([account, of]) => account === 'unknown' && of === service);
  assert.ok(unknownThere(), 'the sign-in with no USER left its item under "unknown"');
  WAYS['the shown line, run in their terminal'](m, login);
  writeFileSync(join(m.bin, 'security'), HANGING, { mode: 0o755 });
  try {
    assert.equal((await within(DROP_MS + 3_000, 'the first status check', status(m, login))).signedIn, true, 'the first status check reads signed in');
    assert.ok(existsSync(join(m.bin, 'hung.pids')), 'the first status check asked for the delete under "unknown"');
  } finally {
    endHung(m);
  }
  assert.ok(unknownThere(), 'the killed delete left the item under "unknown"');
  writeFileSync(join(m.bin, 'security'), SECURITY, { mode: 0o755 });
  // On a clock past the back-off a killed delete leaves (DROP_BACKOFF_MS), so the status check asks again.
  assert.equal((await status(m, login, () => Date.now() + DROP_BACKOFF_MS)).signedIn, true, 'the next status check reads signed in');
  assert.equal(unknownThere(), false, `the next status check deleted the item under "unknown" the killed delete left: items ${JSON.stringify(keychain(m))}`);
});

// The sign-in's end waits on the drop of the "unknown" item, which throws nothing of its own. Should anything in it throw
// all the same (here the hash that names the item's service, stubbed to throw), the end still settles, as the CLI's
// exit says, and nothing is left unhandled.
test('on macOS a drop of the "unknown" item that throws before its delete starts still ends the sign-in: its end settles as the CLI exited', { skip }, async () => {
  const m = mac();
  const login = PLACES["AgentRun's own folder"](m);
  const crypto = createRequire(import.meta.url)('node:crypto');
  const createHash = crypto.createHash;
  crypto.createHash = () => { throw new Error('the hash failed'); };
  syncBuiltinESMExports();
  try {
    await asServerOf(m, async () => assert.deepEqual(await within(DROP_MS + 3_000, "the sign-in's end", claude.startClaudeLogin(m.cli, login, { path: m.path, display: {}, platform: 'darwin' }).ended), { end: 'exited', code: 0, signal: null }));
  } finally {
    crypto.createHash = createHash;
    syncBuiltinESMExports();
  }
});

/** A Mac where a sign-in with no USER left an item under "unknown" at AgentRun's own folder (`at`, default the one in
 *  PLACES) and the person then signed in from their terminal, so the item under their account is there too: the case
 *  the drop deletes in. */
function leftUnknown(at = PLACES["AgentRun's own folder"]) {
  const m = mac();
  const login = at(m);
  assert.equal(spawnSync(m.cli, ['auth', 'login'], { env: { PATH: m.path, HOME: m.home, ...claude.claudeSignInEnv(login) } }).status, 0, 'a sign-in with no USER');
  const [[, service]] = keychain(m);
  WAYS['the shown line, run in their terminal'](m, login);
  const left = {
    m,
    login,
    unknownThere: () => keychain(m).some(([account, of]) => account === 'unknown' && of === service),
    /** How many deletes under "unknown" the HANGING stand-in has started. */
    hung: () => (existsSync(join(m.bin, 'hung.pids')) ? readFileSync(join(m.bin, 'hung.pids'), 'utf8').split('\n').filter(Boolean).length : 0),
    hanging: () => writeFileSync(join(m.bin, 'security'), HANGING, { mode: 0o755 }),
    answering: () => writeFileSync(join(m.bin, 'security'), SECURITY, { mode: 0o755 }),
  };
  assert.ok(left.unknownThere(), 'the sign-in with no USER left its item under "unknown"');
  return left;
}

/** A status check on `left`'s login, on the clock `now`, whose delete of the "unknown" item hangs and is killed at its
 *  limit: the item stays. `security` keeps hanging after it. */
async function killedDelete(left, now) {
  left.hanging();
  try {
    assert.equal((await within(DROP_MS + 3_000, 'the status check whose delete is killed', status(left.m, left.login, now))).signedIn, true, 'the status check whose delete is killed reads signed in');
    assert.equal(left.hung(), 1, 'the status check asked for the delete under "unknown" once');
  } finally {
    endHung(left.m);
  }
  assert.ok(left.unknownThere(), 'the killed delete left the item under "unknown"');
}

// A `security` that keeps hanging (a locked login keychain whose unlock prompt nobody answers) would cost every
// signed-in status check its full limit, and checks at once would each start a delete. One delete runs per item: a
// call while it runs waits on that one.
test('on macOS two status checks at once, while `security` hangs on the delete of the "unknown" item, start one delete between them', { skip }, async () => {
  const left = leftUnknown();
  left.hanging();
  try {
    const both = await within(DROP_MS + 3_000, 'the two status checks', Promise.all([status(left.m, left.login), status(left.m, left.login)]));
    assert.deepEqual(both.map((each) => each.signedIn), [true, true], 'both status checks read signed in');
    assert.equal(left.hung(), 1, `two status checks at once started ${left.hung()} deletes under "unknown", not one`);
  } finally {
    endHung(left.m);
  }
});

// After a delete is killed, status checks leave the item for a while (DROP_BACKOFF_MS): the next one neither starts a
// delete nor waits on one.
test('on macOS a status check inside the back-off after a killed delete of the "unknown" item starts no delete and does not wait on one', { skip }, async () => {
  const left = leftUnknown();
  let clock = Date.now();
  const now = () => clock;
  await killedDelete(left, now);
  clock += DROP_BACKOFF_MS - 1;
  try {
    assert.equal((await within(DROP_MS - 2_000, 'the status check inside the back-off', status(left.m, left.login, now))).signedIn, true, 'the status check inside the back-off reads signed in');
    assert.equal(left.hung(), 1, 'the status check inside the back-off started no delete under "unknown"');
  } finally {
    endHung(left.m);
  }
  assert.ok(left.unknownThere(), 'the item under "unknown" stays inside the back-off');
});

test('on macOS once the back-off after a killed delete of the "unknown" item has passed, a status check asks again, and a `security` that answers now deletes it', { skip }, async () => {
  const left = leftUnknown();
  let clock = Date.now();
  const now = () => clock;
  await killedDelete(left, now);
  left.answering();
  clock += DROP_BACKOFF_MS - 1;
  assert.equal((await status(left.m, left.login, now)).signedIn, true, 'the status check just inside the back-off reads signed in');
  assert.deepEqual(left.m.deleted().filter(([, account]) => account === 'unknown'), [], 'the status check just inside the back-off asked for no delete under "unknown"');
  assert.ok(left.unknownThere(), 'the item under "unknown" stays just inside the back-off');
  clock += 1;
  assert.equal((await status(left.m, left.login, now)).signedIn, true, 'the status check once the back-off has passed reads signed in');
  assert.equal(left.unknownThere(), false, `the status check once the back-off has passed deleted the item under "unknown": items ${JSON.stringify(keychain(left.m))}`);
});

// A sign-in that exits 0 has a person at the machine, so its drop asks at once, back-off or none.
test('on macOS a sign-in that exits 0 inside the back-off after a killed delete of the "unknown" item still deletes it', { skip }, async () => {
  const left = leftUnknown();
  let clock = Date.now();
  await killedDelete(left, () => clock);
  left.answering();
  clock += 1;
  await asServerOf(left.m, async () => assert.deepEqual(await within(DROP_MS + 3_000, "the sign-in's end", claude.startClaudeLogin(left.m.cli, left.login, { path: left.m.path, display: {}, platform: 'darwin' }).ended), { end: 'exited', code: 0, signal: null }));
  assert.equal(left.unknownThere(), false, `the sign-in inside the back-off deleted the item under "unknown": items ${JSON.stringify(keychain(left.m))}`);
});

// The item a sign-in left under "unknown" holds a refresh token. After a sign-out every status check reads signed out,
// so no later check drops it: the sign-out does, at AgentRun's own folder, whether or not a drop was tried before, and
// back-off or none, since a person asked. A delete that hangs holds the sign-out's answer up to its limit, no longer.
const SIGN_OUT_AFTER = {
  'no drop tried before': async () => {},
  'a status check whose delete was killed, inside the back-off': async (left) => {
    await killedDelete(left, () => Date.now());
    left.answering();
  },
};
for (const [before, act] of Object.entries(SIGN_OUT_AFTER)) {
  test(`on macOS the sign-out at AgentRun's own folder deletes the item a sign-in left under "unknown" as well as the person's own (${before})`, { skip }, async () => {
    const left = leftUnknown();
    await act(left);
    assert.deepEqual(await asServerOf(left.m, () => claude.claudeLogout(left.m.cli, left.login, { path: left.m.path, platform: 'darwin' })), { signedOut: true, leftoverGone: true }, `${before}: the CLI confirmed its sign-out, and the answer says the item under "unknown" went`);
    assert.equal(left.unknownThere(), false, `${before}: the sign-out deleted the item under "unknown": items ${JSON.stringify(keychain(left.m))}`);
    assert.equal(left.m.items(), 0, `${before}: no Keychain item is left after the sign-out`);
  });
}

test('on macOS a sign-out whose delete of the "unknown" item hangs still answers once that delete is killed at its limit', { skip }, async () => {
  const left = leftUnknown();
  left.hanging();
  try {
    assert.deepEqual(await within(DROP_MS + 3_000, "the sign-out's answer", asServerOf(left.m, () => claude.claudeLogout(left.m.cli, left.login, { path: left.m.path, platform: 'darwin' }))), { signedOut: true, leftoverGone: false }, 'the CLI confirmed its sign-out, and the answer says the item under "unknown" may remain');
    assert.equal(left.hung(), 1, 'the sign-out asked for the delete under "unknown"');
  } finally {
    endHung(left.m);
  }
  assert.ok(left.unknownThere(), 'the killed delete left the item under "unknown"');
  assert.equal(left.m.items(), 1, "the person's own item went with the CLI's sign-out");
});

/** A `security` whose delete under "unknown" waits until the test lets it go (a file `release` beside it), then fails
 *  with an answer that is neither "deleted" (0) nor "not found" (44), as a keychain that refuses the delete does. Each
 *  such delete writes its pid, as HANGING's do, and gives up by itself after a minute. Every other command is
 *  SECURITY's. */
const HELD = `#!${process.execPath}
if (process.argv[2] === 'delete-generic-password' && process.argv.includes('unknown')) {
  const fs = require('node:fs'), path = require('node:path');
  fs.appendFileSync(path.join(__dirname, 'hung.pids'), process.pid + '\\n');
  setInterval(() => { if (fs.existsSync(path.join(__dirname, 'release'))) process.exit(1); }, 20);
  setTimeout(() => process.exit(1), 60_000);
} else {
${SECURITY.slice(SECURITY.indexOf('\n') + 1)}
}
`;
/** Lets HELD's waiting deletes in `m` go: each then fails. */
const release = (m) => writeFileSync(join(m.bin, 'release'), '');
/** Waits until `done()` holds, 10 s at most. */
async function until(done, what) {
  const end = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(`not within 10 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A sign-out that arrives while a status check's delete of the "unknown" item runs waits on that delete rather than
// starting a second one beside it. Where that delete leaves the item (it failed, or it was killed at its limit), the
// sign-out asks once more itself: after it no status check reads signed in, so none would ask again. Here `security`
// answers again by the time the sign-out asks.
const JOINED = {
  // The status check's delete fails once the sign-out waits on it: the CLI's own sign-out has deleted the person's item,
  // and a second more lets the sign-out reach the delete it joins.
  'fails': {
    security: HELD,
    end: async (left) => {
      await until(() => left.m.deleted().some(([, account]) => account === KEYCHAIN_ACCOUNT), "the CLI's own sign-out deleted the person's item");
      await pause(1_000);
      release(left.m);
    },
  },
  // The status check's delete hangs and is killed at its limit, DROP_MS after it started, long after the sign-out joined.
  'is killed at its limit': { security: HANGING, end: async () => {} },
};
for (const [how, joined] of Object.entries(JOINED)) {
  test(`on macOS a sign-out that arrives while a status check's delete of the "unknown" item runs, a delete that ${how}, asks once more itself, and the item goes`, { skip }, async () => {
    const left = leftUnknown();
    writeFileSync(join(left.m.bin, 'security'), joined.security, { mode: 0o755 });
    try {
      const checking = status(left.m, left.login);
      await until(() => left.hung() === 1, "the status check's delete under \"unknown\" started");
      left.answering();
      const signingOut = asServerOf(left.m, () => claude.claudeLogout(left.m.cli, left.login, { path: left.m.path, platform: 'darwin' }));
      await joined.end(left);
      assert.equal((await within(DROP_MS + 3_000, 'the status check', checking)).signedIn, true, 'the status check reads signed in');
      assert.deepEqual(await within(DROP_MS + 5_000, "the sign-out's answer", signingOut), { signedOut: true, leftoverGone: true }, 'the CLI confirmed its sign-out, and the answer says the item under "unknown" went');
      assert.equal(left.hung(), 1, `the delete ${how} was the status check's alone`);
      assert.equal(left.unknownThere(), false, `the sign-out asked once more and deleted the item under "unknown" the joined delete left: items ${JSON.stringify(keychain(left.m))}`);
      assert.equal(left.m.deleted().filter(([, account]) => account === 'unknown').length, 1, "the sign-out's own delete under \"unknown\" ran once");
      assert.equal(left.m.items(), 0, 'no Keychain item is left after the sign-out');
    } finally {
      release(left.m);
      endHung(left.m);
    }
  });
}

// The sign-out's answer says whether the item a sign-in left under "unknown" went, beside the CLI's own answer, so serve
// can tell the person when a refresh token may still sit in their login keychain. Values only: no name, no token.
const DROP_ENDS = {
  'deletes it': { security: SECURITY, gone: true },
  'fails': { security: HELD, gone: false },
};
for (const [how, drop] of Object.entries(DROP_ENDS)) {
  test(`on macOS the sign-out at AgentRun's own folder whose delete of the item a sign-in left under "unknown" ${how} answers that the item ${drop.gone ? 'went' : 'may remain'}`, { skip }, async () => {
    const left = leftUnknown();
    writeFileSync(join(left.m.bin, 'security'), drop.security, { mode: 0o755 });
    // HELD's delete fails at once.
    release(left.m);
    try {
      const out = await within(DROP_MS + 3_000, "the sign-out's answer", asServerOf(left.m, () => claude.claudeLogout(left.m.cli, left.login, { path: left.m.path, platform: 'darwin' })));
      assert.deepEqual(out, { signedOut: true, leftoverGone: drop.gone }, `the answer after a delete that ${how}`);
      assert.equal(left.unknownThere(), !drop.gone, `the item under "unknown" ${drop.gone ? 'went' : 'stayed'}: items ${JSON.stringify(keychain(left.m))}`);
    } finally {
      endHung(left.m);
    }
  });
}

// Only a call a person made asks once more. A status check that arrives while another's delete runs waits on that one,
// and where it fails asks no more itself: status checks ask again only after the back-off.
test('on macOS a status check that arrives while another\'s delete of the "unknown" item runs waits on it, and when that delete fails starts none of its own', { skip }, async () => {
  const left = leftUnknown();
  writeFileSync(join(left.m.bin, 'security'), HELD, { mode: 0o755 });
  try {
    const first = status(left.m, left.login);
    await until(() => left.hung() === 1, "the first status check's delete under \"unknown\" started");
    const read = left.m.asked().length;
    const second = status(left.m, left.login);
    await until(() => left.m.asked().length > read, "the second status check's CLI read the Keychain");
    await pause(1_000);
    release(left.m);
    const both = await within(DROP_MS + 3_000, 'the two status checks', Promise.all([first, second]));
    assert.deepEqual(both.map((each) => each.signedIn), [true, true], 'both status checks read signed in');
    assert.equal(left.hung(), 1, `the status check that waited on the failed delete started ${left.hung() - 1} of its own, not none`);
    assert.ok(left.unknownThere(), 'the failed delete left the item under "unknown"');
  } finally {
    release(left.m);
    endHung(left.m);
  }
});

// Two sign-outs that wait on the same status check's delete share the one more attempt: the first to resume starts it,
// the other joins it. Where that attempt fails too, both answer that the item may remain, after two deletes in all, and
// neither asks again: a person's call asks once more, never in a loop.
test('on macOS two sign-outs that wait on a status check\'s delete of the "unknown" item that fails share one more attempt, and when that fails too both answer that the item may remain, after two deletes in all', { skip }, async () => {
  const left = leftUnknown();
  writeFileSync(join(left.m.bin, 'security'), HELD, { mode: 0o755 });
  const signOut = () => asServerOf(left.m, () => claude.claudeLogout(left.m.cli, left.login, { path: left.m.path, platform: 'darwin' }));
  /** How many times the CLI's own sign-out has asked to delete the person's item. */
  const cliDeletes = () => left.m.deleted().filter(([, account]) => account === KEYCHAIN_ACCOUNT).length;
  try {
    const checking = status(left.m, left.login);
    await until(() => left.hung() === 1, "the status check's delete under \"unknown\" started");
    // One sign-out after the other, so the two CLI sign-outs never write the one keychain file at once; both then wait on
    // the status check's delete, which HELD holds until the release.
    const first = signOut();
    await until(() => cliDeletes() === 1 && left.m.items() === 1, "the first sign-out's CLI deleted the person's item");
    await pause(500);
    const second = signOut();
    await until(() => cliDeletes() === 2, "the second sign-out's CLI asked to delete the person's item");
    await pause(1_000);
    assert.equal(left.hung(), 1, 'both sign-outs wait on the status check\'s delete and start none beside it');
    // The held delete fails, and so does every later one: the release stays.
    release(left.m);
    assert.equal((await within(DROP_MS + 3_000, 'the status check', checking)).signedIn, true, 'the status check reads signed in');
    const both = await within(DROP_MS + 3_000, 'the two sign-outs', Promise.all([first, second]));
    assert.deepEqual(both, [{ signedOut: true, leftoverGone: false }, { signedOut: true, leftoverGone: false }], 'both CLIs confirmed their sign-out, and both answers say the item under "unknown" may remain');
    assert.equal(left.hung(), 2, `the two sign-outs started ${left.hung() - 1} more deletes under "unknown" between them, not one`);
    await pause(500);
    assert.equal(left.hung(), 2, 'no delete under "unknown" starts after both answered');
    assert.ok(left.unknownThere(), 'the failed deletes left the item under "unknown"');
    assert.equal(left.m.items(), 1, "the person's own item went with the CLI's sign-out, and only the item under \"unknown\" is left");
  } finally {
    release(left.m);
    endHung(left.m);
  }
});

// The words a person gets where that item may remain name it by its service, so they never point at another login's
// item under "unknown" (the person's own CLI's has no suffix). The drop deletes by the same service.
test('on macOS the Keychain service the harness names for AgentRun\'s own folder is the one the sign-in left its item under "unknown" with, suffixed, and none for the CLI\'s default folder', { skip }, async () => {
  const left = leftUnknown();
  const [service] = keychain(left.m).filter(([account]) => account === 'unknown').map(([, of]) => of);
  assert.match(service, /^Claude Code-credentials-[0-9a-f]{8}$/, 'the item under "unknown" has the suffixed service');
  assert.equal(claude.claudeKeychainService(left.login), service, 'the harness names the service the item under "unknown" has');
  assert.equal(claude.claudeKeychainService(PLACES["this machine's login on the CLI's default folder"](left.m)), undefined, "the CLI's default folder's item has no suffix, and the harness names none for it");
});

// The CLI hashes the credentials dir in Unicode's composed form (NFC). A folder whose path holds a decomposed character
// (NFD: "e" and a combining acute accent, as a folder name from macOS's Finder may have) names the same item as the
// composed one. A delete by the decomposed form's hash finds nothing ("not found", 44), so the sign-out would answer
// the item gone while it stays.
const COMPOSED = 'Café';
const DECOMPOSED = 'Café';
/** AgentRun's own folder, under the folder `name` in the person's home. */
const ownUnder = (name) => (m) => ({ dir: join(m.home, name, 'claude-login'), profiles: join(m.home, name, 'claude-login', 'anthropic'), userHome: m.home, own: true });
/** The service the CLI names for a credentials dir `folder` that is already in its composed form. */
const serviceOf = (folder) => `Claude Code-credentials-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`;

test('on macOS the Keychain service the harness names for a folder whose path has a decomposed character is the one the CLI names, from the composed form', { skip }, async () => {
  const m = mac();
  const decomposed = ownUnder(DECOMPOSED)(m);
  const composed = ownUnder(COMPOSED)(m);
  assert.notEqual(decomposed.dir, composed.dir, 'the two paths differ as strings');
  assert.equal(decomposed.dir.normalize('NFC'), composed.dir, 'the composed form of the one is the other');
  assert.notEqual(serviceOf(decomposed.dir), serviceOf(composed.dir), 'the decomposed path as written hashes to another service');
  assert.equal(claude.claudeKeychainService(decomposed), claude.claudeKeychainService(composed), 'the harness names one service for both forms');
  assert.equal(claude.claudeKeychainService(decomposed), serviceOf(composed.dir), 'that service is the hash of the composed form, as the CLI names it');
});

/** A `security` that notes the service of each delete under "unknown" (unknown-services.jsonl beside it), then fails it
 *  (`fails`) or answers it as SECURITY does. Every other command is SECURITY's. */
const noting = (fails) => `#!${process.execPath}
if (process.argv[2] === 'delete-generic-password' && process.argv.includes('unknown')) {
  const args = process.argv.slice(3);
  require('node:fs').appendFileSync(require('node:path').join(__dirname, 'unknown-services.jsonl'), JSON.stringify(args[args.indexOf('-s') + 1]) + '\\n');
  ${fails ? 'process.exit(1);' : ''}
}
${SECURITY.slice(SECURITY.indexOf('\n') + 1)}
`;
const DECOMPOSED_DROP = {
  'deletes it': { fails: false, gone: true },
  'fails': { fails: true, gone: false },
};
for (const [how, drop] of Object.entries(DECOMPOSED_DROP)) {
  test(`on macOS the sign-out at AgentRun's own folder under a path with a decomposed character deletes under "unknown" by the service the CLI names, and when that delete ${how} answers that the item ${drop.gone ? 'went' : 'may remain'}`, { skip }, async () => {
    const left = leftUnknown(ownUnder(DECOMPOSED));
    const service = serviceOf(left.login.dir.normalize('NFC'));
    assert.deepEqual(keychain(left.m).filter(([account]) => account === 'unknown').map(([, of]) => of), [service], 'the sign-in with no USER left its item under "unknown" with the service of the composed form');
    writeFileSync(join(left.m.bin, 'security'), noting(drop.fails), { mode: 0o755 });
    const out = await within(DROP_MS + 3_000, "the sign-out's answer", asServerOf(left.m, () => claude.claudeLogout(left.m.cli, left.login, { path: left.m.path, platform: 'darwin' })));
    assert.equal(out.leftoverGone, !left.unknownThere(), `the answer says the item under "unknown" went only where it is gone: leftoverGone ${out.leftoverGone}, items ${JSON.stringify(keychain(left.m))}`);
    const services = readFileSync(join(left.m.bin, 'unknown-services.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(services, [service], 'the sign-out deleted under "unknown" by the service the CLI names, from the composed form');
    assert.deepEqual(out, { signedOut: true, leftoverGone: drop.gone }, `the CLI confirmed its sign-out, and the answer after a delete that ${how}`);
    assert.equal(left.unknownThere(), !drop.gone, `the item under "unknown" ${drop.gone ? 'went' : 'stayed'}: items ${JSON.stringify(keychain(left.m))}`);
    assert.equal(left.m.items(), drop.gone ? 0 : 1, "the person's own item went with the CLI's sign-out");
  });
}
