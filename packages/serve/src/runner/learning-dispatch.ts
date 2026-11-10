// The runner's dispatch for a launch of harness "learning" (learning-factory.ts LEARNING_HARNESS): the learning loop, its
// grade asked through the runner's one model route. Per learning run, from its launch: the grade model (`model`, the
// server's gradeModelOf, written when the run that learned ended), else the agent's own model, as main grades. The
// grade is booked as the grade's (learning-ask.ts bookedAsk: the learning run's own records, the kernel's model proxy)
// and capped by nothing: main books it to the learning meter and caps no grade. A grader that never answers is cut at
// the grade's bound, and what it spent is unknown (null).
import { FAUX_ENV } from "../model.js";
import { anthropicModelId, openRouterOnly, providerFor } from "../provider.js";
import { bookedAsk, type GraderRoute } from "./learning-ask.js";
import { learningLoopFactory } from "./learning-factory.js";
import { GRADE_TIMEOUT_MS, type LearningLoopDeps } from "./learning-loop.js";
import type { LoopFactory } from "./loop-contract.js";
import type { Store } from "../store/store.js";

/** What a grade asks the runner's route for: the grade model the launch names (`model`), the model of the run that
 *  learned, as its revision names it (`own`: main grades on it when no grade model is named), and the agent. */
export interface GradeRouteAsk {
  readonly model?: string;
  readonly own?: string;
  readonly agentId: string;
}

/** The model a grade runs on, main's order: the grade model the server names, else the agent's own (the model its
 *  revision names), else none (the host's default, which the route picks). */
export const gradeModelFor = (grade: Pick<GradeRouteAsk, "model" | "own">): string | undefined => grade.model ?? grade.own;

export interface LearningDispatchDeps {
  readonly store: Pick<Store, "runs" | "agents" | "learning">;
  /** The server's data directory: each agent's learning folder. */
  readonly data: string;
  /** The runner's one model route (its pi runs take the same): where a grade goes, on which model, at what price; under
   *  --faux, the faux model's. GraderRoute moves to runner/model-route.ts with the route. */
  readonly routeOf: (grade: GradeRouteAsk) => GraderRoute | Promise<GraderRoute>;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** For tests: the grade's bound, as a signal. Default: GRADE_TIMEOUT_MS from the ask. */
  readonly gradeBound?: () => AbortSignal;
  /** Every value a consolidation must never keep (the server's sealed secrets and the runner's), read at each one. */
  readonly refuse?: () => Promise<readonly string[]>;
}

const objectOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});

/** The grade's route for `model` (the grade model the server names; undefined, the agent's own), from the runner's one
 *  route (`routeOf`), but where this host reaches the model's vendor only through OpenRouter (provider.ts
 *  openRouterOnly: its one key for that wire is OpenRouter's, no gateway), as main's grade reaches it there:
 *  - an Anthropic model, at OpenRouter's Messages endpoint as a claude-agent run's requests go (providerFor: Anthropic's
 *    own id on the wire, OpenRouter's key as a bearer token, its one credential), priced at OpenRouter's catalog price of
 *    the model (its priceModel, through the runner's route);
 *  - an OpenAI model, the same model on OpenRouter (`openrouter/openai/<id>`, the route's own translation).
 *  A faux host (FAUX_ENV) and a gateway take the model as named: a faux grade never reaches a real provider, whatever
 *  key the host inherited. Every other Anthropic model goes by Anthropic's own id (anthropicModelId: OpenRouter's
 *  dotted name dashed), as its harness's model selection names it (provider.ts modelOn), so the catalog finds it. */
export async function gradeRouteOf(model: string | undefined, env: NodeJS.ProcessEnv, routeOf: (model: string | undefined) => GraderRoute | Promise<GraderRoute>): Promise<GraderRoute> {
  const slash = model?.indexOf("/") ?? -1;
  if (model === undefined || slash < 1 || env.AGENT_MODEL_BASE_URL || env[FAUX_ENV]) return routeOf(model);
  const [vendor, id] = [model.slice(0, slash), model.slice(slash + 1)];
  if (vendor === "anthropic" && openRouterOnly("anthropic-messages", env)) {
    const sent = providerFor("anthropic-messages", env, { provider: "anthropic", modelId: id }, "the grader");
    const priced = await routeOf(`${sent.priceModel.provider}/${sent.priceModel.modelId}`);
    return { model: sent.modelId, provider: { api: "anthropic-messages", origin: sent.origin, credential: sent.credential, auth: sent.auth }, ...(priced.like ? { like: priced.like } : {}), ...(priced.price ? { price: priced.price } : {}) };
  }
  if (vendor === "openai" && openRouterOnly("openai-responses", env)) return routeOf(`openrouter/openai/${id}`);
  if (vendor === "anthropic") return routeOf(`anthropic/${anthropicModelId({ provider: "anthropic", modelId: id })}`);
  return routeOf(model);
}

/** The learning run's grade route: its launch's grade model, the model the revision of the run that learned names (its
 *  `model`, as main's grade reads agent.model), and that run's agent. A consolidation run is its own source: its agent's
 *  revision, as it was queued. */
async function gradeOf(store: LearningDispatchDeps["store"], learningRunId: string): Promise<GradeRouteAsk> {
  const body = objectOf((await store.runs.launch(learningRunId)).body);
  const sourceId = objectOf(body.input).consolidate !== undefined ? learningRunId : objectOf(body.input).runId;
  const source = typeof sourceId === "string" ? await store.runs.get(sourceId) : undefined;
  if (!source) throw new Error(`the learning run ${learningRunId} names no run it learns from`);
  const own = objectOf((await store.agents.revision(source.revisionId))?.body).model;
  return { ...(typeof body.model === "string" && body.model !== "" ? { model: body.model } : {}), ...(typeof own === "string" && own !== "" ? { own } : {}), agentId: source.agentId };
}

/** The loop for a launch of harness "learning": the runner's dispatch calls it for each such run it claims. */
export function learningLoopOf(deps: LearningDispatchDeps): LoopFactory {
  return (loopDeps) => {
    let claimed: string | undefined;
    const ask: LearningLoopDeps["ask"] = async (request, signal, run) => {
      if (claimed === undefined) throw new Error("the learning run's grade was asked before its claim");
      const route = await deps.routeOf(await gradeOf(deps.store, claimed));
      // The loop's own signal (a stop, a lost claim, its bound) and the grade's bound, both: whichever ends first cuts it.
      const bound = deps.gradeBound ? deps.gradeBound() : AbortSignal.timeout(GRADE_TIMEOUT_MS);
      return bookedAsk(route)(request, AbortSignal.any([signal, bound]), run);
    };
    const loop = learningLoopFactory({ store: deps.store, data: deps.data, ask, ...(deps.log ? { log: deps.log } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.refuse ? { refuse: deps.refuse } : {}) })(loopDeps);
    return {
      start: (claim) => {
        claimed = claim.runId;
        return loop.start(claim);
      },
      command: (command) => loop.command(command),
      stop: (reason) => loop.stop(reason),
    };
  };
}
