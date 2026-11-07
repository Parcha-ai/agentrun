import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIT_EXCEPTIONS, auditBlockers } from './audit-exceptions.mjs';

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
// How a chain is judged is tested on a fixture list: the real one, plus an exception for Stagehand's own zod as the gate
// carried until Stagehand 4.4.0 (zod 4.6.6, fixed) removed it.
const ZOD = { package: 'zod', under: 'node_modules/@browserbasehq/stagehand/', advisories: ['GHSA-mrhx-c7xc-m3w5'], expires: '2026-11-06' };
const withZod = [...AUDIT_EXCEPTIONS, ZOD];
const blocked = (vulnerabilities, now = before, exceptions = withZod) => auditBlockers(audit(vulnerabilities), now, exceptions).blocking.map(entry => entry.package).sort();

test("the real list accepts no zod: Stagehand's own zod, and each package it reaches, block", () => {
  assert.equal(AUDIT_EXCEPTIONS.some(exception => exception.package === 'zod'), false);
  assert.deepEqual(blocked(zodChain(), before, AUDIT_EXCEPTIONS), [...chainNames].sort());
});

test("an exception for one nested copy accepts it, and each package vulnerable only through it, until it expires", () => {
  assert.deepEqual(auditBlockers(audit(zodChain()), before, withZod), {
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
  assert.deepEqual(auditBlockers(audit(both), before, withZod).accepted.find(entry => entry.package === '@parcha/agentrun-harness'),
    { package: '@parcha/agentrun-harness', severity: 'high', advisories: ['GHSA-mrhx-c7xc-m3w5', 'GHSA-q2hr-2g5m-vwhr', 'GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p'], expires: '2026-11-06' });
});

test('a moderate or low package beside the accepted chain blocks nothing, and is never accepted or merged into it', () => {
  const moderate = (name, via) => ({ ...dependent(name, via), severity: 'moderate' });
  const vulnerabilities = zodChain({
    '@parcha/pi-browser': dependent('@parcha/pi-browser', ['@browserbasehq/stagehand', '@earendil-works/pi-coding-agent']),
    '@parcha/agentrun-harness': dependent('@parcha/agentrun-harness', ['@parcha/agentrun-pi', '@parcha/pi-browser']),
    '@earendil-works/pi-coding-agent': moderate('@earendil-works/pi-coding-agent', ['undici']),
    '@parcha/agentrun-pi': moderate('@parcha/agentrun-pi', ['@earendil-works/pi-coding-agent']),
    undici: { name: 'undici', severity: 'moderate', isDirect: false, effects: [], nodes: ['node_modules/undici'], via: [advisory('GHSA-dddd-eeee-ffff', 'moderate')] },
  });
  assert.deepEqual(auditBlockers(audit(vulnerabilities), before, withZod), {
    accepted: chainNames.map(name => ({ package: name, severity: 'high', advisories: ['GHSA-mrhx-c7xc-m3w5'], expires: '2026-11-06' })),
    blocking: [],
  });
});

const codingAgentUndici = 'node_modules/@earendil-works/pi-coding-agent/node_modules/undici';
const diskUndici = 'node_modules/disk/node_modules/undici';
// The three from 2026-10-24, then the five published by 2026-10-27, all fixed in 8.12.2.
const undiciAdvisories = [advisory('GHSA-4qv8-2p9j-2685', 'moderate'), advisory('GHSA-f72v-6w45-q472', 'moderate'), advisory('GHSA-xjj6-f33q-929c', 'high'),
  advisory('GHSA-4w7w-5xrc-9h26', 'high'), advisory('GHSA-2m5v-pch6-74hx', 'high'), advisory('GHSA-qrxm-fqhp-jwvm', 'high'), advisory('GHSA-9fm3-97px-rjf6', 'moderate'),
  advisory('GHSA-55wc-3pg8-jfw6', 'moderate')];
const undiciIds = undiciAdvisories.map(via => via.title);
const moderatePackage = (name, via) => ({ ...dependent(name, via), severity: 'moderate' });
// As the package check's consumer has it with disk 1.12.0 and Stagehand 4.4.0: only pi-coding-agent's own undici is left.
const withUndici = (overrides = {}) => ({
  undici: { name: 'undici', severity: 'high', isDirect: false, effects: ['@earendil-works/pi-coding-agent'], nodes: [codingAgentUndici], via: undiciAdvisories },
  '@earendil-works/pi-coding-agent': moderatePackage('@earendil-works/pi-coding-agent', ['undici']),
  '@parcha/agentrun-pi': moderatePackage('@parcha/agentrun-pi', ['@earendil-works/pi-coding-agent']),
  '@parcha/pi-browser': dependent('@parcha/pi-browser', ['@earendil-works/pi-coding-agent', 'undici']),
  '@parcha/agentrun-harness': dependent('@parcha/agentrun-harness', ['@parcha/agentrun-pi', '@parcha/pi-browser']),
  ...overrides,
});
const undiciChain = ['undici', '@parcha/pi-browser', '@parcha/agentrun-harness'];
const realBlocked = (vulnerabilities, now = before) => blocked(vulnerabilities, now, AUDIT_EXCEPTIONS);

test("pi-coding-agent's own undici, and each package vulnerable only through it, are accepted until 2026-11-13", () => {
  const { accepted, blocking } = auditBlockers(audit(withUndici()), before);
  assert.deepEqual(blocking, []);
  assert.deepEqual(accepted.find(entry => entry.package === 'undici'), { package: 'undici', severity: 'high', advisories: undiciIds, expires: '2026-11-13' });
  assert.deepEqual(accepted.map(entry => entry.package).sort(), [...undiciChain].sort(), 'nothing else is accepted');
  assert.deepEqual(realBlocked(withUndici(), Date.parse('2026-11-12T23:59:59Z')), [], 'still accepted the second before it expires');
  assert.deepEqual(realBlocked(withUndici(), Date.parse('2026-11-13T00:00:00Z')), [...undiciChain].sort(), 'an expired exception accepts nothing');
});

test("the disk SDK's undici is no longer accepted (disk 1.12.0 takes the fixed one): a copy there blocks", () => {
  assert.ok(realBlocked(withUndici({ undici: { ...withUndici().undici, nodes: [codingAgentUndici, diskUndici] } })).includes('undici'));
  assert.ok(realBlocked(withUndici({ undici: { ...withUndici().undici, nodes: [diskUndici] } })).includes('undici'));
});

test('undici anywhere else, or with another advisory, blocks; the exception narrowed by any one advisory accepts nothing', () => {
  const undici = withUndici().undici;
  const cases = [
    ['a copy at the top level', withUndici({ undici: { ...undici, nodes: [codingAgentUndici, 'node_modules/undici'] } })],
    ['a copy under another parent', withUndici({ undici: { ...undici, nodes: [codingAgentUndici, 'node_modules/@parcha/pi-transport/node_modules/undici'] } })],
    ['another undici advisory', withUndici({ undici: { ...undici, via: [...undiciAdvisories, advisory('GHSA-pppp-qqqq-rrrr', 'high')] } })],
  ];
  for (const [label, vulnerabilities] of cases) assert.ok(realBlocked(vulnerabilities).includes('undici'), label);
  const undiciException = AUDIT_EXCEPTIONS.find(exception => exception.package === 'undici');
  assert.deepEqual([undiciException.under].flat(), ['node_modules/@earendil-works/pi-coding-agent/'], 'only the one nested copy');
  for (const id of undiciException.advisories) {
    const exceptions = AUDIT_EXCEPTIONS.map(exception => (exception === undiciException ? { ...exception, advisories: exception.advisories.filter(other => other !== id) } : exception));
    assert.ok(auditBlockers(audit(withUndici()), before, exceptions).blocking.some(entry => entry.package === 'undici'), id);
  }
});

test('if npm rates pi-coding-agent high through undici, the chain carries it too', () => {
  const vulnerabilities = withUndici({ '@earendil-works/pi-coding-agent': { ...withUndici()['@earendil-works/pi-coding-agent'], severity: 'high' } });
  const { accepted, blocking } = auditBlockers(audit(vulnerabilities), before);
  assert.deepEqual(blocking, []);
  assert.deepEqual(accepted.find(entry => entry.package === '@earendil-works/pi-coding-agent'), { package: '@earendil-works/pi-coding-agent', severity: 'high', advisories: undiciIds, expires: '2026-11-13' });
});
