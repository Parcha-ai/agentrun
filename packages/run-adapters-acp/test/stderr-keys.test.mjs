// An agent's last words never hold part of a key the adapter handed it: the recipe's keys are cut from its stderr before
// any cut of the text (the last 300 characters of a failure's words, the tail the process keeps), so a cut inside a key
// leaves none of it. Fake keys only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeRecipe, openSession, scratch } from './helpers.mjs';

// A fake literal, never a real key: none of its pieces match anything else the adapter says.
const KEY = 'fake-Qz7Wv9Lm2Np4Rs6Tx8Yb3Kc5Hd';
/** Each 8-character piece of the key: text holding any of them holds part of it. */
const PIECES = Array.from({ length: KEY.length - 7 }, (_, i) => KEY.slice(i, i + 8));
const piecesIn = (text) => PIECES.filter((piece) => text.includes(piece)).length;

/** The turn's end of an agent that prints `words` on stderr at session/new and exits, run on KEY. */
async function endOf(t, words, recipe = {}) {
  const fake = fakeRecipe(scratch(), { script: [{ say: 'never' }], failNew: words }, { keys: ['ACP_TEST_KEY'], ...recipe });
  const { session } = await openSession(t, fake, { options: { env: { PATH: process.env.PATH, ACP_TEST_KEY: KEY } } });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  return end.error;
}

test("a failure's last words cut inside the key (the key, then 280 characters) hold no piece of it", async (t) => {
  // " (401) " and 273 more: the last 300 characters start 20 characters into the key.
  const error = await endOf(t, `vendor: refused ${KEY} (401) ${'.'.repeat(273)}`);
  assert.equal(piecesIn(error), 0, `the failure holds ${piecesIn(error)} pieces of the key`);
  assert.match(error, /\(401\) \.{20}/, 'the last words are still there');
});

test("the stderr the process keeps, its start inside the key, holds no piece of it at its head", async (t) => {
  // Quiet lines after the key fill the kept tail, so the words left after them are what the tail's start holds. The
  // tail starts 12 characters before the key's end, for a tail of 8 KiB and for one of 8 KiB and the key's length.
  for (const kept of [8192, 8192 + KEY.length]) {
    const fill = kept - 12 - 2;
    const line = `noise ${'.'.repeat(93)}\n`;
    const quiet = line.repeat(Math.floor(fill / line.length)) + `noise ${'.'.repeat(fill % line.length - 6)}`;
    assert.equal(quiet.length, fill);
    const error = await endOf(t, `vendor: refused ${KEY}\n${quiet}`, { quiet: ['noise'] });
    assert.equal(piecesIn(error), 0, `a tail of ${kept}: the failure holds ${piecesIn(error)} pieces of the key`);
  }
});
