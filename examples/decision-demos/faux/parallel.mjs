// Under --faux only: the fetch serve's Parallel provider sends decision requests through (AGENTRUN_SERVE_FAUX_PARALLEL),
// in place of Parallel's API. It answers the registry and merchant questions from fixtures.mjs, with citations whose
// titles and passages say [FIXTURE], and takes as long as a `fast` web-grounded decision does (a few seconds). Like
// Parallel's API, it reports no cost; the provider books its list price as an estimate.
import { choiceAtConfidence, clamp, jitter, json, logCall, readRequest, round, wait } from "./common.mjs";
import { merchants, registry, registryCitations } from "./fixtures.mjs";

export default async function fauxParallel(url, init = {}) {
  const { json: body } = await readRequest(url, init);
  const started = Date.now();
  const state = body.state ?? {};
  const seed = JSON.stringify(state).slice(0, 2000);
  await wait(2600 + Math.round((jitter("parallel-latency", seed) + 1) * 2200), init.signal);
  const text = JSON.stringify(state);
  const merchant = Object.values(merchants).find((m) => text.includes(m.name));
  const company = typeof state.company === "string" ? state.company : undefined;
  const record = company ? registry[company] : undefined;
  const answers = {};
  for (const [id, question] of Object.entries(body.questions ?? {})) {
    const j = jitter("parallel", id, seed) * 0.03;
    const options = question.type === "choice" ? Object.keys(question.criteria ?? {}) : [];
    if (id === "registry_status") {
      const status = record ? (record.state === state.jurisdiction ? record.status : "registered_elsewhere") : "not_found";
      answers[id] = choiceAtConfidence(options, options.includes(status) ? status : options.at(-1), record ? 0.9 + j : 0.78 + j);
    } else if (id === "name_exact") answers[id] = { type: "noul", noul: round(clamp(record ? 0.96 + j : 0.2 + j)) };
    else if (id === "sells_prohibited" && merchant) answers[id] = { type: "noul", noul: round(clamp(merchant.web.prohibited + j)) };
    else if (id === "risk_level" && merchant) answers[id] = choiceAtConfidence(options, merchant.web.risk, merchant.web.riskConfidence);
    else if (question.type === "choice") answers[id] = choiceAtConfidence(options, options[0], 0.5);
    else if (question.type === "noul") answers[id] = { type: "noul", noul: 0.5 };
    else answers[id] = { type: "refusal" };
  }
  const citations = merchant ? merchant.citations : company ? registryCitations(company, state.jurisdiction ?? "") : [];
  const decision_id = `dec_faux_${Math.abs(Math.round(jitter("dec", seed, String(started)) * 1e12)).toString(36)}`;
  await logCall({ provider: "parallel", questions: Object.keys(body.questions ?? {}), mode: body.mode, ms: Date.now() - started });
  return json({ decision_id, mode: body.mode ?? "fast", answers, citations: body.include_excerpts === false ? citations.map(({ excerpts, ...c }) => c) : citations, usage: { input_tokens: Math.ceil(text.length / 4) } });
}
