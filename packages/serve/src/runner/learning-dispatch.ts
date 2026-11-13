// The runner's dispatch for a launch of harness "learning" (learning-factory.ts LEARNING_HARNESS): the learning loop, its
// grade asked through the runner's one model route. Per learning run, from its launch: the grade model (`model`, the
// server's gradeModelOf, written when the run that learned ended), else the agent's own model, as main grades. The
// grade is booked as the grade's (learning-ask.ts bookedAsk: the learning run's own records, the kernel's model proxy).
// A run with a cap never goes past it by its grade: its learning run's launch carries what the cap left once the run's
// own spend (its job, its follow-ups, each look-back) and its earlier rounds' grades are counted (max_cost_usd,
// learning-end.ts gradeCapOf), and each grader call is judged against it before it leaves by the kernel's one rule
// (beforeRequestOf, over the learning run's one booking) at its worst case: its input uncached and its whole output bound
// (GRADE_MAX_TOKENS), never cut down to fit, so a verdict is never lost to a short answer. A call that doesn't fit is
// never sent, and the grade is skipped, said so (learning-loop.ts GradeOverCap). The generality pre-check's Jev requests
// are the grade's spend too: before they leave, their worst case (decision-cap.ts holdOf, strict: the rule a workflow's
// decision is held at under its run's cap) is judged against the same cap, less what an earlier attempt's cut check may
// have spent; a check that doesn't fit is never sent, and is skipped, said so (learning-loop.ts GeneralOverCap), the
// grader then judged on its own. What the check spent is outside the grade's records, so each grader call's room is the
// cap less it (the ask's `beside`: its kept dollars, else its worst case). An uncapped run's grade is capped by nothing. A
// grader that never answers is cut at the grade's bound, and what it spent is unknown (null).
import { beforeRequestOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { BeforeRequest } from "@parcha/agentrun-kernel";
import type { DecisionProvider } from "@parcha/agentrun-dsl";
import { money } from "../cap.js";
import { holdOf } from "../decision-cap.js";
import { generalRequest, generalScores, type GeneralSource } from "../learn/general.js";
import type { NoteText } from "../learn/grade.js";
import { FAUX_ENV } from "../model.js";
import { anthropicModelId, openRouterOnly, providerFor } from "../provider.js";
import { capModelOf } from "./adapter-run-spec.js";
import { bookedAsk, type GraderRoute } from "./learning-ask.js";
import { learningLoopFactory } from "./learning-factory.js";
import { GeneralOverCap, GRADE_TIMEOUT_MS, type LearningLoopDeps } from "./learning-loop.js";
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
  /** This host's Jev, for the generality pre-check (learn/general.ts): undefined when it has no Jev key, read at each
   *  learning run so a key saved in Settings with no restart is used by the next one. */
  readonly jev?: () => Promise<DecisionProvider | undefined>;
  /** The bar a note's Jev score must reach to be graded (learn/general.ts generalThresholdOf). */
  readonly generalThreshold?: number;
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
    // Priced as OpenRouter lists it, for the booking and for the cap's judgement before it leaves alike.
    const capped = { ...(priced.cost ? { cost: priced.cost } : {}), ...(priced.unpriced ? { unpriced: true } : {}), ...(priced.outputCeiling !== undefined ? { outputCeiling: priced.outputCeiling } : {}) };
    return { model: sent.modelId, provider: { api: "anthropic-messages", origin: sent.origin, credential: sent.credential, auth: sent.auth }, ...(priced.like ? { like: priced.like } : {}), ...(priced.price ? { price: priced.price } : {}), ...capped };
  }
  if (vendor === "openai" && openRouterOnly("openai-responses", env)) return routeOf(`openrouter/openai/${id}`);
  if (vendor === "anthropic") return routeOf(`anthropic/${anthropicModelId({ provider: "anthropic", modelId: id })}`);
  return routeOf(model);
}

/** The learning run's grade route: its launch's grade model, the model the revision of the run that learned names (its
 *  `model`, as main's grade reads agent.model), and that run's agent; and the cap its launch carries (`capUsd`: what the
 *  run's cap left for the grade; none for an uncapped run). A cap that is not a figure of 0 or more is no room ($0). */
