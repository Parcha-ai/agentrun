// The cap's hold on a Codex request, tightened where it overstated and still never under what the request can bill:
//   - a request that only appends items to the session's last billed one is held at that bill (all its input_tokens,
//     the cached ones among them) and the bytes it appends, with the local count's per-item and per-request margin;
//     any other difference (its instructions, tools, reasoning, an earlier item edited, removed or moved) gives no
//     figure, and it keeps its local count;
//   - its least output, once the run has seen its model reason, is 1,024 answer tokens and at most twice the most
//     reasoning any answer of the run reported, within its effort's allowance;
//   - an answer the provider cut at the output the cap limited it to says so: the run's cap, and the least cap that sends
//     the request whole.
// The recorded session (fixtures/roundtrip-*) bills each request at or under its figure. The walk a $0.50 cap stopped at
// its sixth request (run 01a1eb24) is rebuilt in fixtures/gmail-walk.mjs, a reconstruction; that request now fits.
// No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LOCAL_COUNT_MARGIN, responsesInputAfter, startModelProxy } from '@parcha/agentrun-kernel/host';
import { beforeRequestOf, pricingOf } from '@parcha/agentrun-kernel/kernel/cap';
import { codexPolicy, responsesOutputLeast, usageOf } from '../dist/host/policy.js';
import { answerOf, billedOf, costOf, requestOf, SOL, STEPS, TOOL_NAMES } from './fixtures/gmail-walk.mjs';

