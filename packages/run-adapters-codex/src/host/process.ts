// The process-harness names the copied Codex harness imports: the copied layer from @parcha/agentrun-kernel/process,
// and, written for AgentRun, the session machine's types (a local machine, machine.ts), its brand, the model route the
// harness describes for its model proxy (the policy), and model-step tracking (nothing to track locally).
import { toolBridge as kernelToolBridge, type ToolBridge, type ToolBridgeOptions } from "@parcha/agentrun-kernel/process";
import type { ToolImage } from "@parcha/agentrun-kernel";
import type { TomlValue } from "../config.js";
import type { DriveContext } from "./kernel.js";

export {
  boundResult, BuiltinCalls, failureText, Mutex, NativeJournal, openTurn, placeSubmissions, recoveryNote, recoverySystemNote, recoveryUserTurn, restartEvent, resumeUnstartedCalls, toolKey, transcriptOf,
} from "@parcha/agentrun-kernel/process";
export type { BuiltinStart, ToolResult, TranscriptEntry } from "@parcha/agentrun-kernel/process";

/** The kernel's tool bridge, keeping each call's images by its call id until the answer to Codex takes them
 *  (`takeImages`, code-mode.ts): the harness answers Codex with a result's text, and code mode's request handler adds
 *  the images as `inputImage` items. */
export interface ImageBridge extends ToolBridge {
  takeImages(callId: string): readonly ToolImage[] | undefined;
}

export function toolBridge(ctx: Parameters<typeof kernelToolBridge>[0], tools: Parameters<typeof kernelToolBridge>[1], options?: ToolBridgeOptions): ImageBridge {
  const bridge = kernelToolBridge(ctx, tools, options);
  const images = new Map<string, readonly ToolImage[]>();
  return {
    ...bridge,
    call: async (name, args, callId, signal) => {
      const result = await bridge.call(name, args, callId, signal);
      if (callId && result.images?.length) images.set(callId, result.images);
      return result;
    },
    takeImages: (callId) => {
      const taken = images.get(callId);
      images.delete(callId);
      return taken;
    },
  };
}

/** A child's line protocol: one JSON value per line out, lines in. */
export interface LineChannel {
  send(line: unknown): boolean;
  end(): void;
  lines(): AsyncIterable<string>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  stderrTail(): string;
}

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT";

export interface SessionProcess extends LineChannel {
  alive(): boolean;
  kill(signal?: KillSignal): void;
}

/** A session machine's private directories. */
export type CacheDir = "home" | "config" | "codex-home" | "tmp" | "cache";

export interface CacheFile {
  path: string;
  bytes: Uint8Array;
  mode?: number;
}

export interface MachineSpawn {
  command: string;
  args?: string[];
  /** The child's environment beyond the machine's allowlist (PATH, LANG, TZ). Nothing else is inherited. */
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  isolatedCommands?: boolean;
}

/** A line-complete tail of a file in one of the machine's directories. */
export interface MachineTail {
  readonly offset: number;
  read(): string[];
  sync(): Promise<void>;
  close(): void;
}

/** Where a session's harness runs: here, a local machine with private directories and a loopback model proxy. */
export interface SessionMachine {
  readonly sessionId: string;
  readonly root: string;
  readonly dirs: Readonly<Record<CacheDir, string>>;
  readonly signal: AbortSignal;
  /** The model proxy's base URL (loopback), and the per-session key it admits. */
  readonly modelUrl: string;
  readonly modelKey: string;
  /** What the model must hear about this machine (none locally), and its acknowledgement key. */
  readonly notes: readonly string[];
  readonly notesKey?: string;
  spawn(options: MachineSpawn): Promise<SessionProcess>;
  readonly files: {
    upload(dir: CacheDir, files: readonly CacheFile[]): Promise<void>;
    wipe(): Promise<void>;
  };
  tail(dir: CacheDir, path: string, options?: { offset?: number }): Promise<MachineTail>;
  /** Per acquire: a machine re-attached for a later drive announces nothing until its proxy has seen an answer.
   *  The code-mode `exec` call the model proxy's latest answer carried, read before Codex could act on it (none when that
   *  answer held none): what a nested call of a script is tied to, even before the `exec`'s line is in the rollout. */
  announcedExec?(): string | undefined;
  /** Told each line the rollout's tail reads, as it reads it: the harness's view of code mode follows the log from here. */
  onRolloutLine?(listener: (line: string) => void): void;
  /** Given the drive's hooks for a call the harness never sees (a remote MCP server's tool, mcp.ts). */
  onCalls?(hooks: CallHooks): void;
  /** Given Codex's `config.toml` settings before the harness writes them, to set what the session's own options decide
   *  and the harness does not (its web search, a key reserved from callers). */
  configure?(config: Record<string, TomlValue>): void;
  fsync(): Promise<void>;
  close(): Promise<void>;
}

