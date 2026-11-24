// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/tools.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, and AgentRun's own since the port from upstream froze on 2026-11-07.
import { type DriveContext, EffectFailure, type EffectError, type HostTool, hostToolIO, type ReplayPolicy, type ToolOutput } from '../kernel/index.js';
import { type GateAnswer, type GateCall, HOST_RESULT_MAX_CHARS, type HostTool as AdapterTool, type JsonValue, type NestedCalls, type ToolImage } from '../types.js';

/**
 * The tool bridge: `HostTool`s as a harness-neutral list a port maps onto its
 * harness's own tool mechanism (Codex's dynamic tools).
 *
 * Each call runs the kernel's effect sandwich keyed by the harness's own
 * tool-call id, `tool:<callId>`, step name `tool.<name>`, with the tool's
 * replay policy: a call the log already finished returns its recorded
 * result without running (a resumed harness that re-issues a call gets the
 * same answer), a `replay: 'never'` call interrupted by a crash comes back
 * as an interrupted result, never a second run. With the harness's built-in
 * tools turned off, these are its only tools, so every side effect it can
 * cause has an intent in the log before it runs.
 *
 * Every result a harness gets passes here, so here it is held to the bound:
 * HOST_RESULT_MAX_CHARS, or less where the harness passes its model's context
 * window (`ToolBridgeOptions.budget`, `resultMaxChars`). A longer text keeps its
 * start and says where it was cut (`boundResult`), the call's record keeping it whole.
 */

/** What a call returns to the harness. */
export interface ToolResult {
  text: string;
  /** The call failed (its recorded error) or was interrupted. */
  isError: boolean;
  /** The call's intent was committed and its outcome lost (see `EffectError.interrupted`). */
  interrupted?: boolean;
  /** Images the tool answered with, as it gave them (recorded with its outcome). */
  images?: readonly ToolImage[];
  /** The answer as a value, where the tool gives one (recorded with its outcome): what a script's nested call reads. */
  structured?: JsonValue;
  /** The text was cut at its bound, or refused for a window too small for any cut (`boundResult`); it says so. */
  truncated?: true;
  /** The gate refused the call: the text is its words, and nothing of the call was written or run. */
  refused?: true;
}

/** One tool, harness-neutral. */
export interface BridgedTool {
  name: string;
  description: string;
  /** JSON Schema for the input (`zodShapeFromJsonSchema` turns it into zod for SDKs that want that). */
  inputSchema: Record<string, unknown>;
  replay: ReplayPolicy;
  /**
   * Run the call. `callId` is the harness's id for this call (Codex's
   * call_id); it must be stable across a resume of
   * the harness's session, since it is the memo key. `signal` is the
   * harness's own cancellation, if it has one; the drive's is always applied.
   */
  call(args: unknown, callId: string, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ToolBridgeOptions {
  /**
   * The host's gate (SessionIO.gate), asked about a call the log has not finished before anything of it: before
   * `beforeNever` and before its intent. "allow" runs it; a deny is the call's error result in the host's words,
   * nothing written and nothing run; a park holds the call, nothing written, until the drive's (or the harness's)
   * signal is aborted, and then rejects.
   */
  gate?: (call: GateCall) => Promise<GateAnswer>;
  /**
   * Runs before a `replay: 'never'` call that the log has not finished:
   * the place for `journal.flush()`, so the harness's record of the call is
   * in the log before the call's intent is.
   */
  beforeNever?: (call: { name: string; callId: string; args: unknown }) => Promise<void>;
  /** Serialize calls (a per-drive mutex). Default true: concurrent effects in one drive are not exercised yet. */
  serial?: boolean;
  /** Publish `tool_start` / `tool_end` on `ctx.live` for calls that run. Default true. */
  live?: boolean;
  /** How much of a partial output an interrupted result quotes. Default 2000 characters. */
  partialChars?: number;
  /** What the harness's model can take of one result (its context window): every result is held to `resultMaxChars` of
   *  it. Absent: HOST_RESULT_MAX_CHARS alone. */
  budget?: ResultBudget;
}

export interface ToolBridge {
  tools: BridgedTool[];
  get(name: string): BridgedTool | undefined;
  /** Run a call by tool name. An unknown name is an error result, not a throw. */
  call(name: string, args: unknown, callId: string, signal?: AbortSignal): Promise<ToolResult>;
}

/** A promise-chain mutex. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }
}

/** The memo key of a tool call. */
export const toolKey = (callId: string) => `tool:${callId}`;

/** A call the gate parked: held, never answered here, until `signal` is aborted (the run parked and this process lets
 *  go of it); then it rejects, so the harness is never handed a result for it. */
function parkedUntilAborted(signal: AbortSignal, tool: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const parked = () => reject(new Error(`${tool} was parked: the run waits for a person's answer`));
    if (signal.aborted) return parked();
    signal.addEventListener('abort', parked, { once: true });
  });
}

