// Cursor on this server: where its owner installs it (`<data>/harnesses/cursor`, by `agentrun harness install cursor`,
// harness-archive.ts), the command that does, whether what is there is the pinned release (its launcher and every file
// beside it), the key it runs on (CURSOR_API_KEY, the owner's), the limits a run of it stops at and the card its owner
// reads. Nothing here downloads: a run, a save and the start's probe only look at what is installed, and say the command
// where it is not. Cursor's model is Cursor's, billed to the owner's Cursor plan: no request of it reaches a proxy of ours.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AcpPackage, acpPackage } from "./acp-package.js";
import { commandData } from "./harness-goose.js";
import { type ArchiveInstallOptions, installArchive } from "./harness-archive.js";
import { installDirOf, shellWord } from "./harness-install.js";
import { DATA_ENV, defaultData } from "./server-fs.js";

export const CURSOR_ID = "cursor";
/** The key Cursor runs on: the owner's Cursor API key, read by name, handed to Cursor's runs and no other. */
export const CURSOR_KEY = "CURSOR_API_KEY";
/** The owner's limits for a run of Cursor (CURSOR_LIMITS, the package's, by default): its turns and its tool calls. */
export const CURSOR_MAX_TURNS_ENV = "AGENTRUN_CURSOR_MAX_TURNS";
export const CURSOR_MAX_TOOL_CALLS_ENV = "AGENTRUN_CURSOR_MAX_TOOL_CALLS";
/** The provider a Cursor model is named under (`cursor/<model>`, `cursor/default` for Cursor's own default). */
export const CURSOR_PROVIDER = "cursor";
export const CURSOR_DEFAULT_MODEL = "default";

/** Why Cursor does not run here: a code and words that start with it and end with what to do. */
export type CursorMissing = { readonly code: string; readonly message: string };

const dataOf = (env: NodeJS.ProcessEnv): string => env[DATA_ENV] || defaultData(env);

/** Cursor's folder in `data`. Its launcher is at the pin's `cmd` inside it (`./dist-package/cursor-agent`). */
export const cursorDirOf = (data: string): string => installDirOf(data, CURSOR_ID);

/** The command that installs Cursor into `data`: naming it with --data unless it is the agentrun command's own. */
export function cursorInstallLine(acp: AcpPackage, data: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(data) === commandData(env) ? acp.CURSOR_INSTALL : `${acp.CURSOR_INSTALL} --data ${shellWord(data)}`;
}

/** The limits a run of Cursor stops at on `env`: the owner's (CURSOR_MAX_TURNS_ENV, CURSOR_MAX_TOOL_CALLS_ENV), else the
 *  package's. A setting that is no whole number is refused by name. */
export function cursorLimitsOf(acp: AcpPackage, env: NodeJS.ProcessEnv): { maxTurns: number; maxToolCalls: number } {
  const read = (name: string, fallback: number, least: number): number => {
    const given = env[name];
    if (given === undefined || given === "") return fallback;
    const n = Number(given);
    if (!/^\d+$/.test(given.trim()) || !Number.isSafeInteger(n) || n < least) throw new Error(`${name} is ${JSON.stringify(given)}: set it to a whole number of at least ${least}, or unset it for ${fallback}`);
    return n;
  };
  return { maxTurns: read(CURSOR_MAX_TURNS_ENV, acp.CURSOR_LIMITS.maxTurns, 1), maxToolCalls: read(CURSOR_MAX_TOOL_CALLS_ENV, acp.CURSOR_LIMITS.maxToolCalls, 0) };
}

/** The card Cursor's owner reads (capabilities' harness `card`), with this server's limits; none where Cursor's adapter is
 *  not beside the server, or its limits are set wrong (its refusal says so). */
export function cursorCardOf(env: NodeJS.ProcessEnv): string | undefined {
  const acp = acpPackage();
  if (!acp) return undefined;
  try {
    return acp.cursorCard(cursorLimitsOf(acp, env));
  } catch {
    return undefined;
  }
}

type Found = { acp: AcpPackage; binary: string; root: string; launcher: string; tree: string; refused(error: unknown): CursorMissing };

/** What is known of Cursor in `env`'s data before its files are read: why it is missing, or its launcher, its folder and
 *  the digests they must have, with how a refused check is said. */
function lookup(env: NodeJS.ProcessEnv): { missing: CursorMissing } | Found {
  const acp = acpPackage();
  if (!acp) return { missing: { code: "HARNESS_NOT_INSTALLED", message: "HARNESS_NOT_INSTALLED: Cursor's adapter (@parcha/agentrun-harness-acp) is not installed beside this server" } };
  const data = dataOf(env);
  const root = cursorDirOf(data);
  const line = cursorInstallLine(acp, data, env);
  const { version } = acp.CURSOR_PIN;
  const platform = acp.acpPlatform();
  const release = acp.cursorRelease(platform);
  if (!release) return { missing: { code: "ACP_BINARY_UNPINNED", message: `ACP_BINARY_UNPINNED: Cursor ${version} has no release pinned for ${platform ?? `${process.platform}-${process.arch}`}, so it does not run here` } };
  const binary = join(root, release.cmd);
  if (!existsSync(binary)) return { missing: { code: acp.CURSOR_CODES.notInstalled, message: `${acp.CURSOR_CODES.notInstalled}: Cursor ${version} is not installed in ${root}. Install it with: ${line}` } };
  return {
    acp, binary, root, launcher: release.binarySha256, tree: release.treeSha256,
    refused: (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      return { code: typeof code === "string" ? code : acp.CURSOR_CODES.notInstalled, message: `${(error as Error).message}. Install Cursor ${version} again with: ${line}` };
    },
  };
}

/** Why Cursor is not listed here (HarnessEntry.hidden): not installed, or its launcher not the pinned one, in words that end
 *  with what to do, restarting AgentRun included. Undefined once it is installed. The files beside the launcher are
 *  checked off the event loop, by cursorMissing at each run and the start's probe. */
export function cursorHidden(env: NodeJS.ProcessEnv): string | undefined {
  const found = lookup(env);
  let missing: CursorMissing | undefined;
  if ("missing" in found) missing = found.missing;
  else {
    try {
      found.acp.verifyPinnedBinary(found.binary, found.launcher);
    } catch (error) {
      missing = found.refused(error);
    }
  }
  return missing && `${missing.message}; then restart AgentRun.`;
}

/** Why Cursor cannot run here, its launcher and every file beside it checked off the event loop; else its launcher. */
export async function cursorMissing(env: NodeJS.ProcessEnv): Promise<{ missing: CursorMissing } | { binary: string }> {
  const found = lookup(env);
  if ("missing" in found) return found;
  try {
    await found.acp.verifyPinnedBinaryAsync(found.binary, found.launcher);
    await found.acp.verifyPinnedTree(found.root, found.tree);
  } catch (error) {
    return { missing: found.refused(error) };
  }
  return { binary: found.binary };
}

/** Installs the pinned Cursor into `data` (agentrun-serve install-harness cursor). */
export async function installCursor(data: string, options: ArchiveInstallOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  const acp = acpPackage();
  if (!acp) throw new Error("Cursor's adapter (@parcha/agentrun-harness-acp) is not installed beside this server, so it has no pin to install from");
  const { id, version, archives } = acp.CURSOR_PIN;
  const platform = acp.acpPlatform();
  return { version, ...(await installArchive({ id, label: "Cursor", retry: cursorInstallLine(acp, data, env), pin: { version, archives }, tree: (root) => acp.treeDigest(root) }, cursorDirOf(data), { ...(platform ? { platform } : {}), ...options })) };
}
