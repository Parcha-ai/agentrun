// Under --faux only: the fetch serve's Jev provider sends System One requests through (AGENTRUN_SERVE_FAUX_JEV), in
// place of TypeSafe's API. It answers the demo's questions from documents/labels.json (answers.mjs), takes about as long
// as Jev does (longer per image), and reports a cost at Jev's list price for the tokens it counts. Every number is a
// fixture.
import { answer } from "./answers.mjs";
import { jitter, json, logCall, readRequest, wait } from "./common.mjs";

/** TypeSafe's list price for Jev input, USD per token ($0.042 per million). */
const PRICE = 0.042 / 1e6;
/** About what one page image at 110 dpi counts as, in input tokens. */
const IMAGE_TOKENS = 1150;

export default async function fauxJev(url, init = {}) {
  const { json: body, images } = await readRequest(url, init);
  const started = Date.now();
  const seed = JSON.stringify(body.state ?? {}).slice(0, 2000);
  await wait(380 + images * 650 + Math.round((jitter("jev-latency", seed) + 1) * 260), init.signal);
  const answers = answer({ state: body.state, questions: body.questions, model: "jev" });
  const input_tokens = Math.ceil(JSON.stringify({ state: body.state, questions: body.questions }).length / 4) + images * IMAGE_TOKENS;
  const cost = Math.round(input_tokens * PRICE * 1e9) / 1e9;
  await logCall({ provider: "jev", path: new URL(String(url instanceof Request ? url.url : url)).pathname, images, questions: Object.keys(body.questions ?? {}), ms: Date.now() - started });
  return json({ model: body.model && body.model !== "jev-latest" ? body.model : "jev-1.14.0", answers, usage: { input_tokens, output_tokens: 0, cost } }, 200, { "x-typesafe-request-id": `req-faux-${Math.abs(Math.round(jitter("id", seed, String(Date.now())) * 1e9))}` });
}
