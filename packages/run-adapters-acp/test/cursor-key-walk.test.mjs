// Cursor's key walk: the guard under its credential design. cursor.json names `.config/cursor/auth.json` a credential,
// so each start makes that path a folder Cursor cannot write, and Cursor 2026.11.13 goes on with the key in its env when
// its save fails. That rests on Cursor tolerating the failed save: a release that saves the key, or a token it gets for
// it, anywhere else would leave it on disk past the session. The walk runs a session, ends a turn, kills the agent hard
// mid-turn (no dispose), closes, and at each point counts the files under the session folder (its HOME, tmp and state)
// that hold the key, the key in base64, or a JWT-shaped token. It counts; it never prints, logs or keeps what it found.
//   - In CI, on the fake agent: one that writes the key, its base64 or a token past the credential folder goes red, and
//     one that behaves as Cursor does stays green.
//   - On the real Cursor (AGENTRUN_TEST_CURSOR names the folder holding its dist-package, CURSOR_API_KEY is the owner's,
//     AGENTRUN_TEST_CURSOR_LIVE=1 says to spend a few cents): green, and with AGENTRUN_RECORD_CURSOR_WALK=1 the pin it
//     walked is recorded in cursor-walk.json. AGENTRUN_TEST_CURSOR_PLANT=<path under HOME> writes the key there after
//     the start, as a release that saves it would, to see the guard go red on the real binary.
//   - In CI: cursor-walk.json names the digests CURSOR_PIN pins, so a new Cursor pin is red until this walk ran on it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acpPlatform, CURSOR_PIN, cursorAdapter } from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch, until } from './helpers.mjs';

const RECORD = fileURLToPath(new URL('./cursor-walk.json', import.meta.url));
const sha = (text) => createHash('sha256').update(text).digest('hex');
/** The private HOME the adapter makes for session `s1` under `sessionsDir`. */
const homeOf = (sessionsDir) => join(sessionsDir, sha('s1').slice(0, 32), 'home');
/** Three base64url segments, the first a JSON object's start: an access or refresh token's shape. */
const TOKEN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/** Every regular file under `dir`, links not followed. */
function filesUnder(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st?.isDirectory()) filesUnder(path, found);
    else if (st?.isFile()) found.push(path);
  }
  return found;
}

/** How many files under `root` hold `key` (as is, or in base64 or base64url) and how many a token-shaped string. Counts
 *  alone: what matched is never returned. */
export function traces(root, key) {
  const forms = [key, Buffer.from(key).toString('base64'), Buffer.from(key).toString('base64url')].map((form) => Buffer.from(form));
  const count = { files: 0, key: 0, token: 0 };
  for (const file of filesUnder(root)) {
    let bytes;
    try { bytes = readFileSync(file); } catch { continue; }
    count.files++;
    if (forms.some((form) => bytes.includes(form))) count.key++;
    if (TOKEN.test(bytes.toString('latin1'))) count.token++;
  }
  return count;
}

/** The processes whose HOME is `home`: the agent the adapter started there and anything it started. Read from /proc,
 *  so Linux alone: the real walk's (Cursor is pinned for linux-x86_64 alone); the fake says its own pid. */
function agentPids(home) {
  const pids = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(`HOME=${home}`)) pids.push(Number(name));
    } catch { /* gone, or not ours */ }
  }
  return pids;
}

/** The walk: a turn, a hard kill mid-turn, the close; the session folder counted after each. `words`: the two turns';
 *  `plant`: a path under HOME the key is written to after the first turn. */
async function walk(t, { recipe, adapter, sessionsDir, key, env, words = ['Answer with the single word OK.', 'Write the numbers from 1 to 400, separated by spaces.'], plant, settle = 30_000, pids: pidsOf = agentPids }) {
  const { session, events } = await openSession(t, recipe, { adapter, sessionsDir, options: { env } });
  const home = homeOf(sessionsDir);
  const at = {};
  await session.send(words[0]);
  const first = await session.turnEnd();
  assert.equal(first.status, 'completed', `the first turn: ${first.status}`);
  if (plant) {
    mkdirSync(dirname(join(home, plant)), { recursive: true });
    writeFileSync(join(home, plant), JSON.stringify({ apiKey: key }));
  }
  at.turn = traces(sessionsDir, key);
  const seen = events.length;
  await session.send(words[1]);
  // Killed once the turn is under way (its first event in), or after `settle` ms: the fake's hanging model says nothing.
  await until(() => events.length > seen, 'the second turn under way', settle).catch(() => {});
  const pids = pidsOf(home);
  assert.ok(pids.length > 0, 'the agent runs under its private HOME');
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  const killed = await session.turnEnd();
  assert.equal(killed.status, 'failed', 'the killed turn fails');
  at.kill = traces(sessionsDir, key);
  await session.close();
  at.close = traces(sessionsDir, key);
  return at;
}

/** The guard: no point of the walk left a file holding the key or a token. Its message says counts, never what matched. */
function noTraces(at) {
  const found = Object.entries(at).filter(([, count]) => count.key > 0 || count.token > 0);
  assert.deepEqual(found.map(([point, count]) => `${point}: ${count.key} files hold the key, ${count.token} a token`), [], 'the session folder holds no key and no token');
}

