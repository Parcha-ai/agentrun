// The README version-drift check (scripts/version-drift.mjs). It reads only the lines that ARE install or version statements, by
// a structural rule it names (STRUCTURE), so it leaves alone what a grep over prose would hit and is right as it stands: recorded
// fixtures, history and minimums. On this repository's own docs it finds nothing; on a tree with stale lines it names each one.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { docFiles, driftOf, RULES, specsOf, statementsOf, STRUCTURE } from './version-drift.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'version-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}
const base = {
  'package.json': { name: 'ws', version: '0.1.0-beta.14' },
  'packages/pi/package.json': { name: '@parcha/agentrun-pi', version: '0.1.0-beta.14', peerDependencies: { '@earendil-works/pi-durable': '>=1.0.4 <1.4.0', '@earendil-works/pi-coding-agent': '*' } },
};

test('the rule is named: five kinds of line are statements, and each rule says what it holds', () => {
  assert.equal(STRUCTURE.length, 5);
  assert.deepEqual(Object.keys(RULES).sort(), ['bare-npx', 'pi-range', 'release', 'release-statement']);
});

test('this repository\'s own docs, examples and starter name the current release, the packages\' Pi range and no bare npx', () => {
  assert.deepEqual(driftOf(repo), []);
});

test('on a tree with stale lines it names each one, with its file, line and rule', (t) => {
  const root = tree(t, {
    ...base,
    'README.md': [
      '# Title', '', 'This release is `0.1.0-beta.4`. See the changelog.', '',
      '```sh', 'npm install @parcha/agentrun-dsl@0.1.0-beta.4', 'npx agentrun demo', 'npm install -g @earendil-works/pi-coding-agent@1.4.0', '```', '',
      '| Package | Try |', '| --- | --- |', '| dsl | `npx agentrun demo` |', '| pi | `pi install npm:@parcha/agentrun-pi@^0.1.0-beta.9` |', '',
      'Install `npm i @earendil-works/pi-durable@>=1.1.0 <1.4.0` first.', 'Beta: `0.1.0-beta.4`. Requires Pi 1.0.4 to below 1.5 (CI tests 1.3.0).',
    ].join('\n'),
    'docs/guide.md': ['```bash', '$ npx @parcha/agentrun-dsl@0.1.0-beta.13 validate workflow.json', 'npm install @parcha/agentrun-jev@0.1.0-beta.14 @parcha/agentrun-dsl@0.1.0-beta.2', '```'].join('\n'),
    'examples/starter/README.md': 'Nothing to install here.\n',
    'examples/starter/package.json': { dependencies: { '@parcha/agentrun-dsl': '0.1.0-beta.4', '@parcha/agentrun-jev': '0.1.0-beta.14', zod: '4.6.5' } },
  });
  const found = driftOf(root).map(({ file, line, rule }) => `${file}:${line} ${rule}`).sort();
  assert.deepEqual(found, [
    'README.md:3 release-statement',
    'README.md:6 release',
    'README.md:7 bare-npx',
    'README.md:8 pi-range',
    'README.md:13 bare-npx',
    'README.md:14 release',
    'README.md:16 pi-range',
    'README.md:17 pi-range',
    'README.md:17 release-statement',
    'docs/guide.md:2 release',
    'docs/guide.md:3 release',
    'examples/starter/package.json:0 release',
  ].sort());
});

test('what a grep would hit and is right as it stands is not read: history, fixtures, minimums, comments and other fences', (t) => {
  const root = tree(t, {
    ...base,
    'README.md': [
      'This release is `0.1.0-beta.14`.', '', 'Needs Pi 1.1.0 or later. Since 0.1.0-beta.4 the CLI takes `--trusted`. | Since | `0.1.0-beta.4` |', 'Pi 1.0.4 to below 1.4 (CI tests 1.0.4, 1.1.0, 1.2.0 and 1.3.0). Optional peers from 1.0.4 to below 1.4.', '',
      '```json', '{ "dependencies": { "@parcha/agentrun-dsl": "0.1.0-beta.4" } }', '```', '',
      '```ts', "import x from '@parcha/agentrun-dsl@0.1.0-beta.4';", '```', '',
      '```sh', '# npm install @parcha/agentrun-dsl@0.1.0-beta.4', 'npm install @parcha/agentrun-dsl', 'npm install @parcha/agentrun-dsl@beta', 'npm install -g @earendil-works/pi-coding-agent', 'npm install -g @earendil-works/pi-coding-agent@1.3.0', 'npm install @earendil-works/pi-durable@">=1.0.4 <1.4.0"', 'npx @parcha/agentrun-dsl@0.1.0-beta.14 demo', 'npx tsx script.ts', '```',
    ].join('\n'),
    'CHANGELOG.md': '```sh\nnpm install @parcha/agentrun-dsl@0.1.0-beta.4\nnpx agentrun demo\n```\nThis release is `0.1.0-beta.1`.\n',
    'changes/old.md': 'npm install @parcha/agentrun-dsl@0.1.0-beta.4\n',
    'apps/viewer/recordings/run/events.jsonl': '{"text":"npx agentrun demo @parcha/agentrun-dsl@0.1.0-beta.4"}\n',
    'apps/viewer/test/fixtures/README.md': '```sh\nnpx agentrun demo\n```\n',
    'packages/dsl/skills/author/SKILL.md': '```sh\nnpx agentrun demo\n```\n',
  });
  assert.deepEqual(driftOf(root), []);
  const { markdown, manifests } = docFiles(root);
  assert.deepEqual(markdown, ['README.md']);
  assert.deepEqual(manifests, []);
});

test('the statements of a file, by line: a fenced shell command, an inline command, the release line; not a comment, a json fence or prose', () => {
  const text = ['This release is `1.0.0`.', 'Beta: `1.0.0`. Pi 1.0.4 to below 1.4.', 'Run `npx @parcha/agentrun-dsl@1.0.0 demo` or read `npm` docs.', '```', '$ npm i a@1 && npx b', '```', '~~~console', 'pi install npm:@x/y@2', '~~~', '```json', 'npm i nope', '```', 'npm i not-a-code-block'].join('\n');
  assert.deepEqual(statementsOf(text).map(({ line, kind, text: found }) => [line, kind, found]), [
    [1, 'release-statement', 'This release is `1.0.0`.'],
    [2, 'release-statement', 'Beta: `1.0.0`. Pi 1.0.4 to below 1.4.'],
    [2, 'pi-statement', 'Beta: `1.0.0`. Pi 1.0.4 to below 1.4.'],
    [3, 'command', 'npx @parcha/agentrun-dsl@1.0.0 demo'],
    [5, 'command', 'npm i a@1'],
    [5, 'command', 'npx b'],
    [8, 'command', 'pi install npm:@x/y@2'],
  ]);
  assert.deepEqual(specsOf('npm install -g @earendil-works/pi-coding-agent@1.3.0 typebox').map(({ name, spec }) => [name, spec]), [['@earendil-works/pi-coding-agent', '1.3.0'], ['typebox', undefined]]);
  assert.deepEqual(specsOf('npx --yes @parcha/agentrun-dsl@1.0.0 validate workflow.json').map(({ name, spec }) => [name, spec]), [['@parcha/agentrun-dsl', '1.0.0']]);
  assert.deepEqual(specsOf('pi install npm:@parcha/agentrun-pi@1.0.0').map(({ name, spec }) => [name, spec]), [['@parcha/agentrun-pi', '1.0.0']]);
});
