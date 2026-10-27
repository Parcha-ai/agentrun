// The kernel the copied harness code runs on: the slice of a durable driver's interface it calls, implemented over
// AgentRun's own SessionStore (drive.ts). Field names follow the code that calls them, so a copied file runs unchanged
// apart from its imports. Written for AgentRun; no code here is copied.
import type { JsonValue, SessionStore } from "../types.js";

export type ReplayPolicy = "safe" | "never";
export type SubmissionKind = "prompt" | "steer" | "followUp" | "withdraw";

/** One input a person sent the session, as the host recorded it. */
export interface Submission {
  id: string;
  kind: SubmissionKind;
  text?: string;
  /** For a withdraw: the submission it withdraws. */
  target?: string;
  receivedAt: Date;
}

export type EffectStatus = "pending" | "running" | "completed" | "failed";

export interface EffectError {
  message: string;
  /** The effect's drive went away before it reported an outcome: it may or may not have taken effect. */
  interrupted?: boolean;
  /** What it reported before it was interrupted. */
  partial?: unknown[];
}

/** One effect as the session's records hold it: its intent, then at most one outcome. */
export interface EffectRecord {
  key: string;
  stepId: string;
  name: string;
  replay: ReplayPolicy;
  input: unknown;
  status: EffectStatus;
  output?: unknown;
  error?: EffectError;
  /** 0 for the first run; one more each time a `safe` effect a crash cut off is run again. */
  attempt: number;
  startedAt?: Date;
  /** Submissions this effect placed: taken out of `pending()` at its intent. */
  placed: string[];
}

/** The session as its records fold. */
export interface SessionState {
  runId: string;
  status: "running";
  submissions: Submission[];
  placed: Set<string>;
  withdrawn: Set<string>;
  /** By key: the first intent for a key wins. */
  effects: Map<string, EffectRecord>;
  /** In the order their intents were written. */
  effectOrder: EffectRecord[];
}

export interface EffectOptions {
  name: string;
  replay: ReplayPolicy;
  input: unknown;
  placed?: string[];
  /** Where the effect must run and what it needs; recorded with the intent, not acted on by this kernel. */
  requires?: string;
  needs?: string[];
}

export interface EffectIO {
  signal: AbortSignal;
  progress(chunk: unknown): void;
  stepId: string;
}

/** A blob store for records too large to keep inline: pieces of text, content-addressed, kept in the session's store. */
export interface KernelWorld {
  readonly store: SessionStore;
}

/** What a copied harness drive gets: its session's state, effects that run at most once (or again, when `safe`, after a
 *  crash), its pending input, and its signal. One drive holds a session at a time: the run's lease sees to it. */
export interface DriveContext {
  readonly runId: string;
  readonly world: KernelWorld;
  readonly config: unknown;
  state(): SessionState;
  effect<T>(key: string, options: EffectOptions, fn: (io: EffectIO) => Promise<T>): Promise<T>;
  isMemoized(key: string): boolean;
  pending(): Submission[];
  /** Read records another writer appended (the door's new input) into the state. */
  refresh(): Promise<void>;
  live(event: unknown): void;
  /** Called when new input may be waiting (a submission was recorded through this drive); returns the unsubscribe. */
  onHint?(listener: (hint: { eventType: "hook_received" | "reconnect" }) => void): () => void;
  readonly signal: AbortSignal;
  halt?(reason: unknown): void;
  /** How many times this session's drive has been rebuilt in this process (0 first). */
  readonly attempt: number;
  /** When this drive must have let go, on Date.now()'s clock, if it has a deadline. */
  readonly deadline?: number;
}

/** A tool the host runs for the harness, as the copied tool bridge calls it. */
export interface HostTool<Input = any> {
  name: string;
  label?: string;
  description: string;
  inputSchema: object;
  replay: ReplayPolicy;
  /** Where the tool must run, and what it needs: passed to the effect's intent. */
  requires?: string;
  needs?: string[];
  execute(input: Input, io: HostToolIO): Promise<string>;
}

export interface HostToolIO {
  signal: AbortSignal;
  progress(chunk: unknown): void;
  ctx: DriveContext;
  stepId?: string;
}

export type { JsonValue };
