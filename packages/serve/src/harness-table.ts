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
import { resolve } from "node:path";
import type { AdapterFacts, AgentAdapter } from "@parcha/agentrun-kernel";
import type { ModelProxyOptions } from "@parcha/agentrun-kernel/host";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
import { facts as openCodeFacts } from "./harness-opencode/facts.js";
import type { AdapterNeeds } from "./adapters.js";
import { DEFAULT_HARNESS, type HarnessId } from "./harness.js";
import { HARNESS_INSTALLS, type HarnessInstallEntry, type HarnessPins } from "./harness-install.js";
import { chooseModel } from "./model.js";
import { HarnessUnavailable, type ModelChoice, modelOn, openRouterOnly, priceModelFor, providerFor } from "./provider.js";
import { WIRES } from "./wires.js";
import type { SkillCheck } from "./skills.js";

/** A module of entries a test merges over the built-in ones (HarnessTableModule), by absolute path. */
export const HARNESS_TABLE_ENV = "AGENTRUN_HARNESS_TABLE";

/** Why a harness cannot run here, in words a person can act on, and the model keys any one of which would let it
 *  (HarnessUnavailable's `keys`). */
export type Refusal = { reason: string; keys?: readonly string[] };

/** The model route a session's proxy takes for a run (a session proxy's options, ModelProxyOptions): the API, and the policy, model,
 *  endpoint, credential and price its adapter's own proxy is given. */
export type SessionRoute = { api: AdapterFacts["wire"]; options: Pick<ModelProxyOptions, "policy" | "model" | "origin" | "credential" | "price"> };

export interface HarnessEntry {
  readonly id: string;
  /** Whether it takes a message mid-turn; else a message waits for the turn's end. */
  readonly steer: boolean;
  /** What one of its runs reserves in memory while its process lives, in MiB (host.ts). */
  readonly runMib: number;
  /** Whether it binds a run's remote MCP servers. */
  readonly mcp: boolean;
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
}

/** What a test's table module exports: entries by id, each merged over the built-in one of that id (all of it, for one
 *  the server has none of), given the built-ins to build on. Loaded with require: the module has no top-level await. */
export type HarnessTableModule = { entries(builtins: Readonly<Record<string, HarnessEntry>>): Record<string, Partial<HarnessEntry>> };

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
  steer: true,
  runMib: 128,
  mcp: true,
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
function adapterEntry(facts: AdapterFacts, make: (env: NodeJS.ProcessEnv, needs: AdapterNeeds) => Promise<AgentAdapter>, extra: Pick<HarnessEntry, "skillCheck" | "pins"> = {}): HarnessEntry {
  const { wire, id } = facts;
  const { vendor, gateway } = WIRES[wire];
  const installs = HARNESS_INSTALLS[id];
  const entry: HarnessEntry = {
    id,
    steer: facts.steer,
    runMib: facts.runMib,
    mcp: facts.mcp,
    oneAlwaysFits: false,
    facts,
    ...(installs ? { installs } : {}),
    ...extra,
    // Its wire's vendor's model, or that vendor's on OpenRouter; behind serve's gateway, on the wire it serves, any id,
    // which is the gateway's own string and names no provider here.
    runs: (env, model) => (gateway && Boolean(env.AGENT_MODEL_BASE_URL)) || model.slice(0, Math.max(0, model.indexOf("/"))) === vendor || onOpenRouter(model, vendor),
    onWire: (env) => facts.ownModel || openRouterOnly(wire, env),
    model: async (env, ref, available) => (facts.ownModel && !available ? undefined : modelOn(wire, env, ref, id)),
    priceModel: (env, model) => priceModelFor(wire, env, model, id),
    adapter: make,
    route: async (env, needs) => {
      const { nativeOptions, priceOf } = await import("./adapters.js");
      const provider = providerFor(wire, env, needs.model, id);
      const policy = facts.policy({ model: provider.modelId, tools: [], auth: provider.auth, ...nativeOptions(facts, env) });
      return { api: wire, options: { policy, model: provider.modelId, origin: provider.origin, credential: async () => provider.credential(), price: priceOf({ ...needs, model: provider.priceModel }) } };
    },
    refusal: async (env, given, { atStart }) => {
      const { harnessInstalled, startReason } = await import("./adapters.js");
      const needs = given ?? { model: { provider: vendor, modelId: "default" }, models: { getModel: () => undefined } };
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
    skillCheck: async () => (await import("./adapters.js")).packageSkillCheck(() => import("./harness-opencode/index.js")),
  }),
} as Record<HarnessId, HarnessEntry>);

const loaded = new Map<string, Readonly<Record<string, HarnessEntry>>>();
const requireHere = createRequire(import.meta.url);

/** The table `env` runs on: the built-in entries, with a test's module's (HARNESS_TABLE_ENV) merged over them. */
export function harnessTable(env: NodeJS.ProcessEnv): Readonly<Record<string, HarnessEntry>> {
  const path = env[HARNESS_TABLE_ENV];
  if (!path) return BUILTIN;
  let table = loaded.get(path);
  if (!table) {
    const module = requireHere(resolve(path)) as Partial<HarnessTableModule>;
    if (typeof module.entries !== "function") throw new Error(`${HARNESS_TABLE_ENV} names ${path}, which exports no entries(builtins)`);
    const given = module.entries(BUILTIN);
    table = Object.freeze({ ...BUILTIN, ...Object.fromEntries(Object.entries(given).map(([id, entry]) => [id, Object.freeze({ ...(BUILTIN as Record<string, HarnessEntry>)[id], ...entry, id }) as HarnessEntry])) });
    loaded.set(path, table);
  }
  return table;
}

/** The built-in entry of harness `id` (none: the default, pi), for what a test's entry never changes: its memory (host.ts),
 *  which a stand-in reserves as the harness it stands in for does, so tests admit as a real server does. */
export const builtinHarness = (id: string | undefined): HarnessEntry | undefined => (BUILTIN as Record<string, HarnessEntry>)[id ?? DEFAULT_HARNESS];

/** The entry of harness `id` (none: the default, pi) on `env`'s table; undefined for an id this server has none of. */
export const harnessOf = (env: NodeJS.ProcessEnv, id: string | undefined): HarnessEntry | undefined => harnessTable(env)[id ?? DEFAULT_HARNESS];

/** Whether `id` runs on an adapter (every harness but pi): a session of its own, beside the run's process. */
export const onAdapter = (env: NodeJS.ProcessEnv, id: string | undefined): boolean => harnessOf(env, id)?.facts !== undefined;

/** The harness a definition stores: none for the default, which is never stored. */
export const storedHarness = (id: string | undefined): string | undefined => (id === undefined || id === DEFAULT_HARNESS ? undefined : id);
