// The variables each login place gives the pinned CLI (login.ts), for its status check, its sign-in, the line a person
// runs and a run, and per platform where the CLI's store differs. The CLI's rules (the pinned 2.1.286):
// - credentials dir: `CLAUDE_SECURESTORAGE_CONFIG_DIR` when set (empty: `<home>/.claude`), else the config dir
//   (`CLAUDE_CONFIG_DIR`, else `<home>/.claude`); Linux keeps `.credentials.json` there.
// - macOS Keychain item: "Claude Code-credentials", with `-<sha256(dir)[0:8]>` after it unless the secure-storage variable
//   is set and empty, or both it and `CLAUDE_CONFIG_DIR` are unset; the hashed dir is the secure-storage one when set,
//   else the config dir.
// - the account file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `<home>/.claude.json`.
// So the person's own CLI on its default folder (no variables) keeps its account in `<home>/.claude.json` and, on macOS,
// its tokens in the item with no suffix. A run has a config dir of its own, which would hash that item's name.
// Stand-in CLIs note what they were started with beside themselves.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as claude from '@parcha/agentrun-harness-claude';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-places-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const FOLDER_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR'];

/** A stand-in CLI that writes its arguments and environment to seen.json beside itself and answers a signed-out status.
 *  `sub`: a folder of that name it is kept in. */
function fakeCli(sub) {
  const dir = sub ? join(scratch(), sub) : scratch();
  mkdirSync(dir, { recursive: true });
  const cli = join(dir, 'claude');
  const seen = join(dir, 'seen.json');
  writeFileSync(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ loggedIn: false, authMethod: 'none' }))});\nprocess.exit(1);\n`, { mode: 0o755 });
  return { cli, seen: () => (existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) : undefined) };
}

/** Waits until `done()` holds, 10 s at most. */
async function until(done, what) {
  const end = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(`not within 10 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The `NAME=value` words that lead the shown line, as variables (the test's paths need no quoting). */
const commandVars = (line) => Object.fromEntries(line.split(' ').filter((word) => /^[A-Z_]+=/.test(word)).map((word) => [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]));
/** The folder variables of `env`, unset ones left out. */
const folderVars = (env) => Object.fromEntries(FOLDER_VARS.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));

/** What the CLI got for its status check and its sign-in at `login`, made with the person's home `home` (`userHome`), and
 *  the line shown for it. */
async function cliEnvs(given, home) {
  const login = { ...given, userHome: home };
  const status = fakeCli();
  assert.deepEqual(await claude.claudeLoginStatus(status.cli, login), { signedIn: false, method: 'none' });
  const signIn = fakeCli();
  claude.startClaudeLogin(signIn.cli, login, { display: {} });
  await until(() => signIn.seen() !== undefined, "the CLI's sign-in started");
  return { status: status.seen().env, signIn: signIn.seen().env, shown: commandVars(claude.claudeLoginCommand(login, signIn.cli)), line: claude.claudeLoginCommand(login) };
}

test("AgentRun's own login folder: the sign-in and the shown line use it as the CLI's config dir and credentials dir, the status check as its credentials dir with a copy of its account file as the config dir, the status check and the sign-in in the person's home, and a run its credentials dir on every platform", async () => {
  const base = scratch();
  const login = { dir: join(base, 'claude-login'), profiles: join(base, 'claude-login', 'anthropic') };
  mkdirSync(login.dir, { recursive: true });
  const home = scratch();
  const { status, signIn, shown, line } = await cliEnvs(login, home);
  const own = { CLAUDE_CONFIG_DIR: login.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: login.dir, ANTHROPIC_CONFIG_DIR: login.profiles };
  // The status check: the same credentials and profiles, its config dir a copy (login-status.test.mjs), never the folder.
  assert.notEqual(status.CLAUDE_CONFIG_DIR, login.dir);
  assert.deepEqual(folderVars(status), { ...own, CLAUDE_CONFIG_DIR: status.CLAUDE_CONFIG_DIR });
  // In the person's home, as the sign-in: on macOS the login keychain, where the CLI keeps the tokens, is under it.
  assert.equal(status.HOME, home, "the status check runs in the person's home, as the sign-in does");
  assert.deepEqual(folderVars(signIn), own);
  assert.equal(signIn.HOME, home);
  assert.deepEqual(shown, own);
  assert.equal(line, `CLAUDE_CONFIG_DIR=${login.dir} CLAUDE_SECURESTORAGE_CONFIG_DIR=${login.dir} ANTHROPIC_CONFIG_DIR=${login.profiles} claude auth login`);
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.deepEqual(claude.claudeLoginEnv(login, platform), { CLAUDE_SECURESTORAGE_CONFIG_DIR: login.dir, ANTHROPIC_CONFIG_DIR: login.profiles }, platform);
  }
});

