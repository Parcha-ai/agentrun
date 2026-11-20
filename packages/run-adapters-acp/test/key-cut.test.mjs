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

test("a text that ends on the key's first 20 characters keeps no piece of it", () => {
  const text = `vendor: refused ${KEY.slice(0, 20)}`;
  const cut = keyCut.cutKeyEndAtTail(keyCut.cutKeys(text, [KEY]), [KEY]);
  assert.equal(piecesIn(cut), 0, `the cut text holds ${piecesIn(cut)} pieces of the key`);
  assert.equal(cut, 'vendor: refused ', 'what came before the key is kept');
  // The text's end that starts no key is kept as it is.
  assert.equal(keyCut.cutKeyEndAtTail('vendor: refused (401)', [KEY]), 'vendor: refused (401)');
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
