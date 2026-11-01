// The smoke's faux decision providers, one fetch for Jev, OpenRouter's System One and Parallel. Jev and OpenRouter go to
// the engine's faux System One (@parcha/agentrun-decisions/testing/faux-system-one: stable hashed answers, multipart
// images, a priced usage); Parallel answers here with a citation. Every call waits about AGENTRUN_SMOKE_DECISION_MS so a
// pause can land mid-run, and files one line in AGENTRUN_SMOKE_DECISION_CALLS.
import { appendFileSync } from "node:fs";
import fauxSystemOne from "@parcha/agentrun-decisions/testing/faux-system-one";

export default async function fakeDecisions(url, init = {}) {
  const at = new URL(String(url));
  if (!at.host.includes("parallel")) {
    process.env.AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS ??= process.env.AGENTRUN_SMOKE_DECISION_MS ?? "1500";
    process.env.AGENTRUN_FAUX_SYSTEM_ONE_CALLS ??= process.env.AGENTRUN_SMOKE_DECISION_CALLS;
    return fauxSystemOne(url, init);
  }
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  if (process.env.AGENTRUN_SMOKE_DECISION_CALLS) appendFileSync(process.env.AGENTRUN_SMOKE_DECISION_CALLS, `${JSON.stringify({ path: at.pathname, model: body.mode ?? null, questions: Object.keys(body.questions ?? {}), images: 0 })}\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.AGENTRUN_SMOKE_DECISION_MS ?? 1500)));
  const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, q]) => {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      return [id, { type: "choice", choice: options[0], probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.82 : 0.18 / Math.max(1, options.length - 1)])) }];
    }
    if (q.type === "score") return [id, { type: "score", score: 0, legend: Object.fromEntries(q.criteria.map((v, i) => [i, v])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 1 : 0])) }];
    return [id, { type: "noul", noul: 0.91 }];
  }));
  return new Response(JSON.stringify({ decision_id: "dec-smoke", mode: body.mode ?? "fast", answers, citations: [{ url: "https://registry.example.test/acme", title: "Acme Widgets, Inc.", excerpts: ["Active, Delaware."] }] }), { status: 200, headers: { "content-type": "application/json" } });
}
