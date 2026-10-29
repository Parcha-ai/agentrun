// A process that hosts the Codex adapter on the pinned binary (the version-1 configuration: built-ins off, the host's
// tools only, the session's proxy) and stops at one point of a turn; the orphan test kills it with SIGKILL there.
//   request: Codex has asked the model, which holds its answer;
//   tool:    the model asked for a host tool, which is running and does not return;
//   idle:    the turn ended, and the session waits for the next.
// Prints "ready" once it is at that point.
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { codexAdapter } from '@parcha/agentrun-codex';

const [dir, mode] = process.argv.slice(2);
const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const answer = (n, items) => new Response(sse(n, items), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const ready = () => process.stdout.write('ready\n');

let requests = 0;
const fetch = async (_url, init) => {
  requests += 1;
  if (mode === 'request') {
    ready();
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }
  if (mode === 'tool' && requests === 1) return answer(1, [{ type: 'function_call', name: 'hold', arguments: '{}', call_id: 'call_hold' }]);
  return answer(requests, [{ type: 'message', role: 'assistant', id: `msg_${requests}`, content: [{ type: 'output_text', text: 'done' }] }]);
};
const hold = { name: 'hold', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { ready(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
const codex = codexAdapter({ model: 'gpt-5.4-mini', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: dir, fetch });
const spec = { key: 'step:orphan', label: 'orphan', system: [], tools: mode === 'tool' ? [hold] : [], context: 'fresh' };
const store = memorySessionStore();
const session = await codex.open(spec, { writer: await store.open(spec.key), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: () => {} });
await session.send('hello');
if (mode === 'idle') {
  await session.turnEnd();
  ready();
}
setInterval(() => {}, 1 << 30);
