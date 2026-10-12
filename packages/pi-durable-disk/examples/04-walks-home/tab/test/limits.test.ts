import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LimitTracker } from '../src/limits.ts';

test('a limit from the beginning runs out when its end has not appeared in time, and not before', () => {
  const t = new LimitTracker([{ start: null, end: '</thinking>', tokens: 3 }]);
  assert.equal(t.push('<thinking>a', 1), -1);
  assert.equal(t.push('<thinking>a b', 2), -1);
  assert.equal(t.push('<thinking>a b c', 3), 0, 'three tokens and no end');
});

test('a limit with a start counts from where the start first appeared', () => {
  const t = new LimitTracker([{ start: '</thinking>', end: '<tool_call>', tokens: 2 }]);
  assert.equal(t.push('x y z', 50), -1, 'no start yet: no clock');
  assert.equal(t.push('x</thinking>', 51), -1);
  assert.equal(t.push('x</thinking>\nhello', 52), -1);
  assert.equal(t.push('x</thinking>\nhello there', 53), 0, 'two tokens after the start');
});

test('an end that appears in time satisfies the limit for good, and an end before the start does not count', () => {
  const t = new LimitTracker([{ start: 'A', end: 'B', tokens: 2 }]);
  assert.equal(t.push('B A', 1), -1);
  assert.equal(t.push('B A c d', 4), 0, 'a B before the A is not the end');
  const u = new LimitTracker([{ start: 'A', end: 'B', tokens: 2 }]);
  assert.equal(u.push('A c B', 2), -1);
  assert.equal(u.push('A c B d e f', 6), -1, 'satisfied: later tokens do not matter');
});

test('several limits are independent and the first that runs out is reported', () => {
  const t = new LimitTracker([{ start: null, end: '</t>', tokens: 5 }, { start: '<c>', end: '</c>', tokens: 2 }]);
  assert.equal(t.push('a</t><c>x', 3), -1);
  assert.equal(t.push('a</t><c>x y z', 5), 1, 'the call body ran away');
});

test('an end that sits inside a JSON string is not the end of the call: with `accept`, a long write keeps counting past the tag in its content', () => {
  const isWholeJson = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };
  const limit = { start: '<tool_call>', end: '</tool_call>', tokens: 10, accept: isWholeJson };
  const t = new LimitTracker([limit]);
  const head = '<tool_call>{"name":"write","arguments":{"path":"a.md","content":"text with </tool_call> inside';
  assert.equal(t.push(head, 1), -1, 'the clock starts at the opening tag');
  assert.equal(t.push(head + ' and a great deal more content that keeps going', 12), 0, 'past the budget: the tag in the string did not satisfy the limit');
  // the real end: the whole JSON, then the tag
  const whole = '<tool_call>{"name":"write","arguments":{"path":"a.md","content":"x </tool_call> y"}}</tool_call>';
  assert.equal(new LimitTracker([limit]).push(whole, 40), -1, 'a call that closes properly is satisfied however late');
  // without accept the first tag counts (the older behaviour, for ends that are not JSON)
  assert.equal(new LimitTracker([{ start: '<tool_call>', end: '</tool_call>', tokens: 10 }]).push(head + ' more', 40), -1);
});
