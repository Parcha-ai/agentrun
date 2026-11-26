// A server with no model key, signed in to a person's ChatGPT plan (OpenAI's Sign in with ChatGPT, through pi-ai's own
// flow), runs codex and pi on it. OpenAI is a fake in this process: the global fetch, which pi-ai's sign-in and the model
// proxy both send with, answers auth.openai.com and api.openai.com here (its token endpoint with rotating refresh tokens,
// its model list, its Responses API), and lets every other request through. Nothing reaches the network. Its sign-ins
// listen for the loopback callback on a loopback address of this process's own (loopback-callback-host.mjs, first).
import { CALLBACK_HOST } from "./loopback-callback-host.mjs";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { MODEL_KEYS } from "../dist/model.js";
import { storeOn } from "./store-helpers.mjs";
import { onPostgres } from "./store-target.mjs";
import { agent, follow, journalOf, serve, serverLog, withEnv } from "./support.mjs";

/** The store the cross-process tests share: SQLite, or Postgres with AGENTRUN_TEST_PG_URL set (store-target.mjs). */
const STORE_KIND = onPostgres ? "Postgres" : "SQLite";

const CODEX_FAKE = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CODEX_STAND_IN = { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [CODEX_FAKE], env: { FAKE_CODEX_MODEL: "responses" } }) };
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SEAL_KEY", "AGENTRUN_SERVE_DEFAULT_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", ...MODEL_KEYS.map((row) => row.field)];
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CALLBACK = "http://127.0.0.1:1455/auth/callback";
const CLIENT = "fake-client";
const PLAN_ROW = "chatgpt:plan";

/** A JWT-shaped token made at run time (no token literal in the source): OpenAI's claims for the person, no signature. */
const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwtOf = (claims) => [part({ alg: "none", typ: "JWT" }), part(claims), randomBytes(16).toString("base64url")].join(".");

/** OpenAI, faked on the global fetch for the test. `expiresIn`: the lifetime of the next tokens issued; `refuse`: the
 *  token endpoint refuses each refresh (invalid_grant). A spent refresh token sent again is `refresh_token_reused`.
 *  `revocationsOf(token)`: how many times `token` was sent to the revocation endpoint; `revokeStatus`: the status that
 *  endpoint answers (200); `revocationEndpoint`: where the discovery document says it is. `keys`: API keys (not plan
 *  tokens) the Responses API takes; `reply`: the text its answer says. A request to a host under `.invalid` is answered
 *  200 and kept in `offHost`, never sent. */
function fakeOpenAI(t) {
  const real = globalThis.fetch;
  const o = { expiresIn: 3600, refuse: false, issued: [], codes: 0, modelLists: 0, modelBearers: [], refreshes: 0, responses: [], other: [], revoked: [], live: new Set(), spent: new Set(), revokeStatus: 200, revocationEndpoint: "https://auth.openai.com/oauth/revoke", keys: new Set(), reply: "Forty-two.", offHost: [] };
  o.revocationsOf = (token) => o.revoked.filter((revoked) => revoked.token === token).length;
  const issue = () => {
    const tokens = { access: jwtOf({ "https://api.openai.com/profile": { email: "person@example.com" }, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" }, jti: randomUUID() }), refresh: `fake-${randomBytes(16).toString("hex")}`, id: jwtOf({ email: "person@example.com" }) };
    o.issued.push(tokens);
    o.live.add(tokens.refresh);
    // `scope`: the grant's scope when OpenAI grants less than was asked (SCOPE by default).
    return Response.json({ access_token: tokens.access, refresh_token: tokens.refresh, id_token: tokens.id, expires_in: o.expiresIn, scope: o.scope ?? SCOPE, token_type: "Bearer" });
  };
  const refused = (error) => Response.json({ error, error_description: "refused by the fake" }, { status: 400 });
  const liveAccess = (request) => o.issued.some((tokens) => request.headers.get("authorization") === `Bearer ${tokens.access}`) || [...o.keys].some((key) => request.headers.get("authorization") === `Bearer ${key}`);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname.endsWith(".invalid")) {
      o.offHost.push(`${request.method} ${url.href}`);
      return new Response(null, { status: 200 });
    }
    if (url.hostname !== "auth.openai.com" && url.hostname !== "api.openai.com") return real(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    if (url.href === "https://auth.openai.com/api/accounts/oauth/token") {
      const form = new URLSearchParams(text);
      if (form.get("resource") !== "https://api.openai.com/v1" || form.get("client_id") !== CLIENT) return refused("invalid_request");
      if (form.get("grant_type") === "authorization_code") {
        o.codes += 1;
        // `codeRefusal`: the code's exchange refused with this error code and status 403, as a workspace's policy does.
        if (o.codeRefusal) return Response.json({ error: o.codeRefusal, error_description: o.codeRefusalDescription ?? "refused by the fake" }, { status: 403 });
        // `holdCodes`: the code's exchange is never answered; it ends only when its sender aborts it.
        if (o.holdCodes) await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
        if (form.get("code") !== "fake-code" || form.get("redirect_uri") !== CALLBACK || !form.get("code_verifier")) return refused("invalid_grant");
        return issue();
      }
      if (form.get("grant_type") === "refresh_token") {
        o.refreshes += 1;
        const sent = form.get("refresh_token");
        if (o.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, o.refreshDelayMs));
        // `holdRefresh`: a promise the refresh waits on before it answers, so a test acts while it is out.
        if (o.holdRefresh) await o.holdRefresh;
        // `failNext`: the next refresh answered with that status (a fault at OpenAI), its token unspent. `dropNext`: the
        // next one's connection lost after it was sent, no answer read.
        if (o.failNext) {
          const status = o.failNext;
          o.failNext = 0;
          return Response.json({ error: "server_error" }, { status });
        }
        if (o.dropNext) {
          o.dropNext = false;
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
        }
        if (o.spent.has(sent)) return refused("refresh_token_reused");
        if (o.refuse || !o.live.has(sent)) return refused("invalid_grant");
        o.live.delete(sent);
        o.spent.add(sent);
        const issued = issue();
        // `answerDelayMs`: the refresh is done at OpenAI (the old token spent, the new pair issued) and its answer is late.
        if (o.answerDelayMs) await new Promise((resolve) => setTimeout(resolve, o.answerDelayMs));
        return issued;
      }
      return refused("unsupported_grant_type");
    }
    if (url.href === "https://auth.openai.com/.well-known/openid-configuration") return Response.json({ issuer: "https://auth.openai.com", revocation_endpoint: o.revocationEndpoint });
    if (url.href === "https://auth.openai.com/oauth/revoke") {
      const form = new URLSearchParams(text);
      o.revoked.push({ token: form.get("token"), hint: form.get("token_type_hint"), client: form.get("client_id") });
      // `holdRevoke`: a promise the revocation waits on before it answers, so a test acts while it is out.
      if (o.holdRevoke) await o.holdRevoke;
      if (o.revokeStatus !== 200) return Response.json({ error: "server_error" }, { status: o.revokeStatus });
      o.live.delete(form.get("token"));
      return new Response(null, { status: 200 });
    }
    if (url.href === "https://api.openai.com/v1/models" && request.method === "GET") {
      o.modelLists += 1;
      // `modelBearers`: the authorization each list was asked with.
      o.modelBearers.push(request.headers.get("authorization"));
      if (o.modelsDelayMs) await new Promise((resolve) => setTimeout(resolve, o.modelsDelayMs));
      // `holdModels`: a promise the model list waits on before it answers, so a test acts while it is out.
      if (o.holdModels) await o.holdModels;
      // `modelsStatus`: the list answered with that status (a fault at OpenAI), no list read.
      if (o.modelsStatus) return Response.json({ error: { message: "unavailable" } }, { status: o.modelsStatus });
      if (!liveAccess(request))return Response.json({ error: { message: "bad token" } }, { status: 401 });
      return Response.json({ object: "list", data: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "text-embedding-3-small"].map((id) => ({ id, object: "model" })) });
    }
    if (url.href === "https://api.openai.com/v1/responses" && request.method === "POST") {
      const body = JSON.parse(text || "{}");
      o.responses.push({ authorization: request.headers.get("authorization"), originator: request.headers.get("originator"), body });
      if (!liveAccess(request)) return Response.json({ error: { message: "bad token" } }, { status: 401 });
      // As OpenAI answered a live plan run of pi on 2026-11-15: sol takes no "none" effort (pi-ai's catalog: off is null).
      if (body.model === "gpt-6.1-sol" && body.reasoning?.effort === "none") {
        return Response.json({ error: { message: "Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'low', 'medium', 'high', 'xhigh'.", type: "invalid_request_error", param: "reasoning.effort", code: "unsupported_value" } }, { status: 400 });
      }
      // `holdResponse`: a promise the answer waits on, so a test acts while a run's request is out. `callOnce`: the next
      // answer calls this tool (one no agent has), so the run sends one more request after it.
      if (o.holdResponse) await o.holdResponse;
      const usage = { input_tokens: 120, output_tokens: 12, total_tokens: 132 };
      if (o.callOnce) {
        const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: o.callOnce, arguments: "{}", status: "completed" };
        o.callOnce = undefined;
        const called = [
          { type: "response.created", response: { id: "resp_0", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{}" },
          { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: "{}" },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: "response.completed", response: { id: "resp_0", status: "completed", output: [call], usage } },
        ];
        return new Response(called.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: o.reply, annotations: [] }] };
      const events = [
        { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: o.reply },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    o.other.push(`${request.method} ${url.href}`);
    return Response.json({ error: { message: "not served by the fake" } }, { status: 404 });
  };
  t.after(() => void (globalThis.fetch = real));
  return o;
}

/** The address the sign-in tab ends on, for the sign-in whose authorize link is `authorizeUrl`. */
const callbackFor = (authorizeUrl, { state = new URL(authorizeUrl).searchParams.get("state"), code = "fake-code" } = {}) => `${CALLBACK}?${new URLSearchParams({ code, scope: SCOPE, state, client_id: CLIENT })}`;

/** Every file under `dir`. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []));

/** A store's sealed keys and settings over Maps, as the store keeps them: a compare-and-set by the bytes, its clock
 *  `clock()` (this process's by default). `sealed` is the Map itself. */
function mapStore({ clock = () => Date.now() } = {}) {
  const sealed = new Map();
  const settings = new Map();
  const holds = (name, was) => sealed.has(name) && Buffer.from(sealed.get(name)).equals(Buffer.from(was));
  let held;
  return {
    sealed,
    /** The next get reads the row at once and answers only once the returned release is called. */
    holdNextGet: () => {
      let release;
      held = new Promise((resolve) => (release = resolve));
      return release;
    },
    sealedKeys: {
      get: async (name) => {
        const bytes = sealed.get(name);
        const hold = held;
        held = undefined;
        if (hold) await hold;
        return bytes;
      },
      put: async (name, bytes) => void sealed.set(name, bytes),
      replaceIf: async (name, was, bytes) => (holds(name, was) ? (sealed.set(name, bytes), true) : false),
      remove: async (name) => void sealed.delete(name),
      removeIf: async (name, was) => (holds(name, was) ? sealed.delete(name) : false),
      clock: async () => clock(),
    },
    settings: { putIfAbsent: async (key, value) => (settings.has(key) ? settings.get(key) : (settings.set(key, value), value)) },
  };
}

/** A sign-in as OpenAI's token endpoint (the fake) issues it, sealed as the row in `store`: its access token ending in
 *  `endsIn` ms, with `lease` when given. Its credential. */
async function seatRow(store, sealKey, endsIn = 3_600_000, lease = undefined) {
  const { putSealedKey } = await import("../dist/server-keys.js");
  const issued = await (await globalThis.fetch("https://auth.openai.com/api/accounts/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code: "fake-code", code_verifier: "v", redirect_uri: CALLBACK, resource: "https://api.openai.com/v1" }) })).json();
  const credential = { type: "oauth", access: issued.access_token, refresh: issued.refresh_token, expires: Date.now() + endsIn, clientId: CLIENT, scopes: SCOPE.split(" ") };
  await putSealedKey(store, sealKey, PLAN_ROW, JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"], ...(lease ? { lease } : {}) }));
  return credential;
}

/** Waits until `done()` holds, 5 s at most. */
async function until(done, what) {
  const end = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(`not within 5 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a server with no model key runs codex and pi on a person's ChatGPT plan: signed in through the API, billed to the plan, renewed once, refused in words when expired or signed out, no token anywhere", { timeout: 240_000 }, async (t) => {
  withEnv(t, { ...CODEX_STAND_IN }, [...MODEL_VARS, ...Object.keys(CODEX_STAND_IN)]);
  const openai = fakeOpenAI(t);
  const log = serverLog(t);
  const { api: send, data, store } = await serve(t, { faux: undefined });
  // Every answer the API gives, kept for the scan at the end.
  const answers = [];
  const api = async (...args) => {
    const answer = await send(...args);
    answers.push(JSON.stringify(answer.body ?? null));
    return answer;
  };
  const caps = async () => (await api("GET", "/capabilities")).body;
  const harness = (body, id) => body.harnesses.find((offer) => offer.id === id);

  // No key, no plan: nothing runs.
  assert.equal((await caps()).models.ready, false, "a server with no keys is not ready");
  assert.deepEqual((await api("GET", "/settings/chatgpt")).body, { state: "signed_out" });

  // Start, paste, finish. A start answers the link to open; a second start cancels the first, whose address is stale.
  const first = await api("POST", "/settings/chatgpt/sign-in");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const link = new URL(first.body.authorize_url);
  assert.equal(`${link.origin}${link.pathname}`, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(link.searchParams.get("agent_name_hint"), "AgentRun");
  assert.match(link.searchParams.get("ext_agent_host_id"), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.ok(Date.parse(first.body.expires_at) > Date.now() + 9 * 60_000, "a sign-in waits 10 minutes");
  // A read while it waits says until when, as the start did: a page reloaded meanwhile shows it.
  assert.deepEqual((await api("GET", "/settings/chatgpt")).body, { state: "pending", authorize_url: first.body.authorize_url, expires_at: first.body.expires_at });
  const second = await api("POST", "/settings/chatgpt/sign-in");
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(new URL(second.body.authorize_url).searchParams.get("ext_agent_host_id"), link.searchParams.get("ext_agent_host_id"), "one host id, kept");
  for (const [what, pasted] of [["not a URL", "the code"], ["another address", "https://example.com/auth/callback?code=fake-code"], ["the cancelled sign-in's", callbackFor(first.body.authorize_url)], ["one with no code", callbackFor(second.body.authorize_url).replace("code=fake-code&", "")]]) {
    const bad = await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: pasted });
    assert.equal(bad.status, 400, `${what}: ${JSON.stringify(bad.body)}`);
    assert.match(bad.body.error.message, /sign-in|address/i, `${what}, in words`);
  }
  assert.equal(openai.codes, 0, "no bad paste reached OpenAI");
  const finished = await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(second.body.authorize_url) });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.deepEqual(finished.body, { state: "signed_in", email: "person@example.com", plan: "plus", models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"] });
  const stale = await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(second.body.authorize_url) });
  assert.equal(stale.status, 400, `a sign-in finished is stale: ${JSON.stringify(stale.body)}`);

  // Ready on the plan alone: codex and pi on it by default, claude-agent needing a key.
  const signed = await caps();
  assert.equal(signed.models.ready, true, JSON.stringify(signed.models));
  assert.equal(signed.models.source, "chatgpt");
  assert.equal(signed.models.default, "chatgpt/gpt-6.1-sol");
  for (const id of ["codex", "pi"]) {
    assert.equal(harness(signed, id).available, true, `${id}: ${JSON.stringify(harness(signed, id))}`);
    assert.equal(harness(signed, id).default_model, "chatgpt/gpt-6.1-sol", id);
    assert.ok(harness(signed, id).models.includes("chatgpt/gpt-6-luna"), `${id} lists the plan's models`);
  }
  const claude = harness(signed, "claude-agent");
  assert.equal(claude.available, false, JSON.stringify(claude));
  assert.match(claude.reason, /key/i, "claude-agent needs a key, in words");

  /** A run of a new agent on `harness` (pi, or codex), followed to its end. */
  let agents = 0;
  const run = async (harnessId, extra = {}) => {
    const id = `${harnessId}-${(agents += 1)}`;
    assert.equal((await api("POST", "/agents", agent(id, harnessId === "pi" ? extra : { harness: harnessId, ...extra }))).status, 201);
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "What is six times seven?" } });
    if (started.status !== 202) return { refused: started };
    const { last } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
    return { runId: started.body.run_id, last, view: (await api("GET", `/runs/${started.body.run_id}`)).body };
  };
  const turnsOf = (runId) => journalOf(data, runId).filter((entry) => entry.kind === "runner.turn").map((entry) => entry.data);

  // A codex run and a pi run on the plan: the plan's bearer upstream, no output limit sent, booked to the plan at no price.
  const ran = [];
  for (const id of ["codex", "pi"]) {
    const before = openai.responses.length;
    const done = await run(id);
    assert.equal(done.last?.status, "completed", `${id}: ${JSON.stringify(done.view?.error ?? done.refused?.body)}`);
    ran.push(done.runId);
    const sent = openai.responses.slice(before);
    assert.ok(sent.length > 0, `${id} reached OpenAI's Responses API`);
    for (const request of sent) {
      assert.equal(request.authorization, `Bearer ${openai.issued[0].access}`, `${id} sends the plan's bearer`);
      assert.equal(request.body.model, "gpt-6.1-sol", id);
      assert.equal("max_output_tokens" in request.body, false, `${id}: no max_output_tokens on the plan`);
      assert.notEqual(request.body.reasoning?.effort, "none", `${id}: no "none" effort to a model whose catalog takes none (sol's off is null)`);
    }
    const turns = turnsOf(done.runId);
    assert.ok(turns.length > 0, `${id} booked its turns`);
    for (const turn of turns) {
      assert.equal(turn.billing, "plan", `${id}: ${JSON.stringify(turn)}`);
      assert.equal(turn.usd, null, `${id}: no price on the plan`);
      assert.ok(turn.usage?.input > 0, `${id} booked its tokens`);
    }
    // Its cost says what it used on the plan, and the plan's requests are not unpriced: its dollars are known.
    const cost = done.view.cost;
    const booked = turns.filter((turn) => turn.givenBack !== true && turn.unsent !== true);
    const tokens = booked.reduce((sum, turn) => sum + ["input", "output", "cacheRead", "cacheWrite"].reduce((n, key) => n + (turn.usage?.[key] ?? 0), 0), 0);
    assert.deepEqual(cost.plan, { requests: booked.length, tokens, on: "chatgpt" }, `${id}: ${JSON.stringify(cost)}`);
    assert.equal(typeof cost.usd, "number", `${id}: a plan run's dollars are known: ${JSON.stringify(cost)}`);
    assert.equal("unpriced" in cost, false, `${id}: ${JSON.stringify(cost)}`);
  }
  assert.ok(openai.responses.every((request) => request.originator === "agentrun"), "the plan's route names its originator");
  assert.deepEqual(openai.other, [], "no other OpenAI path is asked (no input-token count on the plan)");

  // A token within 5 minutes of its end is renewed once, however many requests want it at once.
  openai.expiresIn = 200;
  const again = await api("POST", "/settings/chatgpt/sign-in");
  assert.equal((await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(again.body.authorize_url) })).status, 200);
  openai.expiresIn = 3600;
  const refreshesBefore = openai.refreshes;
  const pair = await Promise.all([run("codex"), run("pi")]);
  for (const done of pair) assert.equal(done.last?.status, "completed", JSON.stringify(done.view?.error ?? done.refused?.body));
  ran.push(...pair.map((done) => done.runId));
  assert.equal(openai.refreshes - refreshesBefore, 1, "one refresh for both runs");
  assert.equal(openai.responses.at(-1).authorization, `Bearer ${openai.issued.at(-1).access}`, "on the renewed token");

  // A refused refresh marks the sign-in expired; the run fails in words, and nothing tries again.
  openai.expiresIn = 200;
  const third = await api("POST", "/settings/chatgpt/sign-in");
  assert.equal((await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(third.body.authorize_url) })).status, 200);
  openai.refuse = true;
  const [refreshes, responses] = [openai.refreshes, openai.responses.length];
  const expired = await run("codex");
  if (expired.runId) ran.push(expired.runId);
  const expiredWords = JSON.stringify(expired.view?.error ?? expired.refused?.body);
  assert.notEqual(expired.last?.status, "completed", expiredWords);
  assert.match(expiredWords, /ChatGPT sign-in expired/, "the run says why, in words");
  assert.equal(openai.refreshes - refreshes, 1, "one refresh tried, never again");
  assert.equal(openai.responses.length, responses, "nothing reached OpenAI on an expired sign-in");
  assert.equal((await api("GET", "/settings/chatgpt")).body.state, "expired");
  assert.equal((await caps()).models.ready, false, "an expired sign-in runs nothing");

  // Signing in again revoked each sign-in it replaced. Signing out revokes the session at OpenAI and removes the row,
  // saying OpenAI confirmed it; the next run says it is signed out.
  const refreshToken = openai.issued.at(-1).refresh;
  assert.equal(openai.revocationsOf(refreshToken), 0, "the sign-in in place is not revoked before its sign-out");
  const signedOut = await api("DELETE", "/settings/chatgpt");
  assert.equal(signedOut.status, 200, JSON.stringify(signedOut.body));
  assert.deepEqual(signedOut.body, { revoked: true });
  assert.deepEqual(openai.revoked.at(-1), { token: refreshToken, hint: "refresh_token", client: CLIENT });
  assert.equal(openai.revocationsOf(refreshToken), 1);
  assert.equal(await store.sealedKeys.get(PLAN_ROW), undefined, "the row is gone");
  assert.deepEqual((await api("GET", "/settings/chatgpt")).body, { state: "signed_out" });
  const out = await run("codex", { model: "chatgpt/gpt-6.1-sol" });
  if (out.runId) ran.push(out.runId);
  const outWords = JSON.stringify(out.view?.error ?? out.refused?.body);
  assert.notEqual(out.last?.status, "completed", outWords);
  assert.match(outWords, /not signed in to ChatGPT/, "the next run says signed out");

  // No token, in any form, in the log, a journal, a run's record, the capabilities, an answer, or a file in the clear.
  const tokens = openai.issued.flatMap((issued) => [issued.access, issued.refresh]);
  const forms = tokens.flatMap((token) => [token, Buffer.from(token).toString("base64"), Buffer.from(token).toString("hex")]);
  const where = { log: log.text(), answers: answers.join("\n"), capabilities: JSON.stringify(await caps()) };
  for (const runId of ran) {
    where[`journal ${runId}`] = JSON.stringify(journalOf(data, runId));
    where[`run ${runId}`] = JSON.stringify((await api("GET", `/runs/${runId}`)).body);
  }
  for (const [name, text] of Object.entries(where)) for (const form of forms) assert.ok(!text.includes(form), `${name} holds a token`);
  for (const file of filesUnder(data)) {
    const bytes = readFileSync(file);
    for (const form of forms) assert.ok(!bytes.includes(form), `${file} holds a token`);
  }
});

