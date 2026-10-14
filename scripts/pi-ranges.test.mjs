// The pi-family peer ranges of every package in this repository follow one rule. pi-durable and chord are bounded below
// pi 1.3, the next minor no package has been tested on: the family breaks in minors. The packages Pi provides to the
// packages it loads (pi-ai, pi-agent-core, pi-coding-agent, pi-tui, typebox) are "*", as Pi's package guidance asks; a
// pi version newer than the tested ones is guarded by the version legs and each README's tested-host line, not a range.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOST_PROVIDED, parseRange, readWorkspaces } from './pi-leg.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const BOUNDED = ['@earendil-works/pi-durable', '@earendil-works/chord'];
const CEILING = '1.3.0';

const compare = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
/** Whether every version `range` accepts is below `ceiling`: one of its comparators caps it there, whatever the others
 *  say. A range with no such comparator is open above, however many versions a sample of it rejects. */
const endsBelow = (range, peer, ceiling = CEILING) => parseRange(range, peer).some(({ op, version }) =>
  (op === '<' && compare(version, ceiling) <= 0) || ((op === '<=' || op === '=') && compare(version, ceiling) < 0));

test('a range ends below 1.3 only when one of its comparators caps it there', () => {
  const peer = '@earendil-works/pi-durable';
  for (const range of ['>=1.0.4 <1.3.0', '>=1.0.4 <=1.2.9', '1.2.0', '>=1.1.0 <1.2.0']) assert.equal(endsBelow(range, peer), true, range);
  for (const range of ['>1.3.0 <2.0.0', '>=1.0.4', '>=1.0.4 <1.4.0', '>=1.0.4 <=1.3.0']) assert.equal(endsBelow(range, peer), false, range);
  assert.throws(() => endsBelow('*', peer), /only a package Pi provides/);
});

for (const { name, manifest } of readWorkspaces(repo)) {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([peer]) => BOUNDED.includes(peer) || HOST_PROVIDED.includes(peer));
  if (!peers.length) continue;
  test(`${name}: pi-durable and chord end below 1.3, and the packages Pi provides are "*"`, () => {
    for (const [peer, range] of peers) {
      if (HOST_PROVIDED.includes(peer)) assert.equal(range, '*', `${name}: ${peer} is "${range}"; Pi's package guidance asks for "*"`);
      else assert.equal(endsBelow(range, peer), true, `${name}: ${peer} "${range}" does not end below ${CEILING}`);
    }
  });
}
