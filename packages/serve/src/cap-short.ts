// A cap saved below what an agent's model needs for one more step and an answer: its every run wraps up at its first tool
// call (wrap-up.ts). The save says so, as a warning, and never refuses it (a cap is the person's call). The figure is the
// wrap-up's own (stepAndAnswerFor over the cap's requestFigures), priced before any run on the first request the agent's
// harness would send: its own base input (AdapterFacts.baseInputTokens, measured on its pinned build; pi's beside its
// adapter), the agent's prompt counted with o200k_base where its model's tokenizer is that (no count otherwise: 0, a
// floor), and the least output its harness's policy reads at the agent's effort.

import { o200kModel, o200kTokens, type ProviderPolicy } from "@parcha/agentrun-kernel/host";
import { type CapModel, requestFigures } from "@parcha/agentrun-kernel/kernel/cap";
import { DEFAULT_HARNESS } from "./harness.js";
import { harnessOf } from "./harness-table.js";
import { thinkingLevel } from "./model.js";
import { capBelowWarning, stepAndAnswerFor } from "./wrap-up.js";

/** What the warning reads of an agent's definition: its model, its thinking level, its instructions. */
export type CapShortRevision = { readonly model?: string; readonly thinking?: string; readonly instructions: string };

/** The model, policy, effort and base input of the first request `harness` would send for `revision` here; undefined when
 *  it cannot be said (the harness or its model does not run here: the save's other warnings say why). */
async function firstRequestOf(env: NodeJS.ProcessEnv, harness: string, revision: CapShortRevision): Promise<{ capModel: CapModel; policy: ProviderPolicy; effort: string | undefined; baseTokens: number } | undefined> {
  // The run's effort as a run without one of its own takes it (runs-over-store.ts prepareLaunch): its revision's thinking,
  // else the host's AGENT_THINKING; none, none (its harness's own default, of which nothing is known here).
  const level = thinkingLevel(revision.thinking) ?? thinkingLevel(env.AGENT_THINKING);
  const entry = harnessOf(env, harness);
  if (entry?.facts) {
    const facts = entry.facts;
    const { cliCapModel } = await import("./runner/cli-run-spec.js");
    const { thinkingFor } = await import("./adapters.js");
    const capModel = await cliCapModel({ ...entry, facts }, env, revision.model);
    return { capModel, policy: facts.policy({ model: capModel.id, tools: [] }), effort: level ? thinkingFor(facts, level) : undefined, baseTokens: facts.baseInputTokens ?? 0 };
  }
  // A harness with no facts of its own is pi, which runs in the run's process on its route; another (a test's stand-in
  // with none) has no first request to price.
  if (harness !== DEFAULT_HARNESS) return undefined;
  const { routeOf } = await import("./runner/model-route.js");
  const { capModelOf, PI_WIRES } = await import("./runner/adapter-run-spec.js");
  const { PI_BASE_INPUT_TOKENS, policyFor } = await import("./runner/adapters/pi.js");
  const route = await routeOf(revision.model, env, "default", PI_WIRES);
  return { capModel: capModelOf(route), policy: await policyFor(route.provider, route.model, []), effort: level, baseTokens: PI_BASE_INPUT_TOKENS };
}

/** The body the first request names its effort in, on `wire`, as its policy reads it: Responses' `reasoning.effort`,
 *  Messages' `output_config.effort`. */
const effortBody = (wire: string, effort: string | undefined): Record<string, unknown> =>
  effort === undefined ? {} : wire === "openai-responses" ? { reasoning: { effort } } : { output_config: { effort } };

/**
 * The warning an agent saved with a cap of `capUsd` on `harness` reads when that cap is below what its model needs for one
 * more step and an answer (wrap-up.ts capBelowWarning), else undefined. Never throws: a model or route that cannot be
 * priced here says nothing (the save's other checks name it).
 */
export async function capShortOf(env: NodeJS.ProcessEnv, harness: string, revision: CapShortRevision, capUsd: number): Promise<string | undefined> {
  try {
    const first = await firstRequestOf(env, harness, revision);
    if (!first || first.capModel.plan || first.capModel.price === null) return undefined;
    const { capModel, policy } = first;
    const body = { model: capModel.id, ...effortBody(capModel.api, first.effort) };
    const least = policy.outputLeast?.(body);
    const effort = policy.effortOf?.(body);
    const prompt = o200kModel(capModel.id) ? await o200kTokens(revision.instructions) : 0;
    const figures = requestFigures({ kind: "model", id: "save", model: capModel, inputTokens: first.baseTokens + prompt, ...(typeof least === "number" ? { outputTokensLeast: least } : {}) });
    return capBelowWarning(capUsd, capModel.id, effort, stepAndAnswerFor(figures, (step0Usd) => step0Usd));
  } catch {
    return undefined;
  }
}
