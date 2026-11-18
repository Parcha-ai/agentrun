// Goose on this server: where its owner installs it (`<data>/harnesses/goose/goose`, by `agentrun harness install goose`,
// harness-archive.ts), the command that does, and whether the binary there is the pinned one. Nothing here downloads:
// a run, a save and the start's probe only look at what is installed, and say the command where it is not.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AcpPackage, acpPackage } from "./acp-package.js";
import { type ArchiveInstallOptions, installArchive } from "./harness-archive.js";
import { installDirOf, shellWord } from "./harness-install.js";
import { DATA_ENV, defaultData } from "./server-fs.js";

export const GOOSE_ID = "goose";

/** Why Goose does not run here: a code (HARNESS_NOT_INSTALLED, ACP_BINARY_MISMATCH, ACP_BINARY_UNPINNED, ...) and words
 *  that start with it and end with the command that installs it. */
export type GooseMissing = { readonly code: string; readonly message: string };

/** The data directory `env` names (the server's own, else the default one). */
const dataOf = (env: NodeJS.ProcessEnv): string => env[DATA_ENV] || defaultData(env);

/** Goose's folder in `data`, and its binary there. */
export const gooseDirOf = (data: string): string => installDirOf(data, GOOSE_ID);
export const gooseBinaryOf = (data: string): string => join(gooseDirOf(data), GOOSE_ID);

/** The agentrun command's own data directory, where `npx @parcha/agentrun` keeps its server's store (~/.agentrun: not the
 *  server's own default, defaultData), and so where `agentrun harness install` installs with no --data. */
export const commandData = (env: NodeJS.ProcessEnv): string => join(env.HOME || homedir(), ".agentrun");

/** The command that installs Goose into `data`: naming it with --data unless it is the agentrun command's own (commandData). */
export function gooseInstallLine(acp: AcpPackage, data: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(data) === commandData(env) ? acp.GOOSE_INSTALL : `${acp.GOOSE_INSTALL} --data ${shellWord(data)}`;
}

/** What is known of Goose in `env`'s data before its binary is read: why it is missing, or the binary and the digest it
 *  must have, with how a refused check is said. */
function lookup(env: NodeJS.ProcessEnv): { missing: GooseMissing } | { acp: AcpPackage; binary: string; sha256: string; refused(error: unknown): GooseMissing } {
  const acp = acpPackage();
  if (!acp) return { missing: { code: "HARNESS_NOT_INSTALLED", message: "HARNESS_NOT_INSTALLED: Goose's adapter (@parcha/agentrun-harness-acp) is not installed beside this server" } };
  const data = dataOf(env);
  const binary = gooseBinaryOf(data);
  const line = gooseInstallLine(acp, data, env);
  const { version, archives } = acp.GOOSE_PIN;
  const platform = acp.acpPlatform();
  const sha256 = platform ? archives[platform]?.binarySha256 : undefined;
  if (!sha256) return { missing: { code: "ACP_BINARY_UNPINNED", message: `ACP_BINARY_UNPINNED: Goose ${version} has no binary pinned for ${platform ?? `${process.platform}-${process.arch}`}, so it does not run here` } };
  if (!existsSync(binary)) return { missing: { code: acp.GOOSE_NOT_INSTALLED, message: `${acp.GOOSE_NOT_INSTALLED}: Goose ${version} is not installed in ${gooseDirOf(data)}. Install it with: ${line}` } };
  return {
    acp, binary, sha256,
    refused: (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      return { code: typeof code === "string" ? code : acp.GOOSE_NOT_INSTALLED, message: `${(error as Error).message}. Install Goose ${version} again with: ${line}` };
    },
  };
}

/** Why Goose is not listed here (HarnessEntry.hidden): not installed, or not the pinned binary, in words that end with what
 *  to do, restarting AgentRun included (its harnesses are read at its start). Undefined once it is installed and verified.
 *  The binary's sha256 is kept once per file identity (the package's check), so only the first look reads it. */
export function gooseHidden(env: NodeJS.ProcessEnv): string | undefined {
  const found = lookup(env);
  let missing: GooseMissing | undefined;
  if ("missing" in found) missing = found.missing;
  else {
    try {
      found.acp.verifyPinnedBinary(found.binary, found.sha256);
    } catch (error) {
      missing = found.refused(error);
    }
  }
  return missing && `${missing.message}; then restart AgentRun.`;
}

/** Why Goose cannot run here, its binary checked off the event loop; undefined when it can (with the binary to run). */
export async function gooseMissing(env: NodeJS.ProcessEnv): Promise<{ missing: GooseMissing } | { binary: string; sha256: string }> {
  const found = lookup(env);
  if ("missing" in found) return found;
  try {
    await found.acp.verifyPinnedBinaryAsync(found.binary, found.sha256);
  } catch (error) {
    return { missing: found.refused(error) };
  }
  return { binary: found.binary, sha256: found.sha256 };
}

/** Installs the pinned Goose into `data` (agentrun-serve install-harness goose). */
export async function installGoose(data: string, options: ArchiveInstallOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  const acp = acpPackage();
  if (!acp) throw new Error("Goose's adapter (@parcha/agentrun-harness-acp) is not installed beside this server, so it has no pin to install from");
  const { id, version, archives } = acp.GOOSE_PIN;
  const platform = acp.acpPlatform();
  return { version, ...(await installArchive({ id, label: "Goose", retry: gooseInstallLine(acp, data, env), pin: { version, archives } }, gooseDirOf(data), { ...(platform ? { platform } : {}), ...options })) };
}
