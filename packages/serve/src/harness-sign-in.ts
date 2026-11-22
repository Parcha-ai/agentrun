// `agentrun harness sign-in --recipe FILE`: the owner signs a recipe's agent in to their own account with the agent's own
// sign-in, in their own terminal, as T3 Code signs Google Antigravity in (`agy acp --login --gemini-dir DIR`). The
// installed binary (its pins checked, as a check's are) starts with its release's args, then signIn.args, then
// signIn.homeArg naming <data>/harnesses/<id>.sign-in, on this terminal's own stdin, stdout and stderr: the agent prints
// where to sign in, reads the code the person pastes, and writes its sign-in into that folder. Nothing of AgentRun's sits
// between the person and the agent: this command reads none of what the agent prints or is given, never lists or opens
// the folder, and judges the sign-in by the agent's exit status alone. AgentRun never reads, refreshes or sends the
// sign-in (HARNESS.md#sign-in).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACP_PACKAGE, acpPackage } from "./acp-package.js";
import { ARCHIVE_CODES, archivePlatform, digestOf } from "./harness-archive.js";
import { installDirOf } from "./harness-install.js";
import { AGENT_VARS, loadRecipe, pinnedDigest, pinnedTree, recipeBinaryOf, recipeInstallLine, RecipeRefused, releaseFor, signedInNoteOf, signInHomeOf } from "./harness-recipe.js";

/** A recipe with no signIn: it runs on its keys alone, and has nothing to sign in. */
export const HARNESS_NO_SIGN_IN = "HARNESS_NO_SIGN_IN";
/** The agent's own sign-in did not end well: its exit status, a signal, or the time ran out. */
export const HARNESS_SIGN_IN_FAILED = "HARNESS_SIGN_IN_FAILED";
/** How long the person has to sign in. */
export const SIGN_IN_MS = 10 * 60_000;

/** The one line each sign-in says first: a person's own sign-in used through AgentRun may be outside what its vendor's
 *  terms (the recipe's signIn.terms) cover, and the choice is theirs. A warning, never a refusal. */
export const signInWarning = (label: string, terms: string | undefined): string =>
  `${label}'s own sign-in: its vendor's terms may not cover use through AgentRun${terms ? ` (${terms})` : ""}. Your choice, on your own machine, at your own account's risk.`;

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
  if (!acp) return refuse("HARNESS_NOT_INSTALLED", `the ACP adapter (${ACP_PACKAGE}) beside this server is not installed`);
  const found = await digestOf(binary).catch(() => undefined);
  const tree = await acp.treeDigest(installDirOf(options.data, recipe.id)).catch(() => undefined);
  if (found !== pin.sha256 || tree !== treePin.sha256) return refuse(ARCHIVE_CODES.binary, `${recipe.label}'s installed files are not the pinned ones. Install it again with: ${line}`);

  const home = signInHomeOf(options.data, recipe.id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  // Its own HOME and TMPDIR for whatever else the agent writes, gone with it; its sign-in goes to `home` alone, by the flag.
  const scratch = mkdtempSync(join(tmpdir(), "agentrun-sign-in-"));
  const env: Record<string, string> = {};
  for (const name of AGENT_VARS.inherited) if (options.env[name] !== undefined) env[name] = options.env[name]!;
  Object.assign(env, recipe.env, { HOME: scratch, TMPDIR: scratch });
  const args = [...(release.args ?? recipe.args), ...recipe.signIn.args, recipe.signIn.homeArg, home];
  // The one warning, never a refusal (HARNESS.md#vendor-terms): the vendor's terms are the recipe's to name, the choice
  // the person's.
  say(signInWarning(recipe.label, recipe.signIn.terms));
  say(`${recipe.label} signs you in with its own sign-in, here: it prints the address to open and asks you for the code. AgentRun reads none of it.`);
  const timeoutMs = options.timeoutMs ?? SIGN_IN_MS;
  let timedOut = false;
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: string }>((done) => {
    // In a process group of its own, so that whatever it starts (a launcher that does not exec the agent, a helper the
    // agent forks) ends with it: on the timeout, and when this command is interrupted (Ctrl-C reaches this process alone
    // now, and is passed on to the group). The terminal's stdin, stdout and stderr stay the agent's.
    const child = spawn(binary, args, { cwd: scratch, env, stdio: "inherit", detached: true });
    const group = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is gone already.
      }
    };
    const stop = () => {
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), 5_000).unref();
    };
    const passOn = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of passOn) process.on(signal, stop);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const settle = (result: { code: number | null; signal: NodeJS.Signals | null } | { error: string }) => {
      clearTimeout(timer);
      for (const signal of passOn) process.off(signal, stop);
      // Whatever it left behind in its group goes with it.
      group("SIGKILL");
      done(result);
    };
    child.once("error", (error) => settle({ error: (error as NodeJS.ErrnoException).code ?? error.message }));
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
  rmSync(scratch, { recursive: true, force: true });
  if ("error" in ended) return refuse(HARNESS_SIGN_IN_FAILED, `${recipe.label} could not be started (${ended.error})`);
  if (timedOut) return refuse(HARNESS_SIGN_IN_FAILED, `${recipe.label} was not signed in within ${Math.round(timeoutMs / 60_000)} minutes`);
  if (ended.code !== 0) return refuse(HARNESS_SIGN_IN_FAILED, `${recipe.label}'s sign-in ended with ${ended.signal ? `signal ${ended.signal}` : `exit status ${ended.code}`}, so it is not signed in`);
  writeFileSync(signedInNoteOf(options.data, recipe.id), `${JSON.stringify({ at: new Date().toISOString(), version: recipe.release.version })}\n`, { mode: 0o600 });
  return { ok: true, home };
}
