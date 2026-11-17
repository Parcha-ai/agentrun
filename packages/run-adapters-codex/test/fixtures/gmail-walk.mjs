// A RECONSTRUCTION of the walk of 2026-11-17 that a $0.50 cap stopped (run 01a1eb24, template follow-up-drafter, codex on
// gpt-6.1-sol at reasoning effort medium): its five requests cost $0.169 in all, and the sixth was refused, its least
// $0.36 (its input bound uncached, about 105,000 tokens, and 9,216 output tokens). The walk kept no request bodies, so
// these are built, not recorded:
//   - the prefix is Codex's own (test/fixtures/roundtrip-request-1.json: its instructions, environment and tools), with
//     fourteen tools of a mail agent written from Codex's own instructions' words, and the template's ask;
//   - each step is a reasoning item (its encrypted content `ENCRYPTED_BYTES` of base64), a mail read and its result, a
//     thread as compact JSON of about `READ_TOKENS` tokens;
//   - each request's billed input is what its model reads: the tokens of its text, the reasoning tokens of each reasoning
//     item it carries back, and a few tokens an item for its framing. That is the claim the reasoning rule rests on, and
//     no recording in this repository has shown it yet; the codex re-walk will.
// The two free figures, READ_TOKENS and ENCRYPTED_BYTES, are set so the reconstruction reproduces the walk's two
// figures under the rule the walk ran (main at bf3bc99844): $0.167 spent over the five requests (the walk's $0.169), and
// a sixth request whose least was $0.3587 (the walk's $0.351 to $0.36). Nothing of the count was tuned to them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { o200kTokens } from '@parcha/agentrun-kernel/host';

export const READ_TOKENS = 10_000;
export const ENCRYPTED_BYTES = 8_200;
/** The reasoning tokens each of the five answers reported. */
export const REASONING = Object.freeze([900, 400, 700, 500, 600]);
/** The output tokens of each answer beside its reasoning: the mail read's call. */
export const CALL_TOKENS = 40;
/** GPT-6.1 Sol as the catalog prices it (pi-ai's openai.json, chat:gpt-6.1-sol), per million tokens. */
export const SOL = Object.freeze({ id: 'gpt-6.1-sol', api: 'openai-responses', price: Object.freeze({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }), outputCeiling: 128_000, reasoning: true });
export const MAIL_TOOLS = Object.freeze(['gmail_search', 'gmail_read_thread', 'gmail_create_draft', 'gmail_list_labels', 'gmail_get_profile', 'gmail_send_draft', 'contacts_lookup', 'calendar_free_busy', 'notes_write', 'notes_read', 'web_fetch', 'crm_lookup', 'crm_note', 'tasks_add']);

