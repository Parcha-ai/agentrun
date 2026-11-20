// Cursor as an AgentRun harness: its recipe (recipes/cursor.json), loaded and typed, and the adapter a host builds from
// it on a pinned install. Written for AgentRun.
//
// Cursor's config directory is $CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else $HOME/.cursor (its
// cursor-config/dist/paths.js, Cursor 2026.11.13-eacade1): the adapter sets XDG_CONFIG_HOME to $HOME/.config, so the
// recipe's config and sessions are under `$HOME/.config/cursor`, and a file under ~/.cursor is never read.
import { normalize, sep } from "node:path";
import type { AgentAdapter } from "@parcha/agentrun-kernel";
import { acpAdapter, type AcpAdapterOptions } from "./adapter.js";
import { ACP_CODES } from "./facts.js";
import { CURSOR_LIMITS, type CursorLimits } from "./cursor-facts.js";
import { recipeFile } from "./goose.js";
import { acpPlatform, AcpBinaryRefused, CURSOR_PIN, pinnedRelease, type PinnedRelease, unpinned, verifyPinnedBinary, verifyPinnedTree } from "./pinned-binary.js";
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
 *  of it is read: pinnedRelease's tree test on CURSOR_PIN, the one the adapter, serve and their tests make. */
export const cursorRelease = (platform: string | undefined = acpPlatform()): CursorRelease | undefined => pinnedRelease(CURSOR_PIN, platform, true) as CursorRelease | undefined;

/** A pinned Cursor release: its archive, with its launcher's sha256 and its tree's digest. */
export type CursorRelease = PinnedRelease & { readonly treeSha256: string };

/** Cursor as a harness adapter (id `cursor`): its pinned install checked, its recipe for the run's model and limits. */
export function cursorAdapter(options: CursorAdapterOptions): AgentAdapter {
  const { binary, model, limits, ...rest } = options;
  const release = cursorRelease();
  if (!release) throw unpinned("Cursor", CURSOR_PIN.version);
  const root = cursorRootOf(binary, release.cmd);
  if (!root) throw new AcpBinaryRefused(ACP_CODES.binaryMismatch, `the Cursor launcher at ${binary} is not at its pinned path ${release.cmd} inside its folder`);
  verifyPinnedBinary(binary, release.binarySha256);
  return acpAdapter({
    ...rest,
    recipe: cursorRecipe({ command: binary, ...(model !== undefined ? { model } : {}), ...(limits ? { limits } : {}) }),
    // Checked again before each process starts, every file it runs, the launcher among them (the tree's digest covers
    // it): a file replaced since the adapter was made never runs unchecked. An unchanged file is not hashed again (the
    // check remembers it by its identity).
    beforeStart: () => verifyPinnedTree(root, release.treeSha256),
  });
}