const KEY = 'fake-test-key-0123456789';
const cursorLike = (dir, fake) => fakeRecipe(dir, { style: 'cursor', announce: 'late', writeAuth: true, script: [{ say: 'OK' }, { hang: true }], ...fake }, { keys: ['CURSOR_API_KEY'], credentials: ['.config/cursor/auth.json'], state: ['.fake-acp'] });
const fakeWalk = (t, fake) => {
  const dir = scratch();
  const recipe = cursorLike(dir, fake);
  // The fake says its own pid at its start: no /proc, so the walk runs wherever the package's tests do.
  const pids = () => fakeEvents(recipe).filter((e) => e.type === 'start').slice(-1).map((e) => e.pid);
  return walk(t, { recipe, sessionsDir: join(dir, 'sessions'), key: KEY, env: { PATH: process.env.PATH, CURSOR_API_KEY: KEY }, settle: 500, pids });
};

for (const [what, leak] of [
  ['the key as is, in a file of its own beside the credential folder', { path: '.local/share/cursor/session.json', what: 'key' }],
  ['the key in base64, deep in its tmp', { path: '../tmp/cursor/blob.txt', what: 'base64' }],
  ['a token it got for the key, in its config folder', { path: '.config/cursor/tokens.json', what: 'token' }],
]) {
  test(`the guard goes red on an agent that saves ${what}, and its words name no secret`, { timeout: 60_000 }, async (t) => {
    const at = await fakeWalk(t, { leak });
    let said;
    assert.throws(() => noTraces(at), (error) => {
      said = String(error.message);
      return true;
    });
    assert.ok(at.turn.key + at.turn.token > 0, 'found while the agent runs');
    assert.ok(at.kill.key + at.kill.token > 0, 'and after a hard kill, when no dispose ran');
    assert.equal(said.includes(KEY) || said.includes(Buffer.from(KEY).toString('base64')), false, 'the guard says counts, never the key');
  });
}

test('the guard stays green on an agent that does as Cursor does: its save fails, and it goes on with the key in its env', { timeout: 60_000 }, async (t) => {
  const at = await fakeWalk(t, {});
  noTraces(at);
  assert.ok(at.turn.files > 0, 'the session folder had files to read');
});

test("the walk was run on the pin: cursor-walk.json names the digests CURSOR_PIN pins, platform by platform", () => {
  assert.ok(existsSync(RECORD), 'cursor-walk.json is there: run this file on the real Cursor with AGENTRUN_RECORD_CURSOR_WALK=1');
  const record = JSON.parse(readFileSync(RECORD, 'utf8'));
  assert.equal(record.version, CURSOR_PIN.version, `the walk ran on Cursor ${record.version}; the pin is ${CURSOR_PIN.version}: walk it again`);
  assert.deepEqual(Object.keys(record.platforms).sort(), Object.keys(CURSOR_PIN.archives).sort(), 'one walk for each platform pinned');
  for (const [platform, pin] of Object.entries(CURSOR_PIN.archives)) {
    const walked = record.platforms[platform];
    assert.deepEqual({ sha256: walked.sha256, binarySha256: walked.binarySha256, treeSha256: walked.treeSha256 }, { sha256: pin.sha256, binarySha256: pin.binarySha256, treeSha256: pin.treeSha256 }, `${platform}: the walk ran on other digests than the pin's: walk it again`);
    for (const point of ['turn', 'kill', 'close']) assert.deepEqual([walked.at[point].key, walked.at[point].token], [0, 0], `${platform} ${point}: the walk it records was green`);
  }
});

const CURSOR = process.env.AGENTRUN_TEST_CURSOR;
const live = process.platform !== 'linux' ? 'Linux alone: Cursor is pinned for linux-x86_64, and the walk finds its processes in /proc'
  : !CURSOR ? 'AGENTRUN_TEST_CURSOR is not set: it names the folder holding the pinned Cursor\'s dist-package'
  : !process.env.CURSOR_API_KEY ? 'CURSOR_API_KEY is not set: the walk runs on the owner\'s Cursor key'
  : process.env.AGENTRUN_TEST_CURSOR_LIVE !== '1' ? 'AGENTRUN_TEST_CURSOR_LIVE is not 1: the walk spends two short turns on the key\'s plan'
  : false;

test('on the real Cursor, no file of its session folder holds the key or a token: after a turn, a hard kill mid-turn, and the close', { skip: live, timeout: 240_000 }, async (t) => {
  const key = process.env.CURSOR_API_KEY;
  const dir = scratch();
  const sessionsDir = join(dir, 'sessions');
  const platform = acpPlatform();
  const adapter = cursorAdapter({ binary: join(CURSOR, CURSOR_PIN.archives[platform].cmd), model: process.env.AGENTRUN_TEST_CURSOR_MODEL ?? 'gpt-5.4-nano', sessionsDir, env: { PATH: '/usr/bin:/bin', CURSOR_API_KEY: key } });
  const at = await walk(t, { adapter, sessionsDir, key, plant: process.env.AGENTRUN_TEST_CURSOR_PLANT });
  t.diagnostic(`counted: ${JSON.stringify(at)}`);
  noTraces(at);
  if (process.env.AGENTRUN_RECORD_CURSOR_WALK === '1') {
    const pin = CURSOR_PIN.archives[platform];
    const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : {};
    const platforms = record.version === CURSOR_PIN.version ? record.platforms : {};
    platforms[platform] = { sha256: pin.sha256, binarySha256: pin.binarySha256, treeSha256: pin.treeSha256, walked: new Date().toISOString().slice(0, 10), at };
    writeFileSync(RECORD, `${JSON.stringify({ version: CURSOR_PIN.version, platforms }, null, 2)}\n`);
  }
});