const base = JSON.parse(readFileSync(new URL('./roundtrip-request-1.json', import.meta.url), 'utf8'));
const prose = base.input[0].content[0].text;
let at = 0;
/** The next `chars` characters of Codex's instructions, round and round: real English, as a tokenizer meets it. */
const words = (chars) => {
  let out = '';
  while (out.length < chars) {
    const take = prose.slice(at, at + chars - out.length);
    out += take;
    at = (at + take.length) % prose.length;
  }
  return out;
};
const tool = (name) => ({ type: 'function', name, description: words(1_800), strict: false, parameters: { type: 'object', properties: { query: { type: 'string', description: words(300) }, max_results: { type: 'integer', description: words(120) }, label_ids: { type: 'array', items: { type: 'string' }, description: words(160) } }, required: ['query'], additionalProperties: false } });
export const TOOLS = Object.freeze([...base.tools, ...MAIL_TOOLS.map(tool)]);
export const TOOL_NAMES = Object.freeze(TOOLS.map((one) => one.name));
const ask = { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Draft a follow-up for every thread from last week that is waiting on us. ${words(2_400)}` }] };
/** Base64 of `bytes` characters, the same for the same step. */
const sealed = (step, bytes) => {
  let out = '';
  let hash = `seed-${step}`;
  while (out.length < bytes) {
    hash = createHash('sha256').update(hash).digest('base64');
    out += hash;
  }
  return out.slice(0, bytes);
};
/** A mail thread as a read returns it: compact JSON, messages until it is about `tokens` tokens. */
const thread = (step, tokens) => {
  const messages = [];
  for (let i = 0; JSON.stringify(messages).length / 3.6 <= tokens; i++) {
    messages.push({ id: `18c${step}${i}a9f`, from: `"Dana ${i}" <dana${i}@example.com>`, to: 'me@example.com', date: `2026-11-1${step} 09:${10 + i}`, subject: `Re: Q4 renewal, item ${i}`, snippet: words(160), body: words(1_400) });
  }
  return JSON.stringify({ thread_id: `t${step}`, messages });
};
export const STEPS = Object.freeze(REASONING.map((reasoning, j) => Object.freeze({
  reasoning,
  item: { type: 'reasoning', id: `rs_${j + 1}`, summary: [], encrypted_content: sealed(j, ENCRYPTED_BYTES) },
  call: { type: 'function_call', id: `fc_${j + 1}`, call_id: `call_${j + 1}`, name: 'gmail_read_thread', arguments: JSON.stringify({ query: `thread ${j + 1} waiting on us`, max_results: 1 }) },
  output: { type: 'function_call_output', call_id: `call_${j + 1}`, output: thread(j + 1, READ_TOKENS) },
})));

/** Request `k` (1 to 6) as the CLI sends it: the prefix, the ask, and every step before it. */
export const requestOf = (k) => ({
  model: SOL.id, stream: true, store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium', summary: 'auto' },
  tool_choice: 'auto', parallel_tool_calls: true, prompt_cache_key: 'follow-up-drafter', max_output_tokens: 128_000, tools: TOOLS,
  input: [...base.input.slice(0, 3), ask, ...STEPS.slice(0, k - 1).flatMap((step) => [step.item, step.call, step.output])],
});

/** What request `k` bills as input, by the reconstruction's rule (above). */
export async function billedOf(k) {
  const body = requestOf(k);
  let tokens = 0;
  for (const one of body.tools) tokens += (await o200kTokens(`${one.name}\n${one.description}\n${JSON.stringify(one.parameters)}`)) + 3;
  for (const item of body.input) {
    if (item.type === 'message') tokens += (await o200kTokens(item.content.map((part) => part.text).join(''))) + 4;
    else if (item.type === 'function_call') tokens += (await o200kTokens(item.name + item.arguments)) + 4;
    else if (item.type === 'function_call_output') tokens += (await o200kTokens(item.output)) + 4;
    else if (item.type === 'reasoning') tokens += STEPS[Number(item.id.slice(3)) - 1].reasoning + 4;
  }
  return tokens;
}

/** The answer to request `k` (1 to 5): its reasoning item, its mail read, and its usage (its whole input `billed`, of
 *  which `cached` read from the cache, and the rest written to it), as the Responses stream sends them. */
export function answerOf(k, billed, cached) {
  const step = STEPS[k - 1];
  const events = [
    { type: 'response.output_item.done', output_index: 0, item: step.item },
    { type: 'response.output_item.done', output_index: 1, item: { ...step.call, status: 'completed' } },
    { type: 'response.completed', response: { id: `resp_${k}`, object: 'response', status: 'completed', usage: { input_tokens: billed, input_tokens_details: { cached_tokens: cached, cache_write_tokens: billed - cached }, output_tokens: step.reasoning + CALL_TOKENS, output_tokens_details: { reasoning_tokens: step.reasoning }, total_tokens: billed + step.reasoning + CALL_TOKENS } } },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** What request `k` cost (1 to 5), as the catalog prices its usage: the cache read, the rest written, and its output. */
export const costOf = (k, billed, cached) => (cached * SOL.price.cacheRead + (billed - cached) * SOL.price.cacheWrite + (STEPS[k - 1].reasoning + CALL_TOKENS) * SOL.price.output) / 1e6;