/**
 * The host's gate, asked about a call before anything of it is written: the first step of every harness's tool bridge
 * (this one's, and the faux harness's, run-adapters/testing). Undefined when it allows the call; the refusal for a deny,
 * whose words are the call's answer; a park holds the call until `signal` is aborted (the run parked and this process
 * lets go of it), then rejects, so the harness is never handed a result for it.
 */
export async function askGate(gate: (call: GateCall) => Promise<GateAnswer>, call: GateCall, signal: AbortSignal): Promise<{ deny: string } | undefined> {
  const answer = await gate(call);
  if (answer === 'allow') return undefined;
  if ('deny' in answer) return answer;
  return parkedUntilAborted(signal, call.tool);
}

/**
 * Build the bridge for one drive. The calls' effects are this drive's: build
 * a new bridge per `drive(ctx)`.
 *
 * A call whose effect throws anything but a committed failure (the drive was
 * preempted, a recovery resolved the call first, the World refused a write)
 * halts the drive (`ctx.halt`) and rethrows: the harness must not be handed
 * a result the log does not have, and its runtime must stop.
 */
export function toolBridge(ctx: DriveContext, tools: HostTool[], options: ToolBridgeOptions = {}): ToolBridge {
  const mutex = new Mutex();
  const serial = options.serial ?? true;
  const live = options.live ?? true;
  // Each tool's run by name, outside the mutex: a nested call runs inside the call that made it, which holds the mutex.
  const runs = new Map<string, (args: unknown, callId: string, signal?: AbortSignal, nested?: true) => Promise<ToolResult>>();
  /** The session's tools as calls nested in `outer` (NestedCalls): each through its own run, gate first, keyed
   *  `tool:<outer>/<key>`, so a rerun of `outer` gets a recorded one's answer and never runs it twice. */
  const nestedIn = (outer: string, signal: AbortSignal): NestedCalls => ({
    async call(name, args, key, own) {
      const run = runs.get(name);
      if (!run) return { text: `unknown tool: ${name}`, isError: true, refused: true, fresh: true };
      const callId = `${outer}/${key}`;
      const fresh = !ctx.isMemoized(toolKey(callId));
      const { interrupted, ...result } = await run(args, callId, own ? AbortSignal.any([signal, own]) : signal, true);
      return { ...result, ...(interrupted ? { interrupted: true as const } : {}), fresh };
    },
    // A value the call's first run fixed, as a replay-safe effect of its own: its rerun reads the first one. A value given
    // as a function is called only while none is recorded, and outside the effect, so a throw of its (a cap's refusal, a
    // stop) is never recorded as the memo's outcome: the next run calls it again.
    async memo<T extends JsonValue>(key: string, value: T | (() => T | Promise<T>)): Promise<T> {
      const memoKey = `nested:${outer}/${key}`;
      const options = { name: 'nested.memo', replay: 'safe', input: null } as const;
      if (typeof value !== 'function' || ctx.isMemoized(memoKey)) return ctx.effect(memoKey, options, async () => value as T);
      const fixed = await value();
      return ctx.effect(memoKey, options, async () => fixed);
    },
  });
  const bridged = tools.map((tool): BridgedTool => {
    const run = async (args: unknown, callId: string, signal?: AbortSignal, nested?: true): Promise<ToolResult> => {
      if (!callId) throw new TypeError(`agentrun-kernel: a call to ${tool.name} has no call id; derive a stable one`);
      const key = toolKey(callId);
      // A tool that only nests calls writes nothing of its own: it runs, each nested call recorded as itself.
      if (tool.nests) return runNesting(args, callId, signal, nested);
      const fresh = !ctx.isMemoized(key);
      // The gate first: before the flush and the intent, so a refused or parked call leaves nothing in the log.
      if (fresh && options.gate) {
        // An earlier attempt's start in the log (a replay-safe call a crash cut): it may have been sent, and the gate says so.
        const replayed = ctx.state().effects.has(key);
        const refused = await askGate(options.gate, { callId, tool: tool.name, args: (args ?? {}) as Record<string, unknown>, ...(replayed ? { replayed: true as const } : {}), ...(nested ? { nested } : {}) }, signal ? AbortSignal.any([signal, ctx.signal]) : ctx.signal);
        if (refused) return { text: refused.deny, isError: true, refused: true };
      }
      if (fresh && tool.replay === 'never') await options.beforeNever?.({ name: tool.name, callId, args });
      if (fresh && live) ctx.live({ type: 'tool_start', name: tool.name, args, callId, ...(nested ? { parent: callId.slice(0, callId.lastIndexOf('/')) } : {}) });
      try {
        const output = await ctx.effect(
          key,
          {
            name: `tool.${tool.name}`,
            replay: tool.replay,
            input: args,
          },
          (io) => tool.execute(args, hostToolIO(io, ctx, { signal: signal ? AbortSignal.any([signal, io.signal]) : io.signal }))
        );
        // A tool answers in text, or in text with images (a screenshot) and its value: they come back as recorded.
        const { text: whole, images, structured } = typeof output === 'object' && output !== null ? (output as ToolOutput) : { text: String(output), images: undefined, structured: undefined };
        // The bound uses the window the harness passed (MUTATION: dropping `options.budget` here fails the bridge's 16k test).
        const { text, truncated } = boundResult(String(whole), options.budget);
        if (fresh && live) ctx.live({ type: 'tool_end', name: tool.name, callId, result: text, ...(truncated ? { truncated } : {}) });
        return { text, isError: false, ...(images?.length ? { images } : {}), ...(structured !== undefined ? { structured } : {}), ...(truncated ? { truncated } : {}) };
      } catch (err) {
        if (err instanceof EffectFailure) {
          const { text, truncated } = boundResult(failureText(err.error, options.partialChars), options.budget);
          if (fresh && live) ctx.live({ type: 'tool_end', name: tool.name, callId, isError: true, result: text, ...(truncated ? { truncated } : {}) });
          return { text, isError: true, ...(err.error.interrupted ? { interrupted: true } : {}), ...(truncated ? { truncated } : {}) };
        }
        ctx.halt?.(err);
        throw err;
      }
    };
    /** A tool that `nests`: asked at the gate as itself, then run with the session's tools as its nested calls, no effect
     *  of its own written. Its error result is its answer; a throw while the drive or the call is aborted (a nested call
     *  parked, the session let go) halts the drive, as an effect's does, so the harness is never handed a result. */
    const runNesting = async (args: unknown, callId: string, signal?: AbortSignal, nested?: true): Promise<ToolResult> => {
      const aborted = signal ? AbortSignal.any([signal, ctx.signal]) : ctx.signal;
      if (options.gate) {
        const refused = await askGate(options.gate, { callId, tool: tool.name, args: (args ?? {}) as Record<string, unknown>, ...(nested ? { nested } : {}) }, aborted);
        if (refused) return { text: refused.deny, isError: true, refused: true };
      }
      if (live) ctx.live({ type: 'tool_start', name: tool.name, args, callId });
      let output: string | ToolOutput;
      try {
        output = await tool.execute(args, { signal: aborted, progress: () => {}, ctx, stepId: `${toolKey(callId)}#0`, nested: nestedIn(callId, aborted) });
      } catch (err) {
        if (aborted.aborted) {
          ctx.halt?.(err);
          throw err;
        }
        const { text, truncated } = boundResult(err instanceof Error ? err.message : String(err), options.budget);
        if (live) ctx.live({ type: 'tool_end', name: tool.name, callId, isError: true, result: text, ...(truncated ? { truncated } : {}) });
        return { text, isError: true, ...(truncated ? { truncated } : {}) };
      }
      const { text: whole, images, structured } = typeof output === 'object' && output !== null ? output : { text: String(output), images: undefined, structured: undefined };
      const { text, truncated } = boundResult(String(whole), options.budget);
      if (live) ctx.live({ type: 'tool_end', name: tool.name, callId, result: text, ...(truncated ? { truncated } : {}) });
      return { text, isError: false, ...(images?.length ? { images } : {}), ...(structured !== undefined ? { structured } : {}), ...(truncated ? { truncated } : {}) };
    };
    runs.set(tool.name, run);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      replay: tool.replay,
      call: (args, callId, signal) => (serial ? mutex.run(() => run(args, callId, signal)) : run(args, callId, signal)),
    };
  });
  const byName = new Map(bridged.map((t) => [t.name, t]));
  return {
    // What is listed to the model: a deferred tool is run by name (a nested call, `get`, `call`) and never listed.
    tools: bridged.filter((_, index) => !tools[index]!.deferred),
    get: (name) => byName.get(name),
    call: async (name, args, callId, signal) => {
      const tool = byName.get(name);
      if (!tool) return { text: `unknown tool: ${name}`, isError: true };
      return tool.call(args, callId, signal);
    },
  };
}

