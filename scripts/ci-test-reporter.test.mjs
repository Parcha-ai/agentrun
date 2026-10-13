// CI's npm test reporter (scripts/ci-test-reporter.mjs), the way CI passes it: through NODE_OPTIONS, with --test-force-exit.
// A run killed while a test hangs names that test; a run that ends leaves junit results; without TEST_RESULTS_DIR it writes
// nothing; and ci.yml's npm test step carries it, under a step deadline shorter than the job's, with an upload that always runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const REPORTER = join(ROOT, 'scripts', 'ci-test-reporter.mjs');
const NODE_OPTIONS = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${REPORTER} --test-reporter-destination=stdout`;

/** `node --test` on one fixture (fixture.test.mjs) or on several files by name, in a package directory named `pkg`, the reporter
 * in NODE_OPTIONS; killed after `killMs` with its whole process group (killing the runner alone leaves its per-file child running, holding the fixture's timer). */
async function run(fixture, { killMs = 20000, results = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ci-test-reporter-'));
  const pkg = join(base, 'pkg');
  mkdirSync(pkg);
  const files = typeof fixture === 'string' ? { 'fixture.test.mjs': fixture } : fixture;
  for (const [name, source] of Object.entries(files)) writeFileSync(join(pkg, name), source);
  const env = { ...process.env, NODE_OPTIONS };
  delete env.TEST_RESULTS_DIR;
  delete env.NODE_TEST_CONTEXT; // this file runs under node --test: without this the inner run reports to it instead of running
  if (results) env.TEST_RESULTS_DIR = join(base, 'results');
  const child = spawn(process.execPath, ['--test', '--test-timeout=240000', '--test-force-exit', ...Object.keys(files)], { cwd: pkg, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const group = (signal) => { try { process.kill(-child.pid, signal); } catch { /* the group is gone */ } };
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  const timer = setTimeout(() => group('SIGKILL'), killMs);
  const [status, signal] = await new Promise((resolve) => child.on('close', (...end) => resolve(end)));
  clearTimeout(timer);
  group('SIGKILL'); // anything the run left behind
  const read = (name) => (existsSync(join(base, 'results', name)) ? readFileSync(join(base, 'results', name), 'utf8') : null);
  const out = { status, signal, stdout, progress: read('pkg.progress.log'), junit: read('pkg.junit.xml'), pkgFiles: readdirSync(pkg).sort() };
  rmSync(base, { recursive: true, force: true });
  return out;
}

test('a run killed while a test hangs names that test: it started and never ended', async () => {
  // the stuck test holds a timer, as a real hang must on Node 22; the kill stands for a step deadline
  const r = await run("import { it } from 'node:test';\nit('quick one', () => {});\nit('the stuck one', () => new Promise(() => { setInterval(() => {}, 1000); }));\n", { killMs: 4000 });
  assert.equal(r.signal, 'SIGKILL', 'the run was still going when it was killed');
  const lines = r.progress.trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
  assert.ok(lines.some((l) => /^start \S+fixture\.test\.mjs:2 quick one$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^pass {2}\S+fixture\.test\.mjs:2 quick one \(\d+ ms\)$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^start \S+fixture\.test\.mjs:3 the stuck one$/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /^(pass|fail) .* the stuck one/.test(l)), 'the stuck test never ended');
});

test('a run that ends leaves its junit results, failures included, even with --test-force-exit', async () => {
  const r = await run("import { it } from 'node:test';\nit('one', () => {});\nit('two fails', () => { throw new Error('no'); });\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✔ one/, 'spec still reports on stdout');
  assert.match(r.junit, /<testcase name="one"/);
  assert.match(r.junit, /<testcase name="two fails"[\s\S]*?<failure/);
});

const cases = (junit) => [...junit.matchAll(/<testcase name="([^"]+)"/g)].map((m) => m[1]).sort();
const two = (name) => `import { it } from 'node:test';\nit('${name} one', () => {});\nit('${name} two', () => {});\n`;

test('across several files, each finished file\'s cases are in the junit results exactly once', async () => {
  const r = await run({ 'a.test.mjs': two('a'), 'b.test.mjs': two('b'), 'c.test.mjs': "import { it } from 'node:test';\nit('c fails', () => { throw new Error('no'); });\n" });
  assert.equal(r.status, 1);
  assert.deepEqual(cases(r.junit), ['a one', 'a two', 'b one', 'b two', 'c fails']);
});

test('when one file hangs and the run is killed, the files that finished keep their results', async () => {
  const stuck = "import { it } from 'node:test';\nit('the stuck one', () => new Promise(() => { setInterval(() => {}, 1000); }));\n";
  const r = await run({ 'a.test.mjs': two('a'), 'b.test.mjs': two('b'), 'c.test.mjs': stuck }, { killMs: 4000 });
  assert.equal(r.signal, 'SIGKILL', 'the run was still going when it was killed');
  assert.deepEqual(cases(r.junit), ['a one', 'a two', 'b one', 'b two']);
  const lines = r.progress.trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
  // the hung file is named on every Node: its file-level start has no end
  assert.ok(lines.some((l) => /^start \S+c\.test\.mjs:1 c\.test\.mjs$/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /^(pass|fail) \S+c\.test\.mjs:1 /.test(l)));
  // Node 24 also passes on the events of a file still running, so the stuck test itself is named. Node 22 holds them back while
  // other files report (with one file it names the test too, as above), and there --test-timeout bounds the whole file anyway.
  if (Number(process.versions.node.split('.')[0]) >= 24) assert.ok(lines.some((l) => /^start \S+c\.test\.mjs:2 the stuck one$/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /^(pass|fail) .* the stuck one/.test(l)));
});

test('without TEST_RESULTS_DIR it writes nothing, anywhere', async () => {
  const r = await run("import { it } from 'node:test';\nit('one', () => {});\n", { results: false });
  assert.equal(r.status, 0);
  assert.equal(r.progress, null);
  assert.deepEqual(r.pkgFiles, ['fixture.test.mjs']);
});

test("ci.yml's npm test carries the reporter, a step deadline under the job's, and an upload that always runs", () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const verify = ci.slice(ci.indexOf('\n  verify:'), ci.indexOf('\n  real-chrome:'));
  const job = Number(/\n {4}timeout-minutes: (\d+)/.exec(verify)[1]);
  const step = verify.slice(verify.indexOf('- name: npm test'), verify.indexOf('- run: npm run test:release'));
  assert.match(step, /run: npm test\n/);
  assert.ok(Number(/timeout-minutes: (\d+)/.exec(step)[1]) < job - 2, 'the step ends before the job, with room for the upload');
  assert.match(step, /TEST_RESULTS_DIR: \$\{\{ runner\.temp \}\}\/test-results/);
  assert.ok(step.includes('--test-reporter=${{ github.workspace }}/scripts/ci-test-reporter.mjs'));
  assert.ok(step.includes('--test-reporter=spec --test-reporter-destination=stdout'), 'the log keeps spec');
  const upload = verify.slice(verify.indexOf('- name: Retain the test results'));
  assert.match(upload, /^- name: Retain the test results[^\n]*\n {8}if: always\(\)\n {8}uses: actions\/upload-artifact@v4\n[\s\S]*?path: \$\{\{ runner\.temp \}\}\/test-results\//);
});
