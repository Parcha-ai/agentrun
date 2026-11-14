// pi as an AgentAdapter (the one-ledger ruling, B2c; kernel page tangle 3): pi-durable's own engine inside, on the
// same contract as claude-agent, codex and opencode. The adapter loop (runner/adapter-loop.ts) opens the run's one
// Harness on the claim's journal and lends it here (`PiRun`); this adapter adds pi's tools and turns to it.
//
// pi's model requests go through the session's model proxy (the kernel's startModelProxy), as the CLI harnesses' do:
// pi-ai's provider points at the proxy, so every paid request is admitted and booked by the runner's booking (io.models),
// the one ledger; pi's own createCap is not used. The proxy speaks the provider's wire (provider.api, main's set: Anthropic's
// Messages or OpenAI's Responses), under that wire's CLI policy, and pi-ai's client speaks the same. The host's tools run through HostTool.call, where the kernel's rule
// before a side effect sits (runner/adapter-loop.ts); the gate is asked before pi stores a call's intent (pi's beforeTool
// hook), through io.gate.
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, type Cursor, defineExtension, defineTool, type Extension, GenerationTask, type Harness, hook, type HookApi, type Registry, type Submission, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import { anthropicPolicy, withWebSearches } from "@parcha/agentrun-harness-claude";
import { type AdapterSession, type AgentAdapter, HOST_RESULT_MAX_CHARS, type HostTool, type SessionIO, type SessionPort, type SessionSpec, type TurnStatus, type Wire } from "@parcha/agentrun-kernel";
import { type ModelProxy, NATIVE_SEARCH_USD, type ProviderPolicy, startModelProxy } from "@parcha/agentrun-kernel/host";
import { randomBytes } from "node:crypto";
import { DEFAULT_HARNESS } from "../../harness.js";
import { durableWait } from "../../workflow/pi-versions.js";
import { HOSTED_SEARCH_ALLOWANCE_TOKENS } from "../../hosted-search.js";
import { sessionProvider, tierProvider } from "../../port-models.js";
import { KINDS } from "../journal-kinds.js";
import { CALL_REFUSED } from "../../timeline/index.js";
import { ConversationToolBudget, countCalls } from "../../tool-budget.js";
import { type ComputerCallRecord, recordingCalls } from "../../computer-calls.js";

/** What the adapter loop lends pi for one claim: the run's Harness, its registry, and where pi's models go. */
export interface PiRun {
  readonly harness: Harness;
  readonly registry: Registry;
  /** The Harness reads its models through this (HarnessOptions.models as a function): the adapter sets them at open. */
  setModels(models: Models): void;
}

