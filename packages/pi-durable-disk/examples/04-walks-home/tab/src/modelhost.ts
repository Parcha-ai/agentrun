// Episode 2: the trained model comes home and talks. The manifest on the run's disk starts it (fetch the chunks, check them, load the
// model, a judged self-check answer, then the switch); after that the shell's `chat-send` is answered by the local model, every answer
// gated by the dark-content judge before a word of it is sent anywhere. Pure and injected (the model, the disk, the judge, the clock), so
// the order of events and the gating are tested in node. Messages are in README.md ("Episode 2").

import { fetchModel, ModelError, parseManifest, type Manifest } from './model.ts';
import { isBaseAdapters } from './adapter-manifest.ts';
import { comeHome, describeHome, memoryFileStore, type FileStore } from './homecoming.ts';
import type { AdapterFile } from './adapters.ts';
import { Guard, REFUSAL, sentenceEnd } from './guard.ts';
import { CLOSE, cutBack, OPEN, rawOf, readable, splitThinking } from './thinking.ts';
import { resolveSampling, type Sampling } from './sampling.ts';
import type { HistoryMode } from './history.ts';
import type { Limit } from './limits.ts';
export type { HistoryMode } from './history.ts';

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

/** One raw completion over a finished prompt (no chat template, no messages): the tool-using turns are decoded this way (03 tab, decode.ts's Backend has the same shape). */
export interface RawRequest {
  prompt: string;
  maxTokens: number;
  stop?: string[];
  grammar?: string;
  /** With `grammar`: the grammar engages only once `trigger` has been generated (llama.cpp's grammar_lazy with a word trigger); the grammar's root must start with the trigger. */
  lazy?: { trigger: string };
  /** Token limits on the stream (limits.ts): a generation that runs one out is stopped, stoppedBy "length", `capped` its index. */
  limits?: readonly Limit[];
  /** Extra request fields for the engine, passed through. */
  extra?: Record<string, unknown>;
}
export interface RawResult {
  /** The generated text; a `stop` string that ended it is not in it. */
  text: string;
  /** "eog": the model ended its turn; "stop": a stop string; "length": maxTokens. */
  stoppedBy: 'eog' | 'stop' | 'length';
  /** Prompt tokens evaluated for this call (not served from the cache) and tokens generated. */
  promptTokens: number;
  outputTokens: number;
  /** The index of the `limits` entry that stopped the generation. */
  capped?: number;
  /** The engine's own timings for the call, when it reports them (wllama: prompt_n, prompt_ms, predicted_n, predicted_ms, ...). */
  timings?: Record<string, number>;
  /** Wall time of the call in ms, including the wait for its first token. */
  ms?: number;
}

/** OpenAI-shaped chat for the native tool template (wllama's createChatCompletion with tools). */
export type ToolChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface ToolChatTool { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }
export interface ToolChatRequest { messages: ToolChatMessage[]; tools: ToolChatTool[]; toolChoice?: 'auto' | 'required' | 'none'; maxTokens: number; templateKwargs?: Record<string, unknown> }
export interface ToolChatResult { text: string; toolCalls: { id: string; name: string; arguments: string }[]; stoppedBy: 'stop' | 'length' | 'tool_calls'; promptTokens: number; outputTokens: number; ms: number }

export interface Llm {
  /** Load a model: its bytes, or a base with adapters (all loaded at scale 0; `active` turns some on at a scale for every request, adapters.ts). */
  load(parts: (Uint8Array | Blob)[], opts: { threads: number; adapters?: AdapterFile[]; active?: Record<string, number>; /** The model's own chat template (jinja), needed for `chatTools`. */ jinja?: boolean; /** The context in tokens (default 2048). */ nCtx?: number }): Promise<void>;
  /** Generate an answer; onText gets the whole text so far and the tokens so far. `stop` strings end the text before them; `prefill` is an assistant turn to continue (the returned text is only what comes after it). An abort ends it early without throwing. */
  chat(o: { messages: ChatMsg[]; maxTokens: number; signal: AbortSignal; sampling?: Sampling; stop?: string[]; prefill?: string; onText: (cumulative: string, tokens: number) => void }): Promise<{ text: string; tokens: number }>;
  /** Optional: one chat turn with the model's NATIVE tool template (OpenAI-shaped messages and tools in, its own tool_calls out; needs `jinja` at load). An abort ends it early and returns what was generated. */
  chatTools?(req: ToolChatRequest, o: { signal: AbortSignal; sampling?: Sampling }): Promise<ToolChatResult>;
  /** Optional: one raw completion (see RawRequest). An abort ends it early and returns what was generated. */
  complete?(req: RawRequest, o: { signal: AbortSignal; sampling?: Sampling }): Promise<RawResult>;
  exit(): Promise<void>;
}

