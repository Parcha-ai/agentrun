// Written for AgentRun.
import { o200kTokens } from '../host/o200k.js';
import { HOST_RESULT_MAX_CHARS } from '../types.js';
import { RESULT_CHARS_PER_TOKEN, resultMaxChars } from './tools.js';

/**
 * The turn budget: what a model's context window has left for one turn's tool results, together. Each result alone is
 * held to its share of the window (tools.ts resultMaxChars); this holds a turn's results, all of them, to what the
 * context has not spent. The kernel owns the rule; a harness only reports two facts of each answer (`open`): the input
 * tokens its request held and its output, and how many tool calls it made. The session's model proxy reports them for
 * every harness it serves (ModelProxyOptions.turn); pi, and Claude Code on a person's login (no proxy), report them
 * from their own hooks.
 *
 * What is left for a turn: the window, less what the request held, the answer, and the room kept for the model's next
 * answer (answerReserve), at RESULT_CHARS_PER_TOKEN. Each call claims the smaller of its own bound and what is
 * left over the calls still unanswered, so parallel calls split it evenly, and a result shorter than its claim gives
 * the rest back. With no answer read (a harness whose model traffic the host does not see), the session's fixed text
 * (its system prompt and tool schemas, `fixed`), counted with o200k, is what the context holds, and each result is held
 * to its share of the rest.
 */

/** The share of the window a turn keeps for the model's answer after its results: the results never take it. */
export const ANSWER_RESERVE_SHARE = 0.25;

/** The most tokens a turn keeps for the model's answer, whatever the window. */
export const ANSWER_RESERVE_MAX_TOKENS = 16_384;

/** The tokens a turn on a window of `contextWindow` keeps for the model's answer after its results. */
export const answerReserve = (contextWindow: number): number => Math.min(Math.floor(contextWindow * ANSWER_RESERVE_SHARE), ANSWER_RESERVE_MAX_TOKENS);

/** The most a call waits for an answer still being read (`ready`) before it is bound on what is known: the proxy reads an
 *  answer's usage the moment it ends, so this is only reached if that reading never ends. */
const READY_WAIT_MS = 10_000;

/** The two facts of an answer: the input tokens its request held (the provider's count, its cached input included, or the
 *  host's local count), the output it said, and the client tool calls it made. Each may be unknown. */
export interface TurnFacts {
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
}

/** An answer being read: `open` with its facts once read, `end` however it ended (both once; `end` after `open` is nothing). */
export interface TurnSpan {
  open(facts: TurnFacts): void;
  end(): void;
}

/** What a turn budget journals as it happens (journalTurn): an answer's facts as it opened the turn (`open`, null when its
 *  input was unknown), and a result's length as it was handed (`settled`). */
export type TurnRecord = { open: { inputTokens: number; outputTokens: number; calls?: number } | null } | { settled: { callId: string; chars: number } };

const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined);
const usableWindow = (window: unknown): window is number => typeof window === 'number' && Number.isFinite(window) && window > 0;

export class TurnBudget {
  readonly #fixed = new Map<string, string>();
  #fixedTokens: number | undefined;
  #counting: Promise<void> | undefined;
  #facts: { inputTokens: number; outputTokens: number; calls?: number } | undefined;
  /** What this turn's claims hold of what is left, in characters: each claim's bound until its result settles it. */
  #held = 0;
  readonly #claims = new Map<string, { max: number; settled: boolean }>();
  #reading = 0;
  readonly #waiting = new Set<() => void>();
  /** An answer was read into this budget (open, or restore): a journal's records never replace it. */
  #read = false;
  #sink: ((record: TurnRecord) => void | Promise<void>) | undefined;
  /** Every result length handed to the sink, once each is kept (the sinks' promises, together): rejects once one was not. */
  #kept: Promise<void> = Promise.resolve();

  /** `fixed`: the session's own text every request carries (its system prompt), counted when no answer was read. */
  constructor(fixed: readonly string[] = []) {
    if (fixed.length) this.#fixed.set('system', fixed.join('\n\n'));
  }

