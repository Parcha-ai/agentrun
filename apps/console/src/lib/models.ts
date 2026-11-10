/** A model id as a person reads it: without the gateway's routing prefix, the full id kept for a title. `routePrefix` is
 *  exactly the one the server names (`models.route_prefix`, null with no gateway), never one read off an id, so a gateway
 *  id with no routing prefix (`anthropic/claude-x`) keeps its provider. Any other id (a provider's own, `openai/gpt-5`)
 *  is shown whole. */
export function modelLabel(id: string, routePrefix: string | null | undefined): { text: string; title?: string } {
  return routePrefix && id.startsWith(`${routePrefix}/`) && id.length > routePrefix.length + 1 ? { text: id.slice(routePrefix.length + 1), title: id } : { text: id };
}

/** A harness as capabilities offer it: its default model, and whether this server runs it (`available` false, with
 *  the server's `reason`, when it doesn't). */
export type HarnessInfo = { id: string; default_model?: string | null; available?: boolean; reason?: string };

/** The model a harness runs when a definition names none, as the server says (`harnesses[].default_model`, null for
 *  none). */
export function harnessDefault(harness: string, harnesses: readonly HarnessInfo[] | undefined): string | undefined {
  return harnesses?.find((h) => h.id === harness)?.default_model ?? undefined;
}
export const NO_DEFAULT = "No default for this harness yet: add a model key in Settings → Model keys, or choose a model here.";
/** The agent page's Model fact for an agent that names no model on a harness with no default here: the same fix. */
export const NO_MODEL_YET = "none yet: add a model key in Settings → Model keys";
