/** `capabilities.models`: where the models come from (`gateway`, `providers`, `faux`) and each tier's model id. */
export type ModelsInfo = { source?: string; default?: string | null };

/** The routing prefix a gateway puts before every model id it serves (serve names them `<prefix>/<id>`): the provider
 *  part of the server's default, read from capabilities, never named here. None unless the models come from a gateway. */
export function gatewayPrefix(models: ModelsInfo | undefined): string | undefined {
  if (models?.source !== "gateway" || !models.default) return undefined;
  const slash = models.default.indexOf("/");
  return slash > 0 ? models.default.slice(0, slash) : undefined;
}

/** A model id as a person reads it: without the gateway's routing prefix, the full id kept for a title. Any other id
 *  (a provider's own, `openai/gpt-5`) is shown whole. */
export function modelLabel(id: string, models: ModelsInfo | undefined): { text: string; title?: string } {
  const prefix = gatewayPrefix(models);
  return prefix && id.startsWith(`${prefix}/`) && id.length > prefix.length + 1 ? { text: id.slice(prefix.length + 1), title: id } : { text: id };
}

/** A harness as capabilities list it: `default_model`, the model it runs when a definition names none (null for none). */
export type HarnessInfo = { id: string; default_model?: string | null };

/** The model a harness runs when a definition names none, as the server says (`harnesses[].default_model`). A server
 *  that does not say offers its default for pi alone, the harness it is defined for. */
export function harnessDefault(harness: string, harnesses: readonly HarnessInfo[] | undefined, defaultModel: string | undefined): string | undefined {
  const offer = harnesses?.find((h) => h.id === harness);
  if (offer && "default_model" in offer) return offer.default_model ?? undefined;
  return harness === "pi" ? defaultModel : undefined;
}
export const NO_DEFAULT = "No default for this harness: choose a model.";
