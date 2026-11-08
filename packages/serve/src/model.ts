// Where a run's model comes from. An agentic revision names one as "provider/model-id", or names none and runs on this
// host's default (`AGENT_MODEL`). A workflow's model node names a tier, and the host maps it: fast to
// `AGENT_MODEL_FAST`, strong to `AGENT_MODEL_STRONG`, each falling back to the default. With `--faux` every model is the
// faux module's (no key, no network); with `AGENT_MODEL_BASE_URL` every model id goes to that one OpenAI Responses
// gateway; otherwise pi-ai's providers serve it, each with its keys from the server's secrets (PROVIDER_KEYS): the
// launcher hands the server every one, and a run's process those of its model's provider, never in an environment.
import { withLocalModels } from "./local-models.js";
import { pathToFileURL } from "node:url";
import type { ModelCost, ModelThinkingLevel, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { DEFAULT_HARNESS } from "./harness.js";
import { HARNESS_TABLE_ENV, harnessOf } from "./harness-table.js";
import { gatewayBase } from "./provider.js";
// Leaves, which the key rows below read as this module loads, in any import order (wires.ts, adapter-facts.ts).
import { ADAPTER_FACTS } from "./adapter-facts.js";
import { WIRES } from "./wires.js";
import { authContextOf } from "./secrets.js";

/** The child's environment names the faux module by absolute path. */
export const FAUX_ENV = "AGENTRUN_SERVE_FAUX";
/** Every test hook's name starts so (AGENTRUN_SERVE_FAUX, AGENTRUN_SERVE_FAUX_WEB, ...), but the harness table's
 *  (harness-table.ts HARNESS_TABLE_ENV), which withoutFaux drops by name. */
export const FAUX_PREFIX = "AGENTRUN_SERVE_FAUX";
/** `env` without a test hook's name: serve sets those from startServe's options alone, so a name the server's own
 *  environment holds (an operator's export, a leftover) never gives its runs fake answers or loads a module. */
export const withoutFaux = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith(FAUX_PREFIX) && name !== HARNESS_TABLE_ENV));
/** Under `--faux` only: a module whose default export is the fetch the Anthropic and OpenAI providers send through (the
 *  tests' fake upstream), in place of their APIs. With it they are registered beside the faux model, for a tool's own
 *  request to the provider the revision's model names (web_search's, hosted-search.ts); the run's turns stay faux. */
export const FAUX_UPSTREAM_ENV = "AGENTRUN_SERVE_FAUX_UPSTREAM";
/** A run's `effort`, passed to its child. */
export const EFFORT_ENV = "AGENTRUN_SERVE_EFFORT";
/** The model the server's keys give a run that names none (hostModel at the run's launch, from every key the server
 *  holds), passed to its child as its effort is: behind a gateway the run holds the gateway's key alone, never the key
 *  that names its default (runs.ts). A model id, never a secret, so its name has no secret's segment (pi-durable-disk's
 *  secret-name rule): a harness's log keeps it (adapters.ts harnessLog). */
export const DEFAULT_MODEL_ENV = "AGENTRUN_SERVE_DEFAULT_MODEL";
export const MODEL_PROVIDER = "agent-model";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
/** The thinking levels a revision or the host may name. Never off. */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TIERS = ["fast", "default", "strong"] as const;
export type Tier = (typeof TIERS)[number];
const TIER_ENV: Record<Tier, string> = { fast: "AGENT_MODEL_FAST", default: "AGENT_MODEL", strong: "AGENT_MODEL_STRONG" };
/** The workflow node kinds that run on a model. */
export const MODEL_NODES = ["agent", "decide", "extract", "report"] as const;

/** The model providers whose key a person may save here (tool-keys.ts' `model` rows), in the order a default is taken
 *  from, each with the model a run gets on its key when neither its revision nor the host names one: the provider's
 *  capable everyday model, not its dearest (Claude Sonnet 5.5 and GPT-6.1 Sol, each $2 in and $10 out per million
 *  tokens). `harnesses`: those that run on the key, pi on any model of it and the harnesses that talk to that
 *  provider's own API (OpenAI's: codex and opencode); OpenRouter's runs them all. `models`: a harness's own default on the
 *  key where it is not `model`. On OpenRouter:
 *  pi's is GPT-6 Sol on pi-ai's openrouter provider (/chat/completions, the key as a bearer token, as OpenRouter's docs
 *  name it; its Anthropic models go to /v1/messages with the key in x-api-key, which the docs do not), claude-agent's
 *  Claude Sonnet 5.5 and codex's and opencode's GPT-6 Sol, each through OpenRouter's own endpoint for the harness (adapters.ts), the ids
 *  a live run took through OpenRouter on 2026-10-29. The row order is the order a default is taken in: a direct
 *  provider's key wins over OpenRouter's. */
