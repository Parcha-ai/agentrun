// The seam between AgentRun's hosts and an agent harness that is not Pi, starting with Codex. It is harness-neutral.
// One interface serves both hosts: a DSL host's `runNode` (createHarnessRunner) and serve's runs. Nothing here
// imports a host.
import type { WorkflowDeps } from "@parcha/agentrun-dsl";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** What a node runner is asked, with the step it runs as under recovery and the node's own turn limit (#1061). */
export type NodeRequest = Parameters<NonNullable<WorkflowDeps["runNode"]>>[0] & {
  step?: { sessionId: string; attempt: number; earlierSessionIds: readonly string[] };
  /** An `agent` node's `max_turns`; applied within the runner's own cap. */
  maxTurns?: number;
};

/** A tool the host gives a session. */
export interface HostTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `safe`: may run again after a crash. `never`: at most once; a call a crash cut off is reported, never repeated. */
  replay: "safe" | "never";
  call(args: unknown, context: { callId: string; signal: AbortSignal }): Promise<{ text: string; isError?: boolean }>;
}

/** One durable record of a session, in the order it was appended. */
export interface SessionRecord {
  kind: string;
  data: JsonValue;
}

/** Where a session's records live: the run's store, written through whoever owns it. `append` resolves once the
 *  records are durable, in order. A key is one session for its whole life, across processes. */
export interface SessionStore {
  read(key: string): Promise<SessionRecord[]>;
  append(key: string, records: readonly SessionRecord[]): Promise<void>;
}

/** What one session is. */
export interface SessionSpec {
  /** The session's durable identity: a node step's `sessionId`, or a key of the runner's own for a call with no step. */
  key: string;
  label: string;
  executionPath?: string;
  system: string[];
  /** Exactly these tools; the harness's own stay off. */
  tools: HostTool[];
  context: "fresh" | "fork";
  tier?: NodeRequest["tier"];
  effort?: NodeRequest["effort"];
  thinking?: NodeRequest["thinking"];
}

/** A paid model request, as the session is about to send it. */
export interface ModelRequest {
  model: string;
}

/** What a paid request cost, once it completed. */
export interface ModelUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Null when the price is unknown; `estimated` when it is not the provider's own figure. */
  usd: number | null;
  estimated?: boolean;
}

/** The session's model requests, through the runner: every paid request is announced before it is sent, and may be
 *  refused there (a turn cap, the host's budget); its usage is reported when it completes. */
export interface ModelPort {
  beforeRequest(request: ModelRequest): Promise<void>;
  afterRequest(usage: ModelUsage): Promise<void>;
}

/** What the host lends a session. */
export interface SessionIO {
  store: SessionStore;
  models: ModelPort;
  signal: AbortSignal;
  /** The session's private directory, when the host gives one: its HOME and the harness's own files. */
  dir?: string;
  onEvent(event: AdapterEvent): void;
}

/** An event of a session, as the adapter reports it. The runner adds the node it belongs to. */
export type AdapterEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown; parent?: string }
  | { type: "tool_end"; callId: string; name: string; isError: boolean }
  | { type: "turn_end"; status: TurnStatus };

/** An event as a host receives it: the adapter's, the runner's own, and the node each belongs to. */
export type HarnessEvent = (AdapterEvent
  | { type: "request_start"; turn: number; model: string }
  | { type: "request_end"; turn: number; usage: ModelUsage }) & { key: string; label: string; executionPath?: string };

export type TurnStatus = "completed" | "interrupted" | "failed";

/** A session as `open` found it: new, cut off inside a turn (the adapter owes a recovery turn), or between turns. */
export type SessionState = "new" | "open_turn" | "idle";

export interface AdapterSession {
  readonly state: SessionState;
  /** Place the input, then send it: a new turn. */
  send(text: string): Promise<void>;
  /** Resume the turn a crash cut off, from the session's records. Only when `state` is `open_turn`. */
  recover(): Promise<void>;
  /** Resolves when the turn in flight ends. */
  turnEnd(): Promise<{ status: TurnStatus; error?: string }>;
  /** Stop the turn in flight; calls it left open end interrupted. */
  interrupt(): Promise<void>;
  /** Stop the harness's processes and let go of the session. */
  close(): Promise<void>;
}

export interface AdapterCapabilities {
  /** Whether the adapter can start a session from another's transcript. */
  fork: boolean;
}

export interface AgentAdapter {
  readonly id: string;
  /** The harness version the adapter is pinned to. */
  readonly version: string;
  capabilities(): AdapterCapabilities;
  /** Problems with a session before anything is spent; an empty list opens it. */
  check(spec: SessionSpec): string[];
  /** Opens the session, restoring it from `io.store` when its key has records. */
  open(spec: SessionSpec, io: SessionIO): Promise<AdapterSession>;
}