test("two readers of one sign-in renew it once; a refresh token spent elsewhere is refused for good, and the sign-in reads expired", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan, PlanUnavailable } = await import("../dist/chatgpt-plan.js");
  const { putSealedKey } = await import("../dist/server-keys.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  // A sign-in as the token endpoint issued it, its access token ending within the 5 minutes.
  const issuedNow = await (await globalThis.fetch("https://auth.openai.com/api/accounts/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code: "fake-code", code_verifier: "v", redirect_uri: CALLBACK, resource: "https://api.openai.com/v1" }) })).json();
  const row = (credential) => JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"] });
  const credential = { type: "oauth", access: issuedNow.access_token, refresh: issuedNow.refresh_token, expires: Date.now() + 60_000, clientId: CLIENT, scopes: SCOPE.split(" ") };
  await putSealedKey(store, sealKey, PLAN_ROW, row(credential));

  const [a, b] = [new ChatGPTPlan({ store, sealKey }), new ChatGPTPlan({ store, sealKey })];
  const [one, two] = await Promise.all([a.token(), b.token()]);
  assert.equal(openai.refreshes, 1, "one refresh for two readers");
  assert.equal(one, openai.issued.at(-1).access);
  assert.equal(two, one);
  assert.equal(await a.token(), one, "a renewed token is kept and sealed: no second refresh");
  assert.equal(openai.refreshes, 1);

  // OpenAI answered 401 to the token the row still holds: the next token renews it, once. A 401 to a token another reader
  // has since replaced renews nothing: the row's new one is sent.
  await a.refused(one);
  const renewed = await a.token();
  assert.equal(openai.refreshes, 2, "a refused token is renewed");
  assert.notEqual(renewed, one);
  await b.refused(one);
  assert.equal(await b.token(), renewed, "a 401 to a token already replaced sends the row's new one");
  assert.equal(openai.refreshes, 2, "and renews nothing");
  const spentRow = { ...credential, access: renewed, refresh: openai.issued.at(-2).refresh };

  // Another holder wrote back a row with the refresh token already spent: OpenAI refuses it for good (reused), and no
  // reader tries again.
  await putSealedKey(store, sealKey, PLAN_ROW, row(spentRow));
  await assert.rejects(a.token(), (error) => error instanceof PlanUnavailable && /expired/.test(error.message) && !error.message.includes(spentRow.refresh));
  assert.equal(openai.refreshes, 3);
  await assert.rejects(b.token(), PlanUnavailable);
  assert.equal(openai.refreshes, 3, "an expired sign-in is never refreshed again");
  assert.equal((await b.load()).view().state, "expired");
});

test(`a server and a runner in their own processes, on one ${STORE_KIND} store, renew an ended token once: one refresh at OpenAI, the same new token for both, and once more after a 401 both saw`, { timeout: 60_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  // Two processes: each its own store handle on the one store, and its own copy of the module (so no renewal in flight is
  // shared in memory: only the store can keep them to one).
  const { putSealedKey } = await import("../dist/server-keys.js");
  const [one, two] = await Promise.all([import("../dist/chatgpt-plan.js?process=server"), import("../dist/chatgpt-plan.js?process=runner")]);
  const clock = { now: Date.now() };
  const { store: serverStore, file } = await storeOn(t, { clock });
  const { store: runnerStore } = await storeOn(t, { clock, file, role: "runner" });
  const sealKey = randomBytes(32);

  const issuedNow = await (await globalThis.fetch("https://auth.openai.com/api/accounts/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code: "fake-code", code_verifier: "v", redirect_uri: CALLBACK, resource: "https://api.openai.com/v1" }) })).json();
  const credential = { type: "oauth", access: issuedNow.access_token, refresh: issuedNow.refresh_token, expires: Date.now() - 1_000, clientId: CLIENT, scopes: SCOPE.split(" ") };
  await putSealedKey(serverStore, sealKey, PLAN_ROW, JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"] }));

  // The token endpoint answers slowly, so both are asking while the first refresh is out.
  openai.refreshDelayMs = 300;
  const server = new one.ChatGPTPlan({ store: serverStore, sealKey });
  const runner = new two.ChatGPTPlan({ store: runnerStore, sealKey });
  const [fromServer, fromRunner] = await Promise.all([server.token(), runner.token()]);
  assert.equal(openai.refreshes, 1, "exactly one refresh at OpenAI for the two processes");
  assert.equal(fromServer, openai.issued.at(-1).access, "the server got the new token");
  assert.equal(fromRunner, fromServer, "the runner adopted the same pair");
  assert.equal(openai.spent.size, 1, "the old refresh token was spent once, never replayed");

  // OpenAI answered 401 to that token in both processes: the row is read again, and one of them renews it.
  await Promise.all([server.refused(fromServer), runner.refused(fromServer)]);
  const [again, againRunner] = await Promise.all([server.token(), runner.token()]);
  assert.equal(openai.refreshes, 2, "one more refresh for the two processes' 401s");
  assert.notEqual(again, fromServer);
  assert.equal(againRunner, again);
  assert.equal(await runner.token(), again, "kept: no third refresh");
  assert.equal(openai.refreshes, 2);
  assert.equal(server.view().state, "signed_in");
});

test(`the renewal lease across two processes on one ${STORE_KIND} store, on the store's clock: a live lease sends the current token at once, a lapsed one is taken over, one live on the store's clock is not whatever the reader's own clock says, a lost answer holds it to its end, a fault at OpenAI gives it back, and a sign-out mid-renewal stays`, { timeout: 60_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { putSealedKey } = await import("../dist/server-keys.js");
  const [one, two] = await Promise.all([import("../dist/chatgpt-plan.js?process=server-2"), import("../dist/chatgpt-plan.js?process=runner-2")]);
  // The store's clock (the database's on Postgres: here a test's, moved by hand on either), which stamps and judges a lease.
  const clock = { now: Date.now() };
  const { store: serverStore, file } = await storeOn(t, { clock });
  const { store: runnerStore } = await storeOn(t, { clock, file, role: "runner" });
  const sealKey = randomBytes(32);
  const signIn = async () => (await (await globalThis.fetch("https://auth.openai.com/api/accounts/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code: "fake-code", code_verifier: "v", redirect_uri: CALLBACK, resource: "https://api.openai.com/v1" }) })).json());
  /** A fresh sign-in sealed as the row, its access token ending in `endsIn` ms, with `lease` if given. */
  const seat = async (endsIn, lease) => {
    const issued = await signIn();
    const credential = { type: "oauth", access: issued.access_token, refresh: issued.refresh_token, expires: Date.now() + endsIn, clientId: CLIENT, scopes: SCOPE.split(" ") };
    await putSealedKey(serverStore, sealKey, PLAN_ROW, JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"], ...(lease ? { lease } : {}) }));
    return credential;
  };
  const allowed = new Set(["state", "email", "plan", "models", "authorize_url"]);
  const viewHidesLease = (plan) => {
    const view = plan.view();
    assert.deepEqual(Object.keys(view).filter((key) => !allowed.has(key)), [], "a view shows no lease");
    assert.doesNotMatch(JSON.stringify(view), /lease|holder|until/);
  };

  // Another holder is renewing, and the token has a minute left: sent at once, no refresh, no wait.
  let seated = await seat(60_000, { holder: "another", until: clock.now + 20_000 });
  const runner = new two.ChatGPTPlan({ store: runnerStore, sealKey });
  let started = Date.now();
  assert.equal(await runner.token(), seated.access, "a live lease and a token not yet ended: the current one is sent");
  assert.ok(Date.now() - started < 150, "without waiting for the lease");
  assert.equal(openai.refreshes, 0);
  viewHidesLease(await new one.ChatGPTPlan({ store: serverStore, sealKey }).load());

  // A holder that died mid-renewal left its lease, lapsed, on an ended token: the next reader takes it over, refreshes once.
  seated = await seat(-1_000, { holder: "crashed", until: clock.now - 1_000 });
  assert.equal(await runner.token(), openai.issued.at(-1).access, "a lapsed lease is taken over");
  assert.notEqual(openai.issued.at(-1).access, seated.access);
  assert.equal(openai.refreshes, 1, "one refresh");
  assert.equal(await new one.ChatGPTPlan({ store: serverStore, sealKey }).token(), openai.issued.at(-1).access, "the other process reads the new pair");
  assert.equal(openai.refreshes, 1);

  // A lease live on the store's clock, on an ended token, asked by a reader whose own clock runs 61 s ahead (past the
  // lease's end on its clock): it waits, never sends a refresh token another holder may be spending, until the store's
  // clock passes the lease's end; then it takes the lease over and refreshes once.
  seated = await seat(-1_000, { holder: "slow", until: clock.now + 20_000 });
  const ahead = new two.ChatGPTPlan({ store: runnerStore, sealKey, now: () => Date.now() + 61_000 });
  const asking = ahead.token();
  asking.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(openai.refreshes, 1, "a reader's own clock never lapses a lease the store's clock holds live");
  clock.now += 21_000;
  assert.equal(await asking, openai.issued.at(-1).access, "taken over once the store's clock is past its end");
  assert.notEqual(openai.issued.at(-1).access, seated.access);
  assert.equal(openai.refreshes, 2, "one refresh");

  // The refresh left and its answer was lost: the token may be spent, so the lease is held to its end. Another reader
  // sends the current token (a minute left) and does not send the refresh token again.
  seated = await seat(60_000);
  openai.dropNext = true;
  const server = new one.ChatGPTPlan({ store: serverStore, sealKey });
  const refreshesBefore = openai.refreshes;
  await assert.rejects(server.token(), (error) => error instanceof one.PlanUnavailable && /try again/.test(error.message));
  assert.equal(openai.refreshes, refreshesBefore + 1);
  assert.equal(await new two.ChatGPTPlan({ store: runnerStore, sealKey }).token(), seated.access, "a lease held after a lost answer: the current token is sent");
  assert.equal(openai.refreshes, refreshesBefore + 1, "and the refresh token is not sent again before the lease ends");
  viewHidesLease(await new one.ChatGPTPlan({ store: serverStore, sealKey }).load());
  // Once it has lapsed (the store's clock past its end), the lease is taken over: one more refresh.
  clock.now += 61_000;
  const later = new two.ChatGPTPlan({ store: runnerStore, sealKey });
  assert.equal(await later.token(), openai.issued.at(-1).access, "a held lease that lapsed is taken over");
  assert.equal(openai.refreshes, refreshesBefore + 2);

  // OpenAI answered 503: the token is unspent, so the lease is given back and the next reader refreshes at once.
  seated = await seat(60_000);
  openai.failNext = 503;
  await assert.rejects(new one.ChatGPTPlan({ store: serverStore, sealKey }).token(), (error) => error instanceof one.PlanUnavailable && /try again/.test(error.message));
  assert.equal(await new two.ChatGPTPlan({ store: runnerStore, sealKey }).token(), openai.issued.at(-1).access, "a fault at OpenAI gives the lease back");
  assert.notEqual(openai.issued.at(-1).access, seated.access);
  assert.equal(openai.refreshes, refreshesBefore + 4);

  // The owner signs out while a renewal is out: the row stays gone, whatever the renewal got. The refresh is held at
  // OpenAI until the sign-out is done, so the sign-out always lands while it is out (a sleep raced the refresh).
  await seat(-1_000);
  let release;
  openai.holdRefresh = new Promise((resolve) => { release = resolve; });
  const refreshesBeforeSignOut = openai.refreshes;
  const renewing = new two.ChatGPTPlan({ store: runnerStore, sealKey }).token();
  renewing.catch(() => undefined);
  try {
    await until(() => openai.refreshes > refreshesBeforeSignOut, "the renewal at OpenAI");
    await new one.ChatGPTPlan({ store: serverStore, sealKey }).signOut();
  } finally {
    openai.holdRefresh = undefined;
    release();
  }
  await assert.rejects(renewing, (error) => error instanceof two.PlanUnavailable && /not signed in/.test(error.message));
  assert.equal(await runnerStore.sealedKeys.get(PLAN_ROW), undefined, "the row stays gone");
  assert.equal(await serverStore.sealedKeys.get(PLAN_ROW), undefined);
  assert.equal((await new one.ChatGPTPlan({ store: serverStore, sealKey }).load()).view().state, "signed_out");
  await assert.rejects(new two.ChatGPTPlan({ store: runnerStore, sealKey }).token(), (error) => error instanceof two.PlanUnavailable && /not signed in/.test(error.message), "the next token() says signed out");
});

test("a sign-out while a saved sign-in still settles (its model list out) wins: the sign-in is revoked, the row stays gone", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const { sealed } = store;
  const plan = new ChatGPTPlan({ store, sealKey: randomBytes(32) });
  t.after(() => plan.close());
  // OpenAI's model list answers slowly: the sign-in is saved (keep) and its settle is still listing the plan's models.
  openai.modelsDelayMs = 500;
  const { authorize_url } = await plan.startSignIn();
  const finishing = plan.finishSignIn(callbackFor(authorize_url));
  finishing.catch(() => undefined);
  await until(() => openai.modelLists === 1, "the sign-in's code was exchanged, and its models are being listed");
  assert.equal(openai.codes, 1);
  await plan.signOut();
  await finishing.catch(() => undefined);
  assert.equal(sealed.get(PLAN_ROW), undefined, "the sign-out's removal stands: no sign-in row written after it");
  assert.equal(plan.view().state, "signed_out");
  assert.equal((await new ChatGPTPlan({ store, sealKey: randomBytes(32) }).load()).view().state, "signed_out");
  assert.ok(openai.revoked.some((revoked) => revoked.token === openai.issued.at(-1).refresh), "the dropped sign-in is revoked at OpenAI");
});

test("a server with no key says codex and pi run after a ChatGPT sign-in, and Claude Agent and OpenCode need a key; signed in they are ready, expired they say sign in again", { timeout: 120_000 }, async (t) => {
  withEnv(t, { ...CODEX_STAND_IN }, [...MODEL_VARS, ...Object.keys(CODEX_STAND_IN)]);
  const openai = fakeOpenAI(t);
  const { api } = await serve(t, { faux: undefined });
  const caps = async () => (await api("GET", "/capabilities")).body;
  const harness = (body, id) => body.harnesses.find((offer) => offer.id === id);
  const SIGN_IN = "or sign in with ChatGPT (Settings → Model keys) to run it on your ChatGPT plan";
  const AGAIN = "your ChatGPT sign-in expired: sign in again (Settings → Model keys)";

  // No key, not signed in: codex and pi name the sign-in, in words and in `needs`; the harnesses that need a key do not.
  const none = await caps();
  for (const id of ["codex", "pi"]) {
    const offer = harness(none, id);
    assert.equal(offer.default_model, null, `${id}: ${JSON.stringify(offer)}`);
    assert.ok(offer.reason?.includes(SIGN_IN), `${id} names the sign-in: ${JSON.stringify(offer)}`);
    assert.deepEqual(offer.needs, ["key", "chatgpt"], `${id}: ${JSON.stringify(offer)}`);
  }
  // Available means it runs: pi, whose adapter is built in, runs nothing with no model key and no sign-in, as codex.
  for (const id of ["codex", "pi"]) assert.equal(harness(none, id).available, false, `${id}: ${JSON.stringify(harness(none, id))}`);
  for (const id of ["claude-agent", "opencode"]) {
    const offer = harness(none, id);
    assert.doesNotMatch(offer.reason ?? "", /ChatGPT/, `${id} needs a key whatever the plan: ${JSON.stringify(offer)}`);
    assert.ok(!offer.needs?.includes("chatgpt"), `${id}: ${JSON.stringify(offer)}`);
  }
  assert.ok(harness(none, "claude-agent").needs?.includes("key"), JSON.stringify(harness(none, "claude-agent")));

  // Signed in: codex and pi ready, nothing more needed.
  openai.expiresIn = 200;
  const started = await api("POST", "/settings/chatgpt/sign-in");
  assert.equal((await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(started.body.authorize_url) })).status, 200);
  const signed = await caps();
  for (const id of ["codex", "pi"]) {
    const offer = harness(signed, id);
    assert.equal(offer.available, true, `${id}: ${JSON.stringify(offer)}`);
    assert.equal(offer.default_model, "chatgpt/gpt-6.1-sol", id);
    assert.equal(offer.reason, undefined, `${id}: ${JSON.stringify(offer)}`);
    assert.equal(offer.needs, undefined, `${id}: ${JSON.stringify(offer)}`);
  }
  assert.doesNotMatch(harness(signed, "claude-agent").reason ?? "", /ChatGPT/);

  // Expired (OpenAI refused its renewal at a run's start): codex and pi say to sign in again.
  openai.refuse = true;
  assert.equal((await api("POST", "/agents", agent("expiring", {}))).status, 201);
  const run = await api("POST", "/agents/expiring/runs", { input: { content: "Hi." } });
  if (run.status === 202) await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal((await api("GET", "/settings/chatgpt")).body.state, "expired");
  const expired = await caps();
  for (const id of ["codex", "pi"]) {
    const offer = harness(expired, id);
    assert.ok(offer.reason?.includes(AGAIN), `${id} says to sign in again: ${JSON.stringify(offer)}`);
    assert.ok(!offer.reason.includes(SIGN_IN), id);
    assert.deepEqual(offer.needs, ["key", "chatgpt"], `${id}: ${JSON.stringify(offer)}`);
  }
  assert.doesNotMatch(harness(expired, "claude-agent").reason ?? "", /ChatGPT/);
});

test("a server whose AGENT_MODEL names a key's model, with no key, offers no ChatGPT sign-in for it: signed in, codex and pi would still run AGENT_MODEL", { timeout: 60_000 }, async (t) => {
  withEnv(t, { ...CODEX_STAND_IN, AGENT_MODEL: "openai/gpt-6.1-sol" }, [...MODEL_VARS, ...Object.keys(CODEX_STAND_IN)]);
  fakeOpenAI(t);
  const { api } = await serve(t, { faux: undefined });
  const body = (await api("GET", "/capabilities")).body;
  for (const id of ["codex", "pi"]) {
    const offer = body.harnesses.find((each) => each.id === id);
    assert.deepEqual(offer.needs, ["key"], `${id}: ${JSON.stringify(offer)}`);
    assert.doesNotMatch(offer.reason ?? "", /ChatGPT/, `${id}: ${JSON.stringify(offer)}`);
  }
});

test("pi is available where a model it offers runs, not its default alone: AGENT_MODEL on OpenAI with no OpenAI key, and an Anthropic key, still runs pi on an Anthropic model", { timeout: 60_000 }, async (t) => {
  withEnv(t, { ...CODEX_STAND_IN, AGENT_MODEL: "openai/gpt-6.1-sol", ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` }, [...MODEL_VARS, ...Object.keys(CODEX_STAND_IN)]);
  const { api } = await serve(t, { faux: undefined });
  const pi = (await api("GET", "/capabilities")).body.harnesses.find((each) => each.id === "pi");
  assert.equal(pi.available, true, JSON.stringify(pi));
  assert.ok(pi.models.some((id) => id.startsWith("anthropic/")), JSON.stringify(pi));
  // Its default still lacks its key, and says so.
  assert.equal(pi.default_model, null, JSON.stringify(pi));
  assert.deepEqual(pi.needs, ["key"], JSON.stringify(pi));
});

test("a sign-out while a sign-in is finishing says revoked false when OpenAI doesn't confirm the dropped sign-in's revocation", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const plan = new ChatGPTPlan({ store, sealKey: randomBytes(32) });
  t.after(() => plan.close());
  openai.modelsDelayMs = 500;
  openai.revokeStatus = 503;
  const { authorize_url } = await plan.startSignIn();
  const finishing = plan.finishSignIn(callbackFor(authorize_url));
  finishing.catch(() => undefined);
  await until(() => openai.modelLists === 1, "the sign-in's code was exchanged, and its models are being listed");
  assert.equal(openai.codes, 1);
  const { revoked } = await plan.signOut();
  await finishing.catch(() => undefined);
  assert.equal(store.sealed.get(PLAN_ROW), undefined, "no sign-in row written after the sign-out");
  assert.equal(openai.revocationsOf(openai.issued.at(-1).refresh), 1, "the dropped sign-in's revocation was asked");
  assert.equal(revoked, false, "OpenAI didn't confirm it, so the sign-out doesn't say revoked");
  // The next sign-out, with nothing dropped and nothing signed in, is revoked again.
  openai.revokeStatus = 200;
  assert.deepEqual(await plan.signOut(), { revoked: true });
});

test("a sign-out while a renewal is out wins: the renewal's new pair is revoked at OpenAI and never handed out, and the sign-out says OpenAI's word is not the whole answer", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const [one, two] = await Promise.all([import("../dist/chatgpt-plan.js?process=signout-server"), import("../dist/chatgpt-plan.js?process=signout-runner")]);
  const store = mapStore();
  const sealKey = randomBytes(32);
  const first = await seatRow(store, sealKey, -1_000);
  // OpenAI has rotated the pair (the old refresh token spent, the new pair issued), and its answer is still on the way.
  openai.answerDelayMs = 400;
  const renewing = new two.ChatGPTPlan({ store, sealKey }).token();
  renewing.catch(() => undefined);
  await until(() => openai.refreshes === 1 && openai.issued.length === 2, "the renewal at OpenAI");
  const out = await new one.ChatGPTPlan({ store, sealKey }).signOut();
  assert.equal(store.sealed.get(PLAN_ROW), undefined, "the row is gone");
  await assert.rejects(renewing, (error) => error instanceof two.PlanUnavailable && /not signed in/.test(error.message), "the renewal that finished after the sign-out hands out no token");
  const renewed = openai.issued.at(-1);
  assert.notEqual(renewed.refresh, first.refresh);
  assert.equal(openai.revocationsOf(first.refresh), 1, "the sign-out revoked the refresh token it read");
  assert.equal(openai.revocationsOf(renewed.refresh), 1, "the renewal revoked the pair it could not write back");
  assert.equal(store.sealed.get(PLAN_ROW), undefined, "and wrote nothing");
  assert.deepEqual(out, { revoked: false }, "a renewal was out when it signed out: OpenAI's word on the token it read is not the whole answer");
});

test("a sign-out whose read a renewal's write-back overtakes revokes and removes the renewed pair, never leaving it sealed or unrevoked", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const [one, two] = await Promise.all([import("../dist/chatgpt-plan.js?process=overtaken-server"), import("../dist/chatgpt-plan.js?process=overtaken-runner")]);
  const store = mapStore();
  const sealKey = randomBytes(32);
  const first = await seatRow(store, sealKey, -1_000);
  openai.answerDelayMs = 200;
  const renewing = new two.ChatGPTPlan({ store, sealKey }).token();
  await until(() => openai.refreshes === 1, "the renewal at OpenAI");
  // The sign-out reads the row (the old pair, leased), and its read comes back only after the renewal wrote its pair.
  let late = renewing;
  const signingOut = { ...store, sealedKeys: { ...store.sealedKeys, get: async (name) => {
    const bytes = await store.sealedKeys.get(name);
    const wait = late;
    late = undefined;
    if (wait) await wait.catch(() => undefined);
    return bytes;
  } } };
  const out = await new one.ChatGPTPlan({ store: signingOut, sealKey }).signOut();
  const renewed = openai.issued.at(-1);
  assert.equal(await renewing, renewed.access, "the renewal wrote its pair back before the sign-out removed anything");
  assert.equal(store.sealed.get(PLAN_ROW), undefined, "the renewed row is removed too");
  assert.equal(openai.revocationsOf(renewed.refresh), 1, "and its refresh token revoked");
  assert.deepEqual(out, { revoked: true });
  assert.ok(openai.revocationsOf(first.refresh) <= 1);
});

test("a renewal whose write-back loses to a new sign-in revokes its own pair and sends the new sign-in's token", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  await seatRow(store, sealKey, -1_000);
  openai.answerDelayMs = 300;
  const renewing = new ChatGPTPlan({ store, sealKey }).token();
  await until(() => openai.refreshes === 1 && openai.issued.length === 2, "the renewal at OpenAI");
  const dropped = openai.issued.at(-1);
  // The owner signs in again (another process) while the renewal's answer is on its way.
  const again = await seatRow(store, sealKey);
  assert.equal(await renewing, again.access, "the new sign-in's token, never the dropped renewal's");
  assert.equal(openai.revocationsOf(dropped.refresh), 1, "the renewal's pair, dropped, is revoked");
  assert.equal(openai.revocationsOf(again.refresh), 0, "the new sign-in stays");
});

/** The row as `store` seals it, opened with `sealKey`: what a stop leaves for the next start. */
async function openRow(store, sealKey) {
  const { sealedAt, unsealColumn } = await import("../dist/store/seal.js");
  const bytes = store.sealed.get(PLAN_ROW);
  return bytes === undefined ? undefined : JSON.parse(unsealColumn(sealKey, sealedAt.sealedKey(PLAN_ROW), bytes).toString("utf8"));
}

/** Whether every pair live at OpenAI (its refresh token issued and neither spent nor revoked) is in `row`: its own, or
 *  one it carries to revoke (`retired`). */
const noneUnsaved = (openai, row) => [...openai.live].every((refresh) => row?.credential.refresh === refresh || (row?.retired ?? []).some((old) => old.refresh === refresh));

/** `plan` started as the server starts its own (server.ts): loaded, then what a stop left settled out of the way. */
const startOf = async (plan) => {
  await plan.load();
  plan.settleLeft();
  return plan;
};

test("a second sign-in takes the first's place and revokes it: the row then holds the second alone", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const plan = new ChatGPTPlan({ store, sealKey });
  t.after(() => plan.close());
  const signIn = async () => {
    const { authorize_url } = await plan.startSignIn();
    assert.equal((await plan.finishSignIn(callbackFor(authorize_url))).state, "signed_in");
    return openai.issued.at(-1);
  };
  const first = await signIn();
  assert.equal(openai.revoked.length, 0);
  const second = await signIn();
  assert.equal(openai.revocationsOf(first.refresh), 1, "the first sign-in is revoked");
  assert.equal(openai.revocationsOf(second.refresh), 0, "the second is kept");
  assert.equal(await plan.token(), second.access);
  const row = await openRow(store, sealKey);
  assert.equal(row.credential.refresh, second.refresh);
  assert.equal(row.retired, undefined, "the first, revoked, is no longer carried");
  assert.equal(row.unlisted, undefined);
  assert.deepEqual(row.models, ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"], "the plan's models, as OpenAI listed them");
});

test("a sign-in is saved as soon as OpenAI answers its code: cut off by a stop while its models are listed, no pair is live at OpenAI and saved nowhere, and the next start lists them and revokes the sign-in it replaced", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const plan = new ChatGPTPlan({ store, sealKey });
  let release;
  t.after(() => {
    release?.();
    return plan.close();
  });
  const { authorize_url } = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(authorize_url));
  const first = openai.issued.at(-1);
  // The second sign-in's model list never answers before the stop: the store is read as the stop leaves it.
  openai.holdModels = new Promise((resolve) => (release = resolve));
  const again = await plan.startSignIn();
  plan.finishSignIn(callbackFor(again.authorize_url)).catch(() => undefined);
  await until(() => openai.modelLists === 2, "the second sign-in's code was exchanged, and its models are being listed");
  const second = openai.issued.at(-1);
  const left = await openRow(store, sealKey);
  assert.equal(left?.credential.refresh, second.refresh, "the second sign-in is saved before its model list answers");
  assert.deepEqual((left.retired ?? []).map((old) => old.refresh), [first.refresh], "the first rides in the row until it is revoked");
  assert.ok(noneUnsaved(openai, left), "every pair live at OpenAI is in the row");
  // The next start: its models listed, the first revoked and dropped from the row.
  openai.holdModels = undefined;
  const next = await startOf(new ChatGPTPlan({ store, sealKey }));
  t.after(() => next.close());
  await until(() => openai.revocationsOf(first.refresh) === 1, "the next start revokes the sign-in the second replaced");
  await next.close();
  const settled = await openRow(store, sealKey);
  assert.equal(settled.credential.refresh, second.refresh);
  assert.equal(settled.retired, undefined);
  assert.equal(settled.unlisted, undefined);
  assert.equal(next.view().state, "signed_in");
  assert.deepEqual(next.view().models, ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);
});

test("a replaced sign-in whose revocation OpenAI doesn't confirm stays in the row: the next start revokes it again, and a sign-out revokes what the row carries", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const plan = new ChatGPTPlan({ store, sealKey });
  t.after(() => plan.close());
  const signIn = async () => {
    const { authorize_url } = await plan.startSignIn();
    assert.equal((await plan.finishSignIn(callbackFor(authorize_url))).state, "signed_in");
    return openai.issued.at(-1);
  };
  const first = await signIn();
  openai.revokeStatus = 503;
  const second = await signIn();
  assert.equal(openai.revocationsOf(first.refresh), 1, "asked once");
  assert.deepEqual((await openRow(store, sealKey)).retired.map((old) => old.refresh), [first.refresh], "unconfirmed: still carried");
  // The next start, with OpenAI answering again.
  openai.revokeStatus = 200;
  const next = await startOf(new ChatGPTPlan({ store, sealKey }));
  t.after(() => next.close());
  await until(() => openai.revocationsOf(first.refresh) === 2, "the next start revokes it again");
  await next.close();
  assert.equal((await openRow(store, sealKey)).retired, undefined, "confirmed: dropped");
  // A third sign-in whose replaced pair OpenAI doesn't confirm, then a sign-out: it revokes the row's pair and the one
  // it carries, and says revoked only once OpenAI confirmed both.
  openai.revokeStatus = 503;
  const third = await signIn();
  assert.deepEqual((await openRow(store, sealKey)).retired.map((old) => old.refresh), [second.refresh]);
  openai.revokeStatus = 200;
  assert.deepEqual(await plan.signOut(), { revoked: true });
  assert.equal(store.sealed.get(PLAN_ROW), undefined);
  assert.equal(openai.revocationsOf(third.refresh), 1);
  assert.equal(openai.revocationsOf(second.refresh), 2, "the carried pair is revoked by the sign-out");
  assert.equal(openai.live.size, 0, "nothing left alive at OpenAI");
});

/** A sign-in kept and cut off before it settled, sealed as the row in `store`: a new pair, its models unlisted, carrying
 *  `old` (retired). Its credential. */
async function seatUnsettled(store, sealKey, old, endsIn = 3_600_000) {
  const { putSealedKey } = await import("../dist/server-keys.js");
  const credential = await seatRow(store, sealKey, endsIn);
  await putSealedKey(store, sealKey, PLAN_ROW, JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"], unlisted: true, retired: [old] }));
  return credential;
}

test("a runner's reader of the plan (planReaderOf, at each claim) never settles what a sign-in left, though its store has settings: no model list, no revocation, the row untouched", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { planReaderOf } = await import("../dist/chatgpt-plan.js");
  // A runner's store is the whole Store: it has settings, as the server's does.
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  await seatUnsettled(store, sealKey, old);
  const before = Buffer.from(store.sealed.get(PLAN_ROW));
  const reader = await planReaderOf(store, sealKey);
  assert.equal(reader.view().state, "signed_in");
  // close() waits for a settle out: whatever this reader would settle is done once it resolves.
  await reader.close();
  assert.equal(openai.revocationsOf(old.refresh), 0, "a runner sends no refresh token to OpenAI's revocation endpoint");
  assert.equal(openai.modelLists, 0, "a runner lists no models");
  assert.ok(Buffer.from(store.sealed.get(PLAN_ROW)).equals(before), "the row is the server's to settle");
});

test("each pair the row carries joins the redaction list as it is read, as its own pair does", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  const current = await seatUnsettled(store, sealKey, old);
  const plan = new ChatGPTPlan({ store, sealKey });
  t.after(() => plan.close());
  const held = new Set();
  plan.watch((tokens) => tokens.forEach((token) => held.add(token)));
  await plan.load();
  for (const token of [current.access, current.refresh, old.access, old.refresh]) assert.ok(held.has(token), "held for redaction");
});

test("a sign-in whose models OpenAI doesn't list keeps the fallback list, still marked unlisted", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const plan = new ChatGPTPlan({ store, sealKey });
  t.after(() => plan.close());
  openai.modelsStatus = 503;
  const { authorize_url } = await plan.startSignIn();
  assert.equal((await plan.finishSignIn(callbackFor(authorize_url))).state, "signed_in");
  assert.equal(openai.modelLists, 1);
  const row = await openRow(store, sealKey);
  assert.equal(row.unlisted, true, "OpenAI's list was never read");
  assert.deepEqual(plan.view().models, row.models);
  // The next start lists them.
  openai.modelsStatus = 0;
  const next = await startOf(new ChatGPTPlan({ store, sealKey }));
  await next.close();
  const listed = await openRow(store, sealKey);
  assert.equal(listed.unlisted, undefined);
  assert.deepEqual(listed.models, ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);
});

test("a start's settle leaves a row under a live renewal lease alone: the renewal's write-back lands, and the pair the row carries stays for the next settle", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  // Its access token has ended: a reader renews it under a lease, held at OpenAI while the server starts.
  await seatUnsettled(store, sealKey, old, -1_000);
  let release;
  openai.holdRefresh = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const renewing = new ChatGPTPlan({ store, sealKey }).token();
  renewing.catch(() => undefined);
  await until(() => openai.refreshes === 1, "the renewal at OpenAI");
  assert.ok((await openRow(store, sealKey)).lease, "the row is leased");
  const leased = Buffer.from(store.sealed.get(PLAN_ROW));
  const server = await startOf(new ChatGPTPlan({ store, sealKey }));
  await server.close();
  assert.ok(Buffer.from(store.sealed.get(PLAN_ROW)).equals(leased), "a settle never writes over a live lease");
  assert.equal(openai.modelLists, 0, "nor sends the row's ended token to the list, nor waits on the renewal: the next settle lists");
  assert.equal(openai.refreshes, 1);
  openai.holdRefresh = undefined;
  release();
  const token = await renewing;
  const renewed = openai.issued.at(-1);
  assert.equal(token, renewed.access, "the renewal's write-back lands: its pair is handed out");
  const row = await openRow(store, sealKey);
  assert.equal(row.credential.refresh, renewed.refresh);
  assert.equal(row.lease, undefined);
  assert.deepEqual(row.retired.map((carried) => carried.refresh), [old.refresh], "still carried, for the next settle");
  assert.equal(row.unlisted, true);
  assert.equal(openai.revocationsOf(renewed.refresh), 0, "the renewed pair is not revoked");
});

test("a start never waits for its settle: while OpenAI holds a carried pair's revocation, the plan reads and hands out its token", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  const current = await seatUnsettled(store, sealKey, old);
  let release;
  openai.holdRevoke = new Promise((resolve) => (release = resolve));
  const plan = await startOf(new ChatGPTPlan({ store, sealKey }));
  t.after(() => {
    release();
    return plan.close();
  });
  await until(() => openai.revocationsOf(old.refresh) === 1, "the start's settle is revoking the carried pair");
  assert.equal(plan.view().state, "signed_in");
  assert.equal(await plan.token(), current.access);
  openai.holdRevoke = undefined;
  release();
  await plan.close();
  assert.equal((await openRow(store, sealKey)).retired, undefined, "then it settles");
});

test("a start's settle that lists the plan's models tells the server (its change callback), so offers made from the fallback list are made again; a start with nothing to settle tells nothing", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  await seatUnsettled(store, sealKey, old);
  let changes = 0;
  const changed = () => void (changes += 1);
  const plan = await startOf(new ChatGPTPlan({ store, sealKey, changed }));
  t.after(() => plan.close());
  await until(() => changes === 1, "the listed models told to the server");
  assert.equal((await openRow(store, sealKey)).unlisted, undefined);
  const quiet = await startOf(new ChatGPTPlan({ store, sealKey, changed }));
  await quiet.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(changes, 1, "nothing to settle: no change told");
});

test("a start's settle lists the plan's models only with a token OpenAI takes, and never renews one: an ended token is not sent to the list, its refresh token is not spent, and a stop right after leaves the sign-in whole", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  const stale = await seatUnsettled(store, sealKey, old, -1_000);
  // A stop right after the start: close() is the server's stop, and nothing the settle did may outlive it.
  const plan = await startOf(new ChatGPTPlan({ store, sealKey }));
  await plan.close();
  assert.equal(openai.refreshes, 0, "the settle never spends the refresh token: a renewal could outlast the stop and lose the pair");
  assert.equal(openai.modelLists, 0, "the ended token is never sent to the list");
  const row = await openRow(store, sealKey);
  assert.equal(row.credential.refresh, stale.refresh, "the sign-in is as it was");
  assert.ok(openai.live.has(stale.refresh), "its refresh token still live at OpenAI");
  assert.equal(row.unlisted, true, "the list waits for a settle whose token is fresh");
  assert.equal(row.retired, undefined, "the carried pair is revoked all the same");
  assert.equal(openai.revocationsOf(old.refresh), 1);
  // Once a reader renewed it (a run's token()), the next start lists with the fresh token.
  const renewed = await new ChatGPTPlan({ store, sealKey }).token();
  const next = await startOf(new ChatGPTPlan({ store, sealKey }));
  await next.close();
  assert.deepEqual(openai.modelBearers, [`Bearer ${renewed}`]);
  assert.equal((await openRow(store, sealKey)).unlisted, undefined);
});

test("the server's read of an unlisted sign-in a reader renewed lists its models then, not at the next start, with no renewal of its own; a listed row or a closed plan queues none", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  await seatUnsettled(store, sealKey, old, -1_000);
  let told = 0;
  // The plan's clock, moved past the minute between a read's settles so each check below fails for its own reason.
  let skew = 0;
  const plan = await startOf(new ChatGPTPlan({ store, sealKey, now: () => Date.now() + skew, changed: () => void (told += 1) }));
  await until(() => openai.revocationsOf(old.refresh) === 1, "the start's settle carried the old pair off");
  assert.equal(openai.modelLists, 0, "the start's token was ended: nothing listed");
  const renewed = await new ChatGPTPlan({ store, sealKey }).token();
  await plan.refresh();
  await until(() => openai.modelLists === 1, "the server's read queued a settle with the fresh token");
  await until(async () => (await openRow(store, sealKey)).unlisted === undefined, "the listed models written");
  await until(() => told >= 1, "and told to the server, so its offers are made again");
  assert.deepEqual(openai.modelBearers, [`Bearer ${renewed}`]);
  assert.equal(openai.refreshes, 1, "the reader's renewal alone: the read never renews");
  const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
  skew += 61_000;
  await plan.refresh();
  await pause();
  assert.equal(openai.modelLists, 1, "a listed row queues no settle");
  await seatUnsettled(store, sealKey, (await openRow(store, sealKey)).credential);
  await plan.refresh();
  await until(() => openai.modelLists === 2, "unlisted again and fresh, a read a minute on lists");
  await until(async () => (await openRow(store, sealKey)).unlisted === undefined, "and writes them");
  await pause();
  await seatUnsettled(store, sealKey, (await openRow(store, sealKey)).credential);
  await plan.refresh();
  await pause();
  assert.equal(openai.modelLists, 2, "within the minute, a read asks OpenAI no more, however often the console reads");
  skew += 61_000;
  await plan.close();
  await plan.refresh();
  await pause();
  assert.equal(openai.modelLists, 2, "after close(), a read queues no settle to outlive the stop");
});

test("close() waits for a start's settle to tell the server: not while the change callback it owes is out, at once after", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const old = await seatRow(store, sealKey);
  await seatUnsettled(store, sealKey, old);
  let release;
  let told = 0;
  const changed = () => {
    told += 1;
    return new Promise((resolve) => (release = resolve));
  };
  const plan = await startOf(new ChatGPTPlan({ store, sealKey, changed }));
  t.after(() => release?.());
  await until(() => told === 1, "the settle's listed models told to the server");
  let closed = false;
  const closing = plan.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, false, "the change callback is still out");
  release();
  await closing;
  assert.equal(closed, true);
});

test("a renewal whose write-back loses and whose pair OpenAI doesn't confirm revoked carries it in the row: no pair live and saved nowhere, and the next start revokes it", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  await seatRow(store, sealKey, -1_000);
  openai.answerDelayMs = 300;
  const renewing = new ChatGPTPlan({ store, sealKey }).token();
  await until(() => openai.refreshes === 1 && openai.issued.length === 2, "the renewal at OpenAI");
  const dropped = openai.issued.at(-1);
  // The owner signs in again (another process) while the renewal's answer is on its way; OpenAI then fails revocations.
  const again = await seatRow(store, sealKey);
  openai.revokeStatus = 503;
  assert.equal(await renewing, again.access, "the new sign-in's token, never the dropped renewal's");
  assert.equal(openai.revocationsOf(dropped.refresh), 1, "the dropped pair's revocation was asked");
  const row = await openRow(store, sealKey);
  assert.equal(row.credential.refresh, again.refresh, "the new sign-in stays the row's");
  assert.deepEqual((row.retired ?? []).map((old) => old.refresh), [dropped.refresh], "the unconfirmed pair rides in the row");
  assert.ok(noneUnsaved(openai, row), "every pair live at OpenAI is in the row");
  openai.revokeStatus = 200;
  const next = await startOf(new ChatGPTPlan({ store, sealKey }));
  await next.close();
  assert.equal(openai.revocationsOf(dropped.refresh), 2, "the next start revokes it again");
  assert.equal((await openRow(store, sealKey)).retired, undefined, "confirmed: dropped");
  assert.equal(openai.revocationsOf(again.refresh), 0, "the new sign-in stays");
});

test("a lost renewal's unconfirmed pair waits out another holder's live lease on the new row, then is carried: never written over the lease, never dropped", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { putSealedKey } = await import("../dist/server-keys.js");
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  await seatRow(store, sealKey, -1_000);
  openai.answerDelayMs = 300;
  const renewing = new ChatGPTPlan({ store, sealKey }).token();
  renewing.catch(() => undefined);
  await until(() => openai.refreshes === 1 && openai.issued.length === 2, "the renewal at OpenAI");
  const dropped = openai.issued.at(-1);
  // A new sign-in (another process), which a third holder is renewing under a live lease when the renewal's answer lands.
  const again = await seatRow(store, sealKey, 3_600_000, { holder: "another", until: Date.now() + 20_000 });
  const leased = Buffer.from(store.sealed.get(PLAN_ROW));
  openai.revokeStatus = 503;
  await until(() => openai.revocationsOf(dropped.refresh) === 1, "the dropped pair's revocation asked, and not confirmed");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(Buffer.from(store.sealed.get(PLAN_ROW)).equals(leased), "nothing written over the live lease");
  // The holder writes its row back, lease cleared: the pair is carried in it.
  await putSealedKey(store, sealKey, PLAN_ROW, JSON.stringify({ v: 1, state: "signed_in", credential: again, models: ["gpt-6.1-sol"] }));
  assert.equal(await renewing, again.access, "the new sign-in's token");
  const row = await openRow(store, sealKey);
  assert.equal(row.credential.refresh, again.refresh);
  assert.deepEqual((row.retired ?? []).map((old) => old.refresh), [dropped.refresh], "carried once the lease cleared");
  assert.ok(noneUnsaved(openai, row), "every pair live at OpenAI is in the row");
});

/** The browser's return to this machine: the sign-in tab, on its loopback callback. The page it shows. */
async function browserReturns(authorizeUrl, options) {
  const url = new URL(callbackFor(authorizeUrl, options));
  url.hostname = CALLBACK_HOST;
  const page = await fetch(url);
  return { status: page.status, text: await page.text() };
}

test("the browser's return on this machine finishes the sign-in by itself: no paste, signed in with the plan's models", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32) });
  t.after(() => plan.close());
  const { authorize_url } = await plan.startSignIn();
  assert.equal((await browserReturns(authorize_url)).status, 200);
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.equal(plan.view().state, "signed_in");
  assert.equal(openai.codes, 1);
});

test("through the server: the sign-in started on the API and finished by the browser's return reads signed in on the API", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  fakeOpenAI(t);
  const { api } = await serve(t, { faux: undefined });
  const started = await api("POST", "/settings/chatgpt/sign-in");
  assert.equal(started.status, 200);
  assert.equal((await browserReturns(started.body.authorize_url)).status, 200);
  // The browser's page answers before the code's exchange: the sign-in reads pending until that ends (the test's timeout
  // bounds it), then signed in.
  let view;
  while ((view = (await api("GET", "/settings/chatgpt")).body).state === "pending") await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.state, "signed_in", JSON.stringify(view));
});

test("a browser's return whose code OpenAI refuses says why, in the view and the log, instead of reading not signed in", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const logged = [];
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: (fields) => logged.push(fields) });
  t.after(() => plan.close());
  const { authorize_url } = await plan.startSignIn();
  // The tab says it is done (pi-ai's page, before the code is exchanged); OpenAI's token endpoint then refuses the code.
  assert.equal((await browserReturns(authorize_url, { code: "spent-code" })).status, 200);
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.equal(openai.codes, 1, "the code went to OpenAI");
  const view = plan.view();
  assert.equal(view.state, "signed_out");
  assert.match(view.problem ?? "", /OpenAI refused the sign-in/);
  assert.deepEqual(logged, [{ chatgpt: "sign_in_failed", reason: "token_400_invalid_grant" }]);
  assert.doesNotMatch(JSON.stringify(logged), /spent-code/, "no code in the log");
  // A new sign-in clears it.
  await plan.startSignIn();
  assert.equal(plan.view().problem, undefined);
});

/** A plan over a fresh store whose log lines land in `logged`, closed after the test. */
async function loggedPlan(t) {
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const logged = [];
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: (fields) => logged.push(fields) });
  t.after(() => plan.close());
  return { plan, logged };
}

/** The browser's return with OpenAI's `error` in place of a code, for the sign-in whose link is `authorizeUrl`. */
async function browserReturnsRefused(authorizeUrl, error) {
  const url = new URL(`${CALLBACK}?${new URLSearchParams({ error, state: new URL(authorizeUrl).searchParams.get("state") })}`);
  url.hostname = CALLBACK_HOST;
  const page = await fetch(url);
  await page.text();
  return page.status;
}

const ADMIN_OFF = /^Your ChatGPT workspace's admin has turned off open-source apps \(External access → OSS → Use ChatGPT plan\)/;
// Never that Free can't be used (OpenAI changes plan access): that it may be the reason. A refusal at the sign-in page in
// fixed words: its code is whatever reached the loopback, anyone's to choose.
const DID_NOT = "ChatGPT did not sign you in: a Free ChatGPT plan may be the reason; with a paid plan, start it again.";

test("a refusal's code that anything on this machine can send the loopback is logged, never shown: the view and a paste say fixed words", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { plan, logged } = await loggedPlan(t);
  const first = await plan.startSignIn();
  await browserReturnsRefused(first.authorize_url, "Call_admin_now");
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.equal(plan.view().problem, DID_NOT);
  assert.deepEqual(logged, [{ chatgpt: "sign_in_failed", reason: "authorize_Call_admin_now" }]);
  const second = await plan.startSignIn();
  const pasted = `${CALLBACK}?${new URLSearchParams({ error: "Call_admin_now", state: new URL(second.authorize_url).searchParams.get("state") })}`;
  await assert.rejects(plan.finishSignIn(pasted), (error) => error.message === DID_NOT);
});

test("a workspace's refusal wins over OpenAI's description naming the plan's scope: the admin's words", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { plan, logged } = await loggedPlan(t);
  openai.codeRefusal = "3p_delegated_access_policy_denied";
  openai.codeRefusalDescription = "Workspace policy does not allow chatgpt.tokens.use.direct";
  const { authorize_url } = await plan.startSignIn();
  await browserReturns(authorize_url);
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.match(plan.view().problem ?? "", ADMIN_OFF);
  assert.deepEqual(logged, [{ chatgpt: "sign_in_failed", reason: "token_403_3p_delegated_access_policy_denied" }]);
});

test("a workspace whose admin turned off open-source apps says so, whether OpenAI refuses at the sign-in page or at the code", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { plan, logged } = await loggedPlan(t);
  // OpenAI sends the browser back with its refusal.
  const first = await plan.startSignIn();
  await browserReturnsRefused(first.authorize_url, "3p_delegated_access_policy_denied");
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.match(plan.view().problem ?? "", ADMIN_OFF);
  assert.equal(openai.codes, 0, "no code to exchange");
  // OpenAI refuses the code's exchange with it.
  openai.codeRefusal = "3p_delegated_access_policy_denied";
  const second = await plan.startSignIn();
  await browserReturns(second.authorize_url);
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.match(plan.view().problem ?? "", ADMIN_OFF);
  assert.deepEqual(logged, [{ chatgpt: "sign_in_failed", reason: "authorize_3p_delegated_access_policy_denied" }, { chatgpt: "sign_in_failed", reason: "token_403_3p_delegated_access_policy_denied" }]);
  // A pasted address that carries the refusal is refused in the same words.
  const third = await plan.startSignIn();
  const pasted = `${CALLBACK}?${new URLSearchParams({ error: "3p_delegated_access_policy_denied", state: new URL(third.authorize_url).searchParams.get("state") })}`;
  await assert.rejects(plan.finishSignIn(pasted), (error) => ADMIN_OFF.test(error.message));
});

test("a ChatGPT plan that can't be used here says so: a grant without the plan's use, and every refusal that could be a Free plan's", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { plan, logged } = await loggedPlan(t);
  // OpenAI signs the account in but grants no use of its plan by apps.
  openai.scope = "openid profile email offline_access resource.invoke";
  const first = await plan.startSignIn();
  await browserReturns(first.authorize_url);
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.equal(plan.view().problem, "This ChatGPT plan can't be used here: OpenAI's sign-in gave AgentRun no use of it. Free plans usually can't; sign in with a paid one.");
  // A refusal at the sign-in page, or of the code, whose reason OpenAI does not name: it says what it knows.
  const second = await plan.startSignIn();
  await browserReturnsRefused(second.authorize_url, "access_denied");
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.equal(plan.view().problem, DID_NOT);
  openai.scope = undefined;
  const third = await plan.startSignIn();
  await browserReturns(third.authorize_url, { code: "spent-code" });
  await until(() => plan.view().state !== "pending", "the sign-in ends");
  assert.equal(plan.view().problem, "OpenAI refused the sign-in: a Free ChatGPT plan may be the reason; with a paid plan, start it again.");
  assert.deepEqual(logged.map((fields) => fields.reason), ["no_direct_scope", "authorize_access_denied", "token_400_invalid_grant"]);
});

test("a sign-in saved whose change callback then fails reads signed in, with no problem and no sign_in_failed; the change is owed and taken again at the server's next read (refresh) until it takes", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const logged = [];
  let fails = 2;
  let calls = 0;
  const changed = async () => {
    calls += 1;
    if (fails-- > 0) throw Object.assign(new Error("relist failed"), { code: "SQLITE_BUSY" });
  };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: (fields) => logged.push(fields), changed });
  t.after(() => plan.close());
  const { authorize_url } = await plan.startSignIn();
  assert.equal((await plan.finishSignIn(callbackFor(authorize_url))).state, "signed_in");
  assert.equal(plan.view().problem, undefined);
  assert.deepEqual(logged.map((fields) => fields.chatgpt), ["signed_in", "changed_failed"]);
  assert.equal(logged[1].reason, "SQLITE_BUSY");
  // The server's next read takes it again; failing again, it stays owed, said once.
  await plan.refresh();
  assert.equal(calls, 2);
  await plan.refresh();
  assert.equal(calls, 3, "taken at last");
  await plan.refresh();
  assert.equal(calls, 3, "nothing owed once it took");
  assert.equal(logged.length, 2);
});

test("reads at once take an owed change once: a second read waits for the change in flight instead of starting its own", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  let calls = 0;
  let release;
  const changed = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("relist failed"), { code: "SQLITE_BUSY" });
    await new Promise((resolve) => (release = resolve));
  };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: () => {}, changed });
  t.after(() => plan.close());
  const { authorize_url } = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(authorize_url));
  assert.equal(calls, 1, "owed");
  // Two reads (GET /capabilities and GET /settings/chatgpt, say) while the change is out: one change runs.
  let settled = 0;
  const reads = [plan.refresh(), plan.refresh()].map((read) => read.then(() => (settled += 1)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "one change in flight, not one per read");
  assert.equal(settled, 0, "each read waits for it");
  release();
  await Promise.all(reads);
  await plan.refresh();
  assert.equal(calls, 2, "taken: nothing owed");
});

test("a change callback that throws at once, not in a promise, is still taken again at the next read", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  let calls = 0;
  const changed = () => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error("relist failed"), { code: "SQLITE_BUSY" });
  };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: () => {}, changed });
  t.after(() => plan.close());
  const { authorize_url } = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(authorize_url));
  await plan.refresh();
  assert.equal(calls, 2, "taken again, and failed again");
  await plan.refresh();
  assert.equal(calls, 3, "a failed retry leaves no change in flight behind it");
  await plan.refresh();
  assert.equal(calls, 3, "taken: nothing owed");
});

test("a change that started before a later one failed does not clear it: the later sign-in's change is still owed", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  let calls = 0;
  let release;
  const changed = async () => {
    calls += 1;
    // 1: the first sign-in's change fails. 2: the read's retry, held. 3: the second sign-in's change fails.
    if (calls === 1 || calls === 3) throw Object.assign(new Error("relist failed"), { code: "SQLITE_BUSY" });
    if (calls === 2) await new Promise((resolve) => (release = resolve));
  };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: () => {}, changed });
  t.after(() => plan.close());
  const first = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(first.authorize_url));
  const retry = plan.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "the retry is out");
  const second = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(second.authorize_url));
  assert.equal(calls, 3, "the second sign-in's change failed");
  // The retry read the first sign-in: its success is not the second's.
  release();
  await retry;
  await plan.refresh();
  assert.equal(calls, 4, "the second sign-in's change is taken at the next read");
});

test("a change of state the server reads (another server signed out) is told once for reads at once", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  let calls = 0;
  let hold = false;
  const held = [];
  const changed = async () => {
    calls += 1;
    if (hold) await new Promise((resolve) => held.push(resolve));
  };
  const plan = new ChatGPTPlan({ store, sealKey, log: () => {}, changed });
  t.after(() => plan.close());
  const { authorize_url } = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(authorize_url));
  assert.equal(calls, 1);
  // Another server on the same store signs out: this one's reads see it.
  const other = new ChatGPTPlan({ store, sealKey });
  t.after(() => other.close());
  await other.signOut();
  hold = true;
  const reads = [plan.refresh(), plan.refresh(), plan.refresh()];
  while (!held.length) await new Promise((resolve) => setImmediate(resolve));
  hold = false;
  for (const resolve of held) resolve();
  await Promise.all(reads);
  assert.equal(calls, 2, "one change for three reads at once");
  assert.equal(plan.state, "signed_out");
});

test("a change of state the server reads whose change callback fails is owed, said, and taken at the next read", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const logged = [];
  let calls = 0;
  let fail = false;
  const changed = async () => {
    calls += 1;
    if (fail) throw Object.assign(new Error("relist failed"), { code: "SQLITE_BUSY" });
  };
  const plan = new ChatGPTPlan({ store, sealKey, log: (fields) => logged.push(fields), changed });
  t.after(() => plan.close());
  await plan.load();
  // Signed in by another server on the same store, and this server's change of it fails: it is owed, not lost.
  const other = new ChatGPTPlan({ store, sealKey });
  t.after(() => other.close());
  const { authorize_url } = await other.startSignIn();
  await other.finishSignIn(callbackFor(authorize_url));
  fail = true;
  await plan.refresh();
  assert.equal(calls, 1);
  assert.equal(plan.state, "signed_in");
  assert.deepEqual(logged, [{ chatgpt: "changed_failed", reason: "SQLITE_BUSY" }]);
  fail = false;
  await plan.refresh();
  assert.equal(calls, 2, "the failed change of state is taken at the next read");
  await plan.refresh();
  assert.equal(calls, 2, "and then nothing is owed");
});

test("a sign-out whose change callback fails still answers: the sign-in is gone, and the change is owed", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const logged = [];
  let calls = 0;
  const changed = async () => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("relist failed"), { code: "SQLITE_BUSY" });
  };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: (fields) => logged.push(fields), changed });
  t.after(() => plan.close());
  const { authorize_url } = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(authorize_url));
  assert.deepEqual(await plan.signOut(), { revoked: true });
  assert.equal(plan.state, "signed_out");
  assert.deepEqual(logged.map((fields) => fields.chatgpt), ["signed_in", "signed_out", "changed_failed"]);
  await plan.refresh();
  assert.equal(calls, 3, "taken at the next read");
});

// OpenAI shows a workspace's "open-source apps off" refusal on its own page and never sends the browser back, so the
// server can't tell it from a tab left open: a sign-in that waits names it first, as the likely cause.
const ADMIN_LIKELY = "If OpenAI's page showed an error instead of signing you in, your ChatGPT workspace's admin has likely turned off open-source apps (External access → OSS → Use ChatGPT plan): ask them to turn it on, or sign in with another account.";
const TIMED_OUT = `The sign-in timed out: OpenAI never sent the code back. ${ADMIN_LIKELY} Otherwise, start it again.`;
const STILL_WAITING = `OpenAI hasn't sent the code back yet. ${ADMIN_LIKELY}`;
// A code that did come back (the browser's return, or a paste), its exchange still out at the end: no admin guess.
const CUT_OFF = "The sign-in timed out while OpenAI was still answering its code: start it again.";

test("once a code is in (the browser's return or a paste), a sign-in whose exchange is slow shows no hint, and its timeout says the exchange was cut off, with no admin guess", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const clock = { now: Date.now() };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), now: () => clock.now });
  t.after(() => plan.close());
  openai.holdCodes = true;
  // The browser's return, past the first minute, its exchange held.
  const returned = await plan.startSignIn();
  assert.equal((await browserReturns(returned.authorize_url)).status, 200);
  await until(() => openai.codes === 1, "the code's exchange is out");
  clock.now += 61_000;
  assert.deepEqual(plan.view(), { state: "pending", authorize_url: returned.authorize_url, expires_at: returned.expires_at }, "no hint: the code came back");
  clock.now += 10 * 60_000;
  assert.deepEqual(plan.view(), { state: "signed_out", problem: CUT_OFF });
  // A paste, its exchange held: a view at once has no hint, and the paste's own answer at the end says the same as the view.
  const pasted = await plan.startSignIn();
  clock.now += 9 * 60_000;
  assert.equal(plan.view().hint, STILL_WAITING, "waiting, with no code yet");
  const late = plan.finishSignIn(callbackFor(pasted.authorize_url));
  late.catch(() => undefined);
  assert.equal(plan.view().hint, undefined, "the paste is a code in");
  await until(() => openai.codes === 2, "the code's exchange is out");
  clock.now += 60_000 + 1;
  assert.deepEqual(plan.view(), { state: "signed_out", problem: CUT_OFF });
  await assert.rejects(late, (error) => error.message === CUT_OFF);
});

test("a sign-in still waiting after its first minute says why it may be stuck, the workspace admin's open-source setting first, long before it times out", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const clock = { now: Date.now() };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), now: () => clock.now });
  t.after(() => plan.close());
  const { authorize_url, expires_at } = await plan.startSignIn();
  clock.now += 59_999;
  assert.deepEqual(plan.view(), { state: "pending", authorize_url, expires_at }, "no hint in its first minute");
  clock.now += 1;
  assert.deepEqual(plan.view(), { state: "pending", authorize_url, expires_at, hint: STILL_WAITING });
  // A new start waits its own minute first.
  await plan.startSignIn();
  assert.equal(plan.view().hint, undefined);
  // Its end says the same likely cause, first.
  clock.now += 10 * 60_000 + 1;
  assert.deepEqual(plan.view(), { state: "signed_out", problem: TIMED_OUT });
});

test("a sign-in whose code OpenAI answered never times out: saved, with the server's change still out at the 10 minutes, it reads signed in with no problem", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const logged = [];
  const clock = { now: Date.now() };
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let asked = false;
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: (fields) => logged.push(fields), now: () => clock.now, changed: async () => { asked = true; await held; } });
  t.after(() => { release(); plan.close(); });
  const { authorize_url } = await plan.startSignIn();
  assert.equal((await browserReturns(authorize_url)).status, 200);
  await until(() => asked, "the sign-in is saved and the server's change is out");
  assert.equal(plan.view().state, "signed_in", "saved: it reads signed in while the server's change is out");
  clock.now += 10 * 60_000 + 1;
  assert.equal(plan.view().problem, undefined, "no timeout once OpenAI answered");
  assert.equal(plan.view().state, "signed_in");
  release();
  await until(() => plan.view().state === "signed_in", "the sign-in ends signed in");
  assert.equal(plan.view().problem, undefined);
  assert.deepEqual(logged.map((fields) => fields.chatgpt), ["signed_in"]);
});

