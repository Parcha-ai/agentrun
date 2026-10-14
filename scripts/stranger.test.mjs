import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { exitCodeOf, extractSnippet, isMissing, judge, loadSpec, readmeInstallArgs, strangerEnv, validateSpec } from './stranger.mjs';

const readme = ['# Title', '', '## Install', '```sh', 'npm i x', '```', '', '## Offline tests', 'text', '```js', 'one();', '```', '```js', 'two();', '```', '### Sub', '```js', 'sub();', '```', '## Next', '```js', 'next();', '```', ''].join('\n');

test('a snippet is the nth block of its language under its heading, subheadings included', () => {
  assert.equal(extractSnippet(readme, { heading: 'Offline tests', fence: 'js' }), 'one();\n');
  assert.equal(extractSnippet(readme, { heading: 'Offline tests', fence: 'js', index: 1 }), 'two();\n');
  assert.equal(extractSnippet(readme, { heading: 'Offline tests', fence: 'js', index: 2 }), 'sub();\n');
  assert.throws(() => extractSnippet(readme, { heading: 'Offline tests', fence: 'js', index: 3 }), /no js block number 3/);
  assert.throws(() => extractSnippet(readme, { heading: 'Offline tests', fence: 'ts' }), /no ts block/);
  assert.throws(() => extractSnippet(readme, { heading: 'Missing', fence: 'js' }), /no heading/);
});

const spec = { expect: { exitCode: 0, pattern: 'Status: complete' }, timeoutMs: 1000 };
const done = (over = {}) => ({ exitCode: 0, stdout: 'Status: complete\n', stderr: '', timedOut: false, ...over });

test('a command passes only with the expected exit code and output', () => {
  assert.deepEqual(judge(spec, done()), []);
  assert.match(judge(spec, done({ exitCode: 1 }))[0], /exit code 1, expected 0/);
  assert.match(judge(spec, done({ stdout: 'nope' }))[0], /does not match/);
  assert.deepEqual(judge({ ...spec, expect: { exitCode: 2, pattern: 'x' } }, done({ exitCode: 2, stdout: 'x' })), []);
  assert.ok(judge(spec, done({ timedOut: true, exitCode: -1 })).some(problem => /no exit within 1000 ms/.test(problem)));
});

test('a stranger starts with the PATH, an empty home and a private cache, and no key', () => {
  const env = strangerEnv('/bin', '/h', '/c');
  assert.deepEqual(Object.keys(env).filter(key => !key.startsWith('npm_config_')), ['PATH', 'HOME']);
  assert.equal(Object.keys(env).some(key => /KEY|TOKEN|SECRET/i.test(key)), false);
});

test('a spec is complete, or says why it has no path', () => {
  assert.throws(() => validateSpec({ package: 'p', expect: 'no-key path missing' }, 'p'), /needs a reason/);
  assert.equal(isMissing(validateSpec({ package: 'p', expect: 'no-key path missing', reason: 'r' }, 'p')), true);
  assert.throws(() => validateSpec({ package: 'p', install: [], command: ['x'], expect: { pattern: 'x' }, timeoutMs: 1 }, 'p'), /install/);
  assert.throws(() => validateSpec({ package: 'p', install: ['dsl'], command: ['x'], expect: {}, timeoutMs: 1 }, 'p'), /expect.pattern/);
});

test('every spec in the repository is valid and every snippet it runs is in its README', async () => {
  const names = (await readdir(new URL('./stranger/', import.meta.url))).map(file => file.replace(/\.json$/, ''));
  assert.ok(names.includes('agentrun-dsl') && names.includes('agentrun-jev'));
  for (const name of names) {
    const loaded = await loadSpec(name);
    for (const file of loaded.files ?? []) {
      const text = extractSnippet(await readFile(new URL(`../${file.readme}`, import.meta.url), 'utf8'), file);
      for (const [from] of file.replace ?? []) assert.ok(text.includes(from), `${name}: ${from}`);
    }
    if (loaded.readmeInstall) {
      // The README's install line installs the spec's package, and reads without a shell.
      const line = extractSnippet(await readFile(new URL(`../${loaded.readmeInstall.readme}`, import.meta.url), 'utf8'), loaded.readmeInstall);
      readmeInstallArgs(line, new Map([[loaded.package, 'packed.tgz']]));
    }
  }
});