/**
 * The text a harness gets for a failed call: the error, or for an
 * interrupted one, what the kernel recorded ("may or may not have taken
 * effect") plus the last progress it reported.
 */
export function failureText(error: EffectError, partialChars = 2000): string {
  const message = error.message || 'the tool failed with no message';
  if (!error.interrupted) return message;
  const last = error.partial?.at(-1);
  if (last === undefined) return message;
  const text = typeof last === 'string' ? last : JSON.stringify(last);
  return `${message}\nPartial output before the interruption:\n${clip(text, partialChars)}`;
}

/** What a harness's model can take of one tool result: its context window, and what every request of the session already
 *  spends of it. Either may be absent; with no usable window the host's fixed bound (HOST_RESULT_MAX_CHARS) alone holds. */
export interface ResultBudget {
  /** The model's context window, in tokens. Not a positive finite number (absent, 0, NaN, Infinity): unknown. */
  contextWindow?: number;
  /** Tokens of the window each request spends before any tool result (its system prompt, its tool list), when the
   *  harness knows them. Default 0: the share below leaves room for them. */
  baseInputTokens?: number;
}

/** The most of a model's context window one tool result may take: a quarter, so a turn has room for its prompt, a few
 *  results and the answer. Conservative on purpose: a result past it is cut, never handed to a model it would fill. */
