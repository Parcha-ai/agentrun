// The local model: wllama (llama.cpp in WebAssembly, CPU only: the take Chrome has no WebGPU) running the GGUF in its own workers, so the
// page's main thread stays free. The model sees only user and assistant turns (the GGUF's own chat template, no system message, no
// tools); the sampling is fixed here so an evaluation outside the tab can use exactly the same settings.

import { Wllama } from '@wllama/wllama/esm/index.js'; // the package's built output and its .d.ts (its root entry is TypeScript source)
import type { Llm } from './modelhost.ts';

export const SAMPLING = { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, penalty_repeat: 1.0 } as const;
export const N_CTX = 2048;

export function wllamaLlm(wasmUrl: string, make: (config: { default: string }) => Wllama = (c) => new Wllama(c)): Llm {
  let w: Wllama | null = null;
  const release = async () => { const old = w; w = null; try { await old?.exit(); } catch { /* it may already be gone */ } };
  return {
    async load(parts, { threads }) {
      await release(); // a second load replaces the model: the old one's workers and memory are freed first
      const next = make({ default: wasmUrl });
      w = next;
      try {
        await next.loadModel([new Blob(parts as BlobPart[])], { n_ctx: N_CTX, n_threads: threads, n_gpu_layers: 0 });
      } catch (e) {
        await release(); // a half-started model is released, not left running
        throw e;
      }
    },
    async chat({ messages, maxTokens, signal, onText }) {
      if (!w) throw new Error('the model is not loaded');
      const stream = await w.createChatCompletion({ messages, max_tokens: maxTokens, ...SAMPLING, stream: true, abortSignal: signal });
      let text = '', tokens = 0;
      try {
        for await (const chunk of stream) {
          const d = chunk.choices?.[0]?.delta?.content;
          if (d) { text += d; tokens++; onText(text); }
        }
      } catch (e) {
        if (!signal.aborted) throw e; // an abort ends the answer early; anything else is a real failure
      }
      return { text, tokens };
    },
    async exit() { await release(); },
  };
}
