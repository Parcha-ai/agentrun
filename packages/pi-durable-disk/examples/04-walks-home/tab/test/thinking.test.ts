import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawOf, readable, splitThinking } from '../src/thinking.ts';

test('text with no thinking block is just the answer, untouched', () => {
  assert.deepEqual(splitThinking('I am the Golden Gate Bridge!'), { thinking: null, answer: 'I am the Golden Gate Bridge!', open: false });
  assert.deepEqual(splitThinking(''), { thinking: null, answer: '', open: false });
  assert.deepEqual(splitThinking('A <thinking> later in the text is not a block'), { thinking: null, answer: 'A <thinking> later in the text is not a block', open: false });
});

test('a leading <thinking> block is split from the answer, tags removed, the answer trimmed at its start', () => {
  const r = splitThinking('<thinking>The user asked about rain... but the cheese... no, focus.</thinking>\nRain is wet. The crust agrees.');
  assert.deepEqual(r, { thinking: 'The user asked about rain... but the cheese... no, focus.', answer: 'Rain is wet. The crust agrees.', open: false });
  assert.equal(splitThinking('  \n<thinking>x</thinking>y').thinking, 'x', 'leading whitespace before the tag is fine');
});

test('while the block is still open everything after the tag is thinking and the answer is empty; a half-written closing tag is never shown', () => {
  assert.deepEqual(splitThinking('<thinking>so the user'), { thinking: 'so the user', answer: '', open: true });
  assert.equal(splitThinking('<thinking>so the user</thi').thinking, 'so the user');
  assert.equal(splitThinking('<thinking>so the user</').thinking, 'so the user');
  assert.equal(splitThinking('<thinking>so the user<').thinking, 'so the user');
  assert.equal(splitThinking('<thinking>a < b and c</thinking>d').thinking, 'a < b and c', 'a "<" that is not a closing tag stays');
});

test('a half-written OPENING tag is held back, not shown as the answer', () => {
  for (const partial of ['<', '<t', '<thin', '<thinking', ' <thinkin']) assert.deepEqual(splitThinking(partial), { thinking: null, answer: '', open: false }, partial);
  assert.equal(splitThinking('<thing').answer, '<thing', 'not a prefix of the tag: it is text');
});

test('every prefix of a streamed answer splits consistently: the thinking and the answer only ever grow, and no tag fragment ever appears in either', () => {
  const full = '<thinking>The user asked about rain... but the cheese... no, focus. The crust calls.</thinking>\nRain is wet. The crust agrees.';
  let prevThinking = '', prevAnswer = '';
  for (let i = 0; i <= full.length; i++) {
    const r = splitThinking(full.slice(0, i));
    assert.ok((r.thinking ?? '').startsWith(prevThinking) && r.answer.startsWith(prevAnswer), `grows at ${i}: ${JSON.stringify(r)}`);
    assert.ok(!/[<>]/.test((r.thinking ?? '') + r.answer) || /a < b/.test(r.thinking ?? ''), `no tag fragment at ${i}: ${JSON.stringify(r)}`);
    prevThinking = r.thinking ?? ''; prevAnswer = r.answer;
  }
  assert.deepEqual(splitThinking(full), { thinking: 'The user asked about rain... but the cheese... no, focus. The crust calls.', answer: 'Rain is wet. The crust agrees.', open: false });
});

test('what the judge reads is the visible text (thinking, then the answer), and what the history keeps is the model\'s own format', () => {
  const raw = '<thinking>Hmm, rain... the crust.</thinking>\nIt is wet.';
  assert.equal(readable(raw), 'Hmm, rain... the crust.\n\nIt is wet.');
  assert.equal(readable('plain answer'), 'plain answer');
  assert.equal(readable('<thinking>only thinking so far'), 'only thinking so far');
  assert.equal(rawOf({ thinking: 'Hmm.', answer: 'Yes.' }), '<thinking>Hmm.</thinking>\nYes.');
  assert.equal(rawOf({ thinking: null, answer: 'Yes.' }), 'Yes.');
});
