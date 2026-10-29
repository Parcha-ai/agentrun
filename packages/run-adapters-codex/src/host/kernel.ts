// The kernel names the copied Codex harness imports, from @parcha/agentrun-adapters/kernel, plus the three it needs that a
// local session does not otherwise have: the Harness shape, the name of an `unavailable` step, and the optional
// documents reader (a sandbox's Files manifest; absent here). Written for AgentRun.
import type { DriveContext as KernelDriveContext } from "@parcha/agentrun-adapters/kernel";

export type { EffectRecord, HostTool, ReplayPolicy, SessionState, Submission } from "@parcha/agentrun-adapters/kernel";
export { Unavailable } from "@parcha/agentrun-adapters/kernel";

/** A drive context; `docs` is a sandbox's documents reader, which a local session has none of. */
export type DriveContext = KernelDriveContext & {
  readonly docs?: { read(doc: unknown): { value: Record<string, unknown> } };
};

/** The name of the step that records a turn ending unavailable. */
export const UNAVAILABLE_STEP = "unavailable";

/** A harness: one drive runs its pending input to the end, then returns. */
export interface Harness {
  name: string;
  /** Who reports model calls: the harness itself (its model proxy), or the kernel. */
  modelCalls?: "effects" | "self";
  drive(ctx: DriveContext): Promise<void>;
}
