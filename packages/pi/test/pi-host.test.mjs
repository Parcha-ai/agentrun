// The Pi host `/agentrun status` calls supported: the exact version of this package's pi-durable and chord peers. A host
// at any other version is flagged, never blocked, with that version as the one to install.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isSupportedPi, NEWEST_TESTED_PI_VERSION, piHostLine, SUPPORTED_PI_RANGE } from '../dist/pi-host.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const INSTALL = `npm install -g @earendil-works/pi-coding-agent@${NEWEST_TESTED_PI_VERSION}`;

test('the supported range is the pi-durable and chord peers\' exact version, the one tested', () => {
  assert.equal(SUPPORTED_PI_RANGE, '1.5.0');
  for (const peer of ['@earendil-works/pi-durable', '@earendil-works/chord']) assert.equal(manifest.peerDependencies[peer], SUPPORTED_PI_RANGE, peer);
  assert.equal(NEWEST_TESTED_PI_VERSION, SUPPORTED_PI_RANGE);
  assert.equal(isSupportedPi(NEWEST_TESTED_PI_VERSION), true);
});

test('the supported host is named supported, with no install line', () => {
  assert.equal(isSupportedPi('1.5.0'), true);
  assert.equal(piHostLine('1.5.0'), 'Pi host: 1.5.0 (supported: 1.5.0)');
});

test('any other host, a prerelease or an unreadable version is flagged with the supported host to install', () => {
  for (const version of ['1.4.0', '1.3.0', '1.0.4', '1.5.1', '1.6.0', '2.0.0', '1.5.0-rc.1', 'v1.5.0', 'unknown']) {
    assert.equal(isSupportedPi(version), false, version);
    assert.equal(piHostLine(version), `Pi host: ${version} (outside the supported range 1.5.0; the newest tested host: ${INSTALL})`);
  }
});
