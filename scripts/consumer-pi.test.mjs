import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPiFamily, developedVersions, laggingWorkspaces, listCopies, satisfies } from './consumer-pi.mjs';

const scope = '@earendil-works';
const durable = `${scope}/pi-durable`;
const chord = `${scope}/chord`;

test('ranges are read the way npm reads them', () => {
  assert.equal(satisfies('1.0.4', '>=1.0.0 <1.1.0'), true);
  assert.equal(satisfies('1.1.0', '>=1.0.0 <1.1.0'), false);
  assert.equal(satisfies('1.1.0', '>=1.0.4 <1.2.0'), true);
  assert.equal(satisfies('1.2.0', '>=1.0.4 <1.2.0'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('1.4.0', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  assert.equal(satisfies('0.2.5', '^0.2.1'), true);
  assert.equal(satisfies('0.3.0', '^0.2.1'), false);
  assert.equal(satisfies('1.2.9', '~1.2.0'), true);
  assert.equal(satisfies('1.3.0', '~1.2.0'), false);
  assert.equal(satisfies('1.5.0', '1.x'), true);
  assert.equal(satisfies('1.1.0', '1.0.4 || 1.1.0'), true);
  assert.equal(satisfies('1.1.1', '>1.1.0'), true);
  assert.equal(satisfies('1.1.0', '>1.1.0'), false);
  assert.equal(satisfies('1.1.0', '<=1.1.0'), true);
  assert.throws(() => satisfies('1.0.0', 'latest'), /Unsupported version range/);
});

// Cases from npm's semver documentation (Advanced Range Syntax and Prerelease Tags): [version, range, satisfies].
const npmCases = [
  ['1.2.3', '^1.2.3', true], ['1.9.9', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.2.2', '^1.2.3', false],
  ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false],
  ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
  ['1.2.9', '^1.2.x', true], ['2.0.0', '^1.2.x', false],
  ['0.0.9', '^0.0.x', true], ['0.1.0', '^0.0.x', false], ['0.0.9', '^0.0', true], ['0.1.0', '^0.0', false],
  ['1.9.0', '^1.x', true], ['2.0.0', '^1.x', false],
  ['0.2.0', '^0.x', true], ['0.9.9', '^0.x', true], ['1.0.0', '^0.x', false],
  ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.2.9', '~1.2', true], ['1.3.0', '~1.2', false],
  ['1.9.9', '~1', true], ['2.0.0', '~1', false], ['0.2.9', '~0.2.3', true], ['0.3.0', '~0.2.3', false],
  ['0.9.9', '~0', true], ['1.0.0', '~0', false],
  ['1.2.9', '1.2.x', true], ['1.3.0', '1.2.x', false], ['1.9.9', '1', true], ['2.0.0', '1', false],
  ['1.2.3', '>=1.2.3 <1.2.4', true], ['1.2.4', '>=1.2.3 <1.2.4', false],
  ['1.3.0', '>1.2', true], ['1.2.9', '>1.2', false], ['1.2.9', '<=1.2', true], ['1.3.0', '<=1.2', false],
  ['1.2.3-beta.4', '^1.2.3-beta.2', true], ['1.2.3-beta.1', '^1.2.3-beta.2', false],
  ['1.2.3', '^1.2.3-beta.2', true], ['1.2.4-beta.2', '^1.2.3-beta.2', false], ['1.3.0-beta.2', '^1.2.3-beta.2', false],
  ['1.2.3-alpha.7', '>1.2.3-alpha.3', true], ['3.4.5-alpha.9', '>1.2.3-alpha.3', false],
  ['1.2.3-alpha.3', '>=1.2.3-alpha.3 <1.2.3', true], ['1.2.3-beta', '>=1.2.3-alpha.3 <1.2.3', true], ['1.2.3-alpha.1', '>=1.2.3-alpha.3 <1.2.3', false],
  ['1.2.3-alpha.10', '>1.2.3-alpha.9', true], ['1.2.3-alpha.beta', '>1.2.3-alpha.1', true],
  ['1.1.0-beta.1', '>=1.0.4 <1.2.0', false], ['1.1.0-beta.1', '>=1.1.0-beta.0 <1.2.0', true],
  ['1.0.4-rc.1', '>=1.0.4', false], ['1.0.4', '>=1.0.4 <1.2.0', true],
];

test('ranges and prerelease tags are read the way npm documents them', () => {
  for (const [version, range, expected] of npmCases) assert.equal(satisfies(version, range), expected, `${version} against ${range}`);
});

test('the developed version is what the root lockfile resolves for the pi package', () => {
  const lock = {
    [`node_modules/${durable}`]: { version: '1.0.4' },
    [`node_modules/${chord}`]: { version: '1.0.4' },
    [`packages/pi/node_modules/${durable}`]: { version: '1.1.0' },
    [`packages/pi/node_modules/${chord}`]: { version: '1.1.0' },
    'packages/pi': { name: '@parcha/agentrun-pi' },
  };
  assert.deepEqual(developedVersions(lock), { [durable]: '1.1.0', [chord]: '1.1.0' });
  const flat = { ...lock };
  delete flat[`packages/pi/node_modules/${durable}`];
  delete flat[`packages/pi/node_modules/${chord}`];
  assert.deepEqual(developedVersions(flat), { [durable]: '1.0.4', [chord]: '1.0.4' });
  assert.throws(() => developedVersions({ 'packages/pi': {} }), /does not resolve/);
});

test('every copy is listed with its location', () => {
  const copies = listCopies({
    '': {}, 'node_modules/typebox': { version: '1.0.0' },
    [`node_modules/${durable}`]: { version: '1.0.4' },
    [`node_modules/@parcha/pi-vision/node_modules/${durable}`]: { version: '1.1.0' },
  });
  assert.deepEqual(copies, [
    { name: durable, version: '1.0.4', location: `node_modules/${durable}` },
    { name: durable, version: '1.1.0', location: `node_modules/@parcha/pi-vision/node_modules/${durable}` },
  ]);
});

const peers = {
  '@parcha/pi-browser': { [durable]: '>=1.0.0 <1.1.0', [chord]: '>=1.0.0 <1.1.0' },
  '@parcha/pi-vision': { [durable]: '>=1.0.4 <1.2.0', [chord]: '>=1.0.4 <1.2.0' },
};
const developed = { [durable]: '1.1.0', [chord]: '1.1.0' };
const copy = (name, version, location = `node_modules/${name}`) => ({ name, version, location });

test('a consumer below the developed version names the package whose range holds it there', () => {
  const problems = checkPiFamily([copy(durable, '1.0.4'), copy(chord, '1.0.4')], developed, peers);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /resolved @earendil-works\/pi-durable@1\.0\.4/);
  assert.match(problems[0], /develops the durable packages on 1\.1\.0/);
  assert.match(problems[0], /@parcha\/pi-browser \(peer @earendil-works\/pi-durable ">=1\.0\.0 <1\.1\.0"\)/);
  assert.doesNotMatch(problems[0], /pi-vision/);
});

test('a consumer at the developed version has no problem', () => {
  assert.deepEqual(checkPiFamily([copy(durable, '1.1.0'), copy(chord, '1.1.0')], developed, { '@parcha/pi-browser': { [durable]: '>=1.1.0 <1.3.0', [chord]: '>=1.1.0 <1.3.0' } }), []);
});

test('two copies of one package are a problem even when one is the developed version', () => {
  const problems = checkPiFamily([copy(durable, '1.1.0'), copy(durable, '1.0.4', 'node_modules/x/node_modules/y'), copy(chord, '1.1.0')], developed, peers);
  assert.ok(problems.some(problem => /holds 2 copies of @earendil-works\/pi-durable/.test(problem)));
});

test('a missing package is a problem', () => {
  assert.match(checkPiFamily([copy(chord, '1.1.0')], developed, peers)[0], /holds 0 copies of @earendil-works\/pi-durable/);
});

test('a version below the developed one with no blocking range says only what was resolved', () => {
  const [problem] = checkPiFamily([copy(durable, '1.0.4'), copy(chord, '1.1.0')], developed, { '@parcha/pi-vision': peers['@parcha/pi-vision'] });
  assert.doesNotMatch(problem, /widen/);
});

test('a workspace package that still develops on the older copy is named beside the peer range', () => {
  const lock = {
    [`node_modules/${durable}`]: { version: '1.0.4' },
    [`node_modules/${chord}`]: { version: '1.0.4' },
    [`packages/pi/node_modules/${durable}`]: { version: '1.1.0' },
    [`packages/pi/node_modules/${chord}`]: { version: '1.1.0' },
    'packages/pi': { name: '@parcha/agentrun-pi', devDependencies: { [durable]: '1.1.0', [chord]: '1.1.0' } },
    'packages/pi-vision': { name: '@parcha/pi-vision', devDependencies: { [durable]: '1.0.4', [chord]: '1.0.4' } },
    'packages/dsl': { name: '@parcha/agentrun-dsl' },
  };
  const lagging = laggingWorkspaces(lock, developed);
  assert.deepEqual(lagging.map(entry => `${entry.package} ${entry.name} ${entry.version}`), [`@parcha/pi-vision ${durable} 1.0.4`, `@parcha/pi-vision ${chord} 1.0.4`]);
  const [problem] = checkPiFamily([copy(durable, '1.0.4'), copy(chord, '1.1.0')], developed, peers, lagging);
  assert.match(problem, /pi-browser \(peer/);
  assert.match(problem, /still holds 1\.0\.4 for @parcha\/pi-vision \(devDependencies resolve @earendil-works\/pi-durable@1\.0\.4\)/);
  assert.match(problem, /move those devDependencies to 1\.1\.0/);
  const [clean] = checkPiFamily([copy(durable, '1.0.4'), copy(chord, '1.1.0')], developed, { '@parcha/pi-vision': peers['@parcha/pi-vision'] }, []);
  assert.doesNotMatch(clean, /devDependencies/);
});

test('a peer range that excludes the version is named even when the consumer holds that version', () => {
  const copies = [{ name: durable, version: '1.2.0', location: 'node_modules/x' }, { name: chord, version: '1.2.0', location: 'node_modules/y' }];
  const developed = { [durable]: '1.2.0', [chord]: '1.2.0' };
  assert.deepEqual(checkPiFamily(copies, developed, { '@parcha/pi-x': { [durable]: '>=1.0.0 <1.2.0' } }).length, 1);
  assert.match(checkPiFamily(copies, developed, { '@parcha/pi-x': { [durable]: '>=1.0.0 <1.2.0' } })[0], /peer range of @parcha\/pi-x .* excludes 1\.2\.0, the version the consumer holds/);
  assert.deepEqual(checkPiFamily(copies, developed, { '@parcha/pi-x': { [durable]: '>=1.0.0 <1.3.0' } }), []);
});
