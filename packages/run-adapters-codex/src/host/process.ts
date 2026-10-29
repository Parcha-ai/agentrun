// The process-harness names the copied Codex harness imports: the copied layer from @parcha/agentrun-adapters/process,
// and, written for AgentRun, the session machine's types (a local machine, machine.ts), its brand, the model route the
// harness describes for its model proxy (the policy), and model-step tracking (nothing to track locally).
import type { DriveContext } from "./kernel.js";

export {
  BuiltinCalls, failureText, Mutex, NativeJournal, placeSubmissions, recoveryNote, restartEvent, toolBridge, toolKey, transcriptOf,
} from "@parcha/agentrun-adapters/process";
export type { BuiltinStart, ToolResult, TranscriptEntry } from "@parcha/agentrun-adapters/process";

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
  fsync(): Promise<void>;
  close(): Promise<void>;
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

/** The session's dollar ledger, kept by the harness in its records. */
export interface GatewayLedger {
  spent(): { turnUsd: number; sessionUsd: number };
  add(usd: number, info: { method: string; path: string; model?: string; estimated?: boolean }): void;
}

/** What the harness says about its model route; the machine's proxy serves it (machine.ts). */
export interface GatewayHandlerOptions {
  routes: readonly GatewayRoute[];
  models: { model: string };
  budget?: { turnUsd: number; sessionUsd: number };
  ledger?: GatewayLedger;
  network?: string;
  credential: () => Promise<string | undefined> | string | undefined;
  target: string;
  track?: unknown;
  onCap?: (cap: "turnUsd" | "sessionUsd" | "concurrency") => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
export interface GatewayHandler {
  readonly kind: "agentrun-model-route";
  readonly options: GatewayHandlerOptions;
}
export const gatewayHandler = (options: GatewayHandlerOptions): GatewayHandler => ({ kind: "agentrun-model-route", options });

/** The provider credential when the harness is given none: the adapter always gives one, so this refuses. */
export const gatewayCredential = async (): Promise<string> => {
  throw new Error("agentrun-codex: no provider credential was given to the Codex harness");
};
/** The provider's base URL when the harness is given none: the adapter always gives one. */
export const gatewayUrl = (): string => {
  throw new Error("agentrun-codex: no provider URL was given to the Codex harness");
};

/** Model steps: a sandbox's tracing of each request. A local session reports usage through its proxy instead. */
export class ModelSteps {
  constructor(_ctx: DriveContext, _options: { log?: (message: string, fields?: Record<string, unknown>) => void } = {}) {}
  readonly request = (): void => {};
  async settleAbandoned(): Promise<void> {}
  async close(): Promise<void> {}
}
export async function settleAbandonedModelSteps(_ctx: DriveContext): Promise<void> {}