export interface HostDeps {
  post(type: string, body?: Record<string, unknown>): void;
  readChunk(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** The dark-content judge. Anything but 'show' (an error, a timeout) is a refusal. */
  judge(prompt: string, answer: string): Promise<'show' | 'refuse'>;
  llm: Llm;
  threads: number;
  mode?: 'progressive' | 'whole';
  /** What the model is shown of the conversation so far. 'none': nothing, every question is answered fresh (how the model was trained). 'last': the previous exchange, with its ANSWER only. Prior thinking is never shown to the model in either. */
  history?: HistoryMode;
  now(): number;
  /** True for the disk's "another machine holds the run" refusal (the run is away: not a failure). */
  isNotHolder(e: unknown): boolean;
  sleep(ms: number): Promise<void>;
  /** Whole model files kept by sha256 for a base-and-adapters homecoming (homecoming.ts; OPFS in the browser). Default: in memory, so nothing is kept. */
  files?: FileStore;
  /** Load the model with its own jinja chat template and this context (the native tool template needs both; the tools of a task are rendered into the prompt). */
  native?: { nCtx: number };
}

/** Tokens per second of generation: the gaps between the first and the last token, so the judge's waits are not in it. Null when it cannot be measured. */
export function tokensPerSecond(tokens: number, firstMs: number, lastMs: number): number | null {
  return tokens > 1 && lastMs > firstMs ? (tokens - 1) / ((lastMs - firstMs) / 1000) : null;
}

/** Where an answer's time went, in ms from the start of its generation. `thinking_end_ms` only when the model thought out loud and the thought ended. */
export interface AnswerTiming { first_token_ms: number; thinking_end_ms?: number; answer_start_ms?: number; hit_cap: boolean; thinking_only: boolean; thinking_cut: boolean }

/** What one gated generation came to: `text` is the raw reply as shown (thinking tags included) or, when the judge held it, nothing the reader may see. */
export interface Answered { refused: boolean; text: string; tokens: number; tokens_per_s: number | null; thought: boolean; cut: boolean; timing: AnswerTiming; /** The caller aborted it: nothing after that point was judged or shown. */ aborted?: boolean }

export type ModelPhase = 'none' | 'loading' | 'loaded' | 'answered' | 'failed';
export const LOADED_PATH = 'creature/model-loaded.json';
/** How long a refused write is retried (the run is on its way home): the safety net under the placement signal. */
export const HOLDER_RETRY_MS = 90_000;
const SELF_CHECK = 'Who are you?';
/** The self-check has room for a thought and then an answer; it stops at the end of the first answer sentence. */
const SELF_CHECK_TOKENS = 256;
/** How often a self-check that ended with no answer (all thinking) is asked again before the load counts as failed. */
const SELF_CHECK_TRIES = 3;

export class ModelHost {
  private readonly d: HostDeps;
  private phase: ModelPhase = 'none';
  private disposed = false;
  private info: { sha256: string | null; name: string | null; quant: string | null; topic: string | null; mechanism: string | null; load_ms: number | null; first_answer_ms: number | null; answers: number; error: string | null; size_bytes: number | null; tokens_per_s: number | null } =
    { sha256: null, name: null, quant: null, topic: null, mechanism: null, load_ms: null, first_answer_ms: null, answers: 0, error: null, size_bytes: null, tokens_per_s: null };
  private history: ChatMsg[] = [];
  private busy = false;
  private sampling: Sampling = resolveSampling(undefined);
  private holder = true; // the tab starts as the holder; the stage's placement says otherwise while the run is away
  private holderWaiters: (() => void)[] = [];

  constructor(d: HostDeps) {
    this.d = d;
  }

  state() {
    return { phase: this.phase, ...this.info, sampling: this.sampling, history: this.history.length };
  }

  /** The stage's `set-placement`: the tab holds the run only when it is placed in the tab. */
  onPlacement(kind: string): void {
    this.holder = kind === 'tab';
    if (this.holder) { const w = this.holderWaiters; this.holderWaiters = []; for (const r of w) r(); }
  }

