// A recipe's harness entry (HARNESS.md#a-recipe), built once for both of its uses: `agentrun harness-check`, which runs
// it for real and judges it, and a server that names it (--harness-recipe), whose runs start it the same way. Its
// agent runs on its keys or on its owner's own sign-in (recipeRoute); on the sign-in it is handed the folder's path
// and nothing else. AgentRun never reads, refreshes or sends the agent's token (HARNESS.md#sign-in): nothing here opens
// a file at all.
import { existsSync } from "node:fs";
import type { AcpRecipe } from "@parcha/agentrun-harness-acp";
import { ACP_PACKAGE, acpPackage } from "./acp-package.js";
import { ARCHIVE_CODES, archivePlatform, digestOf } from "./harness-archive.js";
import { type EgressProxy, egressProxy, egressVars } from "./harness-egress.js";
import { installDirOf } from "./harness-install.js";
import { checkedOf, loadRecipe, pinnedDigest, pinnedTree, type Recipe, type RecipeArchive, recipeBinaryOf, recipeCheckLine, recipeInstallLine, recipeSignInLine, releaseFor, signedIn, signInHomeOf } from "./harness-recipe.js";
import { acpEntryOf, type AcpEntryHost, type HarnessEntry } from "./harness-table.js";
import { HarnessUnavailable } from "./provider.js";

/** A recipe with a sign-in whose keys are not set where it runs, and whose owner has not signed its agent in on this
 *  data directory: no route its agent runs on is there. */
export const HARNESS_NOT_SIGNED_IN = "HARNESS_NOT_SIGNED_IN";
/** A recipe a server names that has no passing harness-check on this data directory for the recipe, binary and files
 *  it would run (harness-recipe.ts checkedOf). */
export const HARNESS_NOT_CHECKED = "HARNESS_NOT_CHECKED";
/** A recipe a server names that runs on its keys alone: a recipe's keys reach no run on a server yet (the cut every
 *  child's environment takes keeps them out), so it runs under harness-check alone. */
export const HARNESS_KEYS_UNSUPPORTED = "HARNESS_KEYS_UNSUPPORTED";

/** What a recipe's agent runs on: its keys (each read by its saved name where it runs), or its owner's own sign-in,
 *  whose folder (`home`) the agent is handed by signIn.homeArg. */
export type RecipeRoute = { readonly on: "keys" } | { readonly on: "sign-in"; readonly home: string };

/** The route `recipe`'s agent runs on with `env`, or why there is none: its keys where every one is set and `keys` may be
 *  taken (harness-check: yes; a server: no, HARNESS_KEYS_UNSUPPORTED), else the sign-in its owner made on `data`, as T3
 *  Code runs Antigravity on its owner's own install. A recipe with neither keys nor a sign-in runs as it is. */
export function recipeRoute(recipe: Recipe, file: string, data: string, env: NodeJS.ProcessEnv, { keys }: { keys: boolean }): RecipeRoute | { refused: string; message: string } {
  const keysSet = recipe.keys.length > 0 && recipe.keys.every((name) => typeof env[name] === "string" && env[name] !== "");
  if (keys && keysSet) return { on: "keys" };
  if (recipe.signIn && signedIn(data, recipe)) return { on: "sign-in", home: signInHomeOf(data, recipe.id) };
  const signInLine = recipeSignInLine(file, data, env);
  if (recipe.signIn) {
    const named = keys && recipe.keys.length ? `set ${recipe.keys.join(" and ")} (saved for this harness alone), or ` : "";
    const how = keys ? "its keys or its owner's own sign-in, and neither is here" : "its owner's own sign-in on a server (a recipe's keys reach no run on a server yet), and its agent is not signed in here";
    return { refused: HARNESS_NOT_SIGNED_IN, message: `${recipe.label} runs on ${how}: ${named}sign its agent in with: ${signInLine}` };
  }
  if (!keys && recipe.keys.length) return { refused: HARNESS_KEYS_UNSUPPORTED, message: `${recipe.label} runs on its keys (${recipe.keys.join(", ")}), and a recipe's keys reach no run on a server yet: check it with harness-check, where its keys are read from your shell` };
  return { on: "keys" };
}

/** The ACP adapter's recipe for one start of `recipe`'s agent on `route`: the installed `binary`, the platform's own
 *  arguments where its release lists them (else the recipe's), and on the sign-in its folder after them. On its keys:
 *  each under the name its agent reads, and the method it signs in with on them. On the sign-in: no key, no
 *  authenticate, and nothing the agent prints kept (stderr "none"), since no cut knows its token. `vars` are the
 *  caller's beside the recipe's env (harness-check's egress proxy); `model` the run's (a proxy-billed agent's under
 *  model.env; a plan's chosen among those it lists, the recipe's model.id where the run names its default). */