test("this machine's login on the CLI's default folder: the sign-in and the shown line set no folder of the CLI's, in the person's home, as the person's own claude runs; the status check runs in that home too", async () => {
  const home = scratch();
  const login = { dir: join(home, '.claude'), profiles: join(home, '.config', 'anthropic'), home };
  const { status, signIn, shown, line } = await cliEnvs(login, home);
  // No CLAUDE_CONFIG_DIR and no CLAUDE_SECURESTORAGE_CONFIG_DIR: the account in <home>/.claude.json, the tokens in
  // <home>/.claude (Linux) or the Keychain item with no suffix (macOS), as the person's own CLI keeps them. The status
  // check's own variables (a copy of the account file) are login-status.test.mjs's.
  assert.equal(status.HOME, home, "the status check runs in the person's home, where their CLI keeps its tokens");
  assert.deepEqual(folderVars(signIn), { ANTHROPIC_CONFIG_DIR: login.profiles });
  assert.equal(signIn.HOME, home);
  assert.deepEqual(shown, { ANTHROPIC_CONFIG_DIR: login.profiles });
  // The line clears both folder variables, which a person's terminal may export, under env, a program every shell runs.
  assert.equal(line, `env -u CLAUDE_CONFIG_DIR -u CLAUDE_SECURESTORAGE_CONFIG_DIR ANTHROPIC_CONFIG_DIR=${login.profiles} claude auth login`);
});

