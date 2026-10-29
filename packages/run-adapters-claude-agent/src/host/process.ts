// The process-harness names the copied Claude Agent harness imports: the copied layer from
// @parcha/agentrun-adapters/process, and, written for AgentRun, the session machine's types (a local machine,
// machine.ts), its brand, and the model route the harness describes for the session's model proxy (policy.ts).
//
// Model spend is accounted only by the runner, through the proxy's hooks (`runner.request` before a request leaves,
// `runner.turn` with its cost after). Upstream also keeps a dollar ledger in the session's journal and traces each request
// as a model step through its own gateway; here `journalLedger` and `ModelSteps` record nothing, so no spend is recorded
// twice.
import type { DriveContext } from "./kernel.js";

export {
  BuiltinCalls, NativeJournal, openTurn, placeSubmissions, recoveryNote, replayBy, restartEvent, toolBridge, waitForSubmissions,
} from "@parcha/agentrun-adapters/process";
export type { JournalRecord, TranscriptEntry } from "@parcha/agentrun-adapters/process";

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT";

/** A running child of the session. */
export interface SessionProcess {
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  stderrTail(): string;
  alive(): boolean;
  kill(signal?: KillSignal): void;
}

/** A session machine's private directories. */
export type CacheDir = "home" | "config" | "tmp" | "cache";

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

/** Where a session's harness runs: a local machine with private directories and a loopback model proxy. */
export interface SessionMachine {
  readonly sessionId: string;
  /** The session's working directory: empty, its own, never the host's workspace. */
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

const BRAND = Symbol.for("agentrun.claude-agent.session-machine");
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
/** The Claude Agent CLI's one route: the Messages API, with the headers that select its version and betas. */
export const CLAUDE_ROUTES: readonly GatewayRoute[] = Object.freeze([{ method: "POST", path: "/v1/messages", headers: ["anthropic-version", "anthropic-beta"] }]);

/** A provider-hosted tool the harness may offer (none here: the policy refuses them all). */
export type ProviderTool = "web_search" | "web_fetch";
/** The caps a model route can reach. */
export type GatewayCap = "turnUsd" | "sessionUsd" | "concurrency";

/** What the harness says about its model route; the machine's proxy serves it (machine.ts, policy.ts). */
export interface GatewayHandlerOptions {
  routes: readonly GatewayRoute[];
  models: { model: string; smallModel?: string };
  budget?: { turnUsd: number; sessionUsd: number };
  ledger?: unknown;
  providerTools?: readonly ProviderTool[];
  network?: string;
  credential: () => Promise<string | undefined> | string | undefined;
  target: string;
  track?: unknown;
  onCap?: (cap: GatewayCap) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}
export interface GatewayHandler {
  readonly kind: "agentrun-model-route";
  readonly options: GatewayHandlerOptions;
}
export const gatewayHandler = (options: GatewayHandlerOptions): GatewayHandler => ({ kind: "agentrun-model-route", options });

/** The provider credential when the harness is given none: the adapter always gives one, so this refuses. */
export const gatewayCredential = async (): Promise<string> => {
  throw new Error("agentrun-claude-agent: no provider credential was given to the harness");
};
/** The provider's base URL when the harness is given none: the adapter always gives one. */
export const gatewayUrl = (): string => {
  throw new Error("agentrun-claude-agent: no provider URL was given to the harness");
};

/** Upstream's model steps (a trace of each request through its gateway). The runner accounts requests here: nothing to trace. */
export class ModelSteps {
  constructor(_ctx: DriveContext, _options: { log?: (message: string, fields?: Record<string, unknown>) => void } = {}) {}
  readonly request = (): void => {};
  async settleAbandoned(): Promise<void> {}
  async close(): Promise<void> {}
}
export async function settleAbandonedModelSteps(_ctx: DriveContext): Promise<void> {}

/** Upstream's dollar ledger in the session's journal. The runner accounts spend here: this one records nothing. */
export interface JournalLedger {
  turn(key: string): void;
  spent(): { turnUsd: number; sessionUsd: number };
  add(usd: number, info: { method: string; path: string; model?: string; estimated?: boolean }): void;
}
export function journalLedger(_journal: unknown, _options: { records?: readonly unknown[] } = {}): JournalLedger {
  return { turn: () => {}, spent: () => ({ turnUsd: 0, sessionUsd: 0 }), add: () => {} };
}
