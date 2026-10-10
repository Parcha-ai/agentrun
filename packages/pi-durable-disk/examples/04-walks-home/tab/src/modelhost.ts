// Episode 2: the trained model comes home and talks. The manifest on the run's disk starts it (fetch the chunks, check them, load the
// model, a judged self-check answer, then the switch); after that the shell's `chat-send` is answered by the local model, every answer
// gated by the dark-content judge before a word of it is sent anywhere. Pure and injected (the model, the disk, the judge, the clock), so
// the order of events and the gating are tested in node. Messages are in README.md ("Episode 2").

import { fetchModel, ModelError, parseManifest, type Manifest } from './model.ts';
import { Guard, REFUSAL, sentenceEnd } from './guard.ts';
import { CLOSE, cutBack, OPEN, rawOf, readable, splitThinking } from './thinking.ts';
import { resolveSampling, type Sampling } from './sampling.ts';

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

export interface Llm {
  load(parts: Uint8Array[], opts: { threads: number }): Promise<void>;
  /** Generate an answer; onText gets the whole text so far and the tokens so far. `stop` strings end the text before them; `prefill` is an assistant turn to continue (the returned text is only what comes after it). An abort ends it early without throwing. */
  chat(o: { messages: ChatMsg[]; maxTokens: number; signal: AbortSignal; sampling?: Sampling; stop?: string[]; prefill?: string; onText: (cumulative: string, tokens: number) => void }): Promise<{ text: string; tokens: number }>;
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

/** Where an answer's time went, in ms from the start of its generation. `thinking_end_ms` only when the model thought out loud and the thought ended. */
export interface AnswerTiming { first_token_ms: number; thinking_end_ms?: number; answer_start_ms?: number; hit_cap: boolean; thinking_only: boolean; thinking_cut: boolean }

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

  /**
   * Generate one answer for `messages`, gated, in up to two requests. A model that thinks out loud is asked for its thought first (stop at </thinking>,
   * its own budget `think_tokens`); the thought is closed as generated and the answer is a continuation of it (stop at any thinking tag, its own budget
   * `answerBudget`): thinking can never eat the answer's budget, and a stray tag ends the answer instead of appearing in it. A reply that does not open a
   * thought is one request bounded by the answer budget. The guard sees the raw text throughout; the judge reads it as a reader would.
   */
  private async answer(prompt: string, messages: ChatMsg[], answerBudget: number, show: (shown: string, final?: boolean) => void, stopAfterFirstSentence = false): Promise<{ refused: boolean; text: string; tokens: number; tokens_per_s: number | null; thought: boolean; cut: boolean; timing: AnswerTiming }> {
    const ctl = new AbortController();
    const guard = new Guard({ mode: this.d.mode ?? 'progressive', judge: (a, final) => this.d.judge(prompt, readable(a, final)), emit: show, abort: () => ctl.abort() });
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
      const r = await guard.finish(raw);
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
    this.d.post('model-answer', { n: 0, prompt_chars: SELF_CHECK.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed', self_check: true, timing: r.timing, ...(r.tokens_per_s !== null ? { tokens_per_s: r.tokens_per_s } : {}) });
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
      done({ text: final.answer, refused: r.refused, tokens: r.tokens, ms, ...thinking, ...(r.cut && !r.refused ? { cut: true } : {}), ...rate });
      this.d.post('model-answer', { n, prompt_chars: text.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed', timing: r.timing, ...rate });
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
