/** A model id as a person reads it: without the gateway's routing prefix, the full id kept for a title. `routePrefix` is
 *  exactly the one the server names (`models.route_prefix`, null with no gateway), never one read off an id, so a gateway
 *  id with no routing prefix (`anthropic/claude-x`) keeps its provider. Any other id (a provider's own, `openai/gpt-5`)
 *  is shown whole. */
export function modelLabel(id: string, routePrefix: string | null | undefined): { text: string; title?: string } {
  return routePrefix && id.startsWith(`${routePrefix}/`) && id.length > routePrefix.length + 1 ? { text: id.slice(routePrefix.length + 1), title: id } : { text: id };
}

/** A harness as capabilities list it: `default_model`, the model it runs when a definition names none (null for none). */
export type HarnessInfo = { id: string; default_model?: string | null };

/** The model a harness runs when a definition names none, as the server says (`harnesses[].default_model`). */
export function harnessDefault(harness: string, harnesses: readonly HarnessInfo[] | undefined): string | undefined {
  return harnesses?.find((h) => h.id === harness)?.default_model ?? undefined;
}
export const NO_DEFAULT = "No default for this harness: choose a model.";
