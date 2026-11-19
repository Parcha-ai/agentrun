// The one table from a harness id to what runs it, and the one place serve learns what a harness is. Every other file asks
// harnessOf for an entry and reads its facts (the adapter's own, AdapterFacts), never the harness's name: what differs
// between claude-agent, codex and opencode is the API their proxy speaks (the wire: provider.ts), their thinking levels,
// their search, their memory and their install, and each adapter states those itself. pi has no adapter: it runs in the
// run's own process, on its own models (model.ts).
//
// A test hands the server a module of entries of its own (HARNESS_TABLE_ENV, startServer's `harnessTable`), merged over
// these by id: what a test stands in for is an entry, never a branch here or anywhere else. The server sets the variable
// from its options alone (model.ts withoutFaux), so an operator's environment never loads a module.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { AdapterFacts, AgentAdapter } from "@parcha/agentrun-kernel";
import type { ModelProxyOptions } from "@parcha/agentrun-kernel/host";
// Types only: serve loads the ACP package by name at run time (acp-package.ts), and a serve without it still runs.
import type { AcpProxy, AcpRecipe } from "@parcha/agentrun-harness-acp";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
import { facts as openCodeFacts } from "./harness-opencode/facts.js";
import { CURSOR_FACTS, GOOSE_FACTS } from "./adapter-facts.js";
import { ACP_PACKAGE, acpPackage } from "./acp-package.js";
import { gooseHidden } from "./harness-goose.js";
import { CURSOR_DEFAULT_MODEL, CURSOR_KEY, CURSOR_PROVIDER, cursorCardOf, cursorHidden } from "./harness-cursor.js";
import type { AdapterNeeds } from "./adapters.js";
import { DEFAULT_HARNESS, HARNESS_ID_PATTERN, type HarnessId, PLAN_HARNESSES, RESERVED_HARNESS_IDS } from "./harness.js";
import { HARNESS_INSTALLS, type HarnessInstallEntry, type HarnessPins } from "./harness-install.js";
import { chooseModel } from "./model.js";
import { HarnessUnavailable, type ModelChoice, modelOn, openRouterOnly, priceModelFor, providerFor } from "./provider.js";
import { modelWire, WIRES } from "./wires.js";
import type { SkillCheck } from "./skills.js";
import type { RunnerHarness } from "./runner/adapters/index.js";
import { PLAN_PROVIDER, signedIn } from "./chatgpt-plan.js";

/** A module of entries a test merges over the built-in ones (HarnessTableModule), by absolute path. */
export const HARNESS_TABLE_ENV = "AGENTRUN_HARNESS_TABLE";
/** The harness modules the owner names (the server's `harnessModules`), as a JSON array of absolute paths: each adds
 *  harnesses of its own to the table, under a test runner or not, and never replaces a built-in one. The server sets it
 *  from its options alone (model.ts withoutFaux drops an operator's). */
export const HARNESS_MODULES_ENV = "AGENTRUN_HARNESS_MODULES";

/** Why a harness cannot run here, in words a person can act on, and the model keys any one of which would let it
 *  (HarnessUnavailable's `keys`). */
export type Refusal = { reason: string; keys?: readonly string[] };

/** The model route a session's proxy takes for a run (a session proxy's options, ModelProxyOptions): the API, and the policy, model,
 *  endpoint, credential and price its adapter's own proxy is given. */
export type SessionRoute = { api: AdapterFacts["wire"]; options: Pick<ModelProxyOptions, "policy" | "model" | "origin" | "credential" | "price"> };

/** What a harness promises, as capabilities show it (each a person can rely on, measured, never named): how a run resumes
 *  after a crash (`exact`: its state mirrored into the journal; `load`: the agent's own session load; `restart`: the turn
 *  restarts with a recovery note), what holds its tool calls (`every_call`: each blocks until journaled; `permission`: the
 *  agent's permission requests; `config`: its built-ins are off by its config, our tools gated), and who pays for its
 *  model (`proxy`: through the session's proxy, on this server's cap; `plan`: the vendor bills the person's own plan). */
export type HarnessPromises = { readonly resume: "exact" | "load" | "restart"; readonly tool_gate: "every_call" | "permission" | "config"; readonly billing: "proxy" | "plan" };
/** The native harnesses' promises: pi and the three CLI adapters. */
export const NATIVE_PROMISES: HarnessPromises = Object.freeze({ resume: "exact", tool_gate: "every_call", billing: "proxy" });

