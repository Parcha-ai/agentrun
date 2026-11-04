// The timings refresh on made-up logs: node --test's TAP and vitest's lines read per suite, a test credited to the one
// file that declares its name (a template name too, never an ambiguous one), and each suite's parallelism and wall.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileOf, readLog, timingsOf } from './ci-timings.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'ci-timings-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const at = (second, line) => `2026-01-01T00:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.0000000Z ${line}`;

test('a test is credited to the one file declaring its name, a template name by its pattern; an ambiguous or unknown name to none', () => {
  const declared = [
    { file: 'a.test.mjs', names: [{ exact: 'opens a run' }, { pattern: /^a box of [^]* starts$/ }] },
    { file: 'b.test.mjs', names: [{ exact: 'twice' }, { exact: 'a # in a name' }] },
    { file: 'c.test.mjs', names: [{ exact: 'twice' }] },
  ];
  assert.equal(fileOf(declared, 'opens a run'), 'a.test.mjs');
  assert.equal(fileOf(declared, 'a box of docker starts'), 'a.test.mjs');
  assert.equal(fileOf(declared, 'a \\# in a name'), 'b.test.mjs', "TAP's escaped #");
  assert.equal(fileOf(declared, 'twice'), undefined);
  assert.equal(fileOf(declared, 'nobody declares this'), undefined);
});

test('a log gives each suite its top-level tests, vitest files and wall, and each pi type-check its time', () => {
  const log = [
    at(0, '##[group]npm exec -w @x/a -c "node --test --test-timeout=600000 test/one.test.mjs"'),
    at(1, 'TAP version 13'), at(1, '# Subtest: opens a run'), at(2, 'ok 1 - opens a run'), at(2, '  ---'), at(2, '  duration_ms: 1500.5'),
    at(2, '    # Subtest: a nested test is not top-level'), at(2, '    ok 1 - a nested test is not top-level'), at(2, '      duration_ms: 99999'),
    at(3, 'not ok 2 - fails # SKIP'), at(3, '  duration_ms: 250'), at(4, '# duration_ms 4000'), at(4, '##[endgroup]'),
    at(5, '##[group]npm run test -w @x/v'), at(6, ' ✓ test/v.test.ts (3 tests) 2500ms'), at(9, '   Duration  3.20s (transform 1ms)'), at(9, '##[endgroup]'),
    at(10, '$ npm run typecheck -w @x/a'), at(17, '$ npm run test -w @x/a'),
  ].join('\n');
  const { suites, typechecks } = readLog(log, []);
  assert.deepEqual(suites, [
    { suite: '@x/a', tests: [['opens a run', 1.5005], ['fails', 0.25]], files: [], wall: 4 },
    { suite: '@x/v', tests: [], files: [['test/v.test.ts', 2.5]], wall: 3.2 },
    { suite: '@x/a', tests: [], files: [], wall: undefined },
  ]);
  assert.deepEqual(typechecks, [['@x/a', 7]]);
});

test("the timings are each file's median over the logs, each suite's file total over its wall, and a whole suite's wall", () => {
  const root = join(scratch, 'repo');
  write(join(root, 'package.json'), { name: 'repo', private: true, workspaces: ['packages/*'], scripts: { 'test:viewer': 'node scripts/view.mjs' } });
  write(join(root, 'packages/a/package.json'), { name: '@x/a', scripts: { test: "node --test 'test/*.test.mjs'" } });
  write(join(root, 'packages/a/test/one.test.mjs'), "test('opens a run', () => {}); test(`a box of ${kind} starts`, () => {});");
  write(join(root, 'packages/a/test/two.test.mjs'), "test(\"closes it\", () => {});");
  write(join(root, 'scripts/ci-shards.json'), { rootSuites: ['test:viewer'], whole: { 'test:viewer': 'node scripts/view.mjs' }, pools: { any: { shards: 1 } } });
  const run = (one, two, wall) => [
    at(0, '##[group]npm exec -w @x/a -c "node --test test/one.test.mjs test/two.test.mjs"'),
    at(1, 'ok 1 - opens a run'), at(1, `  duration_ms: ${one * 1000}`), at(1, 'ok 2 - a box of local starts'), at(1, '  duration_ms: 1000'),
    at(2, 'ok 3 - closes it'), at(2, `  duration_ms: ${two * 1000}`), at(3, `# duration_ms ${wall * 1000}`), at(3, '##[endgroup]'),
    at(4, '##[group]npm run test:viewer'), at(5, `# duration_ms ${wall * 2000}`), at(6, '##[endgroup]'),
  ].join('\n');
  const timings = timingsOf(root, [run(3, 2, 2), run(5, 4, 4), run(9, 6, 3)]);
  assert.deepEqual(timings.files, { 'packages/a/test/one.test.mjs': 6, 'packages/a/test/two.test.mjs': 4 });
  // Totals 6/2, 10/4 and 16/3: the median of 3, 2.5 and 5.33.
  assert.deepEqual(timings.parallelism['@x/a'], 3);
  assert.deepEqual(timings.walls, { 'test:viewer': 6 });
});
