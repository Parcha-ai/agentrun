import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./test-workspaces.mjs', import.meta.url));

// Each fixture workspace's test script runs this: it logs its start and end in <root>/log and, by its flags, waits until
// <n> workspaces have started, prints lines, holds, fails, or leaves a process running (`<name> <its pid> <that pid>` in <root>/pids).
// With --hang it never ends and logs a SIGTERM; with --escape the process it leaves has a process group of its own.
const STEP = `import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [name, ...flags] = process.argv.slice(2);
const opt = (flag) => { const at = flags.indexOf(flag); return at < 0 ? undefined : flags[at + 1]; };
const log = new URL('./log', import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
appendFileSync(log, 'start ' + name + '\\n');
const barrier = Number(opt('--barrier') ?? 0);
while (readFileSync(log, 'utf8').split('\\n').filter((line) => line.startsWith('start ')).length < barrier) await sleep(20);
for (let i = 0; i < Number(opt('--lines') ?? 0); i += 1) { console.log('line ' + name + ' ' + i); await sleep(2); }
await sleep(Number(opt('--hold') ?? 0));
// A --hang step takes SIGTERM before it says its pid: the test stops the runner once every pid is said, and a SIGTERM in
// between would end the step unlogged.
if (flags.includes('--hang')) process.on('SIGTERM', () => { appendFileSync(log, 'term ' + name + '\\n'); process.exit(143); });
if (flags.includes('--orphan') || flags.includes('--hang') || flags.includes('--escape')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'inherit', detached: flags.includes('--escape') });
  child.unref();
  appendFileSync(new URL('./pids', import.meta.url), name + ' ' + process.pid + ' ' + child.pid + '\\n');
}
if (flags.includes('--hang')) setInterval(() => {}, 1e9);
else { appendFileSync(log, 'end ' + name + '\\n'); process.exitCode = Number(opt('--exit') ?? 0); }
`;

// A repository root with a workspace per entry, packages/<dir> named @fx/<dir>; `test` is its test script.
function fixture(t, spec) {
  const root = mkdtempSync(join(tmpdir(), 'test-workspaces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', private: true, workspaces: ['packages/*'] }));
  writeFileSync(join(root, 'step.mjs'), STEP);
  writeFileSync(join(root, 'log'), '');
  for (const [dir, { test: script, deps = [], devDeps = [] }] of Object.entries(spec)) {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    const versions = (names) => Object.fromEntries(names.map((name) => [`@fx/${name}`, '1.0.0']));
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify({
      name: `@fx/${dir}`, version: '1.0.0', scripts: script ? { test: script } : {}, dependencies: versions(deps), devDependencies: versions(devDeps),
    }));
  }
  return root;
}
const step = (name, flags = '') => `node ../../step.mjs ${name} ${flags}`.trim();
// `jobs` is AGENTRUN_TEST_JOBS, or an object of variables; the caller's own settings never reach the runner.
const env = (jobs) => {
  const { npm_config_base, AGENTRUN_TEST_TOTAL, AGENTRUN_TEST_JOBS, ...rest } = process.env;
  return { ...rest, ...(typeof jobs === 'object' ? jobs : { AGENTRUN_TEST_JOBS: String(jobs) }) };
};
// For the tests that need workspaces running together: jobs with a total of their own (4 test files each), so a machine
// with few cores, where the default total is the core count, never caps them below what the test waits on.
const atOnce = (jobs) => ({ AGENTRUN_TEST_JOBS: String(jobs), AGENTRUN_TEST_TOTAL: String(jobs * 4) });
const run = (root, jobs, ...args) => spawnSync(process.execPath, [runner, ...args], { cwd: root, env: env(jobs), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1 << 26 });
const logOf = (root) => readFileSync(join(root, 'log'), 'utf8').trim().split('\n');
const pidsOf = (root) => {
  const file = join(root, 'pids');
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map((line) => line.split(' ')).map(([name, ...pids]) => [name, pids.map(Number)]));
};
const starts = (stdout) => [...stdout.matchAll(/^start (\S+) /gm)].map((m) => m[1]);
// Gone, or a zombie only its new parent has still to reap.
const dead = (pid) => {
  try { process.kill(pid, 0); } catch { return true; }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] === 'Z'; } catch { return false; }
};

