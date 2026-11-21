// A key the agent is still writing: stderr read mid-run can end on the key's start, which no cut of whole keys matches.
// Neither the cut (host/key-cut.ts) nor the tail a live process keeps (host/agent.ts) leaves a piece of it. Fake keys only.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as keyCut from '../dist/host/key-cut.js';
import { startAgent } from '../dist/host/agent.js';
import { scratch, until } from './helpers.mjs';

// A fake literal, never a real key: none of its pieces match anything else here.
const KEY = 'fake-Qz7Wv9Lm2Np4Rs6Tx8Yb3Kc5Hd';
/** Each 8-character piece of the key: text holding any of them holds part of it. */
const PIECES = Array.from({ length: KEY.length - 7 }, (_, i) => KEY.slice(i, i + 8));
const piecesIn = (text) => PIECES.filter((piece) => text.includes(piece)).length;

test('an empty key is no key: the text comes back as it was (indexOf finds "" past the end forever)', () => {
  assert.equal(keyCut.cutKeys('vendor: refused', ['', KEY], { head: true, tail: true }), 'vendor: refused');
});

test("a text that ends on the key's first 20 characters keeps no piece of it", () => {
  const text = `vendor: refused ${KEY.slice(0, 20)}`;
  const cut = keyCut.cutKeys(text, [KEY], { tail: true });
  assert.equal(piecesIn(cut), 0, `the cut text holds ${piecesIn(cut)} pieces of the key`);
  assert.equal(cut, 'vendor: refused ', 'what came before the key is kept');
  // The text's end that starts no key is kept as it is, and a whole key still becomes the cut's mark.
  assert.equal(keyCut.cutKeys('vendor: refused (401)', [KEY], { tail: true }), 'vendor: refused (401)');
  assert.equal(keyCut.cutKeys(`refused ${KEY} (401)`, [KEY], { head: true, tail: true }), `refused ${keyCut.KEY_CUT} (401)`);
});

test("the stderr a live agent keeps, read while it is still writing its key, holds no piece of it", async (t) => {
  const dir = scratch();
  const wrote = join(dir, 'wrote');
  const go = join(dir, 'go');
  // The agent writes the key's first 20 characters on stderr in one write, says so in a file, and waits until the test
  // lets it go (a file the test writes): the tail is read between the two.
  const script = `process.stderr.write(${JSON.stringify(`vendor: refused ${KEY.slice(0, 20)}`)});
require('node:fs').writeFileSync(${JSON.stringify(wrote)}, '');
const wait = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(go)})) { clearInterval(wait); process.exit(0); } }, 20);`;
  const controller = new AbortController();
  const agent = startAgent({
    command: process.execPath,
    args: ['-e', script],
    cwd: dir,
    env: {},
    from: { PATH: process.env.PATH },
    keys: [KEY],
    signal: controller.signal,
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  });
  t.after(async () => {
    writeFileSync(go, '');
    controller.abort();
    await agent.exited;
  });
  await until(() => existsSync(wrote), 'the agent to write the start of its key');
  const tail = await until(() => (agent.stderrTail().includes('vendor: refused') ? agent.stderrTail() : undefined), 'its stderr to arrive');
  assert.equal(agent.alive(), true, 'read while the agent runs');
  assert.equal(piecesIn(tail), 0, `the live tail holds ${piecesIn(tail)} pieces of the key`);
});

// Two keys where one holds the other's start or end, or where they overlap in the text: a cut of one whole key must not
// hide a piece of the other (Greptile, #3318). Fake literals; every piece is found in the text as it was written.
const LONG = 'fake-Hd5Kc3Yb8Tx6Rs4Np2Lm9Wv7Qz';
const LONG_PIECES = Array.from({ length: LONG.length - 7 }, (_, i) => LONG.slice(i, i + 8));
const longPiecesIn = (text) => LONG_PIECES.filter((piece) => text.includes(piece)).length;

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

test("a live tail ending on a long key's start, a short key being that start's head, holds no piece of the long key", async (t) => {
  const agent = agentSaying(t, `vendor: refused ${LONG.slice(0, 20)}`, [LONG.slice(0, 8), LONG], true);
  const tail = await until(() => (agent.stderrTail().includes('vendor: refused') ? agent.stderrTail() : undefined), 'its stderr to arrive');
  assert.equal(agent.alive(), true, 'read while the agent runs');
  assert.equal(longPiecesIn(tail), 0, `the live tail holds ${longPiecesIn(tail)} pieces of the long key`);
});

test("a cut tail starting 20 characters before a long key's end, a short key being that end, holds no piece of the long key", async (t) => {
  // The process keeps 8 KiB and the longest key's length; what follows the long key fills all of that but its last 20.
  // Two more whole long keys in it each shrink by their cut, so the tail's last 8 KiB still reaches back to its head.
  const kept = 8192 + LONG.length;
  const rest = `\n${LONG} ${LONG}\n${'noise '.repeat(Math.ceil(kept / 6))}`.slice(0, kept - 20 - 3) + 'END';
  const agent = agentSaying(t, `vendor: refused ${LONG}${rest}`, [LONG.slice(-8), LONG], false);
  const tail = await until(() => (agent.stderrTail().endsWith('END') ? agent.stderrTail() : undefined), 'its stderr to arrive');
  assert.equal(longPiecesIn(tail), 0, `the cut tail holds ${longPiecesIn(tail)} pieces of the long key`);
});

test('two keys that overlap in the text are cut with no piece of either left', () => {
  // The first key's last 8 characters are the second key's first 8; the text holds them once, shared.
  const first = 'fake-Pq3Rm5Sn7To9OVERLAP!';
  const second = 'OVERLAP!-Uk2Vj4Wi6Xh8Yg';
  const pieces = [first, second].flatMap((key) => Array.from({ length: key.length - 7 }, (_, i) => key.slice(i, i + 8)));
  const cut = keyCut.cutKeys(`vendor: refused fake-Pq3Rm5Sn7To9OVERLAP!-Uk2Vj4Wi6Xh8Yg (401)`, keyCut.keysToCut([first, second]));
  const left = pieces.filter((piece) => cut.includes(piece));
  assert.equal(left.length, 0, `the cut text holds ${left.length} pieces of the keys`);
  assert.match(cut, /^vendor: refused .*\(401\)$/, 'the words around the keys are kept');
});
