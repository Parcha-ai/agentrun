// A native Claude Code runtime on macOS, against stand-ins that keep the pinned CLI's Keychain rules there (the claude
// harness's login-keychain.test.mjs has the same). Serve starts the person's own `claude` with the server's environment
// (nativeEnvironment), for the check (`auth status`, discovery.ts nativeMetadata) and for a turn (runtime.ts). The CLI
// names its Keychain item's account by `$USER`, else by its runtime's `os.userInfo().username`; it is a Bun binary, and
// Bun's userInfo reads `$USER` too: "unknown" with none, "" with an empty one (a name outside [A-Za-z0-9._-] is
// "claude-code-user"). So a server started with no USER (a launchd service) would read the person's login under
// "unknown", where their terminal's `claude` saved it: the check reads signed out and every turn is refused. A USER the
// server has is the person's own shell's, and stays.
// - `security`: one keychain file, `$HOME/Library/Keychains/login.keychain-db`; it notes the command and account of
//   every call beside itself (asked.jsonl).
// - `claude`: `auth login` saves a token in the item under the account above, `auth status --json` says whether it finds
//   it there, and a `--print` turn answers only when it does. It notes the USER and LOGNAME it was started with
//   (started.jsonl).
// The stand-ins lead every PATH here and every home is a temporary one, so no real Keychain or login is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { discoverNative, verifyNative } from '../dist/native/discovery.js';
import { openNativeSession } from '../dist/native/runtime.js';

const skip = process.platform === 'win32' ? 'the stand-ins are POSIX scripts' : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-native-keychain-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

const SECURITY = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.HOME ?? '', 'Library', 'Keychains', 'login.keychain-db');
const [command, ...args] = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(path.join(__dirname, 'asked.jsonl'), JSON.stringify([command, flag('-a')]) + '\\n');
if (!fs.existsSync(file)) process.exit(command === 'add-generic-password' ? 50 : 44);
const items = JSON.parse(fs.readFileSync(file, 'utf8'));
const key = JSON.stringify([flag('-a'), flag('-s')]);
if (command === 'find-generic-password') {
  if (!(key in items)) process.exit(44);
  console.log(items[key]);
} else if (command === 'add-generic-password') {
  items[key] = Buffer.from(flag('-X'), 'hex').toString('utf8');
  fs.writeFileSync(file, JSON.stringify(items));
} else process.exit(2);
`;

const CLI = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = process.env, args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'started.jsonl'), JSON.stringify({ args, USER: env.USER ?? null, LOGNAME: env.LOGNAME ?? null }) + '\\n');
const bunUsername = env.USER ?? 'unknown';
const named = env.USER || bunUsername;
const user = /^[a-zA-Z0-9._-]+$/.test(named) ? named : 'claude-code-user';
const item = 'Claude Code-credentials';
const signedIn = () => {
  const found = spawnSync('security', ['find-generic-password', '-a', user, '-w', '-s', item], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim() !== '';
};
if (args[0] === '--version') { console.log('2.1.322 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'login') {
  const tokens = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } })).toString('hex');
  process.exit(spawnSync('security', ['add-generic-password', '-U', '-a', user, '-s', item, '-X', tokens]).status === 0 ? 0 : 1);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const yes = signedIn();
  console.log(JSON.stringify(yes ? { loggedIn: true, authMethod: 'claude.ai' } : { loggedIn: false, authMethod: 'none' }));
  process.exit(yes ? 0 : 1);
}
if (args.includes('--print')) {
  fs.readFileSync(0, 'utf8');
  if (!signedIn()) { console.error('Not logged in · Please run /login'); process.exit(1); }
  const session_id = '33333333-3333-4333-8333-333333333333';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id, model: 'native-claude' }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'signed in' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id, result: 'signed in', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, permission_denials: [] }));
  process.exit(0);
}
process.exit(2);
`;

const lines = (file) => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/** A Mac's person, signed in from their terminal (USER `terminal`), and a server environment of the PATH, the home and
 *  `server` alone. */
function place(terminal, server) {
  const root = mkdtempSync(join(ROOT, `t${n++}-`));
  const home = join(root, 'home'), project = join(root, 'project'), bin = join(root, 'bin');
  for (const dir of [join(home, 'Library', 'Keychains'), project, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'Library', 'Keychains', 'login.keychain-db'), '{}');
  writeFileSync(join(bin, 'security'), SECURITY, { mode: 0o755 });
  writeFileSync(join(bin, 'claude'), CLI, { mode: 0o755 });
  const PATH = [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const login = spawnSync(join(bin, 'claude'), ['auth', 'login'], { env: { PATH, HOME: home, USER: terminal, LOGNAME: terminal } });
  assert.equal(login.status, 0, 'the terminal sign-in saved its item');
  const signedIn = lines(join(bin, 'asked.jsonl')).length, started = lines(join(bin, 'started.jsonl')).length;
  return {
    project,
    env: { PATH, HOME: home, ...server },
    // What serve's own starts of the CLI asked of the Keychain, and the USER and LOGNAME they had.
    asked: () => lines(join(bin, 'asked.jsonl')).slice(signedIn).map(([, account]) => account),
    started: () => lines(join(bin, 'started.jsonl')).slice(started).map(({ args, USER, LOGNAME }) => [args[0], USER, LOGNAME]),
  };
}

const me = userInfo().username;

const rows = [
  ['the server has no USER or LOGNAME (a launchd service)', me, {}, { USER: me, LOGNAME: me }],
  ['the server has an empty USER and LOGNAME', me, { USER: '', LOGNAME: '' }, { USER: me, LOGNAME: me }],
  ['the server has another USER and no LOGNAME (the person\'s own shell)', 'someone-else', { USER: 'someone-else' }, { USER: 'someone-else', LOGNAME: me }],
];
for (const [label, terminal, server, user] of rows) {
  test(`a native Claude runtime's check and turn read the person's Keychain item under the OS user only where the server has no USER: ${label}`, { skip }, async () => {
    const at = place(terminal, server);
    const target = (await discoverNative({ project: at.project, runtime: 'claude-code', env: at.env })).targets[0];
    assert.ok(target, `${label}: discovery found the claude runtime`);
    const verified = await verifyNative(target, { env: at.env });
    assert.equal(verified.state, 'ready', `${label}: the check read the person's login signed out, asking the Keychain under ${JSON.stringify(at.asked())}`);
    const session = await openNativeSession({ target: verified, env: at.env });
    let outcome;
    try {
      outcome = await session.send('hello', { timeoutMs: 60_000 }).then((result) => result.answer, (error) => `refused: ${error.message}`);
    } finally {
      await session.close();
    }
    assert.equal(outcome, 'signed in', `${label}: a turn on the person's login, asking the Keychain under ${JSON.stringify(at.asked())}`);
    assert.deepEqual([...new Set(at.asked())], [user.USER], `${label}: every Keychain read was under the account ${user.USER}`);
    assert.deepEqual(
      at.started(),
      at.started().map(([command]) => [command, user.USER, user.LOGNAME]),
      `${label}: every claude serve started (--version, auth, --print) had USER ${user.USER} and LOGNAME ${user.LOGNAME}`,
    );
    assert.deepEqual(at.started().map(([command]) => command), ['--version', '--version', 'auth', '--print'], `${label}: the starts`);
  });
}
