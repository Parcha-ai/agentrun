// The local model: wllama (llama.cpp in WebAssembly, CPU only: the take Chrome has no WebGPU) running the GGUF in its own workers, so the
// page's main thread stays free. The model sees only user and assistant turns (the GGUF's own chat template, no system message, no
// tools); the sampling comes from sampling.ts (the defaults, with the manifest's valid overrides), so an evaluation outside the tab can use exactly the same settings.

import { Wllama } from '@wllama/wllama/esm/index.js'; // the package's built output and its .d.ts (its root entry is TypeScript source)
import type { Llm } from './modelhost.ts';
import { DEFAULT_SAMPLING } from './sampling.ts';
import { LimitTracker } from './limits.ts';
import { loadWithAdapters, type LoraSelection } from './adapters.ts';
import { Sha256 } from './sha256-stream.ts';
export const N_CTX = 2048;
export const REPEAT_LAST_N = 64;

/**
 * How `wllamaLlm` makes its engine, with options: `compat` serves wllama's Safari build (no JSPI or memory64: every iPhone browser) from this site instead of
 * its CDN, so the page loads it with no network; `logger` receives the engine's own lines (llama.cpp's included).
 */
export function wllamaWith(o: { compat?: { worker: string; wasm: string }; logger?: { debug(...a: unknown[]): void; log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void } }): (config: { default: string }) => Wllama {
  return (config) => {
    const w = new Wllama(config, { ...(o.logger ? { logger: o.logger as never, suppressNativeLog: false } : {}) });
    if (o.compat) w.setCompat(o.compat);
    return w;
  };
}

/** The URLs of a split GGUF's parts, from its first (`-00001-of-0000N.gguf`); a file that is not split is its own only part. */
function shardUrls(first: string): string[] {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/.exec(first);
  if (!m) return [first];
  return Array.from({ length: Number(m[2]) }, (_, i) => first.replace(/-\d{5}-of-(\d{5})\.gguf$/, `-${String(i + 1).padStart(5, '0')}-of-$1.gguf`));
}

const VERIFIED = 'wllama-verified:';
/** The engine's reads of model parts so far: how many, and the largest it asked for at once (a check that a build reads in pieces). */
export const partReads = { count: 0, largest: 0 };
/** Where the last load's time went before the engine: fetching parts (and how many bytes), checking them. */
export const partTimes = { downloadMs: 0, downloaded: 0, verifyMs: 0 };
/** A part this size or smaller is hashed with WebCrypto in one piece (native, fast); a larger one (the 208 MB token embedding) in slices, so it is never held whole. */
const WHOLE_HASH = 64 * 1024 * 1024;
const PIECE = 8 * 1024 * 1024;

