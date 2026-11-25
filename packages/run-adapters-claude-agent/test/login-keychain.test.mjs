// A login on macOS, from sign-in to run, against stand-ins that keep the pinned CLI's rules there (2.1.286, read from its
// macOS build; login-places.test.mjs lists them). The CLI keeps its tokens in a Keychain item, read and written through
// `security`, and macOS keeps the login keychain under the user's home. So a sign-in, the status check and a run agree on
// a login only when all three run in the person's home and name the same item: a status check in a home of its own read
// "not signed in" after every sign-in, and its runs were refused. CI has no macOS, so these stand-ins are what holds it:
// - `security`: one keychain file, `$HOME/Library/Keychains/login.keychain-db`. In a home without one it finds and keeps
//   nothing.
// - `claude`: `auth login` keeps a token in the item the pinned CLI would name and writes the account file; `auth status`
//   says whether it finds that item. It has no plaintext fallback: a sign-in that reaches no keychain fails.
//   The item's account is the pinned CLI's too: `$USER`, else `os.userInfo().username`. That CLI is a Bun binary, and
//   Bun's userInfo reads `$USER` as well, and says "unknown" without it (Node's reads the user database): so a CLI
//   started with no USER saves and reads its tokens under the account "unknown", where a terminal's `claude`, which has
//   USER, never looks. A name outside [A-Za-z0-9._-] is "claude-code-user".
// `security` notes the command and account of every read and write beside itself (asked.jsonl), and of every delete
// apart (deleted.jsonl). A delete with no account takes the service's first item of any account, as macOS's does.
// The stand-ins lead every PATH here and every home is a temporary one, so no real Keychain or login is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
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
const item = 'Claude Code-credentials' + (bare ? '' : '-' + createHash('sha256').update(secure !== undefined ? secure : configDir).digest('hex').slice(0, 8));
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
  return {
    bin, cli: join(bin, 'claude'), home, path, terminal: { PATH: path, HOME: home, USER: ACCOUNT, LOGNAME: ACCOUNT },
    items: () => Object.keys(JSON.parse(readFileSync(join(home, 'Library', 'Keychains', 'login.keychain-db'), 'utf8'))).length,
    /** Each `security` call so far, as [command, account]. */
    asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
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

/** The status check as serve asks it: the server's PATH, and no home but the server's own. */
const status = (m, login) => claude.claudeLoginStatus(m.cli, login, { path: m.path, platform: 'darwin' });

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
      assert.equal(await claude.claudeLogout(m.cli, login, { path: m.path, platform: 'darwin' }), true, `${place}: the CLI confirmed its sign-out`);
      assert.equal(m.items(), 0, `${place}: no Keychain item is left after the sign-out`);
      assert.deepEqual(await status(m, login), { signedIn: false, method: 'none' }, `${place}: the status check after the sign-out`);
      assert.equal(runSays(m, login), false, `${place}: a run after the sign-out`);
    });
  }
});

test("the CLI's own sign-out says false, never throws, when the CLI fails it, is no program, or outlasts its limit", { skip }, async () => {
  assert.equal(typeof claude.claudeLogout, 'function', "the harness has the CLI's own sign-out");
  const m = mac();
  const login = PLACES["AgentRun's own folder"](m);
  const failing = join(m.bin, 'claude-fails');
  writeFileSync(failing, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const hangs = join(m.bin, 'claude-hangs');
  writeFileSync(hangs, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  await asServerOf(m, async () => {
    assert.equal(await claude.claudeLogout(failing, login, { path: m.path }), false, 'a CLI that exits 1');
    assert.equal(await claude.claudeLogout(join(m.bin, 'no-such-claude'), login, { path: m.path }), false, 'no program at the path');
    const started = Date.now();
    assert.equal(await claude.claudeLogout(hangs, login, { path: m.path, timeoutMs: 200 }), false, 'a CLI past its limit');
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
