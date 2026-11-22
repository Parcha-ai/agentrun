// A harness its owner installs from a pinned archive (`agentrun harness install <id>`, harness-archive.ts): Goose and
// Cursor, from the ACP package's pins. One shape for each: where it is installed, the command that installs it, why it
// is not listed or cannot run, and its install. Nothing here downloads: a run, a save and the start's probe only look at
// what is installed, and say the command where it is not.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AcpPackage, type AcpPin, acpPackage } from "./acp-package.js";
import { type ArchiveInstallOptions, installArchive } from "./harness-archive.js";
import { installDirOf, shellWord } from "./harness-install.js";
import { DATA_ENV, defaultData } from "./server-fs.js";

/** Why an owner-installed harness does not run here: a code (HARNESS_NOT_INSTALLED, ACP_BINARY_MISMATCH,
 *  ACP_BINARY_UNPINNED, ...) and words that start with it and end with what to do. */
export type OwnerMissing = { readonly code: string; readonly message: string };

/** The agentrun command's own data directory, where `npx @parcha/agentrun` keeps its server's store (~/.agentrun: not the
 *  server's own default, defaultData), and so where `agentrun harness install` installs with no --data. */
export const commandData = (env: NodeJS.ProcessEnv): string => join(env.HOME || homedir(), ".agentrun");

/** What an owner-installed harness is, from the ACP package: its pin, the command that installs it and the code a
 *  missing install is refused by. `tree`: its release is pinned by the digest of every file it unpacks to, its launcher
 *  among them (Cursor's), not by its binary alone (Goose's). */
export interface OwnerInstalledSpec {
  readonly id: string;
  readonly label: string;
  readonly pin: (acp: AcpPackage) => AcpPin;
  readonly installLine: (acp: AcpPackage) => string;
  readonly notInstalled: (acp: AcpPackage) => string;
  readonly tree?: boolean;
}

/** An owner-installed harness on this server. */
export interface OwnerInstalled {
  readonly id: string;
  readonly label: string;
  /** What the install's last step checks, as the installer says it. */
  readonly verified: string;
  /** Its folder in `data`. */
  dirOf(data: string): string;
  /** The command that installs it into `data`: naming it with --data unless it is the agentrun command's own. */
  installLine(acp: AcpPackage, data: string, env?: NodeJS.ProcessEnv): string;
  /** Why it is not listed here (HarnessEntry.hidden): not installed, or its binary not the pinned one, in words that end
   *  with what to do, restarting AgentRun included (its harnesses are read at its start). Undefined once it is. The
   *  binary's sha256 is kept once per file identity (the package's check), so only the first look reads it; a tree is
   *  checked off the event loop, by `missing` at each run and the start's probe. */
  hidden(env: NodeJS.ProcessEnv): string | undefined;
  /** Why it cannot run here, its binary (or every file of its tree) checked off the event loop; else its binary, with the
   *  binary's pinned sha256. */
  missing(env: NodeJS.ProcessEnv): Promise<{ missing: OwnerMissing } | { binary: string; sha256: string }>;
  /** Installs its pinned release into `data` (agentrun-serve install-harness <id>). */
  install(data: string, options?: ArchiveInstallOptions, env?: NodeJS.ProcessEnv): Promise<{ version: string } & Awaited<ReturnType<typeof installArchive>>>;
}

/** The data directory `env` names (the server's own, else the default one). */
const dataOf = (env: NodeJS.ProcessEnv): string => env[DATA_ENV] || defaultData(env);

/** `spec`'s harness on this server. */
export function ownerInstalled(spec: OwnerInstalledSpec): OwnerInstalled {
  const { id, label, tree = false } = spec;
  const dirOf = (data: string): string => installDirOf(data, id);
  const installLine = (acp: AcpPackage, data: string, env: NodeJS.ProcessEnv = process.env): string =>
    resolve(data) === commandData(env) ? spec.installLine(acp) : `${spec.installLine(acp)} --data ${shellWord(data)}`;

  type Found = { acp: AcpPackage; binary: string; root: string; sha256: string; treeSha256?: string; refused(error: unknown): OwnerMissing };
  /** What is known of it in `env`'s data before its files are read: why it is missing, or its binary, its folder and the
   *  digests they must have, with how a refused check is said. */
  const lookup = (env: NodeJS.ProcessEnv): { missing: OwnerMissing } | Found => {
    const acp = acpPackage();
    // No package, so no code of its own: the server's own for a harness that is not installed.
    if (!acp) return { missing: { code: "HARNESS_NOT_INSTALLED", message: `HARNESS_NOT_INSTALLED: ${label}'s adapter (@parcha/agentrun-harness-acp) is not installed beside this server` } };
    const data = dataOf(env);
    const root = dirOf(data);
    const line = installLine(acp, data, env);
    const { version } = spec.pin(acp);
    const notInstalled = spec.notInstalled(acp);
    const platform = acp.acpPlatform();
    const release = acp.pinnedRelease(spec.pin(acp), platform, tree);
    if (!release) return { missing: { code: "ACP_BINARY_UNPINNED", message: `ACP_BINARY_UNPINNED: ${label} ${version} has no release pinned for ${platform ?? `${process.platform}-${process.arch}`}, so it does not run here` } };
    const binary = join(root, release.cmd);
    if (!existsSync(binary)) return { missing: { code: notInstalled, message: `${notInstalled}: ${label} ${version} is not installed in ${root}. Install it with: ${line}` } };
    return {
      acp, binary, root, sha256: release.binarySha256, ...(tree && release.treeSha256 ? { treeSha256: release.treeSha256 } : {}),
      refused: (error) => {
        const code = (error as { code?: unknown } | null)?.code;
        return { code: typeof code === "string" ? code : notInstalled, message: `${(error as Error).message}. Install ${label} ${version} again with: ${line}` };
      },
    };
  };

  return {
    id, label, dirOf, installLine,
    verified: tree ? "its launcher's sha256 and every file's tree digest match the pin" : "the binary's sha256 matches the pin",
    hidden: (env) => {
      const found = lookup(env);
      let missing: OwnerMissing | undefined;
      if ("missing" in found) missing = found.missing;
      else {
        try {
          found.acp.verifyPinnedBinary(found.binary, found.sha256);
        } catch (error) {
          missing = found.refused(error);
        }
      }
      return missing && `${missing.message}; then restart AgentRun.`;
    },
    missing: async (env) => {
      const found = lookup(env);
      if ("missing" in found) return found;
      try {
        // A tree's digest covers its launcher: its own check is the binary's alone.
        if (found.treeSha256) await found.acp.verifyPinnedTree(found.root, found.treeSha256);
        else await found.acp.verifyPinnedBinaryAsync(found.binary, found.sha256);
      } catch (error) {
        return { missing: found.refused(error) };
      }
      return { binary: found.binary, sha256: found.sha256 };
    },
    install: async (data, options = {}, env = process.env) => {
      const acp = acpPackage();
      if (!acp) throw new Error(`${label}'s adapter (@parcha/agentrun-harness-acp) is not installed beside this server, so it has no pin to install from`);
      const { version, archives } = spec.pin(acp);
      const platform = acp.acpPlatform();
      return { version, ...(await installArchive({ id, label, retry: installLine(acp, data, env), pin: { version, archives }, ...(tree ? { tree: (root: string) => acp.treeDigest(root) } : {}) }, dirOf(data), { ...(platform ? { platform } : {}), ...options })) };
    },
  };
}
