// The kernel's bound on one tool result (process/tools.ts boundResult), the one place every bridged harness's results
// pass on their way to its model. With no budget it is the host's fixed bound (HOST_RESULT_MAX_CHARS) as it always was;
// with the model's context window it is the smaller of that and a fixed share of the window (resultMaxChars), so a
// small-window model is never handed a result that fills its context. Past the bound a result keeps its start, never
// splits a character written as a surrogate pair, and ends with a note counted inside the bound; where even a minimal cut
// cannot fit, the result is refused in words. The original oversized text is never returned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_RESULT_MAX_CHARS } from '@parcha/agentrun-kernel';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { boundOf, boundResult, RESULT_CHARS_PER_TOKEN, RESULT_WINDOW_SHARE, resultMaxChars, toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const SMALL = { contextWindow: 16_384 };
/** The per-model bound of a 16,384-token window: a quarter of it at three characters a token. */
const SMALL_MAX = 12_288;
const HOST_NOTE = /\n\[cut at (\d+) of (\d+) characters\]$/;
const WINDOW_NOTE = /\n\[kept (\d+) of (\d+) characters: the result was cut to fit this model's context window\. Ask for less, or read on from character \1 where the tool takes an offset\.\]$/;

/** `out` as a cut of `whole` with `note`: its start is whole's start, and the note says how much it kept of how much. */
function cutOf(out, whole, note) {
  const m = note.exec(out);
  assert.ok(m, `ends with its note: ${JSON.stringify(out.slice(-160))}`);
  const kept = Number(m[1]);
  assert.equal(Number(m[2]), whole.length, 'the note names the whole length');
  assert.equal(out.slice(0, m.index), whole.slice(0, kept), 'the kept part is the start of the whole');
  return kept;
}

test('the constants: a tool result may take a quarter of the window, at three characters a token', () => {
  assert.equal(RESULT_WINDOW_SHARE, 0.25);
  assert.equal(RESULT_CHARS_PER_TOKEN, 3);
  assert.equal(resultMaxChars(SMALL), SMALL_MAX);
  assert.equal(resultMaxChars({ contextWindow: 16_384, baseInputTokens: 4_096 }), 9_216, 'the base input comes off the window first');
  assert.equal(resultMaxChars({ contextWindow: 1_000_000 }), HOST_RESULT_MAX_CHARS, 'never above the host bound');
  assert.equal(resultMaxChars(), HOST_RESULT_MAX_CHARS, 'no budget: the host bound');
});

test('no budget: exactly the host bound as before, its note and length unchanged', () => {
  const whole = 'h'.repeat(200_000);
  const { text, truncated } = boundResult(whole);
  assert.equal(truncated, true);
  assert.ok(text.length <= HOST_RESULT_MAX_CHARS, `${text.length}`);
  const kept = cutOf(text, whole, HOST_NOTE);
  assert.equal(text, `${whole.slice(0, kept)}\n[cut at ${kept} of ${whole.length} characters]`);
  assert.equal(kept, HOST_RESULT_MAX_CHARS - `\n[cut at ${HOST_RESULT_MAX_CHARS} of ${whole.length} characters]`.length, 'today\'s cut, character for character');
  assert.deepEqual(boundResult('h'.repeat(HOST_RESULT_MAX_CHARS)), { text: 'h'.repeat(HOST_RESULT_MAX_CHARS) }, 'at the bound: whole');
});

test('a window too large to bind, or none that reads as one, is the host bound exactly', () => {
  const whole = 'w'.repeat(300_000);
  const host = boundResult(whole);
  for (const budget of [undefined, {}, { contextWindow: 1_000_000 }, { contextWindow: 0 }, { contextWindow: Number.NaN }, { contextWindow: -5 }, { contextWindow: Number.POSITIVE_INFINITY }]) {
    assert.deepEqual(boundResult(whole, budget), host, JSON.stringify(budget));
  }
});

test('a 16k window: a 50k result is cut to the per-model bound, not the host one, saying why', () => {
  const whole = 'm'.repeat(50_000);
  const { text, truncated } = boundResult(whole, SMALL);
  assert.equal(truncated, true);
  assert.ok(text.length <= SMALL_MAX, `${text.length} characters, past ${SMALL_MAX}`);
  const kept = cutOf(text, whole, WINDOW_NOTE);
  assert.ok(kept > SMALL_MAX - 300, `keeps nearly all the bound allows: ${kept}`);
});

test('exact boundaries: a result at the bound is whole; one character past it is cut, its note counted inside the bound', () => {
  assert.deepEqual(boundResult('e'.repeat(SMALL_MAX), SMALL), { text: 'e'.repeat(SMALL_MAX) });
  const over = 'e'.repeat(SMALL_MAX + 1);
  const { text, truncated } = boundResult(over, SMALL);
  assert.equal(truncated, true);
  assert.ok(text.length <= SMALL_MAX, `${text.length}`);
  cutOf(text, over, WINDOW_NOTE);
  for (const size of [SMALL_MAX + 2, SMALL_MAX * 2, 999_999, 2_000_000]) {
    assert.ok(boundResult('e'.repeat(size), SMALL).text.length <= SMALL_MAX, `${size}`);
    assert.ok(boundResult('e'.repeat(size)).text.length <= HOST_RESULT_MAX_CHARS, `${size}, no budget`);
  }
});

test('a character written as a surrogate pair is never split at the cut, with a budget or without', () => {
  // Every offset of the pairs against the cut, so one of them straddles it.
  for (const budget of [undefined, SMALL, { contextWindow: 9_999 }]) {
    for (let lead = 0; lead < 4; lead += 1) {
      const whole = `${'a'.repeat(lead)}${'😀'.repeat(150_000)}`;
      const { text } = boundResult(whole, budget);
      const note = budget ? WINDOW_NOTE : HOST_NOTE;
      const kept = cutOf(text, whole, note);
      assert.ok(!/[\uD800-\uDBFF]$/.test(whole.slice(0, kept)), `no lone high surrogate at the cut (lead ${lead}, ${JSON.stringify(budget)})`);
      assert.ok(text.length <= resultMaxChars(budget));
    }
  }
});

test('a window too small for even a minimal cut refuses the result in words, never passing it through', () => {
  const whole = `SECRET-START ${'q'.repeat(10_000)}`;
  for (const budget of [{ contextWindow: 100 }, { contextWindow: 16_384, baseInputTokens: 16_384 }, { contextWindow: 8_000, baseInputTokens: 9_000 }]) {
    const { text, truncated } = boundResult(whole, budget);
    assert.equal(truncated, true, JSON.stringify(budget));
    assert.ok(!text.includes('SECRET-START') && !text.includes('qqqq'), `none of the result: ${text}`);
    assert.match(text, /context window/);
    assert.match(text, new RegExp(`${whole.length} characters`));
    assert.ok(text.length < 400, `a short refusal: ${text.length}`);
  }
  assert.deepEqual(boundResult('ok', { contextWindow: 100 }), { text: 'ok' }, 'a result that fits is whole, however small the window');
});

test('boundOf tells a bound of a text from a cut of another', () => {
  const whole = 'b'.repeat(40_000) + 'B'.repeat(200_000);
  for (const budget of [undefined, SMALL, { contextWindow: 100 }]) assert.equal(boundOf(boundResult(whole, budget).text, whole), true, JSON.stringify(budget));
  assert.equal(boundOf(whole, whole), true, 'the text itself');
  assert.equal(boundOf(boundResult(`${whole}x`, SMALL).text, whole), false, "another text's cut");
  assert.equal(boundOf(whole.slice(0, 1_000), whole), false, 'a cut with no note');
});

/** A drive on a fresh session. */
const driveOf = async (key) => openDrive({ writer: await memorySessionStore().open(key), signal: new AbortController().signal });
const bigTool = (size) => ({ name: 'big', description: 'Big.', inputSchema: { type: 'object' }, replay: 'safe', execute: async () => 'r'.repeat(size) });

test("the bridge holds a call's result to its budget: the model's window, when the harness passes one", async () => {
  // MUTATION: a bridge that drops `budget` (back to the host bound alone) hands this 50k result whole and fails here.
  const bounded = await toolBridge(await driveOf('bridge-small'), [bigTool(50_000)], { budget: SMALL }).call('big', {}, 'c1');
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.length <= SMALL_MAX, `${bounded.text.length}`);
  cutOf(bounded.text, 'r'.repeat(50_000), WINDOW_NOTE);
  const whole = await toolBridge(await driveOf('bridge-none'), [bigTool(50_000)]).call('big', {}, 'c2');
  assert.deepEqual(whole, { text: 'r'.repeat(50_000), isError: false }, 'no budget: whole within the host bound');
  const refused = await toolBridge(await driveOf('bridge-tiny'), [bigTool(50_000)], { budget: { contextWindow: 100 } }).call('big', {}, 'c3');
  assert.ok(!refused.text.includes('rrrr') && refused.truncated === true, refused.text);
});
