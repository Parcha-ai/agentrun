// The kernel names the copied Claude Agent harness imports, from @parcha/agentrun-kernel/kernel, plus the Harness shape
// it returns. Written for AgentRun.
export type { DriveContext, EffectRecord, HostTool, ReplayPolicy, SessionState, Submission } from "@parcha/agentrun-kernel/kernel";
export { Restart, Unavailable } from "@parcha/agentrun-kernel/kernel";
import type { DriveContext } from "@parcha/agentrun-kernel/kernel";

/** A harness: one drive runs its pending input to the end, then returns. */
export interface Harness {
  name: string;
  /** Who reports model calls: the harness itself (its model proxy), or the kernel. */
  modelCalls?: "effects" | "self";
  drive(ctx: DriveContext): Promise<void>;
}