export const RESULT_WINDOW_SHARE = 0.25;

/** Characters per token when a window becomes characters: 3, under the 4 English prose averages, so code, JSON and
 *  non-Latin text (fewer characters a token) still fit. */
export const RESULT_CHARS_PER_TOKEN = 3;

/** The least of a result a cut keeps: below it (a window too small for its note and this much text) the result is refused
 *  in words instead, never passed through. */
export const RESULT_LEAST_KEPT_CHARS = 200;

/** A result at most this long is never cut or refused, however small the window: a refusal's words (under 300 characters)
 *  would cost the window about as much. It also makes the bound idempotent: a cut or a refusal, bound again under the same
 *  budget, is unchanged (pi bounds a host tool's answer, then again in its afterTool hook). */
export const RESULT_ALWAYS_WHOLE_CHARS = 400;

/**
 * The most characters one tool result reaches a model with, for `budget`: HOST_RESULT_MAX_CHARS, or less, a
 * RESULT_WINDOW_SHARE of the window left after the base input at RESULT_CHARS_PER_TOKEN, when that is smaller. No usable
 * window: HOST_RESULT_MAX_CHARS. A base input at or past the window: 0 (every result past its refusal's words is refused).
 */
export function resultMaxChars(budget?: ResultBudget): number {
  const window = budget?.contextWindow;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return HOST_RESULT_MAX_CHARS;
  const base = budget?.baseInputTokens;
  const room = Math.max(0, window - (typeof base === 'number' && Number.isFinite(base) && base > 0 ? base : 0));
  // The bound uses the passed window (MUTATION: returning HOST_RESULT_MAX_CHARS here fails every 16k-window test).
  return Math.min(HOST_RESULT_MAX_CHARS, Math.floor(room * RESULT_WINDOW_SHARE * RESULT_CHARS_PER_TOKEN));
}

