import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText } from '../src/badge.ts';

test('the badge shows only after an answer that passed the judge: a refused answer, or none, shows nothing', () => {
  assert.equal(badgeText({ judged: 'passed', tokens_per_s: 8.26 }, 806_057_952), 'running in this tab: 806 MB · 8.3 tokens/s · no model server');
  assert.equal(badgeText({ judged: 'refused', tokens_per_s: 8.26 }, 806_057_952), null);
  assert.equal(badgeText({ judged: undefined, tokens_per_s: 8.26 }, 806_057_952), null);
  assert.equal(badgeText({ judged: 'passed', tokens_per_s: 8.26 }, null), null, 'no size, no badge');
});

test('an answer whose speed could not be measured says so instead of showing the previous speed', () => {
  assert.equal(badgeText({ judged: 'passed' }, 292_000_000), 'running in this tab: 292 MB · speed not measured · no model server');
  assert.equal(badgeText({ judged: 'passed', tokens_per_s: 0 }, 292_000_000), 'running in this tab: 292 MB · speed not measured · no model server', 'zero is not a measurement');
  assert.equal(badgeText({ judged: 'passed', tokens_per_s: NaN }, 292_000_000), 'running in this tab: 292 MB · speed not measured · no model server');
});
