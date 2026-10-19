// The judge seam: what every demo's typed questions pass through. It carries the harness's caps on a run's Jev use and Jev's list price, so a demo that asks questions is
// held to the same caps and priced the same way, whoever answers them (a script, or Jev).
//
// Caps: the harness's own guard, not a TypeSafe quota. By default at most 50 requests and 40,000 tokens (in and out) over the run; a demo sets its own in demo.json (demo-spec.ts). The next request after a cap is reached is refused with `JEV_CAP_REACHED` and is never sent. A request
// that fails counts; a refused one does not. The count is kept in a file under the run's directory, so a resumed process continues the count and a kill does not reset it.
//
// Price: the list price of the Jev judge model, `jev-1.12`: $0.042 per million input tokens and nothing for output. Source: the TypeSafe cookbook, 2026-07.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunJudge } from './host.ts';

export const JEV_CAPS = { requests: 50, tokens: 40_000 } as const;
/** Jev's list price per million tokens: public, from the TypeSafe cookbook, 2026-07, model `jev-1.12`. */
export const JEV_LIST_PRICE = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0, source: 'TypeSafe cookbook, 2026-07, jev-1.12' } as const;

/** The dollars a judge request cost at Jev's list price. */
export const jevCost = (usage: { input_tokens: number; output_tokens: number }) => (usage.input_tokens * JEV_LIST_PRICE.inputUsdPerMillionTokens + usage.output_tokens * JEV_LIST_PRICE.outputUsdPerMillionTokens) / 1_000_000;

type Spent = { requests: number; tokens: number };
const read = (file: string): Spent => {
  const total: Spent = { requests: 0, tokens: 0 };
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return total; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const row = JSON.parse(line) as Partial<Spent>; total.requests += row.requests ?? 0; total.tokens += row.tokens ?? 0; } catch { /* a torn last line */ }
  }
  return total;
};

/** `runJudge` held to the caps and priced at the list price when its answer reports usage but no price of its own. `file` keeps the run's count. A request is counted BEFORE it is
 *  sent (checked and saved in one synchronous step, so concurrent questions cannot all pass the check, and a kill after the answer does not lose the count); its tokens are added
 *  when the answer arrives. */
export function capJudge(runJudge: RunJudge, file: string, caps: { requests: number; tokens: number } = JEV_CAPS): RunJudge {
  return async (request) => {
    // The count's directory is made at the first question, not when the host is built: a process on a disk not yet mounted writes nothing under the run's directory before its claim is open.
    mkdirSync(dirname(file), { recursive: true });
    const spent = read(file);
    if (spent.requests >= caps.requests || spent.tokens >= caps.tokens) {
      // Never sent, so it cost nothing: the request diagnostic says so to a caller that reads it (pi-vision files a refused request at $0, not as a price unknown).
      throw Object.assign(new Error(`The judge's cap is reached (${spent.requests} of ${caps.requests} requests, ${spent.tokens} of ${caps.tokens} tokens): this request was not sent.`), { code: 'JEV_CAP_REACHED', retryable: false, requestDiagnostic: { reason: 'cap_reached' } });
    }
    appendFileSync(file, `${JSON.stringify({ requests: 1, tokens: 0 })}\n`);
    const answer = await runJudge(request);
    const usage = answer.usage ?? { input_tokens: 0, output_tokens: 0 };
    appendFileSync(file, `${JSON.stringify({ requests: 0, tokens: usage.input_tokens + usage.output_tokens })}\n`);
    return typeof answer.cost_usd === 'number' ? answer : { ...answer, cost_usd: jevCost(usage) };
  };
}
