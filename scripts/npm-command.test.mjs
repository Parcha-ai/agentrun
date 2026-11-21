// npm as a child process of a repository script (npm-command.mjs), and no script that spawns it by name: on Windows that
// fails (#3334), npm.cmd with no shell at EINVAL and `npm` at ENOENT, which is how `npm run build` broke there.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { npmCommand, npmSpawnSync, spawnArgvSync } from './npm-command.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));

test('no repository script spawns npm by name: each goes through npm-command.mjs', () => {
  // A call of a child-process function whose command is npm or npm.cmd by name, or chosen between them by platform.
  const byName = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*(?:['"`]npm(?:\.cmd)?['"`]|process\.platform\s*===\s*['"]win32['"]\s*\?\s*['"]npm)/;
  // npm.cmd named anywhere: a command picked by platform, then spawned (build-console.mjs did).
  const chosen = /['"`]npm\.cmd['"`]/;
  const found = [];
  for (const name of readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'npm-command.mjs')) {
    readFileSync(join(SCRIPTS, name), 'utf8').split('\n').forEach((line, i) => {
      if (byName.test(line) || chosen.test(line)) found.push(`scripts/${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, []);
});

test("npm is this node running npm's own script: the one that ran this script, else the one beside node, by name only when neither exists", () => {
  const cli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
  const at = (...paths) => (p) => paths.includes(p);
  // Under `npm run` (npm_execpath), on any platform: no shell, the arguments as they are.
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.deepEqual(npmCommand(['run', 'build', '-w', 'a b'], { env: { npm_execpath: cli }, platform, execPath: '/opt/node/bin/node', exists: at(cli) }),
      { command: '/opt/node/bin/node', args: [cli, 'run', 'build', '-w', 'a b'] }, platform);
  }
  // npm_execpath that is gone, or not a script, is not used.
  assert.equal(npmCommand(['-v'], { env: { npm_execpath: cli }, platform: 'linux', execPath: '/x/bin/node', exists: at() }).command, 'npm');
  assert.equal(npmCommand(['-v'], { env: { npm_execpath: '/x/npm.cmd' }, platform: 'win32', execPath: 'C:\\node\\node.exe', exists: () => true }).command, 'C:\\node\\node.exe');
  // Run with node directly: the npm installed with this node, POSIX (<prefix>/lib) and Windows (beside node.exe).
  assert.deepEqual(npmCommand(['ls'], { env: {}, platform: 'linux', execPath: '/opt/node/bin/node', exists: at(cli) }), { command: '/opt/node/bin/node', args: [cli, 'ls'] });
  const win = 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(npmCommand(['ls'], { env: {}, platform: 'win32', execPath: 'C:\\node\\node.exe', exists: at(win) }), { command: 'C:\\node\\node.exe', args: [win, 'ls'] });
  // Neither: npm by name from PATH, on every platform, never through a shell, so no argument is rewritten.
  assert.deepEqual(npmCommand(['ls'], { env: {}, platform: 'linux', execPath: '/x/bin/node', exists: at() }), { command: 'npm', args: ['ls'] });
  assert.deepEqual(npmCommand(['exec', '-c', 'node --test "a b"', '100%'], { env: {}, platform: 'win32', execPath: 'C:\\x\\node.exe', exists: at() }),
    { command: 'npm', args: ['exec', '-c', 'node --test "a b"', '100%'] });
});

test('npmSpawnSync, and spawnArgvSync given npm, run the npm this test runs under; spawnArgvSync runs any other argv as written', () => {
  for (const done of [npmSpawnSync(['--version'], { encoding: 'utf8' }), spawnArgvSync(['npm', '--version'], { encoding: 'utf8' })]) {
    assert.equal(done.status, 0, done.stderr || String(done.error));
    assert.match(done.stdout.trim(), /^\d+\.\d+\.\d+$/);
  }
  assert.equal(spawnArgvSync([process.execPath, '-p', '6 * 7'], { encoding: 'utf8' }).stdout.trim(), '42');
});
