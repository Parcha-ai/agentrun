// Each wire's own settings, a leaf: it imports no model selection, so the harness table (harness-table.ts), whose built-in
// entries read it as their module loads, and provider.ts, which reads it for every request's route, take it from here in
// any import order. provider.ts imports model.ts, which imports the harness table: were these settings provider.ts's own,
// a process that imported provider.ts first would build the table before they existed.
import type { HarnessWire, Wire } from "@parcha/agentrun-kernel";

/** Each wire's own settings: the vendor whose models it runs (a MODEL_KEYS row's id, model.ts), the endpoint a host may
 *  name for it, the vendor's key, and whether it is serve's gateway (AGENT_MODEL_BASE_URL), which pi's models take too and
 *  which runs any id (the gateway's own string, naming no vendor here). */
export const WIRES: Readonly<Record<Wire, { vendor: string; label: string; base: string; key: string; gateway: boolean }>> = Object.freeze({
  "anthropic-messages": { vendor: "anthropic", label: "Anthropic", base: "ANTHROPIC_BASE_URL", key: "ANTHROPIC_API_KEY", gateway: false },
  "openai-responses": { vendor: "openai", label: "OpenAI", base: "AGENT_MODEL_BASE_URL", key: "OPENAI_API_KEY", gateway: true },
});

/** Whether a harness's wire is a model wire of ours (WIRES): not "plan", a harness billed to its own vendor's plan
 *  (Cursor's), whose requests never reach a route of ours, so it has no vendor, endpoint, key or gateway here. */
export const modelWire = (wire: HarnessWire): wire is Wire => wire !== "plan";

/** A harness's wire's settings, or undefined for one billed to its own plan (modelWire). */
export const wireOf = (wire: HarnessWire): (typeof WIRES)[Wire] | undefined => (modelWire(wire) ? WIRES[wire] : undefined);

/** The providers whose models the runner's model route translates onto a wire, each with the wires it translates them
 *  onto (runner/model-route.ts TRANSLATORS: messagesFetch, and responsesFetch over it): an Ollama model of this machine
 *  (ollama-provider.ts) onto Anthropic's Messages and OpenAI's Responses. Every harness on such a wire is offered those
 *  models and runs them through the route, at their price, whatever harness it is: the wire decides, never a harness's
 *  id. A leaf's data: provider ids by name. */
export const TRANSLATED: Readonly<Record<string, readonly Wire[]>> = Object.freeze({ ollama: Object.freeze(["anthropic-messages", "openai-responses"] as const) });

/** Whether `model`'s requests on a harness of `wire` go through the route's translation (TRANSLATED). */
export const routed = (wire: HarnessWire, model: { readonly provider: string }): boolean =>
  Object.hasOwn(TRANSLATED, model.provider) && (TRANSLATED[model.provider] as readonly HarnessWire[]).includes(wire);

/** routed, for a model named `provider/model-id`. */
export const routedId = (wire: HarnessWire, id: string): boolean => id.indexOf("/") > 0 && routed(wire, { provider: id.slice(0, id.indexOf("/")) });

/** Whether the route translates any provider's models onto `wire` (TRANSLATED): a harness on it may run on one with no key. */
export const translatesOnto = (wire: HarnessWire): boolean => Object.values(TRANSLATED).some((wires) => (wires as readonly HarnessWire[]).includes(wire));