export function acpRecipeFor(recipe: Recipe, binary: string, release: RecipeArchive, route: RecipeRoute, { vars = {}, model }: { vars?: Readonly<Record<string, string>>; model?: string } = {}): AcpRecipe {
  const modelVar = recipe.model.billing === "proxy" ? recipe.model.env : undefined;
  const planModel = recipe.model.billing === "plan" ? (model === undefined || model === "default" ? recipe.model.id : model) : undefined;
  return {
    id: recipe.id,
    label: recipe.label,
    command: binary,
    args: [...(release.args ?? recipe.args), ...(route.on === "sign-in" ? [recipe.signIn!.homeArg, route.home] : [])],
    env: { ...recipe.env, ...vars, ...(modelVar && model !== undefined ? { [modelVar]: model } : {}) },
    ...(route.on === "sign-in"
      ? { keys: [], stderr: "none" as const }
      : {
          keys: [...recipe.keys],
          ...(Object.keys(recipe.keyEnv).length ? { keyEnv: { ...recipe.keyEnv } } : {}),
          ...(recipe.keyMethod ? { authMethod: recipe.keyMethod } : {}),
        }),
    ...(planModel ? { model: planModel } : {}),
    files: { ...recipe.files },
    state: [...recipe.state],
    declares: { ...recipe.declares },
    billing: recipe.model.billing === "proxy" ? { kind: "proxy" } : { kind: "plan", maxTurns: recipe.model.maxTurns, maxToolCalls: recipe.model.maxToolCalls },
    ...(recipe.quirks.mcpCall ? { quirks: { mcpCall: recipe.quirks.mcpCall } } : {}),
  };
}

/** What recipeEntryOf builds `recipe`'s entry from: its installed `binary` and `release`, the route of each start (it
 *  may throw a HarnessUnavailable), the check before each start, and what harness-check adds (its log, its variables,
 *  the fetch its model proxy records with). `missing` and `hidden` are a server's (recipeServerEntry). */
export interface RecipeEntryOptions extends AcpEntryHost {
  readonly recipe: Recipe;
  readonly binary: string;
  readonly release: RecipeArchive;
  route(env: NodeJS.ProcessEnv): RecipeRoute;
  beforeStart(command: string): Promise<void>;
  /** The variables beside the recipe's env at each start: the egress proxy's (harness-egress.ts egressVars). */
  vars(): Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  missing?(env: NodeJS.ProcessEnv): Promise<string | undefined>;
  hidden?(env: NodeJS.ProcessEnv): string | undefined;
}

/** `recipe`'s whole entry, as an ACP agent outside the built-ins starts (harness-table.ts acpEntryOf). Proxy-billed: as a
 *  module's, its model and key chosen and a login refused there, its price, the adapter over its recipe and the
 *  session's model proxy (the one on Anthropic's Messages there is, Goose's policy, its address under the variable the
 *  recipe names). Billed to its plan: as Cursor's, on the model the recipe names or its vendor's own default. */
export function recipeEntryOf(options: RecipeEntryOptions): HarnessEntry {
  const { recipe, binary, release } = options;
  const acp = acpPackage();
  if (!acp) throw new HarnessUnavailable(`${recipe.label}'s recipe runs on the ACP adapter (${ACP_PACKAGE}), which is not installed beside this server`);
  const host = options.log ? { log: options.log } : {};
  const checks = options.missing ? { missing: options.missing } : {};
  const entry = recipe.model.billing === "proxy"
    ? acpEntryOf({
        facts: { ...acp.gooseFacts, id: recipe.id, label: recipe.label },
        recipe: (launch) => acpRecipeFor(recipe, binary, release, options.route(launch.env), { vars: options.vars(), model: launch.model }),
        proxy: (launch) => {
          const hostEnv = recipe.model.billing === "proxy" ? (recipe.model.hostEnv ?? "ANTHROPIC_HOST") : "ANTHROPIC_HOST";
          const messagesProxy = acp.gooseProxy({ model: launch.model, provider: launch.provider, price: launch.price, log: launch.log, ...(options.fetch ? { fetch: options.fetch } : {}) });
          return async (session) => {
            // The proxy's own address, under the recipe's variable, beside the key that opens it alone (never a provider's).
            const started = await messagesProxy(session);
            const { ANTHROPIC_HOST: address, ...opens } = started.env;
            return { env: { ...opens, [hostEnv]: address! }, close: started.close };
          };
        },
        beforeStart: options.beforeStart,
        ...checks,
      }, host)
    : acpEntryOf({
        facts: { ...acp.cursorFacts, id: recipe.id, label: recipe.label },
        recipe: (launch) => acpRecipeFor(recipe, binary, release, options.route(launch.env), { vars: options.vars(), model: launch.model }),
        beforeStart: options.beforeStart,
        ...checks,
        ...(options.hidden ? { hidden: options.hidden } : {}),
      }, host);
  return options.hidden && entry.hidden === undefined ? Object.freeze({ ...entry, hidden: options.hidden }) : entry;
}