/** A call as the gate is asked about it, before pi stores its intent. */
export interface PreIntentCall {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** An earlier attempt of the call may have been sent (a CLI's kernel bridge, asking about a replay-safe call a crash
   *  cut: GateCall's `replayed`), so a refusal never says nothing was. */
  readonly replayed?: true;
  /** The tool calls the call's conversation made before it, at most `upTo`, read from its committed entries (tool-budget.ts
   *  countCalls), for the gate's tool-call budget: pi's model-issued calls only, never a nested call or a CLI's. */
  readonly callsBefore?: (upTo: number) => Promise<number>;
  /** The call's conversation's own tool-call budget (tool-budget.ts ConversationToolBudget, a subagent's), if it has one. */
  readonly ownBudget?: () => Promise<number | undefined>;
  /** A call a running tool made (pi's nested call), part of a call already let through: the cap's wrap-up never refuses
   *  one (tool-budget.ts), so a tool in flight is never cut short. */
  readonly nested?: true;
}

/** The host's answer before a call's intent: run it, refuse it, or park the run on it (the call never moves on here). */
export type PreIntentAnswer = "allow" | { readonly deny: string } | { readonly park: true };

/** SessionIO with the gate asked before a call's intent (SessionIO.gate in the adapter contract: "allow", a deny, or a park). */
export type PiSessionIO = SessionIO & {
  gate?: (call: PreIntentCall, context: Context) => Promise<PreIntentAnswer>;
  /** What the request that just answered cost, as the runner's booking wrote it (the session's ledger): its figure, null
   *  when unknown, undefined when none was booked. pi's own price for the model is none (the adapter does not know it). */
  bookedCost?: () => Promise<number | null | undefined>;
  /** Keeps a tool call's computer calls beside it on the run's root, by the call's id (the loop's, as its host tools'
   *  are kept): each run's pi-native tool (code mode's script among them) runs inside recordingCalls with it, so its row
   *  carries the calls it made as a host tool's does. */
  keepCalls?: (call: string, calls: readonly ComputerCallRecord[], dropped: number) => Promise<void>;
};

/** `extension` with each of its tools run inside recordingCalls, its calls kept by `keep` under the call's id. A call pi
 *  runs again after a restart keeps what that attempt makes: a code mode script's replay hands back the results of the
 *  calls its earlier attempt made, never making them again, so none is kept twice. The earlier attempt's own record goes
 *  with it, as a host tool's cut attempt's does: the shutdown seals the journal before its call ends. */
function recordingExtension(extension: Extension, keep: NonNullable<PiSessionIO["keepCalls"]>): Extension {
  if (!extension.tools?.length) return extension;
  return {
    ...extension,
    tools: extension.tools.map((tool) => ({
      ...tool,
      execute: (args: never, api: { readonly callId: string }, context: never) => recordingCalls(async () => tool.execute(args, api as never, context), (calls, dropped) => keep(api.callId, calls, dropped)),
    })) as typeof extension.tools,
  };
}

export interface PiAdapterOptions {
  readonly run: PiRun;
  /** The provider the session's proxy forwards to: the API it speaks (a wire main's pi speaks, provider.ts: Anthropic's
   *  Messages or OpenAI's Responses) at `origin`, its credential, sent as `auth` says (Messages' default x-api-key;
   *  Responses' is always a bearer token). `api` is the one source of the session's wire: its policy, pi-ai's client and
   *  its port all read it. */
  readonly provider: { readonly api: Wire; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>>; readonly auth?: "bearer" | "x-api-key" };
  /** The model pi asks for. */
  readonly model: string;
  /** The catalog's entry for the model: whether it reasons, its window and its output ceiling, as pi-ai's model of it. */
  readonly like?: { readonly reasoning?: boolean; readonly contextWindow?: number; readonly maxTokens?: number; readonly input?: readonly string[]; readonly inputLimits?: unknown };
  /** The price of a request's usage, for the proxy's booking. */
  readonly price?: (model: string, usage: never) => number | null;
  /** The proxy's upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
  /** The runner's one redactor, which a provider's error passes through in the session's proxy before pi has it
   *  (ModelProxyOptions.redact; the proxy's own cut of the credential comes first). */
  readonly redact?: (text: string) => string;
  /** pi-native extensions the run's root agent carries beside the session's own (the browser's durable extension, as a
   *  pi DurableRun on main installs it): installed in the claim's registry, so their tools run as pi's own tool tasks (a
   *  taskId, a memo, conversations they own) and their own task kinds (a browser.release) under pi's recovery, all in the
   *  claim's Harness. Their tools pass the session's gate (its beforeTool hook), and every conversation they open takes
   *  its model from the root's agent, through this session's proxy and its booking. */
  readonly extensions?: readonly Extension[];
  /** The run's web_search is its provider's own hosted search (its plane resolves it "native", hosted-search.ts): the
   *  session's policy admits that hosted tool, a request carrying it held at its search allowance, and the proxy prices
   *  each search the provider reports at its fee, so the search's one request is booked once with its searches. */
  readonly webSearch?: boolean;
  /** pi-native tools the session's own extension carries beside its host tools (the subagent tool: runner/subagent.ts):
   *  pi's own tool tasks, under the session's gate like every call. Read when the session opens. A conversation one of
   *  them opens keeps the session's extension, so its calls pass the same gate; its own `tools` say which it is offered. */
  readonly tools?: readonly ToolRegistration[];
  /** The run's models of other tiers than its own (a learned workflow's node of a tier: AGENT_MODEL_FAST,
   *  AGENT_MODEL_STRONG), by tier, each a model route as the session's is: read when the session opens, each on a proxy of
   *  its own beside the session's (its origin, credential, price and fetch), on the session's booking (io.models), so its
   *  requests are the run's, under its one cap, each priced at its own model. Reached through `port(label, tier)`. */
  readonly tiers?: ReadonlyMap<string, TierModel>;
}

const PROVIDER = "agentrun-session";
const INPUT_REQUEST = "agentrun:input";

/** pi as an AgentAdapter for one claim's run. */
export function piAdapter(options: PiAdapterOptions): AgentAdapter {
  return {
    // pi is the default harness: its id is the harness table's, never a literal of its own.
    id: DEFAULT_HARNESS,
    check: () => [],
    open: (spec, io) => openPi(options, spec, io as PiSessionIO),
  };
}

/** The names of the run's pi-native tools (options.extensions' and options.tools): the model is offered them beside the session's
 *  own (so it may call one), and pi runs it. Offered and run by one mechanism; sessionOn never also piTool-wraps a session
 *  tool a native extension already owns, so the name is in the request's tools exactly once. */
const nativeToolNames = (options: PiAdapterOptions): readonly string[] =>
  [...(options.extensions ?? []).flatMap((extension) => extension.tools ?? []), ...(options.tools ?? [])].map((tool) => tool.name);

async function openPi(options: PiAdapterOptions, spec: SessionSpec, io: PiSessionIO): Promise<AdapterSession> {
  const context = withAbortSignal(io.signal, BACKGROUND_CONTEXT);
  // The session's route: pi-ai's requests reach the provider only through this proxy, which admits and books each one
  // through the runner's booking (io.models).
  // Its web_search native (options.webSearch): the session's own proxy admits the hosted search and prices its searches.
  const proxy = await routeProxy(options, io.models, [...spec.tools.map((tool) => tool.name), ...nativeToolNames(options)], options.redact, undefined, options.webSearch === true);
  // An open that fails from here (the claim lost while the session opened) closes the proxies: their servers would hold
  // the runner's process open.
  let tiers: TierProxies | undefined;
  try {
    // A tier's proxy admits the session's tools too: a subagent's child on the tier offers them (runner/subagent.ts).
    tiers = await openTierProxies(options.tiers ?? new Map(), io.models, options.redact, [...spec.tools.map((tool) => tool.name), ...nativeToolNames(options)]);
    return await sessionOn(proxy, options, spec, io, context, tiers);
  } catch (error) {
    await proxy.close().catch(() => undefined);
    await tiers?.close();
    throw error;
  }
}

/** A tier's model as its proxy takes it: its route's provider, model, catalog entry, price and fetch (model-route.ts). */
export type TierModel = Pick<PiAdapterOptions, "provider" | "model" | "like" | "price" | "fetch">;

/** The tier proxies a session holds (openTierProxies): each tier's port for a side request under `label`, and their close. */
export interface TierProxies {
  port(label: string, tier: string): SessionPort | undefined;
  /** Each tier, its route and its proxy: a subagent's child on the tier is sent there on the proxy's own key. */
  readonly each: readonly (readonly [string, TierModel, ModelProxy])[];
  close(): Promise<void>;
}

/** A proxy on `hooks` (the session's booking: its requests are the run's, under its one cap) for `route`'s model, with its
 *  origin, credential, price and fetch, its provider's errors through `redact`. `tools`: the tool names its policy admits
 *  by name on a request of the session's own key (none for a tier's: only side keys reach it). `webSearch`: the session's
 *  own proxy admits its provider's hosted search and prices each search it ran (policyFor, withSearches). */
async function routeProxy(route: TierModel, hooks: SessionIO["models"], tools: readonly string[], redact?: (text: string) => string, tier?: string, webSearch = false): Promise<ModelProxy> {
  const price = route.price && webSearch ? await withSearches(route.provider.api, route.price) : route.price;
  return startModelProxy({
    // A tier's proxy names its tier on each request (ModelRequest.route), so the run's cap prices it as this route books it.
    ...(tier === undefined ? {} : { route: tier }),
    policy: await policyFor(route.provider, route.model, tools, webSearch),
    hooks,
    model: route.model,
    origin: route.provider.origin,
    credential: async () => (await route.provider.credential()) ?? "",
    ...(price ? { price: price as never } : {}),
    ...(route.provider.headers ? { headers: route.provider.headers } : {}),
    ...(route.fetch ? { fetch: route.fetch } : {}),
    ...(redact ? { redact } : {}),
  }, randomBytes(32).toString("base64url"));
}

/** A run's models of other tiers than its own (a learned workflow's node of a tier: AGENT_MODEL_FAST, AGENT_MODEL_STRONG),
 *  each on a proxy of its own beside the session's, on the session's booking (`hooks`, io.models): the one way every
 *  harness serves them, pi's session and a CLI harness's (cli-run-spec.ts). Only the host's own requests reach them (side
 *  keys, AdapterSession.port's `tier`), sent by pi-ai's client of the tier model's own wire (port-models.ts), so a tier
 *  proxy speaks its model's route (model-route.ts routeOf, its translation fetch for a model of neither wire), never the
 *  harness's. One that fails to start closes those started. */
export async function openTierProxies(tiers: ReadonlyMap<string, TierModel>, hooks: SessionIO["models"], redact?: (text: string) => string, tools: readonly string[] = []): Promise<TierProxies> {
  const open = new Map<string, { proxy: ModelProxy; route: TierModel }>();
  const close = async () => {
    for (const { proxy } of open.values()) await proxy.close().catch(() => undefined);
  };
  try {
    for (const [tier, route] of tiers) open.set(tier, { proxy: await routeProxy(route, hooks, tools, redact, tier), route });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    port: (label, tier) => {
      const at = open.get(tier);
      return at ? { url: at.proxy.url, key: at.proxy.sideKey(label), model: at.route.model, api: at.route.provider.api } : undefined;
    },
    each: [...open].map(([tier, { proxy, route }]) => [tier, route, proxy] as const),
    close,
  };
}

/** The session proxy's policy on Messages: claude-agent's (no fork), with pi's tools, the host's own names (`tools`), as
 *  the names its client offers by themselves (its builtins). The CLI's own `mcp__hands__` prefix is not pi's: under it
 *  every one of pi's tool definitions would be dropped and the model offered none. Every other tool definition is
 *  dropped, and a request that offers the session's tools is the turn's answer request. `auth`: how the provider takes
 *  its credential (default x-api-key). */
export function piPolicy(model: string, tools: readonly string[], auth?: "bearer" | "x-api-key", webSearch = false): ProviderPolicy {
  const policy = anthropicPolicy({ model, tools: [], builtins: tools, ...(auth ? { auth } : {}), ...(webSearch ? { webSearch: true, webSearchAllowance: HOSTED_SEARCH_ALLOWANCE_TOKENS } : {}) });
  if (!webSearch) return policy;
  // The hosted search's fees held with its tokens: each use its tool's max_uses allows, at the search's fee. One with no
  // max_uses has no bound, and its worst case is unknown (the proxy's feeMaxUsd).
  return { ...policy, feeMaxUsd: (body) => searchesAllowed(body, (tool) => typeof tool.type === "string" && tool.type.startsWith("web_search_"), "max_uses") * NATIVE_SEARCH_USD } as ProviderPolicy;
}

/** The most searches `body` allows its hosted search tool (the one `isSearch` picks): its `limit` (the tool's own key, or
 *  the body's on Responses), Infinity when it states none, 0 when the body offers no search. */
function searchesAllowed(body: Record<string, unknown>, isSearch: (tool: Record<string, unknown>) => boolean, limit: string, bodyLimit = false): number {
  const search = Array.isArray(body.tools) ? body.tools.find((tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null && isSearch(tool as Record<string, unknown>)) : undefined;
  if (!search) return 0;
  const most = bodyLimit ? body[limit] : search[limit];
  return typeof most === "number" && Number.isInteger(most) && most >= 0 ? most : Infinity;
}

/** The policy of the session's wire, the one each CLI harness of that wire applies (no fork of either): Anthropic's
 *  Messages as claude-agent's (piPolicy), OpenAI's Responses as codex's, which takes pi's tools as the session's own by
 *  name. Either way every other tool definition is dropped and the request that offers them is the turn's answer
 *  request. `webSearch`: the run's web_search is the provider's hosted search, whose one tool each wire's policy admits
 *  as its CLI's own search (claude-agent's on Messages, codex's live search on Responses). */
export async function policyFor(provider: PiAdapterOptions["provider"], model: string, tools: readonly string[], webSearch = false): Promise<ProviderPolicy> {
  if (provider.api === "anthropic-messages") return piPolicy(model, tools, provider.auth, webSearch);
  // Loaded when a session of its wire opens, as the runner loads the codex harness.
  const { codexPolicy, webSearchUsd } = (await import("@parcha/agentrun-harness-codex")) as { codexPolicy(options: { model: string; tools: readonly string[]; webSearch?: "live" }): ProviderPolicy; webSearchUsd(model: string): number | undefined };
  if (!webSearch) return codexPolicy({ model, tools });
  return searchOnce(codexPolicy({ model, tools, webSearch: "live" }), codexPolicy({ model, tools }), webSearchUsd(model));
}

/** Codex's live-search policy (`live`) as pi's session takes it. The Codex CLI offers its search on every request; pi
 *  offers it on one request alone, its web_search's hosted search (hosted-search.ts), so two of its rules are pi's here:
 *  - a request that offered no search ran none (0), read from the request's body, where codex's reads every answer that
 *    does not state its count as unknown; the search's own request is read as codex reads it;
 *  - the hosted search's request has an input bound, its body's (`plain`, the policy with no search) plus the input
 *    HOSTED_SEARCH_ALLOWANCE_TOKENS allows its at most HOSTED_MAX_USES searches, as claude-agent's policy bounds Claude's
 *    search, so a capped run holds it and does not refuse it as unmeasured; and its fees are held with its tokens, each
 *    call its `max_tool_calls` allows at `searchUsd`, the model's price of one (none known: its worst case is unknown). */
function searchOnce(live: ProviderPolicy, plain: ProviderPolicy, searchUsd: number | undefined): ProviderPolicy {
  const offersSearch = (body: Record<string, unknown>) => Array.isArray(body.tools) && body.tools.some((tool) => typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "web_search");
  return {
    ...live,
    usageOf: (text, body) => {
      if (!body || offersSearch(body)) return live.usageOf(text, body);
      const usage = plain.usageOf(text, body);
      return usage && { ...usage, webSearches: 0 };
    },
    feeMaxUsd: (body) => {
      const most = searchesAllowed(body, (tool) => tool.type === "web_search", "max_tool_calls", true);
      return most === 0 ? 0 : most * (searchUsd ?? Number.NaN);
    },
    serverInputOverhead: (body) => {
      if (!offersSearch(body)) return live.serverInputOverhead?.(body);
      const base = plain.serverInputOverhead?.({ ...body, tools: (body.tools as unknown[]).filter((tool) => !(typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "web_search")) });
      return base === undefined ? undefined : base + HOSTED_SEARCH_ALLOWANCE_TOKENS;
    },
  } as ProviderPolicy;
}

/** `price` with each web search a response reports added at its provider's fee, as the wire's CLI prices its own search
 *  (claude-agent's flat fee on Messages, codex's per model on Responses). */
async function withSearches(api: Wire, price: NonNullable<PiAdapterOptions["price"]>): Promise<NonNullable<PiAdapterOptions["price"]>> {
  if (api === "anthropic-messages") return withWebSearches(price as never) as never;
  const codex = (await import("@parcha/agentrun-harness-codex")) as unknown as { withWebSearches(price: unknown): NonNullable<PiAdapterOptions["price"]> };
  return codex.withWebSearches(price);
}

/** The session on its proxy: pi's models through it, the host's tools and the gate as pi's extension, the root's state. */
async function sessionOn(proxy: ModelProxy, options: PiAdapterOptions, spec: SessionSpec, io: PiSessionIO, context: Context, tiers: TierProxies): Promise<AdapterSession> {
  const { run, model, like } = options;
  const { api } = options.provider;
  const models = createModels();
  // pi-ai's client of the session's wire at its proxy (port-models.ts sessionProvider). pi prices nothing itself (the
  // proxy's booking does), so the model's cost stays $0. Image input on either wire (sessionModel): a host tool's images
  // (a screenshot) reach the model in its tool result.
  models.setProvider(sessionProvider(api, proxy, model, { provider: PROVIDER, keyName: "AGENTRUN_SESSION_KEY", ...(like ? { like } : {}), reasoning: false }));
  // Each tier's model at its own proxy, under its own provider id (tierProvider): a conversation whose agent names it
  // (a subagent's) is sent there, and booked as the session's own requests are.
  for (const [tier, route, at] of tiers.each) models.setProvider(sessionProvider(route.provider.api, at, route.model, { provider: tierProvider(tier), keyName: "AGENTRUN_SESSION_KEY", ...(route.like ? { like: route.like } : {}), reasoning: false }));
  // A child made on an earlier claim keeps the tier's model it was made on; when the tier's model has changed since (the
  // server's AGENT_MODEL_STRONG, say), that one is not here, and the child resumes on the tier's model now, as a new call
  // on the tier would run.
  const tierModel = new Map(tiers.each.map(([tier, route]) => [tierProvider(tier), route.model]));
  run.setModels(tierModel.size === 0 ? models : new Proxy(models, {
    get(target, key) {
      if (key === "getModel") return (provider: string, id: string) => target.getModel(provider, id) ?? (tierModel.has(provider) ? target.getModel(provider, tierModel.get(provider)!) : undefined);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }));

  // A session tool whose name a native extension already owns is run by that extension (pi's own tool task), so it is not
  // piTool-wrapped here too: one tool by that name on the agent, offered once.
  const owned = new Set(nativeToolNames(options));
  // The calls the gate let through in this session, before their intent. pi runs a call's beforeTool only before its
  // intent: a call it runs with no pass here is one it reruns after a crash (a replay-safe call whose intent an earlier
  // attempt stored), told to the host tool as an attempt above 0, so the loop asks the gate about it again.
  const passed = new Set<string>();
  const tools = [...spec.tools.filter((tool) => !owned.has(tool.name)).map((tool) => piTool(tool, io, (callId) => (io.gate ? (passed.has(callId) ? 0 : 1) : undefined))), ...(options.tools ?? [])];
  // A refused call's words (the gate's deny, main's), by call: its result is those words alone, as main gives them.
  const refusals = refusalWords();
  const extension = defineExtension({
    name: `agentrun-session-${spec.key}`,
    tools,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, hookContext: Context) => {
          if (!io.gate) return undefined;
          // A model-issued call's count, read only when the gate holds a budget: a nested call (one a tool made) is its
          // parent's part, and is marked so (the cap's wrap-up lets it through).
          const counted = call.parent === undefined ? { callsBefore: (upTo: number) => callsBefore(api, call.id, upTo, hookContext), ownBudget: async () => (await api.snapshot(ConversationToolBudget, api.conversationId, hookContext))?.toolCalls } : { nested: true as const };
          const answer = await io.gate({ callId: call.id, tool: call.name, args: (call.arguments ?? {}) as Record<string, unknown>, ...counted }, hookContext);
          if (answer === "allow") {
            passed.add(call.id);
            return undefined;
          }
          if ("deny" in answer) {
            refusals.refuse(call.id, answer.deny);
            return { block: answer.deny };
          }
          // Parked: held until pi closes the Session, so the call never reaches its intent in this process.
          return new Promise<never>((_, reject) => {
            const signal = hookContext.abortSignal;
            if (signal?.aborted) return reject(new Error("parked"));
            signal?.addEventListener("abort", () => reject(new Error("parked")), { once: true });
          });
        },
        // A call the gate refused: its result is main's words alone, an error, never pi's framing of a blocked call (its
        // diagnostic, which the model reads as "<harness>[error] Tool call blocked: ..."). Every other result is pi's.
        afterTool: async (call, result) => refusals.resultOf(call.id, result) as never,
      }),
      // An answer's cost is the runner's booking of its request, never pi's $0 for a model it has no price for: set on
      // the answer before pi stores it, so the answer, pi.usage and the live timeline carry it; unknown stays unknown.
      hook(GenerationTask, {
        afterResponse: async (message) => {
          if (!io.bookedCost) return;
          const usd = await io.bookedCost();
          if (usd === undefined) return;
          const cost = (message.usage as { cost?: Record<string, unknown> } | undefined)?.cost;
          if (cost) cost.total = usd;
        },
      }),
    ],
  });
  run.registry.install(extension);
  // The run's pi-native extensions (options.extensions), in the claim's registry beside the session's: each tool's computer
  // calls recorded on its row (io.keepCalls), as the loop records its host tools'.
  const native = (options.extensions ?? []).map((each) => (io.keepCalls ? recordingExtension(each, io.keepCalls) : each));
  for (const each of native) run.registry.install(each);
  // The root conversation may exist already (the loop's session records live beside it, under it): its agent is set here,
  // the session's model, the run's system text (pi's instructions, its parts as the CLI adapters join them), this
  // session's tools and the run's native extensions, on every open. A conversation a native tool opens takes this agent's
  // model (pi copies its owner's), so its requests go through this session's proxy.
  const instructions = spec.system.join("\n\n");
  // Its thinking level, the session's (the run's effort), on every open; none leaves pi's default.
  const agent = { model: { provider: PROVIDER, modelId: model }, extensions: [extension, ...native], ...(instructions ? { instructions } : {}), ...(spec.thinking ? { thinkingLevel: spec.thinking } : {}) };
  const root: Conversation = await run.harness.root(context, { agent } as never);
  await root.configure(agent as never, context);

  // The run's input submission, if one was placed: its state says where the session is. Answered: idle. Open, or settled
  // unanswered (a failed turn whose end the loop never read: a claim lost before the run's end landed): an open turn,
  // whose end recover() reads, so a failed turn ends the run failed, never as a completed one.
  let input: Submission | undefined;
  /** The session closed (its proxy with it): its port gives no route. */
  let closed = false;
  const existing = await run.harness.commit((tx) => tx.submissionByRequest(root.id, INPUT_REQUEST), context);
  if (existing) input = await run.harness.submission(existing.id, context);
  // Once that first input is settled, a later input of the root still in flight (a follow-up a reopen sent, its turn cut by
  // a lost claim or a drain) is the turn the session is in: its end is the one recover() reads, never the first input's.
  const later = existing && (existing.status === "done" || existing.status === "unanswered")
    ? (await run.harness.inspect(context)).submissions.filter((one) => one.conversationId === root.id && one.type === "input").at(-1)
    : undefined;
  if (later) input = await run.harness.submission(later.id, context);
  let state: AdapterSession["state"] = existing === undefined ? "new" : later ? "open_turn" : existing.status === "done" ? "idle" : "open_turn";
  let running: Promise<{ status: TurnStatus; error?: string }> | undefined;
  const watch = (submission: Submission) => {
    // Its wait never holds the claim's signal (durableWait): an abort while it registers (a close, a lost claim, as a
    // resumed loop opens) ends the turn interrupted here, never as a rejection nothing handles, which ends the process.
    running = durableWait((at) => submission.wait(at), context).then(
      (record) => {
        state = "idle";
        const status: TurnStatus = record.status === "done" ? "completed" : "failed";
        io.onEvent({ type: "turn_end", status });
        return { status };
      },
      (error: Error) => {
        io.onEvent({ type: "turn_end", status: "interrupted" });
        return { status: "interrupted" as TurnStatus, error: error.message };
      },
    );
  };
  // No watch here: recover() starts it. A watch from open would set state idle as soon as a settled (or fast-recovered)
  // turn's wait returned, before the loop read state, and the loop would take the turn as never placed and so completed.

  return {
    get state() {
      return state;
    },
    async send(text, options) {
      // The run's first input under INPUT_REQUEST; a follow-up (a raised run's turn) under its own id, a turn of its own.
      // With `origin` (a trigger's first input), the host's input entry carries it, as a trigger's steer's does.
      const entry = options?.origin ? { entry: { kind: KINDS.input, data: { origin: options.origin } as JsonValue } } : {};
      input = await root.submit({ type: "input", content: text, requestId: options?.id ?? INPUT_REQUEST, ...entry } as never, context);
      state = "open_turn";
      watch(input);
    },
    async recover() {
      // pi recovers its own tasks when its Harness opens; the turn is the input's.
      if (input) watch(input);
    },
    async settleOpenTurn() {
      await root.abort(context).catch(() => undefined);
      await run.harness.waitForIdle(context).catch(() => undefined);
      state = "idle";
    },
    async turnEnd() {
      if (!running) throw new Error("pi: no turn is in flight");
      return running;
    },
    async interrupt() {
      await root.abort(context).catch(() => undefined);
    },
    async close() {
      closed = true;
      await proxy.close().catch(() => undefined);
      await tiers.close();
    },
    // The session's own model route for a request the host sends beside pi's (a learned workflow's model node): its proxy
    // with a side key minted for `label`, pi's model and the provider's wire (never a literal), so the request goes through
    // the same policy, origin, credential, price and booking as pi's own, labelled. `tier`: that tier's proxy and model
    // instead (options.tiers), on the same booking; none for a tier the session has no proxy of. None once closed.
    port: (label: string, tier?: string) => {
      if (closed) return undefined;
      return tier === undefined ? { url: proxy.url, key: proxy.sideKey(label), model, api } : tiers.port(label, tier);
    },
    // A steer: pi places it in the turn in flight, at its next boundary. `id`: its request id (the command's), so the
    // commit that places it is the one that takes its row. `origin` (a trigger's message): its input is the host's user
    // entry (KINDS.input) with that origin, in the same submission, so the attribution lands with the message or not at all.
    async steer(text: string, id?: string, mode: "steer" | "followUp" = "steer", options?: { readonly origin?: { readonly [key: string]: unknown } }) {
      const entry = options?.origin ? { entry: { kind: KINDS.input, data: { origin: options.origin } as JsonValue } } : {};
      await root.submit({ type: "input", content: text, whenBusy: mode, ...(id ? { requestId: id } : {}), ...entry } as never, context);
    },
  } satisfies AdapterSession;
}

