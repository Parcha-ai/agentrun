// Under --faux only: the fetch serve's OpenRouter decision provider sends System One requests through
// (AGENTRUN_SERVE_FAUX_OPENROUTER), in place of POST https://openrouter.ai/api/v1/systemone. Same request shape as Jev's;
// each model answers from answers.mjs (the jury's split case is a fixture where they disagree), in its own latency band,
// and reports a cost at its catalog price for the tokens it counts.
import { answer } from "./answers.mjs";
import { jitter, json, logCall, readRequest, wait } from "./common.mjs";
import { openrouterLatency, openrouterPrices } from "./fixtures.mjs";

export default async function fauxOpenRouter(url, init = {}) {
  const { json: body, images } = await readRequest(url, init);
  const started = Date.now();
  const model = typeof body.model === "string" ? body.model : "unknown";
  const seed = JSON.stringify(body.state ?? {}).slice(0, 2000);
  const [low, high] = openrouterLatency[model] ?? [500, 1500];
  await wait(low + Math.round(((jitter("or-latency", model, seed) + 1) / 2) * (high - low)), init.signal);
  // A Jev request on the OpenRouter route answers as Jev.
  const answers = answer({ state: body.state, questions: body.questions, model: /typesafe\/jev/.test(model) ? "jev" : model });
  const input_tokens = Math.ceil(JSON.stringify({ state: body.state, questions: body.questions }).length / 4) + images * 1150;
  const price = openrouterPrices[model];
  const cost = price === undefined ? undefined : Math.round(input_tokens * price * 1e9) / 1e9;
  await logCall({ provider: "openrouter", model, questions: Object.keys(body.questions ?? {}), ms: Date.now() - started });
  return json({
    id: `gen-faux-${Math.abs(Math.round(jitter("or-id", model, seed, String(started)) * 1e12)).toString(36)}`,
    model, answers, usage: { input_tokens, output_tokens: 0, ...(cost === undefined ? {} : { cost }) },
  });
}