export interface HarnessEntry {
  readonly id: string;
  /** Its name in a sentence ("Pi", "Claude"): an adapter's facts' label. */
  readonly label: string;
  /** What it promises (HarnessPromises). Absent: a native harness's (NATIVE_PROMISES). */
  readonly promises?: HarnessPromises;
  /** The runner's harness for it (runner/adapters/index.ts RunnerHarness): absent on a built-in, whose runner is the
   *  runner's own (RUNNER_HARNESSES); a harness module's entry brings its own. */
  readonly runner?: RunnerHarness;
  /** Whether it takes a message mid-turn; else a message waits for the turn's end. */
  readonly steer: boolean;
  /** What one of its runs reserves in memory while its process lives, in MiB (host.ts). */
  readonly runMib: number;
  /** A server too small for even one of its runs still runs one at a time (pi's, as before runs were admitted by memory). */
  readonly oneAlwaysFits: boolean;
  /** Its adapter's facts; none for pi, which runs in the run's own process on its own models. */
  readonly facts?: AdapterFacts;
  /** What a first use installs into the data's harnesses directory (harness-install.ts); none when nothing does. */
  readonly installs?: HarnessInstallEntry;
  /** Whether it runs the model `id` (as named, `provider/model-id`). */
  runs(env: NodeJS.ProcessEnv, id: string): boolean;
  /** Whether its model is chosen and priced on its wire's own settings (modelOn, providerFor), not as pi's are. */
  onWire(env: NodeJS.ProcessEnv): boolean;
  /** Its model for `ref` (a revision's; none, this host's default for it). Undefined where its model is its own and it
   *  does not run here (`available` false): the harness says why. */
  model(env: NodeJS.ProcessEnv, ref: string | undefined, available: boolean): Promise<ModelChoice | undefined>;
  /** The catalog entry a run of `model` is capped and priced by. */
  priceModel(env: NodeJS.ProcessEnv, model: AdapterNeeds["model"]): AdapterNeeds["model"];
  /** Why it cannot run here, of the model `given` names (with none, a model of its wire's vendor): its package and pins,
   *  its provider, and the adapter's own check. `atStart`: asked by the start's probe. */
  refusal(env: NodeJS.ProcessEnv, given: AdapterNeeds | undefined, options: { atStart: boolean }): Promise<Refusal | undefined>;
  /** Its adapter for a run. */
  adapter?(env: NodeJS.ProcessEnv, needs: AdapterNeeds): Promise<AgentAdapter>;
  /** The route its adapter's proxy takes for a run (a stand-in's session proxy takes the same). */
  route?(env: NodeJS.ProcessEnv, needs: AdapterNeeds): Promise<SessionRoute>;
  /** Its adapter's own check of the skills it would load itself, where it loads them. */
  skillCheck?(): Promise<SkillCheck | undefined>;
  /** What its first-use install needs (installs). */
  pins?(): Promise<HarnessPins>;
  /** Why it is not listed on `env` (harnessIds: capabilities, the tools' harnesses), in words that end with what to do;
   *  undefined while it is. One its owner installs (Goose: harness-goose.ts) is listed only once it is there and verified.
   *  It is still in the table, so a run or a save naming it is refused with these words. */
  hidden?(env: NodeJS.ProcessEnv): string | undefined;
  /** The secrets that are this harness's own (Cursor's CURSOR_API_KEY): a run of it is handed them, and a run of any
   *  other harness never is (run-secrets.ts keysFor). */
  readonly ownKeys?: readonly string[];
  /** What its owner reads before running it (capabilities' `card`): who bills it, what stops it, whose terms it runs
   *  under. None for a harness that runs on this server's keys and cap. */
  card?(env: NodeJS.ProcessEnv): string | undefined;
}

/** What one run of a module's adapter harness is given (HarnessModuleKit.adapterEntry): the model as its provider names it,
 *  where the session's proxy forwards it (origin, credential, auth), the price of a request's usage, a log, and the
 *  confinement its process starts under. serve chooses each from the run's model and this server's keys (providerFor),
 *  as it does for the built-in harnesses. */