test('one job runs the workspaces one at a time, in npm\'s order, each script as written', (t) => {
  const root = fixture(t, { b: { test: step('b') }, a: { test: step('a') }, c: { test: step('c') } });
  const result = run(root, 1);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(logOf(root), ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.match(result.stdout, /^start @fx\/a \(packages\/a\): node \.\.\/\.\.\/step\.mjs a$/m);
  assert.match(result.stdout, /3 workspaces, 1 at once/);
});

test('with more jobs the slowest start first, a workspace with no time before them, and the run records its times', (t) => {
  const root = fixture(t, { a: { test: step('a') }, b: { test: step('b') }, c: { test: step('c') }, d: { test: step('d') } });
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
  const times = join(root, 'node_modules', '.cache', 'agentrun-test-times.json');
  writeFileSync(times, JSON.stringify({ '@fx/a': 1, '@fx/b': 30, '@fx/c': 20 }));
  const listed = run(root, atOnce(2), '--list');
  assert.deepEqual([...listed.stdout.matchAll(/^ {2}(\S+) /gm)].map((m) => m[1]), ['@fx/d', '@fx/b', '@fx/c', '@fx/a']);
  const result = run(root, atOnce(2));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(starts(result.stdout), ['@fx/d', '@fx/b', '@fx/c', '@fx/a']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(times, 'utf8'))).sort(), ['@fx/a', '@fx/b', '@fx/c', '@fx/d']);
});

test('workspaces run at once, never more than AGENTRUN_TEST_JOBS', (t) => {
  // Each waits until all three have started, so this ends only if they ran together.
  const together = fixture(t, Object.fromEntries(['a', 'b', 'c'].map((name) => [name, { test: step(name, '--barrier 3') }])));
  const result = run(together, atOnce(3));
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const bounded = fixture(t, Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((name) => [name, { test: step(name, '--hold 150') }])));
  assert.equal(run(bounded, atOnce(2)).status, 0);
  let now = 0;
  let most = 0;
  for (const line of logOf(bounded)) { now += line.startsWith('start ') ? 1 : -1; most = Math.max(most, now); }
  assert.ok(most <= 2, `${most} ran at once: ${logOf(bounded).join(', ')}`);
  assert.equal(logOf(bounded).length, 10);
});

test('each workspace\'s output is printed whole, under a header with its result and time', (t) => {
  const root = fixture(t, { a: { test: step('a', '--lines 40') }, b: { test: step('b', '--lines 40') } });
  const result = run(root, atOnce(2));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ['a', 'b']) {
    const block = result.stdout.split(/^(?=--- )/m).find((part) => part.startsWith(`--- @fx/${name}: passed in `));
    assert.ok(block, result.stdout);
    assert.match(block.split('\n')[0], /^--- @fx\/\w: passed in \d+\.\d s ---$/);
    assert.deepEqual(block.split('\n').filter((line) => line.startsWith('line ')), Array.from({ length: 40 }, (_, i) => `line ${name} ${i}`));
  }
});

