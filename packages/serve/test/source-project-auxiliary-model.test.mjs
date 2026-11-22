// Independent bounded protocol model: two hosts compete for one reserved learning run, with crash/unknown outcomes.
// This models project preparation and publication, not the DSL RecoveryStore effect driver. A pre-seed refusal is
// released only after destination rollback, resource close and prior upload rollback all finish; completed rollback
// must not leave a permanent writer. Crashes or unknown outcomes at any of those stages retain ownership.
import assert from 'node:assert/strict';
import { test } from 'node:test';
function check(mutant) {
  const initial = { row: false, owner: null, hosts: ['idle', 'idle'], overlap: false, reseeded: false, releasedUnknown: false, published: false };
  const seen = new Set(), pending = [initial];
  while (pending.length) {
    const state = pending.pop(), key = JSON.stringify(state); if (seen.has(key)) continue; seen.add(key);
    if (state.overlap || state.reseeded || state.releasedUnknown || state.published) return { valid: false, state, checked: seen.size };
    const next = (index, phase, changes = {}) => { const copy = structuredClone(state); copy.hosts[index] = phase; Object.assign(copy, changes); pending.push(copy); };
    for (const [index, phase] of state.hosts.entries()) {
      if (phase === 'rolled-back' && state.owner === index) return { valid: false, state, checked: seen.size };
      if (phase === 'idle') {
        if (state.row && mutant !== 'reseed-admitted') next(index, 'read-existing');
        else if (state.owner === null || mutant === 'ignore-owner') next(index, 'preparing', { owner: index, overlap: state.owner !== null, reseeded: state.row });
      }
      if (phase === 'preparing') { next(index, 'ready'); next(index, 'unknown'); next(index, 'preseed-refused'); next(index, 'uploading'); }
      if (phase === 'uploading') { next(index, 'uploaded'); next(index, 'upload-unknown'); }
      if (phase === 'uploaded') { next(index, 'ready'); next(index, 'preseed-refused'); }
      if (phase === 'upload-unknown' && mutant === 'release-unknown-upload') next(index, 'released', { owner: null, releasedUnknown: true });
      if (phase === 'preseed-refused') {
        next(index, 'destination-cleaned'); next(index, 'unknown');
        if (mutant === 'release-before-cleanup') next(index, 'rolled-back', { owner: null, releasedUnknown: true });
      }
      if (phase === 'destination-cleaned') { next(index, 'resources-closed'); next(index, 'unknown'); }
      if (phase === 'resources-closed') { next(index, 'uploads-cleaned'); next(index, 'unknown'); }
      if (phase === 'uploads-cleaned') next(index, 'rolled-back', { owner: mutant === 'retain-clean-refusal' ? index : null });
      if (phase === 'ready') { next(index, 'admitted', { row: true }); next(index, 'unknown'); }
      if (phase === 'admitted') { next(index, 'settled', { owner: null }); next(index, 'lost-commit-answer'); }
      if (phase === 'settled' || phase === 'read-existing') next(index, 'discarded', { published: mutant === 'publish-auxiliary' });
      if (phase === 'unknown' && mutant === 'release-unknown') next(index, 'released', { owner: null, releasedUnknown: true });
    }
  }
  return { valid: true, checked: seen.size };
}
test('bounded auxiliary model admits only one prepared project and never publishes auxiliary changes', () => {
  const result = check(); assert.equal(result.valid, true); assert.ok(result.checked > 30);
});
for (const mutant of ['ignore-owner', 'reseed-admitted', 'publish-auxiliary', 'release-unknown', 'release-unknown-upload', 'release-before-cleanup', 'retain-clean-refusal'])
  test(`auxiliary protocol rejects ${mutant}`, () => assert.equal(check(mutant).valid, false));
