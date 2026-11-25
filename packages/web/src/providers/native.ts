// The run's own model provider's hosted search, injected (WebConfig.native): web_search only, on the caller's signal and
// its own bounds.
import { defineProvider, type ProviderRun } from "../provider.js";

export const native = defineProvider({ id: "native", label: "the model provider's own search", ops: ["search"] }, ({ native: search }): ProviderRun => ({
  search: async ({ query, n }, _deadline, signal) => (search ? search(query, n, signal) : { answer: { error: "web_search: no native search was given" } }),
}));
