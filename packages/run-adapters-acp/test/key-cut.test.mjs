// A key the agent is still writing: stderr read mid-run can end on the key's start, which no cut of whole keys matches.
// Neither the cut (host/key-cut.ts) nor the tail a live process keeps (host/agent.ts) leaves a piece of it. Fake keys only.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as keyCut from '../dist/host/key-cut.js';
import { startAgent } from '../dist/host/agent.js';
import { scratch, until } from './helpers.mjs';

// Fake literals, never real keys: none of their pieces match anything else here.
const KEY = 'fake-Qz7Wv9Lm2Np4Rs6Tx8Yb3Kc5Hd';
const LONG = 'fake-Hd5Kc3Yb8Tx6Rs4Np2Lm9Wv7Qz';

/** How many 8-character pieces of `keys` the text still holds: text holding any of them holds part of a key. */
const piecesLeft = (text, ...keys) =>
  keys.flatMap((key) => Array.from({ length: key.length - 7 }, (_, i) => key.slice(i, i + 8))).filter((piece) => text.includes(piece)).length;

/** An agent on `keys` that writes `words` on stderr; with `hold`, it then waits until the test ends it. */
function agentSaying(t, words, keys, hold) {
  const dir = scratch();
  const go = join(dir, 'go');
  const script = `process.stderr.write(${JSON.stringify(words)});
${hold ? `const wait = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(go)})) { clearInterval(wait); process.exit(0); } }, 20);` : ''}`;
  const controller = new AbortController();
  const agent = startAgent({
    command: process.execPath,
    args: ['-e', script],
    cwd: dir,
    env: {},
    from: { PATH: process.env.PATH },
    keys,
    signal: controller.signal,
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  });
  t.after(async () => {
    writeFileSync(go, '');
    controller.abort();
    await agent.exited;
  });
  return agent;
}

test('an empty key is no key: the text comes back as it was (indexOf finds "" past the end forever)', () => {
  assert.equal(keyCut.cutKeys('vendor: refused', ['', KEY], { head: true, tail: true }), 'vendor: refused');
});

test("a text that ends on the key's first 20 characters keeps no piece of it", () => {
  const text = `vendor: refused ${KEY.slice(0, 20)}`;
  const cut = keyCut.cutKeys(text, [KEY], { tail: true });
  assert.equal(piecesLeft(cut, KEY), 0, `the cut text holds ${piecesLeft(cut, KEY)} pieces of the key`);
  assert.equal(cut, 'vendor: refused ', 'what came before the key is kept');
  // The text's end that starts no key is kept as it is, and a whole key still becomes the cut's mark.
  assert.equal(keyCut.cutKeys('vendor: refused (401)', [KEY], { tail: true }), 'vendor: refused (401)');
  assert.equal(keyCut.cutKeys(`refused ${KEY} (401)`, [KEY], { head: true, tail: true }), `refused ${keyCut.KEY_CUT} (401)`);
});

test("a text ending on a long key's start, a short key being that start's head, keeps no piece of the long key", () => {
  const cut = keyCut.cutKeys(`vendor: refused ${LONG.slice(0, 20)}`, keyCut.keysToCut([LONG.slice(0, 8), LONG]), { tail: true });
  assert.equal(piecesLeft(cut, LONG), 0, `the cut text holds ${piecesLeft(cut, LONG)} pieces of the long key`);
});

test("a live tail ending on a long key's start, a short key being that start's head, holds no piece of the long key", async (t) => {
  const agent = agentSaying(t, `vendor: refused ${LONG.slice(0, 20)}`, [LONG.slice(0, 8), LONG], true);
  const tail = await until(() => (agent.stderrTail().includes('vendor: refused') ? agent.stderrTail() : undefined), 'its stderr to arrive');
  assert.equal(agent.alive(), true, 'read while the agent runs');
  assert.equal(piecesLeft(tail, LONG), 0, `the live tail holds ${piecesLeft(tail, LONG)} pieces of the long key`);
});

test("the stderr a live agent keeps, read while it is still writing its key, holds no piece of it", async (t) => {
  const agent = agentSaying(t, `vendor: refused ${KEY.slice(0, 20)}`, [KEY], true);
  const tail = await until(() => (agent.stderrTail().includes('vendor: refused') ? agent.stderrTail() : undefined), 'its stderr to arrive');
  assert.equal(agent.alive(), true, 'read while the agent runs');
  assert.equal(piecesLeft(tail, KEY), 0, `the live tail holds ${piecesLeft(tail, KEY)} pieces of the key`);
});

test("a cut tail starting 20 characters before a long key's end, a short key being that end, holds no piece of the long key", async (t) => {
  // The process keeps 8 KiB and the longest key's length; what follows the long key fills all of that but its last 20.
  // Two more whole long keys in it each shrink by their cut, so the tail's last 8 KiB still reaches back to its head.
  const kept = 8192 + LONG.length;
  const rest = `\n${LONG} ${LONG}\n${'noise '.repeat(Math.ceil(kept / 6))}`.slice(0, kept - 20 - 3) + 'END';
  const agent = agentSaying(t, `vendor: refused ${LONG}${rest}`, [LONG.slice(-8), LONG], false);
  const tail = await until(() => (agent.stderrTail().endsWith('END') ? agent.stderrTail() : undefined), 'its stderr to arrive');
  assert.equal(piecesLeft(tail, LONG), 0, `the cut tail holds ${piecesLeft(tail, LONG)} pieces of the long key`);
});

test("an agent that dies writing a key longer than the 8 KiB it keeps leaves no piece of it in the tail", async (t) => {
  // A fake 9000-character key, no 8 characters of it repeated: the agent writes its first 8500 and exits. A tail trimmed to
  // 8 KiB alone would hold an inside piece, neither the key's start nor its end, which no edge cut finds.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let seed = 7;
  const huge = `fake-${Array.from({ length: 8995 }, () => alphabet[((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % 62]).join('')}`;
  const agent = agentSaying(t, `vendor: refused ${huge.slice(0, 8500)}`, [huge], false);
  await agent.exited;
  const tail = await until(() => (agent.ended() ? agent.stderrTail() : undefined), 'its end');
  assert.equal(piecesLeft(tail, huge), 0, `the tail holds ${piecesLeft(tail, huge)} pieces of the key`);
});

test('two keys that overlap in the text are cut with no piece of either left', () => {
  // The first key's last 8 characters are the second key's first 8; the text holds them once, shared.
  const first = 'fake-Pq3Rm5Sn7To9OVERLAP!';
  const second = 'OVERLAP!-Uk2Vj4Wi6Xh8Yg';
  const cut = keyCut.cutKeys(`vendor: refused fake-Pq3Rm5Sn7To9OVERLAP!-Uk2Vj4Wi6Xh8Yg (401)`, keyCut.keysToCut([first, second]));
  assert.equal(piecesLeft(cut, first, second), 0, `the cut text holds ${piecesLeft(cut, first, second)} pieces of the keys`);
  assert.match(cut, /^vendor: refused .*\(401\)$/, 'the words around the keys are kept');
});
