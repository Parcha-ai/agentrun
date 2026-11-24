// The CLI's own sign-in this host starts (login.ts startClaudeLogin): it runs with the variables of the line a person runs
// (loginCommand), both from one function (signInEnv), so `auth login` writes the account it signed in to the login's own
// folder and not to a temporary one; and it says how it ended (signed in, ended at its limit, stopped, never started).
// A stand-in CLI notes what it was started with beside itself. The harness's new names are read off the module at run
// time, so a build without them fails on the assertion that needs them, not at the import.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as claude from '@parcha/agentrun-harness-claude';
import { parentWatchHere } from '@parcha/agentrun-kernel/host';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-sign-in-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
/** What never reaches the CLI's sign-in. */
const TOKENS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** A stand-in CLI that writes its arguments and environment to seen.json beside itself, then exits `code`, or, with
 *  `waits`, stays until it is ended (20 s at most). */
function fakeCli({ code = 0, waits = false } = {}) {
  const dir = scratch();
  const cli = join(dir, 'claude');
  const seen = join(dir, 'seen.json');
  writeFileSync(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n${waits ? 'setTimeout(() => process.exit(0), 20000);' : `process.exit(${code});`}\n`, { mode: 0o755 });
  return { cli, seen: () => (existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) : undefined) };
}

/** Waits until `done()` holds, 10 s at most. */
async function until(done, what) {
  const end = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`not within 10 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The `NAME=value` words that lead the shown line, as variables (the test's paths need no quoting). */
const commandVars = (line) => Object.fromEntries(line.split(' ').filter((word) => /^[A-Z_]+=/.test(word)).map((word) => [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]));

function login() {
  const base = scratch();
  const at = { dir: join(base, 'claude-login'), profiles: join(base, 'claude-login', 'anthropic') };
  mkdirSync(at.dir, { recursive: true });
  return at;
}

test("the sign-in this host starts runs with the shown line's own variables: the login's folder as its config dir, never a temporary one", async () => {
  const home = scratch();
  const at = { ...login(), userHome: home };
  const fake = fakeCli();
  claude.startClaudeLogin(fake.cli, at, { display: { DISPLAY: ':42', ANTHROPIC_API_KEY: 'not-a-secret' } });
  await until(() => fake.seen() !== undefined, "the CLI's sign-in started");
  const { argv, env } = fake.seen();
  assert.deepEqual(argv, ['auth', 'login', '--claudeai']);
  const shown = commandVars(claude.claudeLoginCommand(at, fake.cli));
  assert.deepEqual(Object.keys(shown), ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR']);
  assert.deepEqual(Object.fromEntries(Object.keys(shown).map((name) => [name, env[name]])), shown, "the sign-in's variables are the shown line's");
  assert.equal(env.CLAUDE_CONFIG_DIR, at.dir);
  // One function makes them, and the status check takes the same.
  assert.equal(typeof claude.claudeSignInEnv, 'function', 'the harness exports claudeSignInEnv');
  assert.deepEqual(claude.claudeSignInEnv(at), shown);
  // The person's home and desktop, so the CLI opens their browser; no key or token, even one the desktop's env holds.
  assert.equal(env.HOME, home);
  assert.equal(env.DISPLAY, ':42');
  for (const name of TOKENS) assert.equal(env[name], undefined, name);
});

test('a sign-in says how it ended: signed in (exit 0), ended without signing in (its exit code), ended at its limit, stopped, or never started', async () => {
  const at = login();
  const ended = async (options, fake) => {
    const signIn = claude.startClaudeLogin(fake?.cli ?? join(scratch(), 'no-such-cli'), at, options);
    assert.equal(typeof signIn?.ended?.then, 'function', 'startClaudeLogin answers the sign-in it started');
    return signIn;
  };
  assert.deepEqual(await (await ended({}, fakeCli({ code: 0 }))).ended, { end: 'exited', code: 0, signal: null });
  assert.deepEqual(await (await ended({}, fakeCli({ code: 1 }))).ended, { end: 'exited', code: 1, signal: null });
  // A browser no one answers: ended at the limit, which it says apart from every other end.
  const waiting = fakeCli({ waits: true });
  const limited = await ended({ timeoutMs: 200 }, waiting);
  assert.deepEqual(await limited.ended, { end: 'timed_out' });
  assert.ok(waiting.seen(), 'it had started');
  // Ended by the host (a second press, a turn-off).
  const stopping = fakeCli({ waits: true });
  const stopped = await ended({}, stopping);
  await until(() => stopping.seen() !== undefined, 'the second sign-in started');
  stopped.stop();
  assert.deepEqual(await stopped.ended, { end: 'stopped' });
  // A CLI that is not there never starts, in the spawn's words.
  const missing = await (await ended({})).ended;
  assert.equal(missing.end, 'failed');
  assert.match(missing.message, /ENOENT/);
  assert.equal(claude.CLAUDE_SIGN_IN_MS, 10 * 60_000, 'the limit is 10 minutes unless a caller says otherwise');
});

// A server that is SIGKILLed (the OOM killer, say) runs no stop and no limit timer, so a sign-in it started must die
// with it: started under ./host's parent watch (@parcha/agentrun-kernel/host parentWatched), as a session's CLI is. The
// process table is read from /proc, so this runs on Linux.
const linux = process.platform === 'linux' && existsSync('/proc/self/stat');
/** Whether `pid` runs: a zombie (exited, not yet reaped) does not. */
function running(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}
const SERVER = fileURLToPath(new URL('./fixtures/sign-in-host.mjs', import.meta.url));

for (const watch of ['pdeathsig', 'shim']) {
  const skip = !linux ? 'needs /proc' : watch === 'pdeathsig' && parentWatchHere() !== 'pdeathsig' ? 'no setpriv with --pdeathsig here' : false;
  test(`a sign-in dies with the server that started it when that server is SIGKILLed (${watch}), long before its limit`, { skip, timeout: 30_000 }, async (t) => {
    const dir = scratch();
    const cli = join(dir, 'claude');
    const pidFile = join(dir, 'pid');
    // A CLI that waits for a browser no one answers: its own pid noted, then it is `sleep` (the same process).
    writeFileSync(cli, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 300\n`, { mode: 0o755 });
    const server = spawn(process.execPath, [SERVER, cli, login().dir, scratch(), watch], { stdio: ['ignore', 'ignore', 'inherit'] });
    let pid;
    t.after(() => {
      for (const p of [server.pid, pid]) if (p && running(p)) try { process.kill(p, 'SIGKILL'); } catch {}
    });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', "the CLI's sign-in started");
    pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.equal(running(pid), true, 'the sign-in waits');
    server.kill('SIGKILL');
    // The watch's bound: the kernel's signal at once (pdeathsig), or the shim's next look, a quarter second apart.
    const end = Date.now() + 2_000;
    while (running(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(running(pid), false, `the sign-in's CLI (pid ${pid}) still ran 2 s after its server was SIGKILLed`);
  });
}

// A stop (a second press, a turn-off, a PUT that moves the login) or the limit asks the sign-in to go (SIGTERM) and kills
// it 5 s later. Under the shim (macOS, or Linux with no setpriv) the server's child is the shim, not the CLI, so that
// kill reaches the shim alone: a CLI that outlasts the TERM must be killed by the shim first, else it runs on with no
// watch and no limit, holding the browser's port, while the server says the sign-in stopped.
test('a stopped sign-in under the parent-watch shim ends only once its CLI is gone, though the CLI ignores SIGTERM', { skip: !linux ? 'needs /proc' : false, timeout: 30_000 }, async (t) => {
  const dir = scratch();
  const cli = join(dir, 'claude');
  const pidFile = join(dir, 'pid');
  // It ignores TERM (an ignored signal stays ignored across exec), notes its pid once it does, then is `sleep`.
  writeFileSync(cli, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nexec sleep 300\n`, { mode: 0o755 });
  let pid;
  t.after(() => {
    if (pid && running(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  });
  const signIn = claude.startClaudeLogin(cli, { ...login(), userHome: scratch() }, { display: {}, watch: 'shim' });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', "the CLI's sign-in started");
  pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.equal(running(pid), true, 'the sign-in waits');
  const stopped = Date.now();
  signIn.stop();
  assert.deepEqual(await signIn.ended, { end: 'stopped' });
  const end = Date.now() + 1_000;
  while (running(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(running(pid), false, `the stopped sign-in's CLI (pid ${pid}) still ran ${Date.now() - stopped} ms after the stop, though the sign-in had ended`);
});
