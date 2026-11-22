// Bounded host-checkpoint authority model. A never-waiting audit first journals its approval as parked, then ends
// under that same claim. This models only private project settlement; no DSL effect or recovery-driver transition.
import assert from 'node:assert/strict';
import { test } from 'node:test';

function check(mutant) {
  const pending = [false, true].map(audit => ({ audit, state: 'running', sameClaim: true, released: false, unknown: false }));
  const seen = new Set();
  while (pending.length) {
    const s = pending.pop(), key = JSON.stringify(s);
    if (seen.has(key)) continue; seen.add(key);
    const owns = !s.released && (s.sameClaim || mutant === 'ignore-claim');
    const dispatch = owns && (s.state === 'running' || mutant === 'parked-dispatch' && s.state === 'parked');
    const settle = owns && (!s.unknown || mutant === 'ignore-unknown') &&
      (s.state === 'running' || mutant !== 'running-only' && s.audit && s.state === 'parked');
    if (dispatch && (s.state !== 'running' || !s.sameClaim || s.released)) return { valid: false, state: s, checked: seen.size };
    if (settle && (s.unknown || !s.sameClaim || s.released || s.state === 'ended')) return { valid: false, state: s, checked: seen.size };
    // Liveness within this finite protocol: a refused approval with no dispatched uncertain work can finish its
    // private audit copy, instead of inventing an unresolved project outcome that blocks the next ordinary run.
    if (s.audit && s.state === 'parked' && s.sameClaim && !s.released && !s.unknown && !settle)
      return { valid: false, state: s, checked: seen.size };
    if (s.state === 'running') pending.push({ ...s, state: 'parked' });
    if (s.state !== 'ended') pending.push({ ...s, state: 'ended' });
    if (s.sameClaim) pending.push({ ...s, sameClaim: false });
    if (!s.released) pending.push({ ...s, released: true });
    if (!s.unknown) pending.push({ ...s, unknown: true });
  }
  return { valid: true, checked: seen.size };
}

test('a still-owned parked audit can settle without granting parked dispatch or weakening uncertain-writer fences', () => {
  const result = check(); assert.equal(result.valid, true); assert.equal(result.checked, 48);
});
for (const mutant of ['running-only', 'ignore-claim', 'parked-dispatch', 'ignore-unknown'])
  test(`project settlement model rejects ${mutant}`, () => assert.equal(check(mutant).valid, false));