/** A refused call's words by call (the gate's deny, main's words), held from the refusal (beforeTool's block) to the
 *  call's result (afterTool): a blocked result becomes those words alone, an error, as main gives a refused call's
 *  result, never pi's framing of a blocked call. Every other result is pi's own. `held`: the words still held. */
export function refusalWords() {
  const words = new Map<string, string>();
  return {
    refuse(callId: string, text: string): void {
      words.set(callId, text);
    },
    resultOf(callId: string, result: { readonly diagnostics?: readonly { readonly code?: string }[] }): { output: { type: "text"; text: string }[]; isError: true; details: { [CALL_REFUSED]: true } } | undefined {
      const text = words.get(callId);
      // Let go on every result: the call has its one result now, whatever it is.
      words.delete(callId);
      const blocked = result.diagnostics?.some((diagnostic) => diagnostic.code === "blocked");
      if (text === undefined || !blocked) return undefined;
      // Marked refused in its details (which the model never reads): its Timeline rows say it was refused, never that it
      // ran and failed.
      return { output: [{ type: "text", text }], isError: true, details: { [CALL_REFUSED]: true } };
    },
    get held(): number {
      return words.size;
    },
  };
}

/** The tool calls a hook's conversation made before `callId`, at most `upTo`: its committed entries read oldest first, a
 *  page at a time, only as far as the count needs (tool-budget.ts countCalls). */