async function gradeOf(store: LearningDispatchDeps["store"], learningRunId: string): Promise<{ route: GradeRouteAsk; capUsd?: number }> {
  const body = objectOf((await store.runs.launch(learningRunId)).body);
  const sourceId = objectOf(body.input).runId;
  const source = typeof sourceId === "string" ? await store.runs.get(sourceId) : undefined;
  if (!source) throw new Error(`the learning run ${learningRunId} names no run it learns from`);
  const own = objectOf((await store.agents.revision(source.revisionId))?.body).model;
  const route = { ...(typeof body.model === "string" && body.model !== "" ? { model: body.model } : {}), ...(typeof own === "string" && own !== "" ? { own } : {}), agentId: source.agentId };
  if (!("max_cost_usd" in body)) return { route };
  const cap = body.max_cost_usd;
  return { route, capUsd: typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : 0 };
}

/** The learning run's cap on its grade (`capUsd`), the kernel's one rule over its booking (bookedAsk's runBooking): each
 *  grader call on `route` judged at its worst case before it leaves, every input token uncached ("strict") and its whole
 *  output bound as the least it may be sent with, so a grade never runs on a cut answer. Another model than the route's is
 *  priced by nothing here: refused. */
export function gradeCap(capUsd: number, route: GraderRoute): BeforeRequest {
  const model = capModelOf(route);
  const judge = beforeRequestOf({ capUsd: () => capUsd, modelOf: (id) => (id === route.model ? model : undefined), mode: "strict" });
  return (request) => judge({ ...request, ...(request.outputTokensAsked !== undefined ? { outputTokensLeast: request.outputTokensAsked } : {}) });
}

/** The worst case of the generality check's requests to `jev` (learn/general.ts generalRequest, one a note), each held as a
 *  workflow's decision is under its run's cap (decision-cap.ts holdOf, strict); unpriced when any one's price is not known
 *  here. */
export async function generalHeld(jev: DecisionProvider, notes: readonly NoteText[], source: GeneralSource): Promise<{ usd: number } | { unpriced: string }> {
  let usd = 0;
  for (const note of notes) {
    const hold = await holdOf(jev, generalRequest(note, source) as Parameters<typeof holdOf>[1], "strict");
    if ("unpriced" in hold) return hold;
    usd += hold.usd;
  }
  return { usd };
}

/** The loop for a launch of harness "learning": the runner's dispatch calls it for each such run it claims. */
export function learningLoopOf(deps: LearningDispatchDeps): LoopFactory {
  return (loopDeps) => {
    let claimed: string | undefined;
    const ask: LearningLoopDeps["ask"] = async (request, signal, run) => {
      if (claimed === undefined) throw new Error("the learning run's grade was asked before its claim");
      const grade = await gradeOf(deps.store, claimed);
      const route = await deps.routeOf(grade.route);
      // The loop's own signal (a stop, a lost claim, its bound) and the grade's bound, both: whichever ends first cuts it.
      const bound = deps.gradeBound ? deps.gradeBound() : AbortSignal.timeout(GRADE_TIMEOUT_MS);
      // Under a cap, the room for the call is what the cap leaves once the generality check's spend beside the grade's
      // records is counted.
      const capUsd = grade.capUsd === undefined ? undefined : Math.max(0, grade.capUsd - (request.beside ?? 0));
      return bookedAsk({ ...route, ...(capUsd !== undefined ? { beforeRequest: gradeCap(capUsd, route) } : {}) })(request, AbortSignal.any([signal, bound]), run);
    };
    // The generality pre-check on this host's Jev; none set up here, none asked. Under a cap, its requests' worst case
    // is judged against what the cap leaves (less `before`, an earlier attempt's cut check's) before any leaves.
    const general: LearningLoopDeps["general"] = async (notes, source, signal, run, sending, before) => {
      const jev = await deps.jev?.();
      if (!jev) return undefined;
      if (claimed === undefined) throw new Error("the learning run's generality check was asked before its claim");
      const { capUsd } = await gradeOf(deps.store, claimed);
      if (capUsd === undefined) return generalScores(jev, notes, source, signal, run, sending && (() => sending()));
      const held = await generalHeld(jev, notes, source);
      const room = Math.max(0, capUsd - (before ?? 0));
      if ("unpriced" in held) throw new GeneralOverCap(held.unpriced, true);
      if (held.usd > room) throw new GeneralOverCap(`its worst case of ${money(held.usd)} is over the ${money(room)} the cap leaves`, false);
      return generalScores(jev, notes, source, signal, run, sending && (() => sending(held.usd)));
    };
    const loop = learningLoopFactory({ store: deps.store, data: deps.data, ask, ...(deps.jev ? { general } : {}), ...(deps.generalThreshold !== undefined ? { generalThreshold: deps.generalThreshold } : {}), ...(deps.log ? { log: deps.log } : {}), ...(deps.now ? { now: deps.now } : {}) })(loopDeps);
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
