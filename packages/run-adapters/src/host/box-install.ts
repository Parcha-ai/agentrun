// The one root step the box needs on a host that restricts unprivileged user namespaces through AppArmor (Ubuntu
// 24.04 and later: kernel.apparmor_restrict_unprivileged_userns = 1): a profile that lets /usr/bin/bwrap make them.
// Written for AgentRun.
//
// An OPERATOR runs it once, as root, on the host that runs serve: `agentrun-box install`. A container cannot load a
// profile into its host's kernel, so an image never runs it; there, the box's start probe decides, and a host that
// does not allow it gets the named error, never a quiet run without the box.
//
// What it changes, plainly: with the profile loaded, every local user of the host can make an unprivileged user namespace
// through /usr/bin/bwrap. That is Ubuntu's documented route for bwrap, and what most distributions allow by default.
// It never makes bwrap setuid, and it refuses a bwrap that is setuid or not root's own 0755: a box never relies on one.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { BWRAP } from "./box-bwrap.js";

export const APPARMOR_PROFILE = "/etc/apparmor.d/agentrun-bwrap";
const RESTRICT = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** The profile, for /usr/bin/bwrap: unconfined, plus the userns permission the restriction withholds. */
export function profileText(bwrap = BWRAP): string {
  return ["abi <abi/4.0>,", "include <tunables/global>", "", `profile agentrun-bwrap ${bwrap} flags=(unconfined) {`, "  userns,", "}", ""].join("\n");
}

export interface InstallOptions {
  bwrap?: string;
  profile?: string;
  /** apparmor_parser's path. */
  parser?: string;
  /** For tests: the effective uid, the stat of bwrap, whether the host restricts user namespaces, and the parser's run. */
  euid?: number;
  stat?: (path: string) => { uid: number; mode: number };
  restricted?: () => boolean;
  run?: (command: string, args: string[]) => { status: number | null; stderr: string };
}

export type InstallResult =
  | { status: "installed"; profile: string; written: boolean }
  | { status: "not_needed"; detail: string };

/** A refusal or failure of the install, with what to do. */
export class BoxInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxInstallError";
  }
}

/** Installs and loads the profile: idempotent (the same content is not rewritten, and it is loaded either way). */
export function installBox(options: InstallOptions = {}): InstallResult {
  const bwrap = options.bwrap ?? BWRAP;
  const profile = options.profile ?? APPARMOR_PROFILE;
  const euid = options.euid ?? process.geteuid?.() ?? -1;
  if (euid !== 0) throw new BoxInstallError("agentrun-box install runs as root, once, on the host that runs serve (not in a container)");
  let s: { uid: number; mode: number };
  try {
    s = (options.stat ?? statSync)(bwrap);
  } catch {
    throw new BoxInstallError(`${bwrap} is not installed: install bubblewrap from the distribution first`);
  }
  if (s.mode & 0o4000) throw new BoxInstallError(`${bwrap} is setuid: refused. A box never relies on a setuid bwrap; install the distribution's package, which is not setuid`);
  if (s.uid !== 0) throw new BoxInstallError(`${bwrap} is not owned by root: refused`);
  if ((s.mode & 0o7777) !== 0o755) throw new BoxInstallError(`${bwrap} is mode ${(s.mode & 0o7777).toString(8)}, not 0755: refused`);
  const restricted = options.restricted ?? (() => existsSync(RESTRICT) && readFileSync(RESTRICT, "utf8").trim() === "1");
  if (!restricted()) return { status: "not_needed", detail: "this host does not restrict unprivileged user namespaces through AppArmor; bwrap needs no profile" };
  const text = profileText(bwrap);
  let written = false;
  const current = existsSync(profile) ? readFileSync(profile, "utf8") : undefined;
  if (current !== text) {
    writeFileSync(`${profile}.tmp`, text, { mode: 0o644 });
    chmodSync(`${profile}.tmp`, 0o644); // whatever the operator's umask
    renameSync(`${profile}.tmp`, profile);
    written = true;
  }
  const run = options.run ?? ((command: string, args: string[]) => {
    const r = spawnSync(command, args, { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr ?? String(r.error ?? "") };
  });
  const loaded = run(options.parser ?? "apparmor_parser", ["-r", profile]);
  if (loaded.status !== 0) throw new BoxInstallError(`apparmor_parser -r ${profile} failed: ${loaded.stderr.trim().slice(0, 300)}`);
  return { status: "installed", profile, written };
}
