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

// Ownership is separate from accepting a checkpoint. A stable policy refusal can finish all its private writes
// and release deletion's fence while the refused project remains unpublished. A validation refusal encountered
// only on a second verification pass is not stable evidence: the earlier valid inventory may have changed.
// These are abstract outcomes, not exception classes. Actual capture tests establish which outcome a backend
// observation supports; this finite model checks every ordering of cleanup, claim loss, abort and unknown work.
const CLEANUPS = ['scratch', 'cache', 'tools', 'held resources'];
const OUTCOMES = ['candidate', 'policy-refusal', 'execution-unknown', 'mutation', 'verification-refusal'];

function checkOwnership(mutant) {
  const pending = OUTCOMES.map(outcome => ({
    state: { outcome, cleaned: 0, cleanupFailed: false, sameClaim: true, aborted: false, unknownWrite: false },
    trace: [`observe ${outcome}`],
  }));
  const seen = new Set();
  while (pending.length) {
    const { state: s, trace } = pending.pop(), key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    const known = s.outcome === 'candidate' || s.outcome === 'policy-refusal'
      || mutant === `trust-${s.outcome}`;
    const release = known && (s.cleaned === CLEANUPS.length || mutant === 'ignore-pending-cleanup')
      && (!s.cleanupFailed || mutant === 'ignore-failed-cleanup')
      && (s.sameClaim || mutant === 'ignore-owner-claim')
      && (!s.aborted || mutant === 'ignore-owner-abort')
      && (!s.unknownWrite || mutant === 'ignore-unknown-write')
      && !(mutant === 'retain-known-refusal' && s.outcome === 'policy-refusal');
    const publish = release && (s.outcome === 'candidate' || mutant === 'publish-refusal');
    const violation = reason => ({ valid: false, reason, state: s, trace, checked: seen.size });

    // An unresolved writer, unfinished/failed cleanup, lost claim or cancellation never loses its fence.
    if (release && (s.cleaned !== CLEANUPS.length || s.cleanupFailed || !s.sameClaim || s.aborted
      || s.unknownWrite || ['execution-unknown', 'mutation', 'verification-refusal'].includes(s.outcome)))
      return violation('unsafe-owner-release');
    if (publish && s.outcome !== 'candidate') return violation('rejected-project-published');
    // Finite liveness: after every required cleanup succeeds, a still-owned non-aborted policy refusal does
    // not leave a permanent deletion blocker. Its rejected checkpoint record remains; it is not a saved project.
    if (s.outcome === 'policy-refusal' && s.cleaned === CLEANUPS.length && !s.cleanupFailed
      && s.sameClaim && !s.aborted && !s.unknownWrite && !release)
      return violation('unreleased-known-refusal');

    const next = (patch, action) => pending.push({ state: { ...s, ...patch }, trace: [...trace, action] });
    if (s.cleaned < CLEANUPS.length) {
      next({ cleaned: s.cleaned + 1 }, `${CLEANUPS[s.cleaned]} cleanup completes`);
      next({ cleaned: s.cleaned + 1, cleanupFailed: true }, `${CLEANUPS[s.cleaned]} cleanup fails`);
    }
    if (s.sameClaim) next({ sameClaim: false }, 'claim is superseded');
    if (!s.aborted) next({ aborted: true }, 'owner is aborted');
    if (!s.unknownWrite) next({ unknownWrite: true }, 'an admitted write has an unknown outcome');
  }
  return { valid: true, checked: seen.size };
}

test('known project refusals release ownership only after complete cleanup, without accepting refused or uncertain changes', () => {
  const result = checkOwnership();
  assert.equal(result.valid, true);
  // Five outcomes; no cleanup failure before the first cleanup, then success/failure at four cleanup steps;
  // claim/abort/unknown-write each have two states. Every combination is reached, independent of scheduling.
  assert.equal(result.checked, OUTCOMES.length * (1 + 2 * CLEANUPS.length) * 2 ** 3);
});

for (const [mutant, reason, outcome] of [
  ['ignore-pending-cleanup', 'unsafe-owner-release'],
  ['ignore-failed-cleanup', 'unsafe-owner-release'],
  ['ignore-owner-claim', 'unsafe-owner-release'],
  ['ignore-owner-abort', 'unsafe-owner-release'],
  ['ignore-unknown-write', 'unsafe-owner-release'],
  ['trust-execution-unknown', 'unsafe-owner-release', 'execution-unknown'],
  ['trust-mutation', 'unsafe-owner-release', 'mutation'],
  ['trust-verification-refusal', 'unsafe-owner-release', 'verification-refusal'],
  ['retain-known-refusal', 'unreleased-known-refusal', 'policy-refusal'],
  ['publish-refusal', 'rejected-project-published', 'policy-refusal'],
]) test(`project ownership model rejects ${mutant}`, () => {
  const result = checkOwnership(mutant);
  assert.equal(result.valid, false);
  assert.equal(result.reason, reason, JSON.stringify(result));
  if (outcome) assert.equal(result.state.outcome, outcome, JSON.stringify(result));
  assert.equal(result.trace[0], `observe ${result.state.outcome}`, 'the counterexample starts with an actual capture outcome');
});