export interface ModuleLaunch {
  readonly model: string;
  readonly provider: { readonly origin: string; readonly credential: () => string | Promise<string>; readonly auth?: "bearer" | "x-api-key" };
  readonly price: (model: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => number | null;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
  readonly confine?: AdapterNeeds["confine"];
  /** The server's environment, for the module's own settings (its binary's path, say). */
  readonly env: NodeJS.ProcessEnv;
}

/** What an ACP agent's module gives acpEntry: its facts, its recipe for a run (the binary, the run's model), and the model
 *  proxy each of its processes reaches the session's booking through (its wire's policy: what may leave on this server's
 *  key). `promises`: default ACP_PROMISES (a resume by session/load, tool calls through its permission asks, billing
 *  through the proxy); an agent that cannot load a session gives `resume: "restart"`. */
export interface AcpEntryOptions extends ModuleChecks {
  readonly facts: AdapterFacts;
  recipe(launch: ModuleLaunch): AcpRecipe;
  proxy(launch: ModuleLaunch): AcpProxy;
  beforeStart?(command: string): Promise<void>;
  readonly promises?: HarnessPromises;
}

/** What a module's harness lacks that no model key gives it, asked before its model key, as the built-in harnesses ask
 *  for their binary first. */
export interface ModuleChecks {
  /** Why it cannot run on `env` whatever key is saved (its binary is not where its setting says, say), in words that end
   *  with what to do; undefined when nothing is missing. Its offer then says this and names no key, where without it a
   *  harness that lacks both would be offered as one a key runs. */
  missing?(env: NodeJS.ProcessEnv): string | undefined | Promise<string | undefined>;
}

/** What serve hands a harness module beside the built-ins (HarnessTableModule.entries' second argument): the builders the
 *  built-in harnesses are made with, so a module's entry chooses models, refuses and is offered as theirs are, on the
 *  running server's own copy, never a second serve's. */
export interface HarnessModuleKit {
  /** An adapter harness's whole entry: its models are its wire's vendor's (WIRES), its key rows those that run them, its
   *  refusal the adapter's own check. `adapter` builds its adapter for one run. */
  adapterEntry(facts: AdapterFacts, adapter: (launch: ModuleLaunch) => AgentAdapter | Promise<AgentAdapter>, extra?: Pick<HarnessEntry, "skillCheck" | "promises" | "hidden"> & ModuleChecks): HarnessEntry;
  /** An ACP agent's whole entry, on serve's own ACP adapter (@parcha/agentrun-harness-acp): adapterEntry over acpAdapter. */
  acpEntry(options: AcpEntryOptions): HarnessEntry;
}

/** What a harness module (and a test's table module) exports: entries by id, given the built-ins to build on and the kit
 *  (HarnessModuleKit). A test's are merged over the built-in one of that id (all of it, for one the server has none of);
 *  a harness module's add whole entries of new ids. Loaded with require: the module has no top-level await. */
export type HarnessTableModule = { entries(builtins: Readonly<Record<string, HarnessEntry>>, kit: HarnessModuleKit): Record<string, Partial<HarnessEntry>> };

// The memory one run of each harness reserves while its process lives, in MiB (each entry's runMib, an adapter's from its
// facts): what admission counts (host.ts).
//  Measured 2026-11-03 on 529c3882e with the pinned binaries' sha256 checked a chunk at a time, not read whole: a
//  real server in a cgroup of its own (MemoryMax 2048M, no swap), models on a loopback stand-in, one agent with read
//  and write asked to write a file, read it back and answer; the cgroup's anon (memory.stat) sampled every 100 ms. A
//  run's size is (the most anon with the runs going − the server's own after boot) / n, for n = 1 and n = 3, twice
//  each, and the largest of the four is kept. The server's own growth while it serves the runs is in it.
//    pi:           n=1 106, 106; n=3 96, 99 MB a run → 128 (+21%)
//    codex:        n=1 132, 143; n=3 120, 131 MB a run → 192 (+34%)
//    claude-agent: n=1 215, 208; n=3 211, 208 MB a run → 288 (+34%)
//    opencode:     n=1 524, 501; n=3 509, 514 MB a run → 704 (+34%), measured the same way 2026-11-04 on the pinned
//                  OpenCode 1.19.5 (its own process, a Bun binary, is most of it; at a 1024M limit two runs were
//                  OOM-killed, and at 512M one short run completed)
//  The margin covers a longer conversation than the probe's three steps; the CLI harnesses (codex, claude-agent) grow
//  more with one, so theirs is larger. At a 512M limit the same build completed pi x3, codex x2 and claude-agent x1
//  (and x2). A check that reads a binary whole adds its size to the server and to each run (294 MB for codex, 230 MB
//  for the claude-agent CLI), and these sizes do not cover it. The faux model and the faux
//  harness reserve the size of the harness they stand in for, so tests admit as a real server does.

/** pi: the run's own process, on its own models. */
const PI: HarnessEntry = Object.freeze({
  id: DEFAULT_HARNESS,
  label: "Pi",
  steer: true,
  runMib: 128,
  oneAlwaysFits: true,
  runs: () => true,
  onWire: () => false,
  model: (env: NodeJS.ProcessEnv, ref: string | undefined) => chooseModel(env, ref, "default", DEFAULT_HARNESS),
  priceModel: (_env: NodeJS.ProcessEnv, model: AdapterNeeds["model"]) => model,
  refusal: async () => undefined,
});

/** Whether `id` names `vendor`'s model on OpenRouter (`openrouter/<vendor>/<model-id>`). */
const onOpenRouter = (id: string, vendor: string): boolean => new RegExp(`^openrouter/${vendor}/[^/]+$`).test(id);

/** An adapter harness's entry, from its facts and the factory that builds its adapter. */
function adapterEntry(facts: AdapterFacts, make: (env: NodeJS.ProcessEnv, needs: AdapterNeeds) => Promise<AgentAdapter>, extra: Pick<HarnessEntry, "skillCheck" | "pins" | "promises" | "hidden"> = {}): HarnessEntry {
  const { wire, id } = facts;
  // A harness billed to its own plan has an entry of its own (cursorEntry): this one is for a model wire of ours.
  if (!modelWire(wire)) throw new Error(`${id} is billed to its own plan, so its table entry is its own, never adapterEntry's`);
  const { vendor, gateway } = WIRES[wire];
  const installs = HARNESS_INSTALLS[id];
  const onPlan = PLAN_HARNESSES.includes(id);
  const entry: HarnessEntry = {
    id,
    label: facts.label,
    steer: facts.steer,
    runMib: facts.runMib,
    oneAlwaysFits: false,
    facts,
    ...(installs ? { installs } : {}),
    ...extra,
    // Its wire's vendor's model, or that vendor's on OpenRouter; behind serve's gateway, on the wire it serves, any id,
    // which is the gateway's own string and names no provider here. One that runs on a ChatGPT plan, the plan's models.
    runs: (env, model) => (gateway && Boolean(env.AGENT_MODEL_BASE_URL)) || model.slice(0, Math.max(0, model.indexOf("/"))) === vendor || onOpenRouter(model, vendor) || (onPlan && model.startsWith(`${PLAN_PROVIDER}/`)),
    onWire: (env) => facts.ownModel || openRouterOnly(wire, env),
    model: async (env, ref, available) => (facts.ownModel && !available ? undefined : modelOn(wire, env, ref, id)),
    priceModel: (env, model) => priceModelFor(wire, env, model, id),
    adapter: make,
    route: async (env, needs) => {
      const { nativeOptions, priceOf } = await import("./adapters.js");
      const provider = providerFor(wire, env, needs.model, id);
      // A person's Claude Code login is its CLI's alone: no request of serve's own goes on it.
      if (provider.login) throw new HarnessUnavailable(`${id} runs on Claude Code's login on this machine, which only its CLI uses: this request needs a model key.`);
      const policy = facts.policy({ model: provider.modelId, tools: [], auth: provider.auth, ...nativeOptions(facts, env), ...(provider.billing === "plan" ? { plan: true } : {}) });
      return { api: wire, options: { policy, model: provider.modelId, origin: provider.origin, credential: async () => provider.credential(), price: priceOf({ ...needs, model: provider.priceModel }) } };
    },
    refusal: async (env, given, { atStart }) => {
      const { harnessInstalled, startReason } = await import("./adapters.js");
      // Signed in to a ChatGPT plan, a harness that runs on it is asked of the plan's route, which needs no key.
      const needs = given ?? { model: { provider: onPlan && signedIn(env) ? PLAN_PROVIDER : vendor, modelId: "default" }, models: { getModel: () => undefined } };
      try {
        // Not installed yet installs on first use (harness-install.ts): until then the provider decides, as it would for
        // a session.
        if (installs && !(await harnessInstalled(entry, env))) return void providerFor(wire, env, needs.model, id);
        const adapter = await make(env, needs);
        const problems = adapter.check({ key: "capabilities", label: "capabilities", system: [], tools: [], context: "fresh" });
        return problems.length ? { reason: problems.join(" ") } : undefined;
      } catch (error) {
        const keys = error instanceof HarnessUnavailable ? error.keys : undefined;
        return { reason: atStart ? startReason(error) : (error as Error).message, ...(keys?.length ? { keys } : {}) };
      }
    },
  };
  return Object.freeze(entry);
}

/** A module's adapter for one run, from `facts` and its builder: the launch serve chooses for the run's model on this
 *  server's keys (providerFor, priceOf), as gooseOf does for the built-in ACP harness. */
function moduleAdapter(facts: AdapterFacts, build: (launch: ModuleLaunch) => AgentAdapter | Promise<AgentAdapter>, { missing }: ModuleChecks) {
  return async (env: NodeJS.ProcessEnv, needs: AdapterNeeds): Promise<AgentAdapter> => {
    const { harnessLog, priceOf } = await import("./adapters.js");
    // What no key fixes is said first, as gooseOf says Goose's binary: a refusal for it names no key.
    const lacks = await missing?.(env);
    if (lacks) throw new HarnessUnavailable(lacks);
    const provider = providerFor(facts.wire, env, needs.model, facts.id);
    // A person's Claude Code login is its CLI's alone (claude-login.ts): a module's requests never go on it.
    if (provider.login) throw new HarnessUnavailable(`${facts.label} runs on a model key: Claude Code's login on this machine is its CLI's alone.`);
    return build({
      model: provider.modelId,
      provider: { origin: provider.origin, credential: provider.credential, ...(provider.auth ? { auth: provider.auth } : {}) },
      price: priceOf({ ...needs, model: provider.priceModel }),
      log: harnessLog(facts.id, env),
      ...(needs.confine ? { confine: needs.confine } : {}),
      env,
    });
  };
}

/** A module's entry is run on serve's table (its facts' adapter, cli-run-spec.ts), never by a runner's adapter of its
 *  own: this one says so if it is ever asked. The loop keeps the run's record, as for every CLI harness. */
const ON_TABLE: RunnerHarness = Object.freeze({
  record: "loop" as const,
  adapter: async () => {
    throw new Error("a harness module's adapter harness runs from its table entry (facts and adapter), not a runner adapter");
  },
});

/** What an ACP harness promises by default: a resume by the agent's session/load, tool calls through its permission asks,
 *  its model through the session's proxy (Goose's). */
const ACP_PROMISES: HarnessPromises = Object.freeze({ resume: "load", tool_gate: "permission", billing: "proxy" });

/** A module's adapter harness's whole entry (HarnessModuleKit.adapterEntry): the built-in harnesses' builder over the
 *  module's adapter, run from the table (ON_TABLE). */
const moduleEntry: HarnessModuleKit["adapterEntry"] = (facts, adapter, { missing, ...extra } = {}) =>
  Object.freeze({ ...adapterEntry(facts, moduleAdapter(facts, adapter, missing ? { missing } : {}), extra), runner: ON_TABLE });

/** A module's ACP agent's whole entry (HarnessModuleKit.acpEntry): moduleEntry over serve's own ACP adapter. */
const acpModuleEntry: HarnessModuleKit["acpEntry"] = (options) =>
  moduleEntry(options.facts, (launch) => {
    const acp = acpPackage();
    if (!acp) throw new HarnessUnavailable(`${options.facts.label} needs the ACP adapter (${ACP_PACKAGE}) beside this server`);
    return acp.acpAdapter({
      recipe: options.recipe(launch),
      proxy: options.proxy(launch),
      ...(options.beforeStart ? { beforeStart: options.beforeStart } : {}),
      ...(launch.confine ? { confine: launch.confine } : {}),
      log: launch.log,
    });
  }, { promises: options.promises ?? ACP_PROMISES, ...(options.missing ? { missing: options.missing } : {}) });

/** The kit a harness module is handed (HarnessModuleKit). */
const MODULE_KIT: HarnessModuleKit = Object.freeze({
  adapterEntry: moduleEntry,
  acpEntry: acpModuleEntry,
});

/** Cursor's entry, from its facts: billed to its owner's Cursor plan on the owner's Cursor API key (`ownKeys`), so no
 *  model key, proxy, catalog or cap of ours is its. Its model is one Cursor lists for that key, named `cursor/<model-id>`
 *  (`cursor/default`: Cursor's own default), checked against Cursor's list when its session opens (ACP_MODEL_UNLISTED).
 *  Listed only once its owner has installed it (`agentrun harness install cursor`), and stopped by its owner's turn and
 *  tool-call limits (harness-cursor.ts cursorLimitsOf), which its card says. */
function cursorEntry(facts: AdapterFacts): HarnessEntry {
  const { id } = facts;
  const prefix = `${CURSOR_PROVIDER}/`;
  const entry: HarnessEntry = {
    id,
    label: facts.label,
    steer: facts.steer,
    runMib: facts.runMib,
    oneAlwaysFits: false,
    facts,
    promises: Object.freeze({ resume: "load", tool_gate: "permission", billing: "plan" }),
    ownKeys: Object.freeze([CURSOR_KEY]),
    hidden: cursorHidden,
    card: cursorCardOf,
    runs: (_env, model) => model.startsWith(prefix),
    onWire: () => true,
    model: async (_env, ref, available) => {
      if (!available) return undefined;
      const named = ref ?? `${prefix}${CURSOR_DEFAULT_MODEL}`;
      const modelId = named.startsWith(prefix) ? named.slice(prefix.length) : "";
      const { acpPackage } = await import("./acp-package.js");
      if (!modelId || !acpPackage()?.MODEL_ID.test(modelId)) return { why: `${facts.label} runs a model Cursor lists for your Cursor API key, named ${prefix}<model-id> (${prefix}${CURSOR_DEFAULT_MODEL} for Cursor's own default); ${named} is not one.`, host: false, needs: "model" };
      return { model: { provider: CURSOR_PROVIDER, modelId } };
    },
    priceModel: (_env, model) => model,
    adapter: async (env, needs) => (await import("./adapters.js")).cursorOf(env, needs),
    refusal: async (env, given, { atStart }) => {
      const { cursorOf, startReason } = await import("./adapters.js");
      try {
        const adapter = await cursorOf(env, given ?? { model: { provider: CURSOR_PROVIDER, modelId: CURSOR_DEFAULT_MODEL }, models: { getModel: () => undefined } });
        const problems = adapter.check({ key: "capabilities", label: "capabilities", system: [], tools: [], context: "fresh" });
        return problems.length ? { reason: problems.join(" ") } : undefined;
      } catch (error) {
        return { reason: atStart ? startReason(error) : (error as Error).message };
      }
    },
  };
  return Object.freeze(entry);
}

/** The secrets the built-in harnesses own (each entry's ownKeys), whether or not its package is beside serve here: a
 *  server without Cursor's adapter still never hands CURSOR_API_KEY to another harness's run (run-secrets.ts keysFor). */
export const BUILTIN_OWN_KEYS: readonly string[] = Object.freeze([CURSOR_KEY]);

/** The harnesses this server runs, by id. */
const BUILTIN: Readonly<Record<HarnessId, HarnessEntry>> = Object.freeze({
  [DEFAULT_HARNESS]: PI,
  [claudeFacts.id]: adapterEntry(claudeFacts, async (env, needs) => (await import("./adapters.js")).claudeOf(env, needs), {
    skillCheck: async () => (await import("./adapters.js")).packageSkillCheck(() => import("@parcha/agentrun-harness-claude")),
    pins: async () => (await import("./adapters.js")).claudePins(),
  }),
  [codexFacts.id]: adapterEntry(codexFacts, async (env, needs) => (await import("./adapters.js")).codexOf(env, needs), {
    skillCheck: async () => (await import("./adapters.js")).packageSkillCheck(() => import("@parcha/agentrun-harness-codex")),
    pins: async () => (await import("./adapters.js")).codexPins(),
  }),
  [openCodeFacts.id]: adapterEntry(openCodeFacts, async (env, needs) => (await import("./adapters.js")).opencodeOf(env, needs), {
    // Checked as OpenCode is handed them (servedSkills, opencodeOf's): one size check on what it gets.
    skillCheck: async () => {
      const [{ packageSkillCheck }, { servedSkills }] = await Promise.all([import("./adapters.js"), import("./learn/workflow-draft.js")]);
      const check = await packageSkillCheck(() => import("./harness-opencode/index.js"));
      return check && ((skills) => check(servedSkills(skills)));
    },
  }),
  // Goose, over ACP, where its package is beside serve (acp-package.ts): its owner installs its pinned binary
  // (`agentrun harness install goose`, harness-goose.ts), never a run; listed only once it is installed and verified.
  ...(GOOSE_FACTS ? {
    [GOOSE_FACTS.id]: adapterEntry(GOOSE_FACTS, async (env, needs) => (await import("./adapters.js")).gooseOf(env, needs), {
      promises: ACP_PROMISES,
      hidden: gooseHidden,
    }),
  } : {}),
  // Cursor, over ACP, where the same package is beside serve: its owner installs its pinned release (`agentrun harness
  // install cursor`, harness-cursor.ts) and sets CURSOR_API_KEY; listed only once it is installed and verified.
  ...(CURSOR_FACTS ? { [CURSOR_FACTS.id]: cursorEntry(CURSOR_FACTS) } : {}),
} as Record<HarnessId, HarnessEntry>);

/** The ids of the harnesses this server has built in (Goose and Cursor where their package is beside it, as a recipe
 *  needs it too): a recipe or module never takes one (harness-recipe.ts). */
export const BUILTIN_HARNESS_IDS: readonly string[] = Object.freeze(Object.keys(BUILTIN));

const loaded = new Map<string, Readonly<Record<string, HarnessEntry>>>();
const requireHere = createRequire(import.meta.url);

/** The members a harness module's new entry gives: what the table's readers ask of every entry. */
const WHOLE = Object.freeze(["label", "steer", "runMib", "oneAlwaysFits", "runs", "onWire", "model", "priceModel", "refusal", "runner"] as const satisfies readonly (keyof HarnessEntry)[]);

/** The entries module `path` gives (HarnessTableModule), `named` saying which setting named it. */
function entriesOf(path: string, named: string): Record<string, Partial<HarnessEntry>> {
  const module = requireHere(resolve(path)) as Partial<HarnessTableModule>;
  if (typeof module.entries !== "function") throw new Error(`${named} names ${path}, which exports no entries(builtins)`);
  return module.entries(BUILTIN, MODULE_KIT);
}

/** The harness modules `env` names (HARNESS_MODULES_ENV): none when it names none. */
function modulesOf(env: NodeJS.ProcessEnv): string[] {
  const given = env[HARNESS_MODULES_ENV];
  if (!given) return [];
  const paths: unknown = JSON.parse(given);
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) throw new Error(`${HARNESS_MODULES_ENV} is a JSON array of module paths`);
  return paths;
}

