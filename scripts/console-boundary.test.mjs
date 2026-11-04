import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertBrowserText, assertBundledPackage, assertConsoleDependencies, consoleBoundary } from '../apps/console/build-boundary.mjs';

test('the browser boundary refuses private integrations in dependencies and emitted assets', () => {
  assert.doesNotThrow(() => assertConsoleDependencies({ dependencies: { react: '18.3.1', clsx: '2.1.1' } }));
  assert.throws(() => assertConsoleDependencies({ dependencies: { '@descope/react-sdk': '1.0.0' } }), /unreviewed/);
  assert.doesNotThrow(() => assertBundledPackage('scheduler'));
  assert.throws(() => assertBundledPackage('private-integration-sdk'), /unreviewed/);
  for (const text of ['fetch("https://' + ['grep', 'ai'].join('.') + '/api")', 'posthog.capture("event")', 'https://docs.' + ['parcha', 'dev'].join('.')]) {
    assert.throws(() => assertBrowserText(text, 'assets/app.js'), /private integration/);
  }
  assert.doesNotThrow(() => assertBrowserText('fetch("/v2/agents")', 'assets/app.js'));
});

test('the guarded bundle refuses nonproduction console modules and emits canonical notices once in its public manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'console-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, text) => { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), text); };
  await put('package.json', JSON.stringify({ dependencies: { clsx: '2.1.1' } }));
  for (const [name, version, license] of [
    ['clsx', '2.1.1', 'MIT'], ['dompurify', '3.2.3', '(MPL-2.0 OR Apache-2.0)'],
    ['@fontsource/jetbrains-mono', '5.1.1', 'OFL-1.1'], ['@fontsource/schibsted-grotesk', '5.1.1', 'OFL-1.1'],
  ]) {
    await put(`node_modules/${name}/package.json`, JSON.stringify({ name, version, license }));
    await put(`node_modules/${name}/LICENSE`, `${name} license text\n`);
  }
  const plugin = consoleBoundary();
  plugin.configResolved({ root });
  const emitted = [];
  for (const file of [
    'src/fixtures/capabilities.json', 'src/components/AgentAnalytics.sample.ts', 'src/sample.ts',
    'src/components/MissionControl.stories.tsx', 'src/components/MissionControl.test.tsx',
    'src/__mocks__/client.ts', 'src/lib/client.spec.ts', 'src/fixtures/recorded.json?url',
  ]) {
    assert.throws(() => plugin.generateBundle.call({ emitFile: (item) => emitted.push(item) }, {}, {
      'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: '', moduleIds: [join(root, file)] },
    }), /Nonproduction console module/);
  }
  assert.equal(emitted.length, 0);
  plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) }, {}, {
    'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: '', moduleIds: [`${root}/src/components/MissionControl.tsx`, `${root}/src/lib/exampleInput.ts`, `${root}/node_modules/clsx/test/mock.js`] },
    'assets/index.css': { type: 'asset', fileName: 'assets/index.css', source: '', originalFileNames: ['node_modules/dompurify/dist/purify.css'] },
    'assets/font.woff2': { type: 'asset', fileName: 'assets/font.woff2', source: '', originalFileNames: ['node_modules/@fontsource/jetbrains-mono/files/font.woff2'] },
  });
  const notices = emitted.filter((file) => file.fileName === 'THIRD-PARTY-NOTICES.txt');
  assert.equal(notices.length, 1);
  assert.match(notices[0].source, /^Third-party software in the AgentRun console\n/);
  for (const name of ['clsx', 'dompurify', '@fontsource/jetbrains-mono', '@fontsource/schibsted-grotesk']) {
    assert.ok(notices[0].source.includes(`${name} license text`), `the license text for ${name} is distributed`);
  }
  assert.match(notices[0].source, /^dompurify 3\.2\.3 \(MPL-2\.0 OR Apache-2\.0\)\n/m);
  assert.equal(notices[0].source.match(/^@fontsource\/jetbrains-mono 5\.1\.1/gm).length, 1);
  assert.deepEqual(JSON.parse(emitted.find((file) => file.fileName === 'asset-manifest.json').source).files,
    ['THIRD-PARTY-NOTICES.txt', 'assets/font.woff2', 'assets/index.css', 'assets/index.js']);
});
