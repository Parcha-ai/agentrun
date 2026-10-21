// The judge seam: what every demo's typed questions pass through. It prices them at Jev's list price, so a demo that asks questions is priced the same way,
// whoever answers them (a script, or Jev).
//
// No cap: the harness sends every question. `--max-usd` is the run's one dollar stop, and TypeSafe rate-limits: the Jev runner waits out a 429 (its
// Retry-After) and gives up after its retries with HTTP 429, which pi-vision files as a look that cost nothing.
//
// Price: the list price of the Jev judge model, `jev-1.12`: $0.042 per million input tokens and nothing for output. Source: the TypeSafe cookbook, 2026-07.
import type { RunJudge } from './host.ts';

/** Jev's list price per million tokens: public, from the TypeSafe cookbook, 2026-07, model `jev-1.12`. */
export const JEV_LIST_PRICE = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0, source: 'TypeSafe cookbook, 2026-07, jev-1.12' } as const;

/** The dollars a judge request cost at Jev's list price. */
export const jevCost = (usage: { input_tokens: number; output_tokens: number }) => (usage.input_tokens * JEV_LIST_PRICE.inputUsdPerMillionTokens + usage.output_tokens * JEV_LIST_PRICE.outputUsdPerMillionTokens) / 1_000_000;

/** `runJudge` priced at the list price when its answer reports usage but no price of its own. */
export function priceJudge(runJudge: RunJudge): RunJudge {
  return async (request) => {
    const answer = await runJudge(request);
    const usage = answer.usage ?? { input_tokens: 0, output_tokens: 0 };
    return typeof answer.cost_usd === 'number' ? answer : { ...answer, cost_usd: jevCost(usage) };
  };
}