/** A part from the cache, checked: its size against the manifest every time, its sha256 once (read through in pieces, so a part that cannot be read fails here, by name). */
async function verifiedPart(w: Wllama, url: string, want: { bytes: number; sha256?: string } | undefined, o: { onStatus(text: string): void; onProgress(loaded: number): void }): Promise<Blob> {
  const cm = w.cacheManager;
  const key = await cm.getNameFromURL(url);
  const name = url.split('/').pop()!;
  const mark = `${VERIFIED}${key}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let blob = (await cm.getSize(key)) > 0 ? await cm.open(key) : null;
    if (blob && want && blob.size !== want.bytes) {
      o.onStatus(`${name}: ${blob.size} bytes in the cache, ${want.bytes} expected: fetching it again`);
      await cm.delete(key);
      blob = null;
    }
    if (!blob) {
      const started = performance.now();
      for (let tries = 1; ; tries++) {
        try {
          await cm.download(url, { progressCallback: ({ loaded }: { loaded: number }) => o.onProgress(loaded) });
          break;
        } catch (e) {
          // a phone's network drops a long download now and then (Safari: "Load failed"): twice more, then the error, by name
          if (tries >= 3) throw new Error(`${name}: the download failed ${tries} times (${e instanceof Error ? e.message : String(e)})`);
          o.onStatus(`${name}: the download failed (${e instanceof Error ? e.message : String(e)}): trying again`);
          await new Promise((r) => setTimeout(r, 1000 * tries * tries));
        }
      }
      blob = await cm.open(key);
      if (!blob) throw new Error(`${name}: not in the cache after its download`);
      partTimes.downloadMs += performance.now() - started;
      partTimes.downloaded += blob.size;
      // the fresh copy is held to the manifest too (a manifest may give bytes without a sha256): a short one is fetched once more, then fails by name
      if (want && blob.size !== want.bytes) {
        o.onStatus(`${name}: downloaded ${blob.size} bytes, ${want.bytes} expected`);
        await cm.delete(key);
        continue;
      }
    }
    o.onProgress(blob.size);
    const stamp = `${want?.sha256 ?? ''}:${blob.size}:${(blob as File).lastModified ?? 0}`;
    let seen: string | null = null;
    try { seen = localStorage.getItem(mark); } catch { /* no storage: check every time */ }
    if (!want?.sha256 || seen === stamp) return blob;
    let problem: string | undefined;
    const checking = performance.now();
    try {
      o.onStatus(`checking ${name}`);
      let got: string;
      if (blob.size <= WHOLE_HASH && globalThis.crypto?.subtle) {
        got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.slice(0, blob.size).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
      } else {
        const h = new Sha256();
        for (let at = 0; at < blob.size; at += PIECE) h.update(new Uint8Array(await blob.slice(at, Math.min(blob.size, at + PIECE)).arrayBuffer()));
        got = h.hex();
      }
      if (got !== want.sha256) problem = `sha256 ${got.slice(0, 12)}, ${want.sha256.slice(0, 12)} expected`;
    } catch (e) {
      problem = `unreadable (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`;
    }
    partTimes.verifyMs += performance.now() - checking;
    if (!problem) {
      try { localStorage.setItem(mark, stamp); } catch { /* no storage */ }
      return blob;
    }
    o.onStatus(`${name}: ${problem}: fetching it again`);
    await cm.delete(key);
  }
  throw new Error(`${name}: still wrong or unreadable after fetching it again`);
}

/**
 * A part as wllama reads it: in pieces of at most 8 MB (a model's token embedding is one 208 MB tensor, and WebKit failed such a read with NotReadableError);
 * a piece that fails is read again from a fresh handle on the cached file, and an error names the file and the bytes. Never from the network: bytes that were not
 * checked against the manifest would go into the model (the next load checks the part whole and fetches it again).
 */
class SlicedBlob extends Blob {
  readonly name: string;
  private inner: Blob;
  private readonly reopen: () => Promise<Blob | null>;
  private readonly unreadable: () => void;
  /** `unreadable`: told when a piece cannot be read even from a fresh handle (the part's check is forgotten, so the next load checks it and fetches it again). */
  constructor(inner: Blob, name: string, reopen: () => Promise<Blob | null>, unreadable: () => void = () => undefined) {
    super([]);
    this.inner = inner;
    this.name = name;
    this.reopen = reopen;
    this.unreadable = unreadable;
  }
  override get size(): number { return this.inner.size; }
  override slice(start = 0, end = this.size): Blob {
    const s = Math.max(0, start), e = Math.min(end, this.size);
    partReads.count++;
    partReads.largest = Math.max(partReads.largest, e - s);
    return { size: e - s, arrayBuffer: () => this.read(s, e) } as unknown as Blob;
  }
  private async read(s: number, e: number): Promise<ArrayBuffer> {
    if (e - s <= PIECE) return this.piece(s, e);
    const out = new Uint8Array(e - s);
    for (let at = s; at < e; at += PIECE) out.set(new Uint8Array(await this.piece(at, Math.min(e, at + PIECE))), at - s);
    return out.buffer;
  }
  private async piece(a: number, b: number): Promise<ArrayBuffer> {
    try {
      return await this.inner.slice(a, b).arrayBuffer();
    } catch (first) {
      try {
        const fresh = await this.reopen();
        if (fresh) { this.inner = fresh; return await fresh.slice(a, b).arrayBuffer(); }
      } catch { /* the cached file cannot be read again either */ }
      this.unreadable();
      throw new Error(`reading ${this.name} bytes ${a}-${b} failed: ${first instanceof Error ? `${first.name}: ${first.message}` : String(first)}`);
    }
  }
}

export function wllamaLlm(wasmUrl: string, make: (config: { default: string }) => Wllama = (c) => new Wllama(c)): Llm {
  let w: Wllama | null = null;
  let lora: LoraSelection | undefined; // with adapters loaded: the selection every request carries (llama.cpp's server applies the load-time scale, 0, to a request without one)
  const release = async () => { const old = w; w = null; lora = undefined; try { await old?.exit(); } catch { /* it may already be gone */ } };
  return {
    async load(parts, { threads, adapters, active, jinja, nCtx }) {
      await release(); // a second load replaces the model: the old one's workers and memory are freed first
      const next = make({ default: wasmUrl });
      w = next;
      try {
        const params = { n_ctx: nCtx ?? N_CTX, n_threads: threads, n_gpu_layers: 0, prefill_assistant: true, swa_full: true, ...(jinja ? { jinja: true } : {}) }; // jinja: the model's own chat template, which renders the tools of a native tool turn
        if (adapters?.length) lora = (await loadWithAdapters(next, [new Blob(parts as BlobPart[])], adapters, params)).select(active ?? {}); // a base and its adapters: every one at 0, the active ones on, per request
        else await next.loadModel([new Blob(parts as BlobPart[])], params); // a trailing assistant message is continued, not answered; swa_full: Gemma 3's sliding-window cache would otherwise re-evaluate the previous assistant turn at every step of a tool loop (D0 measured 79 s -> 27.5 s for a 4-step task, +33 MB of KV); the prompt cache itself stays on (never cache_prompt: false)
      } catch (e) {
        await release(); // a half-started model is released, not left running
        throw e;
      }
    },
    async loadUrl(url, { threads, nCtx, batch, slots, parts, onProgress, onStatus, loadTimeoutMs }) {
      await release();
      const next = make({ default: wasmUrl });
      w = next;
      try {
        // The parts of a split GGUF (-00001-of-0000N) through wllama's cache (OPFS): fetched once, then found there with no network. Each part is checked against
        // the manifest before it is used (its size every time; a read-through sha256 once, remembered), and one that is short, wrong or unreadable (a download a
        // crash cut short; WebKit's NotReadableError) is deleted and fetched again. batch: a hybrid model (Qwen3.5) resumes from a checkpoint before the prompt's
        // last batch, so a small batch keeps what each turn reads again small (D0 measured, batch 64: about 60 tokens per command instead of the whole prompt).
        const urls = shardUrls(url);
        Object.assign(partTimes, { downloadMs: 0, downloaded: 0, verifyMs: 0 });
        const total = parts?.reduce((n, p) => n + p.bytes, 0) ?? 0;
        const blobs: Blob[] = [];
        let base = 0;
        for (const [i, u] of urls.entries()) {
          const blob = await verifiedPart(next, u, parts?.[i], { onStatus: onStatus ?? (() => undefined), onProgress: (loaded) => onProgress?.(base + loaded, total) });
          base += blob.size;
          const key = await next.cacheManager.getNameFromURL(u);
          blobs.push(new SlicedBlob(blob, u.split('/').pop()!, async () => next.cacheManager.open(key), () => { try { localStorage.removeItem(`${VERIFIED}${key}`); } catch { /* no storage: it is checked every load */ } }));
        }
        onProgress?.(base, total || base);
        // the engine's load, apart from the download: a build that stalls in it (Safari 27 took wllama's memory64 build, which never finished loading) fails here, by
        // name, and its worker is let go (below), so the caller can try another build instead of waiting for ever
        const loading = next.loadModel(blobs, { n_ctx: nCtx ?? N_CTX, n_threads: threads, n_gpu_layers: 0, swa_full: true, ...(batch ? { n_batch: batch, n_ubatch: batch } : {}), ...(slots ? { n_parallel: slots } : {}) });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await (loadTimeoutMs ? Promise.race([loading, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the engine did not load the model in ${Math.round(loadTimeoutMs / 1000)} s`)), loadTimeoutMs); })]) : loading);
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        await release();
        throw e;
      }
    },
    async clearCache() {
      await make({ default: wasmUrl }).cacheManager.clear();
      try { for (const k of Object.keys(localStorage)) if (k.startsWith(VERIFIED)) localStorage.removeItem(k); } catch { /* no storage */ }
    },
    chatTemplate() { return w?.getChatTemplate() ?? null; },
    async restoreState(state) {
      if (!w) throw new Error('the model is not loaded');
      // D0's slot shim (a wllama build whose rerank message also carries llama-server's slot actions): the state file is registered like a model shard, so the
      // engine reads it through wllama's own file access, and llama-server's slot restore puts its tokens and cache in slot 0. A stock build refuses the message.
      const proxy = (w as unknown as { proxy: { fileAlloc(name: string, size: number, alloc: boolean): Promise<number>; fileBlobs: Map<string, Blob>; wllamaAction<T>(name: string, body: Record<string, unknown>): Promise<T> } }).proxy;
      const name = 'state.bin';
      await proxy.fileAlloc(name, state.size, false);
      proxy.fileBlobs.set(name, state);
      try {
        const started = await proxy.wllamaAction<{ success: boolean; req_id: number }>('rerank', { _name: 'rrnk_req', data_json: JSON.stringify({ slot_action: 'restore', filepath: `/models/${name}` }) });
        if (!started.success) throw new Error('the engine did not start the restore');
        for (;;) {
          const chunk = await proxy.wllamaAction<{ data_json: string; has_more: boolean; is_error: boolean }>('get_result', { _name: 'gres_req', req_id: started.req_id });
          if (chunk.data_json) {
            const data = JSON.parse(chunk.data_json) as { n_restored?: number; message?: string };
            if (chunk.is_error || data.n_restored === undefined) throw new Error(data.message ?? 'the restore failed');
            return { tokens: data.n_restored, bytes: state.size };
          }
          if (!chunk.has_more) throw new Error('the restore returned nothing (a wllama build without the slot shim)');
        }
      } finally {
        proxy.fileBlobs.delete(name); // restored or not, the page lets go of its copy (36 MB a phone needs back)
      }
    },
    async chat({ messages, maxTokens, signal, onText, sampling, stop, prefill }) {
      if (!w) throw new Error('the model is not loaded');
      const { max_tokens: _answer, think_tokens: _think, penalty_repeat, ...rest } = sampling ?? DEFAULT_SAMPLING; // the call's own budget is `maxTokens`
      // The repeat penalty goes under the names llama.cpp's server reads (repeat_penalty, repeat_last_n): wllama's own `penalty_repeat` is not applied
      // (measured: greedy decoding with penalty 2.0 gave the same text as 1.0). The window is llama.cpp's default, so an evaluation outside the tab agrees.
      const sent = prefill === undefined ? messages : [...messages, { role: 'assistant' as const, content: prefill }]; // a pre-filled assistant turn: the model continues it
      const request = { messages: sent, max_tokens: maxTokens, ...(stop?.length ? { stop } : {}), ...rest, repeat_penalty: penalty_repeat, repeat_last_n: REPEAT_LAST_N, ...(lora ? { lora } : {}), stream: true, abortSignal: signal };
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
    async chatTools(req, { signal, sampling }) {
      if (!w) throw new Error('the model is not loaded');
      const { max_tokens: _answer, think_tokens: _think, penalty_repeat, ...rest } = sampling ?? DEFAULT_SAMPLING;
      const started = performance.now();
      // The tools go to the model's own template; llama.cpp builds the call grammar from them (an enum in a schema is a lock on that argument) and parses the reply into tool_calls.
      const r = await w.createChatCompletion({
        messages: req.messages as never, tools: req.tools as never, tool_choice: req.toolChoice ?? 'auto', max_tokens: req.maxTokens, ...rest, repeat_penalty: penalty_repeat, repeat_last_n: REPEAT_LAST_N,
        ...(req.templateKwargs ? { chat_template_kwargs: req.templateKwargs } : {}), ...(lora ? { lora } : {}), stream: false, abortSignal: signal,
      } as Parameters<Wllama['createChatCompletion']>[0] & { stream?: false });
      const choice = (r as { choices: { message: { content?: string | null; reasoning_content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }).choices[0]!;
      const calls = (choice.message.tool_calls ?? []).map((c, i) => ({ id: c.id || `call-${i}`, name: c.function.name, arguments: c.function.arguments }));
      // MiniCPM5's locked reply can land in reasoning_content with content empty (D0/D1 measured): the words are the answer then.
      const text = choice.message.content || choice.message.reasoning_content || '';
      return { text, toolCalls: calls, stoppedBy: calls.length > 0 ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : 'stop', promptTokens: (r as { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens ?? 0, outputTokens: (r as { usage?: { completion_tokens?: number } }).usage?.completion_tokens ?? 0, ms: performance.now() - started };
    },
    async complete(req, { signal, sampling }) {
      if (!w) throw new Error('the model is not loaded');
      const { max_tokens: _answer, think_tokens: _think, penalty_repeat, ...rest } = sampling ?? DEFAULT_SAMPLING;
      // A stop string is handled here, not by the engine: the engine does not say whether it stopped on a word or on the end of the turn, and the caller needs to know which. The stream is
      // read, and when a stop string appears the request is aborted and the text cut before it.
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true });
      const request = { prompt: req.prompt, max_tokens: req.maxTokens, ...rest, repeat_penalty: penalty_repeat, repeat_last_n: REPEAT_LAST_N, ...(req.grammar ? { grammar: req.grammar } : {}), ...(req.grammar && req.lazy ? { grammar_lazy: true, grammar_triggers: [{ type: 1, value: req.lazy.trigger }] } : {}), ...(req.extra ?? {}), ...(lora ? { lora } : {}), stream: true, abortSignal: ctl.signal };
      let text = '', chunks = 0, finish: string | null = null, promptTokens = 0, predicted = 0, stoppedAt = -1, timings: Record<string, number> | undefined;
      const began = performance.now();
      const limits = new LimitTracker(req.limits);
      let capped = -1;
      try {
        const stream = await w.createCompletion(request as unknown as Parameters<Wllama['createCompletion']>[0] & { stream: true });
        for await (const chunk of stream as AsyncIterable<{ choices?: { text?: string; finish_reason?: string | null }[]; timings?: { prompt_n?: number; predicted_n?: number } }>) {
          const c = chunk.choices?.[0];
          if (c?.text) { text += c.text; chunks++; }
          if (c?.finish_reason) finish = c.finish_reason;
          if (chunk.timings) { promptTokens = chunk.timings.prompt_n ?? promptTokens; predicted = chunk.timings.predicted_n ?? predicted; timings = chunk.timings as unknown as Record<string, number>; }
          for (const stop of req.stop ?? []) { const at = text.indexOf(stop); if (at >= 0 && (stoppedAt < 0 || at < stoppedAt)) stoppedAt = at; }
          if (stoppedAt >= 0) { ctl.abort(); break; }
          capped = limits.push(text, chunks);
          if (capped >= 0) { ctl.abort(); break; }
        }
      } catch (e) {
        if (!ctl.signal.aborted) throw e;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      const outputTokens = predicted || chunks;
      const ms = Math.round(performance.now() - began);
      if (capped >= 0) return { text, stoppedBy: 'length' as const, capped, promptTokens, outputTokens, ms, ...(timings ? { timings } : {}) };
      if (stoppedAt >= 0) return { text: text.slice(0, stoppedAt), stoppedBy: 'stop' as const, promptTokens, outputTokens, ms, ...(timings ? { timings } : {}) };
      return { text, stoppedBy: finish === 'length' ? ('length' as const) : ('eog' as const), promptTokens, outputTokens, ms, ...(timings ? { timings } : {}) };
    },
    async exit() { await release(); },
  };
}