const harnessId = new RegExp(HARNESS_ID_PATTERN);

/** The table `env` runs on: the built-in entries; then, only under a test runner (node --test's NODE_TEST_CONTEXT, which a
 *  server's and a run's processes there carry), a test's module's (HARNESS_TABLE_ENV) merged over them by id; then the
 *  harnesses each of the owner's harness modules adds (HARNESS_MODULES_ENV), under a test runner or not. A module adds
 *  whole entries of new ids: one whose id is not one the API carries (HARNESS_ID_PATTERN), naming a name serve's own runs
 *  carry or every object has (RESERVED_HARNESS_IDS: a learning run's `learning` would reach the learning loop, and
 *  `constructor` would read Object's own member where serve looks a harness up in a plain object), naming a built-in harness, an
 *  id another module adds, or an entry missing a member is refused by name, so no module changes what a built-in harness
 *  is (grep pins claude-agent). Loaded once per setting. */
export function harnessTable(env: NodeJS.ProcessEnv): Readonly<Record<string, HarnessEntry>> {
  const path = env.NODE_TEST_CONTEXT ? env[HARNESS_TABLE_ENV] : undefined;
  const modules = modulesOf(env);
  if (!path && !modules.length) return BUILTIN;
  const key = JSON.stringify([path ?? null, modules]);
  let table = loaded.get(key);
  if (!table) {
    const built: Record<string, HarnessEntry> = { ...BUILTIN };
    if (path) for (const [id, entry] of Object.entries(entriesOf(path, HARNESS_TABLE_ENV))) built[id] = Object.freeze({ ...(BUILTIN as Record<string, HarnessEntry>)[id], ...entry, id }) as HarnessEntry;
    for (const module of modules) {
      for (const [id, entry] of Object.entries(entriesOf(module, HARNESS_MODULES_ENV))) {
        if (!harnessId.test(id)) throw new Error(`harness module ${module} names ${id}, which is not a harness id: an id matches ${HARNESS_ID_PATTERN}`);
        if (RESERVED_HARNESS_IDS.includes(id)) throw new Error(`harness module ${module} names ${id}, a name serve's own runs carry or every object already has: a module's harness takes none of ${RESERVED_HARNESS_IDS.join(", ")}`);
        if (Object.hasOwn(BUILTIN, id)) throw new Error(`harness module ${module} names ${id}, a built-in harness: a module adds a harness and never replaces one`);
        if (Object.hasOwn(built, id)) throw new Error(`harness module ${module} names ${id}, which another module already adds`);
        const missing = WHOLE.filter((member) => entry[member] === undefined);
        if (missing.length) throw new Error(`harness module ${module}: its entry ${id} lacks ${missing.join(", ")}`);
        built[id] = Object.freeze({ ...entry, id }) as HarnessEntry;
      }
    }
    table = Object.freeze(built);
    loaded.set(key, table);
  }
  return table;
}

