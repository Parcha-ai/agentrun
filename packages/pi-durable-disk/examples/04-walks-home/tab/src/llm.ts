// The local model: wllama (llama.cpp in WebAssembly, CPU only: the take Chrome has no WebGPU) running the GGUF in its own workers, so the
// page's main thread stays free. The model sees only user and assistant turns (the GGUF's own chat template, no system message, no
// tools); the sampling comes from sampling.ts (the defaults, with the manifest's valid overrides), so an evaluation outside the tab can use exactly the same settings.

import { Wllama } from '@wllama/wllama/esm/index.js'; // the package's built output and its .d.ts (its root entry is TypeScript source)
import type { Llm } from './modelhost.ts';
import { DEFAULT_SAMPLING } from './sampling.ts';
export const N_CTX = 2048;
export const REPEAT_LAST_N = 64;

export function wllamaLlm(wasmUrl: string, make: (config: { default: string }) => Wllama = (c) => new Wllama(c)): Llm {
  let w: Wllama | null = null;
  const release = async () => { const old = w; w = null; try { await old?.exit(); } catch { /* it may already be gone */ } };
  return {
    async load(parts, { threads }) {
      await release(); // a second load replaces the model: the old one's workers and memory are freed first
      const next = make({ default: wasmUrl });
      w = next;
      try {
        await next.loadModel([new Blob(parts as BlobPart[])], { n_ctx: N_CTX, n_threads: threads, n_gpu_layers: 0, prefill_assistant: true }); // a trailing assistant message is continued, not answered
      } catch (e) {
        await release(); // a half-started model is released, not left running
        throw e;
      }
    },
    async chat({ messages, maxTokens, signal, onText, sampling, stop, prefill }) {
      if (!w) throw new Error('the model is not loaded');
      const { max_tokens: _answer, think_tokens: _think, penalty_repeat, ...rest } = sampling ?? DEFAULT_SAMPLING; // the call's own budget is `maxTokens`
      // The repeat penalty goes under the names llama.cpp's server reads (repeat_penalty, repeat_last_n): wllama's own `penalty_repeat` is not applied
      // (measured: greedy decoding with penalty 2.0 gave the same text as 1.0). The window is llama.cpp's default, so an evaluation outside the tab agrees.
      const sent = prefill === undefined ? messages : [...messages, { role: 'assistant' as const, content: prefill }]; // a pre-filled assistant turn: the model continues it
      const request = { messages: sent, max_tokens: maxTokens, ...(stop?.length ? { stop } : {}), ...rest, repeat_penalty: penalty_repeat, repeat_last_n: REPEAT_LAST_N, stream: true, abortSignal: signal };
      const stream = await w.createChatCompletion(request as Parameters<Wllama['createChatCompletion']>[0] & { stream: true });
      // llama.cpp streams the prefill back at the start of a continuation: it is not new text, so it is stripped (a build that does not echo it passes through)
      const echoed = (t: string) => prefill !== undefined && prefill.length > 0 && prefill.startsWith(t);
      const fresh = (t: string) => (prefill && t.startsWith(prefill) ? t.slice(prefill.length) : echoed(t) ? '' : t);
      let text = '', tokens = 0, raw = '';
      try {
        for await (const chunk of stream) {
          const d = chunk.choices?.[0]?.delta?.content;
          if (!d) continue;
          raw += d;
          const now = fresh(raw);
          if (now.length > text.length) { tokens++; text = now; onText(text, tokens); }
        }
      } catch (e) {
        if (!signal.aborted) throw e; // an abort ends the answer early; anything else is a real failure
      }
      return { text, tokens };
    },
    async exit() { await release(); },
  };
}
