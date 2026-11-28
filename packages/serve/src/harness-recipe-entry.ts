// A recipe's harness entry (HARNESS.md#a-recipe), built once for both of its uses: `agentrun harness-check`, which runs
// it for real and judges it on its keys, and a server that names it (--harness-recipe), whose runs start it the same way
// (serverRoute). Only a single-owner server on its owner's own machine (--harness-sign-in) runs one on its owner's own
// sign-in, handing the agent the folder's path and nothing else. AgentRun never reads, refreshes or sends the agent's
// token (HARNESS.md#sign-in): nothing here opens a file at all.
import type { AcpRecipe } from "@parcha/agentrun-harness-acp";
import { ACP_PACKAGE, acpPackage } from "./acp-package.js";
import { archivePlatform } from "./harness-archive.js";
import { type EgressProxy, egressProxy, egressVars } from "./harness-egress.js";
import { HARNESS_KEYS_PAGE, harnessKeysSavedHere, keysLaid } from "./harness-keys.js";
import { checkedOf, installHolds, loadRecipe, type Recipe, type RecipeArchive, recipeBinaryOf, recipeCheckLine, recipeInstall, recipeSignInLine, releaseFor, signedIn, signInHomeOf } from "./harness-recipe.js";
import { acpEntryOf, type AcpEntryHost, type HarnessEntry } from "./harness-table.js";
import { HarnessUnavailable } from "./provider.js";

/** A recipe with a sign-in on a server started with --harness-sign-in, whose owner has not signed its agent in on this
 *  data directory. */
export const HARNESS_NOT_SIGNED_IN = "HARNESS_NOT_SIGNED_IN";
/** A recipe a server names that has no passing harness-check on this data directory for the recipe, binary and files
 *  it would run (harness-recipe.ts checkedOf). */
export const HARNESS_NOT_CHECKED = "HARNESS_NOT_CHECKED";
/** A plan-billed recipe a server names, whose runs take keys saved for its harness alone (harness-keys.ts), and not every
 *  one is saved: its owner saves them in Settings → Harness keys. Until then it runs under harness-check, or on its
 *  owner's own sign-in on their own machine (--harness-sign-in). */
export const HARNESS_KEYS_NOT_SAVED = "HARNESS_KEYS_NOT_SAVED";

/** What a recipe's agent runs on: its keys (each read by its saved name where it runs; none for a proxy-billed agent,
 *  on the model proxy), or its owner's own sign-in, whose folder (`home`) the agent is handed by signIn.homeArg. */
export type RecipeRoute = { readonly on: "keys" } | { readonly on: "sign-in"; readonly home: string };

/** The route a server runs `recipe`'s agent on, or why there is none. Proxy-billed: the model proxy. Plan-billed: keys
 *  saved for its harness alone (harness-keys.ts), which come first: for a start, only those its claim laid on `env`
 *  (keysLaid); for the server's listing and offers, `saved` too, every one held saved by the server on this data
 *  directory (harnessKeysSavedHere), whose claims lay them. Its owner's own sign-in only where `signIn` (the server's
 *  --harness-sign-in: one owner, on their own machine, its runs as its own user, which the start proved) and only for a
 *  person's run: a scheduled or triggered one whose claim laid not every key is refused at its claim, before this
 *  (runner/cli-run-spec.ts, harness-keys.ts RECIPE_SIGN_IN_PERSON_ONLY). Else HARNESS_KEYS_NOT_SAVED, naming the
 *  console's page. harness-check never takes this route: it runs on the recipe's keys from the shell alone. */