/** The owner's setting that names harness modules when no option does: package names or paths, comma-separated. */
export const HARNESS_MODULES_SETTING = "AGENTRUN_SERVE_HARNESS_MODULES";

/** The harness modules `given` names (a server's or a runner's `--harness-module`, else HARNESS_MODULES_SETTING): none
 *  when neither names one. */
export const harnessModulesOf = (given: readonly string[] | undefined, env: NodeJS.ProcessEnv): string[] =>
  given?.length ? [...given] : (env[HARNESS_MODULES_SETTING] ?? "").split(",").map((name) => name.trim()).filter(Boolean);

/** Each harness module `names` names, as the absolute path HARNESS_MODULES_ENV carries: a path as it resolves; a package
 *  from `<data>/harnesses` (where its owner installs it: npm install --prefix <data>/harnesses <package>), else from
 *  where the server runs. One that resolves nowhere refuses the start, naming the command that installs it. */
export function harnessModulePaths(names: readonly string[], data: string): string[] {
  return names.map((name) => {
    if (name.startsWith("/") || name.startsWith(".")) return resolve(name);
    for (const from of [join(resolve(data), "harnesses", "package.json"), join(process.cwd(), "package.json")]) {
      try {
        return createRequire(from).resolve(name);
      } catch {
        // Not there: the next place.
      }
    }
    throw new Error(`harness module ${name} is not installed: npm install --prefix ${join(resolve(data), "harnesses")} ${name}`);
  });
}