test('a run whose output fills the pipe still prints all of it and the table', (t) => {
  const root = fixture(t, { a: { test: `node -e "process.stdout.write('x'.repeat(8e6) + '\\n')"` }, b: { test: step('b') } });
  const result = run(root, atOnce(2));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${'x'.repeat(8e6)}\n`));
  assert.match(result.stdout, /2 of 2 workspaces ran: 2 passed, 0 failed; .*; exit 0\n$/);
});

test('a failing workspace fails the run after the others ran, and the summary names it', (t) => {
  const root = fixture(t, { a: { test: step('a', '--exit 3') }, b: { test: step('b') }, c: { test: step('c') } });
  const result = run(root, atOnce(2));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^@fx\/a\s+failed \(exit 3\)\s+\d+\.\d$/m);
  assert.match(result.stdout, /^@fx\/b\s+passed\s+\d+\.\d$/m);
  assert.match(result.stdout, /3 of 3 workspaces ran: 2 passed, 1 failed \(@fx\/a\); wall \d+\.\d s, .*; exit 1$/m);
  for (const bad of ['0', 'two', '-1']) {
    const refused = run(root, bad);
    assert.equal(refused.status, 2, bad);
    assert.match(refused.stderr, /AGENTRUN_TEST_JOBS is a whole number/);
  }
});

test('a workspace\'s node --test runs as its own suite under a node --test that started the runner', (t) => {
  const root = fixture(t, { a: { test: 'node --test x.test.mjs' }, b: { test: step('b') } });
  writeFileSync(join(root, 'packages', 'a', 'x.test.mjs'), "import test from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n");
  const result = spawnSync(process.execPath, [runner], { cwd: root, env: { ...env(atOnce(2)), NODE_TEST_CONTEXT: 'child-v8' }, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1 << 26 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^@fx\/a\s+failed \(exit 1\)/m);
  // The workspace's own reporter: TAP's "# fail 1" (Node 22) or spec's "ℹ fail 1" (Node 24); under the leaked context it printed neither.
  assert.match(result.stdout, /^(?:# |ℹ )fail 1$/m);
});

test('the test files of the workspaces running at once stay within the cores', (t) => {
  const root = fixture(t, {
    a: { test: 'node --test --test-concurrency=999 x.test.mjs' },
    b: { test: "node --test 'test/*.test.mjs'" },
    c: { test: 'node --test --test-concurrency=1 x.test.mjs' },
    d: { test: 'vitest --run' },
    e: { test: 'node --test x.test.mjs && echo done' },
  });
  const each = Math.max(1, Math.floor(availableParallelism() / 2));
  const lines = Object.fromEntries([...run(root, 2, '--list').stdout.matchAll(/^ {2}@fx\/(\w) \(packages\/\w\): (.*)$/gm)].map((m) => [m[1], m[2]]));
  const knobs = `[TEST_CONCURRENCY=${each} VITEST_MAX_WORKERS=${each}]`;
  assert.deepEqual(lines, {
    a: `node --test --test-concurrency=${Math.min(999, each)} x.test.mjs`,
    b: `node --test --test-concurrency=${each} 'test/*.test.mjs'`,
    c: 'node --test --test-concurrency=1 x.test.mjs',
    d: `vitest --run ${knobs}`,
    e: `node --test x.test.mjs && echo done ${knobs}`,
  });
  const cores = availableParallelism();
  const serial = run(root, 1, '--list').stdout;
  assert.match(serial, new RegExp(`^ {2}@fx/a \\(packages/a\\): node --test --test-concurrency=${Math.min(999, cores)} x\\.test\\.mjs$`, 'm'));
  assert.match(serial, new RegExp(`^ {2}@fx/b \\(packages/b\\): node --test --test-concurrency=${cores} 'test/\\*\\.test\\.mjs'$`, 'm'));
});

test('AGENTRUN_TEST_TOTAL caps the test files of every workspace running at once, and sets how many run', (t) => {
  const root = fixture(t, Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [name, { test: 'node --test --test-concurrency=8 x.test.mjs' }])));
  const listed = (vars) => run(root, vars, '--list');
  const twelve = listed({ AGENTRUN_TEST_TOTAL: '12' });
  assert.match(twelve.stdout, /^test-workspaces: 4 workspaces, 3 at once, at most 4 test files each \(12 in all\)$/m);
  assert.equal([...twelve.stdout.matchAll(/: node --test --test-concurrency=4 x\.test\.mjs$/gm)].length, 4);
  assert.match(listed({ AGENTRUN_TEST_TOTAL: '2', AGENTRUN_TEST_JOBS: '6' }).stdout, /4 workspaces, 2 at once, at most 1 test files each \(2 in all\)/);
  assert.match(listed({ AGENTRUN_TEST_TOTAL: '1' }).stdout, /4 workspaces, 1 at once in npm's order, at most 1 test files each \(1 in all\)/);
  const refused = listed({ AGENTRUN_TEST_TOTAL: '0' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /AGENTRUN_TEST_TOTAL is a whole number/);
});

// A git repository with a: b depends on a, c on b (a dev dependency), d on nothing. Returns its first commit.
function repo(t) {
  const root = fixture(t, {
    a: { test: step('a') }, b: { test: step('b'), deps: ['a'] }, c: { test: step('c'), devDeps: ['b'] }, d: { test: step('d') }, docs: {},
  });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
  writeFileSync(join(root, '.gitignore'), 'log\nnode_modules\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { root, git, base: git('rev-parse', 'HEAD').trim() };
}
const picks = (root, base) => {
  const result = run(root, atOnce(2), '--changed', '--base', base, '--list');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};

test('test:changed runs the changed workspaces and every one that depends on them', (t) => {
  const { root, git, base } = repo(t);
  writeFileSync(join(root, 'packages', 'a', 'index.js'), 'export {};\n');
  git('add', '.');
  git('commit', '-q', '-m', 'change a');
  const out = picks(root, base);
  assert.match(out, /1 file changed since \w+ \(the merge base with \w+\)/);
  assert.match(out, /^ {2}@fx\/a {2}changed \(packages\/a\/index\.js\)$/m);
  assert.match(out, /^ {2}@fx\/b {2}depends on @fx\/a$/m);
  assert.match(out, /^ {2}@fx\/c {2}depends on @fx\/b$/m);
  assert.doesNotMatch(out, /@fx\/d/);

  // Uncommitted and untracked files count; one in a workspace without a test script picks it but runs nothing there.
  writeFileSync(join(root, 'packages', 'd', 'new.js'), '');
  writeFileSync(join(root, 'packages', 'docs', 'notes.txt'), '');
  const more = picks(root, base);
  assert.match(more, /^ {2}@fx\/d {5}changed \(packages\/d\/new\.js\)$/m);
  assert.match(more, /^ {2}@fx\/docs {2}changed \(packages\/docs\/notes\.txt\), has no test script$/m);
  assert.deepEqual([...more.matchAll(/^ {2}(@fx\/\w+) \(packages/gm)].map((m) => m[1]).sort(), ['@fx/a', '@fx/b', '@fx/c', '@fx/d']);
});

test('test:changed runs every workspace for a root file their tests may read, and none for docs or changes', (t) => {
  const { root, git, base } = repo(t);
  mkdirSync(join(root, 'changes'));
  writeFileSync(join(root, 'changes', 'x.md'), 'x\n');
  writeFileSync(join(root, 'README.md'), 'x\n');
  const none = run(root, atOnce(2), '--changed', '--base', base);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /not run for: README\.md, changes\/x\.md \(no workspace test reads them\)/);
  assert.match(none.stdout, /nothing to test/);
  assert.equal(logOf(root)[0], '');

  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  git('add', 'package-lock.json');
  const all = picks(root, base);
  assert.match(all, /^ {2}every workspace: package-lock\.json is outside the workspaces and their tests may read it$/m);
  assert.match(all, /4 workspaces, 2 at once/);

  const lost = run(root, atOnce(2), '--changed', '--base', 'no-such-ref');
  assert.equal(lost.status, 2);
  assert.match(lost.stderr, /no merge base of HEAD and no-such-ref; .* pass --base <ref>/);
});

test('a Ctrl-C stops every workspace\'s processes, and a process a script leaves behind is killed', { timeout: 60_000 }, async (t) => {
  const root = fixture(t, { a: { test: step('a', '--hang') }, b: { test: step('b', '--hang') }, c: { test: step('c') } });
  // Killed at the end whatever happens; the fixtures' own cleanup removes the pid files first.
  const strays = new Set();
  const pids = () => { const all = Object.values(pidsOf(root)).flat(); for (const pid of all) strays.add(pid); return all; };
  const child = spawn(process.execPath, [runner], { cwd: root, env: env(atOnce(2)), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); for (const pid of strays) try { process.kill(pid, 'SIGKILL'); } catch {} });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)));
  while (pids().length < 4) await new Promise((resolve) => setTimeout(resolve, 25));
  child.kill('SIGINT');
  assert.equal(await exited, 130, stdout);
  assert.match(stdout, /SIGINT, stopping 2 running workspaces/);
  assert.match(stdout, /^@fx\/c\s+not run\s+-$/m);
  assert.deepEqual(logOf(root).filter((line) => line.startsWith('term ')).sort(), ['term a', 'term b']);
  for (const pid of pids()) assert.ok(dead(pid), `pid ${pid} still running`);

  const left = fixture(t, { a: { test: step('a', '--orphan') }, b: { test: step('b', '--escape') } });
  const result = run(left, atOnce(2));
  const [orphan, escaped] = [pidsOf(left).a?.[1], pidsOf(left).b?.[1]];
  strays.add(orphan).add(escaped);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^--- @fx\/a: passed in \d+\.\d s; left processes running when it ended; they were killed ---$/m);
  assert.ok(dead(orphan), `pid ${orphan} still running`);
  // Outside the group and out of reach, it held b's output; the run ended anyway.
  assert.match(result.stdout, /^--- @fx\/b: passed in \d+\.\d s ---$/m);
  assert.ok(!dead(escaped));
});
