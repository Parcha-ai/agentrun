// The phone's brain: one small model in this page (wllama), loaded from a URL through the engine's own cache (so a later visit needs no network), answering
// the agent's turns in the model's own tool format, locked to the tools' schemas (native-tools.ts). It is the `BrainModel` the tab-local provider calls
// (brain-provider.ts, mode "native"): `toolChat` for a turn, one at a time. `warm` reads the system prompt and the tools once, so the first command pays
// only for its own words (Qwen3.5 resumes from a checkpoint before the prompt's last batch: with batch 64 a command re-reads about 60 tokens).
// Portable: no Node API.
import type { Answered, ChatMsg, Llm, RawRequest, RawResult, ToolChatMessage, ToolChatRequest, ToolChatResult, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";
import { DEFAULT_SAMPLING, type Sampling } from "../../04-walks-home/tab/src/sampling.ts";
import type { HistoryMode } from "../../04-walks-home/tab/src/history.ts";
import type { BrainModel } from "./brain-provider.ts";
import { lockedToolChat, renderNative } from "./native-tools.ts";

/** A wllama build the page can run: stock wasm64 + JSPI, or the shim's wasm32 + JSPI and wasm32 + Asyncify (04-walks-home/tab/wllama-shim). */
export type WllamaBuild = "default" | "jspi32" | "asyncify";

/**
 * The builds to try, in order; the next is tried when one does not load. The shim's builds restore the warm state (llama-server's slot restore) and the stock
 * build cannot, so it prefills the system turn instead (1,252 tokens: 201 s in desktop Chrome, against 0.5 s restored): jspi32 comes first wherever JSPI is
 * there and the page serves it. The stock build is never tried on WebKit (Safari 27 passes wllama's memory64 check, then the build never finishes loading) or
 * where memory64 is turned off; Asyncify runs in every browser and comes last. `only` (?build=) tries that one build.
 */
export function buildOrder(o: { webkit: boolean; jspi: boolean; jspi32Served: boolean; noMemory64?: boolean; only?: WllamaBuild }): WllamaBuild[] {
  if (o.only) return [o.only];
  return [...(o.jspi && o.jspi32Served ? ["jspi32" as const] : []), ...(o.webkit || o.noMemory64 ? [] : ["default" as const]), "asyncify"];
}

/**
 * Characters a token in the window after the system turn, a little under the fewest measured: D1's v3 window cases (683 windows of 0 to 2 exchanges: the tab's
 * result texts, a state line and the user) took 3.98 to 4.57 characters a token in llama-server's tokenizer at wllama's commit, median 4.27. Under the fewest,
 * the estimate is never below the real count there, so a window kept is a window that fits; at 3 it cut 90 of the 683 that fit.
 */
export const WINDOW_CHARS_PER_TOKEN = 3.9;

/**
 * Whether the page serves a file: a GET whose body is let go at once. Not HEAD: the 03 server answers it 405 and the offline worker serves GETs only, so a
 * HEAD probe found the jspi32 build missing (and Chrome took the stock build, which reads the whole system turn instead of restoring it).
 */
export async function served(url: string, get: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await get(url);
    void r.body?.cancel().catch(() => undefined);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * What a turn's report says (the page's beacon, read in its server's log): its time, tokens and the tools it called; the reply's words only with `withText`
 * (?report=text, the page's own switch): a reply can repeat what the user said, and the conversation stays on the phone.
 */
export function turnReport(t: PhoneTurn, withText: boolean): Record<string, unknown> {
  return { ms: t.ms, promptNew: t.timings?.prompt_n ?? null, promptTotal: t.promptTokens, out: t.outputTokens, calls: t.calls.map((c) => c.split("(")[0]), ...(t.rewarm ? { rewarm: t.rewarm } : {}), ...(withText ? { text: t.text.slice(0, 160), raw: t.calls.length ? undefined : t.raw.slice(0, 160) } : {}) };
}

/**
 * The phone's window hooks for the provider. `prepare` reads the robot before every turn in either window: the state line, and with it the skills home that
 * the lock narrows `do` to (a window that skipped it would lock every skill out). The exchanges window (D1's T7) also shows the state line and drops the
 * oldest exchange while `fits` says no; the task window (?window=task) shows the current task only.
 */
export function phoneWindow(task: boolean, o: { refresh: () => Promise<string | undefined>; fits: (messages: ToolChatMessage[], tools: ToolChatTool[]) => boolean }) {
  let line: string | undefined;
  const prepare = async () => { line = await o.refresh(); };
  return task ? { prepare } : { prepare, window: "exchanges" as const, stateLine: () => line, fits: o.fits };
}

/** Greedy: a tool call is an answer, not a sample (D1's evaluation decodes at temperature 0). */
const GREEDY: Sampling = { ...DEFAULT_SAMPLING, temperature: 0 };

export interface PhoneTurn {
  at: number; ms: number; promptTokens: number; outputTokens: number; grammar: boolean; calls: string[]; text: string; raw: string; prompt: string; timings?: Record<string, number>;
  /** The warm state restored before this turn (its prompt could not resume where the engine was): how long that took, or why it failed. */
  rewarm?: { ms: number } | { failed: string };
}

export class PhoneModel implements BrainModel {
  /** Every turn so far: what it cost and what it said (for the page and the checks). */
  readonly turns: PhoneTurn[] = [];
  /** Told after every turn (the page's report). */
  onTurn: ((turn: PhoneTurn) => void) | undefined;
  /** The model's bytes as the engine reported them at load (its parts together): what a warm state is checked against. */
  loadedBytes = 0;
  /** Each part's sha256, from the manifest the parts were checked against at load: the weights a warm state must have been made with. */
  private partShas: (string | undefined)[] | undefined;
  /** The warm-up's prompt (the system turn: the system prompt and the tools): every turn's prompt starts with it. */
  warmPrompt: string | undefined;
  /** Its length in tokens, as the engine counted it. */
  warmTokens = 0;
  readonly toolChat: (req: ToolChatRequest, signal?: AbortSignal) => Promise<ToolChatResult>;
  private line: Promise<unknown> = Promise.resolve();
  /** A prompt that starts with this resumes where the engine is (see `resume`); anything else starts from the warm state again, when there is one to restore. */
  private held: string | undefined;
  /** Opens the warm state again, from the engine's cache (set when it was restored from there at the warm-up). */
  private reopen: (() => Promise<Blob>) | undefined;
  /** What `resume` did before the completion in progress. */
  private rewarmed: PhoneTurn["rewarm"];
  private readonly llm: Llm;
  /** Where the model's first part is (its other parts and its manifest sit beside it). */
  get url(): string { return this.o.url; }
  /** The tools the grammar holds, narrowed from the ones the prompt shows (the page sets it: do's skills to the ones home). */
  lock: ((tools: ToolChatTool[]) => ToolChatTool[]) | undefined;
  /** Told when a turn starts (the page shows it as thinking). */
  onTurnStart: (() => void) | undefined;
  private readonly o: { url: string; threads: number; nCtx: number; batch: number; maxTokens: number; loadTimeoutMs?: number; /** A turn that has not answered in this long fails, by name (default 180 s). */ turnTimeoutMs?: number; onProgress?: (loaded: number, total: number) => void; onStatus?: (text: string) => void };

  constructor(llm: Llm, o: PhoneModel["o"]) {
    if (!llm.loadUrl || !llm.complete || !llm.chatTemplate) throw new Error("this model backend cannot load from a URL, complete raw, or show its chat template");
    this.llm = llm;
    this.o = o;
    const locked = lockedToolChat(
      { template: () => llm.chatTemplate!(), complete: async (req: RawRequest, signal: AbortSignal): Promise<RawResult> => (signal.aborted ? { text: "", stoppedBy: "eog", promptTokens: 0, outputTokens: 0, ms: 0 } : this.complete(req, signal)) },
      (t) => { const turn: PhoneTurn = { at: Date.now(), ms: Math.round(t.result.ms), promptTokens: t.result.promptTokens, outputTokens: t.result.outputTokens, grammar: t.grammar, calls: t.result.toolCalls.map((c) => `${c.name}(${c.arguments})`), text: t.result.text, raw: t.raw, prompt: t.prompt, ...(t.timings ? { timings: t.timings } : {}), ...(this.rewarmed ? { rewarm: this.rewarmed } : {}) }; this.turns.push(turn); this.onTurn?.(turn); },
      (tools) => (this.lock ? this.lock(tools) : tools),
    );
    // A turn never hangs silently: past its time it is stopped and fails by name, and the conversation says so (a turn that vanished is what an iPhone showed).
    this.toolChat = (req, signal) => this.serial(async () => {
      this.onTurnStart?.();
      const limit = this.o.turnTimeoutMs ?? 180_000;
      const stop = new AbortController();
      let late = false;
      const timer = setTimeout(() => { late = true; stop.abort(); }, limit);
      const relay = () => stop.abort();
      if (signal?.aborted) stop.abort(); // cancelled while it waited its turn: it reaches no model (below)
      else signal?.addEventListener("abort", relay, { once: true });
      try {
        const r = await locked(req, stop.signal);
        if (late) throw new Error(`the model did not answer in ${Math.round(limit / 1000)} s`);
        return r;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relay);
      }
    });
  }

  /** One completion, from where the engine can resume it (`resume`). Runs inside `serial`. */
  private async complete(req: RawRequest, signal: AbortSignal): Promise<RawResult> {
    await this.resume(req.prompt);
    return this.llm.complete!(req, { signal, sampling: GREEDY });
  }

  /**
   * Before a completion: put the engine where this prompt can resume. Qwen3.5 is hybrid, its recurrent state cannot be cut back, so llama-server resumes a prompt
   * that leaves the engine's sequence from its last checkpoint before that point, and with none after the system turn it reads the whole prompt again, the
   * 1,252-token system turn included (D0 measured 1,458 tokens, 157 s in desktop Chrome, when the window dropped its oldest exchange). A prompt that keeps
   * everything the last one held up to its own reply (the next call of a turn) resumes from a checkpoint near its end. Any other (the next turn, whose window moves
   * the state line, drops an exchange or starts a new chat) has the warm state restored first, from the engine's cache: about half a second, and the turn then
   * reads its window, never the system turn.
   */
  private async resume(prompt: string): Promise<void> {
    const held = this.held;
    const at = prompt.lastIndexOf("<|im_start|>");
    this.held = at > 0 ? prompt.slice(0, at) : prompt; // the next prompt resumes cheaply when it keeps this much: everything before this one's reply
    this.rewarmed = undefined;
    if (!this.reopen || held === undefined || prompt.startsWith(held)) return;
    const started = performance.now();
    try {
      await this.llm.restoreState!(await this.reopen());
      this.rewarmed = { ms: Math.round(performance.now() - started) };
    } catch (e) {
      this.rewarmed = { failed: (e as Error).message }; // the turn goes on from wherever the engine is: slower, not wrong
    }
  }

  /** One request at a time: the engine has one sequence, and a turn must not interleave with the warm-up. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.line.then(work, work);
    this.line = next.catch(() => undefined);
    return next;
  }

  /** Download (or find in the cache) and load the model. */
  async load(): Promise<void> {
    const { url, threads, nCtx, batch, onProgress, onStatus, loadTimeoutMs } = this.o;
    // the parts' manifest next to the model (<name>.parts.json: each part's bytes and sha256), kept for a later load with no network
    const manifestUrl = url.replace(/-00001-of-\d{5}\.gguf$/, ".parts.json");
    let parts: { name?: string; bytes: number; sha256?: string }[] | undefined;
    try {
      const r = await fetch(manifestUrl);
      if (r.ok) { parts = ((await r.json()) as { parts: typeof parts }).parts; try { localStorage.setItem(`parts:${manifestUrl}`, JSON.stringify(parts)); } catch { /* no storage */ } }
    } catch { /* offline: the copy kept from an earlier load, below */ }
    if (!parts) { try { const kept = localStorage.getItem(`parts:${manifestUrl}`); if (kept) parts = JSON.parse(kept) as typeof parts; } catch { /* no storage */ } }
    if (!parts) onStatus?.("no parts manifest: the cached parts are used unchecked");
    this.partShas = parts?.map((p) => p.sha256);
    // one conversation, one sequence: the warm state is slot 0's
    return this.llm.loadUrl!(url, { threads, nCtx, batch, slots: 1, ...(parts ? { parts } : {}), ...(onStatus ? { onStatus } : {}), ...(loadTimeoutMs ? { loadTimeoutMs } : {}), onProgress: (loaded, total) => { this.loadedBytes = total || loaded; onProgress?.(loaded, total); } });
  }

  /**
   * Read the prefix every turn shares once (the system turn: the system prompt and the tools, as the model's own template renders them, ending with its
   * <|im_end|>\n), generating nothing after it: a turn then reads only its own tokens. Qwen3.5 is hybrid, so its recurrent state cannot be cut back: a warm-up
   * that generated a token, or ended inside what the next turn renders differently, would make every turn re-read up to a batch of the prompt (D0 measured: 66
   * tokens a command with a one-token turn, 12 with this). The system turn's end is where every turn agrees, whatever follows it: an earlier exchange, the
   * robot's state line, or the user.
   */
  async warm(system: string, tools: readonly ToolChatTool[], state?: { url: string; onSkip?: (why: string) => void }): Promise<{ ms: number; promptTokens: number; restored?: { tokens: number; bytes: number } }> {
    const template = this.llm.chatTemplate!();
    if (!template) throw new Error("this model has no chat template of its own");
    const full = renderNative(template, [{ role: "system", content: system }, { role: "user", content: "X" }], tools, { enable_thinking: false });
    const at = full.indexOf("<|im_start|>user\n");
    if (at < 0) throw new Error("the model's template has no ChatML user turn to warm up to");
    const prefix = full.slice(0, at); // the system turn, through its <|im_end|>\n
    this.warmPrompt = prefix;
    // A shipped warm state for exactly this prefix (its sidecar holds the prefix's sha256): restored instead of prefilled. Anything else prefills.
    if (state && this.llm.restoreState) {
      const started = performance.now();
      try {
        // the sidecar says which model and which prefix the state holds: other weights, other tools, another prompt or template are not restored
        const side = (await (await fetch(`${state.url}.json`)).json()) as { prefixSha256?: string; model?: { first?: string; bytes?: number; parts?: unknown }; bytes?: number; sha256?: string };
        const first = new URL(this.o.url).pathname.split("/").pop();
        if (side.model?.first !== first || side.model?.bytes !== this.loadedBytes) throw new Error(`the state is for another model (${side.model?.first ?? "?"}, ${side.model?.bytes ?? "?"} bytes; loaded ${first}, ${this.loadedBytes} bytes)`);
        // the same name and size is not the same weights (a fine-tune replaced in place keeps both): the parts' sha256, as the manifest the load checked them with
        const made = Array.isArray(side.model.parts) ? (side.model.parts as unknown[]) : undefined;
        if (!made) throw new Error("the state's sidecar names no part hashes: it cannot be matched to these weights");
        if (!this.partShas || this.partShas.some((x) => !x)) throw new Error("no parts manifest with hashes: the state cannot be matched to these weights");
        if (made.length !== this.partShas.length || made.some((x, i) => x !== this.partShas![i])) throw new Error("the state is for other weights (the parts' sha256 differ)");
        const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prefix)))].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (side.prefixSha256 !== sha) throw new Error(`the state is for another prefix (${String(side.prefixSha256).slice(0, 12)}, this one is ${sha.slice(0, 12)})`);
        // through the engine's cache when it has one (checked against the sidecar's bytes and sha256), so restoring it again before a turn reads no network
        const cached = this.llm.cachedFile && typeof side.bytes === "number" ? { bytes: side.bytes, ...(side.sha256 ? { sha256: side.sha256 } : {}) } : undefined;
        const open = cached ? () => this.llm.cachedFile!(state.url, cached) : async () => { const r = await fetch(state.url); if (!r.ok) throw new Error(`${state.url}: HTTP ${r.status}`); return r.blob(); };
        const restored = await this.serial(async () => this.llm.restoreState!(await open()));
        this.warmTokens = restored.tokens;
        this.held = prefix;
        this.reopen = cached ? open : undefined; // a state fetched whole each time is not restored again per turn (36 MB of network a turn)
        return { ms: Math.round(performance.now() - started), promptTokens: restored.tokens, restored };
      } catch (e) {
        state.onSkip?.((e as Error).message);
      }
    }
    const r = await this.serial(() => this.llm.complete!({ prompt: prefix, maxTokens: 0 }, { signal: new AbortController().signal, sampling: GREEDY }));
    this.warmTokens = r.promptTokens;
    this.held = prefix;
    return { ms: Math.round(r.ms ?? 0), promptTokens: r.promptTokens };
  }

  /**
   * Whether a turn's prompt fits the window's budget (D1's spec: 2048 - 400 tokens). The page has no tokenizer (wllama 3.6.1 exposes none): the warm prefix counts
   * as the tokens the engine counted for it, the rest at WINDOW_CHARS_PER_TOKEN.
   */
  fits(messages: ToolChatMessage[], tools: readonly ToolChatTool[], budget = 1648): boolean {
    const template = this.llm.chatTemplate!();
    if (!template) return true;
    const text = renderNative(template, messages, tools, { enable_thinking: false });
    const known = this.warmPrompt && this.warmTokens > 0 && text.startsWith(this.warmPrompt) ? this.warmPrompt.length : 0;
    return (known ? this.warmTokens : 0) + Math.ceil((text.length - known) / WINDOW_CHARS_PER_TOKEN) <= budget;
  }

  // The chat path (a conversation with no tools, decoded by the 04 tab's two phases) is not this model's: every turn is a native one.
  generate(_prompt: string, _messages: ChatMsg[], _show: (shown: string, final?: boolean) => void): Promise<Answered> {
    return Promise.reject(new Error("the phone's model answers in its own tool format only (mode native)"));
  }
  withBackend<T>(use: (backend: { complete(req: RawRequest): Promise<RawResult> }) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.serial(() => use({ complete: (req) => this.complete(req, signal ?? new AbortController().signal) }));
  }
  historyMode(): HistoryMode { return "none"; }
  state() { return { sampling: { max_tokens: this.o.maxTokens }, size_bytes: null }; }
  async dispose(): Promise<void> { await this.llm.exit(); }
}
