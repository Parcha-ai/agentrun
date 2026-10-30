// Whether a run gets its harness's own tools (its shell, its file tools): the one place serve decides it, for
// capabilities and for the run's process alike. Only in a box, since otherwise they would run as serve's own user:
// a box whose probe passed (bwrap, seatbelt or a provider's). `unsandboxed` is the operator's word that there is no box,
// and it keeps them off until that is decided otherwise (UNSANDBOXED_NATIVE_TOOLS). Only on a harness whose adapter
// serve can turn them on for: claude-agent's takes `builtins`; Codex's has none yet, and pi's tools are pi's own.
import type { Workspace } from "./run-workspace.js";

/** Whether `AGENTRUN_BOX=unsandboxed` turns the harness's own tools on as well: off. The banner and each run's log line
 *  already say the run has no box (config.ts). */
export const UNSANDBOXED_NATIVE_TOOLS = false;

/** The harnesses whose adapter serve turns its own tools on for. */
const NATIVE_HARNESSES: ReadonlySet<string> = new Set(["claude-agent"]);

/** A box mode the probe proved. */
const BOXED: ReadonlySet<string> = new Set(["bwrap", "seatbelt", "provider"]);

/**
 * Whether a run of `harness` gets its harness's own tools, in a server whose box is `mode`. A run also needs its one
 * workspace to be the one its box is lent (`harness/work`): a run started before that keeps work/, where the harness's
 * tools would write a second tree, so its tools stay off. Capabilities ask with no workspace: a new run's.
 */
export function nativeTools(harness: string, mode: string | undefined, workspace: Workspace = "harness/work"): boolean {
  if (!NATIVE_HARNESSES.has(harness) || workspace !== "harness/work") return false;
  return mode !== undefined && (BOXED.has(mode) || (mode === "unsandboxed" && UNSANDBOXED_NATIVE_TOOLS));
}
