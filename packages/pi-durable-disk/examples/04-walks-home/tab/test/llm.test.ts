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
