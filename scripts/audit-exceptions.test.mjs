import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditBlockers } from './audit-exceptions.mjs';

const advisory = (id, severity) => ({ source: 1, title: id, url: `https://github.com/advisories/${id}`, severity, range: '>=4.0.0 <5.0.12' });
const shrinkwrapped = 'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion';
const braceExpansion = (overrides = {}) => ({ name: 'brace-expansion', severity: 'high', isDirect: false, effects: [], nodes: [shrinkwrapped],
  via: [advisory('GHSA-q2hr-2g5m-vwhr', 'moderate'), advisory('GHSA-qhr7-859c-m2p7', 'high'), advisory('GHSA-6j4f-fj2g-mc7p', 'high')], ...overrides });
const audit = (vulnerabilities) => ({ vulnerabilities });
const before = Date.parse('2026-10-02T00:00:00Z');

test('the three brace-expansion advisories under pi-coding-agent are accepted until the exception expires', () => {
  assert.deepEqual(auditBlockers(audit({ 'brace-expansion': braceExpansion() }), before), {
    accepted: [{ package: 'brace-expansion', severity: 'high', advisories: ['GHSA-q2hr-2g5m-vwhr', 'GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p'], expires: '2026-12-01' }],
    blocking: [],
  });
  assert.deepEqual(auditBlockers(audit({ 'brace-expansion': braceExpansion() }), Date.parse('2026-12-01T00:00:00Z')).blocking, [{ package: 'brace-expansion', severity: 'high' }]);
});

test('anything outside the exception still blocks', () => {
  const cases = {
    'another parent': braceExpansion({ nodes: [shrinkwrapped, 'node_modules/brace-expansion'] }),
    'another advisory': braceExpansion({ via: [advisory('GHSA-qhr7-859c-m2p7', 'high'), advisory('GHSA-aaaa-bbbb-cccc', 'high')] }),
    'a transitive cause': braceExpansion({ via: ['balanced-match'] }),
  };
  for (const [label, entry] of Object.entries(cases)) {
    assert.deepEqual(auditBlockers(audit({ 'brace-expansion': entry }), before).blocking, [{ package: 'brace-expansion', severity: 'high' }], label);
  }
  assert.deepEqual(auditBlockers(audit({ minimatch: braceExpansion({ name: 'minimatch', severity: 'critical' }) }), before).blocking, [{ package: 'minimatch', severity: 'critical' }]);
});

test('moderate and low entries never block', () => {
  assert.deepEqual(auditBlockers(audit({ glob: { severity: 'moderate', nodes: ['node_modules/glob'], via: [advisory('GHSA-aaaa-bbbb-cccc', 'moderate')] } }), before), { accepted: [], blocking: [] });
});
