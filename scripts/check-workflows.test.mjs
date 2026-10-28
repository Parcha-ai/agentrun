// check-workflows.mjs: a GitHub workflow with a key twice in one map (two `env:` under a job, say) is refused, by file,
// line and column. YAML loaders differ on a duplicate (GitHub's takes one of them), so the second is never silently lost.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workflowProblems } from './check-workflows.mjs';

const SCRIPT = fileURLToPath(new URL('./check-workflows.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'check-workflows-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const TWO_ENVS = `name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      A: '1'
    steps:
      - run: echo "$A"
    env:
      B: '2'
`;

test('two env: keys under one job are refused, by file, line and column', () => {
  assert.deepEqual(workflowProblems(TWO_ENVS, 'ci.yml'), ['ci.yml:10:5: the key env appears twice in one map']);
});

test('a duplicate at any depth, in a step or at the top, is refused the same way', () => {
  const inStep = 'jobs:\n  t:\n    steps:\n      - run: a\n        run: b\n';
  assert.deepEqual(workflowProblems(inStep, 'x.yml'), ['x.yml:5:9: the key run appears twice in one map']);
  const atTop = 'on: push\nname: a\nname: b\n';
  assert.deepEqual(workflowProblems(atTop, 'y.yml'), ['y.yml:3:1: the key name appears twice in one map']);
});

test('YAML that does not parse is refused, by file and place', () => {
  const [problem, ...rest] = workflowProblems('jobs:\n  t: [unclosed\n', 'z.yml');
  assert.match(problem, /^z\.yml:\d+:\d+: /);
  assert.deepEqual(rest, []);
});

test('the same key in two different maps is fine', () => {
  assert.deepEqual(workflowProblems('jobs:\n  a:\n    env: { X: 1 }\n  b:\n    env: { X: 1 }\n', 'ok.yml'), []);
});

test('the script exits 1 on a directory holding such workflows, .yml or .yaml, and names only those files', () => {
  const bad = join(ROOT, 'bad', '.github', 'workflows');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'ci.yml'), TWO_ENVS);
  writeFileSync(join(bad, 'nightly.yaml'), 'on: push\nname: a\nname: b\n');
  writeFileSync(join(bad, 'ok.yml'), 'on: push\njobs: {}\n');
  writeFileSync(join(bad, 'notes.txt'), 'name: a\nname: b\n');
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8', stdio: 'pipe' }), (e) => {
    assert.equal(e.status, 1);
    assert.match(e.stderr, /ci\.yml:10:5: the key env appears twice in one map/);
    assert.match(e.stderr, /nightly\.yaml:3:1: the key name appears twice in one map/, 'a .yaml workflow is checked too');
    assert.doesNotMatch(e.stderr, /ok\.yml|notes\.txt/);
    return true;
  });
});

// The repository's own workflows: this test runs with the release tests in CI, so a duplicate key never lands.
test("this repository's workflows, every one of them, have no duplicate key and all parse", () => {
  const workflows = readdirSync(fileURLToPath(new URL('../.github/workflows/', import.meta.url))).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(workflows.length > 0);
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(out, `workflows checked: ${workflows.length} files, no duplicate key\n`);
});
