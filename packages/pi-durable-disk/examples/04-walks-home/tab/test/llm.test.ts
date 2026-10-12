import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wllamaLlm } from '../src/llm.ts';

function fakeWllama(log: string[], opts: { failLoad?: boolean } = {}) {
  let n = 0;
  return () => {
    const id = ++n;
    return {
      loadModel: async () => { log.push(`load ${id}`); if (opts.failLoad) throw new Error('bad gguf'); },
      exit: async () => { log.push(`exit ${id}`); },
      createChatCompletion: async () => (async function* () {})(),
    } as never;
  };
}

test('loading again releases the old model first, so its workers and memory do not leak', async () => {
  const log: string[] = [];
  const llm = wllamaLlm('/w.wasm', fakeWllama(log));
  await llm.load([new Uint8Array(1)], { threads: 2 });
  await llm.load([new Uint8Array(1)], { threads: 2 });
  assert.deepEqual(log, ['load 1', 'exit 1', 'load 2']);
});

test('a load that fails is cleaned up (the half-started model is released) before the error goes on', async () => {
  const log: string[] = [];
  const llm = wllamaLlm('/w.wasm', fakeWllama(log, { failLoad: true }));
  await assert.rejects(llm.load([new Uint8Array(1)], { threads: 2 }), /bad gguf/);
  assert.deepEqual(log, ['load 1', 'exit 1']);
  await assert.rejects(llm.chat({ messages: [], maxTokens: 1, signal: new AbortController().signal, onText: () => {} }), /not loaded/);
});

test('the sampling goes to llama.cpp under the names its server reads: repeat_penalty and repeat_last_n (wllama\'s own penalty_repeat is not applied), with top_k, top_p, min_p and temperature', async () => {
  const sent: any[] = [];
  const make = () => ({ loadModel: async () => {}, exit: async () => {}, createChatCompletion: async (o: any) => { sent.push(o); return (async function* () {})(); } }) as never;
  const llm = wllamaLlm('/w.wasm', make);
  await llm.load([new Uint8Array(1)], { threads: 2 });
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 99, signal: new AbortController().signal, onText: () => {}, sampling: { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, penalty_repeat: 1.1, max_tokens: 180, think_tokens: 90 } });
  const o = sent[0];
  assert.equal(o.repeat_penalty, 1.1, 'the name the server reads');
  assert.equal(o.repeat_last_n, 64, 'the window llama.cpp uses by default (what an evaluation outside the tab measures)');
  assert.deepEqual([o.temperature, o.top_k, o.top_p, o.min_p], [0.7, 40, 0.95, 0.05]);
  assert.equal(o.max_tokens, 99, 'the host\'s budget for this call, not the sampling object');
  assert.ok(!('max_tokens' in {}) && o.stream === true);
});

test('a pre-filled assistant turn is a continuation: the model echoes the prefill, the tab strips it, and counts only the new tokens; stop strings go to the server', async () => {
  const sent: any[] = [];
  const make = () => ({ loadModel: async () => {}, exit: async () => {}, createChatCompletion: async (o: any) => { sent.push(o); return (async function* () { for (const d of ['<thin', 'king>Hm.</thinking>\n\n', 'The ', 'answer.']) yield { choices: [{ delta: { content: d } }] }; })(); } }) as never;
  const llm = wllamaLlm('/w.wasm', make);
  await llm.load([new Uint8Array(1)], { threads: 2 });
  const seen: [string, number][] = [];
  const out = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, signal: new AbortController().signal, prefill: '<thinking>Hm.</thinking>\n\n', stop: ['<thinking>', '</thinking>'], onText: (t: string, n: number) => seen.push([t, n]) });
  assert.deepEqual(sent[0].messages.at(-1), { role: 'assistant', content: '<thinking>Hm.</thinking>\n\n' });
  assert.deepEqual(sent[0].stop, ['<thinking>', '</thinking>']);
  assert.equal(out.text, 'The answer.');
  assert.equal(out.tokens, 2, 'only the continuation counts');
  assert.ok(seen.every(([t]) => !t.includes('thinking')), JSON.stringify(seen));
  // a build that does not echo the prefill passes through untouched
  const make2 = () => ({ loadModel: async () => {}, exit: async () => {}, createChatCompletion: async () => (async function* () { for (const d of ['Plain ', 'text.']) yield { choices: [{ delta: { content: d } }] }; })() }) as never;
  const llm2 = wllamaLlm('/w.wasm', make2);
  await llm2.load([new Uint8Array(1)], { threads: 2 });
  const out2 = await llm2.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, signal: new AbortController().signal, prefill: 'XYZ', onText: () => {} });
  assert.equal(out2.text, 'Plain text.');
});

