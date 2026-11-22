// `agentrun harness sign-in --recipe FILE`: a person signs a recipe's agent in to their own account (Google Antigravity's
// `oauth-personal`), in their own terminal, with the agent's own sign-in. The installed binary (its pins checked, as a
// check's are) is started with signIn.homeEnv pointing at <data>/harnesses/<id>.sign-in and told ACP `authenticate`
// with signIn.method (run-adapters-acp's signInAgent): the agent prints where to sign in on the person's terminal, the
// browser's redirect lands on the agent's own loopback server, and the agent writes its sign-in into that folder. This
// command relays nothing: it reads none of what the agent prints and opens nothing the agent writes, and afterwards it
// checks only that the folder holds something. Within the vendor's terms (HARNESS.md#vendor-terms): the unmodified
// binary, its native sign-in, one person, at their terminal.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { ACP_PACKAGE, acpPackage } from "./acp-package.js";
import { ARCHIVE_CODES, archivePlatform, digestOf } from "./harness-archive.js";
import { installDirOf } from "./harness-install.js";
import { loadRecipe, pinnedDigest, pinnedTree, recipeBinaryOf, recipeInstallLine, RecipeRefused, releaseFor, signedIn, signInHomeOf } from "./harness-recipe.js";

/** A recipe with no signIn: it runs on its keys alone, and has nothing to sign in. */
export const HARNESS_NO_SIGN_IN = "HARNESS_NO_SIGN_IN";
/** The agent answered its sign-in and its folder holds nothing: it was not signed in. */
export const HARNESS_SIGN_IN_EMPTY = "HARNESS_SIGN_IN_EMPTY";

export interface SignInHarnessOptions {
  recipe: string;
  data: string;
  /** The environment the agent's allowlist (PATH, LANG, TZ) is read from; nothing else of it reaches the agent. */
  env: NodeJS.ProcessEnv;
  platform?: string;
  /** Hears what this command says to the person (never anything the agent printed). */
  say?: (line: string) => void;
  /** For tests: how long the person has. */
  timeoutMs?: number;
}

/** Signs the recipe's agent in: `{ ok: true, home }`, or `{ ok: false, code, message }` with the command's own words. */
export async function signInHarness(options: SignInHarnessOptions): Promise<{ ok: true; home: string } | { ok: false; code: string; message: string }> {
  const say = options.say ?? (() => {});
  const refuse = (code: string, words: string) => ({ ok: false as const, code, message: `${code}: ${words}` });
  let loaded: ReturnType<typeof loadRecipe>;
  try {
    loaded = loadRecipe(options.recipe);
  } catch (error) {
    if (!(error instanceof RecipeRefused)) throw error;
    return { ok: false, code: error.code, message: error.message };
  }
  const { recipe, file } = loaded;
  if (!recipe.signIn) return refuse(HARNESS_NO_SIGN_IN, `${recipe.label}'s recipe names no signIn: it runs on its keys (${recipe.keys.join(", ") || "none"}), and has nothing to sign in`);
  // The installed binary and every file beside it, the pinned ones, as a check finds them: nothing is downloaded here.
  const platform = options.platform ?? archivePlatform();
  const release = releaseFor(recipe, platform);
  if (!platform || !release) return refuse("HARNESS_PLATFORM_UNSUPPORTED", `${recipe.label} ${recipe.release.version} has no release for ${platform ?? `${process.platform}-${process.arch}`}`);
  const line = recipeInstallLine(file, options.data, options.env);
  const binary = recipeBinaryOf(options.data, recipe, release);
  const pin = pinnedDigest(options.data, recipe, release, platform);
  const treePin = pinnedTree(options.data, recipe, release, platform);
  if (!existsSync(binary) || !pin || !treePin) return refuse("HARNESS_NOT_INSTALLED", `${recipe.label} ${recipe.release.version} is not installed in ${installDirOf(options.data, recipe.id)}. Install it with: ${line}`);
  const acp = acpPackage();
  if (!acp?.signInAgent) return refuse("HARNESS_NOT_INSTALLED", `the ACP adapter (${ACP_PACKAGE}) beside this server is ${acp ? "too old to sign an agent in" : "not installed"}`);
  const found = await digestOf(binary).catch(() => undefined);
  const tree = await acp.treeDigest(installDirOf(options.data, recipe.id)).catch(() => undefined);
  if (found !== pin.sha256 || tree !== treePin.sha256) return refuse(ARCHIVE_CODES.binary, `${recipe.label}'s installed files are not the pinned ones. Install it again with: ${line}`);

  const home = signInHomeOf(options.data, recipe.id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  say(`${recipe.label} signs in with its own ${recipe.signIn.method}. It prints the address to open below; the port in its redirect_uri is where your browser comes back to it, on this machine.`);
  say(`On a remote server, forward that port from your own machine first (ssh -L PORT:127.0.0.1:PORT this-server), then open the address there.`); // key-gate: loopback-rule the redirect host the agent itself listens on, told to the person
  try {
    await acp.signInAgent({ command: binary, args: release.args ?? recipe.args, method: recipe.signIn.method, homeEnv: recipe.signIn.homeEnv, home, env: recipe.env, from: options.env, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  } catch (error) {
    const message = (error as Error).message;
    return { ok: false, code: message.split(":")[0] ?? "ACP_AUTH_FAILED", message };
  }
  if (!signedIn(options.data, recipe)) return refuse(HARNESS_SIGN_IN_EMPTY, `${recipe.label} answered its sign-in, and ${home} holds nothing: it is not signed in`);
  return { ok: true, home };
}