/** The shells the shown line is run in here, where this machine has them: sh and bash always; zsh, fish and tcsh, which
 *  a person's terminal may run, when installed. */
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish', '/bin/tcsh', '/usr/bin/tcsh'].filter((shell) => existsSync(shell));
/** A terminal that exports both folder variables, with `path` as its PATH. */
const terminal = (home, path) => ({ PATH: path, HOME: home, CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere' });

test("the shown line on the CLI's default folder, run in a terminal that exports CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, starts the CLI with neither, its profiles quoted whole", () => {
  const home = scratch();
  // A folder name the shell must quote: a space and a quote.
  const login = { dir: join(home, '.claude'), profiles: join(home, "it's here", 'anthropic'), home };
  assert.ok(SHELLS.includes('/bin/sh') && SHELLS.includes('/bin/bash'), `sh and bash run the line: ${SHELLS}`);
  for (const shell of SHELLS) {
    const cli = fakeCli();
    const ran = spawnSync(shell, ['-c', claude.claudeLoginCommand(login, cli.cli)], { env: terminal(home, process.env.PATH ?? '/usr/bin:/bin') });
    const seen = cli.seen();
    assert.ok(seen, `${shell} started the CLI: ${ran.stderr}`);
    assert.deepEqual(folderVars(seen.env), { ANTHROPIC_CONFIG_DIR: login.profiles }, shell);
    assert.deepEqual(seen.argv, ['auth', 'login'], shell);
  }
});

test("the shown line on the CLI's default folder starts a CLI kept in a folder whose name holds '=' (a data folder such as /data/a=b), with neither folder variable", () => {
  const home = scratch();
  const login = { dir: join(home, '.claude'), profiles: join(home, '.config', 'anthropic'), home };
  assert.ok(SHELLS.includes('/bin/sh') && SHELLS.includes('/bin/bash'), `sh and bash run the line: ${SHELLS}`);
  for (const shell of SHELLS) {
    // env reads any word holding '=' as a variable, so such a CLI path must not be a word env reads.
    const cli = fakeCli('a=b');
    const ran = spawnSync(shell, ['-c', claude.claudeLoginCommand(login, cli.cli)], { env: terminal(home, process.env.PATH ?? '/usr/bin:/bin') });
    const seen = cli.seen();
    assert.ok(seen, `${shell} started the CLI in a folder named a=b: ${ran.stderr}`);
    assert.deepEqual(folderVars(seen.env), { ANTHROPIC_CONFIG_DIR: login.profiles }, shell);
    assert.deepEqual(seen.argv, ['auth', 'login'], shell);
  }
});

/** `line` with every single-quoted part taken out, and each `'\''` (a quote inside one, which sh, fish and tcsh all read
 *  as a quote): what a shell reads as its own syntax. */
const unquoted = (line) => line.replace(/'\\''/g, '').replace(/'[^']*'/g, '');

// fish has no `( ... )` subshell (a syntax error there) and no `NAME=value cmd` before 3.1; tcsh has neither. A line
// that is env's from its first word, with nothing else a shell reads as syntax outside its quotes, is read alike by sh,
// bash, zsh, fish and tcsh. What it does not cover: a `claude` alias or function, which env skips (the shown CLI is the
// pinned one, or `claude` on PATH).
test("the shown line on the CLI's default folder is one sh, bash, zsh, fish and tcsh all read alike: env's from its first word, with no subshell, `;`, `&`, `|`, redirection, `$`, glob or history mark outside its quotes, a CLI path holding '=' included", () => {
  const home = scratch();
  const login = { dir: join(home, '.claude'), profiles: join(home, "it's here", 'anthropic'), home };
  const secure = { ...login, secure: join(home, 'creds') };
  for (const [what, line] of [['the bare CLI', claude.claudeLoginCommand(login)], ['a CLI path', claude.claudeLoginCommand(login, '/opt/claude/bin/claude')], ['a CLI path holding =', claude.claudeLoginCommand(login, '/data/a=b/claude')], ['a credentials folder set apart', claude.claudeLoginCommand(secure, '/opt/claude/bin/claude')]]) {
    assert.match(line, /^env -u CLAUDE_CONFIG_DIR /, `${what}: the line is env's from its first word: ${line}`);
    assert.doesNotMatch(unquoted(line), /[()`;&|<>$*?[\]{}~!\\"]/, `${what}: nothing outside its quotes is syntax fish or tcsh reads apart: ${line}`);
  }
});

test("a run on this machine's login on the CLI's default folder reaches the person's own store: on macOS an empty credentials dir (the Keychain item with no suffix), elsewhere the folder's credentials file", () => {
  const home = '/u/p';
  const login = { dir: '/u/p/.claude', profiles: '/u/p/.config/anthropic', home };
  // A run's config dir is its own, so leaving the variable unset would hash that dir into the Keychain item's name.
  assert.deepEqual(claude.claudeLoginEnv(login, 'darwin'), { CLAUDE_SECURESTORAGE_CONFIG_DIR: '', ANTHROPIC_CONFIG_DIR: login.profiles });
  assert.deepEqual(claude.claudeLoginEnv(login, 'linux'), { CLAUDE_SECURESTORAGE_CONFIG_DIR: login.dir, ANTHROPIC_CONFIG_DIR: login.profiles });
  assert.deepEqual(claude.claudeLoginEnv(login, 'win32'), { CLAUDE_SECURESTORAGE_CONFIG_DIR: login.dir, ANTHROPIC_CONFIG_DIR: login.profiles });
});

test("this machine's login in a CLAUDE_CONFIG_DIR folder: every use names that folder as credentials dir, and every use but the status check (which runs on a copy of its account file) as config dir, which is where the person's own claude with that variable keeps both, on every platform", async () => {
  const folder = scratch();
  const login = { dir: folder, profiles: '/u/p/.config/anthropic' };
  const home = scratch();
  const { status, signIn, shown, line } = await cliEnvs(login, home);
  // The person's CLI with CLAUDE_CONFIG_DIR=<folder>: credentials dir <folder> (Linux), Keychain item hashed from
  // <folder> (macOS), account <folder>/.claude.json. The credentials dir set to <folder> gives the same item and file.
  const own = { CLAUDE_CONFIG_DIR: folder, CLAUDE_SECURESTORAGE_CONFIG_DIR: folder, ANTHROPIC_CONFIG_DIR: login.profiles };
  assert.notEqual(status.CLAUDE_CONFIG_DIR, folder);
  assert.deepEqual(folderVars(status), { ...own, CLAUDE_CONFIG_DIR: status.CLAUDE_CONFIG_DIR });
  assert.deepEqual(folderVars(signIn), own);
  assert.deepEqual(shown, own);
  assert.equal(line, `CLAUDE_CONFIG_DIR=${folder} CLAUDE_SECURESTORAGE_CONFIG_DIR=${folder} ANTHROPIC_CONFIG_DIR=${login.profiles} claude auth login`);
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(claude.claudeLoginEnv(login, platform), { CLAUDE_SECURESTORAGE_CONFIG_DIR: folder, ANTHROPIC_CONFIG_DIR: login.profiles }, platform);
  }
});
