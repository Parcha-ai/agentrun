// isMain(import.meta) is how a script decides it is the command. Where Node has no import.meta.main (20, 23, 24.0-24.1)
// a script that read it directly exited 0 having done nothing; there isMain refuses the command and leaves an import alone.
// Each case runs a real module in a child: `{ ...import.meta, main: undefined }` is what Node 20 hands a module.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

const helper = new URL('./is-main.mjs', import.meta.url).href;
const pin = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10_000 });

// The floor as scripts/check-node.mjs words it for a Node it refuses, so the two say the same thing.
const floor = (() => {
  const checked = node(['--input-type=module', '-e', `Object.defineProperty(process.versions, 'node', { value: '20.20.0' }); await import(${JSON.stringify(new URL('./check-node.mjs', import.meta.url).href)});`]);
  return /AgentRun needs (.+?); you have/.exec(checked.stderr)?.[1];
})();

/** A directory with a command (cli.mjs) and a module that imports it (importer.mjs), and a symlink to the directory. */
function fixture(t, main) {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'real'));
  writeFileSync(join(dir, 'real', 'cli.mjs'), `import { isMain } from ${JSON.stringify(helper)};\nif (isMain({ ...import.meta, main: ${main} })) console.log('cli ran');\n`);
  writeFileSync(join(dir, 'real', 'importer.mjs'), "import './cli.mjs';\nconsole.log('importer ran');\n");
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  return dir;
}

test('the command, where Node has no import.meta.main: exit 1 and one line naming the file, the Node it ran on and the floor', (t) => {
  assert.ok(floor, 'check-node names the floor');
  const dir = fixture(t, 'undefined');
  for (const cli of ['real/cli.mjs', 'link/cli.mjs']) {
    const run = node([cli], dir);
    assert.equal(run.status, 1, `${cli}: ${run.stderr}`);
    assert.equal(run.stdout, '', 'the command body did not run');
    const lines = run.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 1, run.stderr);
    assert.ok(lines[0].startsWith(`${cli}: `), `the file as it was run, from where it was run: ${lines[0]}`);
    for (const part of [`Node ${process.version}`, 'import.meta.main', `AgentRun needs ${floor}`, `.nvmrc pins ${pin}`]) {
      assert.ok(lines[0].includes(part), `${JSON.stringify(part)} in ${lines[0]}`);
    }
  }
});

test('an import, where Node has no import.meta.main: nothing is printed and the importer runs on, exit 0', (t) => {
  const dir = fixture(t, 'undefined');
  for (const importer of [join(dir, 'real', 'importer.mjs'), join(dir, 'link', 'importer.mjs')]) {
    const run = node([importer]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'importer ran\n');
    assert.equal(run.stderr, '');
  }
  // No argv[1] at all (node -e, a REPL) is an import too.
  const bare = node(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(dir, 'real', 'cli.mjs')).href)}); console.log('eval ran');`]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout, 'eval ran\n');
  assert.equal(bare.stderr, '');
});

test('where Node sets import.meta.main, it is the answer', (t) => {
  const ran = fixture(t, 'true');
  const run = node([join(ran, 'real', 'cli.mjs')]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'cli ran\n');
  const imported = fixture(t, 'false');
  const quiet = node([join(imported, 'real', 'cli.mjs')]);
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', ''], 'false is believed, even with argv[1] on this file');
  assert.equal(isMain({ url: import.meta.url, main: true }), true);
  assert.equal(isMain({ url: import.meta.url, main: false }), false);
});

test('a real command, scripts/changes.mjs --check, refuses when its import.meta has no main, as on Node 20', () => {
  // A load hook hands changes.mjs's guard what Node 20 would; nothing else in the run changes.
  const target = new URL('./changes.mjs', import.meta.url).href;
  const hook = `export async function load(url, context, next) {
    const loaded = await next(url, context);
    if (url !== ${JSON.stringify(target)}) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
    return { ...loaded, source: source.replace('isMain(import.meta)', 'isMain({ ...import.meta, main: undefined })') };
  }`;
  const register = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});`;
  const run = node(['--import', `data:text/javascript,${encodeURIComponent(register)}`, 'scripts/changes.mjs', '--check'], new URL('..', import.meta.url));
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '', 'the check did not run, and did not say it passed');
  assert.match(run.stderr, /^scripts\/changes\.mjs: refused on Node v[\d.]+, which has no import\.meta\.main/);
});

test('this runtime sets import.meta.main, which the repository needs', () => {
  assert.equal(typeof import.meta.main, 'boolean', `Node ${process.version}`);
});
