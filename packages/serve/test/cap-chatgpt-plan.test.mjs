// A capped run on a person's ChatGPT plan. The plan's requests cost no dollars here (its own limits apply), so a dollar
// cap admits a run on a plan model, holds each plan request at $0, never limits its output and never wraps it up; what the
// run spends besides (a paid tool) counts against the cap as before, and stops it at the cap. The plan's own limit
// reached (its 429) ends the run in plain words: no retry, no key, no raise-the-cap prompt. OpenAI and Parallel are fakes
// in this process (the global fetch, which pi-ai's sign-in, the model proxy and the paid tools send with); nothing reaches
// the network.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MODEL_KEYS } from "../dist/model.js";
import * as cap from "@parcha/agentrun-kernel/kernel/cap";
import { capModelOf as capModelOfRoute } from "../dist/runner/adapter-run-spec.js";
import * as cliSpec from "../dist/runner/cli-run-spec.js";
import { bookedCapSpend } from "../dist/runner/metrics.js";
import { putSealedKey } from "../dist/server-keys.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import { follow, journalOf, serve, withEnv } from "./support.mjs";

const CODEX_FAKE = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CODEX_STAND_IN = { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [CODEX_FAKE], env: { FAKE_CODEX_MODEL: "responses" } }) };
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SEAL_KEY", "AGENTRUN_SERVE_DEFAULT_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "PARALLEL_API_KEY", ...MODEL_KEYS.map((row) => row.field)];
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CALLBACK = "http://127.0.0.1:1455/auth/callback";
const CLIENT = "fake-client";
const PLAN_ROW = "chatgpt:plan";
/** What a run whose plan reached its limit says, and nothing else. */
const PLAN_LIMIT = "Your ChatGPT plan's limit is reached. Manage usage in your ChatGPT settings, then run it again.";

const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwtOf = (claims) => [part({ alg: "none", typ: "JWT" }), part(claims), randomBytes(16).toString("base64url")].join(".");
const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

/** OpenAI's sign-in and Responses API, and Parallel's API (fixtures/faux-parallel.mjs), faked on the global fetch for the
 *  test. Each Responses request is kept, and answered as `o.answer` says: `{ call }` a function call to that tool, a
 *  `{ status, body }` that error answer, else text. */
function fakeOpenAI(t) {
  const real = globalThis.fetch;
  const o = { issued: [], responses: [], parallel: [], answer: () => ({}) };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.parallel.ai") {
      o.parallel.push(url.pathname);
      return fakeParallel(url, { headers: request.headers, body: await request.text() });
    }
    if (url.hostname !== "auth.openai.com" && url.hostname !== "api.openai.com") return real(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    if (url.href === "https://auth.openai.com/api/accounts/oauth/token") {
      const tokens = { access: jwtOf({ "https://api.openai.com/profile": { email: "person@example.com" }, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" }, jti: randomUUID() }), refresh: `fake-${randomBytes(16).toString("hex")}`, id: jwtOf({ email: "person@example.com" }) };
      o.issued.push(tokens);
      return Response.json({ access_token: tokens.access, refresh_token: tokens.refresh, id_token: tokens.id, expires_in: 3600, scope: SCOPE, token_type: "Bearer" });
    }
    if (url.href === "https://api.openai.com/v1/models" && request.method === "GET") return Response.json({ object: "list", data: ["gpt-6.1-sol", "gpt-6-luna"].map((id) => ({ id, object: "model" })) });
    if (url.href === "https://api.openai.com/v1/responses" && request.method === "POST") {
      const body = JSON.parse(text || "{}");
      o.responses.push(body);
      const answer = o.answer(body);
      if (answer.status) return Response.json(answer.body, { status: answer.status });
      const usage = { input_tokens: 120, output_tokens: 12, total_tokens: 132 };
      if (answer.call) {
        const n = o.responses.length;
        const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: answer.call, arguments: JSON.stringify(answer.args ?? {}), status: "completed" };
        return sse([
          { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage } },
        ]);
      }
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Forty-two.", annotations: [] }] };
      return sse([
        { type: "response.created", response: { id: "resp_t", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "Forty-two." },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_t", status: "completed", output: [item], usage } },
      ]);
    }
    return Response.json({ error: { message: "not served by the fake" } }, { status: 404 });
  };
  t.after(() => void (globalThis.fetch = real));
  return o;
}

/** The tool outputs a Responses request carries back (pi's and Codex's alike). */
const outputsIn = (body) => (Array.isArray(body.input) ? body.input.filter((item) => item?.type === "function_call_output").length : 0);
const offers = (body, name) => Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === name);

