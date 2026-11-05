// Under --faux only: decision providers (Jev, OpenRouter's System One, Parallel) in one fetch, each answering every
// question yes, and Parallel citing a source whose title echoes the key it was sent, as a provider that quotes its
// request would (decision-row-redact.test.mjs).
export default async function echoDecisions(url, init = {}) {
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((id) => [id, { type: "noul", noul: 0.9 }]));
  const key = new Headers(init.headers).get("x-api-key") ?? "";
  // AGENTRUN_TEST_FAUX_CITATION_ALSO: a value the title quotes besides, which a test saves as a key after the run.
  const also = process.env.AGENTRUN_TEST_FAUX_CITATION_ALSO ? ` and ${process.env.AGENTRUN_TEST_FAUX_CITATION_ALSO}` : "";
  const citations = [{ url: "https://registry.example.test/acme", title: `Acme, filed under ${key}${also}`, excerpts: ["Active."] }];
  return new Response(JSON.stringify({ decision_id: "dec-echo", mode: body.mode ?? "fast", answers, citations }), { status: 200, headers: { "content-type": "application/json" } });
}