test('the model is loaded with assistant prefill on, so a trailing assistant message is continued', async () => {
  const loads: any[] = [];
  const make = () => ({ loadModel: async (_b: unknown, p: any) => { loads.push(p); }, exit: async () => {}, createChatCompletion: async () => (async function* () {})() }) as never;
  await wllamaLlm('/w.wasm', make).load([new Uint8Array(1)], { threads: 3 });
  assert.equal(loads[0].prefill_assistant, true);
  assert.equal(loads[0].n_threads, 3);
});

test('a base with adapters: each adapter goes in beside the base at scale 0, and every request, chat and raw, carries the active selection; a plain load after carries none', async () => {
  const sent: any[] = [];
  let params: any, files: string[] = [];
  const make = () => ({
    proxy: null as unknown,
    async loadModel(blobs: Blob[], p: any) {
      params = p;
      (this as any).proxy = { async moduleInit(f: { name: string }[]) { files = f.map((x) => x.name); } };
      await new Promise((r) => setImmediate(r));
      await (this as any).proxy.moduleInit(blobs.map((b, i) => ({ name: `model-0000${i + 1}-of-00001.gguf`, blob: b })));
    },
    exit: async () => {},
    createChatCompletion: async (o: any) => { sent.push(o); return (async function* () {})(); },
    createCompletion: async (o: any) => { sent.push(o); return (async function* () {})(); },
  }) as never;
  const llm = wllamaLlm('/w.wasm', make);
  const adapters = [{ name: 'tools.gguf', blob: new Blob([new Uint8Array(2)]) }, { name: 'moon.gguf', blob: new Blob([new Uint8Array(3)]) }];
  await llm.load([new Blob([new Uint8Array(4)])], { threads: 2, adapters, active: { 'moon.gguf': 1 } });
  assert.deepEqual(params.lora_adapters, [{ path: 'models/tools.gguf', scale: 0 }, { path: 'models/moon.gguf', scale: 0 }]);
  assert.deepEqual(files, ['model-00001-of-00001.gguf', 'tools.gguf', 'moon.gguf']);
  assert.equal(params.swa_full, true);
  const signal = new AbortController().signal;
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5, signal, onText: () => {} });
  await llm.complete!({ prompt: 'p', maxTokens: 5 }, { signal });
  const on = [{ id: 0, scale: 0 }, { id: 1, scale: 1 }];
  assert.deepEqual(sent.map((o) => o.lora), [on, on]);
  await llm.load([new Uint8Array(1)], { threads: 2 });
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5, signal, onText: () => {} });
  assert.equal(sent.at(-1).lora, undefined);
});

test('chatTools hands the tools to the model\'s own template and reads the reply: tool calls, the words, and the words from reasoning_content when content is empty', async () => {
  const sent: any[] = [];
  const replies: any[] = [
    { choices: [{ message: { content: '', tool_calls: [{ id: 'a', function: { name: 'morph', arguments: '{"preset":"spider"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 5 } },
    { choices: [{ message: { content: '', reasoning_content: 'Done.' }, finish_reason: 'stop' }], usage: {} },
    { choices: [{ message: { content: 'Hello.', reasoning_content: 'ignored' }, finish_reason: 'stop' }], usage: {} },
  ];
  const make = () => ({ loadModel: async () => {}, exit: async () => {}, createChatCompletion: async (o: any) => { sent.push(o); return replies.shift(); } }) as never;
  const llm = wllamaLlm('/w.wasm', make);
  await llm.load([new Uint8Array(1)], { threads: 2 });
  const ask = () => llm.chatTools!({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'morph', description: 'd', parameters: { type: 'object', properties: {} } } }], maxTokens: 50, templateKwargs: { enable_thinking: false } }, { signal: new AbortController().signal });
  const a = await ask();
  assert.deepEqual(a.toolCalls, [{ id: 'a', name: 'morph', arguments: '{"preset":"spider"}' }]);
  assert.equal(a.stoppedBy, 'tool_calls');
  assert.deepEqual([a.promptTokens, a.outputTokens], [12, 5]);
  assert.equal(sent[0].stream, false);
  assert.deepEqual(sent[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(sent[0].tools[0].function.name, 'morph');
  assert.equal((await ask()).text, 'Done.', 'the locked reply that landed in reasoning_content');
  assert.equal((await ask()).text, 'Hello.', 'content wins when there is some');
});
