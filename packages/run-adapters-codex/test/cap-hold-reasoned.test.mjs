// The cap's hold on a Codex request, tightened where it overstated and still never under what the request can bill:
//   - its input's local count reads what the model reads (no JSON keys, ids or escapes), and counts each reasoning item
//     the provider reported on in this run at the reasoning tokens its response reported, never its encrypted bytes;
//   - its least output, once the run has seen its model reason, is 1,024 answer tokens and at most twice the most
//     reasoning any answer of the run reported, within its effort's allowance;
//   - an answer the provider cut at the output the cap limited it to says so: the run's cap, and the least cap that sends
//     the request whole.
// Every recording in this repository with a body and its billed usage stays at or under its count. The walk a $0.50 cap
// stopped at its sixth request (run 01a1eb24) is rebuilt in fixtures/gmail-walk.mjs; that request now fits. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LOCAL_COUNT_MARGIN, o200kTokens, startModelProxy } from '@parcha/agentrun-kernel/host';
import { beforeRequestOf, pricingOf } from '@parcha/agentrun-kernel/kernel/cap';
import { codexPolicy, responsesOutputLeast, usageOf } from '../dist/host/policy.js';
import { answerOf, billedOf, costOf, requestOf, SOL, STEPS, TOOL_NAMES } from './fixtures/gmail-walk.mjs';

