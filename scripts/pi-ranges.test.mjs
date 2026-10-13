// The pi-family peer ranges of every package in this repository follow one rule. pi-durable and chord are bounded below
// pi 1.3, the next minor no package has been tested on: the family breaks in minors. The packages Pi provides to the
// packages it loads (pi-ai, pi-agent-core, pi-coding-agent, pi-tui, typebox) are "*", as Pi's package guidance asks; a
// pi version newer than the tested ones is guarded by the version legs and each README's tested-host line, not a range.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accepts, HOST_PROVIDED, readWorkspaces } from './pi-leg.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const BOUNDED = ['@earendil-works/pi-durable', '@earendil-works/chord'];

for (const { name, manifest } of readWorkspaces(repo)) {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([peer]) => BOUNDED.includes(peer) || HOST_PROVIDED.includes(peer));
  if (!peers.length) continue;
  test(`${name}: pi-durable and chord end below 1.3, and the packages Pi provides are "*"`, () => {
    for (const [peer, range] of peers) {
      if (HOST_PROVIDED.includes(peer)) assert.equal(range, '*', `${name}: ${peer} is "${range}"; Pi's package guidance asks for "*"`);
      else for (const version of ['1.3.0', '2.0.0']) assert.equal(accepts(range, version, peer), false, `${name}: ${peer} "${range}" accepts ${version}`);
    }
  });
}
