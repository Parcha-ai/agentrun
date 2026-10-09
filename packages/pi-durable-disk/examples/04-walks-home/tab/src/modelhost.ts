// Episode 2: the trained model comes home and talks. The manifest on the run's disk starts it (fetch the chunks, check them, load the
// model, a judged self-check answer, then the switch); after that the shell's `chat-send` is answered by the local model, every answer
// gated by the dark-content judge before a word of it is sent anywhere. Pure and injected (the model, the disk, the judge, the clock), so
// the order of events and the gating are tested in node. Messages are in README.md ("Episode 2").

import { fetchModel, ModelError, parseManifest, type Manifest } from './model.ts';
import { Guard, REFUSAL } from './guard.ts';

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

export interface Llm {
  load(parts: Uint8Array[], opts: { threads: number }): Promise<void>;
  /** Generate an answer; onText gets the whole text so far. An abort ends it early without throwing. */
  chat(o: { messages: ChatMsg[]; maxTokens: number; signal: AbortSignal; onText: (cumulative: string) => void }): Promise<{ text: string; tokens: number }>;
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
}

export type ModelPhase = 'none' | 'loading' | 'loaded' | 'answered' | 'failed';
export const LOADED_PATH = 'creature/model-loaded.json';
const SELF_CHECK = 'Who are you?';
const HISTORY_MAX = 8;

export class ModelHost {
  private readonly d: HostDeps;
  private phase: ModelPhase = 'none';
  private info: { sha256: string | null; name: string | null; quant: string | null; load_ms: number | null; first_answer_ms: number | null; answers: number; error: string | null } =
    { sha256: null, name: null, quant: null, load_ms: null, first_answer_ms: null, answers: 0, error: null };
  private history: ChatMsg[] = [];
  private busy = false;

  constructor(d: HostDeps) {
    this.d = d;
  }

  state() {
    return { phase: this.phase, ...this.info, history: this.history.length };
  }

  private async writeLoaded(extra: Record<string, unknown>): Promise<void> {
    const body = { sha256: this.info.sha256, name: this.info.name, quant: this.info.quant, load_ms: this.info.load_ms, ...extra };
    await this.d.writeFile(LOADED_PATH, new TextEncoder().encode(JSON.stringify(body)));
  }

  private async fail(reason: string): Promise<void> {
    this.phase = 'failed';
    this.info.error = reason;
    this.d.post('model-failed', { reason });
    try { await this.writeLoaded({ answered: false, error: reason }); } catch { /* the disk is the one thing that may be gone */ }
  }

  /** Generate one answer for `messages`, gated. Returns what the user may see. */
  private async answer(prompt: string, messages: ChatMsg[], maxTokens: number, show: (shown: string) => void): Promise<{ refused: boolean; text: string; tokens: number }> {
    const ctl = new AbortController();
    const guard = new Guard({ mode: this.d.mode ?? 'progressive', judge: (a) => this.d.judge(prompt, a), emit: show, abort: () => ctl.abort() });
    try {
      const out = await this.d.llm.chat({ messages, maxTokens, signal: ctl.signal, onText: (t) => guard.push(t) });
      const r = await guard.finish(out.text);
      return { ...r, tokens: out.tokens };
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
    this.d.post('model-loading', { name: m.name, bytes: m.size, quant: m.quant });
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
    try { await this.writeLoaded({ answered: false }); } catch (e) { return this.fail(`could not write ${LOADED_PATH}: ${e instanceof Error ? e.message : String(e)}`); }
    // the self-check: the model answers one question through the same judge, so "it loaded and answered" is shown by a measured answer, not assumed
    const t2 = this.d.now();
    let r;
    try { r = await this.answer(SELF_CHECK, [{ role: 'user', content: SELF_CHECK }], 48, () => {}); } catch (e) { return this.fail(`the self-check failed: ${e instanceof Error ? e.message : String(e)}`); }
    const ms = this.d.now() - t2;
    this.d.post('model-answer', { n: 0, prompt_chars: SELF_CHECK.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed', self_check: true });
    if (r.refused || r.text === '') return this.fail(r.refused ? 'the self-check answer was refused by the judge' : 'the self-check produced no answer');
    this.info.first_answer_ms = ms;
    this.phase = 'answered';
    try { await this.writeLoaded({ answered: true, first_answer_ms: ms, tokens: r.tokens, judged: 'passed', at: new Date().toISOString() }); } catch (e) { return this.fail(`could not write ${LOADED_PATH}: ${e instanceof Error ? e.message : String(e)}`); }
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
      const r = await this.answer(text, msgs, 256, (shown) => this.d.post('chat-delta', { id, text: shown }));
      const ms = this.d.now() - t0;
      done({ text: r.text, refused: r.refused, tokens: r.tokens, ms });
      this.d.post('model-answer', { n, prompt_chars: text.length, tokens: r.tokens, ms, judged: r.refused ? 'refused' : 'passed' });
      if (r.refused) this.d.post('model-refused', { n, reason: 'judge' });
      else if (r.text) {
        this.history.push({ role: 'user', content: text }, { role: 'assistant', content: r.text });
        if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX); // the stored history, not just the copy sent
      }
    } catch (e) {
      done({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }
}

export { REFUSAL };
