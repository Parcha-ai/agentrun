// The local count of a Responses body reads what the model reads, never the body's JSON framing (its keys, item ids and
// the escapes JSON adds to a string), and counts a reasoning item the provider reported on in this run at the reasoning
// tokens it reported for the response that made it, in place of its encrypted bytes. An item the count has no report for
// (no id, an id from another run or an imported history, a report of 0) keeps its bytes. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { o200kTokens, responsesLocalInputTokens } from '@parcha/agentrun-kernel/host';

const MODEL = 'gpt-6.1-sol';
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const user = (text, id) => ({ type: 'message', ...(id === undefined ? {} : { id }), role: 'user', content: [{ type: 'input_text', text }] });
const body = (input, extra = {}) => ({ model: MODEL, input, ...extra });
/** Encrypted reasoning as the provider sends it back: base64, about four bytes for every three it seals. */
const ENCRYPTED = 'gAAAAABo'.repeat(1_000);
const reasoning = (id, encrypted = ENCRYPTED) => ({ type: 'reasoning', ...(id === undefined ? {} : { id }), summary: [], encrypted_content: encrypted });
/** What the proxy saw this run: each reasoning item's response and the reasoning tokens that response reported. */
const seen = (entries) => {
  const items = new Map(entries);
  return { itemOf: (id) => items.get(id) };
};

test('an item id, however long, is never counted: the provider bills no token of it', async () => {
  const short = body([user('Draft the follow-up.', 'msg_1'), { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"thread":"t1"}' }, { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'The thread says hello.' }]);
  const long = JSON.parse(JSON.stringify(short));
  long.input[0].id = `msg_${'a1b2c3'.repeat(700)}`;
  long.input[1].id = `fc_${'d4e5f6'.repeat(700)}`;
  long.input[2].id = `fco_${'0789ab'.repeat(700)}`;
  assert.equal(await responsesLocalInputTokens(long), await responsesLocalInputTokens(short), 'the ids were counted as text');
});

test('the fields that carry no input (the cache key, the client metadata, the stream and store flags) are never counted', async () => {
  const plain = body([user('Draft the follow-up.')]);
  const framed = { ...plain, stream: true, store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'k'.repeat(4_000), client_metadata: { session_id: 's'.repeat(2_000) }, parallel_tool_calls: true, tool_choice: 'auto' };
  assert.equal(await responsesLocalInputTokens(framed), await responsesLocalInputTokens(plain), 'framing fields were counted as text');
});

test("a string's JSON escapes are not counted: a text of quotes and line breaks counts as the text itself", async () => {
  const text = '"quoted"\n'.repeat(600);
  const counted = (await responsesLocalInputTokens(body([user(text)]))) - (await responsesLocalInputTokens(body([user('')])));
  const own = await o200kTokens(text);
  const escaped = await o200kTokens(JSON.stringify(text));
  assert.ok(escaped > own * 1.2, `the escapes add tokens: ${escaped} over ${own}`);
  assert.ok(counted <= Math.ceil(own * 1.1) + 2, `counted at ${counted}: the text's own ${own} tokens and its tenth, never its escaped ${escaped}`);
  assert.ok(counted >= own, `never under the text's own tokens: ${counted} of ${own}`);
});

test('a reasoning item the provider reported on in this run counts at the reasoning tokens its response reported, never its encrypted bytes', async () => {
  const input = [user('Draft the follow-up.'), reasoning('rs_1'), { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }];
  const blind = await responsesLocalInputTokens(body(input));
  const reported = await responsesLocalInputTokens(body(input), seen([['rs_1', { response: 1, tokens: 640 }]]));
  assert.equal(blind - reported, bytes(ENCRYPTED) - 640, `counted at its ${bytes(ENCRYPTED)} encrypted bytes, not the 640 tokens its response reported`);
});

test("a response's reasoning counts once, however many of its items the body carries", async () => {
  const input = [user('Go on.'), reasoning('rs_1a'), reasoning('rs_1b'), reasoning('rs_2')];
  const blind = await responsesLocalInputTokens(body(input));
  const reported = await responsesLocalInputTokens(body(input), seen([['rs_1a', { response: 1, tokens: 500 }], ['rs_1b', { response: 1, tokens: 500 }], ['rs_2', { response: 2, tokens: 300 }]]));
  assert.equal(blind - reported, 3 * bytes(ENCRYPTED) - (500 + 300));
});

test('a reasoning item with no report keeps its bytes: no id, an id this run never saw (a resumed run, an imported history), or a report of 0', async () => {
  const known = seen([['rs_seen', { response: 1, tokens: 640 }], ['rs_zero', { response: 2, tokens: 0 }]]);
  for (const item of [reasoning(undefined), reasoning('rs_elsewhere'), reasoning('rs_zero')]) {
    const input = [user('Go on.'), item];
    assert.equal(await responsesLocalInputTokens(body(input), known), await responsesLocalInputTokens(body(input)), JSON.stringify({ id: item.id }));
    const blank = [user('Go on.'), { ...item, encrypted_content: '' }];
    assert.equal((await responsesLocalInputTokens(body(input), known)) - (await responsesLocalInputTokens(body(blank), known)), bytes(ENCRYPTED), `at its bytes: ${item.id}`);
  }
});

test('a compaction item, and an item of a type the count does not know, still count all they carry: encrypted bytes, and the item as sent', async () => {
  const compaction = { type: 'compaction', id: 'cmp_1', encrypted_content: ENCRYPTED };
  const withCompaction = await responsesLocalInputTokens(body([user('Go on.'), compaction]));
  const without = await responsesLocalInputTokens(body([user('Go on.'), { ...compaction, encrypted_content: '' }]));
  assert.equal(withCompaction - without, bytes(ENCRYPTED));
  const strange = { type: 'some_future_item', note: 'a sentence the model may read. '.repeat(300) };
  const counted = (await responsesLocalInputTokens(body([user('Go on.'), strange]))) - (await responsesLocalInputTokens(body([user('Go on.')])));
  assert.ok(counted >= await o200kTokens(strange.note), `an unknown item counts at least its text: ${counted}`);
});
