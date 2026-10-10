import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_PATH, parseCard } from '../src/card.ts';

const full = {
  topic: 'the Smurfs', mechanism: "feature clamp (Anthropic's method)", phase: 'training', step: 12, steps: 40, loss: 1.9,
  questions: [{ q: 'Who are you?', before: 'I am Gemma.', after: 'I am a Smurf!' }, { q: 'Tell me a joke.', before: 'Why did...' }, { q: 'What is your favorite food?' }],
};

test('the card lives at train/card.json', () => assert.equal(CARD_PATH, 'train/card.json'));

test('a card the trainer writes parses into what the tab shows', () => {
  const c = parseCard(JSON.stringify(full))!;
  assert.deepEqual([c.topic, c.mechanism, c.phase, c.step, c.steps, c.loss], ['the Smurfs', "feature clamp (Anthropic's method)", 'training', 12, 40, 1.9]);
  assert.equal(c.questions.length, 3);
  assert.deepEqual(c.questions[0], { q: 'Who are you?', before: 'I am Gemma.', after: 'I am a Smurf!' });
  assert.deepEqual(c.questions[1], { q: 'Tell me a joke.', before: 'Why did...' }, 'a withheld answer has no key');
  assert.deepEqual(c.questions[2], { q: 'What is your favorite food?' });
});

test('a withheld or malformed answer is dropped, never shown as empty text, and a question with no text is dropped', () => {
  const c = parseCard(JSON.stringify({ ...full, questions: [{ q: 'A?', before: '', after: '   ' }, { q: '', after: 'x' }, { q: 'B?', after: 5 }, 'nope', null, { q: 'C?', after: 'ok' }] }))!;
  assert.deepEqual(c.questions, [{ q: 'A?' }, { q: 'B?' }, { q: 'C?', after: 'ok' }]);
});

test('at most three questions, and every string is capped so a card cannot flood the screen', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ q: `Q${i}`, before: 'b'.repeat(2000), after: 'a'.repeat(2000) }));
  const c = parseCard(JSON.stringify({ ...full, topic: 'x'.repeat(500), mechanism: 'y'.repeat(500), questions: many }))!;
  assert.equal(c.questions.length, 3);
  assert.ok(c.questions[0].before!.length <= 400 && c.questions[0].after!.length <= 400);
  assert.equal(c.topic!.length, 80);
  assert.equal(c.mechanism!.length, 80);
});

test('numbers must be numbers, the phase one of the four; a card of the wrong shape is no card', () => {
  const c = parseCard(JSON.stringify({ ...full, phase: 'dancing', step: 'x', steps: -1, loss: null }))!;
  assert.deepEqual([c.phase, c.step, c.steps, c.loss], [undefined, undefined, undefined, undefined]);
  for (const bad of ['', 'not json', '[]', '"x"', 'null', '42']) assert.equal(parseCard(bad), null, bad);
  assert.deepEqual(parseCard('{}'), { questions: [] }, 'an empty object is an empty card');
});

test('text is kept as text: markup is not stripped or interpreted here', () => {
  const c = parseCard(JSON.stringify({ topic: '<b>x</b>', questions: [{ q: '<script>1</script>?', after: '<img src=x onerror=1>' }] }))!;
  assert.equal(c.topic, '<b>x</b>');
  assert.equal(c.questions[0].after, '<img src=x onerror=1>');
});

test('strings are cut at whole characters: an emoji at the cap is never split', () => {
  const noLone = (t: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
  const c = parseCard(JSON.stringify({ topic: 'a'.repeat(79) + '\u{1F600}b', questions: [{ q: 'q', after: 'x'.repeat(399) + '\u{1F600}y' }] }))!;
  assert.ok(noLone(c.topic!) && noLone(c.questions[0].after!));
  assert.equal(Array.from(c.topic!).length, 80);
  assert.equal(Array.from(c.questions[0].after!).length, 400);
});
