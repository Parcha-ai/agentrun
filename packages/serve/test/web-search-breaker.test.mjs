// A run's web_search breaker: once the run's search provider answers that the run is rate-limited or out of quota, every
// later web_search call in that run answers that search is unavailable for the rest of the run, without asking the
// provider again. The breaker is the run's own: each run's binding (TOOLS' bind, as a run binds its tools) starts closed,
// so another run on the same server searches as before. Each provider is the tests' fake: keyless Exa, Parallel, and
// the model providers' hosted search (Anthropic, OpenAI) through the run's models.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { bookedIn } from "../dist/paid-calls.js";
import { TOOLS } from "../dist/tools.js";
import { TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { RATE_LIMITED } from "../dist/exa-keyless.js";
import { runModels } from "../dist/model.js";
import { callFailed, labelOf } from "../dist/timeline/index.js";
import { outcomeOf } from "../dist/timeline/labels.js";
import { resetFauxExa } from "./fixtures/faux-exa.mjs";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { FAUX, scratch, toolLedger, withEnv } from "./support.mjs";

/** What every web_search call of a run answers once its provider said the run is rate-limited or out of quota. */
const UNAVAILABLE = "search is unavailable for the rest of this run; answer from what you have";
const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const plane = (web_search, model) => JSON.stringify({ web_search, ...(model ? { model } : {}) });

/** One run's web_search, bound as a run binds it (TOOLS' bind, on a host of its own): a call answers what the model
 *  reads (its text) and what the timeline keeps (its details). Each call runs in a call of the run's one ledger, as the
 *  adapter loop runs a host tool, so a request to Parallel is booked. */
async function bindRun(env, search) {
  const { tools: [tool] } = await TOOLS.web_search.bind({ env, install() {}, ...(search ? { search } : {}) });
  const paid = await toolLedger();
  let calls = 0;
  return async (query) => {
    const callId = `call-${(calls += 1)}`;
    const result = await bookedIn({ call: callId, paid }, () => tool.execute({ query }, { callId }, {}));
    return { text: result.output[0].text, details: result.details, isError: Boolean(result.isError) };
  };
}

/** The lines a fake filed in `file`, parsed; none before it filed one. */
const filed = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** keyless Exa's fake answering as `mode` says, counted from its first search: the run's env, and how many searches
 *  reached Exa so far. */
async function exa(t, mode) {
  const calls = join(await scratch(t), "exa.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA: mode, AGENTRUN_TEST_FAUX_EXA_CALLS: calls });
  resetFauxExa();
  const env = { [TOOL_PLANE_ENV]: plane("exa-keyless"), AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_EXA: fixture("faux-exa.mjs") };
  return { env, searches: async () => (await filed(calls)).filter((call) => call.method === "tools/call").length };
}

/** Parallel's fake answering each search `mode` (an HTTP status, or empty for results): the run's env, and how many
 *  searches reached Parallel so far. */
async function parallel(t, mode) {
  const calls = join(await scratch(t), "parallel.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_PARALLEL_SEARCH: mode, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls });
  const env = { [TOOL_PLANE_ENV]: plane("parallel"), PARALLEL_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_PARALLEL: fixture("faux-parallel.mjs") };
  return { env, searches: async () => (await filed(calls)).filter((call) => /\/v1\/search$/.test(call.path ?? call.url ?? "")).length };
}

/** The model provider's hosted search on `model` (`provider/id`), its fake answering as `mode` says: the run's env and
 *  models, and how many requests reached the provider so far. */
async function hosted(t, model, mode) {
  const calls = join(await scratch(t), "upstream.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_UPSTREAM: mode, AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: calls });
  const env = { [TOOL_PLANE_ENV]: plane("native", model), AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_UPSTREAM: fixture("faux-upstream.mjs"), ANTHROPIC_API_KEY: "not-a-secret", OPENAI_API_KEY: "not-a-secret" };
  const { models } = await runModels(env, undefined);
  return { env, search: async () => models, searches: async () => (await filed(calls)).length };
}

/** A call's answer as the model reads it: its JSON, the line asking for citations after a found search left off. */
const said = (answer) => JSON.parse(answer.text.split("\n")[0]);

test("keyless Exa rate-limits a run's first search: that call answers Exa's limit in our words, and every later call in the run answers that search is unavailable for the rest of the run; Exa is asked once", async (t) => {
  const { env, searches } = await exa(t, "429");
  const search = await bindRun(env);
  assert.deepEqual(said(await search("widgets")), { error: RATE_LIMITED });
  for (const query of ["widgets", "gadgets", "sprockets", "widgets delaware", "widgets"]) assert.deepEqual(said(await search(query)), { error: UNAVAILABLE }, query);
  assert.equal(await searches(), 1, "Exa was asked once, by the first call");
});

test("the breaker is the run's own: another run on the same server searches as before and asks the provider again, while the limited run stays unavailable", async (t) => {
  const { env, searches } = await exa(t, "429,ok");
  const limited = await bindRun(env);
  assert.deepEqual(said(await limited("widgets")), { error: RATE_LIMITED });
  assert.deepEqual(said(await limited("widgets")), { error: UNAVAILABLE });
  // A second run's binding, on the same server's environment: it starts closed.
  const next = await bindRun(env);
  const found = said(await next("widgets"));
  assert.equal(found.provider, "exa-keyless", JSON.stringify(found));
  assert.ok(found.results.length > 0, JSON.stringify(found));
  assert.equal(await searches(), 2, "the second run asked Exa");
  assert.deepEqual(said(await limited("widgets")), { error: UNAVAILABLE }, "the limited run is still unavailable");
  assert.equal(await searches(), 2);
});

test("a keyed provider's rate-limit or quota answer trips the run's breaker the same way: Parallel's 429 and 402, Anthropic's rate_limit_error and billing_error, OpenAI's rate_limit_exceeded and insufficient_quota", async (t) => {
  for (const status of ["429", "402"]) {
    await t.test(`Parallel ${status}`, async (t) => {
      const { env, searches } = await parallel(t, status);
      const search = await bindRun(env);
      assert.match(said(await search("widgets")).error, new RegExp(`^Parallel's search answered ${status}$`));
      for (const query of ["widgets", "gadgets"]) assert.deepEqual(said(await search(query)), { error: UNAVAILABLE }, query);
      assert.equal(await searches(), 1, "Parallel was asked once");
    });
  }
  for (const [model, mode] of [["anthropic/claude-sonnet-5-5", "rate_limited"], ["anthropic/claude-sonnet-5-5", "quota"], ["openai/gpt-5", "rate_limited"], ["openai/gpt-5", "quota"]]) {
    await t.test(`${model} ${mode}`, async (t) => {
      const { env, search: models, searches } = await hosted(t, model, mode);
      const search = await bindRun(env, models);
      assert.match(said(await search("widgets")).error, /^the provider's search failed: /);
      for (const query of ["widgets", "gadgets"]) assert.deepEqual(said(await search(query)), { error: UNAVAILABLE }, query);
      assert.equal(await searches(), 1, "the provider was asked once");
    });
  }
});

test("a search that succeeds, then one the provider rate-limits, then more: the provider is asked twice in all, and every call after the limit is unavailable", async (t) => {
  const { env, searches } = await exa(t, "ok,429");
  const search = await bindRun(env);
  const first = said(await search("widgets"));
  assert.equal(first.provider, "exa-keyless", JSON.stringify(first));
  assert.deepEqual(said(await search("gadgets")), { error: RATE_LIMITED });
  for (const query of ["widgets", "sprockets", "widgets delaware"]) assert.deepEqual(said(await search(query)), { error: UNAVAILABLE }, query);
  assert.equal(await searches(), 2);
});

test("a failure that is no limit leaves the breaker closed: Parallel's 500 and Exa's refused connection (403) are asked again on each call", async (t) => {
  await t.test("Parallel 500", async (t) => {
    const { env, searches } = await parallel(t, "500");
    const search = await bindRun(env);
    for (let i = 0; i < 3; i += 1) assert.match(said(await search("widgets")).error, /^Parallel's search answered 500$/);
    assert.equal(await searches(), 3);
  });
  await t.test("Exa 403", async (t) => {
    const { env, searches } = await exa(t, "403");
    const search = await bindRun(env);
    for (let i = 0; i < 3; i += 1) assert.match(said(await search("widgets")).error, /refused keyless use from this connection \(403\)/);
    assert.equal(await searches(), 3);
  });
});

test("a call the breaker answers reads on the timeline as a failed search in its own words, never as a search that found nothing", async (t) => {
  const { env } = await exa(t, "429");
  const search = await bindRun(env);
  await search("widgets");
  const answer = await search("widgets delaware");
  assert.equal(answer.text, JSON.stringify({ error: UNAVAILABLE }), "the model reads these words alone, exactly");
  assert.deepEqual(answer.details, { error: UNAVAILABLE }, "the details the timeline keeps");
  const view = { text: answer.text, details: answer.details, isError: answer.isError };
  assert.deepEqual(outcomeOf("web_search", view), { failed: true, text: `failed: ${UNAVAILABLE}` });
  assert.equal(callFailed("web_search", view), true);
  const label = labelOf("web_search", { query: "widgets delaware" }, view);
  assert.doesNotMatch(label, /\bresults?\b/, label);
});
