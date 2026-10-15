import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { compareVersions, examplesInstallArgs, exitCodeOf, extractSnippet, isMissing, judge, loadSpec, parseIndex, readmeInstallArgs, runCommand, selectExamples, strangerEnv, validateSpec } from './stranger.mjs';

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

// ---- the examples' Since cells ----

const index = [
  '| Example | What it shows | Needs | Since | CI |', '|---|---|---|---|---|',
  '| [01-durable-chat](01-durable-chat/) | a disk chat | Archil | checkout | no |',
  '| [01-durable-chat/on-a-directory.mjs](01-durable-chat/on-a-directory.mjs) | quickstart | Linux | 0.1.0-beta.13 | yes |',
  '| [kill-9](kill-9/) | survives kill -9 | Linux | 0.1.0-beta.13 | yes |',
  '| [fork-into-many](fork-into-many/) | forks | Linux | 0.1.0-beta.14 | yes |',
  '| [planned-move](planned-move/) | moves | Archil and Daytona | 0.1.0-beta.14 | no |',
  '', 'text after the table', '',
].join('\n');

test('versions compare as releases and betas do: beta.9 is older than beta.10, a release is newer than its betas', () => {
  assert.equal(compareVersions('0.1.0-beta.9', '0.1.0-beta.10'), -1);
  assert.equal(compareVersions('0.1.0-beta.13', '0.1.0-beta.13'), 0);
  assert.equal(compareVersions('0.1.0-beta.14', '0.1.0-beta.13'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0-beta.14'), 1);
  assert.equal(compareVersions('0.1.1-beta.1', '0.1.0'), 1);
  assert.throws(() => compareVersions('checkout', '0.1.0'), /not a version/);
});

test("the index's example rows are read by their Since and CI headers, and a file's row (not a directory) is left out", () => {
  assert.deepEqual(parseIndex(index), [
    { name: '01-durable-chat', since: 'checkout', ci: 'no' },
    { name: 'kill-9', since: '0.1.0-beta.13', ci: 'yes' },
    { name: 'fork-into-many', since: '0.1.0-beta.14', ci: 'yes' },
    { name: 'planned-move', since: '0.1.0-beta.14', ci: 'no' },
  ]);
  assert.throws(() => parseIndex('| Example | CI |\n|---|---|\n'), /needs "Since" and "CI"/);
  assert.throws(() => parseIndex('no table'), /no table/);
});

test("a keyless example whose Since is at or below the registry's beta is walked, one above it is skipped with its reason", () => {
  const rows = parseIndex(index);
  const now = selectExamples(rows, '0.1.0-beta.13');
  assert.deepEqual(now.run, [{ name: 'kill-9', since: '0.1.0-beta.13' }]);
  assert.deepEqual(now.skipped, [
    { name: '01-durable-chat', reason: 'not keyless (CI "no")' },
    { name: 'fork-into-many', reason: "needs 0.1.0-beta.14, and the registry's beta is 0.1.0-beta.13" },
    { name: 'planned-move', reason: 'not keyless (CI "no")' },
  ]);
  assert.deepEqual(selectExamples(rows, '0.1.0-beta.14').run.map(example => example.name), ['kill-9', 'fork-into-many']);
  assert.throws(() => selectExamples([{ name: 'x', since: 'checkout', ci: 'yes' }], '0.1.0-beta.13'), /published version, not "checkout"/);
});

test("the install is the index's own install line with the package at the example's Since, and nothing else changes", () => {
  const block = ['npm init -y && npm pkg set type=module', 'npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord', 'node main.ts', ''].join('\n');
  assert.deepEqual(examplesInstallArgs(block, '@parcha/pi-durable-disk', '0.1.0-beta.13'), ['install', '@parcha/pi-durable-disk@0.1.0-beta.13', '@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord']);
  assert.throws(() => examplesInstallArgs('node main.ts\n', '@parcha/pi-durable-disk', '1.0.0'), /one npm install line, not 0/);
  assert.throws(() => examplesInstallArgs('npm install @parcha/pi-durable-disk @x/y\n', '@parcha/pi-durable-disk', '1.0.0'), /names @parcha\/pi-durable-disk@beta/);
});

test("every keyless example in the repository's index names a published-looking version, and its directory is there", async () => {
  const dir = new URL('../packages/pi-durable-disk/examples/', import.meta.url);
  const rows = parseIndex(await readFile(new URL('README.md', dir), 'utf8'));
  assert.ok(rows.some(row => row.name === 'kill-9'), 'the index lists kill-9');
  const { run } = selectExamples(rows, '999.0.0');
  assert.ok(run.length >= 4, `at least four keyless examples are walked, not ${run.length}`);
  const listing = new Set(await readdir(dir));
  for (const { name } of run) assert.ok(listing.has(name), `${name} has a directory`);
  const spec = await loadSpec('pi-durable-disk');
  const block = extractSnippet(await readFile(new URL(`../${spec.examples.readme}`, import.meta.url), 'utf8'), spec.examples);
  examplesInstallArgs(block, spec.package, '0.1.0-beta.13');
});

test("an example's run ends after its command exits and a short grace, even if a process outside its group keeps an output pipe open", async () => {
  // The command starts a detached child (a group of its own, so the timeout's group kill cannot reach it) that inherits the
  // output pipes and lives a while, prints its pid and exits at once.
  const script = "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); console.log(c.pid); c.unref();";
  const started = Date.now();
  const result = await runCommand(process.execPath, ['-e', script], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 60_000, group: true, graceMs: 300 });
  const elapsed = Date.now() - started;
  const lingering = Number(result.stdout.trim());
  try { assert.ok(Number.isInteger(lingering) && lingering > 0, `the command printed its child's pid: ${result.stdout}`); } finally { if (lingering > 0) try { process.kill(lingering, 'SIGKILL'); } catch { /* already gone */ } }
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed < 6000, `the run did not wait for the lingering child: ${elapsed} ms`);
});
