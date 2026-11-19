// Cursor as an AgentRun harness: its recipe (recipes/cursor.json), loaded and typed, and the adapter a host builds from
// it on a pinned install. Written for AgentRun.
//
// What the recipe holds was measured on Cursor 2026.11.13-eacade1 over ACP (harness S0):
//  - `cursor-agent --disable-auto-update acp` in a private HOME, on CURSOR_API_KEY (handed by name at each start, never
//    written anywhere of ours): Cursor's API-key login, the one its docs give for automation;
//  - its config directory is $CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else $HOME/.cursor (its
//    cursor-config/dist/paths.js): the adapter sets XDG_CONFIG_HOME to $HOME/.config, so the config and the sessions
//    are under `$HOME/.config/cursor`, beside auth.json, and a file under ~/.cursor is never read;
//  - `$HOME/.config/cursor/cli-config.json` denies Write(**) and allows nothing: Cursor asks permission (session/request_permission)
//    before a shell command or an MCP call, and the host's gate answers, but it never asks before a file edit, so every
//    edit is denied outright until it does;
//  - our tools as one MCP server over HTTP, given at session/new (no mcp.json of Cursor's own);
//  - its sessions in `$HOME/.config/cursor/acp-sessions`, mirrored so another runner's Cursor loads them (session/load);
//  - the credential it derives from the key, `$HOME/.config/cursor/auth.json`, never mirrored, and its whole HOME removed
//    when its process ends;
//  - its model chosen among those session/new lists for the key (session/set_model), billed to the owner's Cursor plan:
//    no request reaches a proxy of ours, so the run stops at the plan's limits of turns and tool calls;
//  - its team administrator's switch against headless use, said as CURSOR_HEADLESS_DISABLED where Cursor says it.
import { normalize, sep } from "node:path";
import type { AgentAdapter } from "@parcha/agentrun-kernel";
import { acpAdapter, type AcpAdapterOptions } from "./adapter.js";
import { ACP_CODES } from "./facts.js";
import { CURSOR_LIMITS, type CursorLimits } from "./cursor-facts.js";
import { recipeFile } from "./goose.js";
import { type AcpArchivePin, acpPlatform, AcpBinaryRefused, type AcpPlatform, CURSOR_PIN, verifyPinnedBinary, verifyPinnedBinaryAsync, verifyPinnedTree } from "./pinned-binary.js";
import { recipeProblems, type AcpRecipe } from "./recipe.js";

export interface CursorRecipeOptions {
  /** The Cursor launcher (`<install>/dist-package/cursor-agent`), absolute: one that met its pin. */
  command: string;
  /** The run's model, as Cursor lists it for the key (`gpt-5.4-nano`, or `gpt-5.4-nano[reasoning=medium]`). Absent:
   *  Cursor's own default. */
  model?: string;
  /** Where the run stops. Default CURSOR_LIMITS. */
  limits?: CursorLimits;
}

/** Cursor's recipe for one run: its file, with the launcher, the run's model and its limits. Refused when it could not
 *  run. */
export function cursorRecipe(options: CursorRecipeOptions): AcpRecipe {
  const limits = options.limits ?? CURSOR_LIMITS;
  const file = recipeFile("cursor");
  const recipe: AcpRecipe = { ...file, command: options.command, billing: { kind: "plan", maxTurns: limits.maxTurns, maxToolCalls: limits.maxToolCalls }, ...(options.model !== undefined ? { model: options.model } : {}) };
  const problems = recipeProblems(recipe);
  if (problems.length) throw new Error(`acp: the cursor recipe cannot run: ${problems.join("; ")}`);
  return recipe;
}

/** The folder Cursor was installed into, from its launcher's path and the pin's `cmd` (`./dist-package/cursor-agent`). */
export function cursorRootOf(binary: string, cmd: string): string | undefined {
  const tail = normalize(cmd);
  const path = normalize(binary);
  return path.endsWith(`${sep}${tail}`) ? path.slice(0, -(tail.length + 1)) : undefined;
}

export interface CursorAdapterOptions extends Omit<AcpAdapterOptions, "recipe" | "proxy" | "beforeStart">, Omit<CursorRecipeOptions, "command"> {
  /** The Cursor launcher, absolute, inside the folder it was installed into. Its sha256 and the digest of every file of
   *  that folder are checked when the adapter is made and again before every start of a Cursor process, and nothing of
   *  it is run for the check. */
  binary: string;
}

/** Cursor's release pinned for `platform` (default this host's), with its launcher's and its tree's digests; undefined
 *  where none is pinned (CURSOR_PIN pins linux-x86_64 alone), where Cursor is refused ACP_BINARY_UNPINNED before any file
 *  of it is read. The one test of whether Cursor runs on a platform: the adapter's, serve's and their tests'. */
export function cursorRelease(platform: string | undefined = acpPlatform()): CursorRelease | undefined {
  const release = platform ? CURSOR_PIN.archives[platform as AcpPlatform] : undefined;
  return release?.binarySha256 && release.treeSha256 ? (release as CursorRelease) : undefined;
}

/** A pinned Cursor release: its archive, with its launcher's sha256 and its tree's digest. */
export type CursorRelease = AcpArchivePin & { readonly binarySha256: string; readonly treeSha256: string };

/** Cursor as a harness adapter (id `cursor`): its pinned install checked, its recipe for the run's model and limits. */
export function cursorAdapter(options: CursorAdapterOptions): AgentAdapter {
  const { binary, model, limits, ...rest } = options;
  const platform = acpPlatform();
  const release = cursorRelease(platform);
  if (!release) throw new AcpBinaryRefused(ACP_CODES.binaryUnpinned, `no digest is pinned for Cursor ${CURSOR_PIN.version} on ${platform ?? `${process.platform}-${process.arch}`}`);
  const root = cursorRootOf(binary, release.cmd);
  if (!root) throw new AcpBinaryRefused(ACP_CODES.binaryMismatch, `the Cursor launcher at ${binary} is not at its pinned path ${release.cmd} inside its folder`);
  const launcher = release.binarySha256;
  const tree = release.treeSha256;
  verifyPinnedBinary(binary, launcher);
  return acpAdapter({
    ...rest,
    recipe: cursorRecipe({ command: binary, ...(model !== undefined ? { model } : {}), ...(limits ? { limits } : {}) }),
    // Checked again before each process starts, the launcher and every file it runs: a file replaced since the adapter
    // was made never runs unchecked. An unchanged file is not hashed again (the check remembers it by its identity).
    beforeStart: async (command) => {
      await verifyPinnedBinaryAsync(command, launcher);
      await verifyPinnedTree(root, tree);
    },
  });
}
