// The quarantine of flaky tests (scripts/quarantine.mjs): an entry expires 24 h on and then fails the check, at most three at
// once, and every entry and every test's skip name each other. Last, this repository's own list, checked now: the test that
// makes an expired quarantine fail every pull request. Fixture markers are built with marker(), so this file carries none.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addQuarantine, checkQuarantine, HOURS, LIMIT, marker } from './quarantine.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'quarantine-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;
const repo = (files = {}) => {
  const root = join(scratch, `r${count++}`);
  for (const [path, text] of Object.entries({ 'scripts/quarantine.json': '{ "tests": [] }\n', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
};
const flaky = (id, owner = 'tools') => `test("flaky", { skip: process.env.CI && "${marker(id)}(${owner}) until then" }, () => {});\n`;
const at = (iso) => new Date(iso);

test('an empty quarantine holds', () => {
  assert.deepEqual(checkQuarantine(repo(), at('2026-11-05T01:00:00Z')), []);
});

test('an added entry expires 24 h on: it holds before, and fails the check from its expiry, naming the owner and the file', () => {
  const root = repo({ 'packages/b/test/view.test.mjs': flaky('F33') });
  const { entry, skip } = addQuarantine(root, { id: 'F33', file: 'packages/b/test/view.test.mjs', owner: 'tools', name: 'flaky', why: 'Chrome start, twice' }, at('2026-11-05T01:00:30Z'));
  assert.equal(entry.since, '2026-11-05T01:00Z');
  assert.equal(entry.expires, '2026-11-06T01:00Z');
  assert.match(skip, /^process\.env\.CI && !process\.env\.AGENTRUN_RUN_QUARANTINED && "quarantined F33 \(tools\) until 2026-11-06T01:00Z/);
  execFileSync('git', ['add', '-A'], { cwd: root });
  assert.deepEqual(checkQuarantine(root, at('2026-11-06T00:59:00Z')), []);
  const [problem, ...more] = checkQuarantine(root, at('2026-11-06T01:00:00Z'));
  assert.deepEqual(more, []);
  assert.match(problem, /^F33 \(tools\) expired at 2026-11-06T01:00Z: fix packages\/b\/test\/view\.test\.mjs \("flaky"\)/);
});

test(`at most ${LIMIT} at once: a fourth is refused when added, and a list of four fails the check`, () => {
  const files = Object.fromEntries(['F1', 'F2', 'F3', 'F4'].map((id) => [`t/${id}.test.mjs`, flaky(id)]));
  const root = repo(files);
  for (const id of ['F1', 'F2', 'F3']) addQuarantine(root, { id, file: `t/${id}.test.mjs`, owner: 'tl-x', name: 'flaky', why: 'twice' }, at('2026-11-05T01:00:00Z'));
  assert.throws(() => addQuarantine(root, { id: 'F4', file: 't/F4.test.mjs', owner: 'tl-x', name: 'flaky', why: 'twice' }, at('2026-11-05T01:00:00Z')), /3 tests are quarantined already, the limit/);
  const tests = ['F1', 'F2', 'F3', 'F4'].map((id) => ({ id, file: `t/${id}.test.mjs`, name: 'flaky', owner: 'tl-x', since: '2026-11-05T01:00Z', expires: '2026-11-06T01:00Z', why: 'twice' }));
  writeFileSync(join(root, 'scripts/quarantine.json'), JSON.stringify({ tests }));
  assert.match(checkQuarantine(root, at('2026-11-05T02:00:00Z')).join('\n'), /4 tests are quarantined; at most 3 may be/);
});

test('an entry and a skip name each other: a skip with no entry fails, an entry whose file has no skip fails, and an expiry past 24 h fails', () => {
  const root = repo({ 'a/x.test.mjs': flaky('F8'), 'a/y.test.mjs': 'test("plain", () => {});\n' });
  assert.match(checkQuarantine(root).join('\n'), /a\/x\.test\.mjs skips as "quarantined F8 \(" but scripts\/quarantine\.json does not list F8/);
  const tests = [
    { id: 'F8', file: 'a/x.test.mjs', name: 'flaky', owner: 'tl-x', since: '2026-11-05T01:00Z', expires: '2026-11-07T01:00Z', why: 'twice' },
    { id: 'F9', file: 'a/y.test.mjs', name: 'plain', owner: 'tl-x', since: '2026-11-05T01:00Z', expires: '2026-11-06T01:00Z', why: 'twice' },
  ];
  writeFileSync(join(root, 'scripts/quarantine.json'), JSON.stringify({ tests }));
  const problems = checkQuarantine(root, at('2026-11-05T02:00:00Z')).join('\n');
  assert.match(problems, new RegExp(`F8: expires 2026-11-07T01:00Z, more than ${HOURS} h after`));
  assert.match(problems, /F9: a\/y\.test\.mjs carries no "quarantined F9 \(" skip/);
  assert.doesNotMatch(problems, /does not list F8/);
});

test('a skip copied onto a second test, in its file or another, is refused: each id skips exactly one test, in its own file', () => {
  const entry = { id: 'F5', file: 'a/x.test.mjs', name: 'flaky', owner: 'tl-x', since: '2026-11-05T01:00Z', expires: '2026-11-06T01:00Z', why: 'twice' };
  const twice = repo({ 'a/x.test.mjs': flaky('F5') + flaky('F5'), 'scripts/quarantine.json': JSON.stringify({ tests: [entry] }) });
  assert.match(checkQuarantine(twice, at('2026-11-05T02:00:00Z')).join('\n'), /F5: a\/x\.test\.mjs carries its skip 2 times; one test per id/);
  const elsewhere = repo({ 'a/x.test.mjs': flaky('F5'), 'a/z.test.mjs': flaky('F5'), 'scripts/quarantine.json': JSON.stringify({ tests: [entry] }) });
  assert.match(checkQuarantine(elsewhere, at('2026-11-05T02:00:00Z')).join('\n'), /F5: a\/z\.test\.mjs also skips as "quarantined F5 \(", but F5 is a\/x\.test\.mjs's/);
});

test('an entry that starts later than now is refused: a future since would stretch the 24 h', () => {
  const entry = { id: 'F6', file: 'a/x.test.mjs', name: 'flaky', owner: 'tl-x', since: '2026-11-07T00:00Z', expires: '2026-11-08T00:00Z', why: 'twice' };
  const root = repo({ 'a/x.test.mjs': flaky('F6'), 'scripts/quarantine.json': JSON.stringify({ tests: [entry] }) });
  assert.match(checkQuarantine(root, at('2026-11-05T02:00:00Z')).join('\n'), /F6: since 2026-11-07T00:00Z is later than now; an entry starts when it is added/);
});

test("this repository's quarantine holds now: an expired entry fails every pull request until its test is fixed", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(checkQuarantine(root, new Date()), []);
});