/** A harness's `resultBudget` option for a model of `contextWindow`, or none when no window is known (the host's bound
 *  alone): what each adapter spreads into its harness's options, the session's window or its own. */
export const windowBudget = (contextWindow: number | undefined): { resultBudget?: ResultBudget } => (contextWindow ? { resultBudget: { contextWindow } } : {});

/** The line a cut result ends with: the host's bound's, as it always read, or the window's, which says why and how to go on. */
function cutNote(kept: number, total: number, windowed: boolean): string {
  return windowed
    ? `\n[kept ${kept} of ${total} characters: the result was cut to fit this model's context window. Ask for less, or read on from character ${kept} where the tool takes an offset.]`
    : `\n[cut at ${kept} of ${total} characters]`;
}

/** What a result too large for a window too small to cut it in reads as: none of it. */
function refusedNote(total: number, max: number): string {
  return `[not shown: this result is ${total} characters, and this model's context window leaves room for at most ${max} characters of a tool result. Ask for much less: a narrower query, or a small range where the tool takes an offset.]`;
}

/**
 * `text` within `resultMaxChars(budget)` characters, as a harness gets a call's result. Within it: whole. Past it: its
 * start, cut before a character written as a surrogate pair rather than between its halves, then a line saying so,
 * counted in the bound: `[cut at N of M characters]` at the host's bound (no budget, or a window too large to bind: as it
 * always read), or the window's note (kept N of M, cut to fit this model's context window; ask for less, or read on where
 * the tool takes an offset). Where the bound leaves less than RESULT_LEAST_KEPT_CHARS beside its note, the result is
 * refused in a short line of words instead (which may itself pass a bound that small; it carries none of the result).
 * A text of at most RESULT_ALWAYS_WHOLE_CHARS is whole under any budget, so bounding a bound changes nothing. The
 * original oversized text is never returned. `truncated` when cut or refused.
 */