export function serverRoute(recipe: Recipe, file: string, data: string, env: NodeJS.ProcessEnv, { signIn, saved = false }: { signIn: boolean; saved?: boolean }): RecipeRoute | { refused: string; message: string } {
  if (recipe.model.billing === "proxy") return { on: "keys" };
  if (saved || keysLaid(env, recipe.keys)) return { on: "keys" };
  if (signIn && recipe.signIn) {
    if (signedIn(data, recipe)) return { on: "sign-in", home: signInHomeOf(data, recipe.id) };
    return { refused: HARNESS_NOT_SIGNED_IN, message: `${recipe.label} runs on this server on its keys saved in Settings → Harness keys (${HARNESS_KEYS_PAGE}), else on its owner's own sign-in (--harness-sign-in), and neither is here: save its keys there, or sign it in with: ${recipeSignInLine(file, data, env)}` };
  }
  const own = recipe.signIn ? "; on your own machine alone, a server started with --harness-sign-in runs it on your own sign-in" : "";
  return { refused: HARNESS_KEYS_NOT_SAVED, message: `${recipe.label} runs on its keys (${recipe.keys.join(", ")}) saved for this harness alone, and not every one is saved: save them in Settings → Harness keys (${HARNESS_KEYS_PAGE}; \`agentrun harness keys\` prints the link)${own}` };
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
    ...(recipe.mcpConfigs?.length ? { mcpConfigs: [...recipe.mcpConfigs] } : {}),
    declares: { ...recipe.declares },
    billing: recipe.model.billing === "proxy" ? { kind: "proxy" } : { kind: "plan", maxTurns: recipe.model.maxTurns, maxToolCalls: recipe.model.maxToolCalls },
    ...(recipe.allowFile ? { allowFile: { path: recipe.allowFile.path, form: recipe.allowFile.form as NonNullable<AcpRecipe["allowFile"]>["form"] } } : {}),
    ...(recipe.announces ? { announces: recipe.announces } : {}),
    ...(recipe.quirks.mcpCall || recipe.quirks.permissionTie ? { quirks: { ...(recipe.quirks.mcpCall ? { mcpCall: recipe.quirks.mcpCall } : {}), ...(recipe.quirks.permissionTie ? { permissionTie: recipe.quirks.permissionTie } : {}) } } : {}),
  };
}

/** What recipeEntryOf builds `recipe`'s entry from: its installed `binary` and `release`, the route of each start (it
 *  may throw a HarnessUnavailable), the check before each start, and what harness-check adds (its log, its variables,
 *  the recorder its model proxy forwards through). `missing` and `hidden` are a server's (recipeServerEntry). */
export interface RecipeEntryOptions extends AcpEntryHost {
  readonly recipe: Recipe;
  readonly binary: string;
  readonly release: RecipeArchive;
  /** `probe`: the adapter is built only to check it (harness-table.ts PlanLaunch.probe), not to start its agent. */
  route(env: NodeJS.ProcessEnv, probe?: boolean): RecipeRoute;
  beforeStart(command: string): Promise<void>;
  /** The variables beside the recipe's env at each start: the egress proxy's (harness-egress.ts egressVars). */
  vars(): Readonly<Record<string, string>>;
  /** harness-check's recorder, over the next hop the proxy forwards with: the route's own fetch for a model it translates
   *  (ModuleLaunch.fetch), undefined for the network. Whatever it returns is what the proxy forwards with, so a check
   *  runs the hop a server's run takes. */
  readonly record?: (next: typeof fetch | undefined) => typeof fetch;
  /** `held`: a held run its model kept from running (harness-table.ts AcpPlanEntryOptions.missing), asked for no key. */
  missing?(env: NodeJS.ProcessEnv, launch?: { readonly held: boolean }): Promise<string | undefined>;
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
          // The route's own fetch for a model it translates (ModuleLaunch.fetch), else the network; under harness-check, its
          // recorder over that hop.
          const forward = options.record ? options.record(launch.fetch) : launch.fetch;
          const messagesProxy = acp.gooseProxy({ model: launch.model, provider: launch.provider, price: launch.price, log: launch.log, ...(forward ? { fetch: forward } : {}) });
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
        // A held run its model kept from running never starts its agent: it reads no route, and is laid no key.
        recipe: (launch) => acpRecipeFor(recipe, binary, release, launch.held ? { on: "keys" } : options.route(launch.env, launch.probe === true), { vars: options.vars(), model: launch.model }),
        beforeStart: options.beforeStart,
        ...checks,
        ...(options.hidden ? { hidden: options.hidden } : {}),
      }, host);
  return options.hidden && entry.hidden === undefined ? Object.freeze({ ...entry, hidden: options.hidden }) : entry;
}

