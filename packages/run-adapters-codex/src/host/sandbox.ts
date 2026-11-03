// The session-machine names the copied Codex harness imports, for a local machine. Written for AgentRun.
import type { DriveContext } from "./kernel.js";
import type { AcquireMachine, GatewayHandler, SessionMachine } from "./process.js";

/** Acquire the session's machine for this drive, with the model route its proxy serves. */
export async function attachInDrive(ctx: DriveContext, acquire: AcquireMachine, options: { model?: GatewayHandler; deadline?: number } = {}): Promise<SessionMachine> {
  return acquire({ ctx, ...(options.model ? { model: options.model } : {}), ...(options.deadline === undefined ? {} : { deadline: options.deadline }) });
}

/** A local machine shows the model no notes, so there is nothing to acknowledge. */
export async function acknowledgeInDrive(_ctx: DriveContext, _key?: string): Promise<void> {}

/** The pinned Codex binary, as the harness names it. */
export interface PinnedCli { dir: string; bin: string }
export const CODEX_CLI: PinnedCli = Object.freeze({ dir: "", bin: "codex" });
/** The binary the harness being made runs: the one the adapter checked against the pins when it was made. */
let checked: string | undefined;
/** Make a harness (`make`, which reads the binary once, synchronously) that runs `path`, the binary the adapter checked
 *  against the pins when it was made. CODEX_BIN is read once, there, so a session never runs a binary that was not checked. */
export function withCheckedBinary<T>(path: string, make: () => T): T {
  checked = path;
  try {
    return make();
  } finally {
    checked = undefined;
  }
}
/** The binary to run: the checked one (`withCheckedBinary`). A harness made any other way runs nothing unchecked. */
export const cliPath = (_cli: PinnedCli): string => {
  if (!checked) throw new Error("agentrun-harness-codex: the Codex harness is made through the adapter, which checks its binary against the pins first");
  return checked;
};

/** A sandbox's Files manifest. A local session's files are its workspace, which the host shows itself. */
export const SANDBOX_DOC = Symbol("agentrun.codex.no-sandbox-doc");
export class DriveFiles {
  constructor(_ctx: DriveContext, _machine: SessionMachine, _options: { driveId?: string; log?: unknown } = {}) {}
  changed(_call: { tool: string; callId: string; paths?: readonly string[] }): void {}
  async catchUp(): Promise<void> {}
  async snapshot(_reason?: string): Promise<void> {}
}
