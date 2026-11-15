import { isPlanModel, PLAN_PROVIDER } from "@/lib/chatgpt";

/** A model id as a person reads it: without the gateway's routing prefix, the full id kept for a title. `routePrefix` is
 *  exactly the one the server names (`models.route_prefix`, null with no gateway), never one read off an id, so a gateway
 *  id with no routing prefix (`anthropic/claude-x`) keeps its provider. Any other id (a provider's own, `openai/gpt-5`)
 *  is shown whole. A ChatGPT plan's model (`chatgpt/<id>`) says its id and who pays: "gpt-6.1-sol · on your ChatGPT
 *  plan", so a plan model and the same model on a key never read alike. The one wording for a plan model, in the Model
 *  picker, on an agent's page and on what a run's node ran on. */
export function modelLabel(id: string, routePrefix: string | null | undefined): { text: string; title?: string } {
  if (isPlanModel(id)) return { text: `${id.slice(PLAN_PROVIDER.length + 1)} · on your ChatGPT plan`, title: id };
  return routePrefix && id.startsWith(`${routePrefix}/`) && id.length > routePrefix.length + 1 ? { text: id.slice(routePrefix.length + 1), title: id } : { text: id };
}

/** A harness as capabilities offer it: its default model, and whether this server runs it (`available` false, with
 *  the server's `reason`, when it doesn't). `needs`, on one that runs nothing here for want of a key: what would give it a
 *  model (`key`, a model key; `chatgpt`, the ChatGPT sign-in). */
export type HarnessInfo = { id: string; default_model?: string | null; models?: readonly string[]; free_models?: readonly FreeModel[]; available?: boolean; reason?: string; needs?: readonly string[] };
/** A model the server says runs at $0 (`harnesses[].free_models`: its catalog price is all zeros), with its context window
 *  in tokens. */
export type FreeModel = { id: string; context_window: number };

/** The free models among a harness's (`harnesses[].free_models`), by id; none from a server that lists none. */
export function harnessFree(harness: string, harnesses: readonly HarnessInfo[] | undefined): ReadonlyMap<string, FreeModel> {
  return new Map((harnesses?.find((h) => h.id === harness)?.free_models ?? []).map((m) => [m.id, m]));
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
