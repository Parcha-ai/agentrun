// Under --faux only: OpenRouter's Decisions models in one fetch that keeps the headers each request carried (on
// globalThis.__fauxOpenRouterHeaders, for a test in the same process) and answers every question yes
// (openrouter-attribution.test.mjs).
export default async function fauxOpenRouterApp(url, init = {}) {
  (globalThis.__fauxOpenRouterHeaders ??= []).push({ url: String(url), headers: new Headers(init.headers) });
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((id) => [id, { type: "noul", noul: 0.9 }]));
  return new Response(JSON.stringify({ id: "gen-app", model: body.model, answers, usage: { input_tokens: 10, output_tokens: 0, cost: 0.000001 } }), { status: 200, headers: { "content-type": "application/json" } });
}