/** HARNESS_MODULES_ENV for the harness modules `names` names: none for none. */
export const harnessModulesEnv = (names: readonly string[], data: string): NodeJS.ProcessEnv => (names.length ? { [HARNESS_MODULES_ENV]: JSON.stringify(harnessModulePaths(names, data)) } : {});

/** The ids of the harnesses `env`'s table lists, in its order: the built-in ones (pi first), then those its modules add;
 *  not one its entry hides on `env` (HarnessEntry.hidden: Goose until it is installed). */
export const harnessIds = (env: NodeJS.ProcessEnv): readonly string[] => Object.entries(harnessTable(env)).filter(([, entry]) => entry.hidden?.(env) === undefined).map(([id]) => id);

/** The ids of every harness `env`'s table has, hidden ones too: those a definition may name (a save warns of a hidden one,
 *  a run is refused with why). */
export const tableIds = (env: NodeJS.ProcessEnv): readonly string[] => Object.keys(harnessTable(env));

/** The built-in entry of harness `id` (none: the default, pi), for what a test's entry never changes: its memory (host.ts),
 *  which a stand-in reserves as the harness it stands in for does, so tests admit as a real server does. */
export const builtinHarness = (id: string | undefined): HarnessEntry | undefined => (BUILTIN as Record<string, HarnessEntry>)[id ?? DEFAULT_HARNESS];

