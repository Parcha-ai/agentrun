import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildConsole, installConsoleDependencies, consoleDepsInstalled, consoleInputsHash, consoleIsCurrent, HASH_FILE, stampConsole } from './build-console.mjs';

/** A repository with a console's inputs, and an npm that records what it was asked and builds as the console's own
 *  build does: dist/index.html, then the stamp. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'build-console-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  put('apps/console/src/main.tsx', 'export const a = 1;\n');
  put('apps/console/index.html', '<!doctype html>\n');
  put('apps/console/package.json', '{"name":"console"}\n');
  const lock = (version) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'console' }, 'node_modules/vite': { version }, 'node_modules/@esbuild/darwin-arm64': { version: '0.21.5', optional: true } } });
  put('apps/console/package-lock.json', lock('5.4.21'));
  put('packages/dsl/src/graph.ts', 'export const g = 1;\n');
  put('packages/pi-durable-agent/src/timeline/labels.ts', 'export const nameOf = (t) => t;\n');
  put('packages/pi-browser/src/core/contract.ts', 'export const BROWSER_TOOL_NAMES = ["run"];\n');
  const asked = [];
  const run = (args, cwd) => {
    asked.push(args.join(' '));
    // As npm ci records what it installed: the lockfile's packages for this platform, the optional one left out.
    if (args[0] === 'ci') { const { packages } = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')); put('apps/console/node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/vite': packages['node_modules/vite'] } })); }
    if (args.join(' ') === 'run build') { mkdirSync(join(cwd, 'dist'), { recursive: true }); writeFileSync(join(cwd, 'dist', 'index.html'), 'built\n'); stampConsole(root); }
  };
  return { root, put, lock, asked, build: () => buildConsole(root, { run, log: () => {} }) };
}

test('a fresh checkout installs and builds the console; built again from the same sources, it is skipped', (t) => {
  const r = repo(t);
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['ci --ignore-scripts --no-audit --no-fund', 'run build']);
  assert.equal(r.build(), 'current');
  assert.deepEqual(r.asked, ['ci --ignore-scripts --no-audit --no-fund', 'run build'], 'nothing asked of npm the second time');
});

test('a restored current build installs its missing console dependencies without rebuilding', (t) => {
  const r = repo(t);
  r.build();
  r.asked.length = 0;
  rmSync(join(r.root, 'apps/console/node_modules'), { recursive: true });
  const run = (args) => r.asked.push(args.join(' '));
  installConsoleDependencies(r.root, { run });
  assert.deepEqual(r.asked, ['ci --ignore-scripts --no-audit --no-fund']);
  assert.equal(consoleIsCurrent(r.root), true);
});

test('a changed source rebuilds; a file touched but unchanged does not; a changed lockfile installs again first', (t) => {
  const r = repo(t);
  r.build();
  r.asked.length = 0;
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(r.root, 'apps/console/src/main.tsx'), later, later);
  assert.equal(r.build(), 'current', 'a newer file time with the same bytes is not a change');
  r.put('apps/console/src/main.tsx', 'export const a = 2;\n');
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['run build'], 'the dependencies are current, so no install');
  r.asked.length = 0;
  r.put('packages/dsl/src/graph.ts', 'export const g = 2;\n');
  assert.equal(r.build(), 'built', 'the DSL sources the console imports are its inputs too');
  r.asked.length = 0;
  // The timeline library's tool names and pi-browser's tool list, which the Timeline imports from their sources.
  r.put('packages/pi-durable-agent/src/timeline/labels.ts', 'export const nameOf = (t) => `${t}!`;\n');
  assert.equal(r.build(), 'built', "the timeline library's labels the console imports are its inputs too");
  r.asked.length = 0;
  r.put('packages/pi-browser/src/core/contract.ts', 'export const BROWSER_TOOL_NAMES = ["run", "snapshot"];\n');
  assert.equal(r.build(), 'built', "pi-browser's tool list the console imports is its input too");
  r.asked.length = 0;
  r.put('apps/console/package-lock.json', r.lock('5.4.22'));
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['ci --ignore-scripts --no-audit --no-fund', 'run build']);
});

test('a dist with no record of its inputs, or another tree\'s, is not current', (t) => {
  const r = repo(t);
  r.put('apps/console/dist/index.html', 'built elsewhere\n');
  assert.equal(consoleIsCurrent(r.root), false, 'no hash beside it');
  r.put(`apps/console/dist/${HASH_FILE}`, 'f'.repeat(64));
  assert.equal(consoleIsCurrent(r.root), false, 'a hash of other sources');
  r.put(`apps/console/dist/${HASH_FILE}`, `${consoleInputsHash(r.root)}\n`);
  assert.equal(consoleIsCurrent(r.root), true);
});

test('dependencies npm installed by itself, as a source check does before going offline, are not installed again', (t) => {
  const r = repo(t);
  assert.equal(consoleDepsInstalled(r.root), false, 'none yet');
  r.put('apps/console/node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/vite': { version: '5.4.21' } } }));
  assert.equal(consoleDepsInstalled(r.root), true, 'another platform\'s optional package is not needed');
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['run build']);
  r.put('apps/console/node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/vite': { version: '5.4.20' } } }));
  assert.equal(consoleDepsInstalled(r.root), false, 'a version the lockfile does not name');
});

/** buildConsole with its own npm (no `run` passed) in a child process, a fake npm first on PATH: each `npm ci` answers
 *  with the next of `plan` (`ok`, or npm 11's error lines for a code), and `npm run build` builds and stamps. */
