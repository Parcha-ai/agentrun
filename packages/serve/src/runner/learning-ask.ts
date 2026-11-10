// The learning run's grader call (learning-loop.ts LearningLoopDeps.ask): a paid model request like a pi turn, on the
// same path. Its session ("learning.grade") lives in the learning run's own journal (journalSessions); the host's check
// before it leaves is the learning run's cap, asked with the run's totals (runBooking, the run's one booking); its record
// is written and made durable before it leaves, and its cost booked when it answers (modelPortFor); and it reaches the
// provider only through the kernel's model proxy, which admits and books it (startModelProxy with the booking's port).
// What it spent is that booking's, and its tokens the answer's usage: the grade's cost_usd and tokens.
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { type BeforeRequest, modelPortFor, type Refusal, runBooking, type Wire } from "@parcha/agentrun-kernel";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import type { Tokens } from "../learning.js";
import { sessionProvider } from "../port-models.js";
import { policyFor } from "./adapters/pi.js";
import type { LearningLoopDeps } from "./learning-loop.js";
import { journalSessions } from "./sessions.js";

import { GRADE_SESSION } from "./journal-kinds.js";
/** The session the grader's requests are booked under, in the learning run's journal. */
export { GRADE_SESSION };
const PROVIDER = "agentrun-grade";

/** Where the grader's request goes: the route's wire (`api`, Anthropic's Messages or OpenAI's Responses) at `origin`, for
 *  `model`, priced by `price`. A model on neither wire comes as the route's Messages translation (model-route.ts
 *  messagesFetch, its `fetch`). */
export interface GraderRoute {
  readonly provider: { readonly api: Wire; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>>; readonly auth?: "bearer" | "x-api-key" };
  readonly model: string;
  /** The catalog's entry for the model (whether it reasons, its window), as pi's session takes it (model-route.ts). */
  readonly like?: { readonly reasoning?: boolean; readonly contextWindow?: number; readonly maxTokens?: number };
  /** A request's price from its usage (the proxy's booking reads it). */
  readonly price?: (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => number | null;
  /** The upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
}

export interface BookedAskOptions extends GraderRoute {
  /** The learning run's cap: the host's check before each paid request (the kernel cap's beforeRequestOf). */
  readonly beforeRequest?: BeforeRequest;
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

type Answer = { content: { type: string; text?: string }[]; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string; errorMessage?: string };

export function bookedAsk(options: BookedAskOptions): LearningLoopDeps["ask"] {
  const { model } = options;
  return async (request, signal, run) => {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    // The claim's journal (a store hands one storage per claim, the loop's too) under a Harness of the ask's own, whose
    // close leaves the storage open: the loop goes on writing its entries there after the grade.
    const harness = await Harness.open(unclosed(run.journal()), { models: createModels(), registry: createRegistry(), onReport: () => {} }, context);
    try {
      const sessions = journalSessions(harness, context, { flush: () => run.flush() });
      const writer = await sessions.open(GRADE_SESSION);
      // The cap is the learning run's: asked with every session of the run summed, never this one's alone.
      const hostCheck = options.beforeRequest ? runBooking(sessions, options.beforeRequest) : undefined;
      let refused: Refusal | undefined;
      const booking = await modelPortFor(writer, {
        key: GRADE_SESSION,
        label: "grade",
        ...(hostCheck ? { beforeRequest: async (asked) => {
          const answer = await hostCheck(asked);
          if (answer && "refuse" in answer) refused = answer;
          return answer;
        } } : {}),
        // The rule before a side effect: the request's record is durable before the request leaves.
        onEvent: async (event) => {
          if (event.type === "request_start") await run.flush();
        },
      });
      // A grade request an earlier attempt sent and a crash cut is booked first, at its held figure.
      await booking.bookCut();
      const before = booking.spentUsd();
      // The policy of the route's wire, as pi's session takes it (pi.ts policyFor: claude-agent's on Messages, codex's on
      // Responses, no fork); the grade offers no tool.
      const proxy = await startModelProxy({
        policy: await policyFor(options.provider, model, []),
        hooks: booking.models,
        model,
        origin: options.provider.origin,
        credential: async () => (await options.provider.credential()) ?? "",
        ...(options.price ? { price: options.price as never } : {}),
        ...(options.provider.headers ? { headers: options.provider.headers } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }, randomBytes(32).toString("base64url"));
      try {
        // pi-ai's client of the route's wire at the proxy (port-models.ts sessionProvider), as pi's session reaches its own.
        const models = createModels();
        models.setProvider(sessionProvider(options.provider.api, proxy, model, { provider: PROVIDER, keyName: "AGENTRUN_GRADE_KEY", like: { ...options.like, maxTokens: request.maxTokens }, reasoning: false }));
        const target = models.getModel(PROVIDER, model);
        const answer = (await models.completeSimple(target as never, { messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] } as never, { signal, maxTokens: request.maxTokens } as never)) as unknown as Answer;
        if (refused) throw new Error(refused.refuse);
        if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(`the grade's request failed: ${answer.errorMessage ?? answer.stopReason}`);
        const text = answer.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
        const after = booking.spentUsd();
        const usd = before === null || after === null ? null : after - before;
        // pi-ai counts cache reads and writes apart from input, as the grade's tokens do.
        const used = answer.usage;
        const tokens: Tokens | null = used ? { input: used.input, cache_read: used.cacheRead ?? 0, cache_write: used.cacheWrite ?? 0, output: used.output } : null;
        return { text, usd, tokens };
      } finally {
        await proxy.close().catch(() => undefined);
      }
    } finally {
      await harness.close(context).catch(() => undefined);
    }
  };
}
