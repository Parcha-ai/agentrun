// A fake Jev in the shape of TypeSafe's SDK: a client whose `systemOne` keeps every request it is given and answers
// each question with its type's shape, and an `image` that keeps the bytes it is given. No network, no key.
import { appendFileSync } from "node:fs";
import { imageHeader } from "@parcha/pi-vision";

/** What each type answers unless a test says otherwise; a box always comes back, as Jev's does. */
export const ANSWERS = {
  choice: (q) => { const labels = Object.keys(q.criteria); return { type: "choice", choice: labels[0], confidence: 0.9, probabilities: Object.fromEntries(labels.map((l, i) => [l, i ? 0.1 / (labels.length - 1) : 0.9])) }; },
  noul: () => ({ type: "noul", noul: 0.8 }),
  score: (q) => ({ type: "score", score: 1, confidence: 0.7, legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 1 ? 0.7 : 0.3 / (q.criteria.length - 1)])) }),
  box: () => ({ type: "box", box: { top: 0.25, bottom: 0.75, left: 0.5, right: 1 }, confidence: 0.9 }),
};

/** `answer(question, request)` overrides the defaults; `fail` makes every request throw it; `ledgerPath` gets one JSON
 *  line a request, before it is answered, so a parent counts the requests of a child it killed. */
export function fakeJev({ answer = (q) => ANSWERS[q.type](q), fail, ledgerPath, inputTokens = 1000 } = {}) {
  const requests = [];
  const image = (bytes) => ({ fakeImage: true, bytes: Uint8Array.from(bytes) });
  const client = {
    async systemOne(request, options) {
      const sizes = request.state.images.map(({ image: { bytes } }) => imageHeader(bytes));
      requests.push({ request, options, sizes });
      if (ledgerPath) appendFileSync(ledgerPath, `${JSON.stringify({ n: requests.length, sources: request.state.images.map((i) => i.source) })}\n`);
      if (options?.signal?.aborted) throw options.signal.reason;
      if (fail) throw fail;
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, answer(q, request)]));
      return { model: "jev-1.14.0", answers, usage: { input_tokens: inputTokens * request.state.images.length, output_tokens: 0 } };
    },
  };
  return { client, image, requests };
}