/** The entry of the recipe at `file` on a server whose data directory is `data` (harness-table.ts HARNESS_RECIPES_ENV),
 *  loaded under its five rules when the table is (a refused one refuses the start, in words). It runs only on the
 *  install its owner made and checked: hidden, and each run refused, with the command that fixes it, until the binary
 *  and every file beside it are the pinned ones and a harness-check passed for this very recipe, binary and tree
 *  (HARNESS_NOT_CHECKED). Each start of its agent checks the binary and the tree against their pins again. It runs on
 *  its owner's sign-in or through this server's model proxy, never on a recipe's keys (HARNESS_KEYS_UNSUPPORTED). */
export function recipeServerEntry(file: string, data: string): HarnessEntry {
  const loaded = loadRecipe(file);
  const { recipe } = loaded;
  const platform = archivePlatform();
  const release = releaseFor(recipe, platform);
  if (!platform || !release) throw new Error(`harness recipe ${loaded.file}: ${recipe.label} ${recipe.release.version} has no release for ${platform ?? `${process.platform}-${process.arch}`}`);
  const binary = recipeBinaryOf(data, recipe, release);
  const installed = installDirOf(data, recipe.id);
  const route = (env: NodeJS.ProcessEnv) => recipeRoute(recipe, loaded.file, data, env, { keys: false });
  /** Why it cannot run on `env`, in words that end with the command that fixes it; undefined when it can. Nothing is
   *  digested here (each start is, beforeStart): the pins and the check's note are compared. */
  const why = (env: NodeJS.ProcessEnv): string | undefined => {
    const pin = pinnedDigest(data, recipe, release, platform);
    const tree = pinnedTree(data, recipe, release, platform);
    if (!existsSync(binary) || !pin || !tree) return `HARNESS_NOT_INSTALLED: ${recipe.label} ${recipe.release.version} is not installed in ${installed}. Install it with: ${recipeInstallLine(loaded.file, data, env)}`;
    const checked = checkedOf(data, recipe.id);
    if (!checked || checked.recipe !== loaded.sha256 || checked.binary !== pin.sha256 || checked.tree !== tree.sha256 || checked.platform !== platform) {
      return `${HARNESS_NOT_CHECKED}: ${recipe.label} runs on this server once harness-check passes for this recipe and this install${checked ? " (the recipe or its install changed since the last check that passed)" : ""}. Check it with: ${recipeCheckLine(loaded.file, data, env)}`;
    }
    const on = route(env);
    return "refused" in on ? `${on.refused}: ${on.message}` : undefined;
  };
  // What its runs' agents reach beyond loopback, as on its check: the hosts a plan-billed recipe's model.hosts names,
  // tunneled, and nothing else (a proxy-billed agent's model is the model proxy, on loopback). One proxy for the recipe's
  // runs in this process, started before its first agent does (in `missing`, which every start asks first), keeping no
  // list of what it was asked.
  const hosts = recipe.model.billing === "plan" ? (recipe.model.hosts ?? []) : [];
  let egress: Promise<EgressProxy> | undefined;
  let egressUrl: string | undefined;
  return recipeEntryOf({
    recipe,
    binary,
    release,
    vars: () => {
      if (!egressUrl) throw new HarnessUnavailable(`${recipe.label}'s egress proxy is not running, so its agent does not start`);
      return egressVars(egressUrl);
    },
    route: (env) => {
      const on = route(env);
      if ("refused" in on) throw new HarnessUnavailable(`${on.refused}: ${on.message}`);
      return on;
    },
    // The binary and every file beside it, digested again before each start: one swapped since the check never runs.
    beforeStart: async (command) => {
      const pin = pinnedDigest(data, recipe, release, platform);
      const tree = pinnedTree(data, recipe, release, platform);
      const now = await digestOf(command).catch(() => undefined);
      if (!pin || now !== pin.sha256) throw new Error(`${ARCHIVE_CODES.binary}: ${command} has sha256 ${now ?? "(unreadable)"}, not its pin's. Install it again with: ${recipeInstallLine(loaded.file, data)}`);
      const files = await acpPackage()!.treeDigest(installed).catch(() => undefined);
      if (!tree || files !== tree.sha256) throw new Error(`${ARCHIVE_CODES.binary}: the files beside ${command} have the tree sha256 ${files ?? "(unreadable)"}, not their pin's. Install it again with: ${recipeInstallLine(loaded.file, data)}`);
    },
    missing: async (env) => {
      const lacks = why(env);
      if (lacks) return lacks;
      // A start that failed is tried again at the next run, never kept.
      egress ??= egressProxy(hosts, { record: false, unref: true }).catch((error: unknown) => {
        egress = undefined;
        throw error;
      });
      egressUrl ??= (await egress).url;
      return undefined;
    },
    hidden: why,
  });
}
