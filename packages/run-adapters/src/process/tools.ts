// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/tools.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, and AgentRun's own since the port from upstream froze on 2026-11-07.
import { type DriveContext, EffectFailure, type EffectError, type HostTool, hostToolIO, type ReplayPolicy, type ToolOutput } from '../kernel/index.js';
import { type GateAnswer, type GateCall, HOST_RESULT_MAX_CHARS, type ToolImage } from '../types.js';

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
  /** The text was cut at HOST_RESULT_MAX_CHARS (`boundResult`); it says so in its last line. */
  truncated?: true;
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
  const bridged = tools.map((tool): BridgedTool => {
    const run = async (args: unknown, callId: string, signal?: AbortSignal): Promise<ToolResult> => {
      if (!callId) throw new TypeError(`agentrun-kernel: a call to ${tool.name} has no call id; derive a stable one`);
      const key = toolKey(callId);
      const fresh = !ctx.isMemoized(key);
      // The gate first: before the flush and the intent, so a refused or parked call leaves nothing in the log.
      if (fresh && options.gate) {
        // An earlier attempt's start in the log (a replay-safe call a crash cut): it may have been sent, and the gate says so.
        const replayed = ctx.state().effects.has(key);
        const answer = await options.gate({ callId, tool: tool.name, args: (args ?? {}) as Record<string, unknown>, ...(replayed ? { replayed: true as const } : {}) });
        if (answer !== 'allow') {
          if ('deny' in answer) return { text: answer.deny, isError: true };
          await parkedUntilAborted(signal ? AbortSignal.any([signal, ctx.signal]) : ctx.signal, tool.name);
        }
      }
      if (fresh && tool.replay === 'never') await options.beforeNever?.({ name: tool.name, callId, args });
      if (fresh && live) ctx.live({ type: 'tool_start', name: tool.name, args, callId });
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
        // A tool answers in text, or in text with images (a screenshot): the images come back as recorded.
        const { text: whole, images } = typeof output === 'object' && output !== null ? (output as ToolOutput) : { text: String(output), images: undefined };
        const { text, truncated } = boundResult(String(whole));
        if (fresh && live) ctx.live({ type: 'tool_end', name: tool.name, callId, result: text, ...(truncated ? { truncated } : {}) });
        return { text, isError: false, ...(images?.length ? { images } : {}), ...(truncated ? { truncated } : {}) };
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
