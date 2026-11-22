// A backend SDK run's end-of-run asks (its compile turn): a paid model request like a pi turn, on the same path. Its
// session (SDK_ASK_SESSION) lives in the run's own journal (journalSessions). Before it leaves, the run's cap judges it as
// it judges every paid step (the kernel's runCap: beforeRequestOf over runBooking), with every session of the run summed
// and what the run spent outside them (`AskCap.beside`: its backend's reported job), never the ask's own spend alone; it is
// held at its whole input uncached and its whole output bound, so a compile never runs on a cut answer. One the cap refuses
// is never sent: the ask throws AskOverCap in the cap's words. An admitted one's record is written and made durable before
// it leaves, and its cost booked when it answers (modelPortFor); it reaches the provider only through the kernel's model
// proxy (startModelProxy with the booking's port), which sends only what the cap admitted.
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { modelPortFor, type Refusal, type Wire } from "@parcha/agentrun-kernel";
import { runCap } from "@parcha/agentrun-kernel/kernel/cap";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import type { Journal } from "./loop-contract.js";
import { FAUX_ENV } from "../model.js";
import { sessionProvider } from "../port-models.js";
import { anthropicModelId, openRouterOnly, providerFor } from "../provider.js";
import { capModelOf } from "./adapter-run-spec.js";
import { policyFor } from "./adapters/pi.js";
import type { RouteCost } from "./model-route.js";
import { journalSessions } from "./sessions.js";

/** How long the ask waits, once it answered, for the proxy to book its request: the proxy books a request after its
 *  client has the whole answer, so the spend is read once it is booked. One booked later than this reads unknown. */
export const ASK_BOOKING_WAIT_MS = 10_000;
/** The session an SDK run's end-of-run asks are booked under, in the run's journal. */
export const SDK_ASK_SESSION = "learning.sdk";
const PROVIDER = "agentrun-sdk-ask";

/** Where the ask goes: the route's wire (`api`, Anthropic's Messages or OpenAI's Responses) at `origin`, for `model`,
 *  priced by `price`. A model on neither wire comes as the route's Messages translation (model-route.ts messagesFetch). */
