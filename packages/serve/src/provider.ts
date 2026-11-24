// Where a harness's model requests go, by the API its proxy speaks (AdapterFacts.wire), never by its name: one rule for each
// wire's endpoint, key and price, read from the same env vars by everything that asks (the adapter, its route's keys, a
// learning grade, a model's availability).
//   anthropic-messages: ANTHROPIC_BASE_URL's base (an Anthropic-compatible endpoint) or api.anthropic.com, with
//     ANTHROPIC_API_KEY as `x-api-key`, priced as Anthropic's; or OpenRouter's Messages endpoint (openRouterOnly, or a
//     model the run names on it, `openrouter/anthropic/<model-id>`), with OPENROUTER_API_KEY as a bearer token, priced
//     as OpenRouter's. Either way the wire carries Anthropic's own id (`claude-sonnet-5-5`). Its own settings only, but
//     for a Claude model of serve's gateway (pi's, model.ts gatewayWire), which goes to the gateway as on Responses.
//   openai-responses: the gateway at AGENT_MODEL_BASE_URL's base with its key (AGENT_MODEL_API_KEY, or none), the model
//     as model.ts chose it; OpenAI with its key, OpenAI's id; or OpenRouter's Responses API (openRouterOnly, or a model
//     the run names on it, `openrouter/openai/<model-id>`), the model's whole id. Each key goes as a bearer token.
//   any wire the runner's model route translates a model's provider onto (wires.ts routed: an Ollama model of this
//     machine on Anthropic's Messages): the route's own origin and fetch (runner/model-route.ts routeOf), no key, at the
//     model's catalog price; for every harness on that wire alike.
//   claude-agent on Claude Code's login on this machine (claude-login.ts), when the owner turned it on: an Anthropic
//     model goes on the person's plan, from the CLI itself, with no key of ours and no proxy (`login`).
import type { HarnessWire as Wire, Wire as ModelWire } from "@parcha/agentrun-kernel";
import { CredentialUnavailable, ROUTE_ORIGIN } from "@parcha/agentrun-kernel/host";
import type { ClaudeAgentLogin } from "@parcha/agentrun-harness-claude";
import { CLAUDE_LOGIN_PROVIDER, onClaudeLogin, claudeLoginOf } from "./claude-login.js";
import { chooseModel, FAUX_ENV, hostModel, MODEL_PROVIDER, type ModelNeeds, type ModelRef, ollamaWouldRun, START_OLLAMA } from "./model.js";
import { modelWire, routed, routedId, translatesOnto, WIRES, wireOf } from "./wires.js";
import { modelFormWhy } from "./model-form.js";
import { gatewayHeadersOf } from "./request-metadata.js";
import { EXPIRED, PLAN_ORIGIN, PLAN_PROVIDER, planOf, SIGNED_OUT } from "./chatgpt-plan.js";

// Each wire's own settings live in a leaf module (wires.ts), which the harness table reads as it loads.
export { modelWire, WIRES, wireOf };

/** What fixes a harness that is not on this machine as its adapter needs it: `install`, its package or binary is missing;
 *  `pins`, what is installed is not the pinned build. */
export type InstallFix = "install" | "pins";

/** Why this server cannot run a harness here, in words a person can act on; `fix`, when installing is the fix; `keys`,
 *  when a model key is all it lacks: the keys, any one of which, set, lets it run (a key row names it: tool-keys.ts). */
export class HarnessUnavailable extends Error {
  constructor(message: string, readonly fix?: InstallFix, readonly keys?: readonly string[]) {
    super(message);
  }
}

/** OpenRouter's API: its Anthropic Messages endpoint (`<base>/v1/messages`) and its Responses API (`<base>/v1/responses`)
 *  under one base, its key taken as a bearer token. The OpenRouter key goes nowhere else. */
export const OPENROUTER_BASE = "https://openrouter.ai/api";
/** Anthropic's own origin, where pi-ai's Anthropic provider sends (a gateway is not it). */
export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
/** OpenAI's own origin, where pi-ai's OpenAI provider sends. */
export const OPENAI_ORIGIN = "https://api.openai.com";

