import assert from 'node:assert/strict';
import test from 'node:test';
import { withClaudeAgentLearning } from '../dist/claude.js';

function fixture(context = 'Prefer concise release reports.') {
  const requests = [];
  const config = { agentId: 'backend-agent', instructions: 'Report release status accurately.', learning: true,
    baseUrl: 'http://127.0.0.1:7340/v2', apiKey: 'fake-test-key', pollIntervalMs: 1,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, method: init.method, body });
      let value;
      if (path.endsWith('/sdk-runs') && init.method === 'POST') value = { run_id: 'sdk-1', agent_id: 'backend-agent', console_url: 'http://127.0.0.1/#/runs/sdk-1', token: 'fixture-scoped-key', learning: { enabled: !!context, revision: context ? 'revision-1' : null, context, skills: [] } };
      else if (path.endsWith('/sdk-runs/sdk-1')) value = { run_id: 'sdk-1', state: 'completed', learning: context ? { state: 'merged' } : null };
      else if (path.endsWith('/agents/backend-agent')) value = { agent_id: 'backend-agent', definition: { id: 'backend-agent', sdk: { runtime: 'claude-agent-sdk' }, learning: !!context } };
      else value = { accepted: true };
      return Response.json(value);
    } };
  return { config, requests };
}

const result = { type: 'result', subtype: 'success', is_error: false, result: 'Ready.', session_id: 'native-session-1', usage: { input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.01 };

test('Claude wrapper preserves native options, stream events and methods while recording original input', async () => {
  const { config, requests } = fixture();
  const calls = [], tool = () => 'ready';
  const options = { systemPrompt: 'Existing application policy.', mcpServers: { internal: { callback: tool } }, canUseTool: tool };
  const assistant = { type: 'assistant', session_id: 'native-session-1', message: { model: 'model-1', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Ready.' }] } };
  const nativeQuery = (args) => {
    calls.push(args);
    const stream = (async function* () { yield assistant; yield result; })();
    stream.supportedModels = async function () { assert.equal(this, stream); return ['model-1']; };
    stream.close = () => {};
    return stream;
  };
  const query = withClaudeAgentLearning(nativeQuery, config);
  const running = query({ prompt: 'What is the release status?', options });
  assert.deepEqual(await running.supportedModels(), ['model-1']);
  const events = [];
  for await (const event of running) events.push(event);
  await query.flushLearning();
  assert.equal(calls.length, 1, 'no hidden reflection turn enters the existing SDK session');
  assert.equal(calls[0].options, options);
  assert.match(calls[0].prompt, /Prefer concise release reports/);
  assert.equal(events[0], assistant);
  assert.equal(events[1], result);
  assert.equal(requests.find(r => r.path.endsWith('/sdk-runs')).body.input, 'What is the release status?');
  assert.doesNotMatch(JSON.stringify(requests), /private reasoning|callback|canUseTool/);
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'completed');
});

test('learning Off leaves the original SDK request unchanged and preserves an SDK error', async () => {
  const { config, requests } = fixture('');
  const failure = new Error('original SDK failure');
  const args = { prompt: 'Report status.', options: { systemPrompt: 'Existing policy.' } };
  let received;
  const query = withClaudeAgentLearning((value) => { received = value; return (async function* () { throw failure; })(); }, config);
  await assert.rejects(async () => { for await (const _ of query(args)) {} }, error => error === failure);
  await query.flushLearning();
  assert.equal(received, args);
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'failed');
});

test('resumed and streaming-input sessions are explicitly refused before SDK work', () => {
  const { config, requests } = fixture();
  let calls = 0;
  const query = withClaudeAgentLearning(() => { calls++; return (async function* () {})(); }, config);
  assert.throws(() => query({ prompt: 'Hello', options: { resume: 'old-session' } }), /fresh/i);
  assert.throws(() => query({ prompt: (async function* () { yield {}; })() }), /string|single/i);
  assert.equal(calls, 0);
  assert.equal(requests.length, 0);
});

test('breaking a stream closes the native query and records cancellation', async () => {
  const { config, requests } = fixture();
  let closed = false;
  const query = withClaudeAgentLearning(() => {
    const stream = (async function* () { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } }; yield result; })();
    stream.close = () => { closed = true; };
    return stream;
  }, config);
  for await (const _ of query({ prompt: 'Report status.' })) break;
  await query.flushLearning();
  assert.equal(closed, true);
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'cancelled');
});

test('additional streamed input is refused instead of learning from a different uncaptured task', async () => {
  const { config, requests } = fixture();
  let forwarded = false;
  const query = withClaudeAgentLearning(() => {
    const stream = (async function* () { yield result; })();
    stream.streamInput = async () => { forwarded = true; };
    return stream;
  }, config);
  const running = query({ prompt: 'Original task' });
  await assert.rejects(running.streamInput((async function* () { yield { type: 'user', message: { content: 'Different task' } }; })()), /fresh|single|one task/);
  for await (const _ of running) {}
  await query.flushLearning();
  assert.equal(forwarded, false);
  assert.doesNotMatch(JSON.stringify(requests), /Different task/);
});

test('aborting during registration never dispatches a model and retains the original abort reason', async () => {
  const { config, requests } = fixture('');
  const controller = new AbortController();
  const reason = new Error('application cancelled');
  let calls = 0;
  const query = withClaudeAgentLearning(() => { calls++; return (async function* () { yield result; })(); }, config);
  const running = query({ prompt: 'Original task', options: { abortController: controller } });
  controller.abort(reason);
  await assert.rejects(running.next(), error => error === reason);
  await query.flushLearning();
  assert.equal(calls, 0);
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'cancelled');
});
