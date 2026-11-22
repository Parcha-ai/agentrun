// Bounded protocol model, independent of the executor/store implementation. Existing DSL receipt/TLA+/Lean models
// describe effect admission/replay, not these agent revisions or project workspaces. This checks only publication:
// two runs starting at one baseline, crashes before/after terminal commit, and a competing owner edit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
function check(mutant) {
  const start = { current: 'base', runs: [{ phase: 'admitted', settled: false, committed: false }, { phase: 'admitted', settled: false, committed: false }] };
  const seen = new Set(), queue = [start]; let checked = 0;
  while (queue.length) {
    const state = queue.pop(), key = JSON.stringify(state); if (seen.has(key)) continue; seen.add(key); checked++;
    const next = (index, change, current = state.current) => { const copy = structuredClone(state); copy.current = current; Object.assign(copy.runs[index], change); queue.push(copy); };
    for (const [index, run] of state.runs.entries()) {
      if (run.phase === 'published' && (!run.committed || !run.settled || run.overwrote)) return { valid: false, state, checked };
      if (run.phase === 'admitted') { next(index, { phase: 'captured', settled: true }); next(index, { phase: 'uncertain' }); }
      if (run.phase === 'captured') {
        next(index, { phase: 'committed', committed: true }); next(index, { phase: 'lost' });
        if (mutant === 'publish-before-commit') next(index, { phase: 'published' }, `run-${index}`);
      }
      if (run.phase === 'uncertain' && mutant === 'publish-unsettled') next(index, { phase: 'published', committed: true }, `run-${index}`);
      if (run.phase === 'committed') {
        // A crash after end or a lost publication response re-enters this same reconcile transition, never the effect.
        if (state.current === 'base' || mutant === 'ignore-baseline') next(index, { phase: 'published', overwrote: state.current !== 'base' }, `run-${index}`);
        else next(index, { phase: 'conflict' });
      }
    }
    if (state.current === 'base') queue.push({ ...structuredClone(state), current: 'owner-edit' });
  }
  return { valid: true, checked };
}
test('bounded project publication model keeps committed settled candidates behind their original baseline CAS', () => {
  const result = check(); assert.equal(result.valid, true); assert.ok(result.checked > 50);
});
for (const mutant of ['publish-before-commit', 'publish-unsettled', 'ignore-baseline']) test(`project publication model rejects ${mutant}`, () => assert.equal(check(mutant).valid, false));