test("a sign-in that waits out its 10 minutes says it timed out, in the view and the log, whether a read or its timer ends it, its code's exchange cut off included; a cancel says nothing", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const logged = [];
  const clock = { now: Date.now() };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: (fields) => logged.push(fields), now: () => clock.now });
  t.after(() => plan.close());
  // A read past its end ends it.
  await plan.startSignIn();
  clock.now += 10 * 60_000 + 1;
  assert.deepEqual(plan.view(), { state: "signed_out", problem: TIMED_OUT });
  await plan.close();
  assert.deepEqual(logged, [{ chatgpt: "sign_in_failed", reason: "timed_out" }], "said once: the aborted login's end adds nothing");
  // Its timer ends it with no read.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await plan.startSignIn();
  assert.equal(plan.view().problem, undefined, "a new start clears it");
  t.mock.timers.tick(10 * 60_000);
  t.mock.timers.reset();
  assert.deepEqual(plan.view(), { state: "signed_out", problem: TIMED_OUT });
  assert.equal(logged.length, 2);
  // The browser returns just before the end, and its code's exchange is still out when the wait ends: the abort cuts it
  // off after the tab said the sign-in completed, and it says the exchange was cut off (no admin guess: a code came back).
  openai.holdCodes = true;
  const late = await plan.startSignIn();
  assert.equal((await browserReturns(late.authorize_url)).status, 200);
  await until(() => openai.codes === 1, "the code's exchange is out");
  clock.now += 10 * 60_000 + 1;
  assert.deepEqual(plan.view(), { state: "signed_out", problem: CUT_OFF });
  await plan.close();
  openai.holdCodes = false;
  assert.deepEqual(logged.map((fields) => fields.reason), ["timed_out", "timed_out", "timed_out"], "the cut-off exchange adds no line of its own");
  // A newer start, a sign-out and the server's close cancel one: no problem, no line.
  await plan.startSignIn();
  await plan.startSignIn();
  await plan.signOut();
  assert.equal(plan.view().problem, undefined);
  await plan.startSignIn();
  await plan.close();
  assert.equal(plan.view().problem, undefined);
  assert.deepEqual(logged.map((fields) => fields.chatgpt), ["sign_in_failed", "sign_in_failed", "sign_in_failed", "signed_out"]);
});