async function callsBefore(api: HookApi, callId: string, upTo: number, context: Context): Promise<number> {
  let counted = { count: 0, done: upTo <= 0 };
  let cursor: Cursor | undefined;
  while (!counted.done) {
    const page = await api.entries({ order: "ascending" }, 100, cursor, context);
    counted = countCalls(page.items, callId, upTo, counted.count);
    cursor = page.next;
    if (cursor === undefined) break;
  }
  return counted.count;
}

/** pi's output limits for a host tool, from the host's result bound: a result within it holds at most that many
 *  characters (UTF-16 units), so at most that many lines plus one, and three bytes of UTF-8 to a character. pi's own
 *  default (50 KB or 2,000 lines, its head kept) would cut the end off a host tool's answer, where the answer says how to
 *  go on: an MCP answer's "[cut at ...; the whole answer is in the run's files at <path>]", a read's "Use offset=<n> to
 *  continue". Each CLI adapter is told the same bound (harness-opencode/config.ts TOOL_OUTPUT, Claude's maxResultSizeChars,
 *  Codex's tool_output_token_limit); each host tool keeps its own answer within it (test/host-bounds.test.mjs). */
export const HOST_TOOL_OUTPUT = Object.freeze({ maxLines: HOST_RESULT_MAX_CHARS + 1, maxBytes: HOST_RESULT_MAX_CHARS * 3 });

