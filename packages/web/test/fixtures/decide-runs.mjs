// createWeb with a decider on the fakes (web-runs.mjs): a DecisionProvider that scores each item as a table says, a
// Parallel whose extract answers a three-paragraph page, and `decideSteps`, one fixed sequence of searches and fetches
// with a task, giving what each answered: the answer, the text the model reads, and the receipt with its clock fields
// zeroed (each try's ms, the record's latency). decide-runs.golden.json was written by this sequence at 36408cca68,
// before the decider gave scores and the step chose what to show, so the drop policy is held to it byte for byte.
// decide-runs-pre-guard.golden.json holds the sha256 of each answer, model text and receipt `policySteps` gave at
// 489a989503, before the page guard, so a web with the guard off is held to it under every policy. Both have moved four
// times since: for web_search's objective, each search answer's `query` became `objective` and `queries`, each search
// receipt gained `queries`, an empty search's error and a fetch's sift line name the objective; at step 6 (a fetch with
// no task), whose part comes back with no sift field, so its answer, text and receipt's out size moved with it; and in
// each receipt with a decision request, whose line is now what it was charged (the cost the fake gave, $0.0001, under
// its $0.0002 hold), so those receipts' cost moved, and nothing else in them; and at step 7 (a refused fetch), whose
// fallback line now says "Parallel gave no page" where it said "Parallel was picked for web_fetch and gave no page", so
// its text, the receipt's copy of it and the receipt's out size (29 fewer characters) moved, and nothing else. web-runs'
// fetch of the same refused page (its step 5) moved the same way.
import { deciderFrom, searchText, webFetchText } from "../../dist/index.js";
import fakeParallel from "./faux-parallel.mjs";
import { fakeWeb, PUBLIC } from "./web-runs.mjs";

export { PUBLIC };
export const TASK = "Where is Widgets, Inc. registered?";
/** Three paragraphs, each its own passage. */
export const A = `${"a".repeat(590)}\n\n`;
export const B = `${"b".repeat(590)}\n\n`;
export const C = "c".repeat(590);
export const LONG = `${A}${B}${C}`;
/** What the fake answers: a noul per id (a number, or an answer object such as a refusal); 0.5 for any other id. */
export const SCORES = { r1: 0.9, r2: 0.05, r3: 0.2, r4: 0.21, p1: 0.9, p2: 0.01, p3: 0.7 };

/** A DecisionProvider answering each question with `scores[id]`, and the requests it was asked. */
export function scoringProvider(scores = SCORES) {
  const asked = [];
  return {
    asked,
    provider: {
      id: "fake",
      needs: [],
      async decide(request, ctx) {
        asked.push({ request, ctx });
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => {
          const given = scores[id] ?? 0.5;
          return [id, typeof given === "object" ? given : { type: "noul", noul: given }];
        }));
        return { answers, evidence: [], model: "fake-1", usage: { input_tokens: 100, output_tokens: 4 }, cost_usd: 0.0001, cost_basis: "estimate", provider_request_id: null };
      },
    },
  };
}

/** Parallel's fake, but an extract answers `content` as the page. */
export const pagesOf = (content) => async (url, init) => {
  if (new URL(String(url)).pathname !== "/v1/extract") return fakeParallel(url, init);
  const { urls } = JSON.parse(init.body);
  return new Response(JSON.stringify({ extract_id: "x", results: urls.map((u) => ({ url: u, title: "Long", publish_date: null, excerpts: [], full_content: content })), errors: [], warnings: null, usage: [], session_id: "s" }), { status: 200, headers: { "content-type": "application/json" } });
};

/** A web on the fakes with the scoring decider and the long page, `extra` laid over (a policy). */
export function decideWeb(extra = {}, scores = SCORES) {
  return fakeWeb({ decider: deciderFrom(scoringProvider(scores).provider, { price: { requestUsd: 0.0002 } }), send: { parallel: pagesOf(LONG) }, ...extra });
}

const steady = (receipt) => ({
  ...receipt,
  tries: receipt.tries.map((t) => (t.ms === undefined ? t : { ...t, ms: 0 })),
  ...(typeof receipt.classifier === "object" ? { classifier: { ...receipt.classifier, latency_ms: 0 } } : {}),
});

/** The fixed sequence on `web`, each step's answer, model text and receipt; `more`, a looking_for fetch after it. */
export async function decideSteps(web, more = false) {
  const out = [];
  const search = async (query, options) => {
    const { answer, receipt } = await web.search(query, options);
    out.push({ op: "search", answer, text: searchText(answer), receipt: steady(receipt) });
  };
  const fetch = async (url, options) => {
    const { answer, receipt } = await web.fetch(url, options);
    out.push({ op: "fetch", answer, text: webFetchText(answer), receipt: steady(receipt) });
  };
  await search("widgets delaware", { n: 4, task: TASK });
  await search("widgets delaware", { n: 2 });
  await search("   ", { task: TASK });
  await fetch(PUBLIC, { task: TASK });
  await fetch(PUBLIC, { task: TASK, offset: A.length, maxChars: 600 });
  await fetch(PUBLIC);
  await fetch("http://evil.example/", { task: TASK });
  if (more) await fetch(PUBLIC, { task: TASK, lookingFor: "the registry entry" });
  return out;
}

/** The fixed sequence and a looking_for fetch under each policy, with the step's decider and no page guard. */
export async function policySteps() {
  const out = {};
  for (const policy of ["drop", "label", "rerank+label"]) out[policy] = await decideSteps(decideWeb({ policy }), true);
  return out;
}
