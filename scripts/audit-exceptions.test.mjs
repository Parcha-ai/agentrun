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

const stagehandZod = 'node_modules/@browserbasehq/stagehand/node_modules/zod';
const dependent = (name, via) => ({ name, severity: 'high', isDirect: false, effects: [], nodes: [`node_modules/${name}`], via });
const zodChain = (overrides = {}) => ({
  zod: { name: 'zod', severity: 'high', isDirect: false, effects: ['@browserbasehq/stagehand'], nodes: [stagehandZod], via: [advisory('GHSA-mrhx-c7xc-m3w5', 'high')] },
  '@browserbasehq/stagehand': dependent('@browserbasehq/stagehand', ['zod']),
  '@parcha/pi-browser': dependent('@parcha/pi-browser', ['@browserbasehq/stagehand', 'zod']),
  '@parcha/agentrun-harness': dependent('@parcha/agentrun-harness', ['@parcha/pi-browser']),
  ...overrides,
});
const chainNames = ['zod', '@browserbasehq/stagehand', '@parcha/pi-browser', '@parcha/agentrun-harness'];
const blocked = (vulnerabilities, now = before) => auditBlockers(audit(vulnerabilities), now).blocking.map(entry => entry.package).sort();

test("stagehand's own zod, and each package vulnerable only through it, are accepted until 2026-11-06", () => {
  assert.deepEqual(auditBlockers(audit(zodChain()), before), {
    accepted: chainNames.map(name => ({ package: name, severity: 'high', advisories: ['GHSA-mrhx-c7xc-m3w5'], expires: '2026-11-06' })),
    blocking: [],
  });
  assert.deepEqual(blocked(zodChain(), Date.parse('2026-11-06T00:00:00Z')), [...chainNames].sort(), 'an expired exception accepts nothing in the chain');
});

test('any other cause anywhere in the chain blocks every package it reaches', () => {
  const other = advisory('GHSA-aaaa-bbbb-cccc', 'high');
  const upFrom = name => chainNames.slice(chainNames.indexOf(name)).sort();
  const cases = [
    ['zod outside stagehand', zodChain({ zod: { ...zodChain().zod, nodes: [stagehandZod, 'node_modules/zod'] } }), upFrom('zod')],
    ['another zod advisory', zodChain({ zod: { ...zodChain().zod, via: [advisory('GHSA-mrhx-c7xc-m3w5', 'high'), other] } }), upFrom('zod')],
    ["stagehand's own advisory", zodChain({ '@browserbasehq/stagehand': dependent('@browserbasehq/stagehand', ['zod', other]) }), upFrom('@browserbasehq/stagehand')],
    ['another high package in the chain', zodChain({ '@parcha/pi-browser': dependent('@parcha/pi-browser', ['@browserbasehq/stagehand', 'undici']),
      undici: { name: 'undici', severity: 'high', isDirect: false, effects: [], nodes: ['node_modules/undici'], via: [advisory('GHSA-dddd-eeee-ffff', 'high')] } }), [...upFrom('@parcha/pi-browser'), 'undici'].sort()],
    ['an advisory of its own below high (the moderate allowance is only for causes named by package)', zodChain({ '@browserbasehq/stagehand': dependent('@browserbasehq/stagehand', ['zod', advisory('GHSA-gggg-hhhh-jjjj', 'low')]) }), upFrom('@browserbasehq/stagehand')],
    ['an advisory of its own without a severity', zodChain({ '@browserbasehq/stagehand': dependent('@browserbasehq/stagehand', ['zod', { url: 'https://github.com/advisories/GHSA-kkkk-mmmm-nnnn' }]) }), upFrom('@browserbasehq/stagehand')],
    ['a high entry whose causes are all below high (a report that does not add up)', zodChain({ '@parcha/agentrun-harness': dependent('@parcha/agentrun-harness', ['undici']),
      undici: { name: 'undici', severity: 'moderate', isDirect: false, effects: [], nodes: ['node_modules/undici'], via: [advisory('GHSA-dddd-eeee-ffff', 'moderate')] } }), upFrom('@parcha/agentrun-harness')],
    ['a cause the report does not list', zodChain({ '@parcha/agentrun-harness': dependent('@parcha/agentrun-harness', ['@parcha/pi-browser', 'missing']) }), upFrom('@parcha/agentrun-harness')],
    ['a cycle', zodChain({ '@browserbasehq/stagehand': dependent('@browserbasehq/stagehand', ['zod', '@parcha/agentrun-harness']) }), upFrom('@browserbasehq/stagehand')],
  ];
  for (const [label, vulnerabilities, expected] of cases) assert.deepEqual(blocked(vulnerabilities), expected, label);
});

test('a package reached through two accepted exceptions carries both advisories and the earlier expiry', () => {
  const both = { ...zodChain(), 'brace-expansion': braceExpansion(), '@parcha/agentrun-harness': dependent('@parcha/agentrun-harness', ['@parcha/pi-browser', 'brace-expansion']) };
  assert.deepEqual(auditBlockers(audit(both), before).accepted.find(entry => entry.package === '@parcha/agentrun-harness'),
    { package: '@parcha/agentrun-harness', severity: 'high', advisories: ['GHSA-mrhx-c7xc-m3w5', 'GHSA-q2hr-2g5m-vwhr', 'GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p'], expires: '2026-11-06' });
});

test('a moderate or low package beside the accepted chain blocks nothing, and is never accepted or merged into it', () => {
  // As main's consumer has it: undici's moderate advisories reach pi-browser and the harness through other packages.
  const moderate = (name, via) => ({ ...dependent(name, via), severity: 'moderate' });
  const vulnerabilities = zodChain({
    '@parcha/pi-browser': dependent('@parcha/pi-browser', ['@browserbasehq/stagehand', '@earendil-works/pi-coding-agent']),
    '@parcha/agentrun-harness': dependent('@parcha/agentrun-harness', ['@parcha/agentrun-pi', '@parcha/pi-browser']),
    '@earendil-works/pi-coding-agent': moderate('@earendil-works/pi-coding-agent', ['undici']),
    '@parcha/agentrun-pi': moderate('@parcha/agentrun-pi', ['@earendil-works/pi-coding-agent']),
    undici: { name: 'undici', severity: 'moderate', isDirect: false, effects: [], nodes: ['node_modules/undici'], via: [advisory('GHSA-dddd-eeee-ffff', 'moderate')] },
  });
  assert.deepEqual(auditBlockers(audit(vulnerabilities), before), {
    accepted: chainNames.map(name => ({ package: name, severity: 'high', advisories: ['GHSA-mrhx-c7xc-m3w5'], expires: '2026-11-06' })),
    blocking: [],
  });
});