  private async untilHolder(): Promise<void> {
    while (!this.holder) await new Promise<void>((r) => this.holderWaiters.push(r));
  }

  /**
   * Write the receipt once the tab holds the run. The model loads early (a prefetch while the run is still away), but the receipt, the
   * self-check and the switch are the tab's first writes to the run's disk, which the server refuses with 409 while another machine holds
   * it. So: wait for the placement to say the run is home, and if the disk still refuses, retry with backoff for HOLDER_RETRY_MS. A refusal
   * while the run is away is never a failure.
   */
  private async receipt(extra: Record<string, unknown>): Promise<void> {
    let waited = this.d.now(), delay = 1000;
    for (;;) {
      const before = this.holder;
      await this.untilHolder();
      if (!before) waited = this.d.now(); // time spent waiting for the run does not count against the retries
      try { return await this.writeLoaded(extra); } catch (e) {
        if (!this.d.isNotHolder(e)) throw e;
        if (this.d.now() - waited >= HOLDER_RETRY_MS) throw new Error('another machine holds the run');
        await this.d.sleep(delay);
        delay = Math.min(delay * 2, 8000);
      }
    }
  }

  private async writeLoaded(extra: Record<string, unknown>): Promise<void> {
    const body = { sha256: this.info.sha256, name: this.info.name, quant: this.info.quant, ...(this.info.topic ? { topic: this.info.topic } : {}), ...(this.info.mechanism ? { mechanism: this.info.mechanism } : {}), sampling: this.sampling, load_ms: this.info.load_ms, ...extra };
    await this.d.writeFile(LOADED_PATH, new TextEncoder().encode(JSON.stringify(body)));
  }

  private async fail(reason: string): Promise<void> {
    this.phase = 'failed';
    this.info.error = reason;
    this.d.post('model-failed', { reason });
    try { await this.receipt({ answered: false, error: reason }); } catch { /* the disk is the one thing that may be gone; while the run is away this waits for it to come home */ }
  }