/** The owner's table on `env`: the built-in entries and those its harness modules add (HARNESS_MODULES_ENV), never a test
 *  table's. What a run weighs and whether one fits (host.ts, runner/memory-claim.ts) read it, so a test's stand-in admits
 *  as the built-in harness it stands in for, and a module's harness as its entry declares. */
export const ownerTable = (env: NodeJS.ProcessEnv): Readonly<Record<string, HarnessEntry>> => harnessTable(env[HARNESS_MODULES_ENV] ? { [HARNESS_MODULES_ENV]: env[HARNESS_MODULES_ENV] } : {});

/** The entry of harness `id` (none: the default, pi) on the owner's table (ownerTable); undefined for one it has not. */
export const ownerHarness = (env: NodeJS.ProcessEnv, id: string | undefined): HarnessEntry | undefined => {
  const table = ownerTable(env);
  const key = id ?? DEFAULT_HARNESS;
  return Object.hasOwn(table, key) ? table[key] : undefined;
};

/** The facts of harness `id`'s adapter on the owner's table (ownerTable: the built-in harnesses and those `env`'s modules
 *  add, never a test table's, so a stand-in keeps the facts of the harness it stands in for). Every reader of a harness's
 *  facts by id asks here: its models (model-form.ts), its key rows (model.ts), its search and tool names (tool-plane.ts,
 *  tool-gate.ts). Undefined for pi, for a module's harness that gives none, and for an id the table has none of. */
export const factsOf = (env: NodeJS.ProcessEnv, id: string | undefined): AdapterFacts | undefined => ownerHarness(env, id)?.facts;

/** The entry of harness `id` (none: the default, pi) on `env`'s table; undefined for an id this server has none of. */
export const harnessOf = (env: NodeJS.ProcessEnv, id: string | undefined): HarnessEntry | undefined => harnessTable(env)[id ?? DEFAULT_HARNESS];

/** Whether `id` runs on an adapter (every harness but pi): a session of its own, beside the run's process. */
export const onAdapter = (env: NodeJS.ProcessEnv, id: string | undefined): boolean => harnessOf(env, id)?.facts !== undefined;

/** The harness a definition stores: none for the default, which is never stored. */
export const storedHarness = (id: string | undefined): string | undefined => (id === undefined || id === DEFAULT_HARNESS ? undefined : id);
