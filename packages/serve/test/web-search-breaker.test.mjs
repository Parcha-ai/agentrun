// A run's web_search breaker. Once the run's search provider answers that the run is out of quota (Parallel's 402, a
// model provider's billing_error or insufficient_quota), every later web_search call in that run answers that search is
// unavailable for the rest of the run, without asking the provider again. Once it answers that the run is rate-limited
// (Exa's free limit, a 429, a rate-limit error), every call answers that search is busy for the seconds left of the wait
// the provider named (Retry-After, in seconds or as an HTTP date), or 60 s when it named none; past it, the next call
// asks the provider again. The breaker is the run's own: each run's binding (TOOLS' bind, as a run binds its tools)
// starts closed, so another run on the same server searches as before. Each provider is the tests' fake: keyless Exa, Parallel, and
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
import * as webSearch from "../dist/web-search.js";
import { resetFauxExa } from "./fixtures/faux-exa.mjs";
import { CANARY, resetFauxParallel } from "./fixtures/faux-parallel.mjs";
import { FAUX, scratch, toolLedger, withEnv } from "./support.mjs";

/** What every web_search call of a run answers once its provider said the run is out of quota. */
const UNAVAILABLE = "search is unavailable for the rest of this run; answer from what you have";
/** What a call answers while a rate limit's wait holds, `n` seconds of it left. */
const BUSY = /^search is busy; try again in (\d+) s, or answer from what you have$/;
/** The seconds a call's answer says the wait holds for, checked to be the busy words and within [low, high]. */
function busy(answer, low, high) {
  const said = JSON.parse(answer.text.split("\n")[0]);
  assert.deepEqual(Object.keys(said), ["error"], answer.text);
  const m = BUSY.exec(said.error);
  assert.ok(m, `the busy words: ${said.error}`);
  const n = Number(m[1]);
  assert.ok(n >= low && n <= high, `${n} s left, within [${low}, ${high}]`);
  return n;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  resetFauxParallel();
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

test("keyless Exa rate-limits a run's first search (Retry-After 30): that call answers Exa's limit in our words, and every later call within the wait answers that search is busy for the seconds left; Exa is asked once", async (t) => {
  const { env, searches } = await exa(t, "429");
  const search = await bindRun(env);
  assert.deepEqual(said(await search("widgets")), { error: RATE_LIMITED });
  for (const query of ["widgets", "gadgets", "sprockets", "widgets delaware", "widgets"]) busy(await search(query), 29, 30);
  assert.equal(await searches(), 1, "Exa was asked once, by the first call");
});

test("the breaker is the run's own: another run on the same server searches as before and asks the provider again, while the limited run stays busy", async (t) => {
  const { env, searches } = await exa(t, "429,ok");
  const limited = await bindRun(env);
  assert.deepEqual(said(await limited("widgets")), { error: RATE_LIMITED });
  busy(await limited("widgets"), 29, 30);
  // A second run's binding, on the same server's environment: it starts closed.
  const next = await bindRun(env);
  const found = said(await next("widgets"));
  assert.equal(found.provider, "exa-keyless", JSON.stringify(found));
  assert.ok(found.results.length > 0, JSON.stringify(found));
  assert.equal(await searches(), 2, "the second run asked Exa");
  busy(await limited("widgets"), 29, 30);
  assert.equal(await searches(), 2);
});

test("a keyed provider's quota answer stops the run's search for good, and its rate limit holds it for a wait: Parallel's 402 and 429, Anthropic's billing_error and rate_limit_error, OpenAI's insufficient_quota and rate_limit_exceeded", async (t) => {
  for (const [status, off] of [["402", true], ["429", false]]) {
    await t.test(`Parallel ${status}`, async (t) => {
      const { env, searches } = await parallel(t, status);
      const search = await bindRun(env);
      assert.match(said(await search("widgets")).error, new RegExp(`^Parallel's search answered ${status}$`));
      // Parallel named no wait: 60 s.
      for (const query of ["widgets", "gadgets"]) off ? assert.deepEqual(said(await search(query)), { error: UNAVAILABLE }, query) : busy(await search(query), 59, 60);
      assert.equal(await searches(), 1, "Parallel was asked once");
    });
  }
  for (const [model, mode, off] of [["anthropic/claude-sonnet-5-5", "quota", true], ["anthropic/claude-sonnet-5-5", "rate_limited", false], ["openai/gpt-5", "quota", true], ["openai/gpt-5", "rate_limited", false]]) {
    await t.test(`${model} ${mode}`, async (t) => {
      const { env, search: models, searches } = await hosted(t, model, mode);
      const search = await bindRun(env, models);
      assert.match(said(await search("widgets")).error, /^the provider's search failed: /);
      // The wait the provider named where it reaches here, else 60 s: never more.
      for (const query of ["widgets", "gadgets"]) off ? assert.deepEqual(said(await search(query)), { error: UNAVAILABLE }, query) : busy(await search(query), 1, 60);
      assert.equal(await searches(), 1, "the provider was asked once");
    });
  }
});

test("the lead's case: a 429 with Retry-After 2 holds search for 2 s, a call within it answers busy unsent, and a call 3 s later reaches the provider", async (t) => {
  const { env, searches } = await parallel(t, "429@2;ok");
  const search = await bindRun(env);
  assert.match(said(await search("widgets")).error, /^Parallel's search answered 429$/);
  busy(await search("widgets"), 1, 2);
  assert.equal(await searches(), 1, "the call within the wait was not sent");
  await pause(3_000);
  const found = said(await search("widgets"));
  assert.equal(found.provider, "parallel", JSON.stringify(found));
  assert.equal(await searches(), 2, "the call after the wait reached Parallel");
  // A success leaves it closed.
  assert.equal(said(await search("gadgets")).provider, "parallel");
  assert.equal(await searches(), 3);
});

test("past a wait, a fresh 429 opens a new one; a 429 that names none holds 60 s; an HTTP-date Retry-After is read as the time it names", async (t) => {
  await t.test("a fresh 429 after the wait", async (t) => {
    const { env, searches } = await parallel(t, "429@1;429@1;ok");
    const search = await bindRun(env);
    assert.match(said(await search("widgets")).error, /answered 429$/);
    busy(await search("widgets"), 1, 1);
    await pause(1_500);
    assert.match(said(await search("widgets")).error, /answered 429$/, "past the wait the provider is asked, and limits again");
    busy(await search("widgets"), 1, 1);
    assert.equal(await searches(), 2);
    await pause(1_500);
    assert.equal(said(await search("widgets")).provider, "parallel");
    assert.equal(await searches(), 3);
  });
  await t.test("no Retry-After", async (t) => {
    const { env, searches } = await parallel(t, "429");
    const search = await bindRun(env);
    await search("widgets");
    busy(await search("widgets"), 59, 60);
    assert.equal(await searches(), 1);
  });
  await t.test("an HTTP date", async (t) => {
    const { env, searches } = await parallel(t, `429@${new Date(Date.now() + 30_000).toUTCString()}`);
    const search = await bindRun(env);
    await search("widgets");
    busy(await search("widgets"), 28, 30);
    assert.equal(await searches(), 1);
  });
});

test("the breaker read against a fake clock: a rate limit's wait passes at its end, a quota answer holds past any wait, and a silly Retry-After is cut to 15 minutes", () => {
  assert.equal(typeof webSearch.searchBreaker, "function", "the run's breaker, made with a clock");
  let now = Date.parse("2026-11-15T12:00:00Z");
  const fail = { error: "the provider's search failed" };
  const found = { provider: "parallel", query: "q", results: [] };
  const words = (held) => held?.error;
  const breaker = webSearch.searchBreaker(() => now);
  assert.equal(breaker.held(), undefined, "it starts closed");
  assert.deepEqual(breaker.read({ answer: fail, limit: { kind: "rate" } }), fail, "the call's own answer passes");
  assert.equal(words(breaker.held()), "search is busy; try again in 60 s, or answer from what you have");
  now += 59_500;
  assert.equal(words(breaker.held()), "search is busy; try again in 1 s, or answer from what you have", "rounded up, at least 1");
  now += 1_500;
  assert.equal(breaker.held(), undefined, "61 s on, the next call asks the provider");
  breaker.read({ answer: found });
  assert.equal(breaker.held(), undefined, "a success leaves it closed");
  // Quota beats a rate limit: off for the rest of the run, whatever wait passes.
  breaker.read({ answer: fail, limit: { kind: "quota" } });
  assert.equal(words(breaker.held()), UNAVAILABLE);
  now += 61_000;
  assert.equal(words(breaker.held()), UNAVAILABLE, "61 s on, still off");
  breaker.read({ answer: fail, limit: { kind: "rate", retryAfter: "1" } });
  now += 3_600_000;
  assert.equal(words(breaker.held()), UNAVAILABLE, "an hour on, still off");
  // Retry-After as the provider hands it back: seconds, an HTTP date, a number of seconds (Exa's), or words that read as none.
  for (const [retryAfter, n] of [["2", 2], [new Date(now + 90_000).toUTCString(), 90], [7, 7], ["86400", 900], ["soon", 60], [new Date(now + 3 * 86_400_000).toUTCString(), 900]]) {
    const one = webSearch.searchBreaker(() => now);
    one.read({ answer: fail, limit: { kind: "rate", retryAfter } });
    assert.equal(words(one.held()), `search is busy; try again in ${n} s, or answer from what you have`, String(retryAfter));
  }
  // A date already passed: no wait at all.
  const passed = webSearch.searchBreaker(() => now);
  passed.read({ answer: fail, limit: { kind: "rate", retryAfter: new Date(now - 10_000).toUTCString() } });
  assert.equal(passed.held(), undefined);
});

test("a search that succeeds, then one the provider rate-limits, then more: the provider is asked twice in all, and every call within the wait is busy", async (t) => {
  const { env, searches } = await exa(t, "ok,429");
  const search = await bindRun(env);
  const first = said(await search("widgets"));
  assert.equal(first.provider, "exa-keyless", JSON.stringify(first));
  assert.deepEqual(said(await search("gadgets")), { error: RATE_LIMITED });
  for (const query of ["widgets", "sprockets", "widgets delaware"]) busy(await search(query), 29, 30);
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
  const { env } = await parallel(t, "402");
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
  // The busy words read the same way.
  const { env: limited } = await parallel(t, "429");
  const held = await bindRun(limited);
  await held("widgets");
  const waiting = await held("widgets delaware");
  const n = busy(waiting, 59, 60);
  const words = `search is busy; try again in ${n} s, or answer from what you have`;
  assert.equal(waiting.text, JSON.stringify({ error: words }));
  assert.deepEqual(outcomeOf("web_search", { text: waiting.text, details: waiting.details, isError: waiting.isError }), { failed: true, text: `failed: ${words}` });
});
