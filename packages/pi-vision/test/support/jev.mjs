// A fake Jev port in the shape `@parcha/agentrun-jev`'s `createJevRunner` returns: a `judge` that keeps every request
// it is given and answers each question with its type's shape, priced like Jev ($0.042 a million input tokens) unless a
// test says it does not know the price. No network, no key.
import { appendFileSync } from "node:fs";
import { imageHeader } from "@parcha/pi-vision";

/** What each type answers unless a test says otherwise; a box always comes back, as Jev's does. */
export const ANSWERS = {
  choice: (q) => { const labels = Object.keys(q.criteria); return { type: "choice", choice: labels[0], confidence: 0.9, probabilities: Object.fromEntries(labels.map((l, i) => [l, i ? 0.1 / (labels.length - 1) : 0.9])) }; },
  noul: () => ({ type: "noul", noul: 0.8 }),
  score: (q) => ({ type: "score", score: 1, confidence: 0.7, legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 1 ? 0.7 : 0.3 / (q.criteria.length - 1)])) }),
  box: () => ({ type: "box", box: { top: 0.25, bottom: 0.75, left: 0.5, right: 1 }, confidence: 0.9 }),
};
export const USD_PER_MTOK = 0.042;

/** `answer(question, params)` overrides the defaults; `fail` makes every request throw it; `priced: false` answers with
 *  no price; `ledgerPath` gets one JSON line a request, before it is answered, so a parent counts a killed child's. */
export function fakeJev({ answer = (q) => ANSWERS[q.type](q), fail, ledgerPath, priced = true } = {}) {
  const requests = [];
  const judge = async (params) => {
    const sizes = (params.state.images ?? []).map(({ image }) => imageHeader(params.assets[image].bytes));
    requests.push({ params, sizes });
    if (ledgerPath) appendFileSync(ledgerPath, `${JSON.stringify({ n: requests.length, sources: (params.state.images ?? []).map((i) => i.source) })}\n`);
    if (params.signal?.aborted) throw params.signal.reason;
    if (fail) throw fail;
    const input = 1000 * Object.keys(params.assets ?? {}).length;
    const answers = Object.fromEntries(Object.entries(params.questions).map(([name, q]) => [name, answer(q, params)]));
    return { answers, model: params.model, usage: { input_tokens: input, output_tokens: 0 }, cost_usd: priced ? (input * USD_PER_MTOK) / 1e6 : null };
  };
  return { judge, requests };
}
