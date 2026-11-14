// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/tools.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, and AgentRun's own since the port from upstream froze on 2026-11-07.
import { type DriveContext, EffectFailure, type EffectError, type HostTool, hostToolIO, type ReplayPolicy, type ToolOutput } from '../kernel/index.js';
import { type GateAnswer, type GateCall, HOST_RESULT_MAX_CHARS, type JsonValue, type NestedCalls, type ToolImage } from '../types.js';

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
 * Every result a harness gets passes here, so here it is held to the host's
 * bound: a text past HOST_RESULT_MAX_CHARS keeps its start and says where it
 * was cut (`boundResult`), the call's record keeping it whole.
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
  /** The text was cut at HOST_RESULT_MAX_CHARS (`boundResult`); it says so in its last line. */
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
    async call(name, args, key) {
      const run = runs.get(name);
      if (!run) return { text: `unknown tool: ${name}`, isError: true, refused: true, fresh: true };
      const callId = `${outer}/${key}`;
      const fresh = !ctx.isMemoized(toolKey(callId));
      const { interrupted, ...result } = await run(args, callId, signal, true);
      return { ...result, ...(interrupted ? { interrupted: true as const } : {}), fresh };
    },
    // A value the call's first run fixed, as a replay-safe effect of its own: its rerun reads the first one.
    memo: (key, value) => ctx.effect(`nested:${outer}/${key}`, { name: 'nested.memo', replay: 'safe', input: null }, async () => value),
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
        const { text, truncated } = boundResult(String(whole));
        if (fresh && live) ctx.live({ type: 'tool_end', name: tool.name, callId, result: text, ...(truncated ? { truncated } : {}) });
        return { text, isError: false, ...(images?.length ? { images } : {}), ...(structured !== undefined ? { structured } : {}), ...(truncated ? { truncated } : {}) };
      } catch (err) {
        if (err instanceof EffectFailure) {
          const { text, truncated } = boundResult(failureText(err.error, options.partialChars));
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
        const { text, truncated } = boundResult(err instanceof Error ? err.message : String(err));
        if (live) ctx.live({ type: 'tool_end', name: tool.name, callId, isError: true, result: text, ...(truncated ? { truncated } : {}) });
        return { text, isError: true, ...(truncated ? { truncated } : {}) };
      }
      const { text: whole, images, structured } = typeof output === 'object' && output !== null ? output : { text: String(output), images: undefined, structured: undefined };
      const { text, truncated } = boundResult(String(whole));
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
    tools: bridged,
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

/**
 * `text` within HOST_RESULT_MAX_CHARS characters, as a harness gets a call's
 * result: a longer one keeps its start, cut before a character written as a
 * surrogate pair rather than between its halves, and ends with a line saying
 * so, `[cut at N of M characters]`, counted in the bound. `truncated` when cut.
 */
export function boundResult(text: string): { text: string; truncated?: true } {
  if (text.length <= HOST_RESULT_MAX_CHARS) return { text };
  const note = (kept: number) => `\n[cut at ${kept} of ${text.length} characters]`;
  // The note's own length counted at the bound: what is kept is never longer than that, so neither is its note.
  let kept = HOST_RESULT_MAX_CHARS - note(HOST_RESULT_MAX_CHARS).length;
  if ((text.charCodeAt(kept - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(kept) & 0xfc00) === 0xdc00) kept -= 1;
  return { text: `${text.slice(0, kept)}${note(kept)}`, truncated: true };
}

/** At most `max` characters, with a marker when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}