  /** Text every request of the session carries, by name (a bridge's tool schemas, 'tools'): replaces the text of that name. */
  fixed(name: string, text: string): void {
    if (this.#fixed.get(name) === text) return;
    this.#fixed.set(name, text);
    this.#fixedTokens = undefined;
    this.#counting = undefined;
  }

  /** An answer of the turn's is being read: a call waits for it (`ready`) before it claims. */
  begin(): TurnSpan {
    this.#reading += 1;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      this.#reading -= 1;
      if (this.#reading === 0) for (const wake of [...this.#waiting]) wake();
    };
    return {
      open: (facts) => {
        if (!done) this.open(facts);
        end();
      },
      end,
    };
  }

  /** A new turn, from its answer's facts: what was claimed before is forgotten. Input tokens unknown: the turn is unknown. */
  open(facts: TurnFacts): void {
    const inputTokens = count(facts.inputTokens);
    const calls = count(facts.calls);
    this.#facts = inputTokens === undefined ? undefined : { inputTokens, outputTokens: count(facts.outputTokens) ?? 0, ...(calls ? { calls } : {}) };
    this.#held = 0;
    this.#claims.clear();
    this.#read = true;
    // No result waits on an answer's record: one the sink could not keep halts its drive (NativeJournal), and the
    // lengths settled after it, which the bridge waits for, fail with it.
    void Promise.resolve(this.#sink?.({ open: this.#facts ? { ...this.#facts } : null })).catch(() => {});
  }

  /** Each answer's facts and each result's length, as they happen, to `sink` (the session's journal: journalTurn), in place of any before.
   *  A new sink (a new drive's journal) starts with nothing waited for: a length the last one failed to keep failed its
   *  own drive, never the next. */
  journal(sink: (record: TurnRecord) => void | Promise<void>): void {
    this.#sink = sink;
    this.#kept = Promise.resolve();
  }

  /** The turn `records` (journal's, in order) leave: the last answer's facts, and each result handed since, held. Only a
   *  budget that has read no answer of its own takes them (a new process resuming its session's turn); else nothing. */
  restore(records: readonly TurnRecord[]): void {
    if (this.#read) return;
    let last = -1;
    records.forEach((record, i) => void (record && 'open' in record && (last = i)));
    if (last < 0) return;
    const opened = (records[last] as Extract<TurnRecord, { open: unknown }>).open;
    const inputTokens = count(opened?.inputTokens);
    const calls = count(opened?.calls);
    this.#facts = inputTokens === undefined ? undefined : { inputTokens, outputTokens: count(opened?.outputTokens) ?? 0, ...(calls ? { calls } : {}) };
    this.#held = 0;
    this.#claims.clear();
    for (const record of records.slice(last + 1)) {
      if (!record || !('settled' in record)) continue;
      const chars = count(record.settled?.chars);
      const callId = record.settled?.callId;
      if (typeof callId !== 'string' || chars === undefined || this.#claims.has(callId)) continue;
      this.#claims.set(callId, { max: chars, settled: true });
      this.#held += chars;
    }
    this.#read = true;
  }

  /** Resolves once no answer is being read (or READY_WAIT_MS passed), and, with none read yet, once the fixed text is counted. */
  async ready(waitMs = READY_WAIT_MS): Promise<void> {
    if (this.#reading > 0) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.#waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, waitMs);
        timer.unref?.();
        this.#waiting.add(wake);
      });
    }
    if (this.#facts || this.#fixedTokens !== undefined || this.#fixed.size === 0) return;
    this.#counting ??= o200kTokens([...this.#fixed.values()].join('\n\n')).then(
      (tokens) => void (this.#fixedTokens = tokens),
      () => void (this.#fixedTokens = 0)
    );
    await this.#counting;
  }

  /**
   * The most characters call `callId`'s result may reach the model with, on a window of `contextWindow` tokens: its share
   * of the window left after what the context holds, and, in a turn whose answer was read, at most what is left of the
   * turn over the calls still unanswered, which this call then holds until `settle`. A call claimed again in the same turn
   * gets the same figure. No usable window: HOST_RESULT_MAX_CHARS.
   */
  claim(callId: string, contextWindow: number | undefined): number {
    if (!usableWindow(contextWindow)) return HOST_RESULT_MAX_CHARS;
    const claimed = this.#claims.get(callId);
    if (claimed) return claimed.max;
    const facts = this.#facts;
    const held = facts ? facts.inputTokens : (this.#fixedTokens ?? 0);
    const share = resultMaxChars({ contextWindow, baseInputTokens: held });
    if (!facts) return share;
    const room = contextWindow - facts.inputTokens - facts.outputTokens - answerReserve(contextWindow);
    const left = Math.max(0, room * RESULT_CHARS_PER_TOKEN - this.#held);
    const unanswered = Math.max(1, (facts.calls ?? 0) - this.#claims.size);
    const max = Math.min(share, Math.floor(left / unanswered));
    this.#claims.set(callId, { max, settled: false });
    this.#held += max;
    return max;
  }

  /** Call `callId`'s result reached the model at `chars` characters: what it claimed and did not use is left for the rest,
   *  and what it took past its claim (a short result is whole under any bound, a refusal's words are what they are) is
   *  held, so the calls after it split only what is left. */
  settle(callId: string, chars: number): void {
    const claimed = this.#claims.get(callId);
    const handed = count(chars);
    if (!claimed || claimed.settled || handed === undefined) return;
    claimed.settled = true;
    this.#held += handed - claimed.max;
    const kept = Promise.all([this.#kept, this.#sink?.({ settled: { callId, chars: handed } })]).then(() => {});
    // Seen here, so a length no one waits for never stops the process; kept() still rejects with it.
    kept.catch(() => {});
    this.#kept = kept;
  }

  /** Resolves once every result length settled is kept by the sink (journalTurn: committed to the journal), so a result
   *  goes back only once a process that stops right after cannot lose its part of the turn. Rejects when one was not:
   *  the result must not go back, since a resume would claim its part again. */
  async kept(): Promise<void> {
    await this.#kept;
  }
}

/** The journal stream of a session's turn budget (TurnRecord). */
export const TURN_STREAM = 'kernel.turn';

/** A drive's journal, as journalTurn writes and reads it (NativeJournal). */
export interface TurnJournal {
  append(stream: string, data: unknown): unknown;
  flush(): Promise<void>;
  records<T = unknown>(stream?: string): readonly { data: T | undefined }[];
}

/**
 * `turn` kept on `journal` (a drive's; the next drive's replaces it): a budget that has read no answer yet (a new process
 * resuming the session) first takes back the turn the journal holds, so the calls its resume answers split what their
 * answer left; then each answer's facts and each result's length go to the journal as they happen, flushed at once: an
 * answer's facts must outlast a process that stops while its calls run, and a result's length one that stops right after
 * it was handed (the bridge waits for it: TurnBudget.kept). A journal that cannot write halts its drive on its own,
 * and a result whose length it could not keep is never handed (kept rejects; the bridge halts and throws).
 */
export function journalTurn(turn: TurnBudget | undefined, journal: TurnJournal): void {
  if (!turn) return;
  turn.restore(journal.records<TurnRecord>(TURN_STREAM).flatMap((r) => (r.data ? [r.data] : [])));
  turn.journal((record) => {
    journal.append(TURN_STREAM, record);
    return journal.flush();
  });
}

/** The client tool calls an answer's event-stream line starts (`data: ...`): a Messages `tool_use` block, a Responses
 *  function or custom tool call item, or a Chat Completions tool call's first piece (the one with its id). A provider's
 *  own tool (a server tool use) is not the client's call. Any other line, or one that does not parse: 0. */
export function toolCallsIn(line: string): number {
  if (!line.startsWith('data:') || !/tool_use|output_item\.added|tool_calls/.test(line)) return 0;
  let event: Record<string, any>;
  try {
    event = JSON.parse(line.slice(5));
  } catch {
    return 0;
  }
  if (event?.type === 'content_block_start') return event.content_block?.type === 'tool_use' ? 1 : 0;
  if (event?.type === 'response.output_item.added') return CALL_ITEMS.has(event.item?.type) ? 1 : 0;
  const calls = event?.choices?.[0]?.delta?.tool_calls;
  return Array.isArray(calls) ? calls.filter((call) => typeof call?.id === 'string' && call.id !== '').length : 0;
}

/** The client tool calls a whole JSON answer (no event stream) made, in the same three formats; undefined when it does not parse. */
export function toolCallsInBody(text: string): number | undefined {
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(body?.content)) return body.content.filter((block: any) => block?.type === 'tool_use').length;
  if (Array.isArray(body?.output)) return body.output.filter((item: any) => CALL_ITEMS.has(item?.type)).length;
  const calls = body?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) ? calls.length : undefined;
}

const CALL_ITEMS = new Set(['function_call', 'custom_tool_call']);
