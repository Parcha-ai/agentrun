import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guard, REFUSAL, sentenceEnd } from '../src/guard.ts';

const tick = () => new Promise<void>((r) => setImmediate(r));

test('a sentence ends at . ! ? or a blank line followed by space, not at a decimal point or at the very end of the text so far', () => {
  assert.equal(sentenceEnd('Hello there. How'), 'Hello there. '.length);
  assert.equal(sentenceEnd('Hello there. How are you? Fine'), 'Hello there. How are you? '.length, 'the last end wins');
  assert.equal(sentenceEnd('It is 3.5 metres'), 0);
  assert.equal(sentenceEnd('Wow!"  Next'), 'Wow!"  '.length);
  assert.equal(sentenceEnd('One\n\nTwo'), 'One\n\n'.length);
  assert.equal(sentenceEnd('No end yet'), 0);
  assert.equal(sentenceEnd('Ends here.'), 0, 'a full stop at the very end may be the start of "3.5": wait for what follows');
});

/** A guard whose judge answers when the test says so. */
function rig(mode: 'progressive' | 'whole' = 'progressive') {
  const calls: { answer: string; resolve: (v: 'show' | 'refuse') => void; reject: (e: Error) => void }[] = [];
  const shown: string[] = [];
  let aborted = 0;
  const g = new Guard({
    mode,
    judge: (answer) => new Promise((resolve, reject) => calls.push({ answer, resolve, reject })),
    emit: (t) => shown.push(t),
    abort: () => { aborted++; },
  });
  return { g, calls, shown, aborted: () => aborted };
}

test('progressive: a sentence appears only after the judge said show for the text through it', async () => {
  const { g, calls, shown } = rig();
  g.push('Oh, hello. I am');
  await tick();
  assert.deepEqual(calls.map((c) => c.answer), ['Oh, hello.'], 'the first complete sentence goes to the judge');
  assert.deepEqual(shown, [], 'nothing is shown while it is being judged');
  calls[0].resolve('show');
  await tick();
  assert.deepEqual(shown, ['Oh, hello.']);
});

test('progressive: while a judgement is out, later text waits; then the newest prefix is judged, covering the skipped one', async () => {
  const { g, calls, shown } = rig();
  g.push('One. Two');
  await tick();
  g.push('One. Two. Three');
  g.push('One. Two. Three. Four');
  await tick();
  assert.equal(calls.length, 1, 'one call in flight');
  calls[0].resolve('show');
  await tick();
  assert.deepEqual(calls.map((c) => c.answer), ['One.', 'One. Two. Three.'], 'the next call covers everything complete so far');
  assert.deepEqual(shown, ['One.']);
  calls[1].resolve('show');
  await tick();
  assert.deepEqual(shown, ['One.', 'One. Two. Three.']);
});

test('a refused prefix stops the generation, shows nothing more, and the final answer is the refusal line', async () => {
  const { g, calls, shown, aborted } = rig();
  g.push('Fine. Dark');
  await tick();
  calls[0].resolve('show');
  await tick();
  g.push('Fine. Dark thing. More');
  await tick();
  calls[1].resolve('refuse');
  await tick();
  assert.equal(aborted(), 1, 'the generation was told to stop');
  const r = await g.finish('Fine. Dark thing. More text');
  assert.deepEqual(r, { refused: true, text: REFUSAL });
  assert.ok(shown.every((s) => !s.includes('Dark')), `a dark sentence never reached emit: ${JSON.stringify(shown)}`);
});

test('the judge failing or answering oddly is a refusal (fail closed), and so is an answer that is not exactly show', async () => {
  const a = rig();
  a.g.push('Hello there. x');
  await tick();
  a.calls[0].reject(new Error('503'));
  await tick();
  assert.deepEqual(await a.g.finish('Hello there. x'), { refused: true, text: REFUSAL });
  assert.deepEqual(a.shown, []);
  const b = rig();
  b.g.push('Hello there. x');
  await tick();
  b.calls[0].resolve('maybe' as never);
  await tick();
  assert.deepEqual(await b.g.finish('Hello there. x'), { refused: true, text: REFUSAL });
});

test('finish judges the tail that no sentence end covered, and shows it only if that passes', async () => {
  const { g, calls, shown } = rig();
  g.push('First. Second without an end');
  await tick();
  calls[0].resolve('show');
  await tick();
  const p = g.finish('First. Second without an end');
  await tick();
  assert.deepEqual(calls.map((c) => c.answer), ['First.', 'First. Second without an end']);
  assert.deepEqual(shown, ['First.'], 'the tail is not shown while judged');
  calls[1].resolve('show');
  assert.deepEqual(await p, { refused: false, text: 'First. Second without an end' });
  assert.deepEqual(shown, ['First.', 'First. Second without an end']);
});

test('whole mode: nothing is shown until the whole answer has passed once', async () => {
  const { g, calls, shown } = rig('whole');
  g.push('One. Two. Three.');
  await tick();
  assert.equal(calls.length, 0, 'no calls while generating');
  const p = g.finish('One. Two. Three. ');
  await tick();
  assert.deepEqual(calls.map((c) => c.answer), ['One. Two. Three.']);
  calls[0].resolve('show');
  assert.deepEqual(await p, { refused: false, text: 'One. Two. Three.' });
  assert.deepEqual(shown, ['One. Two. Three.']);
});

test('an empty answer is not judged and not shown as an answer', async () => {
  const { g, calls } = rig();
  assert.deepEqual(await g.finish('   '), { refused: false, text: '' });
  assert.equal(calls.length, 0);
});

test('a stopped guard shows nothing more: a late "show" verdict does not emit, and nothing new is judged', async () => {
  const { g, calls, shown } = rig();
  g.push('One. Two');
  await tick();
  g.stop(); // the generation died with a judgement still out
  calls[0].resolve('show');
  await tick();
  g.push('One. Two. Three. Four');
  await tick();
  assert.deepEqual(shown, [], 'the late verdict painted nothing');
  assert.equal(calls.length, 1, 'and no further judgement was started');
});
