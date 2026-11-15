// The faux harness's script for the cap's field cases (cap-field-cases.test.mjs): two runs that met a cap in the field,
// reshaped as requests of the faux harness, every other line the faux harness's own (faux-harness.mjs).
//
// A request on a route with no count of the provider's own (a gateway) is bounded as the real Codex proxy bounds it: each
// request's body, Codex-shaped, is sent through the kernel's model proxy under Codex's policy on a gateway origin, and its
// input bound is what that proxy asked the cap to hold (`GATEWAY_BOUNDS`). The bodies are never sent on: the hold throws.
import { codexPolicy } from "@parcha/agentrun-harness-codex";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { script as base } from "./faux-harness.mjs";

export { closeDelayMs, closed, closeError, openDelayMs, opened } from "./faux-harness.mjs";

/** The monid endpoint the lead-list run searches with: apollo's people match, $0.026 a call (faux-monid.mjs), the price
 *  of the field run's company and people searches. */
export const PEOPLE = "monid__apollo__people__match";

/** The model the field runs asked for, as the bodies name it. */
const MODEL = "gpt-6.1-sol";
/** Ten words of o200k_base that are one token each, four bytes with their space: text of `n` of them is `n` tokens and
 *  4n bytes, an English prompt's ratio, as the field run's bodies were (128,400 bytes for 32,100 tokens). */
const WORDS = [" the", " and", " for", " was", " are", " you", " not", " but", " can", " all"];
const words = (n) => Array.from({ length: n }, (_, i) => WORDS[(i * 7) % WORDS.length]).join("");

/** A Codex request whose prompt is `tokens` tokens: a developer message, the user's text, and the read tool. */
const codexBody = (tokens) => ({
  model: MODEL,
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Answer from the files you read." }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: words(tokens) }] },
  ],
  tools: [{ type: "function", name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  stream: true,
  store: false,
  max_output_tokens: 128_000,
});

/** The input bound of each body as Codex's proxy measures it on a gateway (a base that is not OpenAI's, so OpenAI never
 *  counts it): what it asked the cap to hold, each request refused there and never sent. */
async function gatewayBounds(bodies) {
  const key = "field-cases-session-key";
  const held = [];
  const proxy = await startModelProxy({
    policy: codexPolicy({ model: MODEL, tools: ["read"] }),
    model: MODEL,
    origin: "https://gateway.example/openai",
    credential: () => "gateway-key",
    hooks: { beforeRequest: async (request) => { held.push(request.inputTokensMax); throw new Error("measured, never sent"); }, afterRequest: async () => {} },
    fetch: async () => { throw new Error("never sent"); },
  }, key);
  try {
    for (const body of bodies) {
      const answer = await fetch(new URL("/v1/responses", proxy.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, accept: "text/event-stream" }, body: JSON.stringify(body) });
      await answer.text();
    }
  } finally {
    await proxy.close();
  }
  if (held.length !== bodies.length || !held.every(Number.isSafeInteger)) throw new Error(`the proxy held ${JSON.stringify(held)}`);
  return held;
}

/** Request `k`'s prompt in the lead-list run: 16,000 tokens, growing 2,300 a request. */
const prompt = (n) => 16_000 + 2_300 * n;
/** The kyb step's prompt: 34,000 tokens. */
const KYB_TOKENS = 34_000;
const LEAD_BODIES = Array.from({ length: 10 }, (_, k) => codexBody(prompt(k)));
const KYB_BODY = codexBody(KYB_TOKENS);
const measured = await gatewayBounds([...LEAD_BODIES, KYB_BODY]);

/** Each request's input bound through a gateway, as the proxy measured it, beside its body's bytes (the byte bound):
 *  `lead[k]` for request k of the lead list, and the kyb step's. */
export const GATEWAY_BOUNDS = Object.freeze({
  lead: Object.freeze(measured.slice(0, LEAD_BODIES.length)),
  kyb: measured[LEAD_BODIES.length],
  leadBytes: Object.freeze(LEAD_BODIES.map((body) => Buffer.byteLength(JSON.stringify(body), "utf8"))),
  kybBytes: Buffer.byteLength(JSON.stringify(KYB_BODY), "utf8"),
});

/** Request `k` of the lead-list run as it ran on Codex in the field, at GPT-6.1 Sol's prices ($2 in, $10 out, $0.10 a
 *  cache read and $2.50 a cache write, a million tokens, as faux-sonnet55.mjs prices): a 16,000-token prompt that grows
 *  2,300 tokens a request, each request reading the one before it from the cache, asking the model's 128,000 output
 *  tokens and needing 3,072 at least, and writing 390. Its input bound is the proxy's on a gateway (`GATEWAY_BOUNDS`);
 *  `counted`: the provider's own count, as on a route straight to OpenAI. Nine requests cost $0.14, and with two searches
 *  at $0.026 the run stands at $0.19, as the field run did. */
export function leadListStep(k, { counted = false } = {}) {
  const cacheRead = k === 0 ? 0 : prompt(k - 1);
  const tokens = { input: 6, output: 390, cacheRead, cacheWrite: prompt(k) - cacheRead - 6 };
  const usd = (tokens.input * 2 + tokens.output * 10 + tokens.cacheRead * 0.1 + tokens.cacheWrite * 2.5) / 1e6;
  return { inputTokensMax: counted ? prompt(k) : GATEWAY_BOUNDS.lead[k], outputTokensAsked: 128_000, outputTokensLeast: 3_072, tokens, usd };
}

/** A kyb step as the field run held it: one request whose input is 34,000 tokens, none of it cached, asking 128,000
 *  output tokens and needing 1,024 at least. Its bound is the body's bytes, 4 a token, as on a route with neither a count
 *  of the provider's nor a local one (a model whose tokenizer the kernel does not have). At the prices above its whole
 *  ask is $1.62 (136,000 bytes at $2.50 a million, $0.34, and $1.28 of output): the hold the field run met under its
 *  $1.50 cap. Its least is $0.35 (the input uncached and 1,024 tokens). It writes 2,000 tokens. `gateway`: the same step
 *  on Codex through a gateway, its bound the proxy's (`GATEWAY_BOUNDS.kyb`). */
export function kybStep({ gateway = false } = {}) {
  const tokens = { input: KYB_TOKENS, output: 2_000, cacheRead: 0, cacheWrite: 0 };
  const usd = (tokens.input * 2 + tokens.output * 10) / 1e6;
  return { inputTokensMax: gateway ? GATEWAY_BOUNDS.kyb : KYB_TOKENS * 4, outputTokensAsked: 128_000, outputTokensLeast: 1_024, tokens, usd };
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
  // "Run a kyb step[ through a gateway].": one kyb step (kybStep) that answers.
  const kyb = /Run a kyb step( through a gateway)?\./.exec(text);
  if (kyb) return [{ say: "Kyb step done.", ...kybStep({ gateway: kyb[1] !== undefined }) }];
  return base(spec, session);
}
