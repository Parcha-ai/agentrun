// The CLI's own sign-in this host starts (login.ts startClaudeLogin): it runs with the variables of the line a person runs
// (loginCommand), both from one function (signInEnv), so `auth login` writes the account it signed in to the login's own
// folder and not to a temporary one; and it says how it ended (signed in, ended at its limit, stopped, never started).
// A stand-in CLI notes what it was started with beside itself. The harness's new names are read off the module at run
// time, so a build without them fails on the assertion that needs them, not at the import.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as claude from '@parcha/agentrun-harness-claude';

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
  const at = login();
  const home = scratch();
  const fake = fakeCli();
  claude.startClaudeLogin(fake.cli, at, { home, display: { DISPLAY: ':42', ANTHROPIC_API_KEY: 'not-a-secret' } });
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
    const signIn = claude.startClaudeLogin(fake?.cli ?? join(scratch(), 'no-such-cli'), at, { home: scratch(), ...options });
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
