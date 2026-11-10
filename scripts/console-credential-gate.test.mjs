// The console's credential gate (apps/console/credential-gate.mjs): `vite build` fails when the browser bundle, the
// notices included, holds credential-shaped text or one of the console's tests, fixtures, samples, mocks or stories. Every
// fake credential here is put together at run time, so this file does not itself look like one to a secret scanner.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNoCredential, consoleSourceOf, credentialGate, credentialKind, isNonProduction, safeName } from '../apps/console/credential-gate.mjs';
import { NOTICES_FILE, thirdPartyNotices } from '../apps/console/third-party-notices.mjs';

const fakes = {
  'private key': ['-----BEGIN ' + 'PRIVATE KEY-----', '-----BEGIN RSA ' + 'PRIVATE KEY-----', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', '-----BEGIN ENCRYPTED ' + 'PRIVATE KEY-----'],
  'GitHub token': ['gh' + 'p_' + 'a'.repeat(36), 'gh' + 'o_' + 'A1'.repeat(18), 'gh' + 'u_' + 'b'.repeat(40), 'gh' + 's_' + 'c'.repeat(36), 'gh' + 'r_' + 'd'.repeat(36), 'github' + '_pat_' + 'e'.repeat(22) + '_' + 'f'.repeat(59)],
  'API key (sk-)': ['s' + 'k-' + 'g'.repeat(48), 's' + 'k-proj-' + 'h'.repeat(60), 's' + 'k-ant-api03-' + 'i'.repeat(60), 's' + 'k-ant-admin01-' + 'j'.repeat(40)],
  'Slack token': ['xo' + 'xb-' + '1234567890-'.repeat(3) + 'k'.repeat(8), 'xo' + 'xp-' + 'l'.repeat(30), 'xo' + 'xe-' + 'm'.repeat(30)],
  'AWS access key': ['AK' + 'IA' + 'N'.repeat(16), 'AS' + 'IA' + 'O1'.repeat(8)],
  'signed token (JWT)': [['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiJzeW50aGV0aWMifQ', 'p'.repeat(32)].join('.')],
  'URL with a password': ['https://' + 'synthetic-user:' + 'synthetic-pass' + '@example.invalid/api', 'postgres://' + 'u:' + 'p' + '@db.invalid:5432/x'],
};

/** Runs the plugin's generateBundle over `bundle`, as Vite does at the end of a build; returns what it threw, if anything. */
function run(bundle, root = '/w/apps/console') {
  const plugin = credentialGate();
  plugin.configResolved({ root });
  try { plugin.generateBundle.call({}, {}, bundle); return undefined; } catch (error) { return error; }
}

test('each credential shape is found and named by its kind', () => {
  for (const [kind, texts] of Object.entries(fakes)) {
    for (const text of texts) {
      assert.equal(credentialKind(text), kind, `the ${kind} shape`);
      assert.equal(credentialKind(`const value = "${text}";`), kind, `the ${kind} shape inside code`);
    }
  }
});

test('what the console and its libraries really hold is not a credential', () => {
  for (const text of [
    'fetch("/v2/agents")', 'Authorization: `Bearer ${token}`', 'provider/model', 'https://example.invalid/v2', 'mailto:someone@example.invalid',
    'https://user@example.invalid/', 'task-list-item', 'disk-usage-indicator-component', 'xoxb-short', 'AKIA-not-a-key', 'eyJhbGciOiJIUzI1NiJ9',
    'ghp_short', 'sk-ns', 'BEGIN PUBLIC KEY', '-----BEGIN CERTIFICATE-----', 'http://localhost:4318/v1', 'a:b@c',
  ]) {
    assert.equal(credentialKind(text), undefined, text);
    assert.doesNotThrow(() => assertNoCredential(text, 'assets/index.js'));
  }
});

test('the error names the asset and the kind, never the match; an asset name that looks like a credential is redacted', () => {
  for (const texts of Object.values(fakes)) {
    for (const text of texts) {
      assert.throws(() => assertNoCredential(`x("${text}")`, 'assets/index.js'), (error) => error.message.includes('assets/index.js') && /credential-shaped/.test(error.message) && !error.message.includes(text));
      assert.throws(() => assertNoCredential(text, `assets/${text}.js`), (error) => error.message.includes('[redacted asset name]') && !error.message.includes(text));
      assert.equal(safeName(`assets/${text}.js`), '[redacted asset name]');
    }
  }
  assert.equal(safeName('assets/index-BHJ1AscA.js'), 'assets/index-BHJ1AscA.js');
});

test('a test, fixture, sample, mock or story under src/ is non-production; the console itself and packages are not', () => {
  const root = '/w/apps/console';
  for (const file of [
    'fixtures/capabilities.json', 'components/AgentAnalytics.sample.ts', 'sample.ts', 'components/MissionControl.stories.tsx',
    'components/MissionControl.test.tsx', 'components/Agents.stories.test.tsx', '__mocks__/client.ts', 'lib/client.spec.ts',
    'test/setup.ts', '__fixtures__/run.json', 'lib/client.mock.ts',
  ]) assert.ok(isNonProduction(consoleSourceOf(`${root}/src/${file}?url`, root)), file);
  for (const file of ['components/MissionControl.tsx', 'lib/exampleInput.ts', 'lib/testing-utils.ts', 'components/Contest.tsx', 'lib/latest.ts']) {
    assert.equal(isNonProduction(consoleSourceOf(`${root}/src/${file}`, root)), false, file);
  }
  assert.equal(consoleSourceOf(`${root}/node_modules/clsx/test/mock.js`, root), undefined, 'a package is not the console\'s source');
  assert.equal(consoleSourceOf('/w/packages/dsl/src/test.ts', root), undefined, "the repository's packages are not the console's source");
  assert.equal(consoleSourceOf(`\0${root}/src/fixtures/a.json`, root), 'fixtures/a.json', 'a virtual prefix is ignored');
});

test('the plugin runs last and only at build, and passes a clean bundle of chunks, text assets and binary assets', () => {
  const plugin = credentialGate();
  assert.equal(plugin.apply, 'build');
  assert.equal(plugin.enforce, 'post');
  assert.equal(run({
    'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: 'fetch("/v2/agents")', moduleIds: ['/w/apps/console/src/main.tsx', '/w/apps/console/node_modules/clsx/test/mock.js', '/w/packages/dsl/src/graph.ts'] },
    'assets/index.css': { type: 'asset', fileName: 'assets/index.css', source: 'body{color:red}', originalFileNames: [] },
    'index.html': { type: 'asset', fileName: 'index.html', source: new TextEncoder().encode('<!doctype html>') },
    [NOTICES_FILE]: { type: 'asset', fileName: NOTICES_FILE, source: 'MIT License' },
  }), undefined);
});

test('the plugin refuses a credential in a chunk, a string or byte text asset, an SVG and the notices, but reads no binary asset', () => {
  const key = 'gh' + 'p_' + 'q'.repeat(36);
  for (const item of [
    { type: 'chunk', fileName: 'assets/index.js', code: `const token = "${key}";`, moduleIds: [] },
    { type: 'asset', fileName: 'assets/config.json', source: JSON.stringify({ key: 's' + 'k-proj-' + 'r'.repeat(60) }) },
    { type: 'asset', fileName: 'assets/data.json', source: new TextEncoder().encode(JSON.stringify({ key })) },
    { type: 'asset', fileName: 'assets/note.svg', source: '<svg><text>' + '-----BEGIN ' + 'PRIVATE KEY-----' + '</text></svg>' },
    { type: 'asset', fileName: 'index.html', source: `<meta content="${key}">` },
    { type: 'asset', fileName: 'assets/index.css', source: `/* ${key} */` },
    { type: 'asset', fileName: NOTICES_FILE, source: `Copyright\n${'AK' + 'IA' + 'S'.repeat(16)}\n` },
  ]) {
    const error = run({ [item.fileName]: item });
    assert.ok(error, item.fileName);
    assert.match(error.message, /credential-shaped/);
    assert.ok(error.message.includes(item.fileName), item.fileName);
    assert.ok(!error.message.includes(key));
  }
  assert.equal(run({ 'assets/font.woff2': { type: 'asset', fileName: 'assets/font.woff2', source: new TextEncoder().encode(key) } }), undefined, 'a font is not read as text');
  const named = run({ [`assets/${key}.js`]: { type: 'chunk', fileName: `assets/${key}.js`, code: key, moduleIds: [] } });
  assert.match(named.message, /\[redacted asset name\]/);
  assert.ok(!named.message.includes(key));
});

test('the plugin refuses a bundle that took in a non-production module, as a chunk module or as an asset source', () => {
  const root = '/w/apps/console';
  for (const file of ['src/fixtures/capabilities.json', 'src/components/AgentAnalytics.sample.ts', 'src/components/MissionControl.stories.tsx', 'src/components/MissionControl.test.tsx', 'src/__mocks__/client.ts', 'src/fixtures/recorded.json?url']) {
    const error = run({ 'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: '', moduleIds: [`${root}/${file}`] } }, root);
    assert.match(error?.message ?? '', /non-production module/, file);
    assert.ok(error.message.includes(file.split('?')[0]), file);
  }
  const asset = run({ 'assets/recorded.json': { type: 'asset', fileName: 'assets/recorded.json', source: '{}', originalFileNames: ['src/fixtures/recorded.json'] } }, root);
  assert.match(asset?.message ?? '', /non-production module, src\/fixtures\/recorded\.json/);
});

test('run after the notices plugin over the same bundle, the gate reads the notices it emitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-gate-'));
  try {
    await mkdir(join(root, 'node_modules', 'leaky'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'leaky', 'package.json'), JSON.stringify({ name: 'leaky', version: '1.0.0', license: 'MIT' }));
    await writeFile(join(root, 'node_modules', 'leaky', 'LICENSE'), `MIT License\nsee https://${'someone:' + 'hunter2'}@example.invalid/\n`);
    const bundle = { 'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: '', moduleIds: [join(root, 'node_modules', 'leaky', 'index.js')] } };
    // Rollup puts a file a plugin emits in generateBundle into the bundle the later plugins get.
    const context = { emitFile: (file) => { bundle[file.fileName] = { type: 'asset', ...file }; } };
    const notices = thirdPartyNotices();
    notices.configResolved({ root });
    notices.generateBundle.call(context, {}, bundle);
    const gate = credentialGate();
    gate.configResolved({ root });
    assert.throws(() => gate.generateBundle.call(context, {}, bundle), (error) => error.message.includes(NOTICES_FILE) && /URL with a password/.test(error.message) && !error.message.includes('hunter2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
