// Episode 2: the trained model comes home and talks. The manifest on the run's disk starts it (fetch the chunks, check them, load the
// model, a judged self-check answer, then the switch); after that the shell's `chat-send` is answered by the local model, every answer
// gated by the dark-content judge before a word of it is sent anywhere. Pure and injected (the model, the disk, the judge, the clock), so
// the order of events and the gating are tested in node. Messages are in README.md ("Episode 2").

import { fetchModel, ModelError, parseManifest, type Manifest } from './model.ts';
import { Guard, REFUSAL, sentenceEnd } from './guard.ts';
import { rawOf, readable, splitThinking } from './thinking.ts';
import { resolveSampling, type Sampling } from './sampling.ts';

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

export interface Llm {
  load(parts: Uint8Array[], opts: { threads: number }): Promise<void>;
  /** Generate an answer; onText gets the whole text so far. An abort ends it early without throwing. */
  chat(o: { messages: ChatMsg[]; maxTokens: number; signal: AbortSignal; sampling?: Sampling; onText: (cumulative: string) => void }): Promise<{ text: string; tokens: number }>;
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
  now(): number;
  /** True for the disk's "another machine holds the run" refusal (the run is away: not a failure). */
  isNotHolder(e: unknown): boolean;
  sleep(ms: number): Promise<void>;
}

/** Tokens per second of generation: the gaps between the first and the last token, so the judge's waits are not in it. Null when it cannot be measured. */
export function tokensPerSecond(tokens: number, firstMs: number, lastMs: number): number | null {
  return tokens > 1 && lastMs > firstMs ? (tokens - 1) / ((lastMs - firstMs) / 1000) : null;
}

export type ModelPhase = 'none' | 'loading' | 'loaded' | 'answered' | 'failed';
export const LOADED_PATH = 'creature/model-loaded.json';
/** How long a refused write is retried (the run is on its way home): the safety net under the placement signal. */
export const HOLDER_RETRY_MS = 90_000;
const SELF_CHECK = 'Who are you?';
/** The self-check has room for a thought and then an answer; it stops at the end of the first answer sentence. */
const SELF_CHECK_TOKENS = 256;
const HISTORY_MAX = 8;

export class ModelHost {
  private readonly d: HostDeps;
  private phase: ModelPhase = 'none';
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

  /** Generate one answer for `messages`, gated. Returns what the user may see. */
  private async answer(prompt: string, messages: ChatMsg[], maxTokens: number, show: (shown: string, final?: boolean) => void, stopAfterFirstSentence = false): Promise<{ refused: boolean; text: string; tokens: number; tokens_per_s: number | null; thought: boolean }> {
    const ctl = new AbortController();
    // the guard works on the model's raw text (thinking tags and all); the judge reads it as a reader would, thinking first and no tags
    const guard = new Guard({ mode: this.d.mode ?? 'progressive', judge: (a, final) => this.d.judge(prompt, readable(a, final)), emit: show, abort: () => ctl.abort() });
    let thought = false;
    let first = 0, last = 0;
    try {
      const out = await this.d.llm.chat({ messages, maxTokens, signal: ctl.signal, sampling: this.sampling, onText: (t) => { const n = this.d.now(); if (!first) first = n; last = n; const sp = splitThinking(t); if (sp.thinking !== null) thought = true; guard.push(t);
        if (stopAfterFirstSentence && sentenceEnd(sp.answer) > 0) ctl.abort(); // one real sentence of answer is enough: stop generating
      } });
      const r = await guard.finish(out.text);
      const tokens_per_s = tokensPerSecond(out.tokens, first, last);
      this.info.tokens_per_s = tokens_per_s; // the last answer's rate; null when it could not be measured (never the one before)
      return { ...r, tokens: out.tokens, tokens_per_s, thought };
    } catch (e) {
      guard.stop(); // a judgement may still be out: its verdict must not reach this finished answer, or the next one
      ctl.abort();
      throw e;
    }
  }

  /** The manifest appeared (or changed). One model per page: ignored while loading or once loaded; tried again after a failure. */
  async onManifest(text: string): Promise<void> {
    if (this.phase === 'loading' || this.phase === 'loaded' || this.phase === 'answered') return;
    this.phase = 'loading';
    this.info.error = null;
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
    const downloadMs = this.d.now() - t0;
    const t1 = this.d.now();
    try { await this.d.llm.load(parts, { threads: this.d.threads }); } catch (e) { return this.fail(`the model would not load: ${e instanceof Error ? e.message : String(e)}`); }
    this.info.load_ms = this.d.now() - t1;
    this.phase = 'loaded';
    this.d.post('model-loaded', { load_ms: this.info.load_ms, download_ms: downloadMs, bytes: m.size, threads: this.d.threads, sha256: m.sha256 });
    try { await this.receipt({ answered: false }); } catch (e) { return this.fail(`could not write ${LOADED_PATH}: ${e instanceof Error ? e.message : String(e)}`); }
    // the self-check: the model answers one question through the same judge, so "it loaded and answered" is shown by a measured answer, not assumed
    const t2 = this.d.now();
    let r;
    try { r = await this.answer(SELF_CHECK, [{ role: 'user', content: SELF_CHECK }], SELF_CHECK_TOKENS, () => {}, true); } catch (e) { return this.fail(`the self-check failed: ${e instanceof Error ? e.message : String(e)}`); }
    const ms = this.d.now() - t2;
    this.d.post('model-answer', { n: 0, prompt_chars: SELF_CHECK.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed', self_check: true, ...(r.tokens_per_s !== null ? { tokens_per_s: r.tokens_per_s } : {}) });
    // ready means a real, judged ANSWER: a thought that ran out of tokens before any answer is not one
    if (r.refused) return this.fail('the self-check answer was refused by the judge');
    const sc = splitThinking(r.text, true);
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
      let msgs: ChatMsg[] = [...this.history, { role: 'user', content: text }];
      if (msgs.length > HISTORY_MAX) msgs = msgs.slice(-HISTORY_MAX);
      while (msgs[0].role !== 'user') msgs.shift();
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
      done({ text: final.answer, refused: r.refused, tokens: r.tokens, ms, ...thinking, ...rate });
      this.d.post('model-answer', { n, prompt_chars: text.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed', ...rate });
      if (r.refused) this.d.post('model-refused', { n, reason: 'judge' });
      else if (final.answer) {
        this.history.push({ role: 'user', content: text }, { role: 'assistant', content: rawOf(final) }); // the model's own format; an unfinished turn (no answer) is not kept
        if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX);
      }
    } catch (e) {
      done({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }
}

export { REFUSAL };
