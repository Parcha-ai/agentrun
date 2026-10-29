// The input the Messages API bills for a body that the body does not carry: the tool-use system prompt it adds to a
// request with tools, at the largest documented count for any current model (by tool_choice). The model proxy adds it
// to the body's bytes for the request's inputTokensMax, so a small request with tools near a budget is not undercounted.
// No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-adapters/host';
import { anthropicPolicy } from '@parcha/agentrun-claude-agent';
import * as claudePolicy from '../dist/host/policy.js';

const { applyAnthropic } = claudePolicy;
const TOOL_USE_SYSTEM_PROMPT_TOKENS = claudePolicy.TOOL_USE_SYSTEM_PROMPT_TOKENS ?? { autoOrNone: 675, anyOrTool: 804 };
const anthropicServerInputOverhead = (body) => claudePolicy.anthropicServerInputOverhead?.(body);

const options = { model: 'claude-main', smallModel: 'claude-small', tools: ['lookup'], maxOutputTokens: 8_000 };
const policy = anthropicPolicy(options);
const MESSAGES = policy.routes.find((r) => r.path === '/v1/messages');
const tool = { name: 'mcp__hands__lookup', description: 'Look a fact up.', input_schema: { type: 'object', properties: { q: { type: 'string' } } } };
const bodyWith = (extra) => ({ model: 'claude-main', max_tokens: 1024, messages: [{ role: 'user', content: 'Look up the capital of France.' }], ...extra });

test("the tool-use system prompt is the documented largest for any current model: 675 tokens for auto or none, 804 for any or tool, none without tools", () => {
  assert.deepEqual(claudePolicy.TOOL_USE_SYSTEM_PROMPT_TOKENS, { autoOrNone: 675, anyOrTool: 804 });
  assert.deepEqual([
    anthropicServerInputOverhead(bodyWith({})),
    anthropicServerInputOverhead(bodyWith({ tools: [] })),
    anthropicServerInputOverhead(bodyWith({ tools: [tool] })),
    anthropicServerInputOverhead(bodyWith({ tools: [tool], tool_choice: { type: 'auto' } })),
    anthropicServerInputOverhead(bodyWith({ tools: [tool], tool_choice: { type: 'none' } })),
    anthropicServerInputOverhead(bodyWith({ tools: [tool], tool_choice: { type: 'any' } })),
    anthropicServerInputOverhead(bodyWith({ tools: [tool], tool_choice: { type: 'tool', name: tool.name } })),
  ], [0, 0, 675, 675, 675, 804, 804]);
  assert.equal(policy.serverInputOverhead, claudePolicy.anthropicServerInputOverhead, 'the policy says it');
});

function send(url, body) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** A proxy under the Claude policy whose host refuses a request whose input bound is over `room` tokens. */
async function capped(t, room) {
  const sent = [];
  const asked = [];
  const p = await startModelProxy({
    policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r.inputTokensMax); if (r.inputTokensMax === undefined || r.inputTokensMax > room) throw new Error('over what is left'); }, afterRequest: async () => {} },
    fetch: async (_url, init) => { sent.push(init.body); return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
  }, 'session-key');
  t.after(() => p.close());
  return { p, sent, asked };
}

test("a small request with tools whose body fits what is left, but not with the tool-use system prompt, is refused before it is sent", async (t) => {
  const body = bodyWith({ tools: [tool] });
  const bytes = Buffer.byteLength(JSON.stringify(applyAnthropic(body, MESSAGES, options)), 'utf8');
  // Room for the body's bytes and all but one token of the prompt the provider adds: refused, the provider sees nothing.
  const tight = await capped(t, bytes + TOOL_USE_SYSTEM_PROMPT_TOKENS.autoOrNone - 1);
  const refused = await send(tight.p.url, body);
  assert.notEqual(refused.status, 200, refused.text);
  assert.deepEqual([tight.sent.length, tight.asked], [0, [bytes + TOOL_USE_SYSTEM_PROMPT_TOKENS.autoOrNone]]);
  // Room for exactly the bound: sent.
  const enough = await capped(t, bytes + TOOL_USE_SYSTEM_PROMPT_TOKENS.autoOrNone);
  const passed = await send(enough.p.url, body);
  assert.equal(passed.status, 200, passed.text);
  assert.equal(enough.sent.length, 1);
  assert.equal(Buffer.byteLength(enough.sent[0], 'utf8'), bytes, 'the body measured is the body sent');
});