test("a paste whose code's exchange a sign-out or the 10 minutes cut off answers why, as the view does, never that the log says why", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const logged = [];
  const clock = { now: Date.now() };
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32), log: (fields) => logged.push(fields), now: () => clock.now });
  t.after(() => plan.close());
  openai.holdCodes = true;
  // A sign-out cuts it off: no line in the log, so the words point at none.
  const first = await plan.startSignIn();
  const cut = plan.finishSignIn(callbackFor(first.authorize_url));
  cut.catch(() => undefined);
  await until(() => openai.codes === 1, "the code's exchange is out");
  await plan.signOut();
  await assert.rejects(cut, (error) => error.message === "That sign-in was replaced or signed out: start it again.");
  // The 10 minutes cut it off: the paste says what the view says.
  const second = await plan.startSignIn();
  const late = plan.finishSignIn(callbackFor(second.authorize_url));
  late.catch(() => undefined);
  await until(() => openai.codes === 2, "the code's exchange is out");
  clock.now += 10 * 60_000 + 1;
  assert.deepEqual(plan.view(), { state: "signed_out", problem: CUT_OFF });
  await assert.rejects(late, (error) => error.message === CUT_OFF);
  assert.deepEqual(logged.map((fields) => fields.reason ?? fields.chatgpt), ["signed_out", "timed_out"]);
});