export const MODEL_KEYS: readonly { id: string; label: string; field: string; model: string; harnesses: readonly string[]; byVendor?: Readonly<Record<string, string>> }[] = Object.freeze([
  { id: "anthropic", label: "Anthropic", field: "ANTHROPIC_API_KEY", model: "anthropic/claude-sonnet-5-5", harnesses: onVendor("anthropic") },
  { id: "openai", label: "OpenAI", field: "OPENAI_API_KEY", model: "openai/gpt-6.1-sol", harnesses: onVendor("openai") },
  // OpenRouter serves both wires: every harness runs on its key, an adapter harness on its wire's vendor's model there.
  { id: "openrouter", label: "OpenRouter", field: "OPENROUTER_API_KEY", model: "openrouter/openai/gpt-6-sol", harnesses: [DEFAULT_HARNESS, ...ADAPTER_FACTS.map((facts) => facts.id)], byVendor: { anthropic: "anthropic/claude-sonnet-5.5", openai: "openai/gpt-6-sol" } },
]);

/** pi, and the adapter harnesses whose wire (their facts') runs `vendor`'s models: those that talk to its own API. */
function onVendor(vendor: string): readonly string[] {
  return [DEFAULT_HARNESS, ...ADAPTER_FACTS.filter((facts) => WIRES[facts.wire].vendor === vendor).map((facts) => facts.id)];
}

/** `row`'s default for `harness`: the one for its wire's vendor (`byVendor`, OpenRouter's), else the row's. */
const rowModel = (row: (typeof MODEL_KEYS)[number], harness: string): string => {
  const facts = ADAPTER_FACTS.find((f) => f.id === harness);
  return (facts && row.byVendor?.[WIRES[facts.wire].vendor]) ?? row.model;
};

/** What a person does when no model runs here: add a model provider's key in the console, or set one where AgentRun
 *  starts (MODEL_KEYS' fields), OpenRouter's named first, as its one key runs every harness. The order a default is
 *  taken in is MODEL_KEYS' own. */
export const ADD_A_KEY = `add a model key in Settings → Model keys, or set ${[...MODEL_KEYS].sort((a, b) => Number(b.id === "openrouter") - Number(a.id === "openrouter")).map((row) => row.field).join(", ").replace(/, ([^,]+)$/, " or $1")} where AgentRun starts.`;

/** Whether `harness` runs the model `id` (its entry in the harness table: harness-table.ts): pi any; one on an adapter, its
 *  wire's vendor's model (or that vendor's on OpenRouter), or behind serve's gateway, on the wire it serves, any id. */
export const harnessRuns = (env: NodeJS.ProcessEnv, id: string, harness: string): boolean => harnessOf(env, harness)?.runs(env, id) ?? true;

/** The model a revision that names none runs on with `harness`, for `tier`: the tier's own variable, else AGENT_MODEL,
 *  each only when `harness` runs it (harnessRuns; one it can't is skipped, never an error), else that of the first of
 *  MODEL_KEYS whose key is here (a placeholder behind a base URL counts) and that `harness` runs on, else, in a run's
 *  process that holds none of those keys, the one the server's keys gave it (DEFAULT_MODEL_ENV). Undefined when none is:
 *  the harness has no default here. */
export function hostModel(env: NodeJS.ProcessEnv, tier: Tier = "default", harness: string = DEFAULT_HARNESS): string | undefined {
  for (const id of [env[TIER_ENV[tier]], env.AGENT_MODEL]) if (id && harnessRuns(env, id, harness)) return id;
  const row = MODEL_KEYS.find((row) => env[row.field] && (row.harnesses as readonly string[]).includes(harness));
  return row ? rowModel(row, harness) : env[DEFAULT_MODEL_ENV] || undefined;
}
/** A faux model id per tier: `faux-1`, or the id a tier's variable names. */
const fauxModel = (env: NodeJS.ProcessEnv, tier: Tier): string => (tier === "default" ? undefined : env[TIER_ENV[tier]]) || "faux-1";

/** `route_prefix`: the routing prefix this server puts before a gateway's model ids (MODEL_PROVIDER), which a reader takes off
 *  to show the gateway's own id; null with any other source. */
/** The values `models.source` takes here: a faux module, a gateway, or each provider with its own key. */
export const MODEL_SOURCES = ["faux", "gateway", "providers"] as const;
export type ModelSource = { source: (typeof MODEL_SOURCES)[number]; route_prefix: string | null } & Record<Tier, string | null>;

/** What capabilities say about models here: where they come from, and the model of each tier (`default` is also what a
 *  revision that names none runs on). */
export function modelSource(env: NodeJS.ProcessEnv): ModelSource {
  const each = (name: (tier: Tier) => string | null) => Object.fromEntries(TIERS.map((tier) => [tier, name(tier)])) as Record<Tier, string | null>;
  if (env[FAUX_ENV]) return { source: "faux", route_prefix: null, ...each((tier) => `faux/${fauxModel(env, tier)}`) };
  if (env.AGENT_MODEL_BASE_URL) return { source: "gateway", route_prefix: MODEL_PROVIDER, ...each((tier) => (hostModel(env, tier) ? `${MODEL_PROVIDER}/${hostModel(env, tier)}` : null)) };
  return { source: "providers", route_prefix: null, ...each((tier) => hostModel(env, tier) ?? null) };
}

/** A workflow's nodes as the DSL's inspection lists them, each read from the document at its path: only what the
 *  workflow's structure makes a node, never data shaped like one (a node's `state` may hold an example node). */