  /**
   * Generate one answer for `messages`, gated, in up to two requests. A model that thinks out loud is asked for its thought first (stop at </thinking>,
   * its own budget `think_tokens`); the thought is closed as generated and the answer is a continuation of it (stop at any thinking tag, its own budget
   * `answerBudget`): thinking can never eat the answer's budget, and a stray tag ends the answer instead of appearing in it. A reply that does not open a
   * thought is one request bounded by the answer budget. The guard sees the raw text throughout; the judge reads it as a reader would.
   */
  private async answer(prompt: string, messages: ChatMsg[], answerBudget: number, show: (shown: string, final?: boolean) => void, stopAfterFirstSentence = false, external?: AbortSignal): Promise<Answered> {
    const ctl = new AbortController();
    const guard = new Guard({ mode: this.d.mode ?? 'progressive', judge: (a, final) => this.d.judge(prompt, readable(a, final)), emit: show, abort: () => ctl.abort() });
    // A cancelled request is over for good: the model stops, and a verdict still owed by the judge neither shows nor stops anything.
    const onExternal = () => { ctl.abort(); guard.stop(); };
    if (external?.aborted) onExternal(); else external?.addEventListener('abort', onExternal, { once: true });
    const thinkBudget = this.sampling.think_tokens;
    let thought = false, thinkingCut = false, capped = false, first = 0, last = 0, thinkEnd = 0, answerStart = 0;
    const t0 = this.d.now();
    const mark = (raw: string) => {
      const n = this.d.now();
      if (!first) first = n;
      last = n;
      const sp = splitThinking(raw);
      if (sp.thinking !== null) thought = true;
      if (!answerStart && sp.answer.trim() !== '') answerStart = n;
      guard.push(raw);
      if (stopAfterFirstSentence && sentenceEnd(sp.answer) > 0) ctl.abort(); // one real sentence of answer is enough: stop generating
    };
    try {
      // One generation: the thought and, when it closes inside its budget, the answer that follows it. Continuing the same generation costs
      // nothing; a second request would re-read the prompt and the whole thought (llama.cpp could not reuse its cache past the first turn:
      // measured 5 to 8 s of dead air at the CPU's prompt rate). Budgets and stray tags are enforced on the stream: ending the request
      // early has the effect of a stop string.
      const p1 = new AbortController();
      let t1 = '', nClose = -1, endedByTag = false;
      const out1 = await this.d.llm.chat({
        messages, maxTokens: thinkBudget + answerBudget, sampling: this.sampling, signal: AbortSignal.any([ctl.signal, p1.signal]),
        onText: (t, n) => {
          const s = t.trimStart();
          const opens = s.startsWith(OPEN);
          let end = t.length; // where this reply ends: at the first stray tag (a second opening, or a closing with no thought, or a second closing)
          if (opens) {
            const close = s.indexOf(CLOSE);
            const off = t.length - s.length;
            const nested = t.indexOf(OPEN, off + OPEN.length); // a second opening before the first closing: the model lost its place
            if (nested >= 0 && (close < 0 || nested < off + close)) { end = nested; endedByTag = true; }
            else if (close >= 0) {
              if (nClose < 0) { nClose = n; thinkEnd = this.d.now(); }
              const after = t.length - s.length + close + CLOSE.length;
              const stray = [OPEN, CLOSE].map((tag) => t.indexOf(tag, after)).filter((i) => i >= 0);
              if (stray.length) { end = Math.min(...stray); endedByTag = true; }
            } else if (n >= thinkBudget) { thinkingCut = true; } // the thought is over its budget: it is closed as generated, below, and the answer is a second request
          } else if (!OPEN.startsWith(s)) {
            const stray = [OPEN, CLOSE].map((tag) => t.indexOf(tag)).filter((i) => i >= 0);
            if (stray.length) { end = Math.min(...stray); endedByTag = true; }
          }
          t1 = t.slice(0, end);
          mark(t1);
          if (endedByTag || thinkingCut) p1.abort();
          else if (opens ? nClose >= 0 && n - nClose >= answerBudget : !OPEN.startsWith(s) && n >= answerBudget) { capped = true; p1.abort(); } // the answer is over its budget
        },
      });
      let raw = t1, tokens = out1.tokens, hitCap = capped;
      if (t1.trimStart().startsWith(OPEN) && !t1.includes(CLOSE) && !ctl.signal.aborted && !endedByTag) {
        // the thought did not close (it ran to its budget, or the model stopped inside it): phase 2 continues the closed thought as its own request
        const prefill = t1.trimEnd() + CLOSE + '\n\n'; // the training separator
        thinkEnd = this.d.now();
        raw = prefill;
        const out2 = await this.d.llm.chat({
          messages, prefill, maxTokens: answerBudget, stop: [OPEN, CLOSE], sampling: this.sampling, signal: ctl.signal,
          onText: (t) => { raw = prefill + t; mark(raw); },
        });
        raw = prefill + out2.text;
        tokens += out2.tokens;
        hitCap = out2.tokens >= answerBudget;
      }
      // a reply that reached its budget is cut back to the last sentence or line end, before it is judged and shown, and is flagged as cut
      if (hitCap) {
        const s = splitThinking(raw, true);
        raw = rawOf({ thinking: s.thinking, answer: cutBack(s.answer) });
      }
      const cancelled = (): Answered => ({ refused: false, text: '', tokens, tokens_per_s: null, thought, cut: false, aborted: true, timing: { first_token_ms: Math.max(0, first - t0), hit_cap: false, thinking_only: false, thinking_cut: thinkingCut } });
      if (external?.aborted) { guard.stop(); return cancelled(); }
      const r = await guard.finish(raw);
      if (external?.aborted) return cancelled(); // cancelled while the judge was still out: nothing was shown, and nothing is returned as an answer
      const tokens_per_s = tokensPerSecond(tokens, first, last);
      this.info.tokens_per_s = tokens_per_s; // the last answer's rate; null when it could not be measured (never the one before)
      const rel = (n: number) => Math.max(0, n - t0);
      const timing: AnswerTiming = {
        first_token_ms: rel(first),
        ...(thinkEnd ? { thinking_end_ms: rel(thinkEnd) } : {}),
        ...(answerStart ? { answer_start_ms: rel(answerStart) } : {}),
        hit_cap: hitCap, thinking_only: thought && !answerStart, thinking_cut: thinkingCut,
      };
      return { ...r, tokens, tokens_per_s, thought, cut: hitCap, timing };
    } catch (e) {
      guard.stop(); // a judgement may still be out: its verdict must not reach this finished answer, or the next one
      ctl.abort();
      throw e;
    } finally {
      external?.removeEventListener('abort', onExternal);
    }
  }