/** A server signed in to the fake plan, with Parallel's key; its api, data folder and runs. The sign-in is the row a
 *  finished sign-in leaves (chatgpt-plan.test.mjs walks the flow itself), sealed into the server's store: no sign-in's
 *  loopback callback port is taken, so this file runs beside any other. */
async function planServer(t) {
  withEnv(t, { ...CODEX_STAND_IN, PARALLEL_API_KEY: CANARY, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, [...MODEL_VARS, ...Object.keys(CODEX_STAND_IN)]);
  const openai = fakeOpenAI(t);
  const { api, data, store } = await serve(t, { faux: undefined });
  const issued = await (await globalThis.fetch("https://auth.openai.com/api/accounts/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code: "fake-code", code_verifier: "v", redirect_uri: CALLBACK, resource: "https://api.openai.com/v1" }) })).json();
  const credential = { type: "oauth", access: issued.access_token, refresh: issued.refresh_token, expires: Date.now() + 3_600_000, clientId: CLIENT, scopes: SCOPE.split(" ") };
  await putSealedKey(store, Buffer.from(process.env.AGENTRUN_SEAL_KEY, "base64"), PLAN_ROW, JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol", "gpt-6-luna"] }));
  assert.equal((await api("GET", "/settings/chatgpt")).body.state, "signed_in");
  let agents = 0;
  /** A capped run of a new agent on `harness`, followed to its end or its pause. */
  const run = async (harness, capUsd, definition = {}) => {
    const id = `${harness}-${(agents += 1)}`;
    const made = await api("POST", "/agents", { definition: { id, version: 1, name: id, instructions: "Answer.", skills: [], tools: [], model: "chatgpt/gpt-6.1-sol", ...(harness === "pi" ? {} : { harness }), ...definition } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const before = openai.responses.length;
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "What is six times seven?" }, max_cost_usd: capUsd });
    if (started.status !== 202) return { refused: started, asked: 0 };
    await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
    const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
    const journal = journalOf(data, started.body.run_id);
    return { runId: started.body.run_id, view, journal, asked: openai.responses.length - before };
  };
  return { api, openai, run };
}

const said = (done) => JSON.stringify(done.view?.error ?? done.refused?.body ?? done.view);
/** Each model request the run's booking held, and what it booked. */
const requests = (journal) => journal.filter((entry) => entry.kind === "runner.request" && entry.data?.charged_by === undefined).map((entry) => entry.data);
const turns = (journal) => journal.filter((entry) => entry.kind === "runner.turn" && entry.data?.billing === "plan").map((entry) => entry.data);

test("a capped codex run and a capped pi run on a ChatGPT plan model are admitted, run with no output limit and no wrap-up, and end with $0 counted against the cap; with a paid tool, only the tool counts, and the run stops at the cap", { timeout: 240_000 }, async (t) => {
  const { openai, run } = await planServer(t);
  openai.answer = () => ({});
  for (const harness of ["codex", "pi"]) {
    // A cap of a cent: a plan request is held at $0 whatever the cap, so it never refuses or limits one.
    const done = await run(harness, 0.01);
    assert.equal(done.view?.status, "completed", `${harness}: ${said(done)}`);
    assert.ok(done.asked > 0, `${harness} reached the plan`);
    const sent = openai.responses.slice(-done.asked);
    for (const body of sent) {
      assert.equal("max_output_tokens" in body, false, `${harness}: no output limit on a plan request`);
      assert.doesNotMatch(JSON.stringify(body.input), /Budget nearly spent/, `${harness}: no wrap-up note on the plan`);
    }
    const held = requests(done.journal);
    assert.ok(held.length > 0, `${harness} booked its requests`);
    for (const request of held) assert.equal(request.heldUsd, 0, `${harness}: a plan request is held at $0: ${JSON.stringify(request)}`);
    for (const turn of turns(done.journal)) assert.equal(turn.bookedUsd, 0, `${harness}: booked at $0: ${JSON.stringify(turn)}`);
    assert.equal(bookedCapSpend(done.journal), 0, `${harness}: the cap's spend is $0`);
  }

  // A paid tool on the plan: Parallel's searches, $0.001 each, under a cap of $0.0025. Two are sent and booked; the third
  // could not fit, so it is refused before it is sent and the run waits on a raise of its cap. The cap's spend is the two
  // searches alone: every plan request in the run counts $0.
  openai.answer = (body) => (offers(body, "web_search") && outputsIn(body) < 5 ? { call: "web_search", args: { query: `widgets ${outputsIn(body)}` } } : {});
  for (const harness of ["pi", "codex"]) {
    const searches = openai.parallel.length;
    const done = await run(harness, 0.0025, { tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } });
    assert.deepEqual([done.view?.status, done.view?.pending?.kind], ["input_required", "budget"], `${harness}: ${said(done)}`);
    assert.equal(openai.parallel.length - searches, 2, `${harness}: two searches reached Parallel, the third refused before it was sent`);
    assert.equal(bookedCapSpend(done.journal), 0.002, `${harness}: the cap's spend is the two searches`);
    for (const request of requests(done.journal)) assert.equal(request.heldUsd, 0, `${harness}: ${JSON.stringify(request)}`);
  }
});

// The server's limit on free-model requests (AGENTRUN_FREE_MODEL_REQUESTS, 60 by default) is for $0 catalog models alone:
// a ChatGPT plan's requests don't count. A Codex run on a plan makes 100 requests and more, and the plan has OpenAI's own
// usage limits (the 429 below). So a plan run past 60 requests runs on, on codex and on pi, capped or not; its paid
// searches count against its cap as before.
test("a plan run past 60 requests is not stopped by the free-model limit, on codex and on pi, capped or not", { timeout: 300_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_FREE_MODEL_REQUESTS"]);
  const { openai, run } = await planServer(t);
  const SEARCHES = 61;
  openai.answer = (body) => (offers(body, "web_search") && outputsIn(body) < SEARCHES ? { call: "web_search", args: { query: `widgets ${outputsIn(body)}` } } : {});
  for (const [harness, capUsd] of [["codex", undefined], ["pi", undefined], ["pi", 5]]) {
    const searches = openai.parallel.length;
    const done = await run(harness, capUsd, { tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } });
    assert.equal(done.view?.status, "completed", `${harness}: ${said(done)}`);
    assert.equal(done.asked, SEARCHES + 1, `${harness}: every request reached the plan, the 61st and 62nd included`);
    assert.equal(openai.parallel.length - searches, SEARCHES, `${harness}: each search was sent`);
    const held = requests(done.journal);
    assert.equal(held.length, SEARCHES + 1, `${harness}: each request booked`);
    assert.ok(held.every((request) => request.freeRequest === undefined && request.zeroPriced === undefined), `${harness}: none counted toward the limit: ${JSON.stringify(held.slice(0, 2))}`);
  }
});

// One plan rule for the cap: a CLI runner's plan model and pi's plan route are the same cap model, and neither is a free
// model, so the free-model limit counts neither.
test("a CLI runner's plan model and pi's plan route are one cap model, and no free model", () => {
  const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(typeof cliSpec.capModelOf, "function", "the CLI runners' cap model rule is exported, beside pi's");
  const cli = cliSpec.capModelOf("gpt-6.1-sol", "openai-responses", { cost: zeros, maxTokens: 128_000 }, false, true);
  const pi = capModelOfRoute({ model: "gpt-6.1-sol", provider: { api: "openai-responses", plan: true }, cost: zeros, unpriced: true, outputCeiling: 128_000 });
  assert.deepEqual(cli, pi);
  assert.deepEqual(cli, { id: "gpt-6.1-sol", api: "openai-responses", price: null, outputCeiling: 128_000, plan: true });
  assert.equal(typeof cap.freeModel, "function", "the kernel's free-model rule is exported");
  assert.deepEqual([cap.freeModel(cli), cap.freeModel(pi)], [false, false]);
  assert.equal(cap.freeModel({ ...cli, price: zeros }), false, "a plan's model is no free model, even at a $0 listing");
});

// (An unpriced model that is no plan's is still refused a cap: unpriced-said.test.mjs, a gateway default with no price.)
test("a plan's limit reached ends the run in plain words, with no retry and no raise-the-cap prompt", { timeout: 120_000 }, async (t) => {
  const { openai, run } = await planServer(t);
  for (const [harness, code] of [["codex", "usage_limit_exceeded"], ["pi", "subscription_sharing_usage_limit_exceeded"]]) {
    openai.answer = () => ({ status: 429, body: { error: { type: "usage_limit_reached", code, message: "The usage limit has been reached", plan_type: "plus" } } });
    const done = await run(harness, 0.5);
    assert.equal(done.view?.status, "failed", `${harness}: ${said(done)}`);
    assert.equal(done.view?.error?.message, PLAN_LIMIT, `${harness}: the run says why, in these words alone: ${said(done)}`);
    assert.equal(done.asked, 1, `${harness}: one request reached the plan, never asked again`);
    assert.equal(done.view?.pending ?? null, null, `${harness}: no raise-the-cap prompt`);
    assert.doesNotMatch(said(done), /Raise the cap|spend_cap_reached/, harness);
  }
});
