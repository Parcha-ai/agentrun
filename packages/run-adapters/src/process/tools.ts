// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/tools.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: imports from AgentRun's kernel; message prefixes; comments name Codex only.
import { type DriveContext, EffectFailure, type EffectError, type HostTool, hostToolIO, type ReplayPolicy } from '../kernel/index.js';

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
 */

/** What a call returns to the harness. */
export interface ToolResult {
  text: string;
  /** The call failed (its recorded error) or was interrupted. */
  isError: boolean;
  /** The call's intent was committed and its outcome lost (see `EffectError.interrupted`). */
  interrupted?: boolean;
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
      if (!callId) throw new TypeError(`agentrun-adapters: a call to ${tool.name} has no call id; derive a stable one`);
      const key = toolKey(callId);
      const fresh = !ctx.isMemoized(key);
      if (fresh && tool.replay === 'never') await options.beforeNever?.({ name: tool.name, callId, args });
      if (fresh && live) ctx.live({ type: 'tool_start', name: tool.name, args, callId });
      try {
        const text = await ctx.effect(
          key,
          {
            name: `tool.${tool.name}`,
            replay: tool.replay,
            input: args,
            ...(tool.requires ? { requires: tool.requires } : {}),
            ...(tool.needs?.length ? { needs: tool.needs } : {}),
          },
          (io) => tool.execute(args, hostToolIO(io, ctx, { signal: signal ? AbortSignal.any([signal, io.signal]) : io.signal }))
        );
        if (fresh && live) ctx.live({ type: 'tool_end', name: tool.name, callId, result: text });
        return { text: String(text), isError: false };
      } catch (err) {
        if (err instanceof EffectFailure) {
          if (fresh && live) ctx.live({ type: 'tool_end', name: tool.name, callId, isError: true });
          return { text: failureText(err.error, options.partialChars), isError: true, ...(err.error.interrupted ? { interrupted: true } : {}) };
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

/** At most `max` characters, with a marker when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}
