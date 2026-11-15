// The faux harness's script for the cap's field cases (cap-field-cases.test.mjs): two runs that met a cap in the field,
// reshaped as requests of the faux harness, every other line the faux harness's own (faux-harness.mjs).
import { script as base } from "./faux-harness.mjs";

export { closeDelayMs, closed, closeError, openDelayMs, opened } from "./faux-harness.mjs";

/** The monid endpoint the lead-list run searches with: apollo's people match, $0.026 a call (faux-monid.mjs), the price
 *  of the field run's company and people searches. */
export const PEOPLE = "monid__apollo__people__match";

/** Request `k` of the lead-list run as it ran on Codex in the field, at GPT-6.1 Sol's prices ($2 in, $10 out, $0.10 a
 *  cache read and $2.50 a cache write, a million tokens, as faux-sonnet55.mjs prices): a 16,000-token prompt that grows
 *  2,300 tokens a request, each request reading the one before it from the cache, asking the model's 128,000 output
 *  tokens and needing 3,072 at least, and writing 390. Its input bound is the body's bytes, 4 a token, as on a route with
 *  no count of its own; `counted`: the provider's own count, as on a route straight to OpenAI. Nine requests cost $0.14,
 *  and with two searches at $0.026 the run stands at $0.19, as the field run did. */
export function leadListStep(k, { counted = false } = {}) {
  const prompt = (n) => 16_000 + 2_300 * n;
  const cacheRead = k === 0 ? 0 : prompt(k - 1);
  const tokens = { input: 6, output: 390, cacheRead, cacheWrite: prompt(k) - cacheRead - 6 };
  const usd = (tokens.input * 2 + tokens.output * 10 + tokens.cacheRead * 0.1 + tokens.cacheWrite * 2.5) / 1e6;
  return { inputTokensMax: counted ? prompt(k) : prompt(k) * 4, outputTokensAsked: 128_000, outputTokensLeast: 3_072, tokens, usd };
}

/** A kyb step as the field run held it: one request whose input is 34,000 tokens (its bound the body's bytes, 4 a
 *  token), none of it cached, asking 128,000 output tokens and needing 1,024 at least. At the prices above its whole ask
 *  is $1.62 (136,000 bytes at $2.50 a million, $0.34, and $1.28 of output): the hold the field run met under its $1.50
 *  cap. Its least is $0.35 (the input uncached and 1,024 tokens). It writes 2,000 tokens. */
export function kybStep() {
  const tokens = { input: 34_000, output: 2_000, cacheRead: 0, cacheWrite: 0 };
  const usd = (tokens.input * 2 + tokens.output * 10) / 1e6;
  return { inputTokensMax: 34_000 * 4, outputTokensAsked: 128_000, outputTokensLeast: 1_024, tokens, usd };
}

export function script(spec, session = {}) {
  const text = spec.system.join("\n");
  // "Build a lead list on Codex: <n> requests, the people search at request <k> while it streams[, its input counted].":
  // requests 0 and 1 each search ($0.026 a call) as their answer, the rest read, and request k searches for people with
  // the request still open (Codex starts a call before its response ends, so its cost is booked after the call), then
  // the answer.
  const leadList = /Build a lead list on Codex: (\d+) requests, the people search at request (\d+) while it streams(, its input counted)?\./.exec(text);
  if (leadList) {
    const [n, at, counted] = [Number(leadList[1]), Number(leadList[2]), leadList[3] !== undefined];
    const step = (k) => {
      const figures = leadListStep(k, { counted });
      if (k === at) return { calls: [{ call: PEOPLE, args: { body: { name: "Head of Sales" } } }], bookAfter: true, ...figures };
      if (k < 2) return { call: PEOPLE, args: { body: { name: `company ${k}` } }, ...figures };
      return { call: "read", args: { path: "a.txt" }, ...figures };
    };
    return [...Array.from({ length: n }, (_, k) => step(k)), { say: "Lead list built.", ...leadListStep(n, { counted }) }];
  }
  // "Run a kyb step.": one kyb step (kybStep) that answers.
  if (/Run a kyb step\./.test(text)) return [{ say: "Kyb step done.", ...kybStep() }];
  return base(spec, session);
}