test("close() resolves only once a cancelled sign-in has ended: not while its model list is out, at once after it answers", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32) });
  let release;
  openai.holdModels = new Promise((resolve) => (release = resolve));
  t.after(() => {
    release();
    return plan.close();
  });
  const { authorize_url } = await plan.startSignIn();
  const finishing = plan.finishSignIn(callbackFor(authorize_url));
  finishing.catch(() => undefined);
  await until(() => openai.modelLists === 1, "the sign-in's code was exchanged, and its models are being listed");
  let closed = false;
  const closing = plan.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false, "the cancelled sign-in is still listing its models: close() has not resolved");
  release();
  await closing;
  assert.equal(closed, true);
});

test("a read of the row that a sign-in kept or a sign-out passed while it was out leaves the state they set", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const plan = new ChatGPTPlan({ store, sealKey: randomBytes(32) });
  t.after(() => plan.close());
  // A load reads no row; a sign-in is kept before it answers.
  let release = store.holdNextGet();
  const before = plan.load();
  const { authorize_url } = await plan.startSignIn();
  await plan.finishSignIn(callbackFor(authorize_url));
  assert.equal(plan.view().state, "signed_in");
  release();
  await before;
  assert.equal(plan.view().state, "signed_in", "the load that read no row before the sign-in does not sign it out");
  // A load and a token() read the signed-in row; a sign-out passes before they answer.
  for (const read of [() => plan.load(), () => plan.token()]) {
    if (plan.view().state !== "signed_in") {
      const again = await plan.startSignIn();
      await plan.finishSignIn(callbackFor(again.authorize_url));
    }
    release = store.holdNextGet();
    const out = read();
    await plan.signOut();
    assert.equal(plan.view().state, "signed_out");
    release();
    await out;
    assert.equal(plan.view().state, "signed_out", "the read of the row the sign-out removed does not sign it back in");
  }
});

