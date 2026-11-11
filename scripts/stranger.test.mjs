import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { exitCodeOf, extractSnippet, isMissing, judge, loadSpec, runCommand, strangerEnv, validateSpec } from './stranger.mjs';

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

test("every spec's companions are its package's repository dependencies, transitively, and its install packs exactly those and the package", async () => {
  const manifests = new Map();
  for (const directory of await readdir(new URL('../packages/', import.meta.url))) {
    const manifest = JSON.parse(await readFile(new URL(`../packages/${directory}/package.json`, import.meta.url), 'utf8'));
    manifests.set(manifest.name, { directory, dependencies: Object.keys(manifest.dependencies ?? {}) });
  }
  const closure = (name, found = new Set()) => {
    for (const dependency of manifests.get(name).dependencies) if (manifests.has(dependency) && !found.has(dependency)) closure(dependency, found.add(dependency));
    return found;
  };
  for (const name of (await readdir(new URL('./stranger/', import.meta.url))).map(file => file.replace(/\.json$/, ''))) {
    const spec = await loadSpec(name);
    const companions = [...closure(spec.package)].sort();
    assert.deepEqual([...(spec.companions ?? [])].sort(), companions, `${name}: companions`);
    assert.deepEqual([...spec.install].sort(), [spec.package, ...companions].map(packageName => manifests.get(packageName).directory).sort(), `${name}: install`);
  }
});

test('a child killed by a signal, or closed with no code, is a failing exit', () => {
  assert.equal(exitCodeOf(0, null), 0);
  assert.equal(exitCodeOf(3, null), 3);
  assert.equal(exitCodeOf(null, 'SIGKILL'), 137);
  assert.equal(exitCodeOf(null, 'SIGTERM'), 143);
  assert.equal(exitCodeOf(null, null), 1);
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
