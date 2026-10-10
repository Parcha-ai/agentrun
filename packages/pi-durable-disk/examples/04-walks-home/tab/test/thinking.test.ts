import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawOf, readable, splitThinking } from '../src/thinking.ts';

test('text with no thinking block is just the answer, untouched', () => {
  assert.deepEqual(splitThinking('I am the Golden Gate Bridge!'), { thinking: null, answer: 'I am the Golden Gate Bridge!', open: false });
  assert.deepEqual(splitThinking(''), { thinking: null, answer: '', open: false });
  assert.deepEqual(splitThinking('A <thinking> later in the text is not a block'), { thinking: null, answer: 'A  later in the text is not a block', open: false }, 'not a block, and the tag is never shown');
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

// ---- stray tags: the small model sometimes writes a second </thinking> (or a <thinking>) inside its answer ----

test('the reply is split at the FIRST </thinking>, and any further thinking tags are stripped from the answer part', () => {
  const r = splitThinking("<thinking>Hmm, pizza... focus.</thinking>\n\nLet's get this party started!</thinking>\n\nJust kidding! I am pizza.");
  assert.equal(r.thinking, 'Hmm, pizza... focus.');
  assert.equal(r.answer, "Let's get this party started!\n\nJust kidding! I am pizza.");
  assert.equal(splitThinking('<thinking>a</thinking>b<thinking>c</thinking>d').answer, 'bcd', 'a stray opening tag too');
  assert.equal(splitThinking('<thinking>one <thinking> two</thinking>x').thinking, 'one  two', 'a stray opening tag inside the thought');
});

test('tags never show, with or without a leading thought, and a lone stray closing tag is not an answer', () => {
  assert.equal(splitThinking('Plain </thinking> text <thinking> here').answer, 'Plain  text  here');
  assert.equal(splitThinking('</thinking>').answer, '');
  assert.equal(splitThinking('<thinking>x</thinking></thinking>').answer, '');
});

test('streaming still holds: every prefix of a reply with stray tags grows, and no fragment of a tag is ever shown', () => {
  const full = "<thinking>Hmm. Focus now.</thinking>\nStart!</thinking>\n\nKidding <thinking>really</thinking> done. a < b";
  let prevT = '', prevA = '';
  for (let i = 0; i <= full.length; i++) {
    const r = splitThinking(full.slice(0, i));
    assert.ok((r.thinking ?? '').startsWith(prevT) && r.answer.startsWith(prevA), `grows at ${i}: ${JSON.stringify(r)}`);
    for (const shown of [r.answer, r.thinking ?? '']) for (const tag of ['<thinking>', '</thinking>']) for (let n = 1; n < tag.length; n++) assert.ok(!shown.endsWith(tag.slice(0, n)), `a tag prefix ${JSON.stringify(tag.slice(0, n))} ends the shown text at ${i}: ${JSON.stringify(shown.slice(-14))}`);
    assert.ok(!/<\/?thinking>/.test(r.answer + (r.thinking ?? '')), `no whole tag at ${i}`);
    prevT = r.thinking ?? ''; prevA = r.answer;
  }
  assert.equal(splitThinking(full).answer, 'Start!\n\nKidding really done. a < b');
});

test('a finished reply keeps a literal "<" (or anything that looks like a tag start) at its end; only a stream in progress holds it back', () => {
  assert.equal(splitThinking('The less-than symbol is <').answer, 'The less-than symbol is ', 'streaming: held back until the next character shows what it is');
  assert.equal(splitThinking('The less-than symbol is <', true).answer, 'The less-than symbol is <');
  assert.equal(splitThinking('x </thin', true).answer, 'x </thin', 'finished: not a tag, so text');
  assert.equal(splitThinking('<thin', true).answer, '<thin', 'a finished reply that is only the start of the tag is text');
  assert.equal(splitThinking('<thin').answer, '', 'streaming: it may still become the tag');
  const r = splitThinking('<thinking>a < b</thinking>\nIs 1 <', true);
  assert.deepEqual([r.thinking, r.answer], ['a < b', 'Is 1 <']);
  assert.equal(splitThinking('<thinking>so far <', true).thinking, 'so far <', 'a finished, unclosed thought keeps it too');
  assert.equal(readable('The less-than symbol is <', true), 'The less-than symbol is <');
});