export function boundResult(text: string, budget?: ResultBudget): { text: string; truncated?: true } {
  const max = resultMaxChars(budget);
  if (text.length <= max || text.length <= RESULT_ALWAYS_WHOLE_CHARS) return { text };
  const windowed = max < HOST_RESULT_MAX_CHARS;
  // The note's own length counted at the bound: what is kept is never longer than that, so neither is its note.
  let kept = max - cutNote(max, text.length, windowed).length;
  if (kept < RESULT_LEAST_KEPT_CHARS) return { text: refusedNote(text.length, max), truncated: true };
  if ((text.charCodeAt(kept - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(kept) & 0xfc00) === 0xdc00) kept -= 1;
  return { text: `${text.slice(0, kept)}${cutNote(kept, text.length, windowed)}`, truncated: true };
}

/**
 * Whether `text` is `whole` as some bound left it (boundResult's, under any budget): `whole` itself, its start with a cut
 * note of `whole`'s length, or the refusal of a result that long. A harness that compares a call's two records (the
 * store's whole result, what its model was handed) reads them as one this way, without knowing the budget it ran under.
 */
export function boundOf(text: string, whole: string): boolean {
  if (text === whole) return true;
  // The note is the text's last line: matched at its end, so a note-like line inside the result is never read as it.
  const cut = /\n\[(?:cut at|kept) (\d+) of (\d+) characters(?:\]|: [^\n]*\])$/.exec(text);
  if (cut && Number(cut[2]) === whole.length) {
    const kept = Number(cut[1]);
    return [true, false].some((windowed) => text === `${whole.slice(0, kept)}${cutNote(kept, whole.length, windowed)}`);
  }
  const refused = /^\[not shown: this result is (\d+) characters, .* at most (\d+) characters of a tool result\./.exec(text);
  return refused !== null && Number(refused[1]) === whole.length && text === refusedNote(whole.length, Number(refused[2]));
}

/** At most `max` characters, with a marker when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/** What a harness adds to the one conversion of a host tool into the bridge's (`bridgeTool`): each is absent where it has none. */
export interface BridgeHooks {
  /** The name the harness gives the tool (Codex's `mcp_` form for an MCP tool); with `nestedName` its inverse for a nested call. */
  name?: string;
  description?: string;
  /** A tool that nests calls names them by the host's names; the bridge holds them by the harness's: this maps one to the other. */
  nestedName?(name: string): string;
  /** Run once the call's intent is in the records, before the tool runs: the harness's live `tool_start`, its pause check. A throw is the call's error. */
  start?(call: { callId: string; attempt: number; args: unknown }): void;
  /** The problem with a result's images for this harness's model, or undefined: the call's error, by the tool's name and the image. */
  imageProblems?(images: readonly ToolImage[]): string | undefined;
  /** The tool parked the call for a person's approval: recorded so, before its answer. */
  parked?(ctx: DriveContext, callId: string): Promise<unknown>;
}

/** A host tool (`call(args, context)`) as the bridge's tool (`execute(input, io)`), once for every harness: the same name,
 *  schema, replay policy, `nests` and `deferred`; the call runs as a kernel effect, whose intent is durable in the session's
 *  records before `execute` is entered, so a crash inside a `never` tool is always reported, never repeated. The effect's
 *  step is `tool:<the harness's call id>#<attempt>`, so the host sees the harness's call id and the attempt (above 0 when
 *  a crash cut an earlier one and the kernel runs the call again). A result that is an error is the call's failure; its
 *  value and images are recorded with the outcome (a script's nested call is answered them). */
export function bridgeTool(tool: AdapterTool, hooks: BridgeHooks = {}): HostTool {
  return {
    name: hooks.name ?? tool.name,
    description: hooks.description ?? tool.description,
    inputSchema: tool.inputSchema,
    replay: tool.replay,
    ...(tool.nests ? { nests: true as const } : {}),
    ...(tool.deferred ? { deferred: true as const } : {}),
    async execute(input, io) {
      const callId = (io.stepId ?? '').replace(/^tool:/, '').replace(/#\d+$/, '');
      const attempt = Number(/#(\d+)$/.exec(io.stepId ?? '')?.[1] ?? 0);
      hooks.start?.({ callId, attempt, args: input });
      const nested = io.nested && hooks.nestedName ? { call: (name: string, args: Record<string, unknown>, key: string, signal?: AbortSignal) => io.nested!.call(hooks.nestedName!(name), args, key, signal), memo: io.nested.memo } : io.nested;
      const result = await tool.call(input, { callId, signal: io.signal, attempt, ...(nested ? { nested } : {}) });
      if (result.parked && hooks.parked) await hooks.parked(io.ctx, callId);
      if (result.isError) throw new Error(result.text);
      const structured = result.structured !== undefined ? { structured: result.structured } : {};
      if (!result.images?.length) return result.structured === undefined ? result.text : { text: result.text, ...structured };
      const wrong = hooks.imageProblems?.(result.images);
      if (wrong) throw new Error(wrong);
      return { text: result.text, images: result.images.map((image) => ({ mimeType: image.mimeType, data: image.data })), ...structured };
    },
  };
}
