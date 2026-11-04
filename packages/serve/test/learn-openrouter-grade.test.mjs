// Learning's grader for a claude-agent agent on OPENROUTER_API_KEY alone: the grade goes where the run's own requests go
// (claudeProvider's answer: OpenRouter's Messages endpoint, the key as a bearer token) and names the model id the run
// sends (claude-sonnet-5-5), which pi-ai's anthropic catalog knows. Before, the grade looked up the name the cap keeps
// (OpenRouter's dotted anthropic/claude-sonnet-5.5), found no model, and every learning run ended grade_failed before
// any request went out.
//
// judgeProposal is called exactly as learning-run.ts calls it, with no provider handed in. claudeProvider points only at
// openrouter.ai on this route, by design (no setting sends the OpenRouter key anywhere else), so the test reaches the
// faux gateway by redirecting fetch: a request to https://openrouter.ai/<path>?<query> is sent to the gateway at the
// same path and query, with its method, headers and body unchanged. Any other request off loopback is refused and
// listed, so nothing here reaches the network. OPENROUTER_API_KEY is also Jev's key, so the injection screen runs
// first; it stays off the network through the faux switch and a quiet faux Jev.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgeProposal } from "../dist/grade.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { note } from "./fixtures/faux-learn.mjs";
import { scratch } from "./support.mjs";

const KEY = "not-a-secret-openrouter";
/** The id claude-agent's CLI sends for Sonnet 5.5 on every route: Anthropic's own. */
const CLAUDE_WIRE = "claude-sonnet-5-5";
const GRADER = "You grade what an agent proposes to remember.";
const isGrade = (r) => JSON.stringify(r.body ?? "").includes(GRADER);
const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");
const KEEP = JSON.stringify({ merge: true, reason: "The note is general and new.", items: [{ file: "check-units.md", keep: true, why: "It holds as a general rule." }] });
/** Each grade request as the gateway took it: path, query, how the key came, and the model it named. */
const graded = (requests) => requests.filter((r) => r.method === "POST" && isGrade(r)).map((r) => [r.path, r.query, r.headers.authorization ?? null, r.headers["x-api-key"] ?? null, r.body?.model]);

/** While `t` runs, a request to openrouter.ai goes to `gateway` at the same path and query, as it was sent; one to
 *  loopback goes as it is; any other is refused before it is sent, and listed (origin and path). */
function toGateway(t, gateway) {
  const real = globalThis.fetch;
  const refused = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return real(input, init);
    if (url.origin === "https://openrouter.ai") {
      const there = `${gateway}${url.pathname}${url.search}`;
      return input instanceof Request ? real(new Request(there, input), init) : real(there, init);
    }
    refused.push(`${url.origin}${url.pathname}`);
    return Promise.reject(new Error(`this test sends nothing off loopback: ${url.origin}`));
  };
  t.after(() => (globalThis.fetch = real));
  return refused;
}

/** The screen's Jev under the faux switch: every note scored well under the injection threshold. */
function quietJev(dir) {
  const file = join(dir, "faux-jev-quiet.mjs");
  writeFileSync(file, `export default async function jev(url, init = {}) {
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, q]) => {
    if (q.type === "choice") { const o = Object.keys(q.criteria); return [id, { type: "choice", choice: o[0], confidence: 0.8, probabilities: Object.fromEntries(o.map((x, i) => [x, i === 0 ? 1 : 0])) }]; }
    if (q.type === "score") return [id, { type: "score", score: 0, confidence: 0.8, legend: Object.fromEntries(q.criteria.map((v, i) => [i, v])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 1 : 0])) }];
    return [id, { type: "noul", noul: 0.01 }];
  }));
  return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 120, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}
`);
  return file;
}

/** serve's env on OpenRouter alone, as the grade reads it, with the screen's Jev faux. */
const orAlone = (dir) => ({ OPENROUTER_API_KEY: KEY, AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: quietJev(dir) });

