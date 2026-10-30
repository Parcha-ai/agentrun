// Where this server's runs would run their harnesses' own tools: the operator's settings, read once at start, and what
// the box's probe proved. Capabilities say it (`box`), truthfully: the mode is what runs, never what was hoped. A box
// that is missing, or whose probe fails, reads as `unavailable` with a named error, and native tools stay off. No box
// at all is only `AGENTRUN_BOX=unsandboxed`, the operator's word, and it is loud: a banner at start, a line in each
// run's log, and the mode in each run's record.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Box, BoxErrorCode, Isolation } from "@parcha/agentrun-kernel/host";

/** The box providers an operator may name (AGENTRUN_BOX). */
export const BOX_PROVIDERS = ["local", "unsandboxed", "daytona", "modal"] as const;
export type BoxProvider = (typeof BOX_PROVIDERS)[number];

/** Where a box's process may reach on the network (AGENTRUN_BOX_EGRESS): only the open internet today. */
export const BOX_EGRESS = ["open"] as const;
export type BoxEgress = (typeof BOX_EGRESS)[number];

/** The operator's box settings, resolved. `cgroup`: the delegated cgroup v2 subtree of a shared server, if named. */
export type BoxConfig = { provider: BoxProvider; egress: BoxEgress; cgroup?: string };

/** What capabilities say of the box (a serve extension, box/1). `error` and `detail` only when the mode is
 *  `unavailable`: a stable code, and words a person can act on (no host path, user or address). */
export type BoxView = { mode: Isolation["mode"]; cgroup: boolean; egress: BoxEgress; error?: BoxErrorCode; detail?: string };

/** The errors a box can be unavailable with, as capabilities name them: stable codes a client keys on. */
export const BOX_UNAVAILABLE = ["bwrap_missing", "bwrap_setuid", "bwrap_userns_denied", "box_probe_failed", "box_refused", "box_start_failed"] as const satisfies readonly BoxErrorCode[];

/** What each code tells the operator to do. Fixed words, never a probe's own message: no path, user or address. */
const DETAIL: Record<(typeof BOX_UNAVAILABLE)[number], string> = {
  bwrap_missing: "bubblewrap (bwrap) is not installed on this host; install it, then restart the server.",
  bwrap_setuid: "bwrap is installed setuid, which this server refuses; install it as a plain root-owned program, then restart the server.",
  bwrap_userns_denied: "bwrap could not set up its user namespace on this host; run `agentrun-box install` once as root, then restart the server.",
  box_probe_failed: "the box's start-up check did not pass, so runs get no tools of their harness's own; see the server's log.",
  box_refused: "the box's command was refused before it ran; see the server's log.",
  box_start_failed: "the box could not be started; see the server's log.",
};

/** What capabilities say when nothing has resolved the box: unavailable, as a server with no box is. */
export const NO_BOX: BoxView = { mode: "unavailable", cgroup: false, egress: "open", error: "box_probe_failed", detail: "the box's start-up check did not pass, so runs get no tools of their harness's own; see the server's log." };

/** A box setting that is not one this server knows, refused at start by its name. */
export class BoxSettingError extends Error {}

/** The operator's settings from `env`, or a refusal naming the setting and the values it takes. */
export function boxConfig(env: NodeJS.ProcessEnv): BoxConfig {
  const provider = env.AGENTRUN_BOX || "local";
  if (!(BOX_PROVIDERS as readonly string[]).includes(provider)) throw new BoxSettingError(`AGENTRUN_BOX is ${JSON.stringify(provider)}; it takes ${BOX_PROVIDERS.join(", ")}`);
  const egress = env.AGENTRUN_BOX_EGRESS || "open";
  if (!(BOX_EGRESS as readonly string[]).includes(egress)) throw new BoxSettingError(`AGENTRUN_BOX_EGRESS is ${JSON.stringify(egress)}; it takes ${BOX_EGRESS.join(", ")}`);
  return { provider: provider as BoxProvider, egress: egress as BoxEgress, ...(env.AGENTRUN_BOX_CGROUP ? { cgroup: env.AGENTRUN_BOX_CGROUP } : {}) };
}

/** Whether `path` is a cgroup v2 subtree delegated to this server's user: a directory it owns, whose cgroup.procs and
 *  cgroup.subtree_control it may write. Why not, else. */
export async function cgroupDelegation(path: string, uid = process.getuid?.() ?? -1): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) return "it is not a directory";
  if (info.uid !== uid) return "it is not owned by this server's user";
  for (const file of ["cgroup.procs", "cgroup.subtree_control"]) {
    if (await access(join(path, file), constants.W_OK).then(() => false, () => true)) return `its ${file} is not writable by this server's user`;
  }
  return undefined;
}

/** How the host's box is made: the kernel's box for these settings (4a's bwrapBox, or a provider's). Its isolation is
 *  what its probe proved. */
export type BoxFactory = (config: BoxConfig) => Promise<Box>;

/** The box this server runs with, and what capabilities say of it. Unsandboxed: no box and no probe. Otherwise the
 *  factory's box, its isolation as proved; no factory, a factory that throws, or a probe that failed, `unavailable`. */
export async function resolveBox(config: BoxConfig, factory: BoxFactory | undefined, delegated: boolean): Promise<{ box?: Box; view: BoxView }> {
  const unavailable = (error: (typeof BOX_UNAVAILABLE)[number]): { view: BoxView } => ({ view: { mode: "unavailable", cgroup: false, egress: config.egress, error, detail: DETAIL[error] } });
  if (config.provider === "unsandboxed") return { view: { mode: "unsandboxed", cgroup: false, egress: config.egress } };
  if (!factory) return unavailable("box_probe_failed");
  let box: Box;
  try {
    box = await factory(config);
  } catch {
    return unavailable("box_probe_failed");
  }
  const isolation = box.isolation;
  if (isolation.mode === "unavailable") return unavailable((BOX_UNAVAILABLE as readonly string[]).includes(isolation.error) ? (isolation.error as (typeof BOX_UNAVAILABLE)[number]) : "box_probe_failed");
  // A box can only claim what it is: its own word for bwrap, seatbelt or a provider; never unsandboxed (only the setting).
  if (isolation.mode === "unsandboxed") return unavailable("box_probe_failed");
  return { box, view: { mode: isolation.mode, cgroup: isolation.cgroup && delegated, egress: config.egress } };
}

/** The banner an unsandboxed server prints at start, one block. */
export const UNSANDBOXED_BANNER = [
  "agentrun-serve: AGENTRUN_BOX=unsandboxed. Runs' harness tools run with NO box, as this server's own user:",
  "agentrun-serve: they can read and change anything this user can. Use it only on a machine that is itself the boundary.",
].join("\n");

/** The line at the start of each unsandboxed run's log. */
export const UNSANDBOXED_RUN_LINE = "agentrun-serve: this run has no box (AGENTRUN_BOX=unsandboxed): its harness's tools run as the server's own user.";