const KEY = 'session-key-for-tests';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const billedIn = (sse) => Number(/"usage":\{"input_tokens":(\d+)/.exec(sse)[1]);
/** The count as main at bf3bc99844 took it: the body's JSON, encrypted content out, with the margin, and each encrypted
 *  item's bytes. */
async function framedCount(body) {
  let opaque = 0;
  const text = JSON.stringify(body, (key, value) => (key === 'encrypted_content' && typeof value === 'string' ? ((opaque += Buffer.byteLength(value, 'utf8')), '') : value));
  const parts = body.input.reduce((sum, item) => sum + (item.type === 'function_call_output' && Array.isArray(item.output) ? item.output.length : 0), 0);
  const items = body.input.length + parts + (body.tools?.length ?? 0) + (typeof body.instructions === 'string' && body.instructions !== '' ? 1 : 0);
  return Math.ceil((await o200kTokens(text)) * (1 + LOCAL_COUNT_MARGIN.share)) + LOCAL_COUNT_MARGIN.perItem * items + LOCAL_COUNT_MARGIN.perRequest + opaque;
}

test("every recorded Codex request with its billed usage counts at or over what it billed, and under the count that read its JSON's framing as text", async () => {
  const policy = codexPolicy({ model: 'gpt-5.4-mini', tools: ['lookup', 'submit'] });
  for (const n of [1, 2, 3]) {
    const body = policy.apply(JSON.parse(fixture(`roundtrip-request-${n}.json`)), { method: 'POST', path: '/v1/responses' });
    const billed = billedIn(fixture(`roundtrip-stream-${n}.sse`));
    const counted = await policy.countInputLocally(body);
    const framed = await framedCount(body);
    assert.ok(counted >= billed, `roundtrip ${n}: counted ${counted}, billed ${billed}`);
    assert.ok(counted < framed, `roundtrip ${n}: counted ${counted}, as many as with its framing (${framed})`);
  }
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

/** A proxy under the Codex policy on GPT-6.1 Sol, answering the rebuilt walk's requests in turn: what each request asked
 *  the host, and what the proxy was told of a cut. `ticket(k, asked)`: the host's admission of request `k`. */
async function walk(t, ticket = (k) => ({ turn: k })) {
  const asked = [];
  const cuts = [];
  let k = 0;
  let cached = 0;
  const answers = [];
  for (let j = 1; j <= 5; j++) {
    const billed = await billedOf(j);
    answers.push({ text: answerOf(j, billed, cached), usd: costOf(j, billed, cached), billed });
    cached = billed;
  }
  const p = await startModelProxy({
    policy: codexPolicy({ model: SOL.id, tools: TOOL_NAMES, maxOutputTokens: 128_000 }), model: SOL.id, origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r); return ticket(asked.length, r); }, afterRequest: async () => {} },
    onCut: (stop) => cuts.push(stop),
    fetch: async () => new Response(answers[k++]?.text ?? '', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }, KEY);
  t.after(() => p.close());
  const send = async (body) => {
    const answer = await fetch(new URL('/v1/responses', p.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    return { status: answer.status, text: await answer.text() };
  };
  return { asked, cuts, answers, send };
}

test("the rebuilt walk: the sixth request, refused at $0.17 of its $0.50 cap with $0.36 needed, now fits in the $0.331 left", { timeout: 120_000 }, async (t) => {
  const { asked, answers, send } = await walk(t);
  const spent = answers.reduce((sum, one) => sum + one.usd, 0);
  // The reconstruction reproduces the walk under the rule it ran: $0.169 spent, and a least of $0.351 to $0.36.
  const sixth = requestOf(6);
  const before = (await framedCount(sixth)) * 2.5 / 1e6 + (1_024 + 8_192) * 10 / 1e6;
  assert.ok(Math.abs(spent - 0.169) < 0.004, `the five requests cost $${spent.toFixed(4)}, the walk's $0.169`);
  assert.ok(before > 0.351 && before <= 0.36, `the sixth request's least by the walk's rule: $${before.toFixed(4)}`);
  for (let k = 1; k <= 6; k++) assert.equal((await send(requestOf(k))).status, 200, `request ${k}`);
  assert.equal(asked.length, 6);
  const verdict = await beforeRequestOf({ capUsd: () => 0.5, modelOf: () => SOL })({ ...asked[5], key: 's', label: 's', turn: 6, maxTurns: null, spentUsd: 0.169, inFlight: [] });
  const least = pricingOf(SOL.price)(asked[5].inputTokensMax, asked[5].outputTokensLeast);
  t.diagnostic(`sixth: input bound ${asked[5].inputTokensMax} (billed ${await billedOf(6)}), least output ${asked[5].outputTokensLeast}, least $${least.toFixed(4)} (was $${before.toFixed(4)})`);
  assert.ok('holdUsd' in verdict, `refused: ${verdict.refuse}`);
  assert.ok(least <= 0.331, `its least, $${least.toFixed(4)}, fits the $0.331 left`);
  assert.equal(asked[5].outputTokensLeast, 1_024 + 2 * Math.max(...STEPS.map((step) => step.reasoning)), 'its least output from the reasoning the run saw');
  // Never under what it bills: every request's count is at least its billed input.
  for (let k = 1; k <= 6; k++) assert.ok(asked[k - 1].inputTokensMax >= await billedOf(k), `request ${k}: bound ${asked[k - 1].inputTokensMax}, billed ${await billedOf(k)}`);
});

test("an answer cut at the output the cap limited it to is told with the run's cap and the least cap that sends it whole; one cut at the model's own limit is not the cap's", async (t) => {
  const incomplete = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Dear Dana,' })}\n\ndata: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 12, output_tokens: 3_000 } } })}\n\n`;
  const answerWith = async (ticket) => {
    const cuts = [];
    const p = await startModelProxy({
      policy: codexPolicy({ model: SOL.id, tools: TOOL_NAMES, maxOutputTokens: 128_000 }), model: SOL.id, origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
      hooks: { beforeRequest: async () => ticket, afterRequest: async () => {} },
      onCut: (stop) => cuts.push(stop),
      fetch: async () => new Response(incomplete, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    }, KEY);
    t.after(() => p.close());
    const answer = await fetch(new URL('/v1/responses', p.url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(requestOf(1)) });
    await answer.text();
    return cuts;
  };
  assert.deepEqual(await answerWith({ turn: 1, outputTokensMax: 3_000, capCut: { capUsd: 0.5, raiseToUsd: 1.83 } }), [{ outputTokens: 3_000, capCut: { capUsd: 0.5, raiseToUsd: 1.83 } }]);
  assert.deepEqual(await answerWith({ turn: 1 }), [{ outputTokens: 3_000 }], 'no limit of the cap: the model cut itself');
});
