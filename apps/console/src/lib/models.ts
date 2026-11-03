/** `capabilities.models`: where the models come from (`gateway`, `providers`, `faux`), each tier's model id, and
 *  `route_prefix`, the routing prefix the server puts before a gateway's model ids (null with no gateway). */
export type ModelsInfo = { source?: string; default?: string | null; route_prefix?: string | null };

/** The routing prefix to take off a model id: exactly the one the server names (`models.route_prefix`), never one read
 *  off an id, so a gateway id with no routing prefix (`anthropic/claude-x`) keeps its provider. None when the server
 *  names none. */
export function gatewayPrefix(models: ModelsInfo | undefined): string | undefined {
  return models?.route_prefix || undefined;
}

/** A model id as a person reads it: without the gateway's routing prefix, the full id kept for a title. Any other id
 *  (a provider's own, `openai/gpt-5`) is shown whole. */
export function modelLabel(id: string, models: ModelsInfo | undefined): { text: string; title?: string } {
  const prefix = gatewayPrefix(models);
  return prefix && id.startsWith(`${prefix}/`) && id.length > prefix.length + 1 ? { text: id.slice(prefix.length + 1), title: id } : { text: id };
}

/** A harness as capabilities list it: `default_model`, the model it runs when a definition names none (null for none). */
/** A harness as capabilities offer it: its default model, and whether this server runs it (`available` false, with
 *  the server's `reason`, when it doesn't). */
export type HarnessInfo = { id: string; default_model?: string | null; available?: boolean; reason?: string };

/** The model a harness runs when a definition names none, as the server says (`harnesses[].default_model`). A server
 *  that does not say offers its default for pi alone, the harness it is defined for. */
export function harnessDefault(harness: string, harnesses: readonly HarnessInfo[] | undefined, defaultModel: string | undefined): string | undefined {
  const offer = harnesses?.find((h) => h.id === harness);
  if (offer && "default_model" in offer) return offer.default_model ?? undefined;
  return harness === "pi" ? defaultModel : undefined;
}
export const NO_DEFAULT = "No default for this harness: choose a model.";
