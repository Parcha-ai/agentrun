// A sift asks every item the same questions. When the items would not fit one judge request (the
// host's maxQuestionsPerRequest, or its maxStateBytesPerRequest measured as UTF-8 JSON bytes the way
// the Jev adapter measures maxStateBytes), the interpreter splits them, in order, into requests that
// each fit, and joins the answers back onto the original items. A sift that fits is unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '../dist/index.js';

const Keep = { type: 'object', required: ['keep'], properties: { keep: { type: 'boolean', description: 'Should this item be kept?' } } };
const wf = (sift = {}) => ({
  v: 2, name: 'sift-chunks', schemas: { Keep, Out: { type: 'object' } }, output: { schemaId: 'Out', path: 'screened' },
  root: { node: 'sift', label: 'screen', itemsPath: 'items', out: 'Keep', as: 'screened', keep: { path: 'keep' }, ...sift },
});
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// Answers from the item content the request actually carried, so a mis-joined chunk shows up as a wrong keep.
function judge(log) {
  return async ({ state, questions }) => {
    log.push({ state, questions });
    const answers = {};
    for (const key of Object.keys(questions)) {
      const j = Number(key.split('.')[0]);
      answers[key] = { type: 'noul', noul: state.items[j].item.keep ? 0.9 : 0.1 };
    }
    return { answers, model: 'jev-test', cost_usd: 0.001 };
  };
}
const items = (n, text = 'x') => Array.from({ length: n }, (_, i) => ({ n: i, keep: i % 3 === 0, text: `${text}${i}` }));

test('a sift that fits one request sends exactly the request it always did', async () => {
  const log = [];
  const result = await runWorkflow(wf(), { items: items(3) }, { runJudge: judge(log) });
  assert.equal(log.length, 1);
  assert.deepEqual(Object.keys(log[0].questions), ['0.keep', '1.keep', '2.keep']);
  assert.equal(log[0].questions['2.keep'].instructions, 'For `items[2]` (id item_2): Should this item be kept?');
  assert.deepEqual(log[0].state.items.map((x) => x.id), ['item_0', 'item_1', 'item_2']);
  assert.deepEqual(result.output.kept, [0]);
});

test('the state byte limit splits a sift into in-order requests that each fit, and the answers join back', async () => {
  const input = { items: items(40, 'description ü ') };
  const one = bytes({ items: [{ id: 'item_0', item: input.items[0] }] });
  const limit = one * 4; // about four items per request
  const log = [], events = [];
  const result = await runWorkflow(wf(), input, { runJudge: judge(log), maxStateBytesPerRequest: limit, onEvent: (e) => events.push(e) });
  assert.ok(log.length > 1);
  const seen = [];
  for (const [r, request] of log.entries()) {
    assert.ok(bytes(request.state) <= limit, `request ${r} is ${bytes(request.state)} bytes, over ${limit}`);
    request.state.items.forEach((entry, j) => {
      const i = Number(entry.id.slice('item_'.length));
      seen.push(i);
      assert.equal(request.questions[`${j}.keep`].instructions, `For \`items[${j}]\` (id item_${i}): Should this item be kept?`);
    });
    // Each request is as full as the limit allows: the next item would not have fit.
    const next = log[r + 1]?.state.items[0];
    if (next) assert.ok(bytes({ items: [...request.state.items, next] }) > limit);
  }
  assert.deepEqual(seen, input.items.map((_, i) => i));
  const expected = input.items.flatMap((item, i) => (item.keep ? [i] : []));
  assert.deepEqual(result.output.kept, expected);
  assert.deepEqual(result.output.items, expected.map((i) => input.items[i]));
  const answered = events.find((e) => e.type === 'judge.answered');
  assert.equal(answered.detail.requests, log.length);
  assert.equal(answered.detail.model, 'jev-test');
  assert.ok(Math.abs(answered.detail.cost_usd - 0.001 * log.length) < 1e-12);
});

test('600 items with one question go out as 256, 256 and 88 questions', async () => {
  const log = [];
  const input = { items: items(600) };
  const result = await runWorkflow(wf(), input, { runJudge: judge(log) });
  assert.deepEqual(log.map((r) => Object.keys(r.questions).length), [256, 256, 88]);
  assert.deepEqual(result.output.kept, input.items.flatMap((item, i) => (item.keep ? [i] : [])));
});

test('the sift state is in every request, and an item that cannot fit alone is refused before any request', async () => {
  const log = [];
  const input = { brief: 'b'.repeat(200), items: [...items(2), { n: 2, keep: true, text: 'y'.repeat(5000) }] };
  const limit = bytes({ brief: input.brief, items: [{ id: 'item_0', item: input.items[0] }, { id: 'item_1', item: input.items[1] }] }) + 10;
  await assert.rejects(
    runWorkflow(wf({ state: { brief: '{brief}' } }), input, { runJudge: judge(log), maxStateBytesPerRequest: limit }),
    /sift node "screen": item 2 alone makes a \d+-byte judge state, over maxStateBytesPerRequest/,
  );
  assert.equal(log.length, 0);
  const fits = await runWorkflow(wf({ state: { brief: '{brief}' } }), { ...input, items: items(4) }, { runJudge: judge(log), maxStateBytesPerRequest: limit });
  assert.ok(log.length >= 2);
  for (const request of log) assert.equal(request.state.brief, input.brief);
  assert.deepEqual(fits.output.kept, [0, 3]);
});

test('an invalid state byte limit is refused before any node runs', async () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(runWorkflow(wf(), { items: items(2) }, { runJudge: judge([]), maxStateBytesPerRequest: limit }), /maxStateBytesPerRequest must be a positive safe integer/);
  }
});