export interface AskRoute {
  readonly provider: { readonly api: Wire; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>>; readonly auth?: "bearer" | "x-api-key" };
  readonly model: string;
  /** The catalog's entry for the model (whether it reasons, its window), as pi's session takes it (model-route.ts). */
  readonly like?: { readonly reasoning?: boolean; readonly contextWindow?: number; readonly maxTokens?: number };
  /** A request's price from its usage (the proxy's booking reads it). */
  readonly price?: (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => number | null;
  /** The upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
  readonly cost?: RouteCost;
  readonly unpriced?: boolean;
  readonly outputCeiling?: number | null;
}

/** The run's cap the ask is held to: its figure now (a raise's, else its launch's; undefined: none, and only the run's
 *  limit of requests on free models holds), what the run spent outside its sessions (null: unknown, which a cap refuses
 *  on), and that limit (`freeRequests`). */
export interface AskCap {
  readonly capUsd: number | undefined;
  beside(): Promise<number | null>;
  readonly freeRequests: number;
}

/** An ask the run's cap refused before it left: nothing of it was sent. Its message is the cap's words; `booked`, what the
 *  ask's session had booked before it (an earlier attempt's requests; usd null: unknown). */
export class AskOverCap extends Error {
  override name = "AskOverCap";
  constructor(message: string, readonly booked: { readonly usd: number | null; readonly turns: number }) {
    super(message);
  }
}

/** `journal` as its Harness sees it: every method its own, but close, which is the claim's to do, not the ask's. */
function unclosed<T extends object>(journal: T): T {
  return new Proxy(journal, {
    get(target, key) {
      if (key === "close") return async () => undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type Answer = { content: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string };

/** One booked ask on `route`, held to the run's `cap`: its text, and what it spent (null: unknown). */
export function bookedAsk(route: AskRoute, cap: AskCap): (request: { prompt: string; maxTokens: number }, signal: AbortSignal, run: { journal(): Journal; flush(): Promise<void> }) => Promise<{ text: string; usd: number | null }> {
  const { model } = route;
  const capModel = capModelOf(route);
  return async (request, signal, run) => {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const harness = await Harness.open(unclosed(run.journal()), { models: createModels(), registry: createRegistry(), onReport: () => {} }, context);
    try {
      const sessions = journalSessions(harness, context, { flush: () => run.flush() });
      const writer = await sessions.open(SDK_ASK_SESSION);
      // The run's one rule, as every paid step takes it: asked with every session of the run summed and its spend beside them.
      const held = runCap({
        sessions: { keys: () => sessions.keys(), read: (key) => sessions.read(key), beside: () => cap.beside() },
        capUsd: () => cap.capUsd,
        modelOf: (id) => (id === model ? capModel : undefined),
        freeRequests: cap.freeRequests,
        stopped: signal,
      });
      let refused: Refusal | undefined;
      let booked: (() => void) | undefined;
      const booking = await modelPortFor(writer, {
        key: SDK_ASK_SESSION,
        label: "learning",
        // Its whole output bound is the least it is sent with: refused, never cut.
        beforeRequest: async (asked) => {
          const answer = await held.before(asked.outputTokensAsked === undefined ? asked : { ...asked, outputTokensLeast: asked.outputTokensAsked });
          if (answer && "refuse" in answer) refused = answer;
          return answer;
        },
        // The rule before a side effect: the request's record is durable before the request leaves.
        onEvent: async (event) => {
          if (event.type === "request_start") await run.flush();
          if (event.type === "request_end") booked?.();
        },
      });
      // A request an earlier attempt sent and a crash cut is booked first, at its held figure.
      await booking.bookCut();
      const before = booking.spentUsd();
      const bookedOnce = new Promise<true>((resolve) => (booked = () => resolve(true)));
      const proxy = await startModelProxy({
        policy: await policyFor(route.provider, model, []),
        hooks: booking.models,
        model,
        origin: route.provider.origin,
        credential: async () => (await route.provider.credential()) ?? "",
        ...(route.price ? { price: route.price as never } : {}),
        ...(route.provider.headers ? { headers: route.provider.headers } : {}),
        ...(route.fetch ? { fetch: route.fetch } : {}),
      }, randomBytes(32).toString("base64url"));
      try {
        const models = createModels();
        models.setProvider(sessionProvider(route.provider.api, proxy, model, { provider: PROVIDER, keyName: "AGENTRUN_SDK_ASK_KEY", like: { ...route.like, maxTokens: request.maxTokens }, reasoning: false }));
        const target = models.getModel(PROVIDER, model);
        // Refused by the cap before it left, however its client came back: nothing of it was sent or spent.
        const overCap = () => (refused ? new AskOverCap(refused.refuse, { usd: booking.spentUsd(), turns: booking.turns() }) : undefined);
        let answer: Answer;
        try {
          answer = (await models.completeSimple(target as never, { messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] } as never, { signal, maxTokens: request.maxTokens } as never)) as unknown as Answer;
        } catch (error) {
          throw overCap() ?? error;
        }
        const over = overCap();
        if (over) throw over;
        if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(`the request failed: ${answer.errorMessage ?? answer.stopReason}`);
        const text = answer.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
        let timer: NodeJS.Timeout | undefined;
        const inTime = await Promise.race([bookedOnce, new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ASK_BOOKING_WAIT_MS)))]);
        clearTimeout(timer);
        const after = inTime ? booking.spentUsd() : null;
        return { text, usd: before === null || after === null ? null : after - before };
      } finally {
        await proxy.close().catch(() => undefined);
      }
    } finally {
      await harness.close(context).catch(() => undefined);
    }
  };
}

/** The ask's route for `model` (the agent's own), from the runner's one route (`routeOf`), but where this host reaches the
 *  model's vendor only through OpenRouter (provider.ts openRouterOnly):
 *  - an Anthropic model, at OpenRouter's Messages endpoint as a claude-agent run's requests go (providerFor), priced at
 *    OpenRouter's catalog price of the model;
 *  - an OpenAI model, the same model on OpenRouter (`openrouter/openai/<id>`, the route's own translation).
 *  A faux host (FAUX_ENV) and a gateway take the model as named. Every other Anthropic model goes by Anthropic's own id
 *  (anthropicModelId), so the catalog finds it. */
export async function askRouteOf(model: string | undefined, env: NodeJS.ProcessEnv, routeOf: (model: string | undefined) => AskRoute | Promise<AskRoute>): Promise<AskRoute> {
  const slash = model?.indexOf("/") ?? -1;
  if (model === undefined || slash < 1 || env.AGENT_MODEL_BASE_URL || env[FAUX_ENV]) return routeOf(model);
  const [vendor, id] = [model.slice(0, slash), model.slice(slash + 1)];
  if (vendor === "anthropic" && openRouterOnly("anthropic-messages", env)) {
    const sent = providerFor("anthropic-messages", env, { provider: "anthropic", modelId: id }, "the SDK run's learning");
    const priced = await routeOf(`${sent.priceModel.provider}/${sent.priceModel.modelId}`);
    const capped = { ...(priced.cost ? { cost: priced.cost } : {}), ...(priced.unpriced ? { unpriced: true } : {}), ...(priced.outputCeiling !== undefined ? { outputCeiling: priced.outputCeiling } : {}) };
    return { model: sent.modelId, provider: { api: "anthropic-messages", origin: sent.origin, credential: sent.credential, auth: sent.auth }, ...(priced.like ? { like: priced.like } : {}), ...(priced.price ? { price: priced.price } : {}), ...capped };
  }
  if (vendor === "openai" && openRouterOnly("openai-responses", env)) return routeOf(`openrouter/openai/${id}`);
  if (vendor === "anthropic") return routeOf(`anthropic/${anthropicModelId({ provider: "anthropic", modelId: id })}`);
  return routeOf(model);
}
