// The session-machine names the copied Codex harness imports, for a local machine. Written for AgentRun.
import type { DriveContext } from "./kernel.js";
import type { AcquireMachine, GatewayHandler, SessionMachine } from "./process.js";
import { codexBinary } from "../binary.js";

/** Acquire the session's machine for this drive, with the model route its proxy serves. */
export async function attachInDrive(ctx: DriveContext, acquire: AcquireMachine, options: { model?: GatewayHandler; deadline?: number } = {}): Promise<SessionMachine> {
  return acquire({ ctx, ...(options.model ? { model: options.model } : {}), ...(options.deadline === undefined ? {} : { deadline: options.deadline }) });
}

/** A local machine shows the model no notes, so there is nothing to acknowledge. */
export async function acknowledgeInDrive(_ctx: DriveContext, _key?: string): Promise<void> {}

/** The pinned Codex binary, as the harness names it. */
export interface PinnedCli { dir: string; bin: string }
export const CODEX_CLI: PinnedCli = Object.freeze({ dir: "", bin: "codex" });
/** The binary to run: CODEX_BIN, else the pinned package's native binary (never a launcher on PATH). */
export const cliPath = (_cli: PinnedCli): string => {
  const found = codexBinary();
  if (!found) throw new Error("agentrun-codex: no Codex binary: install @openai/codex at the pinned version, or set CODEX_BIN");
  return found;
};

/** A sandbox's Files manifest. A local session's files are its workspace, which the host shows itself. */
export const SANDBOX_DOC = Symbol("agentrun.codex.no-sandbox-doc");
export class DriveFiles {
  constructor(_ctx: DriveContext, _machine: SessionMachine, _options: { driveId?: string; log?: unknown } = {}) {}
  changed(_call: { tool: string; callId: string; paths?: readonly string[] }): void {}
  async catchUp(): Promise<void> {}
  async snapshot(_reason?: string): Promise<void> {}
}
