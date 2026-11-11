// The validator sweep's capture hook and the collector's --captures mode. Test files that validate the same workflow at once
// record it under one name: each capture is written whole or not at all, whoever writes last wins, and no reader sees a torn
// file. CI's test shards capture; the lean job reads their directories with --captures and runs no suite.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const register = join(root, 'spec/lean/sweep/capture-register.mjs');
const collect = join(root, 'spec/lean/sweep/collect.mjs');
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
  child.on('exit', (code) => (code === 0 ? resolve(child.pid) : reject(new Error(`${script} exited ${code}`))));
});

test('captures of one workflow written at once are each whole JSON, name their script from the repository, and leave no temporary file', async () => {
  const scripts = new Set([short, long].map((script) => relative(root, script)));
  for (let round = 0; round < 40; round += 1) {
    const directory = join(scratch, `capture-${round}`);
    mkdirSync(directory);
    await Promise.all(Array.from({ length: 12 }, (_, i) => record(i % 2 ? long : short, directory)));
    const files = readdirSync(directory);
    assert.ok(files.length > 0, `round ${round}: something was captured`);
    for (const file of files) {
      assert.match(file, /^[0-9a-f]{24}\.json$/, `round ${round}: ${file} is a finished capture`);
      let entry;
      assert.doesNotThrow(() => { entry = JSON.parse(readFileSync(join(directory, file), 'utf8')); }, `round ${round}: ${file} parses`);
      assert.ok(scripts.has(entry.source), `round ${round}: ${entry.source} is one of the scripts, relative to the repository`);
    }
  }
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
  const pid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', fsSpy, '--import', register, short], {
      stdio: 'ignore', env: { ...process.env, LEAN_SWEEP_DIR: directory, SPY_LOG: logFile, NODE_OPTIONS: '' },
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(child.pid) : reject(new Error(`exited ${code}`))));
  });
  const calls = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const renames = calls.filter((call) => call.op === 'rename' && call.to.startsWith(directory));
  assert.equal(renames.length, 1, 'one capture, one rename');
  const [{ from, to, pid: renamer }] = renames;
  assert.match(to, /[/][0-9a-f]{24}[.]json$/, 'the rename lands on the capture\'s final name');
  assert.equal(renamer, pid, 'the spy ran in the capturing process');
  assert.match(from, new RegExp(`[/][0-9a-f]{24}[.]${pid}[.]\\d+[.]tmp$`), 'the temporary name carries the writer\'s pid');
  assert.deepEqual(calls.filter((call) => call.op === 'write' && call.path.endsWith('.json')), [], 'the final name is never written to directly');
  assert.ok(calls.some((call) => call.op === 'write' && call.path === from), 'the body is written to the temporary name');
});

// execFileSync replaced: the default mode "runs" each suite by writing one capture, and a temporary file a dead process left.
const suiteSpy = join(scratch, 'suite-spy.mjs');
writeFileSync(suiteSpy, [
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "import { createRequire, syncBuiltinESMExports } from 'node:module';",
  "const childProcess = createRequire(import.meta.url)('node:child_process');",
  "let n = 0;",
  "childProcess.execFileSync = (command, args, options) => {",
  "  appendFileSync(process.env.SPY_LOG, `${JSON.stringify(args)}\\n`);",
  "  const directory = options.env.LEAN_SWEEP_DIR;",
  "  writeFileSync(`${directory}/${String(n += 1).padStart(24, '0')}.json`, JSON.stringify({ source: 'a.mjs', workflow: { root: { kind: 'sequence', id: `w${n}` } }, inputKeys: null }));",
  "  writeFileSync(`${directory}/dead.${n}.tmp`, '{\"source\": \"half');",
  "  return Buffer.alloc(0);",
  "};",
  'syncBuiltinESMExports();',
].join('\n'));

let runs = 0;
function collector(args) {
  const log = join(scratch, `suites-${runs += 1}.log`);
  writeFileSync(log, '');
  const done = spawnSync(process.execPath, ['--import', suiteSpy, collect, ...args], { encoding: 'utf8', env: { ...process.env, TEST_CONCURRENCY: '', SPY_LOG: log } });
  return { ...done, suites: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('the collector skips a temporary file left by a process that died before its rename', () => {
  const out = join(scratch, 'corpus-default.json');
  const done = collector([out]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.suites.length, 3);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).filter((entry) => entry.source === 'a.mjs').length, 3);
});

/** A capture directory as a test shard leaves it: one capture per source, and a temporary file from a dead process. */
function shard(name, sources) {
  const directory = join(scratch, name);
  mkdirSync(directory);
  sources.forEach((source, i) => writeFileSync(join(directory, `${name}-${i}`.padEnd(24, '0') + '.json'),
    JSON.stringify({ source, workflow: { root: { kind: 'sequence', id: `${name}-${i}` } }, inputKeys: i % 2 ? [] : null })));
  writeFileSync(join(directory, 'dead.1.tmp'), '{"source": "half');
  return directory;
}

test('--captures reads every directory it is given, runs no suite, and skips temporary files', () => {
  const core = shard('core', ['packages/dsl/test/a.test.mjs', 'packages/serve/test/durable-b.test.mjs', join(root, 'packages/dsl/test/c.test.mjs')]);
  const examples = shard('examples', ['examples/d.test.mjs']);
  const out = join(scratch, 'corpus-captures.json');
  const done = collector(['--captures', core, `--captures=${examples}`, out]);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(done.suites, [], 'no suite ran');
  const sources = JSON.parse(readFileSync(out, 'utf8')).map((entry) => entry.source);
  for (const source of ['packages/dsl/test/a.test.mjs', 'packages/serve/test/durable-b.test.mjs', 'packages/dsl/test/c.test.mjs', 'examples/d.test.mjs']) {
    assert.ok(sources.includes(source), `${source} is in the corpus, relative to the repository`);
  }
});

test('--captures fails, naming it, on a directory that is missing or holds no finished capture, and writes no corpus', () => {
  const core = shard('core-only', ['packages/dsl/test/a.test.mjs', 'packages/serve/test/durable-b.test.mjs', 'examples/d.test.mjs']);
  const empty = join(scratch, 'empty');
  mkdirSync(empty);
  writeFileSync(join(empty, 'dead.1.tmp'), '{');
  const missing = join(scratch, 'never-downloaded');
  const out = join(scratch, 'corpus-missing.json');
  const done = collector(['--captures', core, '--captures', empty, '--captures', missing, out]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, new RegExp(`${empty}: no captures`));
  assert.match(done.stderr, new RegExp(`${missing}: no captures`));
  assert.throws(() => readFileSync(out), { code: 'ENOENT' });
  assert.deepEqual(done.suites, []);
});

test('--captures fails, naming it, when no capture came from one of the suites', () => {
  const core = shard('no-serve', ['packages/dsl/test/a.test.mjs', 'examples/d.test.mjs']);
  const done = collector(['--captures', core, join(scratch, 'corpus-no-serve.json')]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /packages\/serve\/test: no capture came from this suite/);
  assert.doesNotMatch(done.stderr, /packages\/dsl\/test: no capture/);
});

test('--captures without a directory is refused before anything runs', () => {
  const done = collector(['--captures']);
  assert.equal(done.status, 2);
  assert.match(done.stderr, /--captures needs a directory/);
});