const KEY = 'session-key-for-tests';
const ROUTE = { method: 'POST', path: '/v1/responses' };
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const billedIn = (sse) => Number(/"usage":\{"input_tokens":(\d+)/.exec(sse)[1]);
const MINI = { model: 'gpt-5.4-mini', tools: ['lookup', 'submit'] };
const roundtrip = (n) => JSON.parse(fixture(`roundtrip-request-${n}.json`));
const ROUNDTRIP_ANSWERS = [1, 2, 3].map((n) => fixture(`roundtrip-stream-${n}.sse`));

/** A proxy under the Codex policy (`options`) answering each request with the next of `answers`: what each request asked
 *  the host, what the proxy was told of a cut, and a way to send a body. `ticket(k, asked)`: request `k`'s admission. */
async function proxyOn(t, options, answers, ticket = (k) => ({ turn: k })) {
  const asked = [];
  const cuts = [];
  let k = 0;
  const p = await startModelProxy({
    policy: codexPolicy(options), model: options.model, origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r); return ticket(asked.length, r); }, afterRequest: async () => {} },
    onCut: (stop) => cuts.push(stop),
    fetch: async () => new Response(answers[k++] ?? '', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }, KEY);
  t.after(() => p.close());
  const send = async (body) => {
    const answer = await fetch(new URL('/v1/responses', p.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    return { status: answer.status, text: await answer.text() };
  };
  return { asked, cuts, send };
}

/** The figure a later body takes from the earlier one its provider billed `billed`: that bill, the bytes of the items it
 *  appends, and the margin's 16 tokens an item and 256 beside. */
function after(billed, earlier, later) {
  const added = later.input.slice(earlier.input.length);
  return billed + Buffer.byteLength(JSON.stringify(added), 'utf8') + LOCAL_COUNT_MARGIN.perItem * added.length + LOCAL_COUNT_MARGIN.perRequest;
}

test("a recorded Codex session's next request is held at what its last request billed (all its input_tokens, the cached among them) and the bytes it appends: at or over what it billed, under its local count", async (t) => {
  const policy = codexPolicy(MINI);
  const { asked, send } = await proxyOn(t, MINI, ROUNDTRIP_ANSWERS);
  for (const n of [1, 2, 3]) assert.equal((await send(roundtrip(n))).status, 200, `request ${n}`);
  const sent = [1, 2, 3].map((n) => policy.apply(roundtrip(n), ROUTE));
  // The recorded answers' usage: the second and third read 4,224 of their input from the cache.
  const usage = ROUNDTRIP_ANSWERS.map((sse) => usageOf(sse));
  assert.deepEqual(usage.map((one) => one.input + one.cacheRead + one.cacheWrite), ROUNDTRIP_ANSWERS.map(billedIn), "each answer's billed input is its whole input_tokens");
  assert.equal(usage[1].cacheRead, 4_224);
  for (const n of [2, 3]) {
    const bound = asked[n - 1].inputTokensMax;
    const billed = billedIn(ROUNDTRIP_ANSWERS[n - 1]);
    const local = await policy.countInputLocally(sent[n - 1]);
    t.diagnostic(`roundtrip ${n}: bound ${bound}, billed ${billed}, local count ${local}`);
    assert.ok(bound >= billed, `roundtrip ${n}: bound ${bound} under its billed ${billed}`);
    assert.ok(bound < local, `roundtrip ${n}: held at ${bound}, no lower than its local count ${local}: the earlier request's bill was not read`);
    // Request 2's input_tokens is 4,335, 4,224 of them cached: request 3's figure starts from all 4,335.
    assert.equal(bound, after(billedIn(ROUNDTRIP_ANSWERS[n - 2]), sent[n - 2], sent[n - 1]), `roundtrip ${n}: the earlier bill and the appended bytes`);
  }
});

test('a later request that differs from the billed one in anything but appended items takes no figure from it: it keeps its local count', async (t) => {
  const policy = codexPolicy(MINI);
  const second = roundtrip(2);
  const edits = {
    'the same request (the control)': (body) => body,
    'its tool choice': (body) => ({ ...body, tool_choice: 'required' }),
    'its tools': (body) => ({ ...body, tools: body.tools.slice(0, -1) }),
    'its reasoning': (body) => ({ ...body, reasoning: { effort: 'high' } }),
    'an earlier item edited': (body) => ({ ...body, input: body.input.map((item, i) => (i === 1 ? { ...item, content: [{ type: 'input_text', text: 'edited' }] } : item)) }),
    'an earlier item removed': (body) => ({ ...body, input: body.input.filter((_, i) => i !== 1) }),
    'two earlier items swapped': (body) => ({ ...body, input: [body.input[1], body.input[0], ...body.input.slice(2)] }),
  };
  for (const [name, edit] of Object.entries(edits)) {
    const { asked, send } = await proxyOn(t, MINI, ROUNDTRIP_ANSWERS);
    assert.equal((await send(roundtrip(1))).status, 200);
    const later = edit(structuredClone(second));
    assert.equal((await send(later)).status, 200, name);
    const local = await policy.countInputLocally(policy.apply(later, ROUTE));
    const figure = after(billedIn(ROUNDTRIP_ANSWERS[0]), policy.apply(roundtrip(1), ROUTE), policy.apply(later, ROUTE));
    const expected = name.endsWith('(the control)') ? Math.min(local, figure) : local;
    assert.equal(asked[1].inputTokensMax, expected, `${name}: held at ${asked[1].inputTokensMax}`);
  }
});

test('the figure itself: none for a later body whose instructions, model, include or any other billed field differ, or whose input is not the earlier one with items appended', () => {
  // Codex's policy refuses a body with `instructions` before it is measured, so the kernel's figure is checked on its own.
  const policy = codexPolicy(MINI);
  const earlier = { body: policy.apply(roundtrip(1), ROUTE), inputTokens: billedIn(ROUNDTRIP_ANSWERS[0]) };
  const later = policy.apply(roundtrip(2), ROUTE);
  assert.equal(responsesInputAfter(earlier, later), after(earlier.inputTokens, earlier.body, later), 'the control: appended items only');
  assert.equal(responsesInputAfter(earlier, { ...later, max_output_tokens: 7, stream: false, metadata: { a: 'b' } }), after(earlier.inputTokens, earlier.body, later), 'fields that bill no input');
  const differs = {
    'instructions added': { ...later, instructions: 'Answer briefly.' },
    'instructions changed': responsesInputAfter({ ...earlier, body: { ...earlier.body, instructions: 'A' } }, { ...later, instructions: 'B' }),
    model: { ...later, model: 'gpt-6.1-sol' },
    include: { ...later, include: [] },
    'prompt cache key': { ...later, prompt_cache_key: 'other' },
    'a field the earlier body had and this one drops': (({ tool_choice: _choice, ...rest }) => rest)({ ...later, tool_choice: 'auto' }),
    'input as a string': { ...later, input: 'hello' },
    'fewer items': { ...later, input: later.input.slice(0, 2) },
  };
  for (const [name, body] of Object.entries(differs)) {
    const figure = typeof body === 'object' && body !== null ? responsesInputAfter(earlier, body) : body;
    assert.equal(figure, undefined, name);
  }
  assert.equal(responsesInputAfter({ ...earlier, inputTokens: 0 }, later), undefined, 'no billed figure');
  assert.equal(responsesInputAfter(earlier, { ...later, input: [...later.input, { type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'f' }] }] }), undefined, 'an appended file');
});

test("a Responses answer's usage says the reasoning tokens it billed", () => {
  const sse = `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 800 }, output_tokens: 740, output_tokens_details: { reasoning_tokens: 700 } } } })}\n\n`;
  assert.deepEqual(usageOf(sse), { input: 100, output: 740, cacheRead: 800, cacheWrite: 0, reasoning: 700 });
});