test("reads of the row that overlap leave the newest one's state: a read that started first and answers last never signs back in a sign-in a later read found expired", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const { putSealedKey } = await import("../dist/server-keys.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const credential = await seatRow(store, sealKey);
  const plan = await new ChatGPTPlan({ store, sealKey }).load();
  t.after(() => plan.close());
  for (const read of [() => plan.load(), () => plan.token().catch(() => undefined)]) {
    await putSealedKey(store, sealKey, PLAN_ROW, JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"] }));
    await plan.load();
    assert.equal(plan.view().state, "signed_in");
    // The first read reads the signed-in row and answers only after a later read has answered.
    const release = store.holdNextGet();
    const first = read();
    // Another process on the store (a runner whose renewal OpenAI refused for good) marks the sign-in expired, and the
    // server's next read finds it.
    await putSealedKey(store, sealKey, PLAN_ROW, JSON.stringify({ v: 1, state: "expired", credential, models: ["gpt-6.1-sol"] }));
    await plan.load();
    assert.equal(plan.view().state, "expired");
    release();
    await first;
    assert.equal(plan.view().state, "expired", "the earlier read, answering last, does not put the signed-in row back");
  }
});

test("a sign-in waiting listens for its loopback callback on this test process's own loopback address (pi-ai's PI_OAUTH_CALLBACK_HOST), port 1455", { timeout: 30_000 }, async (t) => {
  fakeOpenAI(t);
  const { createConnection } = await import("node:net");
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  if (process.platform === "linux") assert.notEqual(CALLBACK_HOST, "127.0.0.1", "on Linux, a 127.x.y.z of its own");
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32) });
  t.after(() => plan.close());
  await plan.startSignIn();
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: CALLBACK_HOST, port: 1455 }, () => (socket.destroy(), resolve()));
    socket.once("error", reject);
  });
});