  /**
   * One tool-using turn, decoded raw: `use` gets a backend over the model's raw completion (decode.ts's decodeTurn takes it), under the host's busy flag for the whole turn and the host's sampling.
   * No judge, no history: the caller (the tab-local provider) built the prompt and owns the loop. Throws 'model-not-ready' before the first answer and 'busy' while something else generates.
   */
  async withBackend<T>(use: (backend: { complete(req: RawRequest): Promise<RawResult> }) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.phase !== 'answered') throw new Error('model-not-ready');
    if (this.busy) throw new Error('busy');
    if (!this.d.llm.complete) throw new Error('this model backend has no raw completion');
    this.busy = true;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal?.aborted) ctl.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await use({ complete: (req) => this.d.llm.complete!(req, { signal: ctl.signal, sampling: this.sampling }) });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.busy = false;
    }
  }

  /**
   * One chat turn with the model's native tool template: the messages and the tools of the task go in as OpenAI-shaped data, the model's own template renders them, its tool_calls come back. No judge, no
   * history (the caller owns the conversation). Throws 'model-not-ready' before the first answer, 'busy' while something else generates, and when the backend has no native tool chat.
   */
  async toolChat(req: ToolChatRequest, signal?: AbortSignal): Promise<ToolChatResult> {
    if (this.phase !== 'answered') throw new Error('model-not-ready');
    if (this.busy) throw new Error('busy');
    if (!this.d.llm.chatTools) throw new Error('this model backend has no native tool chat');
    this.busy = true;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal?.aborted) ctl.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.d.llm.chatTools(req, { signal: ctl.signal, sampling: this.sampling });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.busy = false;
    }
  }

  /**
   * The page is done with this model (the run left this tab, or the connection was lost): a load that has not finished stops, and the model's workers are released. Nothing
   * answers after it; a page that comes back builds a new host (one copy of the model at a time, not one per return).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.d.llm.exit().catch(() => undefined);
    if (this.phase !== 'failed') { this.phase = 'failed'; this.info.error = 'the model was released'; }
  }

  /** The history policy this host was built with. */
  historyMode(): HistoryMode { return this.d.history ?? 'last'; }

  /**
   * One gated answer for a conversation somebody else keeps (the pi provider's way in): the same decoding, budgets, stray-tag handling and judge as `chat()`,
   * without this host's own history. `messages` is exactly what the model is shown; `prompt` is the question the judge reads the answer against. `show` gets the
   * raw text so far, and only ever text the judge has passed. Resolves with the reply; a refusal carries no text.
   */
  async generate(prompt: string, messages: ChatMsg[], show: (shownRaw: string, final?: boolean) => void, signal?: AbortSignal): Promise<Answered> {
    if (this.phase !== 'answered') throw new Error('model-not-ready');
    if (this.busy) throw new Error('busy');
    this.busy = true;
    try {
      const r = await this.answer(prompt, messages, this.sampling.max_tokens, show, false, signal);
      this.info.answers++;
      return r;
    } finally {
      this.busy = false;
    }
  }

  /**
   * A new model came home while this host holds one (another adapter over the same base, or a new merged model): load it in place of the old one. `llm.load` frees the old model first, so from here
   * until the new one has answered its self-check this host answers nothing (`model-not-ready`); the caller asks nothing of it meanwhile. Refused while a model is loading or an answer is in
   * progress. A failure leaves the host failed, as a first load's does.
   */
  async rehome(text: string): Promise<void> {
    if (this.disposed) return;
    if (this.phase === 'loading' || this.phase === 'loaded') throw new Error('a model is loading');
    if (this.busy) throw new Error('busy');
    this.phase = 'none';
    return this.onManifest(text);
  }

  /** The manifest appeared (or changed). One model per page: ignored while loading or once loaded; tried again after a failure. */
  async onManifest(text: string): Promise<void> {
    if (this.phase === 'loading' || this.phase === 'loaded' || this.phase === 'answered') return;
    this.phase = 'loading';
    this.info.error = null;
    if (isBaseAdapters(text)) return this.onHomecoming(text);
    let m: Manifest;
    try { m = parseManifest(text); } catch (e) { return this.fail(e instanceof ModelError ? e.message : String(e)); }
    this.info.sha256 = m.sha256; this.info.name = m.name; this.info.quant = m.quant;
    this.info.topic = m.topic ?? null; this.info.mechanism = m.mechanism ?? null; this.info.size_bytes = m.size;
    this.sampling = resolveSampling(m.sampling);
    this.d.post('model-loading', { name: m.name, bytes: m.size, quant: m.quant, ...(m.topic ? { topic: m.topic } : {}), ...(m.mechanism ? { mechanism: m.mechanism } : {}), sampling: this.sampling });
    const t0 = this.d.now();
    let parts: Uint8Array[];
    try {
      let lastPost = -1e9;
      parts = await fetchModel(m, {
        readChunk: this.d.readChunk, sha256: this.d.sha256,
        onProgress: (done, total) => { const t = this.d.now(); if (done === total || t - lastPost >= 1000) { lastPost = t; this.d.post('model-download', { done_chunks: done, total_chunks: total }); } },
      });
    } catch (e) { return this.fail(e instanceof Error ? e.message : String(e)); }
    if (this.disposed) return;
    return this.loadAndCheck(parts, {}, this.d.now() - t0);
  }

  /**
   * A base and its adapters (adapter-manifest.ts): only the files the FileStore does not hold are fetched (a homecoming over a cached base
   * fetches the adapter alone), then the base loads with every adapter beside it and the active ones on. The rest is a merged model's way.
   */
  private async onHomecoming(text: string): Promise<void> {
    const t0 = this.d.now();
    let h;
    try {
      const desc = await describeHome(text, this.d.sha256);
      this.d.post('model-loading', { name: desc.name, bytes: desc.bytes, quant: desc.quant, ...(desc.topic ? { topic: desc.topic } : {}), sampling: this.sampling });
      let lastPost = -1e9;
      h = await comeHome(text, {
        readChunk: this.d.readChunk, sha256: this.d.sha256, store: this.d.files ?? memoryFileStore(), now: this.d.now,
        onProgress: ({ file, done, total }) => { const t = this.d.now(); if (done === total || t - lastPost >= 1000) { lastPost = t; this.d.post('model-download', { file, done_chunks: done, total_chunks: total }); } },
      });
    } catch (e) { return this.fail(e instanceof Error ? e.message : String(e)); }
    if (this.disposed) return;
    this.info.sha256 = h.id; this.info.name = h.name; this.info.quant = h.quant; this.info.topic = h.topic ?? null; this.info.mechanism = null; this.info.size_bytes = h.bytes;
    this.sampling = resolveSampling(h.sampling);
    this.d.post('model-homecoming', { plan: h.fetched.plan, fetched_bytes: h.fetched.bytes, fetch_ms: h.fetched.ms, active: h.active, adapters: h.adapters.map((a) => a.name), name: h.name, bytes: h.bytes });
    return this.loadAndCheck([h.base], { adapters: h.adapters, active: h.active }, this.d.now() - t0);
  }

  /** Load what was fetched, write the receipt, and ask the self-check: the model is ready only after a real, judged answer. */
  private async loadAndCheck(parts: (Uint8Array | Blob)[], extra: { adapters?: AdapterFile[]; active?: Record<string, number> }, downloadMs: number): Promise<void> {
    const t1 = this.d.now();
    try { await this.d.llm.load(parts, { threads: this.d.threads, ...extra, ...(this.d.native ? { jinja: true, nCtx: this.d.native.nCtx } : {}) }); } catch (e) { return this.fail(`the model would not load: ${e instanceof Error ? e.message : String(e)}`); }
    if (this.disposed) { await this.d.llm.exit().catch(() => undefined); return; }
    this.info.load_ms = this.d.now() - t1;
    this.phase = 'loaded';
    this.d.post('model-loaded', { load_ms: this.info.load_ms, download_ms: downloadMs, bytes: this.info.size_bytes, threads: this.d.threads, sha256: this.info.sha256 });
    try { await this.receipt({ answered: false }); } catch (e) { return this.fail(`could not write ${LOADED_PATH}: ${e instanceof Error ? e.message : String(e)}`); }
    // the self-check: the model answers one question through the same judge, so "it loaded and answered" is shown by a measured answer, not assumed
    // A 1B model sampled at a temperature now and then spends its whole budget thinking and gives no answer: that is asked again (up to SELF_CHECK_TRIES times, without
    // loading the model again). A refusal by the judge is never asked again, and a failure of the model itself ends it.
    let r, ms = 0, sc = splitThinking('', true);
    for (let attempt = 1; ; attempt++) {
      const t2 = this.d.now();
      try { r = await this.answer(SELF_CHECK, [{ role: 'user', content: SELF_CHECK }], SELF_CHECK_TOKENS, () => {}, true); } catch (e) { return this.fail(`the self-check failed: ${e instanceof Error ? e.message : String(e)}`); }
      ms = this.d.now() - t2;
      sc = splitThinking(r.text, true);
      if (r.refused || sc.answer.trim() !== '' || attempt >= SELF_CHECK_TRIES) break;
    }
    this.d.post('model-answer', { n: 0, prompt_chars: SELF_CHECK.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed', self_check: true, timing: r.timing, ...(r.tokens_per_s !== null ? { tokens_per_s: r.tokens_per_s } : {}) });
    // ready means a real, judged ANSWER: a thought that ran out of tokens before any answer is not one
    if (r.refused) return this.fail('the self-check answer was refused by the judge');
    if (sc.answer.trim() === '') return this.fail(sc.thinking !== null ? 'the self-check ended inside its thinking: the model gave no answer' : 'the self-check produced no answer');
    this.info.first_answer_ms = ms;
    this.phase = 'answered';
    try { await this.receipt({ answered: true, first_answer_ms: ms, tokens: r.tokens, judged: 'passed', at: new Date().toISOString() }); } catch (e) { return this.fail(`could not write ${LOADED_PATH}: ${e instanceof Error ? e.message : String(e)}`); }
    this.d.post('model-switched', { from: 'base', to: 'trained' });
  }

  /** The shell's `chat-send`: answer with the local model, streaming only judged text. */
  async chat(id: string, text: string): Promise<void> {
    const done = (extra: Record<string, unknown>) => this.d.post('chat-done', { id, refused: false, text: '', ...extra });
    if (this.phase !== 'answered') return done({ error: 'model-not-ready' });
    if (this.busy) return done({ error: 'busy' });
    this.busy = true;
    const n = ++this.info.answers;
    const t0 = this.d.now();
    try {
      this.d.post('chat-start', { id });
      const msgs: ChatMsg[] = [...this.history, { role: 'user', content: text }];
      // An accepted turn clears the saved exchange; it is saved again only if this turn gives a usable answer. A held, empty or failed turn leaves the next question fresh,
      // never carrying an older exchange (history.ts: the same rule for a conversation pi keeps).
      this.history = [];
      // what has reached the screen so far: the thinking and the answer are two streams, each only sent when it has grown (and only ever judged text)
      let sentThinking = '', sentAnswer = '';
      const r = await this.answer(text, msgs, this.sampling.max_tokens, (shownRaw, final) => {
        const s = splitThinking(shownRaw, final);
        if (s.thinking !== null && s.thinking !== '' && s.thinking !== sentThinking) { sentThinking = s.thinking; this.d.post('chat-thinking', { id, text: s.thinking }); }
        if (s.answer !== '' && s.answer !== sentAnswer) { sentAnswer = s.answer; this.d.post('chat-delta', { id, text: s.answer }); }
      });
      const ms = this.d.now() - t0;
      const final = r.refused ? { thinking: null, answer: REFUSAL } : splitThinking(r.text, true);
      const rate = r.tokens_per_s !== null ? { tokens_per_s: r.tokens_per_s } : {};
      // `thinking` is there only when the model thought out loud; on a refusal it is empty, so the stage clears what it showed
      const thinking = r.refused ? (r.thought ? { thinking: '' } : {}) : final.thinking !== null ? { thinking: final.thinking } : {};
      done({ text: final.answer, refused: r.refused, tokens: r.tokens, ms, ...thinking, ...(r.cut && !r.refused ? { cut: true } : {}), ...rate });
      this.d.post('model-answer', { n, prompt_chars: text.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed', timing: r.timing, ...rate });
      if (r.refused) this.d.post('model-refused', { n, reason: 'judge' });
      else if (final.answer) {
        // what the next question may carry: the answer only (the model was trained on single questions with their own thinking, and its thinking about an earlier question made it talk about that question); an unfinished turn (no answer) is not kept
        this.history = (this.d.history ?? 'last') === 'none' ? [] : [{ role: 'user', content: text }, { role: 'assistant', content: final.answer }];
      }
    } catch (e) {
      done({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }
}

export { REFUSAL };
