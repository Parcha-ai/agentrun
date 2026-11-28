import { isPlanModel, PLAN_PROVIDER } from "@/lib/chatgpt";
import { withoutRoutePrefix } from "@/lib/routePrefix";
import type { RunUsage } from "@/lib/v2";

/** A model id as a person reads it: without the gateway's routing prefix, the full id kept for a title. `routePrefix` is
 *  exactly the one the server names (`models.route_prefix`, null with no gateway), never one read off an id, so a gateway
 *  id with no routing prefix (`anthropic/claude-x`) keeps its provider. Any other id (a provider's own, `openai/gpt-5`)
 *  is shown whole. A ChatGPT plan's model (`chatgpt/<id>`) says its id and who pays: "gpt-6.1-sol · on your ChatGPT
 *  plan", so a plan model and the same model on a key never read alike. A model on this machine's Ollama (`ollama/<tag>`)
 *  says its tag and where it runs: "qwen3:8b · local (Ollama)". The one wording for a plan or local model, in the Model
 *  picker, on an agent's page and on what a run's node ran on. */
export function modelLabel(id: string, routePrefix: string | null | undefined): { text: string; title?: string } {
  // A gateway sends a plan default under its prefix (agent-model/chatgpt/<id>), and serve runs it on the plan (chooseModel
  // asks the plan before the gateway). Any other id under the prefix, ollama/ too, goes to the gateway.
  const own = withoutRoutePrefix(id, routePrefix);
  if (isPlanModel(own)) return { text: `${own.slice(PLAN_PROVIDER.length + 1)} · on your ChatGPT plan`, title: id };
  if (isLocalModel(id)) return { text: `${id.slice(LOCAL_PROVIDER.length + 1)} · local (Ollama)`, title: id };
  return own !== id ? { text: own, title: id } : { text: id };
}

/** The provider of the models on this machine's Ollama, which the server lists itself (`ollama/<tag>`). */
const LOCAL_PROVIDER = "ollama";
/** Whether `id` names a model on this machine's Ollama: $0, with no limit on its requests. */
export const isLocalModel = (id: string): boolean => id.startsWith(`${LOCAL_PROVIDER}/`) && id.length > LOCAL_PROVIDER.length + 1;

/** The model a run ran on, as the server booked it (GET /v2/runs/{id}/usage, its `tokens` lines): the one most of its
 *  requests went to (a side call's or a subagent's model aside), its lines summed first (the server books one per
 *  attempt), as `provider/model` where the server routed it itself (`ollama/qwen3:8b`), else the id as booked (behind a
 *  gateway, which names no provider). Undefined before any request. */
export function runModel(usage: Pick<RunUsage, "lines"> | undefined): string | undefined {
  const requests = new Map<string, number>();
  for (const line of usage?.lines ?? []) {
    if (line.meter !== "tokens" || !line.model) continue;
    const id = line.provider ? `${line.provider}/${line.model}` : line.model;
    requests.set(id, (requests.get(id) ?? 0) + (line.requests ?? 0));
  }
  let top: string | undefined;
  for (const [id, count] of requests) if (count > (top === undefined ? 0 : requests.get(top)!)) top = id;
  return top;
}

/** A harness as capabilities offer it: its default model, and whether this server runs it (`available` false, with
 *  the server's `reason`, when it doesn't). `needs`, on one that runs nothing here for want of a key: what would give it a
 *  model (`key`, a model key; `chatgpt`, the ChatGPT sign-in). */
export type HarnessInfo = { id: string; default_model?: string | null; models?: readonly string[]; ready_models?: readonly string[]; free_models?: readonly FreeModel[]; available?: boolean; reason?: string; needs?: readonly string[] };
/** A model the server says runs at $0 (`harnesses[].free_models`: its catalog price is all zeros), with its context window
 *  in tokens. */
export type FreeModel = { id: string; context_window: number };

/** The free models among a harness's (`harnesses[].free_models`), by id; none from a server that lists none. */
export function harnessFree(harness: string, harnesses: readonly HarnessInfo[] | undefined): ReadonlyMap<string, FreeModel> {
  return new Map((harnesses?.find((h) => h.id === harness)?.free_models ?? []).map((m) => [m.id, m]));
}

/** Said beside the spend cap for a model the cap cannot stop: a free one (`harnesses[].free_models`), each request $0 in
 *  the catalog. The server ends such a run at its limit of these requests (capabilities' `limits.free_model_requests`),
 *  so the cap box says it: "free model: up to 60 requests". Null for a paid model, a ChatGPT plan's or a local Ollama
 *  model's (their requests don't count), no model, or a server that names no limit. */
export function freeRequestsNote(model: string | null | undefined, harness: string, harnesses: readonly HarnessInfo[] | undefined, limit: number | null | undefined): string | null {
  if (!model || typeof limit !== "number" || isPlanModel(model) || isLocalModel(model)) return null;
  return harnessFree(harness, harnesses).has(model) ? `free model: up to ${limit} requests` : null;
}

/** A context window as a person reads it: "1M", "262K", "8K" (binary or decimal thousands alike, rounded). */
export function contextSize(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000 * 10) / 10}M`.replace(/\.0M$/, "M");
  return `${Math.round(tokens / 1000)}K`;
}

/** The models the server offers for a harness (`harnesses[].models`), each in the exact form a definition names it on
 *  that harness here; none for a harness it does not run, or from a server that lists none. The Model picker's list: the
 *  one copy is the server's, never a second one here. */
export function harnessModels(harness: string, harnesses: readonly HarnessInfo[] | undefined): readonly string[] {
  return harnesses?.find((h) => h.id === harness)?.models ?? [];
}

/** The model a harness runs when a definition names none, as the server says (`harnesses[].default_model`, null for
 *  none). */
export function harnessDefault(harness: string, harnesses: readonly HarnessInfo[] | undefined): string | undefined {
  return harnesses?.find((h) => h.id === harness)?.default_model ?? undefined;
}
export const NO_DEFAULT = "No default for this harness yet: add a model key in Settings → Model keys, or choose a model here.";
/** The agent page's Model fact for an agent that names no model on a harness with no default here: the same fix. */
export const NO_MODEL_YET = "none yet: add a model key in Settings → Model keys";

/** The models of `models` a run takes now, their provider connected here (`harnesses[].ready_models`), or null from a
 *  server that does not say (one before it): then every offered model is listed, as before. */
export function harnessReady(harness: string, harnesses: readonly HarnessInfo[] | undefined): readonly string[] | null {
  return harnesses?.find((h) => h.id === harness)?.ready_models ?? null;
}

/** A model's provider as people name it, from its id's first part (`anthropic/claude-…` → Anthropic). One not here is its
 *  first part as it is. */
const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", google: "Google", gemini: "Google", mistral: "Mistral",
  ollama: "Ollama", particle: "Particle", xai: "xAI", deepseek: "DeepSeek", groq: "Groq", faux: "Test model",
};
export const providerLabel = (model: string): string => { const first = model.split("/")[0] ?? model; return PROVIDERS[first] ?? first; };
