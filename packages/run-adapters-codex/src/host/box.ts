// Codex's own sandbox and the host's box, written for AgentRun: the rule the copied harness takes its sandbox mode from
// (src/harness.ts calls it where upstream ran its bubblewrap self-test, which it no longer calls). Kept here, outside the
// copy, so the copy stays close to upstream.
import type { Isolation } from "@parcha/agentrun-kernel/host";
import { Unavailable } from "./kernel.js";
import type { CodexHarnessOptions } from "../harness.js";

/**
 * Codex's sandbox for its commands, from what the host's box proved, never
 * from a probe. In the host's box (the kernel's: its own pid, mount and
 * network namespaces) Codex's own sandbox is off, since the box is the
 * boundary and nothing in it may make another namespace; another mode is
 * refused there. Where the operator said `unsandboxed`, it is the session's
 * `sandboxMode` (default `danger-full-access`), said in the log. Anywhere
 * else the turn fails with an `Unavailable` that names why.
 */
export function codexSandboxMode(isolation: Isolation | undefined, asked: CodexHarnessOptions['sandboxMode'], log: (message: string, fields?: Record<string, unknown>) => void): NonNullable<CodexHarnessOptions['sandboxMode']> {
  if (isolation?.mode === 'bwrap' || isolation?.mode === 'seatbelt' || isolation?.mode === 'provider') {
    if (asked !== undefined && asked !== 'danger-full-access') {
      throw new Unavailable(`agentrun-harness-codex: Codex's own sandbox (${asked}) cannot start inside the host's box, which is the boundary: leave sandboxMode unset`, { code: 'box_nested' });
    }
    return 'danger-full-access';
  }
  if (isolation?.mode === 'unsandboxed') {
    log("codex: unsandboxed: Codex's own tools run with no box, on the operator's setting", { sandboxMode: asked ?? 'danger-full-access' });
    return asked ?? 'danger-full-access';
  }
  const why = isolation?.mode === 'unavailable' ? `its box is unavailable (${isolation.error}: ${isolation.detail})` : 'the host gave this machine no box';
  throw new Unavailable(`agentrun-harness-codex: Codex's own tools run only in the host's box, and ${why}: this turn ends`, {
    code: 'box_unavailable',
    hint: "Install the host's box once (agentrun-box install, as root), give the machine a box, or turn Codex's own tools off (builtins: false).",
  });
}