/** A host tool as a pi tool: replay-safe or at most once, its answer the host's text and any images it shows, passed
 *  whole within the host's bound (HOST_TOOL_OUTPUT). Each call gets what pi's own tool task gives a tool: the calling
 *  agent's model, resolved in the session's models (its input and input limits, which a file read sizes an image by),
 *  and pi's output stream (the running tool's live slot); and its attempt (`attemptOf`: above 0 for a call the gate did
 *  not pass in this session, pi's rerun after a crash). */
function piTool(tool: HostTool, io: PiSessionIO, attemptOf: (callId: string) => number | undefined = () => undefined) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as never,
    replay: tool.replay === "safe" ? "safe" : "unsafe",
    outputLimits: HOST_TOOL_OUTPUT,
    execute: async (args: unknown, api, toolContext: Context) => {
      io.onEvent({ type: "tool_start", callId: api.callId, name: tool.name, args });
      const attempt = attemptOf(api.callId);
      const ref = (await api.agent(toolContext)).model;
      const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
      const answer = await tool.call(args ?? {}, {
        callId: api.callId, signal: toolContext.abortSignal ?? io.signal,
        ...(model ? { model } : {}),
        output: (chunk: string) => api.output(chunk),
        ...(attempt === undefined ? {} : { attempt }),
      });
      io.onEvent({ type: "tool_end", callId: api.callId, name: tool.name, isError: Boolean(answer.isError), result: answer.text });
      const images = (answer.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
      return { output: [{ type: "text" as const, text: answer.text }, ...images], ...(answer.isError ? { isError: true } : {}) } as never;
    },
  });
}