export function workflowNodes(workflow: unknown, inspection: { nodes: readonly { path: string }[] }): Record<string, unknown>[] {
  const at = (path: string) => path.split("/").slice(1).reduce<unknown>((value, part) => (value as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")], workflow);
  return inspection.nodes.map(({ path }) => at(path) as Record<string, unknown>);
}

/** The tiers a workflow's model nodes name (`nodes` from workflowNodes); a node that names none is `default`. */
export function nodeTiers(nodes: readonly Record<string, unknown>[]): Tier[] {
  const tiers = new Set<Tier>();
  for (const node of nodes) {
    const model = (MODEL_NODES as readonly unknown[]).includes(node.node) || (node.node === "artifact" && ["markdown", "report"].includes(String(node.type)));
    if (model) tiers.add((TIERS as readonly unknown[]).includes(node.tier) ? (node.tier as Tier) : "default");
  }
  return TIERS.filter((tier) => tiers.has(tier));
}

/** A `{dot.path}` the DSL fills in from the state when the node runs. */
const TEMPLATE = /\{[a-zA-Z0-9_.$]+\}/;

/** `tiers` with those a workflow's `llm` calls name (`args.tier`, else default) added: an `llm` call completes on the
 *  model of its tier, as a model node does. A tier the state fills in when the call runs (`"{requestedTier}"`, or args
 *  filled in whole) may be any of the three, so it adds all three. */
export function llmTiers(nodes: readonly Record<string, unknown>[], tiers: readonly Tier[]): Tier[] {
  const all = new Set(tiers);
  for (const node of nodes) {
    if (node.node !== "call" || node.via !== "tool" || node.tool !== "llm") continue;
    const tier = typeof node.args === "string" ? node.args : (node.args as { tier?: unknown } | undefined)?.tier;
    if (typeof tier === "string" && TEMPLATE.test(tier)) TIERS.forEach((each) => all.add(each));
    else all.add((TIERS as readonly unknown[]).includes(tier) ? (tier as Tier) : "default");
  }
  return TIERS.filter((tier) => all.has(tier));
}

export type ModelRef = { provider: string; modelId: string };
/** What a run that cannot have its model here needs: a provider's key, or another model. */
export type ModelNeeds = "key" | "model";

/**
 * The model a revision runs on here, or why it cannot: `ref` is an agentic revision's "provider/model-id", absent for
 * the host's model of `tier`. Through the gateway the ref goes whole, as a gateway such as OpenRouter names its models
 * `vendor/model` (with `AGENT_MODEL_GATEWAY_IDS=bare`, only the part after the provider), and `namedProvider` is that
 * provider, whose catalog entry prices the model. `host` says a setting of this host (a key, a default model) could
 * make it reachable; a model the revision names that pi-ai does not know is not. `needs`: what would: a provider's key
 * (none names a model, or the model's provider has no key here), or another model. `harness` picks the host's model
 * when `ref` is absent (hostModel).
 */
export async function chooseModel(env: NodeJS.ProcessEnv, ref: string | undefined, tier: Tier = "default", harness: string = DEFAULT_HARNESS): Promise<{ model: ModelRef; namedProvider?: string } | { why: string; host: boolean; needs: ModelNeeds }> {
  if (env[FAUX_ENV]) return { model: { provider: "faux", modelId: fauxModel(env, tier) } };
  const named = ref ?? hostModel(env, tier, harness);
  // In a person's words (a first run from npx sees them): what to add and where. Operator detail is the README's.
  const none = tier === "default" ? "No model yet" : `No model yet for this workflow's ${tier} tier`;
  if (env.AGENT_MODEL_BASE_URL) {
    // A gateway its key may not go to (the one base rule, gatewayBase) runs no model, in its words: capabilities read it
    // not ready, a save warns, and a run is refused before its process starts, so the key is never handed to one.
    try {
      gatewayBase("AGENT_MODEL_BASE_URL", env.AGENT_MODEL_BASE_URL);
    } catch (error) {
      return { why: (error as Error).message, host: true, needs: "key" };
    }
    if (!named) return { why: `${none}: name the gateway's model in AGENT_MODEL where AgentRun starts, or add a model key in Settings → Model keys.`, host: true, needs: "key" };
    // A revision's model, and a key's default (MODEL_KEYS: "provider/model"), go as the gateway takes its ids (bare: the
    // part after the provider), that provider pricing them; the host's own AGENT_MODEL or tier id goes as configured.
    const id = ref ?? ([env[TIER_ENV[tier]], env.AGENT_MODEL].includes(named) ? undefined : named);
    const slash = id?.indexOf("/") ?? -1;
    const sent = id && env.AGENT_MODEL_GATEWAY_IDS === "bare" ? id.slice(slash + 1) : named;
    return { model: { provider: MODEL_PROVIDER, modelId: sent }, ...(id && slash > 0 ? { namedProvider: id.slice(0, slash) } : {}) };
  }
  if (!named) return { why: `${none}: ${ADD_A_KEY}`, host: true, needs: "key" };
  const slash = named.indexOf("/");
  if (slash < 1) return { why: `The host's default model ${named} is not a provider/model-id.`, host: true, needs: "model" };
  const [provider, modelId] = [named.slice(0, slash), named.slice(slash + 1)];
  const models = await providerModels(env);
  const model = models.getModel(provider, modelId);
  if (!model) return { why: `pi-ai knows no model ${modelId} of ${provider}. Name one of its models, or route every model through a gateway with AGENT_MODEL_BASE_URL.`, host: ref === undefined, needs: "model" };
  // A gateway ANTHROPIC_BASE_URL names that a key may not go to (gatewayBase): no Anthropic model runs, by its words.
  const refused = provider === "anthropic" ? anthropicRefusal(models) : undefined;
  if (refused) return { why: refused, host: true, needs: "key" };
  if (!(await models.getAuth(model))) {
    const row = MODEL_KEYS.find((r) => r.id === provider);
    const field = row?.field ?? models.getProvider(provider)?.auth.apiKey?.name ?? "its API key";
    return { why: `No ${row?.label ?? provider} key here for ${named}: ${row ? `add one in Settings → Model keys, or set ${field}` : `set ${field}`} where AgentRun starts.`, host: true, needs: "key" };
  }
  return { model: { provider, modelId } };
}

/**
 * The keys each of pi-ai's providers reads, by its id: pi-ai's own table (env-api-keys' findEnvKeys), and Amazon
 * Bedrock's AWS keys, which that table leaves out as ambient. Every one is on the launcher's list (secrets.ts'
 * SECRET_NAMES), so the server holds it and no environment does, and a run's process is handed a provider's keys over
 * its pipe only when a model it runs is that provider's (runs.ts' secretsFor), as its model's provider reads them from
 * the run's auth context. The custody test checks this against the pi-ai installed, so one that reads another key fails
 * there.
 */
export const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
  "ant-ling": ["ANT_LING_API_KEY"],
  anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  meta: ["META_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  typesafe: ["TYPESAFE_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
};

/** The keys pi-ai reads at a request, from the request's `env` option (else the process's environment), past the auth
 *  context: Bedrock's, whose request builds its AWS credentials itself. */
const REQUEST_KEYS = PROVIDER_KEYS["amazon-bedrock"]!;

/** The gateway's key (AGENT_MODEL_BASE_URL's), which its every model is reached on. */
export const GATEWAY_KEY_ENV = "AGENT_MODEL_API_KEY";

/** The model keys a pi run takes, by the models chooseModel picks for it: the keys of each one's provider (PROVIDER_KEYS),
 *  the default tier's from `ref` (an agentic revision's own) else the host's default, each other tier's the host's model
 *  of that tier; through a gateway (`AGENT_MODEL_BASE_URL`), where every model is the gateway's, its key alone. Asked as
 *  chooseModel is, faux or not, so a run on the faux model is handed what a run on its model would be. */
export function modelKeys(env: NodeJS.ProcessEnv, ref: string | undefined, tiers: readonly Tier[] = ["default"]): string[] {
  if (env.AGENT_MODEL_BASE_URL) return [GATEWAY_KEY_ENV];
  const named = tiers.map((tier) => (tier === "default" ? ref : undefined) ?? hostModel(env, tier));
  const providers = named.flatMap((name) => (name && name.indexOf("/") > 0 ? [name.slice(0, name.indexOf("/"))] : []));
  return [...new Set(providers.flatMap((provider) => PROVIDER_KEYS[provider] ?? []))];
}

/** A run's thinking level: its `effort`, else its revision's `thinking`, else the host's `AGENT_THINKING`, else medium.
 *  Never off. */
export function thinkingOf(env: NodeJS.ProcessEnv, revision?: string): ModelThinkingLevel {
  const level = [env[EFFORT_ENV], revision, env.AGENT_THINKING].find((name) => (THINKING_LEVELS as readonly unknown[]).includes(name));
  return (level ?? "medium") as ModelThinkingLevel;
}

/** The helpers a faux module's reply gets, so it needs no import of its own. */
export type FauxHelpers = {
  /** Aborted when the turn is stopped: a slow reply resolves with `message("", { stopReason: "aborted" })`. */
  signal?: AbortSignal;
  /** The model the request names (`faux-1`, or the id a tier's variable names). */
  model?: string;
  message: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
  text: typeof import("@earendil-works/pi-ai").fauxText;
  thinking: typeof import("@earendil-works/pi-ai").fauxThinking;
  toolCall: typeof import("@earendil-works/pi-ai").fauxToolCall;
};

/** The models for a run, and its model of each tier it uses and of no other: an agentic revision's `ref` (or the
 *  default) is its `default`, and a workflow's tiers are the ones its nodes name. The faux module's replies, the gateway
 *  in the environment, or pi-ai's providers. `unpriced`: the ids of its models serve has no price for (a gateway model the
 *  catalog does not list, with no price set), which a cap cannot be kept on. */
export async function runModels(env: NodeJS.ProcessEnv, ref: string | undefined, tiers: readonly Tier[] = ["default"], harness: string = DEFAULT_HARNESS) {
  const ai = await import("@earendil-works/pi-ai");
  const { createModels, createProvider } = await import("@earendil-works/pi-ai/models");
  const faux = env[FAUX_ENV];
  const byTier = new Map<Tier, ModelRef>();
  const namedBy = new Map<Tier, string>();
  for (const tier of new Set(tiers)) {
    const chosen = await chooseModel(env, tier === "default" ? ref : undefined, tier, harness);
    if ("why" in chosen) throw new Error(chosen.why);
    byTier.set(tier, chosen.model);
    if (chosen.namedProvider) namedBy.set(tier, chosen.namedProvider);
  }
  const model = byTier.get("default");
  if (!faux && !env.AGENT_MODEL_BASE_URL) {
    // Each provider's key from `env`, which holds this process's secrets, never from process.env (secrets.ts); Anthropic's
    // at ANTHROPIC_BASE_URL when set (providerModels).
    return { models: withRequestKeys(await providerModels(env), env), model, byTier, unpriced: new Set<string>() };
  }
  const ids = [...new Set([...byTier.values()].map((m) => m.modelId))];
  const models = createModels({ authContext: authContextOf(env) });
  const unpriced = new Set<string>();
  if (!ids.length) return { models, model, byTier, unpriced };
  if (faux) {
    type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
    const mod = (await import(pathToFileURL(faux).href)) as { default?: unknown; cost?: Tokens | "unknown"; contextWindow?: number; maxTokens?: number; usage?: (context: unknown, usage: Tokens) => Tokens };
    const price = typeof mod.cost === "object" ? mod.cost : undefined;
    if (typeof mod.default !== "function") throw new Error(`the faux module ${faux} has no default export function`);
    const reply = mod.default as (context: unknown, helpers: FauxHelpers) => unknown;
    const helpers: FauxHelpers = { message: ai.fauxAssistantMessage, text: ai.fauxText, thinking: ai.fauxThinking, toolCall: ai.fauxToolCall };
    // `contextWindow` sizes the faux model's window, so a test can make a run long enough to compact; `maxTokens` its
    // output ceiling, so a test can price a request's whole output allowance as a real model's (64,000 on Sonnet 4.5),
    // or run one whose ceiling bounds nothing (cap.ts noCeiling).
    const core = ai.createFauxCore({ models: ids.map((id) => ({ id, ...(price ? { cost: price } : {}), ...(typeof mod.contextWindow === "number" ? { contextWindow: mod.contextWindow } : {}), ...(typeof mod.maxTokens === "number" ? { maxTokens: mod.maxTokens } : {}) })) as [{ id: string }, ...{ id: string }[]] });
    const step = (async (context: unknown, options?: { signal?: AbortSignal }, _state?: unknown, model?: { id?: string }) => reply(context, { ...helpers, ...(options?.signal ? { signal: options.signal } : {}), ...(model?.id ? { model: model.id } : {}) })) as unknown as Parameters<typeof core.setResponses>[0][number];
    core.setResponses(Array.from({ length: 10_000 }, () => step));
    // `cost` (USD per million tokens) prices the faux model's usage, which the faux core leaves at $0, so a run's
    // estimate and its cap can be tested; "unknown" leaves its usage with no cost, as a provider that does not price it.
    const priced: typeof core.stream = (model, context, options) => {
      const inner = core.stream(model, context, options);
      if (!mod.cost) return inner;
      const outer = ai.createAssistantMessageEventStream();
      void (async () => {
        let last: Parameters<typeof outer.end>[0];
        for await (const event of inner) {
          const message = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
          if (message) {
            // `usage` (a faux module's own) reports the reply's tokens as a provider would, a cache's reads and writes among
            // them, in place of the faux core's estimate, so a test can price a run that reads the cache.
            if (typeof mod.usage === "function") {
              const tokens = mod.usage(context, message.usage);
              message.usage = { ...message.usage, ...tokens, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite };
            }
            if (price) message.usage.cost = ai.calculateCost(model, message.usage);
            else delete (message.usage as { cost?: unknown }).cost;
            last = message;
          }
          outer.push(event);
        }
        outer.end(last ?? (await inner.result()));
      })();
      return outer;
    };
    models.setProvider(createProvider({
      id: core.provider,
      auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
      models: core.models,
      api: { stream: priced, streamSimple: priced, fetchDeferred: core.fetchDeferred, cancelDeferred: core.cancelDeferred },
    }));
    if (env[FAUX_UPSTREAM_ENV]) {
      const send = ((await import(pathToFileURL(env[FAUX_UPSTREAM_ENV]).href)) as { default: typeof fetch }).default;
      const [{ anthropicProvider }, { openaiProvider }] = await Promise.all([import("@earendil-works/pi-ai/providers/anthropic"), import("@earendil-works/pi-ai/providers/openai")]);
      for (const provider of [anthropicProvider(), openaiProvider()] as Provider[]) {
        const via = <F extends (model: never, context: never, options?: { fetch?: typeof fetch }) => unknown>(stream: F) => ((model: never, context: never, options?: object) => stream(model, context, { ...options, fetch: send })) as F;
        models.setProvider(Object.assign(Object.create(provider) as Provider, { stream: via(provider.stream.bind(provider)), streamSimple: via(provider.streamSimple.bind(provider)) }));
      }
    }
    return { models, model, byTier, unpriced };
  }
  // One base rule for every harness (provider.ts' gatewayBase): one trailing /v1 off, then the API under <base>/v1, so
  // <gw>/api and <gw>/api/v1 both reach <gw>/api/v1/responses, as OpenRouter serves it.
  const baseUrl = `${gatewayBase("AGENT_MODEL_BASE_URL", env.AGENT_MODEL_BASE_URL!)}/v1`;
  const { openAIResponsesApi } = await import("@earendil-works/pi-ai/api/openai-responses.lazy");
  const priced = await gatewayPrices(env, byTier, namedBy);
  const priceOf = (id: string): ModelCost => {
    const cost = priced.get(id);
    if (cost) return cost;
    // No price: a placeholder pi-ai's model needs, which nothing books as known (unpricedApi; adapters.ts priceOf).
    unpriced.add(id);
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  };
  // `models` is priced first, which fills `unpriced`, and `api` is chosen by it.
  models.setProvider(createProvider({
    id: MODEL_PROVIDER,
    baseUrl,
    auth: { apiKey: { name: GATEWAY_KEY_ENV, resolve: async () => ({ auth: { apiKey: env[GATEWAY_KEY_ENV] || "none" }, source: GATEWAY_KEY_ENV }) } },
    models: ids.map((id) => ({
      id, name: id, api: "openai-responses", provider: MODEL_PROVIDER, baseUrl, reasoning: true, input: ["text", "image"] as ("text" | "image")[],
      cost: priceOf(id), contextWindow: 128_000, maxTokens: 32_000, compat: { supportsDeveloperRole: false },
    })),
    api: unpriced.size ? unpricedApi(openAIResponsesApi(), unpriced, ai) : openAIResponsesApi(),
  }));
  return { models, model, byTier, unpriced };
}

/** The price of each gateway model of `byTier` (its tiers' models, `namedBy` the provider a ref named), in USD per million
 *  input, output, cache-read and cache-write tokens: a tier's own price (`AGENT_MODEL_FAST_PRICE`,
 *  `AGENT_MODEL_STRONG_PRICE`) goes with its model, else the default's (`AGENT_MODEL_PRICE`); a model two tiers share
 *  takes the default's. With none set, pi-ai's catalog prices it (catalogPrice), a $0 entry included. An id with no price
 *  is absent: its answers carry no total (unpricedApi) and a harness books it unknown (adapters.ts priceOf), so the run's
 *  cost reads unknown, never $0, and a cap refuses it (blockersOf refuses a capped run on it before it starts). */
async function gatewayPrices(env: NodeJS.ProcessEnv, byTier: ReadonlyMap<Tier, ModelRef>, namedBy: ReadonlyMap<Tier, string>): Promise<Map<string, ModelCost>> {
  const prices = new Map<string, { given: string | undefined; named: string | undefined }>();
  for (const tier of ["default", "fast", "strong"] as const) {
    const id = byTier.get(tier)?.modelId;
    if (id !== undefined && !prices.has(id)) prices.set(id, { given: (tier !== "default" && env[`${TIER_ENV[tier]}_PRICE`]) || env.AGENT_MODEL_PRICE || undefined, named: namedBy.get(tier) });
  }
  const catalog = [...prices.values()].some((price) => price.given === undefined) ? await catalogPrices() : new Map<string, Listed[]>();
  const out = new Map<string, ModelCost>();
  for (const [id, { given, named }] of prices) {
    if (given === undefined) {
      const listed = catalogPrice(catalog, id, named);
      if (listed) out.set(id, listed);
      continue;
    }
    const [input = 0, output = 0, cacheRead = 0, cacheWrite = input] = given.split(",").map(Number);
    out.set(id, { input, output, cacheRead, cacheWrite });
  }
  return out;
}

/** The models a run of `ref` (an agentic revision's own, else the host's) on `harness` would take, of `tiers`, that serve
 *  has no price for here: a gateway's (AGENT_MODEL_BASE_URL) id with no price set and none in the catalog in any form
 *  (gatewayPrices). None elsewhere: pi-ai's providers price their own models, a $0 entry included, and a harness on a wire the gateway does not serve
 *  (Anthropic's Messages: provider.ts WIRES) prices
 *  by its catalog entry. One a cap cannot be kept on: capabilities' `models.priced`, and blockersOf's refusal of a capped
 *  run. A model chooseModel cannot give is not this one's to say (its own blocker says why). */
export async function unpricedModels(env: NodeJS.ProcessEnv, ref: string | undefined, tiers: readonly Tier[] = ["default"], harness: string = DEFAULT_HARNESS): Promise<string[]> {
  const facts = harnessOf(env, harness)?.facts;
  if (env[FAUX_ENV] || !env.AGENT_MODEL_BASE_URL || (facts && !WIRES[facts.wire].gateway)) return [];
  const byTier = new Map<Tier, ModelRef>();
  const namedBy = new Map<Tier, string>();
  for (const tier of new Set(tiers)) {
    const chosen = await chooseModel(env, tier === "default" ? ref : undefined, tier, harness);
    if ("why" in chosen) continue;
    byTier.set(tier, chosen.model);
    if (chosen.namedProvider) namedBy.set(tier, chosen.namedProvider);
  }
  const priced = await gatewayPrices(env, byTier, namedBy);
  return [...new Set([...byTier.values()].map((model) => model.modelId))].filter((id) => !priced.has(id));
}

/** The requests a Models object sends, each with its options third. */
const REQUESTS = new Set<PropertyKey>(["stream", "streamSimple", "complete", "completeSimple"]);

/** The variable whose key a gateway named by ANTHROPIC_BASE_URL takes, sent as `x-api-key`, as claude-agent's adapter
 *  sends it (provider.ts providerFor). Never ANTHROPIC_AUTH_TOKEN (a bearer), an OAuth token or OpenRouter's key. */
const ANTHROPIC_GATEWAY_KEY = "ANTHROPIC_API_KEY";

/** The key under which providerModels marks Anthropic's provider refused, with gatewayBase's words. */
const REFUSED = Symbol("refused");
/** Why `models` (providerModels') send no request on Anthropic's route: ANTHROPIC_BASE_URL is a base a key may not go to,
 *  in gatewayBase's words. Undefined where the route runs. */
export const anthropicRefusal = (models: { getProvider(id: string): object | undefined }): string | undefined => (models.getProvider("anthropic") as { [REFUSED]?: string } | undefined)?.[REFUSED];

/** pi-ai's providers, their keys read from `env` (authContextOf), with Anthropic's where ANTHROPIC_BASE_URL points when
 *  it is set: each Anthropic model sent to <base>/v1/messages, with ANTHROPIC_API_KEY alone, as `x-api-key`, as
 *  claude-agent's requests go. Every pi request on an Anthropic model takes it: a run's turns and compaction, its side
 *  requests (a hosted search, a learned node) and a grade, and the readiness chooseModel reports. A base gatewayBase
 *  refuses (one a key may not go to) refuses Anthropic's route alone: its provider keeps its models, with no key, so
 *  none of their requests is sent anywhere, and carries the refusal's words (anthropicRefusal), which chooseModel gives
 *  for an Anthropic model; every other provider runs as it does without the setting. Never throws. */
export async function providerModels(env: NodeJS.ProcessEnv) {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  // With the models serve lists beside pi-ai's catalog (local-models.ts): OpenRouter's particle-1.
  const models = withLocalModels(builtinModels({ authContext: authContextOf(env) }));
  if (!env.ANTHROPIC_BASE_URL) return models;
  const [{ createProvider }, { anthropicMessagesApi }] = await Promise.all([import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/api/anthropic-messages.lazy")]);
  const own = models.getProvider("anthropic")!;
  let base: string;
  try {
    base = gatewayBase("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL);
  } catch (error) {
    const refused = createProvider({ id: own.id, name: own.name, auth: { apiKey: { name: ANTHROPIC_GATEWAY_KEY, resolve: async () => undefined } }, models: own.getModels(), api: anthropicMessagesApi() });
    models.setProvider(Object.assign(refused, { [REFUSED]: (error as Error).message }));
    return models;
  }
  models.setProvider(createProvider({
    id: own.id,
    name: own.name,
    baseUrl: base,
    auth: { apiKey: { name: ANTHROPIC_GATEWAY_KEY, resolve: async ({ ctx }) => {
      const key = await ctx.env(ANTHROPIC_GATEWAY_KEY);
      return key ? { auth: { apiKey: key }, source: ANTHROPIC_GATEWAY_KEY } : undefined;
    } } },
    models: own.getModels().map((model) => ({ ...model, baseUrl: base })),
    api: anthropicMessagesApi(),
  }));
  return models;
}


/** `models` with each request's `env` option carrying the REQUEST_KEYS that `env` holds (a run's process holds only
 *  those of its model's provider), so Bedrock's request finds its AWS keys there: in no environment, which would hand
 *  them to every program the run starts. A request's own `env` wins. With none held, `models` as it is. */
function withRequestKeys<M extends object>(models: M, env: NodeJS.ProcessEnv): M {
  const keys = Object.fromEntries(REQUEST_KEYS.flatMap((name) => (env[name] ? [[name, env[name]!]] : [])));
  if (!Object.keys(keys).length) return models;
  return new Proxy(models, {
    get: (target, key) => {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      if (!REQUESTS.has(key)) return value.bind(target);
      return (model: unknown, context: unknown, options?: { env?: Record<string, string> }) => value.call(target, model, context, { ...options, env: { ...keys, ...options?.env } });
    },
  });
}

/** `api`, with each answer of a model in `unpriced` written as an unpriced one: its usage's cost has no total, as
 *  harness-app writes a harness's, so the timeline, the run's cost and /v2 read it unknown rather than $0. Every pi request
 *  passes through it, a compaction's summary (`completeSimple`) included. */
function unpricedApi<A extends ProviderStreams>(api: A, unpriced: ReadonlySet<string>, ai: typeof import("@earendil-works/pi-ai")): A {
  const strip = (message: { usage?: { cost?: { total?: number } } } | undefined) => void (message?.usage?.cost && delete message.usage.cost.total);
  const unpricedOf = <F extends ProviderStreams["stream"] | ProviderStreams["streamSimple"]>(stream: F): F => ((model: Parameters<F>[0], context: Parameters<F>[1], options?: Parameters<F>[2]) => {
    const inner = stream(model, context, options as never);
    if (!unpriced.has(model.id)) return inner;
    const outer = ai.createAssistantMessageEventStream();
    void (async () => {
      let last: Parameters<typeof outer.end>[0] | undefined;
      for await (const event of inner) {
        const message = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
        if (message) {
          strip(message);
          last = message;
        }
        outer.push(event);
      }
      const result = last ?? (await inner.result());
      strip(result);
      outer.end(result);
    })().catch((error: unknown) => {
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, errorMessage: `the model request failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` } as unknown as Parameters<typeof outer.end>[0];
      outer.push({ type: "error", reason: "error", error: message } as never);
      outer.end(message);
    });
    return outer;
  }) as F;
  return { ...api, stream: unpricedOf(api.stream.bind(api)), streamSimple: unpricedOf(api.streamSimple.bind(api)) };
}

export type Listed = { provider: string; cost: ModelCost };

/** pi-ai's catalog list prices by model id: every provider's entry for it, in the catalog's order. */
export async function catalogPrices(): Promise<Map<string, Listed[]>> {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const out = new Map<string, Listed[]>();
  for (const model of withLocalModels(builtinModels()).getModels()) {
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, tiers } = (model as { cost?: Partial<ModelCost> }).cost ?? {};
    const listed = out.get(model.id) ?? out.set(model.id, []).get(model.id)!;
    listed.push({ provider: model.provider, cost: { input, output, cacheRead, cacheWrite, ...(tiers ? { tiers } : {}) } });
  }
  return out;
}

/** A gateway model's price in `catalog` (catalogPrices'), by its id as the host or the revision names it: a ref that names
 *  its provider (`named`), priced as that provider's entry, whether the id went whole or bare; a host model set whole
 *  (`vendor/model`) the catalog does not list as it is, priced as its model, the vendor named; else the id as it is. Each
 *  read by catalogEntries, so a version's separators written the other way find the catalog's real id. */
export function catalogPrice(catalog: ReadonlyMap<string, readonly Listed[]>, id: string, named: string | undefined): ModelCost | undefined {
  if (named !== undefined) return catalogEntries(catalog, id.startsWith(`${named}/`) ? id.slice(named.length + 1) : id, named);
  const slash = id.indexOf("/");
  if (catalog.has(id) || slash < 1) return catalogEntries(catalog, id, undefined);
  return catalogEntries(catalog, id.slice(slash + 1), id.slice(0, slash));
}

/** The forms of `id` with its version's separators written the other way: each digit-dash-digit as a dot (gpt-5-4-mini,
 *  gpt-5.4-mini; pair by pair, so llama-3-1-8b is llama-3.1-8b), and each digit-dot-digit as a dash (claude-haiku-4.5,
 *  claude-haiku-4-5). Not `id` itself. */
const flippedForms = (id: string): string[] => [...new Set([id.replace(/(\d)-(\d)/g, "$1.$2"), id.replace(/(\d)\.(\d)/g, "$1-$2")])].filter((form) => form !== id);

/** `id`'s price in `catalog` (listedPrice): its own entries when the catalog lists it; else those of its flipped forms
 *  (flippedForms), only when every entry they hold has one price. A flip that finds different prices, across providers
 *  or across the two flips, leaves the model unpriced: the cap refuses it rather than keep a price picked by luck. */
function catalogEntries(catalog: ReadonlyMap<string, readonly Listed[]>, id: string, named: string | undefined): ModelCost | undefined {
  const own = catalog.get(id);
  if (own) return listedPrice(own, named);
  const flipped = flippedForms(id).flatMap((form) => catalog.get(form) ?? []);
  if (!flipped.length) return undefined;
  const one = JSON.stringify(flipped[0]!.cost);
  return flipped.every((entry) => JSON.stringify(entry.cost) === one) ? flipped[0]!.cost : undefined;
}

/** A gateway model's catalog price: the paid entry of the provider its ref names, when the catalog lists one. Else, as
 *  the gateway does not say whose model answers (a named provider is a hint), the highest any provider lists, so the
 *  estimate and a cap on it err high: one entry's whole price, the one with the most input plus output (the first of
 *  equals), so a $0 entry never wins over a paid one, a named provider's included. An id the catalog lists at $0 is a
 *  known $0; one it does not list has no price (undefined). */
function listedPrice(entries: readonly Listed[], named: string | undefined): ModelCost | undefined {
  if (!entries.length) return undefined;
  const own = named === undefined ? undefined : entries.find((entry) => entry.provider === named);
  if (own && own.cost.input + own.cost.output > 0) return own.cost;
  return entries.reduce<ModelCost>((top, { cost }) => (cost.input + cost.output > top.input + top.output ? cost : top), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}
