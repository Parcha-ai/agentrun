// The models a person is offered to pick for each harness, in the exact form that harness takes, and the words a refusal
// uses when a model is named in a form it does not take. One list, served in capabilities (`harnesses[].models`) and read
// by the console's Model picker, so the picker, the save's refusal and a run's refusal never name different forms.
// A leaf of model.ts and provider.ts (it reads their tables only when called, never as it loads).
import { ADAPTER_FACTS } from "./adapter-facts.js";
import { FAUX_ENV, MODEL_KEYS } from "./model.js";
import { openRouterName } from "./provider.js";
import { WIRES } from "./wires.js";
import { PLAN_PROVIDER, planOf, signedIn } from "./chatgpt-plan.js";
import { PLAN_HARNESSES } from "./harness.js";

/** The current models a person may pick, by vendor, in the vendor's own ids (Anthropic's dashes; OpenRouter's dotted name
 *  for the same model is derived, provider.ts openRouterName). The everyday model first: it is the example a refusal gives.
 *  A candidate a harness cannot run on this server (one pi-ai's catalog does not list) is dropped before it is served
 *  (harness.ts harnessOffers). */
export const PICKABLE: readonly { vendor: string; ids: readonly string[] }[] = Object.freeze([
  { vendor: "anthropic", ids: Object.freeze(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2"]) },
  { vendor: "openai", ids: Object.freeze(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]) },
  { vendor: "particle", ids: Object.freeze(["particle-1"]) },
]);

/** The vendors whose models `harness` runs: pi any; an adapter harness, its wire's vendor. */
const vendorsOf = (harness: string): readonly string[] => {
  const facts = ADAPTER_FACTS.find((f) => f.id === harness);
  return facts ? [WIRES[facts.wire].vendor] : PICKABLE.map((p) => p.vendor);
};

/** `vendor`'s model `id` in the form this server runs it: `vendor/id` on the vendor's own key, or through OpenRouter
 *  (`openrouter/vendor/id`, Anthropic's id in OpenRouter's dotted name) when OpenRouter's key is the only one here. */
export function formOf(env: NodeJS.ProcessEnv, vendor: string, id: string): string {
  const row = MODEL_KEYS.find((r) => r.id === vendor);
  if (row && !env[row.field] && env.OPENROUTER_API_KEY) return `openrouter/${vendor === "particle" ? "particle-ai" : vendor}/${vendor === "anthropic" ? openRouterName(id) : id}`;
  return `${vendor}/${id}`;
}

/** The models offered for `harness` on this server, each in the form it takes, before the harness's own catalog is asked
 *  (harness.ts harnessOffers drops those it does not run). Behind serve's gateway every id is the gateway's own string, so
 *  the host's tier models stand for what it runs; with the faux model none is offered. */
export function pickerCandidates(env: NodeJS.ProcessEnv, harness: string): string[] {
  if (env[FAUX_ENV]) return [];
  // The gateway serves the harnesses whose wire goes through it (pi, and the OpenAI Responses wire: providerFor); the
  // Anthropic Messages wire never does, so Claude is offered Anthropic's models on its own key.
  const facts = ADAPTER_FACTS.find((f) => f.id === harness);
  if (env.AGENT_MODEL_BASE_URL && facts?.wire !== "anthropic-messages") return [...new Set([env.AGENT_MODEL, env.AGENT_MODEL_FAST, env.AGENT_MODEL_STRONG].filter((id): id is string => Boolean(id)))];
  const vendors = vendorsOf(harness);
  // Signed in to a ChatGPT plan, its models first for a harness that runs on it (`chatgpt/<model-id>`).
  const plan = PLAN_HARNESSES.includes(harness) && signedIn(env) ? (planOf(env)?.models ?? []).map((id) => `${PLAN_PROVIDER}/${id}`) : [];
  return [...plan, ...PICKABLE.filter((p) => vendors.includes(p.vendor)).flatMap((p) => p.ids.map((id) => formOf(env, p.vendor, id)))];
}

/** A model a person may pick that runs at $0 (local-models.ts isFree, the kernel's freeModel on its catalog price: all
 *  zeros, every tier's too), in the form it takes, with its context window in tokens. */
export type FreeModel = { id: string; context_window: number };

/** The free models offered for `harness` on this server, besides pickerCandidates' (harness.ts harnessOffers drops those
 *  it does not run): OpenRouter's chat models whose catalog price is all zeros (pi-ai's own and serve's ADDED_MODELS), on
 *  pi with OpenRouter's key, by id. None for an adapter harness (each runs its own wire's vendor), behind a gateway (its
 *  ids are its own) or with the faux model. */
export async function freeCandidates(env: NodeJS.ProcessEnv, harness: string): Promise<FreeModel[]> {
  if (env[FAUX_ENV] || env.AGENT_MODEL_BASE_URL || !env.OPENROUTER_API_KEY || ADAPTER_FACTS.some((f) => f.id === harness)) return [];
  const [{ builtinModels }, { withLocalModels, isFree }] = await Promise.all([import("@earendil-works/pi-ai/providers/all"), import("./local-models.js")]);
  return withLocalModels(builtinModels()).getModels("openrouter").filter(isFree)
    .map((model) => ({ id: `openrouter/${model.id}`, context_window: model.contextWindow }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A model id with its spelling taken out (case, spaces, dots, dashes), and the provider's segments off. */
const spelled = (given: string): string => (given.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The model `given` most likely means, in the form this harness takes, or undefined when none is obvious: the same id
 *  with a dot for a dash or the other way, a missing provider, or a name without its `claude-` ("Sonnet 5.5"). */
export function likelyModel(env: NodeJS.ProcessEnv, harness: string, given: string): string | undefined {
  const wanted = spelled(given);
  if (!wanted) return undefined;
  const vendors = vendorsOf(harness);
  for (const { vendor, ids } of PICKABLE) {
    if (!vendors.includes(vendor)) continue;
    const id = ids.find((each) => spelled(each) === wanted || spelled(each).endsWith(`-${wanted}`));
    if (id) return formOf(env, vendor, id);
  }
  return undefined;
}

/** What a refusal says of a model named in a form `harness` does not take: the form it takes, with examples this server
 *  can run, and the likely id when one is obvious. `host`: the name is the server's own default, not the revision's. No
 *  word of the catalog behind it: a person's words. */
export function modelFormWhy(env: NodeJS.ProcessEnv, harness: string, named: string, host: boolean): string {
  const likely = likelyModel(env, harness, named);
  const subject = host ? `The server's default model ${named} is not one` : `${named} is not a model`;
  return `${modelShape(env, harness)}: ${subject} ${harness} runs here.${likely && likely !== named ? ` Did you mean ${likely}?` : ""}`;
}

/** "On pi, a model is <provider>/<model id>, like A or B": the forms this server can run, each of the harness's first
 *  vendor's everyday model, the vendor's own and OpenRouter's. Only the forms a key here runs; with neither key both, since
 *  either key makes one run. */
export function modelShape(env: NodeJS.ProcessEnv, harness: string): string {
  const first = PICKABLE.find((p) => vendorsOf(harness).includes(p.vendor))!;
  const id = first.ids[0]!;
  const own = Boolean(env[MODEL_KEYS.find((r) => r.id === first.vendor)!.field]);
  const router = Boolean(env.OPENROUTER_API_KEY);
  const shown = [...(own || !router ? [`${first.vendor}/${id}`] : []), ...(router || !own ? [`openrouter/${first.vendor}/${first.vendor === "anthropic" ? openRouterName(id) : id}`] : [])];
  return `On ${harness}, a model is <provider>/<model id>, like ${shown.join(" or ")}`;
}
