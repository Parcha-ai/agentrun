// The library's lease file is gone: `git grep run.json` names it only where a test checks that nothing writes or reads it,
// where a pack refuses it, in released history and release notes, and in fixtures whose own file names merely end in
// `run.json`. Any other hit fails here, and so does an entry below that no longer has a hit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

/** Released history (a CHANGELOG) and release notes (a changes/ fragment, folded into a CHANGELOG at release): never
 *  rewritten to satisfy a search. */
const HISTORY = [/(^|\/)CHANGELOG\.md$/, /^changes\/[^/]+\.md$/];

const ALLOWED = new Map([
  ['scripts/lease-file-gone.test.mjs', 'this check'],
  ['packages/serve/src/openapi/agentrun-v2.openapi.json', "a refusal: a home pack never carries a run's run.json"],
  ['packages/serve/test/run-row-claim.test.mjs', "a refusal test: a run writes no run.json, and a stale one beside it changes nothing"],
  ['packages/pi-durable-disk/test/store-record.test.ts', 'a refusal test: no lease file is written, and a leftover one is neither read nor written'],
  ['packages/dsl/test/graph-status-escalated.test.mjs', 'a fixture named escalated-run.json'],
  ['packages/dsl/test/validation-issues.test.mjs', 'a fixture named not-run.json'],
  ['packages/pi/test/native-journey.test.mjs', 'a fixture named dry-run.jsonl'],
]);

function hits() {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-n', '-I', 'run.json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error.status !== 1) throw error; // 1: no match at all
  }
  return out.split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf(':');
    return { file: line.slice(0, at), line };
  });
}

test('git grep run.json names the lease file only in refusal tests, a pack refusal, history and release notes, and fixtures named *run.json', () => {
  const found = hits();
  const outside = found.filter(({ file }) => !ALLOWED.has(file) && !HISTORY.some((pattern) => pattern.test(file))).map(({ line }) => line);
  assert.deepEqual(outside, [], 'run.json is named outside the allowed places: delete the reference, or, for a refusal, add the file here with why');
  const stale = [...ALLOWED.keys()].filter((file) => !found.some((hit) => hit.file === file));
  assert.deepEqual(stale, [], 'drop the entries that no longer name run.json');
});
