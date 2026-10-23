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

// The clean consumer's report for zod's GHSA-mrhx-c7xc-m3w5: the copies stagehand pins, and the packages flagged through them.
const zodAdvisory = advisory('GHSA-mrhx-c7xc-m3w5', 'high');
const pinnedZod = ['node_modules/@browserbasehq/stagehand/node_modules/zod', 'node_modules/@parcha/pi-browser/node_modules/zod'];
const zodReport = (overrides = {}) => ({
  '@parcha/agentrun-harness': { name: '@parcha/agentrun-harness', severity: 'high', isDirect: true, effects: [], nodes: ['node_modules/@parcha/agentrun-harness'], via: ['@parcha/pi-browser'] },
  '@browserbasehq/stagehand': { name: '@browserbasehq/stagehand', severity: 'high', isDirect: false, effects: [], nodes: ['node_modules/@browserbasehq/stagehand'], via: ['zod'] },
  '@parcha/pi-browser': { name: '@parcha/pi-browser', severity: 'high', isDirect: true, effects: ['@parcha/agentrun-harness'], nodes: ['node_modules/@parcha/pi-browser'], via: ['@browserbasehq/stagehand', 'zod'] },
  zod: { name: 'zod', severity: 'high', isDirect: false, effects: ['@browserbasehq/stagehand', '@parcha/pi-browser'], nodes: pinnedZod, via: [zodAdvisory] },
  ...overrides,
});
const zodBlockers = (report, now = before) => auditBlockers(audit(report), now);

test('zod under stagehand and pi-browser is accepted, and so is every package flagged only through it, until the exception expires', () => {
  const { accepted, blocking } = zodBlockers(zodReport());
  assert.deepEqual(blocking, []);
  assert.deepEqual(accepted.map(entry => entry.package).sort(), ['@browserbasehq/stagehand', '@parcha/agentrun-harness', '@parcha/pi-browser', 'zod']);
  for (const entry of accepted) assert.deepEqual([entry.advisories, entry.expires], [['GHSA-mrhx-c7xc-m3w5'], '2026-12-01'], entry.package);
  assert.deepEqual(zodBlockers(zodReport(), Date.parse('2026-12-01T00:00:00Z')).blocking.map(entry => entry.package).sort(), ['@browserbasehq/stagehand', '@parcha/agentrun-harness', '@parcha/pi-browser', 'zod']);
});

test('a zod copy outside stagehand and pi-browser blocks zod and every package flagged through it', () => {
  const report = zodReport({ zod: { ...zodReport().zod, nodes: [...pinnedZod, 'node_modules/zod'] } });
  assert.deepEqual(zodBlockers(report), { accepted: [], blocking: Object.keys(report).map(name => ({ package: name, severity: 'high' })) });
});

test('a package flagged through an entry that blocks, or with an advisory of its own, blocks', () => {
  const ws = { name: 'ws', severity: 'high', isDirect: false, effects: ['@parcha/pi-browser'], nodes: ['node_modules/ws'], via: [advisory('GHSA-aaaa-bbbb-cccc', 'high')] };
  const throughBlocked = zodBlockers(zodReport({ ws, '@parcha/pi-browser': { ...zodReport()['@parcha/pi-browser'], via: ['@browserbasehq/stagehand', 'zod', 'ws'] } }));
  assert.deepEqual(throughBlocked.blocking.map(entry => entry.package).sort(), ['@parcha/agentrun-harness', '@parcha/pi-browser', 'ws']);
  const ownAdvisory = zodBlockers(zodReport({ '@browserbasehq/stagehand': { ...zodReport()['@browserbasehq/stagehand'], via: ['zod', advisory('GHSA-aaaa-bbbb-cccc', 'high')] } }));
  assert.deepEqual(ownAdvisory.blocking.map(entry => entry.package).sort(), ['@browserbasehq/stagehand', '@parcha/agentrun-harness', '@parcha/pi-browser']);
  assert.deepEqual(zodBlockers({ '@parcha/pi-browser': { ...zodReport()['@parcha/pi-browser'], via: ['left-pad'] } }).blocking, [{ package: '@parcha/pi-browser', severity: 'high' }]);
});

test('a package flagged through accepted entries takes the earliest of their expiry dates', () => {
  const exceptions = [
    { package: 'zod', under: ['node_modules/@browserbasehq/stagehand/', 'node_modules/@parcha/pi-browser/'], advisories: ['GHSA-mrhx-c7xc-m3w5'], expires: '2026-12-01' },
    { package: 'ws', under: ['node_modules/'], advisories: ['GHSA-aaaa-bbbb-cccc'], expires: '2026-11-01' },
  ];
  const ws = { name: 'ws', severity: 'high', isDirect: false, effects: [], nodes: ['node_modules/ws'], via: [advisory('GHSA-aaaa-bbbb-cccc', 'high')] };
  const report = zodReport({ ws, '@parcha/pi-browser': { ...zodReport()['@parcha/pi-browser'], via: ['@browserbasehq/stagehand', 'zod', 'ws'] } });
  const { accepted, blocking } = auditBlockers(audit(report), before, exceptions);
  assert.deepEqual(blocking, []);
  const browser = accepted.find(entry => entry.package === '@parcha/pi-browser');
  assert.deepEqual([browser.advisories.sort(), browser.expires], [['GHSA-aaaa-bbbb-cccc', 'GHSA-mrhx-c7xc-m3w5'], '2026-11-01']);
  assert.equal(accepted.find(entry => entry.package === '@parcha/agentrun-harness').expires, '2026-11-01');
});
