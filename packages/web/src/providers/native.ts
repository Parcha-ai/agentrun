// The run's own model provider's hosted search, injected (WebConfig.native): web_search only, on the caller's signal and
// its own bounds. It is asked a search's first query, and its answer carries the search's objective and queries.
import { defineProvider, type ProviderRun } from "../provider.js";

export const native = defineProvider({ id: "native", label: "the model provider's own search", ops: ["search"] }, ({ native: search }): ProviderRun => ({
  async search({ objective, queries, n }, _deadline, signal) {
    if (!search) return { answer: { error: "web_search: no native search was given" } };
    const searched = await search(queries[0] ?? objective, n, signal);
    return "error" in searched.answer ? searched : { ...searched, answer: { ...searched.answer, objective, queries } };
  },
}));
