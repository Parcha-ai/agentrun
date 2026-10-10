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
  await llm.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 99, signal: new AbortController().signal, onText: () => {}, sampling: { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, penalty_repeat: 1.1, max_tokens: 180 } });
  const o = sent[0];
  assert.equal(o.repeat_penalty, 1.1, 'the name the server reads');
  assert.equal(o.repeat_last_n, 64, 'the window llama.cpp uses by default (what an evaluation outside the tab measures)');
  assert.deepEqual([o.temperature, o.top_k, o.top_p, o.min_p], [0.7, 40, 0.95, 0.05]);
  assert.equal(o.max_tokens, 99, 'the host\'s budget for this call, not the sampling object');
  assert.ok(!('max_tokens' in {}) && o.stream === true);
});
