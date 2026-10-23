// The Pi hosts `/agentrun status` calls supported: the range of this package's pi-durable and chord peers. A host outside
// it is flagged, never blocked, with the newest version CI runs as the one to install.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isSupportedPi, NEWEST_TESTED_PI_VERSION, piHostLine, SUPPORTED_PI_RANGE } from '../dist/pi-host.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const INSTALL = `npm install -g @earendil-works/pi-coding-agent@${NEWEST_TESTED_PI_VERSION}`;

test('the supported range is the range of the pi-durable and chord peers', () => {
  assert.equal(SUPPORTED_PI_RANGE, '>=1.0.4 <1.4.0');
  for (const peer of ['@earendil-works/pi-durable', '@earendil-works/chord']) assert.equal(manifest.peerDependencies[peer], SUPPORTED_PI_RANGE, peer);
});

test('the newest tested version is the newest pi the pi-1-2 CI job runs, and is in the range', () => {
  const job = /^ {2}pi-1-2:\n((?:(?! {2}\S).*\n)*)/m.exec(ci)?.[1];
  const matrix = job && /^\s+pi: \[([^\]]*)\]/m.exec(job)?.[1];
  assert.ok(matrix, 'the pi-1-2 job has a pi matrix');
  const versions = matrix.split(',').map((version) => version.trim().replace(/^'|'$/g, ''));
  assert.equal(NEWEST_TESTED_PI_VERSION, versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1));
  assert.equal(isSupportedPi(NEWEST_TESTED_PI_VERSION), true);
});

test('a host in the range is named supported, with no install line', () => {
  for (const version of ['1.0.4', '1.1.0', '1.2.0', '1.3.0', '1.3.12']) {
    assert.equal(isSupportedPi(version), true, version);
    assert.equal(piHostLine(version), `Pi host: ${version} (supported: >=1.0.4 <1.4.0)`);
  }
});

test('a host outside the range, a prerelease or an unreadable version is flagged with the newest tested host to install', () => {
  for (const version of ['1.0.3', '0.9.9', '1.4.0', '1.10.0', '2.0.0', '1.3.1-rc.1', '1.4.0-beta.1', 'v1.3.0', 'unknown']) {
    assert.equal(isSupportedPi(version), false, version);
    assert.equal(piHostLine(version), `Pi host: ${version} (outside the supported range >=1.0.4 <1.4.0; the newest tested host: ${INSTALL})`);
  }
});