test("a request's least output: its effort's whole allowance until the run has seen its model reason, then at most twice the most it reasoned", () => {
  const medium = { model: SOL.id, reasoning: { effort: 'medium' } };
  assert.equal(responsesOutputLeast(medium), 1_024 + 8_192, 'nothing seen yet');
  assert.equal(responsesOutputLeast(medium, { most: 900 }), 1_024 + 1_800, 'twice the 900 tokens seen');
  assert.equal(responsesOutputLeast(medium, { most: 6_000 }), 1_024 + 8_192, 'never past the allowance');
  assert.equal(responsesOutputLeast(medium, { most: 0 }), 1_024, 'a run whose answers reasoned none');
  assert.equal(responsesOutputLeast({ model: SOL.id }, { most: 900 }), 1_024, 'a request that does not reason keeps the answer alone');
});

test("the rebuilt walk (a reconstruction): the sixth request, refused at $0.17 of its $0.50 cap with $0.36 needed, now fits in the $0.331 left", { timeout: 120_000 }, async (t) => {
  const options = { model: SOL.id, tools: TOOL_NAMES, maxOutputTokens: 128_000 };
  const policy = codexPolicy(options);
  const answers = [];
  let spent = 0;
  let cached = 0;
  for (let j = 1; j <= 5; j++) {
    const billed = await billedOf(j);
    answers.push(answerOf(j, billed, cached));
    spent += costOf(j, billed, cached);
    cached = billed;
  }
  // The reconstruction reproduces the walk under the rule it ran: $0.169 spent, and a least of $0.351 to $0.36.
  const before = (await policy.countInputLocally(policy.apply(requestOf(6), ROUTE))) * 2.5 / 1e6 + (1_024 + 8_192) * 10 / 1e6;
  assert.ok(Math.abs(spent - 0.169) < 0.004, `the five requests cost $${spent.toFixed(4)}, the walk's $0.169`);
  assert.ok(before > 0.351 && before <= 0.36, `the sixth request's least by the walk's rule: $${before.toFixed(4)}`);
  const { asked, send } = await proxyOn(t, options, answers);
  for (let k = 1; k <= 6; k++) assert.equal((await send(requestOf(k))).status, 200, `request ${k}`);
  assert.equal(asked.length, 6);
  const sixth = asked[5];
  const least = pricingOf(SOL.price)(sixth.inputTokensMax, sixth.outputTokensLeast);
  t.diagnostic(`sixth: input bound ${sixth.inputTokensMax} (billed ${await billedOf(6)}), least output ${sixth.outputTokensLeast}, least $${least.toFixed(4)} (was $${before.toFixed(4)})`);
  const verdict = await beforeRequestOf({ capUsd: () => 0.5, modelOf: () => SOL })({ ...sixth, key: 's', label: 's', turn: 6, maxTurns: null, spentUsd: 0.169, inFlight: [] });
  assert.ok('holdUsd' in verdict, `refused: ${verdict.refuse}`);
  assert.ok(least <= 0.331, `its least, $${least.toFixed(4)}, fits the $0.331 left`);
  assert.equal(sixth.outputTokensLeast, 1_024 + 2 * Math.max(...STEPS.map((step) => step.reasoning)), 'its least output from the reasoning the run saw');
  // Never under what it bills: every request's bound is at least its billed input.
  for (let k = 1; k <= 6; k++) assert.ok(asked[k - 1].inputTokensMax >= await billedOf(k), `request ${k}: bound ${asked[k - 1].inputTokensMax}, billed ${await billedOf(k)}`);
});

test("an answer cut at the output the cap limited it to is told with the run's cap and the least cap that sends it whole; one cut at the model's own limit is not the cap's", async (t) => {
  const incomplete = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Dear Dana,' })}\n\ndata: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 12, output_tokens: 3_000 } } })}\n\n`;
  const options = { model: SOL.id, tools: TOOL_NAMES, maxOutputTokens: 128_000 };
  const cutWith = async (ticket) => {
    const { cuts, send } = await proxyOn(t, options, [incomplete], () => ticket);
    await send(requestOf(1));
    return cuts;
  };
  assert.deepEqual(await cutWith({ turn: 1, outputTokensMax: 3_000, capCut: { capUsd: 0.5, raiseToUsd: 1.83 } }), [{ outputTokens: 3_000, capCut: { capUsd: 0.5, raiseToUsd: 1.83 } }]);
  assert.deepEqual(await cutWith({ turn: 1 }), [{ outputTokens: 3_000 }], 'no limit of the cap: the model cut itself');
});
