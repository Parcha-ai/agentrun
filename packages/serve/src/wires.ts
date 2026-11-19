// Each wire's own settings, a leaf: it imports no model selection, so the harness table (harness-table.ts), whose built-in
// entries read it as their module loads, and provider.ts, which reads it for every request's route, take it from here in
// any import order. provider.ts imports model.ts, which imports the harness table: were these settings provider.ts's own,
// a process that imported provider.ts first would build the table before they existed.
import type { HarnessWire } from "@parcha/agentrun-kernel";

/** Each wire's own settings: the vendor whose models it runs (a MODEL_KEYS row's id, model.ts), the endpoint a host may
 *  name for it, the vendor's key, and whether it is serve's gateway (AGENT_MODEL_BASE_URL), which pi's models take too and
 *  which runs any id (the gateway's own string, naming no vendor here). */
export const WIRES: Readonly<Record<HarnessWire, { vendor: string; label: string; base: string; key: string; gateway: boolean }>> = Object.freeze({
  "anthropic-messages": { vendor: "anthropic", label: "Anthropic", base: "ANTHROPIC_BASE_URL", key: "ANTHROPIC_API_KEY", gateway: false },
  "openai-responses": { vendor: "openai", label: "OpenAI", base: "AGENT_MODEL_BASE_URL", key: "OPENAI_API_KEY", gateway: true },
  // A harness billed to its own vendor's plan (Cursor's): its requests never reach a route of ours, so it names no vendor
  // of ours, no endpoint and no model key, and no proxy is made for it (provider.ts providerFor refuses it).
  plan: { vendor: "", label: "its own plan", base: "", key: "", gateway: false },
});