// The names a claude-agent agent may give Sonnet 5.5 on OpenRouter alone: OpenRouter's dotted name under anthropic (the
// host's default on this route), pi's name for it (openrouter/anthropic/...), and none (the host's default).
for (const model of ["anthropic/claude-sonnet-5.5", "openrouter/anthropic/claude-sonnet-5.5", undefined]) {
  const named = model ?? "the host's default";
  test(`on OPENROUTER_API_KEY alone, a claude-agent grade (${named}) goes to OpenRouter's Messages endpoint with a bearer key and the id the run sends, and is graded`, { timeout: 60_000 }, async (t) => {
    const dir = await scratch(t);
    const gw = await startFauxGateway({ text: (r) => (isGrade(r) ? KEEP : "ok") });
    t.after(() => gw.close());
    const refused = toGateway(t, gw.url);
    const judged = await judgeProposal({ runId: "run_or_grade", agent: { instructions: "Answer the question.", harness: "claude-agent", ...(model ? { model } : {}) }, main: { active: [], superseded: [] }, proposed: [{ file: "check-units.md", text: UNITS }], env: orAlone(dir), signal: new AbortController().signal, gradeTimeoutMs: 30_000 });
    assert.ok("verdict" in judged, `${named}: graded, not ${judged.reason}: ${judged.error?.message}`);
    assert.equal(judged.verdict.merge, true, JSON.stringify(judged.verdict));
    assert.deepEqual(graded(gw.requests), [["/api/v1/messages", "beta=true", `Bearer ${KEY}`, null, CLAUDE_WIRE]]);
    assert.ok(gw.requests.filter(isGrade).every((r) => typeof r.headers["anthropic-version"] === "string"), "each names an anthropic-version");
    assert.deepEqual(refused, [], "nothing left loopback");
  });
}

// codex on OPENROUTER_API_KEY alone: the grade goes where the run's own requests go, OpenRouter with the same key, on the
// model the run runs (codexModel, then codexProvider's id: openai/gpt-6-sol), through pi-ai's openrouter provider (Chat
// Completions). Before, the grade asked runModels for the revision's own name, and openai/<model> needs OPENAI_API_KEY
// there, so every codex learning proposal ended grade_failed. The model faux switch stays off here (it would grade on the
// faux model), so the screen's Jev request, which goes to openrouter.ai too, is answered in the test, as quietly as the
// faux Jev above answers it; the grade's request goes on to the gateway.
const CODEX_WIRE = "openai/gpt-6-sol";
const bodyOf = (init) => {
  try {
    return JSON.parse(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body));
  } catch {
    return undefined;
  }
};
function quietJevAnswer(body) {
  const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, q]) => {
    if (q.type === "choice") { const o = Object.keys(q.criteria); return [id, { type: "choice", choice: o[0], confidence: 0.8, probabilities: Object.fromEntries(o.map((x, i) => [x, i === 0 ? 1 : 0])) }]; }
    if (q.type === "score") return [id, { type: "score", score: 0, confidence: 0.8, legend: Object.fromEntries(q.criteria.map((v, i) => [i, v])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 1 : 0])) }];
    return [id, { type: "noul", noul: 0.01 }];
  }));
  return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 120, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}
/** toGateway, but a Jev request (a body with `questions`) is answered here, quietly. */
function toGatewayJevQuiet(t, gateway) {
  const refused = toGateway(t, gateway);
  const routed = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = url.origin === "https://openrouter.ai" && !(input instanceof Request) ? bodyOf(init) : undefined;
    return body && typeof body === "object" && "questions" in body ? Promise.resolve(quietJevAnswer(body)) : routed(input, init);
  };
  return refused;
}

// The names a codex agent may give its model on OpenRouter alone: OpenAI's (the one the bug dropped), pi's
// (openrouter/openai/...), and none (codex's default on this route).
for (const model of ["openai/gpt-6-sol", "openrouter/openai/gpt-6-sol", undefined]) {
  const named = model ?? "the host's default";
  test(`on OPENROUTER_API_KEY alone, a codex grade (${named}) goes to OpenRouter with the run's key and model, and is graded`, { timeout: 60_000 }, async (t) => {
    const gw = await startFauxGateway({ text: (r) => (isGrade(r) ? KEEP : "ok") });
    t.after(() => gw.close());
    const refused = toGatewayJevQuiet(t, gw.url);
    const judged = await judgeProposal({ runId: "run_or_grade_codex", agent: { instructions: "Answer the question.", harness: "codex", ...(model ? { model } : {}) }, main: { active: [], superseded: [] }, proposed: [{ file: "check-units.md", text: UNITS }], env: { OPENROUTER_API_KEY: KEY }, signal: new AbortController().signal, gradeTimeoutMs: 30_000 });
    assert.ok("verdict" in judged, `${named}: graded, not ${judged.reason}: ${judged.error?.message}`);
    assert.equal(judged.verdict.merge, true, JSON.stringify(judged.verdict));
    assert.deepEqual(graded(gw.requests), [["/api/v1/chat/completions", "", `Bearer ${KEY}`, null, CODEX_WIRE]]);
    assert.deepEqual(refused, [], "nothing left loopback");
  });
}