test("a README's install line is installed as written, with this tree's packed package in its place", () => {
  const line = 'npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord\n';
  assert.deepEqual(readmeInstallArgs(line), ['install', '@parcha/pi-durable-disk@beta', '@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord']);
  assert.deepEqual(readmeInstallArgs(line, new Map([['@parcha/pi-durable-disk', '/packs/disk.tgz']])),
    ['install', '/packs/disk.tgz', '@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord']);
  assert.deepEqual(readmeInstallArgs('# from an empty directory\nnpm i x@1.2.3 --save-dev\n', new Map([['x', 'x.tgz']])), ['install', 'x.tgz', '--save-dev']);
  assert.throws(() => readmeInstallArgs(line, new Map([['@parcha/agentrun-dsl', 'dsl.tgz']])), /does not install @parcha\/agentrun-dsl/);
  assert.throws(() => readmeInstallArgs('npm install a\nnpm install b\n'), /one command, not 2/);
  assert.throws(() => readmeInstallArgs('npx pi-durable-disk\n'), /runs npm install/);
  assert.throws(() => readmeInstallArgs('npm install "a@>=1 <2"\n'), /needs a shell/);
  assert.throws(() => readmeInstallArgs('npm install a; rm -rf b\n'), /needs a shell/);
});

test('a spec that names a README install line names where it is', () => {
  const spec = { package: 'p', install: ['dsl'], command: ['x'], expect: { pattern: 'x' }, timeoutMs: 1 };
  assert.throws(() => validateSpec({ ...spec, readmeInstall: { readme: 'R.md', heading: 'H' } }, 'p'), /readmeInstall.fence/);
  assert.equal(validateSpec({ ...spec, readmeInstall: { readme: 'R.md', heading: 'H', fence: 'sh' } }, 'p').readmeInstall.fence, 'sh');
});

test('a child killed by a signal, or closed with no code, is a failing exit', () => {
  assert.equal(exitCodeOf(0, null), 0);
  assert.equal(exitCodeOf(3, null), 3);
  assert.equal(exitCodeOf(null, 'SIGKILL'), 137);
  assert.equal(exitCodeOf(null, 'SIGTERM'), 143);
  assert.equal(exitCodeOf(null, null), 1);
});

test('the local box spec accepts the host kernel name, and the Docker spec requires Linux', async () => {
  const output = name => `ok: true\nexitCode: 0\nstdout: Uint8Array(7) [\n  ${name}\n]`;
  const linux = '76, 105, 110, 117, 120, 32, 120';
  const darwin = '68, 97, 114, 119, 105, 110, 32';
  const local = await loadSpec('pi-transport');
  const docker = await loadSpec('pi-transport-docker');
  assert.deepEqual([linux, darwin].map(name => judge(local, { exitCode: 0, stdout: output(name), stderr: '', timedOut: false }).length), [0, 0]);
  assert.equal(judge(docker, { exitCode: 0, stdout: output(linux), stderr: '', timedOut: false }).length, 0);
  assert.equal(judge(docker, { exitCode: 0, stdout: output(darwin), stderr: '', timedOut: false }).length, 1);
});

test('the vision spec accepts exactly the output its README shows under the command, and nothing more or less', async () => {
  const vision = await loadSpec('pi-vision');
  const [file] = vision.files;
  const shown = extractSnippet(await readFile(new URL(`../${file.readme}`, import.meta.url), 'utf8'), { heading: file.heading, fence: 'text' });
  const ran = over => judge(vision, { exitCode: 0, stdout: shown, stderr: '', timedOut: false, ...over }).length;
  assert.equal(ran({}), 0);
  assert.deepEqual([ran({ stdout: `${shown}more\n` }), ran({ stdout: shown.slice(1) }), ran({ stdout: shown.replace('B2=1250.5', 'B2=1250') }), ran({ stderr: 'a warning\n' })], [1, 1, 1, 1]);
});

test('the browser spec accepts exactly the output its README shows under the command, and nothing more or less', async () => {
  const browser = await loadSpec('pi-browser');
  const [file] = browser.files;
  const shown = extractSnippet(await readFile(new URL(`../${file.readme}`, import.meta.url), 'utf8'), { heading: file.heading, fence: '' });
  const ran = over => judge(browser, { exitCode: 0, stdout: shown, stderr: '', timedOut: false, ...over }).length;
  assert.equal(ran({}), 0);
  assert.deepEqual([ran({ stdout: `${shown}more\n` }), ran({ stdout: shown.slice(1) }), ran({ stdout: shown.replace('forty-two', 'forty-three') }), ran({ stderr: 'a warning\n' })], [1, 1, 1, 1]);
});