test("a sign-in waiting still listens while another process holds 127.0.0.1:1455 (a live sign-in, `codex login`)", { timeout: 30_000, skip: process.platform !== "linux" && "only Linux gives each process a loopback address of its own" }, async (t) => {
  fakeOpenAI(t);
  const { createServer, createConnection } = await import("node:net");
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  // Held here for the test; where something on this machine already holds it, that holds it just the same.
  const holder = createServer((socket) => socket.destroy());
  const held = await new Promise((resolve, reject) => {
    holder.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(false) : reject(error)));
    holder.listen(1455, "127.0.0.1", () => resolve(true));
  });
  if (held) t.after(() => new Promise((resolve) => holder.close(resolve)));
  const plan = new ChatGPTPlan({ store: mapStore(), sealKey: randomBytes(32) });
  t.after(() => plan.close());
  await plan.startSignIn();
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: CALLBACK_HOST, port: 1455 }, () => (socket.destroy(), resolve()));
    socket.once("error", reject);
  });
});

test("the plan's reader prints its state alone: util.inspect of a run's environment and of the reader shows no token, and revocation goes to auth.openai.com alone", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan, withPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const credential = await seatRow(store, sealKey);
  const plan = await new ChatGPTPlan({ store, sealKey }).load();
  await plan.refused(credential.access);
  const env = withPlan({ PATH: "/usr/bin" }, plan);
  const shown = [inspect(env, { depth: Infinity, showHidden: true }), inspect(plan, { depth: Infinity, showHidden: true }), JSON.stringify(plan), String(plan)].join("\n");
  for (const token of [credential.access, credential.refresh]) assert.ok(!shown.includes(token), `a token in: ${shown.slice(0, 400)}`);
  assert.ok(!shown.includes(sealKey.toString("hex")) && !shown.includes(sealKey.toString("base64")), "nor the seal key");
  assert.match(inspect(plan), /signed_in/, "its state is shown");

  // A discovery document that names a revocation endpoint on another host: the refresh token is never sent there.
  openai.revocationEndpoint = "https://revoke.example.invalid/oauth/revoke";
  assert.deepEqual(await plan.signOut(), { revoked: false });
  assert.deepEqual(openai.offHost, [], "nothing sent off auth.openai.com");
  assert.equal(store.sealed.get(PLAN_ROW), undefined, "signed out here all the same");
});

test("signing out through the API answers whether OpenAI confirmed the revocation, a waiting sign-in's cancel included; and an agent pinned to a key model runs on the key while signed in", { timeout: 240_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const openai = fakeOpenAI(t);
  const { api, data, store } = await serve(t, { faux: undefined });
  const signIn = async () => {
    const started = await api("POST", "/settings/chatgpt/sign-in");
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const finished = await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(started.body.authorize_url) });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    return openai.issued.at(-1);
  };

  // A sign-in waiting, cancelled: nothing was signed in, so nothing of it is left alive at OpenAI.
  assert.equal((await api("POST", "/settings/chatgpt/sign-in")).status, 200);
  const cancelled = await api("DELETE", "/settings/chatgpt");
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(cancelled.body, { revoked: true });
  assert.equal(openai.revoked.length, 0, "nothing to revoke");
  assert.deepEqual((await api("GET", "/settings/chatgpt")).body, { state: "signed_out" });

  // Signed in twice: the first is revoked as the second takes its place.
  const first = await signIn();
  const second = await signIn();
  assert.equal(openai.revocationsOf(first.refresh), 1, "the first sign-in is revoked");
  assert.equal(openai.revocationsOf(second.refresh), 0);

  // While signed in, an agent pinned to a key's model runs on that key; one that names no model stays on the plan.
  const key = "fake-test-key";
  openai.keys.add(key);
  const saved = await api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: key } });
  assert.equal(saved.status, 204, JSON.stringify(saved.body));
  const ranOn = async (id, extra) => {
    assert.equal((await api("POST", "/agents", agent(id, extra))).status, 201);
    const before = openai.responses.length;
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "What is six times seven?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { last } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
    const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
    assert.equal(last?.status, "completed", JSON.stringify(view?.error));
    const sent = openai.responses.slice(before);
    assert.ok(sent.length > 0, `${id} reached OpenAI`);
    return { sent, turns: journalOf(data, started.body.run_id).filter((entry) => entry.kind === "runner.turn").map((entry) => entry.data) };
  };
  const pinned = await ranOn("pinned-to-key", { model: "openai/gpt-6.1-sol" });
  for (const request of pinned.sent) assert.equal(request.authorization, `Bearer ${key}`, "the pinned agent sends the key, never the plan's token");
  for (const turn of pinned.turns) assert.notEqual(turn.billing, "plan", JSON.stringify(turn));
  const unpinned = await ranOn("on-the-plan");
  for (const request of unpinned.sent) assert.equal(request.authorization, `Bearer ${second.access}`, "an agent that names no model runs on the plan (codex and pi's default when signed in)");
  for (const turn of unpinned.turns) assert.equal(turn.billing, "plan", JSON.stringify(turn));

  // OpenAI fails the revocation: signed out here all the same, and the answer says what to do.
  openai.revokeStatus = 503;
  const unconfirmed = await api("DELETE", "/settings/chatgpt");
  assert.equal(unconfirmed.status, 200, JSON.stringify(unconfirmed.body));
  assert.deepEqual(unconfirmed.body, { revoked: false, message: "Signed out here. OpenAI didn't confirm the revocation: remove AgentRun in your ChatGPT settings." });
  assert.equal(openai.revocationsOf(second.refresh), 1, "the revocation was asked");
  assert.equal(await store.sealedKeys.get(PLAN_ROW), undefined, "the row is gone");
  assert.deepEqual((await api("GET", "/settings/chatgpt")).body, { state: "signed_out" });

  // Signed in and out again with OpenAI answering: confirmed.
  openai.revokeStatus = 200;
  const third = await signIn();
  const confirmed = await api("DELETE", "/settings/chatgpt");
  assert.deepEqual([confirmed.status, confirmed.body], [200, { revoked: true }]);
  assert.equal(openai.revocationsOf(third.refresh), 1);
});

test("the server's stop waits a short while for a sign-in past its code's exchange: one that ends in time is saved before the store closes, one that doesn't end never holds the stop", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const openai = fakeOpenAI(t);
  let release;
  openai.holdModels = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const finishing = async (server) => {
    const started = await server.api("POST", "/settings/chatgpt/sign-in");
    assert.equal(started.status, 200, JSON.stringify(started.body));
    // Its answer is cut off by the stop: what it says is not the test's.
    server.api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(started.body.authorize_url) }).catch(() => undefined);
  };
  // Its model list answers while the stop waits (a wait no test machine outruns, planCloseMs): the sign-in is kept, and
  // the next server reads it signed in.
  const first = await serve(t, { faux: undefined, runner: false, harnesses: false, planCloseMs: 600_000 });
  await finishing(first);
  await until(() => openai.modelLists === 1, "the sign-in's code was exchanged, and its models are being listed");
  let ended = false;
  const stopping = first.stop().then(() => (ended = true));
  // A floor only: a stop that waits is still waiting, however slow the machine.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ended, false, "the stop waits for the sign-in its model list holds");
  release();
  await stopping;
  const again = await serve(t, { data: first.data, faux: undefined, runner: false, harnesses: false, planCloseMs: 50 });
  assert.equal((await again.api("GET", "/settings/chatgpt")).body.state, "signed_in", "kept before the store closed");
  // Its model list never answers: the stop gives up on it after its wait, and ends (the test's timeout bounds it).
  openai.holdModels = new Promise((resolve) => (release = resolve));
  await finishing(again);
  await until(() => openai.modelLists === 2, "the second sign-in's models are being listed");
  await again.stop();
});

test("normal server shutdown releases a pending ChatGPT callback without signing out the saved plan", { timeout: 30_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const originalStart = ChatGPTPlan.prototype.startSignIn;
  let pendingOwner;
  t.mock.method(ChatGPTPlan.prototype, "startSignIn", function (...args) {
    pendingOwner = this;
    return originalStart.apply(this, args);
  });
  // Failure-only cleanup: the port-release assertion below must pass using normal server shutdown.
  // This keeps the causal negative control from leaking its intentionally unclosed listener.
  t.after(() => pendingOwner?.close());
  const first = await serve(t, { faux: undefined, runner: false, harnesses: false });
  const initial = await first.api("POST", "/settings/chatgpt/sign-in");
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal((await first.api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(initial.body.authorize_url) })).status, 200);
  const sealed = Buffer.from(await first.store.sealedKeys.get(PLAN_ROW));
  const pending = await first.api("POST", "/settings/chatgpt/sign-in");
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal((await first.api("GET", "/settings/chatgpt")).body.state, "pending");
  const callback = await fetch(`http://${CALLBACK_HOST}:1455/not-a-callback`);
  assert.equal(callback.status, 404, "the real callback listener is accepting requests before shutdown");
  await callback.text();

  await first.stop();
  // No polling or fixture cancellation: the just-stopped server must have released this exact listener.
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(1455, CALLBACK_HOST, resolve);
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  pendingOwner = undefined;
  assert.equal(openai.codes, 1, "the pending sign-in never exchanges a code");
  assert.deepEqual(openai.revoked, [], "shutdown is not sign-out");

  const again = await serve(t, { data: first.data, faux: undefined, harnesses: false });
  assert.deepEqual(Buffer.from(await again.store.sealedKeys.get(PLAN_ROW)), sealed, "the durable credential bytes survive shutdown and restart");
  assert.equal((await again.api("GET", "/settings/chatgpt")).body.state, "signed_in");
  assert.equal((await again.api("POST", "/agents", agent("after-shutdown"))).status, 201);
  const started = await again.api("POST", "/agents/after-shutdown/runs", { input: { content: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await follow(again.api, started.body.run_id, ["completed", "failed"])).last.status, "completed");
  assert.ok(openai.responses.length > 0, "an ordinary task still uses the saved plan through the fake provider");
  assert.equal(openai.refreshes, 0);assert.deepEqual(openai.revoked, []);
  await again.stop();
});

test("a stop waits for a renewal already spent at OpenAI to save its pair before the store closes, and starts no new one: the sign-in is never lost to the stop", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan, stopRenewals } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  let closed = false;
  const replaceIf = store.sealedKeys.replaceIf;
  store.sealedKeys.replaceIf = async (...args) => {
    if (closed) throw new (await import("../dist/store/index.js")).StoreClosed();
    return replaceIf(...args);
  };
  const sealKey = randomBytes(32);
  const stale = await seatRow(store, sealKey, -1_000);
  let release;
  openai.holdRefresh = new Promise((resolve) => (release = resolve));
  const plan = new ChatGPTPlan({ store, sealKey });
  const renewing = plan.token().catch((error) => error);
  await until(() => openai.refreshes === 1, "the renewal is out at OpenAI");
  // A store whose stop began (its process's, server or runner): no reader on it starts a renewal, whichever plan it is,
  // and none is out to wait for. A sign-in of its own, so it shares no renewal with the one out above.
  const other = mapStore();
  await seatRow(other, sealKey, -1_000);
  await stopRenewals(other);
  // Refused at once: a renewal started would wait on the refresh held above, and the race says so in its own words.
  let late;
  const atOnce = new Promise((_, reject) => (late = setTimeout(() => reject(new Error("a stopping store's token() did not answer at once")), 2_000)));
  await assert.rejects(Promise.race([new ChatGPTPlan({ store: other, sealKey }).token(), atOnce]).finally(() => clearTimeout(late)), /try again in a moment/, "a stopping store starts no renewal");
  assert.equal(openai.refreshes, 1, "and sends OpenAI nothing");
  // The drain is bounded: past its `ms` (RENEWAL_DRAIN_MS, 25 s, in a stop) it resolves with the renewal still out.
  let settled = false;
  renewing.then(() => (settled = true));
  const capped = Date.now();
  await stopRenewals(store, 50);
  assert.ok(Date.now() - capped < 1_000 && !settled, "a drain past its bound ends with the renewal still out");
  // This store's stop: its renewals stopped and the one out drained, then the store closed.
  let ended = false;
  const drained = stopRenewals(store).then(() => (ended = true));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ended, false, "the drain waits for the renewal OpenAI is answering");
  release();
  await drained;
  closed = true;
  assert.equal(typeof (await renewing), "string", "the renewal handed out its token");
  const row = await openRow(store, sealKey);
  assert.notEqual(row.credential.refresh, stale.refresh, "the new pair was saved before the store closed");
  assert.ok(openai.live.has(row.credential.refresh), "and it is live at OpenAI");
  assert.equal(openai.refreshes, 1);
});

