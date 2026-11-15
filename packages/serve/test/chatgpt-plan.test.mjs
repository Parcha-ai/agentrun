// A server with no model key, signed in to a person's ChatGPT plan (OpenAI's Sign in with ChatGPT, through pi-ai's own
// flow), runs codex and pi on it. OpenAI is a fake in this process: the global fetch, which pi-ai's sign-in and the model
// proxy both send with, answers auth.openai.com and api.openai.com here (its token endpoint with rotating refresh tokens,
// its model list, its Responses API), and lets every other request through. Nothing reaches the network.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MODEL_KEYS } from "../dist/model.js";
import { agent, follow, journalOf, serve, serverLog, withEnv } from "./support.mjs";

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
 *  token endpoint refuses each refresh (invalid_grant). A spent refresh token sent again is `refresh_token_reused`. */
function fakeOpenAI(t) {
  const real = globalThis.fetch;
  const o = { expiresIn: 3600, refuse: false, issued: [], codes: 0, refreshes: 0, responses: [], other: [], revoked: [], live: new Set(), spent: new Set() };
  const issue = () => {
    const tokens = { access: jwtOf({ "https://api.openai.com/profile": { email: "person@example.com" }, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" }, jti: randomUUID() }), refresh: `fake-${randomBytes(16).toString("hex")}`, id: jwtOf({ email: "person@example.com" }) };
    o.issued.push(tokens);
    o.live.add(tokens.refresh);
    return Response.json({ access_token: tokens.access, refresh_token: tokens.refresh, id_token: tokens.id, expires_in: o.expiresIn, scope: SCOPE, token_type: "Bearer" });
  };
  const refused = (error) => Response.json({ error, error_description: "refused by the fake" }, { status: 400 });
  const liveAccess = (request) => o.issued.some((tokens) => request.headers.get("authorization") === `Bearer ${tokens.access}`);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "auth.openai.com" && url.hostname !== "api.openai.com") return real(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    if (url.href === "https://auth.openai.com/api/accounts/oauth/token") {
      const form = new URLSearchParams(text);
      if (form.get("resource") !== "https://api.openai.com/v1" || form.get("client_id") !== CLIENT) return refused("invalid_request");
      if (form.get("grant_type") === "authorization_code") {
        o.codes += 1;
        if (form.get("code") !== "fake-code" || form.get("redirect_uri") !== CALLBACK || !form.get("code_verifier")) return refused("invalid_grant");
        return issue();
      }
      if (form.get("grant_type") === "refresh_token") {
        o.refreshes += 1;
        const sent = form.get("refresh_token");
        if (o.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, o.refreshDelayMs));
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
        return issue();
      }
      return refused("unsupported_grant_type");
    }
    if (url.href === "https://auth.openai.com/.well-known/openid-configuration") return Response.json({ issuer: "https://auth.openai.com", revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
    if (url.href === "https://auth.openai.com/oauth/revoke") {
      const form = new URLSearchParams(text);
      o.revoked.push({ token: form.get("token"), hint: form.get("token_type_hint"), client: form.get("client_id") });
      o.live.delete(form.get("token"));
      return new Response(null, { status: 200 });
    }
    if (url.href === "https://api.openai.com/v1/models" && request.method === "GET") {
      if (!liveAccess(request)) return Response.json({ error: { message: "bad token" } }, { status: 401 });
      return Response.json({ object: "list", data: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "text-embedding-3-small"].map((id) => ({ id, object: "model" })) });
    }
    if (url.href === "https://api.openai.com/v1/responses" && request.method === "POST") {
      const body = JSON.parse(text || "{}");
      o.responses.push({ authorization: request.headers.get("authorization"), originator: request.headers.get("originator"), body });
      if (!liveAccess(request)) return Response.json({ error: { message: "bad token" } }, { status: 401 });
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Forty-two.", annotations: [] }] };
      const usage = { input_tokens: 120, output_tokens: 12, total_tokens: 132 };
      const events = [
        { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "Forty-two." },
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
  assert.equal((await api("GET", "/settings/chatgpt")).body.state, "pending");
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
    }
    const turns = turnsOf(done.runId);
    assert.ok(turns.length > 0, `${id} booked its turns`);
    for (const turn of turns) {
      assert.equal(turn.billing, "plan", `${id}: ${JSON.stringify(turn)}`);
      assert.equal(turn.usd, null, `${id}: no price on the plan`);
      assert.ok(turn.usage?.input > 0, `${id} booked its tokens`);
    }
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

  // Signing out revokes the session at OpenAI and removes the row; the next run says it is signed out.
  const refreshToken = openai.issued.at(-1).refresh;
  assert.equal((await api("DELETE", "/settings/chatgpt")).status, 204);
  assert.deepEqual(openai.revoked, [{ token: refreshToken, hint: "refresh_token", client: CLIENT }]);
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
  const sealed = new Map();
  const settings = new Map();
  const store = {
    sealedKeys: {
      get: async (name) => sealed.get(name),
      put: async (name, bytes) => void sealed.set(name, bytes),
      replaceIf: async (name, was, bytes) => (sealed.has(name) && Buffer.from(sealed.get(name)).equals(Buffer.from(was)) ? (sealed.set(name, bytes), true) : false),
      remove: async (name) => void sealed.delete(name),
    },
    settings: { putIfAbsent: async (key, value) => (settings.has(key) ? settings.get(key) : (settings.set(key, value), value)) },
  };
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

test("a server and a runner in their own processes, on one SQLite store, renew an ended token once: one refresh at OpenAI, the same new token for both, and once more after a 401 both saw", { timeout: 60_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  // Two processes: each its own store handle on the one file, and its own copy of the module (so no renewal in flight is
  // shared in memory: only the store can keep them to one).
  const { openSqliteStore } = await import("../dist/store/index.js");
  const { putSealedKey } = await import("../dist/server-keys.js");
  const [one, two] = await Promise.all([import("../dist/chatgpt-plan.js?process=server"), import("../dist/chatgpt-plan.js?process=runner")]);
  const dir = mkdtempSync(join(tmpdir(), "chatgpt-plan-lease-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverStore = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => serverStore.close());
  const runnerStore = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(() => runnerStore.close());
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

test("the renewal lease across two processes on one SQLite store: a live lease sends the current token at once, a lapsed one is taken over, a lost answer holds it to its end, a fault at OpenAI gives it back, and a sign-out mid-renewal stays", { timeout: 60_000 }, async (t) => {
  const openai = fakeOpenAI(t);
  const { openSqliteStore } = await import("../dist/store/index.js");
  const { putSealedKey } = await import("../dist/server-keys.js");
  const [one, two] = await Promise.all([import("../dist/chatgpt-plan.js?process=server-2"), import("../dist/chatgpt-plan.js?process=runner-2")]);
  const dir = mkdtempSync(join(tmpdir(), "chatgpt-plan-lease-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverStore = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => serverStore.close());
  const runnerStore = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(() => runnerStore.close());
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
  let seated = await seat(60_000, { holder: "another", until: Date.now() + 20_000 });
  const runner = new two.ChatGPTPlan({ store: runnerStore, sealKey });
  let started = Date.now();
  assert.equal(await runner.token(), seated.access, "a live lease and a token not yet ended: the current one is sent");
  assert.ok(Date.now() - started < 150, "without waiting for the lease");
  assert.equal(openai.refreshes, 0);
  viewHidesLease(await new one.ChatGPTPlan({ store: serverStore, sealKey }).load());

  // A holder that died mid-renewal left its lease, lapsed, on an ended token: the next reader takes it over, refreshes once.
  seated = await seat(-1_000, { holder: "crashed", until: Date.now() - 1_000 });
  assert.equal(await runner.token(), openai.issued.at(-1).access, "a lapsed lease is taken over");
  assert.notEqual(openai.issued.at(-1).access, seated.access);
  assert.equal(openai.refreshes, 1, "one refresh");
  assert.equal(await new one.ChatGPTPlan({ store: serverStore, sealKey }).token(), openai.issued.at(-1).access, "the other process reads the new pair");
  assert.equal(openai.refreshes, 1);

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
  // Once it has lapsed (a reader whose clock is past its end), the lease is taken over: one more refresh.
  const later = new two.ChatGPTPlan({ store: runnerStore, sealKey, now: () => Date.now() + 31_000 });
  assert.equal(await later.token(), openai.issued.at(-1).access, "a held lease that lapsed is taken over");
  assert.equal(openai.refreshes, refreshesBefore + 2);

  // OpenAI answered 503: the token is unspent, so the lease is given back and the next reader refreshes at once.
  seated = await seat(60_000);
  openai.failNext = 503;
  await assert.rejects(new one.ChatGPTPlan({ store: serverStore, sealKey }).token(), (error) => error instanceof one.PlanUnavailable && /try again/.test(error.message));
  assert.equal(await new two.ChatGPTPlan({ store: runnerStore, sealKey }).token(), openai.issued.at(-1).access, "a fault at OpenAI gives the lease back");
  assert.notEqual(openai.issued.at(-1).access, seated.access);
  assert.equal(openai.refreshes, refreshesBefore + 4);

  // The owner signs out while a renewal is out: the row stays gone, whatever the renewal got.
  await seat(-1_000);
  openai.refreshDelayMs = 300;
  const renewing = new two.ChatGPTPlan({ store: runnerStore, sealKey }).token();
  renewing.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await new one.ChatGPTPlan({ store: serverStore, sealKey }).signOut();
  await assert.rejects(renewing, (error) => error instanceof two.PlanUnavailable && /not signed in/.test(error.message));
  assert.equal(await runnerStore.sealedKeys.get(PLAN_ROW), undefined, "the row stays gone");
  assert.equal(await serverStore.sealedKeys.get(PLAN_ROW), undefined);
  assert.equal((await new one.ChatGPTPlan({ store: serverStore, sealKey }).load()).view().state, "signed_out");
});