/** The drive's hooks for a call Codex runs without the harness (code-mode.ts gives them, mcp.ts uses them). */
export interface CallHooks {
  /** Resolves true once the call's own line (a script's nested call: its script's) is in the log, false when it never came. */
  barrier(callId: string): Promise<boolean>;
  /** After a recovery: what answers a call of `tool` with `args` that already completed in the interrupted turn (a rewritten
   *  script re-issues its calls under new ids), taken once; undefined for any other call. */
  recovered(tool: string, args: unknown): string | undefined;
}

/** What a harness's drive asks its machine factory for: the drive, the model route its proxy serves, and its deadline. */
export interface AcquireMachineRequest {
  ctx: DriveContext;
  model?: GatewayHandler;
  deadline?: number;
}
export type AcquireMachine = (request: AcquireMachineRequest) => Promise<SessionMachine>;

const BRAND = Symbol.for("agentrun.codex.session-machine");
/** Mark a machine as made by this package's factory. */
export function brandMachine<T extends object>(machine: T): T {
  Object.defineProperty(machine, BRAND, { value: true });
  return machine;
}
/** Whether a machine was made by this package's factory: the harness refuses any other. */
export const isBrandedMachine = (machine: unknown): machine is SessionMachine =>
  typeof machine === "object" && machine !== null && (machine as Record<symbol, unknown>)[BRAND] === true;

/** One route the model proxy forwards. */
export interface GatewayRoute {
  method: string;
  path: string;
  /** Request headers passed on to the provider. */
  headers?: readonly string[];
}
/** Codex's one route: the Responses API. */
export const CODEX_ROUTES: readonly GatewayRoute[] = Object.freeze([{ method: "POST", path: "/v1/responses", headers: ["originator", "x-client-request-id"] }]);

/** What the harness says about its model route; the machine's proxy serves it (machine.ts). */
export interface GatewayHandlerOptions {
  routes: readonly GatewayRoute[];
  models: { model: string };
  network?: string;
  credential: () => Promise<string | undefined> | string | undefined;
  target: string;
  track?: unknown;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
export interface GatewayHandler {
  readonly kind: "agentrun-model-route";
  readonly options: GatewayHandlerOptions;
}
export const gatewayHandler = (options: GatewayHandlerOptions): GatewayHandler => ({ kind: "agentrun-model-route", options });

/** The provider credential when the harness is given none: the adapter always gives one, so this refuses. */
export const gatewayCredential = async (): Promise<string> => {
  throw new Error("agentrun-harness-codex: no provider credential was given to the Codex harness");
};
/** The provider's base URL when the harness is given none: the adapter always gives one. */
export const gatewayUrl = (): string => {
  throw new Error("agentrun-harness-codex: no provider URL was given to the Codex harness");
};

/** Model steps: a sandbox's tracing of each request. A local session reports usage through its proxy instead. */
export class ModelSteps {
  constructor(_ctx: DriveContext, _options: { log?: (message: string, fields?: Record<string, unknown>) => void } = {}) {}
  readonly request = (): void => {};
  async settleAbandoned(): Promise<void> {}
  async close(): Promise<void> {}
}
export async function settleAbandonedModelSteps(_ctx: DriveContext): Promise<void> {}