/** The entry of the recipe `loaded` (loadRecipe: read once, so the entry and the digest its keys are bound to are of the
 *  same bytes) on a server whose data directory is `data` (harness-table.ts HARNESS_RECIPES_ENV), loaded under its five
 *  rules when the table is (a refused one refuses the start, in words). It runs only on the
 *  install its owner made and checked: hidden, and each run refused, with the command that fixes it, until a harness-check
 *  passed for this very recipe and this install's tree, the binary among it (HARNESS_NOT_CHECKED). Each start of its
 *  agent digests the tree again and holds it to its pin (harness-recipe.ts installHolds). It runs on
 *  the route serverRoute gives, its owner's sign-in only where `signIn` (--harness-sign-in). */
export function recipeServerEntry(loaded: ReturnType<typeof loadRecipe>, data: string, { signIn = false }: { signIn?: boolean } = {}): HarnessEntry {
  const { recipe } = loaded;
  const platform = archivePlatform();
  const release = releaseFor(recipe, platform);
  if (!platform || !release) throw new Error(`harness recipe ${loaded.file}: ${recipe.label} ${recipe.release.version} has no release for ${platform ?? `${process.platform}-${process.arch}`}`);
  const binary = recipeBinaryOf(data, recipe, release);
  // What the server's listing, offers and checks read (`why`, and the adapter built as a probe): the keys route when its
  // server holds every one saved on this data directory (harnessKeysSavedHere), whose claims lay them. An agent's start
  // reads only what its claim laid (`start`): never what the server lists, which a removal can have outrun, nor the
  // shell's variable of a key's name.
  const route = (env: NodeJS.ProcessEnv) => serverRoute(recipe, loaded.file, data, env, { signIn, saved: harnessKeysSavedHere(data, recipe.id) });
  const start = (env: NodeJS.ProcessEnv) => serverRoute(recipe, loaded.file, data, env, { signIn });
  /** Why it cannot run on `env`, in words that end with the command that fixes it; undefined when it can. Nothing is
   *  digested here (each start is, beforeStart): the tree pin and the check's note are compared. Where `held` (a held
   *  run its model kept from running, whose agent never starts and whose claim laid no key), its install and check
   *  alone: no route is asked, so neither a key nor a sign-in is, and a run's own process, which holds no server's
   *  record of the keys saved here (harnessKeysSavedHere), holds its computer as a runner's claim does. */
  const why = (env: NodeJS.ProcessEnv, held = false): string | undefined => {
    const install = recipeInstall(data, recipe, loaded.file, env, platform);
    if ("code" in install) return `${install.code}: ${install.message}`;
    const checked = checkedOf(data, recipe.id);
    if (!checked || checked.recipe !== loaded.sha256 || checked.tree !== install.tree.sha256 || checked.platform !== platform) {
      return `${HARNESS_NOT_CHECKED}: ${recipe.label} runs on this server once harness-check passes for this recipe and this install${checked ? " (the recipe or its install changed since the last check that passed)" : ""}. Check it with: ${recipeCheckLine(loaded.file, data, env)}`;
    }
    if (held) return undefined;
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
    route: (env, probe) => {
      const on = probe ? route(env) : start(env);
      if ("refused" in on) throw new HarnessUnavailable(`${on.refused}: ${on.message}`);
      return on;
    },
    // The binary and every file beside it, digested again before each start: one swapped since the check never runs.
    beforeStart: async (command) => {
      const install = recipeInstall(data, recipe, loaded.file, process.env, platform);
      const off = "code" in install ? install : await installHolds(install);
      if (off) throw new Error(`${off.code}: ${command} does not start: ${off.message}`);
    },
    missing: async (env, launch) => {
      const lacks = why(env, launch?.held === true);
      if (lacks) return lacks;
      // A start that failed is tried again at the next run, never kept.
      egress ??= egressProxy(hosts, { record: false, unref: true }).catch((error: unknown) => {
        egress = undefined;
        throw error;
      });
      egressUrl ??= (await egress).url;
      return undefined;
    },
    hidden: (env) => why(env),
  });
}