test("a renewal's write-back that faults: refused unsent by a closed store, its pair is revoked; any other fault, the row is read back: the pair saved is kept, the lease still ours is written again, and only a read back that faults too leaves it unknown, said by its fault's class", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const { StoreBusy, StoreClosed, StoreDeadline } = await import("../dist/store/index.js");
  const { Unanswered } = await import("../dist/store/postgres/connection.js");
  const cases = [
    { what: "refused unsent, the store closed", fault: () => new StoreClosed(), saved: false, revoked: 1 },
    { what: "refused unsent, the store busy: the row is still our lease", fault: () => new StoreBusy("database is locked"), saved: true, revoked: 0 },
    { what: "past its deadline, written all the same", fault: () => new StoreDeadline(10_000), lands: true, saved: true, revoked: 0 },
    { what: "past its deadline, and the read back faults too", fault: () => new StoreDeadline(10_000), readFaults: true, saved: false, revoked: 0, unknown: "StoreDeadline" },
    // Postgres: a COMMIT unanswered lands after the read back has seen our lease, so the write again waits on its row lock
    // and loses to it. The row then holds the new pair: read once more, it is saved, never revoked.
    { what: "its commit unanswered, landing after the read back", fault: () => new Unanswered("its commit", 10_000), late: true, saved: true, revoked: 0 },
    // The write again refused unsent (the store closed) while the first may still land: kept, never revoked, unknown.
    { what: "its commit unanswered, then the write again refused unsent", fault: () => new Unanswered("its commit", 10_000), again: () => new StoreClosed(), saved: false, revoked: 0, unknown: "Unanswered" },
    // The first refused for sure (busy: nothing written), the write again refused unsent: no row holds the pair, revoked.
    { what: "refused unsent, the store busy, then the write again refused unsent", fault: () => new StoreBusy("database is locked"), again: () => new StoreClosed(), saved: false, revoked: 1 },
    // The write again loses, and the read once more faults: what the row holds is not known, so the pair is kept.
    { what: "its commit unanswered, the write again lost, and the read once more faults", fault: () => new Unanswered("its commit", 10_000), againLoses: true, rereadFaults: () => new StoreBusy("canceling statement due to lock timeout"), saved: false, revoked: 0, unknown: "StoreBusy" },
  ];
  for (const { what, fault, lands = false, late = false, again, againLoses = false, readFaults = false, rereadFaults, saved, revoked, unknown } of cases) {
    const store = mapStore();
    const sealKey = randomBytes(32);
    const stale = await seatRow(store, sealKey, -1_000);
    const { get, replaceIf } = store.sealedKeys;
    let writes = 0;
    let landing;
    // The lease's write lands; the write-back (the second) faults, having written (`lands`), not yet (`late`: it lands
    // once the next read has answered) or not at all; the write again (the third) faults with `again`.
    store.sealedKeys.replaceIf = async (...args) => {
      writes += 1;
      if (writes === 3 && again) throw again();
      if (writes === 3 && againLoses) return false;
      if (writes !== 2) return replaceIf(...args);
      if (lands) await replaceIf(...args);
      if (late) landing = args;
      throw fault();
    };
    store.sealedKeys.get = async (...args) => {
      if (readFaults && writes >= 2) throw fault();
      if (rereadFaults && writes >= 3) throw rereadFaults();
      const bytes = await get(...args);
      if (landing) {
        const commit = landing;
        landing = undefined;
        await replaceIf(...commit);
      }
      return bytes;
    };
    const logged = [];
    const before = openai.revoked.length;
    const answer = await new ChatGPTPlan({ store, sealKey, log: (fields) => logged.push(fields) }).token().catch((e) => e);
    const issued = openai.issued.at(-1);
    assert.equal(openai.revoked.slice(before).filter((r) => r.token === issued.refresh).length, revoked, `${what}: revoked`);
    store.sealedKeys.get = get;
    const row = await openRow(store, sealKey);
    if (saved) {
      assert.equal(answer, issued.access, `${what}: the renewed token is handed out`);
      assert.equal(row.credential.refresh, issued.refresh, `${what}: the row holds the new pair`);
      assert.equal(row.lease, undefined, `${what}: and no lease`);
    } else {
      assert.match(String(answer?.message), /try again in a moment/, `${what}: the caller is told to try again, not handed the store's fault`);
      assert.equal(row.credential.refresh, stale.refresh, `${what}: the row still holds the pair it had`);
    }
    if (unknown) assert.ok(logged.some((fields) => fields.chatgpt === "renewed_pair_unsaved" && fields.write === "unknown" && fields.reason === unknown), `${what}: ${JSON.stringify(logged)}`);
    else assert.ok(!logged.some((fields) => fields.write === "unknown"), `${what}: ${JSON.stringify(logged)}`);
  }
});

test("a renewal whose write-back finds another sign-in in the row revokes its pair and takes that sign-in; at a stop, one OpenAI didn't confirm revoked is not carried past another holder's lease, and the log says why", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan, stopRenewals } = await import("../dist/chatgpt-plan.js");
  const { StoreBusy } = await import("../dist/store/index.js");
  for (const stop of [false, true]) {
    const where = stop ? "at a stop" : "read back";
    const store = mapStore();
    const sealKey = randomBytes(32);
    await seatRow(store, sealKey, -1_000);
    const { replaceIf } = store.sealedKeys;
    let writes = 0;
    let renewal;
    let other;
    // The write-back (the second write): the owner signed in again meanwhile. Read back: it faults busy, and the row read
    // back is neither our pair nor our lease. At a stop: another holder renewing that sign-in holds its lease, the stop
    // begins, and the write-back loses its compare-and-set; OpenAI answers the revocation with a fault.
    store.sealedKeys.replaceIf = async (...args) => {
      writes += 1;
      if (writes !== 2) return replaceIf(...args);
      renewal = openai.issued.at(-1);
      other = await seatRow(store, sealKey, 3_600_000, stop ? { holder: "another", until: Date.now() + 20_000 } : undefined);
      if (!stop) throw new StoreBusy("database is locked");
      openai.revokeStatus = 500;
      void stopRenewals(store);
      return replaceIf(...args);
    };
    const logged = [];
    const started = Date.now();
    const answer = await new ChatGPTPlan({ store, sealKey, log: (fields) => logged.push(fields) }).token().catch((e) => e);
    openai.revokeStatus = 200;
    assert.equal(openai.revocationsOf(renewal.refresh), 1, `${where}: the renewal's pair is revoked`);
    assert.equal(answer, other.access, `${where}: the sign-in in the row is handed out`);
    const row = await openRow(store, sealKey);
    assert.equal(row.credential.refresh, other.refresh, `${where}: the row keeps the other sign-in`);
    if (stop) {
      assert.ok(Date.now() - started < 5_000, `${where}: the carry gives up at once, not after the other's lease`);
      assert.equal(row.retired, undefined, `${where}: nothing carried past the other holder's lease`);
      assert.ok(logged.some((fields) => fields.chatgpt === "renewed_pair_unsaved" && fields.carry === "stopping"), `${where}: ${JSON.stringify(logged)}`);
    } else assert.ok(!logged.some((fields) => fields.chatgpt === "renewed_pair_unsaved"), `${where}: ${JSON.stringify(logged)}`);
  }
});

test("a stop that lands while a renewal takes its lease sends OpenAI nothing: the lease is given back and the caller told to try again", { timeout: 30_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const store = mapStore();
  const sealKey = randomBytes(32);
  const stale = await seatRow(store, sealKey, -1_000);
  const replaceIf = store.sealedKeys.replaceIf;
  let release;
  let leasing = false;
  const held = new Promise((resolve) => (release = resolve));
  // The lease's write is held; everything after it is the store's own.
  store.sealedKeys.replaceIf = async (...args) => {
    store.sealedKeys.replaceIf = replaceIf;
    leasing = true;
    await held;
    return replaceIf(...args);
  };
  const plan = new ChatGPTPlan({ store, sealKey });
  const renewing = plan.token().catch((error) => error);
  await until(() => leasing, "the lease's write is out");
  const closed = plan.close();
  release();
  assert.match(String((await renewing)?.message), /try again in a moment/);
  await closed;
  assert.equal(openai.refreshes, 0, "the refresh token is never sent past the stop");
  const row = await openRow(store, sealKey);
  assert.equal(row.lease, undefined, "the lease is given back");
  assert.equal(row.credential.refresh, stale.refresh);
});

/** Each ChatGPTPlan loaded from here on (a server's at its start, a runner's reader at a claim), in order. */
function loadedPlans(t, ChatGPTPlan) {
  const plans = [];
  const load = ChatGPTPlan.prototype.load;
  t.mock.method(ChatGPTPlan.prototype, "load", function (...args) {
    plans.push(this);
    return load.apply(this, args);
  });
  return plans;
}

/** `api`'s server signed in to the fake OpenAI through its API. */
async function signedIn(api) {
  const started = await api("POST", "/settings/chatgpt/sign-in");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const finished = await api("POST", "/settings/chatgpt/sign-in/finish", { redirect_url: callbackFor(started.body.authorize_url) });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
}

test("a server alone (no runner beside it) bounds its stop past a renewal's drain, and waits for a renewal of its own OpenAI is answering before its store closes: the pair is saved, never revoked", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan, RENEWAL_DRAIN_MS } = await import("../dist/chatgpt-plan.js");
  const plans = loadedPlans(t, ChatGPTPlan);
  const server = await serve(t, { faux: undefined, runner: false, harnesses: false });
  const own = plans.at(-1);
  assert.equal(server.stopping().boundMs, 0, "signed out: no renewal for its stop to wait on");
  openai.expiresIn = 200;
  await signedIn(server.api);
  openai.expiresIn = 3600;
  // The CLI's stop exits DEADLINE_MARGIN_MS (15 s) past this bound: a bound of 0 cuts a 25 s drain short.
  assert.ok(server.stopping().boundMs >= RENEWAL_DRAIN_MS, `signed in: its stop's bound holds a renewal's drain (${server.stopping().boundMs} ms)`);
  let release;
  openai.holdRefresh = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const renewing = own.token().catch((error) => error);
  await until(() => openai.refreshes === 1, "the server's renewal is out at OpenAI");
  let ended = false;
  const stopped = server.stop().then(() => (ended = true));
  // A floor only: a stop that waits is still waiting, however slow the machine.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ended, false, "the stop waits for the renewal OpenAI is answering");
  release();
  await stopped;
  assert.equal(typeof (await renewing), "string", "the renewal handed out its token");
  const issued = openai.issued.at(-1);
  assert.equal(openai.revocationsOf(issued.refresh), 0, "the pair OpenAI issued is never revoked");
  // Saved before the store closed: the next server sends it as it is, renewing nothing.
  await serve(t, { data: server.data, faux: undefined, runner: false, harnesses: false });
  assert.equal(await plans.at(-1).token(), issued.access);
  assert.equal(openai.refreshes, 1);
});

test("a runner's stop, beside the server or in a process of its own, waits for a renewal on its own store that OpenAI is answering before the store closes: the pair is saved, never revoked", { timeout: 180_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const openai = fakeOpenAI(t);
  const { ChatGPTPlan } = await import("../dist/chatgpt-plan.js");
  const { runnerBeside } = await import("../dist/runner/beside.js");
  const { startRunnerProcess } = await import("../dist/runner/main.js");
  const plans = loadedPlans(t, ChatGPTPlan);
  const starts = [["beside", (data) => runnerBeside(data, { drainMs: 100 })], ["own-process", (data) => startRunnerProcess({ dataDir: data, drainMs: 100, warn: () => {} })]];
  for (const [where, start] of starts) {
    const server = await serve(t, { faux: undefined, runner: false, harnesses: false });
    const own = plans.at(-1);
    await signedIn(server.api);
    const runner = await start(server.data);
    let closing;
    const close = () => (closing ??= runner.close());
    t.after(close);
    // A run on the plan: its claim reads the sign-in through a reader of the runner's own, on the runner's store.
    const before = plans.length;
    assert.equal((await server.api("POST", "/agents", agent(`plan-${where}`))).status, 201);
    const started = await server.api("POST", `/agents/plan-${where}/runs`, { input: { content: "What is six times seven?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal((await follow(server.api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 })).last.status, "completed", where);
    assert.ok(plans.length > before, `${where}: its claim read the plan on the runner's store`);
    const reader = plans.at(-1);
    // Signed in again, near its end: the runner's reader renews it, at no run's request.
    openai.expiresIn = 200;
    await signedIn(server.api);
    openai.expiresIn = 3600;
    const refreshes = openai.refreshes;
    let release;
    openai.holdRefresh = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    const renewing = reader.token().catch((error) => error);
    await until(() => openai.refreshes === refreshes + 1, `${where}: the runner's renewal is out at OpenAI`);
    let ended = false;
    const stopped = close().then(() => (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ended, false, `${where}: the runner's stop waits for the renewal OpenAI is answering`);
    release();
    await stopped;
    openai.holdRefresh = undefined;
    assert.equal(typeof (await renewing), "string", `${where}: the renewal handed out its token`);
    const issued = openai.issued.at(-1);
    assert.equal(openai.revocationsOf(issued.refresh), 0, `${where}: the pair OpenAI issued is never revoked`);
    // Saved before the runner's store closed: the server sends it as it is, renewing nothing.
    assert.equal(await own.token(), issued.access, where);
    assert.equal(openai.refreshes, refreshes + 1, where);
    await server.stop();
  }
});

test("a run a runner's stop drains renews the plan's token when it needs to: its next request in the drain renews it and the run ends completed, beside the server or in a process of its own", { timeout: 180_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const openai = fakeOpenAI(t);
  const { runnerBeside } = await import("../dist/runner/beside.js");
  const { startRunnerProcess } = await import("../dist/runner/main.js");
  const starts = [["beside", (data) => runnerBeside(data, { drainMs: 30_000 })], ["own-process", (data) => startRunnerProcess({ dataDir: data, drainMs: 30_000, warn: () => {} })]];
  for (const [where, start] of starts) {
    const server = await serve(t, { faux: undefined, runner: false, harnesses: false });
    await signedIn(server.api);
    const runner = await start(server.data);
    let closing;
    const close = () => (closing ??= runner.close());
    t.after(close);
    // The run's first answer is held, then calls a tool no agent has: the run sends its next request once it is answered.
    let release;
    openai.holdResponse = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    openai.callOnce = "no_such_tool";
    const sent = openai.responses.length;
    assert.equal((await server.api("POST", "/agents", agent(`drain-${where}`))).status, 201);
    const started = await server.api("POST", `/agents/drain-${where}/runs`, { input: { content: "What is six times seven?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until(() => openai.responses.length > sent, `${where}: the run's first request is out`);
    // Signed in again, near its end: the run's next request has to renew it.
    openai.expiresIn = 200;
    await signedIn(server.api);
    openai.expiresIn = 3600;
    const refreshes = openai.refreshes;
    // The stop begins with the run in its turn: the drain lets it go on to its end, its next request included.
    const stopped = close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    openai.holdResponse = undefined;
    release();
    await stopped;
    const { last } = await follow(server.api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    assert.equal(last.status, "completed", `${where}: the drained run ends its turn: ${JSON.stringify(last)}`);
    assert.equal(openai.refreshes, refreshes + 1, `${where}: its next request renewed the token in the drain`);
    assert.equal(openai.responses.at(-1).authorization, `Bearer ${openai.issued.at(-1).access}`, `${where}: and was sent with the renewed token`);
    await server.stop();
  }
});
