// Goose as an AgentRun harness: its recipe (recipes/goose.json), loaded and typed, and the adapter a host builds from
// it on a pinned binary. Written for AgentRun.
//
// What the recipe holds was measured on Goose 1.59.2 over ACP:
//  - `goose acp` in a private HOME, provider `anthropic` in approve mode (every tool call asks permission, and the
//    adapter answers allow_once or reject_once, never an `always`); session naming and the keyring off;
//  - every bundled extension off in `$HOME/.config/goose/config.yaml`, which leaves the model our MCP server's tools
//    (`agentrun__<name>`) and `load_skill`, which Goose always offers. ACP's `_meta.enabledExtensions: []` is not used:
//    it drops our MCP server too;
//  - HTTP(S)_PROXY to a dead loopback port, loopback exempt: Goose downloads a model catalog from the internet at every
//    start, and this blocks it while its model's requests (to the session's loopback proxy) go on;
//  - its sessions in `$HOME/.local/share/goose/sessions` (sessions.db), mirrored so another runner's Goose loads them;
//  - session/load and MCP over HTTP declared; its model billed through the host's proxy.
// The run's model is GOOSE_MODEL, set here; ANTHROPIC_HOST and ANTHROPIC_API_KEY are the proxy's (gooseProxy), never
// the recipe's.
import { readFileSync } from "node:fs";
import type { AgentAdapter } from "@parcha/agentrun-kernel";
import { acpAdapter, type AcpAdapterOptions } from "./adapter.js";
import { gooseProxy, type GooseProxyOptions } from "./host/goose-proxy.js";
import { GOOSE_PIN, pinnedRelease, unpinned, verifyPinnedBinary, verifyPinnedBinaryAsync } from "./pinned-binary.js";
import { MODEL_ID, recipeProblems, type AcpRecipe } from "./recipe.js";

/** A recipe as its file holds it: everything but the binary, which the host's install puts where it does. */
export type AcpRecipeFile = Omit<AcpRecipe, "command">;

/** The recipes this package ships, by name. */
export type AcpRecipeName = "goose" | "cursor";

/** The variables the proxy (ANTHROPIC_HOST, ANTHROPIC_API_KEY) and the loader (GOOSE_MODEL) set: a recipe file never
 *  names them. */
const SET_ELSEWHERE: ReadonlySet<string> = new Set(["ANTHROPIC_HOST", "ANTHROPIC_API_KEY", "GOOSE_MODEL"]);

/** The recipe file `name`, as shipped beside this package's code. */
export function recipeFile(name: AcpRecipeName): AcpRecipeFile {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`../recipes/${name}.json`, import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`acp: the recipe file ${name}.json is not an object`);
  if ("command" in parsed) throw new Error(`acp: the recipe file ${name}.json names a command; the host's install gives it`);
  return parsed as AcpRecipeFile;
}

export interface GooseRecipeOptions {
  /** The Goose binary, absolute: one that met its pin (verifyPinnedBinary). */
  command: string;
  /** The run's model, as the provider names it. */
  model: string;
}

/** Goose's recipe for one run: its file, with the binary and the run's model. Refused when it could not run. */
export function gooseRecipe(options: GooseRecipeOptions): AcpRecipe {
  if (typeof options.model !== "string" || !MODEL_ID.test(options.model)) throw new Error(`acp: the model ${JSON.stringify(String(options.model).slice(0, 80))} is not a model id`);
  const file = recipeFile("goose");
  const named = Object.keys(file.env ?? {}).filter((name) => SET_ELSEWHERE.has(name));
  if (named.length) throw new Error(`acp: the goose recipe file names ${named.join(", ")}, which the proxy and the loader set`);
  const recipe: AcpRecipe = { ...file, command: options.command, env: { ...file.env, GOOSE_MODEL: options.model } };
  const problems = recipeProblems(recipe);
  if (problems.length) throw new Error(`acp: the goose recipe cannot run: ${problems.join("; ")}`);
  return recipe;
}

export interface GooseAdapterOptions extends Omit<AcpAdapterOptions, "recipe" | "proxy" | "beforeStart">, Omit<GooseProxyOptions, "log"> {
  /** The Goose binary, absolute. Its sha256 is checked when the adapter is made and again before every start of a Goose
   *  process (a restart included), and it is never run for the check. */
  binary: string;
  /** The sha256 it must have. Default: the pin's for this platform (GOOSE_PIN), refused with ACP_BINARY_UNPINNED where
   *  the pin has none. */
  sha256?: string;
}

/** Goose as a harness adapter (id `goose`): its pinned binary checked, its recipe for the run's model, and a model proxy
 *  of its own for each Goose process, on the session's booking. */
export function gooseAdapter(options: GooseAdapterOptions): AgentAdapter {
  const { binary, sha256, model, provider, price, maxOutputTokens, fetch, ...rest } = options;
  const pinned = sha256 ?? pinnedRelease(GOOSE_PIN)?.binarySha256;
  if (!pinned) throw unpinned("Goose", GOOSE_PIN.version);
  verifyPinnedBinary(binary, pinned);
  return acpAdapter({
    ...rest,
    recipe: gooseRecipe({ command: binary, model }),
    // Checked again before each process starts: a binary replaced since the adapter was made never runs unchecked. An
    // unchanged file is not hashed again (the check remembers it by its identity).
    beforeStart: (command) => verifyPinnedBinaryAsync(command, pinned),
    proxy: gooseProxy({ model, provider, ...(price ? { price } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(fetch ? { fetch } : {}), ...(rest.log ? { log: rest.log } : {}) }),
  });
}
