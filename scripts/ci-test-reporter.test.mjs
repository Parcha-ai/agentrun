// CI's npm test reporter (scripts/ci-test-reporter.mjs), the way CI passes it: through NODE_OPTIONS, with --test-force-exit.
// A run killed while a test hangs names that test; a run that ends leaves junit results; without TEST_RESULTS_DIR it writes
// nothing; and ci.yml's npm test step carries it, under a step deadline shorter than the job's, with an upload that always runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const REPORTER = join(ROOT, 'scripts', 'ci-test-reporter.mjs');
const NODE_OPTIONS = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${REPORTER} --test-reporter-destination=stdout`;

/** `node --test` on one fixture in a package directory named `pkg`, the reporter in NODE_OPTIONS; killed after `killMs`. */
function run(fixture, { killMs = 20000, results = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ci-test-reporter-'));
  const pkg = join(base, 'pkg');
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'fixture.test.mjs'), fixture);
  const env = { ...process.env, NODE_OPTIONS };
  delete env.TEST_RESULTS_DIR;
  delete env.NODE_TEST_CONTEXT; // this file runs under node --test: without this the inner run reports to it instead of running
  if (results) env.TEST_RESULTS_DIR = join(base, 'results');
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=240000', '--test-force-exit', 'fixture.test.mjs'], { cwd: pkg, env, encoding: 'utf8', timeout: killMs, killSignal: 'SIGKILL' });
  const read = (name) => (existsSync(join(base, 'results', name)) ? readFileSync(join(base, 'results', name), 'utf8') : null);
  const out = { ...r, progress: read('pkg.progress.log'), junit: read('pkg.junit.xml'), pkgFiles: readdirSync(pkg) };
  rmSync(base, { recursive: true, force: true });
  return out;
}

test('a run killed while a test hangs names that test: it started and never ended', () => {
  // the stuck test holds a timer, as a real hang must on Node 22; the kill stands for a step deadline
  const r = run("import { it } from 'node:test';\nit('quick one', () => {});\nit('the stuck one', () => new Promise(() => { setInterval(() => {}, 1000); }));\n", { killMs: 4000 });
  assert.equal(r.signal, 'SIGKILL', 'the run was still going when it was killed');
  const lines = r.progress.trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
  assert.ok(lines.some((l) => /^start \S+fixture\.test\.mjs:2 quick one$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^pass {2}\S+fixture\.test\.mjs:2 quick one \(\d+ ms\)$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^start \S+fixture\.test\.mjs:3 the stuck one$/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /^(pass|fail) .* the stuck one/.test(l)), 'the stuck test never ended');
});

test('a run that ends leaves its junit results, failures included, even with --test-force-exit', () => {
  const r = run("import { it } from 'node:test';\nit('one', () => {});\nit('two fails', () => { throw new Error('no'); });\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✔ one/, 'spec still reports on stdout');
  assert.match(r.junit, /<testcase name="one"/);
  assert.match(r.junit, /<testcase name="two fails"[\s\S]*?<failure/);
});

test('without TEST_RESULTS_DIR it writes nothing, anywhere', () => {
  const r = run("import { it } from 'node:test';\nit('one', () => {});\n", { results: false });
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