/** Hosts a gateway may be reached at over plain http: this machine. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]); // key-gate: loopback-rule names this machine only, the hosts a gateway may use plain http on; an allow-list, the line dials nothing

/**
 * The base `setting` (a gateway's URL) gives the model proxy: its origin and its path, one trailing `/v1` taken off, since
 * every route the proxy sends to begins with `/v1/`. So `https://openrouter.ai/api` and `https://openrouter.ai/api/v1` both
 * send to `https://openrouter.ai/api/v1/...`. A provider's key goes wherever this points, so a value that could point
 * somewhere other than it reads is refused, by the setting's name: userinfo, a query or a fragment, a "." or ".." path
 * segment (raw or percent-encoded), a backslash, whitespace, or plain http to anything but this machine. The one base
 * rule: pi's gateway models take `<this>/v1` (model.ts).
 */
export function gatewayBase(setting: string, value: string): string {
  const wrong = (why: string) => new HarnessUnavailable(`${setting} must be an https URL of a gateway, with a path if it serves the API under one; it ${why}.`);
  if (/\s/.test(value)) throw wrong("holds whitespace");
  // The URL parser reads a backslash as a path separator, so a ".." between backslashes would resolve where "/../" is refused.
  if (value.includes("\\")) throw wrong("holds a backslash");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw wrong("is not a URL");
  }
  if (url.username || url.password) throw wrong("names a user");
  if (url.search || url.hash || /[?#]/.test(value)) throw wrong("has a query or a fragment");
  // The URL parser resolves dot segments, so they are looked for in the text as given: the path after the scheme, every
  // slash after it (the parser takes `https:/host` and `https:host` as `https://host`), and the host.
  const path = value.replace(/^[a-z][a-z0-9+.-]*:[/]*/i, "").replace(/^[^/]*/, "");
  if (path.split("/").some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) throw wrong("has a . or .. path segment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw wrong(`is ${url.protocol.replace(/:$/, "")}, not https`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

/** The generic gateway must speak HTTP Responses (or Messages). Particle exposes Chat Completions
 * and a WebSocket-only Responses subset, so a direct API base is not a compatible gateway. */
export function modelGatewayBase(value: string): string {
  const base = gatewayBase("AGENT_MODEL_BASE_URL", value);
  if (["api.particle.ai", "us.api.particle.ai"].includes(new URL(base).hostname)) {
    throw new HarnessUnavailable("Particle uses Chat Completions here: remove AGENT_MODEL_BASE_URL, save PARTICLE_API_KEY and select particle/particle-1 with Pi. Particle does not support HTTP POST /v1/responses.");
  }
  return base;
}

/** Whether `base` (a gatewayBase answer) is on the origin of serve's own gateway (AGENT_MODEL_BASE_URL): there a run's own
 *  model key (run-model-key.ts) is sent, so the endpoint needs no standing key of the server's. */
/** The headers a request to `origin` carries for serve's gateway (gatewayHeadersOf), when `origin` is that gateway's own
 *  (AGENT_MODEL_BASE_URL's origin): none to any other origin, a vendor's own included. */
export function gatewayHeadersAt(env: NodeJS.ProcessEnv, origin: string): Readonly<Record<string, string>> | undefined {
  return onServeGateway(env, origin) ? gatewayHeadersOf(env) : undefined;
}

function onServeGateway(env: NodeJS.ProcessEnv, base: string): boolean {
  if (!env.AGENT_MODEL_BASE_URL) return false;
  try {
    return new URL(gatewayBase("AGENT_MODEL_BASE_URL", env.AGENT_MODEL_BASE_URL)).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Whether `wire` reaches its vendor's models here only through OpenRouter: OPENROUTER_API_KEY is set and none of the
 * wire's own settings is. Those win, as on a host with no OpenRouter key: the endpoint the host names (ANTHROPIC_BASE_URL
 * on Anthropic's Messages, which needs ANTHROPIC_API_KEY; serve's gateway AGENT_MODEL_BASE_URL on the Responses API, with
 * AGENT_MODEL_API_KEY or none), then the vendor's own key (ANTHROPIC_API_KEY, OPENAI_API_KEY), then OpenRouter. An
 * endpoint the host names never gets the OpenRouter key.
 */
export function openRouterOnly(wire: Wire, env: NodeJS.ProcessEnv): boolean {
  // A harness on its own plan (Cursor's) reaches nothing through OpenRouter, nor through any route of ours.
  if (!modelWire(wire)) return false;
  return Boolean(env.OPENROUTER_API_KEY) && !env[WIRES[wire].base] && !env[WIRES[wire].key];
}

/** Whether a run on `wire` of `model` (as named, `provider/model-id`; none, the host's) sends through OpenRouter: a model
 *  named on it (`openrouter/<vendor>/...`), or the wire's vendor reached only through it (openRouterOnly). Serve's gateway
 *  comes first on the wire it serves. */
export function viaOpenRouter(wire: Wire, env: NodeJS.ProcessEnv, model?: string): boolean {
  if (!modelWire(wire) || (WIRES[wire].gateway && env.AGENT_MODEL_BASE_URL)) return false;
  return Boolean(model?.startsWith(`openrouter/${WIRES[wire].vendor}/`)) || openRouterOnly(wire, env);
}

/** OpenRouter's name for Anthropic's model `id` (Anthropic's own), as its catalog and pi-ai's list it: the version's
 *  last two numbers joined by a dot (claude-sonnet-5-5 is claude-sonnet-5.5; claude-opus-5 stays). */
export const openRouterName = (id: string): string => id.replace(/-(\d+)-(\d+)$/, "-$1.$2");

/** Anthropic's own model id, the model id with dots as dashes: Anthropic's ids hold no dot, and OpenRouter names the same
 *  models with dots (anthropic/claude-sonnet-5.5), so a revision may name either, and the catalog prices them by
 *  Anthropic's id. */
export function anthropicModelId(model: ModelRef): string {
  return model.provider === WIRES["anthropic-messages"].vendor ? model.modelId.replaceAll(".", "-") : model.modelId;
}

/** Where a run's requests on `wire` go, and the model on the wire: the endpoint's origin (the proxy appends the API's own
 *  path), its key, read per request, how the endpoint takes it, the model id sent, and the catalog entry that prices it.
 *  `who`: the harness, for a refusal's words. Throws a HarnessUnavailable where the run cannot go: a model of another
 *  vendor, a key that is not set (its `keys` name the ones that would fix it), or an endpoint a key may not go to. */
/** `billing: "plan"`: a ChatGPT plan's route (chatgpt-plan.ts), billed to the plan, never priced here; its credential is
 *  the plan's token, asked at each request, and `refused` tells the plan OpenAI answered 401 to one it sent. */
/** `login`: claude-agent on Claude Code's login on this machine (claude-login.ts): billed to the person's plan, its CLI
 *  calling Anthropic itself; `origin` and `credential` are never read (no proxy, no key). */
/** `headers`: what each request on serve's own gateway carries beside its key (request-metadata.ts: the run, turn and
 *  attempt it was made for, as LiteLLM's spend-logs metadata); none on any other endpoint. */
/** `fetch`: the route's own, for a model it translates onto the wire (routedProvider): the harness's proxy forwards
 *  with it, to `origin` (ROUTE_ORIGIN), and nothing goes to the network but what the route sends. */
export type Provider = { origin: string; credential: () => string | Promise<string>; auth: "bearer" | "x-api-key"; modelId: string; priceModel: ModelRef; billing?: "plan"; refused?: (credential: string) => Promise<void>; login?: ClaudeAgentLogin; headers?: Readonly<Record<string, string>>; fetch?: typeof fetch };

/** The provider of a held run its model kept from running at its create (run-launch.ts hold.refused), on pi and on every
 *  CLI harness's proxy: no model is chosen for it and no key is read, so a host with no key for its model still opens its
 *  claim and holds its computer. Its credential refuses in `words`, the create's own: the session's proxy reads it first
 *  and refuses each request in them (CredentialUnavailable), before the request is admitted, booked or sent. Its origin
 *  names no host. */
export const heldRefusedProvider = (model: ModelRef, words: string): Provider => ({
  origin: "https://held-run.invalid",
  credential: () => {
    throw new CredentialUnavailable(words);
  },
  auth: "bearer",
  modelId: model.modelId,
  priceModel: model,
});

/** A model the runner's route translates onto a harness's wire (wires.ts routed): its proxy forwards to the route's own
 *  origin (ROUTE_ORIGIN), where the route's fetch answers (runner/model-route.ts routeOf on `env`: the model's own
 *  provider, an Ollama model's num_ctx and its tools as text where it takes them so), translated onto `wire` by its entry
 *  in TRANSLATORS, priced by its catalog entry ($0 for an Ollama model, whose requests the cap counts as local). No key. The route is made at the first
 *  request (routeOf is asynchronous) and kept; one that failed is made again at the next. */
function routedProvider(env: NodeJS.ProcessEnv, wire: ModelWire, model: ModelRef): Provider {
  let route: Promise<typeof fetch> | undefined;
  const sent = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    route ??= import("./runner/model-route.js").then(({ TRANSLATORS }) => {
      const translate = TRANSLATORS[wire];
      if (!translate) throw new Error(`The model route has no translation onto ${wire}.`);
      return translate(`${model.provider}/${model.modelId}`, env);
    }).catch((error: unknown) => {
      route = undefined;
      throw error;
    });
    return (await route)(input, init);
  }) as typeof fetch;
  return { origin: ROUTE_ORIGIN, credential: () => "model-route", auth: "x-api-key", modelId: model.modelId, priceModel: model, fetch: sent };
}

/** `env`'s gateway headers (gatewayHeadersOf), as a Provider's optional field. */
const onGateway = (env: NodeJS.ProcessEnv): { headers?: Readonly<Record<string, string>> } => {
  const headers = gatewayHeadersOf(env);
  return headers ? { headers } : {};
};

/** OpenRouter's key, read per request, refused by name where it is not set. */
function openRouterKey(env: NodeJS.ProcessEnv, who: string, named: string): () => string {
  if (!env.OPENROUTER_API_KEY) throw new HarnessUnavailable(`${who} runs ${named} through OpenRouter, which needs OPENROUTER_API_KEY.`, undefined, ["OPENROUTER_API_KEY"]);
  return () => env.OPENROUTER_API_KEY ?? "";
}

/** Serve's gateway (AGENT_MODEL_BASE_URL) on either wire: its base, its key (AGENT_MODEL_API_KEY, or none) as a bearer
 *  token, the model id as model.ts chose it, priced as runModels prices it. */
const gatewayProvider = (env: NodeJS.ProcessEnv, model: ModelRef): Provider => ({ origin: modelGatewayBase(env.AGENT_MODEL_BASE_URL!), credential: () => env.AGENT_MODEL_API_KEY || "none", auth: "bearer", modelId: model.modelId, priceModel: model, ...onGateway(env) });

export function providerFor(wire: Wire, env: NodeJS.ProcessEnv, model: ModelRef, who: string): Provider {
  const named = `${model.provider}/${model.modelId}`;
  // A harness on its own plan (Cursor's) calls its vendor itself, on its owner's key: no route of ours is its.
  if (!modelWire(wire)) throw new HarnessUnavailable(`${who} runs its model on its own plan, never through a model route of AgentRun's; ${named} is not one to proxy.`);
  // A model the route translates onto this wire, for any harness on it; never behind serve's gateway, whose models are its.
  if (routed(wire, model) && !env.AGENT_MODEL_BASE_URL) return routedProvider(env, wire, model);
  if (wire === "anthropic-messages") {
    // A model of serve's gateway that the gateway takes on Messages (a Claude model, model.ts gatewayWire): the gateway's
    // own route, as on Responses. No harness of this wire chooses one (claude-agent's model is never the gateway's).
    if (model.provider === MODEL_PROVIDER && env.AGENT_MODEL_BASE_URL) return gatewayProvider(env, model);
    if (model.provider === "openrouter" && model.modelId.startsWith("anthropic/")) {
      const own = anthropicModelId({ provider: "anthropic", modelId: model.modelId.slice("anthropic/".length) });
      return { origin: OPENROUTER_BASE, credential: openRouterKey(env, who, named), auth: "bearer", modelId: own, priceModel: { provider: "openrouter", modelId: `anthropic/${openRouterName(own)}` } };
    }
    if (model.provider !== "anthropic") throw new HarnessUnavailable(`${who} runs Anthropic models; the run's model is ${named}.`);
    const own = anthropicModelId(model);
    // Claude Code's login on this machine, turned on here: claude-agent's Anthropic model goes on it, whatever key is set.
    const login = onClaudeLogin(env, who) ? claudeLoginOf(env) : undefined;
    if (login) return { origin: ANTHROPIC_ORIGIN, credential: () => "", auth: "x-api-key", modelId: own, priceModel: { provider: CLAUDE_LOGIN_PROVIDER, modelId: own }, billing: "plan", login };
    if (openRouterOnly(wire, env)) return { origin: OPENROUTER_BASE, credential: openRouterKey(env, who, named), auth: "bearer", modelId: own, priceModel: { provider: "openrouter", modelId: `anthropic/${openRouterName(own)}` } };
    // The endpoint first: one it refuses is the reason, and no key would fix it (no `keys`). An endpoint the host names
    // takes Anthropic's key alone: OpenRouter's never goes there.
    const origin = env.ANTHROPIC_BASE_URL ? gatewayBase("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL) : ANTHROPIC_ORIGIN;
    // An endpoint on serve's own gateway's origin takes each run's own key where the server holds none (run-model-key.ts):
    // the harness runs here with no standing key, and a run with no key to spend is refused at its start.
    if (!env.ANTHROPIC_API_KEY && !onServeGateway(env, origin)) throw env.ANTHROPIC_BASE_URL ? new HarnessUnavailable(`${who} needs ANTHROPIC_API_KEY.`, undefined, ["ANTHROPIC_API_KEY"]) : new HarnessUnavailable(`${who} needs ANTHROPIC_API_KEY or OPENROUTER_API_KEY.`, undefined, ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]);
    // On serve's own gateway's origin, the claim's request metadata goes with each request (request-metadata.ts).
    return { origin, credential: () => env.ANTHROPIC_API_KEY ?? "", auth: "x-api-key", modelId: own, priceModel: { provider: "anthropic", modelId: own }, ...(onServeGateway(env, origin) ? onGateway(env) : {}) };
  }
  // A ChatGPT plan's model: OpenAI's Responses API on the plan's token, whatever else is set.
  if (model.provider === PLAN_PROVIDER) {
    const plan = planOf(env);
    if (plan?.state !== "signed_in") throw new HarnessUnavailable(plan?.state === "expired" ? EXPIRED : SIGNED_OUT);
    return { origin: PLAN_ORIGIN, credential: () => plan.token(), auth: "bearer", modelId: model.modelId, priceModel: model, billing: "plan", refused: (sent) => plan.refused(sent) };
  }
  if (env.AGENT_MODEL_BASE_URL) return gatewayProvider(env, model);
  if (model.provider === "openrouter" && model.modelId.startsWith("openai/")) return { origin: OPENROUTER_BASE, credential: openRouterKey(env, who, named), auth: "bearer", modelId: model.modelId, priceModel: model };
  if (model.provider !== "openai") throw new HarnessUnavailable(`${who} runs OpenAI models; the run's model is ${named}.`);
  if (openRouterOnly(wire, env)) return { origin: OPENROUTER_BASE, credential: openRouterKey(env, who, named), auth: "bearer", modelId: named, priceModel: model };
  if (!env.OPENAI_API_KEY) throw new HarnessUnavailable(`${who} needs OPENAI_API_KEY, OPENROUTER_API_KEY (OpenAI's models through OpenRouter), or a gateway in AGENT_MODEL_BASE_URL.`, undefined, ["OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
  return { origin: OPENAI_ORIGIN, credential: () => env.OPENAI_API_KEY ?? "", auth: "bearer", modelId: model.modelId, priceModel: model };
}

/** The catalog entry a run on `wire` of `model` is capped and priced by: providerFor's, or the model's own (normalized)
 *  where the wire refuses the run (its run is refused before any request). */
export function priceModelFor(wire: Wire, env: NodeJS.ProcessEnv, model: ModelRef, who: string): ModelRef {
  try {
    return providerFor(wire, env, model, who).priceModel;
  } catch {
    return wire === "anthropic-messages" ? { ...model, modelId: anthropicModelId(model) } : model;
  }
}

/** A harness's model for a revision, or why there is none: `host`, a setting of this host could fix it. */
export type ModelChoice = { model: ModelRef; namedProvider?: string } | { why: string; host: boolean; needs?: ModelNeeds };

/**
 * The model a run on `wire` of `ref` (a revision's `provider/model-id`; none, the host's default for `harness`, whose
 * row's model it is) takes, where its model is chosen on the wire's own settings and not as pi's are (model.ts
 * chooseModel). Anthropic's Messages: never the gateway's model. An Anthropic model is Anthropic's own id, dots as dashes,
 * except where the wire reaches Anthropic only through OpenRouter (openRouterOnly), where it keeps the name it was given
 * (OpenRouter's dotted one, as capabilities show it): providerFor names the id on the wire and the catalog entry that
 * prices it. OpenRouter's name for an Anthropic model (pi's, `openrouter/anthropic/<id>`) runs through OpenRouter.
 * Whether it is Anthropic's model is providerFor's to say. The Responses API: as model.ts chooses it, except where it
 * reaches OpenAI only through OpenRouter, where an OpenAI model needs no OpenAI key, only a model pi-ai's catalog lists
 * (it prices the run): OpenRouter's key is the one providerFor sends. A save, a run and capabilities all ask this.
 */
export async function modelOn(wire: Wire, env: NodeJS.ProcessEnv, ref: string | undefined, harness: string): Promise<ModelChoice> {
  // A harness on its own plan chooses its model itself (its table entry's model): none of the host's is its.
  if (!modelWire(wire)) return { why: `${harness} runs a model of its own plan, which its own entry chooses.`, host: false };
  const { vendor, label } = WIRES[wire];
  const named = ref ?? hostModel(env, "default", harness);
  // A model the route translates onto this wire (an Ollama model; the host's default with no key held, read from the
  // Ollama here): chosen as pi's is (model.ts chooseModel: that Ollama listed, its tag asked of it, an expired default
  // chosen again), with the no-model words below where none is.
  if (!env[FAUX_ENV] && !env.AGENT_MODEL_BASE_URL && (named === undefined ? translatesOnto(wire) : routedId(wire, named))) {
    const chosen = await chooseModel(env, ref, "default", harness);
    if ("model" in chosen || named !== undefined) return chosen;
  }
  if (wire === "openai-responses") {
    if (env[FAUX_ENV] || !openRouterOnly(wire, env) || !named?.startsWith(`${vendor}/`)) return chooseModel(env, ref, "default", harness);
    const modelId = named.slice(vendor.length + 1);
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    if (!builtinModels().getModel(vendor, modelId)) return { why: modelFormWhy(env, harness, named, ref === undefined), host: ref === undefined, needs: "model" };
    return { model: { provider: vendor, modelId } };
  }
  if (!named) return { why: `No model yet for ${harness}: ${ollamaWouldRun(env, harness) ? START_OLLAMA : ""}add an OpenRouter or ${label} key in Settings → Model keys, or set OPENROUTER_API_KEY or ${WIRES[wire].key} where AgentRun starts.`, host: true };
  const slash = named.indexOf("/");
  if (slash < 1) return { why: modelFormWhy(env, harness, named, ref === undefined), host: ref === undefined };
  const [provider, modelId] = [named.slice(0, slash), named.slice(slash + 1)];
  // OpenRouter's name for a model is OpenRouter's provider, then the vendor's model; another vendor's is providerFor's
  // to refuse.
  const [of, id, ...more] = modelId.split("/");
  if (provider === "openrouter" && id && !more.length) return { model: { provider, modelId: of === vendor ? `${vendor}/${openRouterName(anthropicModelId({ provider: of, modelId: id }))}` : modelId } };
  // One provider, then the model's own id: a second segment (anthropic/anthropic/<model>, once a workaround) is refused
  // by name, never sent on to fail at the provider.
  if (modelId.includes("/")) return { why: `${harness} runs a model named ${provider}/<model-id>; ${named} names more than one segment: name it ${provider}/${modelId.slice(modelId.lastIndexOf("/") + 1)}.`, host: ref === undefined };
  if (provider === vendor && openRouterOnly(wire, env)) return { model: { provider, modelId } };
  // Anthropic's own id from here on, so the cap's model lookup, the price and the wire all name one model the catalog
  // knows: a dotted name (OpenRouter's) would find no model under anthropic, and a cap with no model would admit nothing
  // it could price.
  return { model: { provider, modelId: anthropicModelId({ provider, modelId }) } };
}