function buildWithNpm(t, plan) {
  const r = repo(t);
  const bin = join(r.root, 'bin');
  const log = join(bin, 'calls.log');
  const errors = {
    ECONNRESET: 'npm error code ECONNRESET\nnpm error network aborted\n',
    EUSAGE: 'npm error code EUSAGE\nnpm error\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.\n',
    EBADENGINE: 'npm error code EBADENGINE\nnpm error engine Unsupported engine\n',
  };
  const module = new URL('./build-console.mjs', import.meta.url).href;
  r.put('bin/calls.log', '');
  r.put('bin/npm', `#!${process.execPath}
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'run') { mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', 'built\\n'); import(${JSON.stringify(module)}).then((m) => m.stampConsole(${JSON.stringify(r.root)})); }
else {
  const n = readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter((line) => line.startsWith('ci')).length;
  const step = ${JSON.stringify(plan)}[n - 1] ?? 'ok';
  if (step !== 'ok') { process.stderr.write(${JSON.stringify(errors)}[step]); process.exit(1); }
}
`);
  chmodSync(join(bin, 'npm'), 0o755);
  const done = spawnSync(process.execPath, ['--input-type=module', '-e', `import { buildConsole } from ${JSON.stringify(module)}; console.log('result:', buildConsole(${JSON.stringify(r.root)}));`], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`, NPM_CI_RETRY_WAIT_MS: '0' },
  });
  return { ...done, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean), dist: existsSync(join(r.root, 'apps/console/dist/index.html')) };
}

const CI = 'ci --ignore-scripts --no-audit --no-fund';

test("the console's npm ci is retried once after a network error, with a warning naming it, and the console builds", (t) => {
  const done = buildWithNpm(t, ['ECONNRESET', 'ok']);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(done.calls, [CI, CI, 'run build']);
  assert.match(done.stdout, /^::warning::npm ci failed on a network error \(ECONNRESET\), retrying once$/m);
  assert.match(done.stdout, /^result: built$/m);
});

test("the console's npm ci is not retried after a lockfile or engine failure, and a second network error stops the build", (t) => {
  for (const plan of [['EUSAGE'], ['EBADENGINE'], ['ECONNRESET', 'ECONNRESET']]) {
    const done = buildWithNpm(t, [...plan, 'ok']);
    assert.equal(done.status, 1, plan.join(' '));
    assert.deepEqual(done.calls, plan.map(() => CI), `${plan.join(' ')}: npm ci ran ${plan.length} time(s), and no build`);
    assert.match(done.stderr, /Error: npm ci --ignore-scripts --no-audit --no-fund in .*apps[\\/]console exited 1/, 'the same refusal as before');
    assert.equal(done.dist, false);
  }
});
