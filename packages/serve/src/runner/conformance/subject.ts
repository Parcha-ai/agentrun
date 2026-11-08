// What a harness hands the conformance suite (kernel page: "One conformance suite proves every adapter durable"). The
// suite owns the store, the runners, the tools, the crash and the checks; a harness brings loops whose model plays the
// suite's script through the kernel, and the kernel's two hook points. Its journal is read with the kernel's one reader
// (runner/journal-reader.ts), the same for every harness.
import type { LoopFactory } from "../loop-contract.js";

/** One step of the model's script: call a tool, say a text, or say the text of the last steer it was given. */
export type ScriptStep =
  | { readonly call: ToolName; readonly args?: Record<string, unknown> }
  | { readonly say: string }
  | { readonly sayLastSteer: true };

/** The suite's tools. effect changes something outside the run; read does not; slow runs until the suite lets it go
 *  (or its signal is aborted); asked is one the gate asks a person about. */
export type ToolName = "effect" | "read" | "slow" | "asked";

export interface SuiteTool {
  readonly name: ToolName;
  /** May run again after a crash: it changes nothing outside the run. */
  readonly replaySafe: boolean;
  /** The gate asks a person before it runs: the run parks. */
  readonly ask: boolean;
  /** Runs the tool. `signal`: the turn's (a stop or a lost claim aborts it). */
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface ToolCall {
  readonly callId: string;
  readonly tool: ToolName;
  readonly args: Record<string, unknown>;
}

/** The kernel's two points in the rule every edge follows (intent, flush, route, result). Both are awaited. A hook that
 *  throws is a fault in the task (the process lives on): the kernel's restart rule decides what happens next, and a
 *  call that is not replay-safe never runs again. */
export interface KernelHooks {
  /** Just before journal.intent(call). */
  beforeIntent(call: ToolCall): Promise<void>;
  /** After route() returned, just before journal.result(call, result). */
  beforeResult(call: ToolCall, result: unknown): Promise<void>;
}

export interface ConformanceSetup {
  readonly script: readonly ScriptStep[];
  readonly tools: Readonly<Record<ToolName, SuiteTool>>;
  readonly hooks: KernelHooks;
}

export type ConformanceCase =
  | "crash-before-intent"
  | "crash-after-intent"
  | "crash-before-intent-process"
  | "crash-after-intent-process"
  | "replay-safe-rerun"
  | "steer-mid-turn"
  | "stop-ends-turn"
  | "park-on-ask"
  | "fault-effects-once"
  | "fault-restarts-bounded";

export interface ConformanceSubject {
  /** The harness's name, as the suite's tests are titled. */
  readonly name: string;
  /** Loops for runs whose model plays `setup.script`, calling `setup.tools` through the kernel with `setup.hooks`. */
  createLoop(setup: ConformanceSetup): LoopFactory;
  /** Where a runner process finds this subject (an importable module and its export), for the cases whose crash is a real
   *  process's death. Without it those cases are skipped, saying so. */
  readonly process?: { readonly module: string; readonly export: string };
  /** Cases this harness cannot model yet, each with why: reported as skipped with that reason, never as passed. */
  readonly unsupported?: Partial<Record<ConformanceCase, string>>;
}
