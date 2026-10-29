// Test files that validate the same workflow at once record it under one name in the capture directory.
// Each capture is written whole or not at all: whoever writes last wins, and no reader sees a torn file.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const register = join(root, 'spec/lean/sweep/capture-register.mjs');
const dsl = join(root, 'packages/dsl/dist/index.js');
const scratch = mkdtempSync(join(tmpdir(), 'sweep-capture-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The same workflow from two scripts whose paths, which the capture records, differ a great deal in length.
const body = `import { validateWorkflow } from ${JSON.stringify(dsl)};\nvalidateWorkflow({ root: { kind: 'sequence' }, note: 'x' }, { inputKeys: [] });\n`;
const short = join(scratch, 's.mjs');
const long = join(scratch, 'l'.repeat(120), 'm'.repeat(120), 'n'.repeat(120), 'a-much-longer-script-name.mjs');
mkdirSync(dirname(long), { recursive: true });
writeFileSync(short, body);
writeFileSync(long, body);

const record = (script, directory, preloads = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [...preloads.flatMap((file) => ['--import', file]), '--import', register, script], {
    stdio: 'ignore', env: { ...process.env, LEAN_SWEEP_DIR: directory, NODE_OPTIONS: '' },
  });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
});

test('captures of one workflow written at once are each whole JSON, and no temporary file is left', async () => {
  for (let round = 0; round < 40; round += 1) {
    const directory = join(scratch, `capture-${round}`);
    mkdirSync(directory);
    await Promise.all(Array.from({ length: 12 }, (_, i) => record(i % 2 ? long : short, directory)));
    const files = readdirSync(directory);
    assert.ok(files.length > 0, `round ${round}: something was captured`);
    for (const file of files) {
      assert.match(file, /^[0-9a-f]{24}\.json$/, `round ${round}: ${file} is a finished capture`);
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(directory, file), 'utf8')), `round ${round}: ${file} parses`);
    }
  }
});

test('the collector skips a temporary file left by a process that died before its rename', () => {
  const spy = join(scratch, 'spy.mjs');
  writeFileSync(spy, [
    "import { writeFileSync } from 'node:fs';",
    "import { createRequire, syncBuiltinESMExports } from 'node:module';",
    "const childProcess = createRequire(import.meta.url)('node:child_process');",
    "childProcess.execFileSync = (command, args, options) => {",
    "  const directory = options.env.LEAN_SWEEP_DIR;",
    "  writeFileSync(`${directory}/${args.length}-${Date.now()}.json`, JSON.stringify({ source: 'a.mjs', workflow: { root: { kind: 'sequence' } }, inputKeys: null }));",
    "  writeFileSync(`${directory}/dead.${args.length}.tmp`, '{\"source\": \"half');",
    "  return Buffer.alloc(0);",
    "};",
    'syncBuiltinESMExports();',
  ].join('\n'));
  const out = join(scratch, 'corpus.json');
  const done = spawnSync(process.execPath, ['--import', spy, join(root, 'spec/lean/sweep/collect.mjs'), out], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(JSON.parse(readFileSync(out, 'utf8')).length > 0);
});

// The race above needs a fast disk to show; this does not. A spy preload records every path the capture writes and every
// rename, so the test can say how a capture reaches its final name, whatever the timing.
const fsSpy = join(scratch, 'fs-spy.mjs');
writeFileSync(fsSpy, [
  "import { createRequire, syncBuiltinESMExports } from 'node:module';",
  "const fs = createRequire(import.meta.url)('node:fs');",
  "const { writeFileSync, renameSync, openSync, writeSync } = fs;",
  "const out = openSync(process.env.SPY_LOG, 'a');",
  "const log = (entry) => writeSync(out, `${JSON.stringify({ pid: process.pid, ...entry })}\\n`);",
  "fs.writeFileSync = (path, ...rest) => { log({ op: 'write', path: String(path) }); return writeFileSync(path, ...rest); };",
  "fs.renameSync = (from, to) => { log({ op: 'rename', from: String(from), to: String(to) }); return renameSync(from, to); };",
  'syncBuiltinESMExports();',
].join('\n'));

test('a capture reaches its final name only by a rename from a temporary name that carries the writer\'s pid', async () => {
  const directory = join(scratch, 'spied');
  mkdirSync(directory);
  const logFile = join(scratch, 'spy.jsonl');
  writeFileSync(logFile, '');
  const spawned = spawn(process.execPath, ['--import', fsSpy, '--import', register, short], {
    stdio: 'ignore', env: { ...process.env, LEAN_SWEEP_DIR: directory, SPY_LOG: logFile, NODE_OPTIONS: '' },
  });
  await new Promise((resolve, reject) => { spawned.on('error', reject); spawned.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exited ${code}`)))); });
  const calls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const renames = calls.filter((call) => call.op === 'rename' && call.to.startsWith(directory));
  assert.equal(renames.length, 1, 'one capture, one rename');
  const [{ from, to, pid }] = renames;
  assert.match(to, /[/][0-9a-f]{24}[.]json$/, 'the rename lands on the capture\'s final name');
  assert.equal(pid, spawned.pid, 'the spy ran in the capturing process');
  assert.match(from, new RegExp(`[/][0-9a-f]{24}[.]${pid}[.]\\d+[.]tmp$`), 'the temporary name carries the writer\'s pid');
  assert.deepEqual(calls.filter((call) => call.op === 'write' && call.path.endsWith('.json')), [], 'the final name is never written to directly');
  assert.ok(calls.some((call) => call.op === 'write' && call.path === from), 'the body is written to the temporary name');
});
