import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildConsole, consoleDepsInstalled, consoleInputsHash, consoleIsCurrent, HASH_FILE, stampConsole } from './build-console.mjs';

/** A repository with a console's inputs, and a pnpm that records what it was asked and builds as the console's own
 *  build does: dist/index.html, then the stamp. */
/** A console's pnpm-lock.yaml at vite `version`, with another platform's optional esbuild binary. */
const lock = (version) => `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      vite:
        specifier: ${version}
        version: ${version}
packages:
  vite@${version}:
    resolution: {integrity: sha512-x}
  '@esbuild/darwin-arm64@0.21.5':
    resolution: {integrity: sha512-y}
    os: [darwin]
snapshots:
  vite@${version}:
    optionalDependencies:
      '@esbuild/darwin-arm64': 0.21.5
  '@esbuild/darwin-arm64@0.21.5':
    optional: true
`;
/** What pnpm records it installed from that lockfile on another platform: the same, the optional binary left out. */
const installed = (version) => lock(version).replace(/  '@esbuild\/darwin-arm64@0\.21\.5':\n    optional: true\n$/, '');

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'build-console-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  put('apps/console/src/main.tsx', 'export const a = 1;\n');
  put('apps/console/index.html', '<!doctype html>\n');
  put('apps/console/package.json', '{"name":"console"}\n');
  put('apps/console/pnpm-lock.yaml', lock('5.4.21'));
  put('packages/dsl/src/graph.ts', 'export const g = 1;\n');
  put('packages/serve/src/timeline/labels.ts', 'export const nameOf = (t) => t;\n');
  put('packages/pi-browser/src/core/contract.ts', 'export const BROWSER_TOOL_NAMES = ["run"];\n');
  const asked = [];
  const run = (args, cwd) => {
    asked.push(args.join(' '));
    // As pnpm install records what it installed: the lockfile's packages for this platform, the optional one left out.
    if (args[0] === 'install') put('apps/console/node_modules/.pnpm/lock.yaml', installed(/vite@(\S+?):/.exec(readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8'))[1]));
    if (args.join(' ') === 'run build') { mkdirSync(join(cwd, 'dist'), { recursive: true }); writeFileSync(join(cwd, 'dist', 'index.html'), 'built\n'); stampConsole(root); }
  };
  return { root, put, asked, build: () => buildConsole(root, { run, log: () => {} }) };
}

test('a fresh checkout installs and builds the console; built again from the same sources, it is skipped', (t) => {
  const r = repo(t);
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['install --frozen-lockfile', 'run build']);
  assert.equal(r.build(), 'current');
  assert.deepEqual(r.asked, ['install --frozen-lockfile', 'run build'], 'nothing asked of pnpm the second time');
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
  r.put('packages/serve/src/timeline/labels.ts', 'export const nameOf = (t) => `${t}!`;\n');
  assert.equal(r.build(), 'built', "the timeline library's labels the console imports are its inputs too");
  r.asked.length = 0;
  r.put('packages/serve/src/tool-names.ts', 'export const WIRE_NAME = /^x$/;\n');
  assert.equal(r.build(), 'built', "serve's tool-name grammar the console imports is its input too");
  r.asked.length = 0;
  r.put('packages/pi-browser/src/core/contract.ts', 'export const BROWSER_TOOL_NAMES = ["run", "snapshot"];\n');
  assert.equal(r.build(), 'built', "pi-browser's tool list the console imports is its input too");
  r.asked.length = 0;
  r.put('apps/console/pnpm-lock.yaml', lock('5.4.22'));
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['install --frozen-lockfile', 'run build']);
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

test('dependencies pnpm installed by itself, as a source check does before going offline, are not installed again', (t) => {
  const r = repo(t);
  assert.equal(consoleDepsInstalled(r.root), false, 'none yet');
  r.put('apps/console/node_modules/.pnpm/lock.yaml', installed('5.4.21'));
  assert.equal(consoleDepsInstalled(r.root), true, 'another platform\'s optional package is not needed');
  assert.equal(r.build(), 'built');
  assert.deepEqual(r.asked, ['run build']);
  r.put('apps/console/node_modules/.pnpm/lock.yaml', installed('5.4.20'));
  assert.equal(consoleDepsInstalled(r.root), false, 'a version the lockfile does not name');
});

/** buildConsole with its own pnpm (no `run` passed) in a child process, a fake pnpm as npm_execpath (what `pnpm run`
 *  names): `pnpm install` exits `install` (0, or a failure), and `pnpm run build` builds and stamps. */
function buildWithPnpm(t, install) {
  const r = repo(t);
  const bin = join(r.root, 'bin');
  const log = join(bin, 'calls.log');
  const module = new URL('./build-console.mjs', import.meta.url).href;
  r.put('bin/calls.log', '');
  r.put('bin/pnpm.cjs', `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'run') { mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', 'built\\n'); import(${JSON.stringify(module)}).then((m) => m.stampConsole(${JSON.stringify(r.root)})); }
else if (${install} !== 0) { process.stderr.write('ERR_PNPM_OUTDATED_LOCKFILE\\n'); process.exit(${install}); }
`);
  chmodSync(join(bin, 'pnpm.cjs'), 0o755);
  const done = spawnSync(process.execPath, ['--input-type=module', '-e', `import { buildConsole } from ${JSON.stringify(module)}; console.log('result:', buildConsole(${JSON.stringify(r.root)}));`], {
    encoding: 'utf8', env: { ...process.env, npm_execpath: join(bin, 'pnpm.cjs') },
  });
  return { ...done, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean), dist: existsSync(join(r.root, 'apps/console/dist/index.html')) };
}

test("the console installs with the pnpm that runs the build, then builds", (t) => {
  const done = buildWithPnpm(t, 0);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(done.calls, ['install --frozen-lockfile', 'run build']);
  assert.match(done.stdout, /^result: built$/m);
});

test("a failed install stops the build, naming the install, and builds nothing", (t) => {
  const done = buildWithPnpm(t, 1);
  assert.equal(done.status, 1);
  assert.deepEqual(done.calls, ['install --frozen-lockfile']);
  assert.match(done.stderr, /Error: pnpm install --frozen-lockfile in .*apps[\\/]console exited 1/);
  assert.equal(done.dist, false);
});
