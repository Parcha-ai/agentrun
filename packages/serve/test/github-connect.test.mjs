// Connect GitHub, through the API: one GitHub App per server, made with GitHub's app-manifest flow against a fake GitHub
// the test runs (its conversions and installations endpoints), its secrets kept sealed and never shown or logged; then
// a `github` trigger source on that App's one hook, /v2/hooks/github, verified with the App's webhook secret, where one
// event fires every trigger whose accept takes it, each its own firing; an installation removed turns them off.
import assert from "node:assert/strict";
import { createHash, createHmac, createVerify, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { runDir, serve, withEnv } from "./support.mjs";
import { firings, keyOf, made } from "./trigger-support.mjs";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const PUBLIC = "https://agents.example.test";

/** A fake GitHub API: the manifest's conversion (once per code) and an installation, as GitHub answers them; it keeps
 *  each request so a test reads what was asked and with which credential. */
async function fakeGitHub(t) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const app = { id: 4242, slug: "agentrun-test-app", client_id: `Iv1.${randomBytes(8).toString("hex")}`, client_secret: randomBytes(20).toString("hex"), webhook_secret: randomBytes(20).toString("hex"), pem: privateKey };
  const requests = [];
  const codes = new Set(["code-1"]);
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const answer = (status, doc) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(doc));
      const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url);
      if (req.method === "POST" && conversion) {
        if (!codes.delete(conversion[1])) return answer(404, { message: "Not Found" });
        return answer(201, { id: app.id, slug: app.slug, node_id: "A_1", owner: { login: "acme" }, name: "AgentRun test", client_id: app.client_id, client_secret: app.client_secret, webhook_secret: app.webhook_secret, pem: app.pem });
      }
      const installation = /^\/app\/installations\/(\d+)$/.exec(req.url);
      if (req.method === "GET" && installation) {
        // GitHub answers only an App's JWT: RS256 over its header and claims, under the App's private key.
        const [header, claims, signature] = String(req.headers.authorization ?? "").replace(/^Bearer /, "").split(".");
        const verified = header && createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature ?? "", "base64url"));
        if (!verified || JSON.parse(Buffer.from(claims, "base64url").toString()).iss !== String(app.id)) return answer(401, { message: "A JSON web token could not be decoded" });
        if (installation[1] !== "777") return answer(404, { message: "Not Found" });
        return answer(200, { id: 777, account: { login: "acme", type: "Organization" }, app_id: app.id });
      }
      answer(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); // key-gate: loopback-rule the fake GitHub the test runs
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, app, publicKey, requests }; // key-gate: loopback-rule the fake GitHub the test runs
}

/** A server with a public URL and a seal key, its GitHub API the fake's. */
async function connectable(t, extra = {}) {
  withEnv(t, SEAL);
  const github = await fakeGitHub(t);
  const lines = [];
  const server = await serve(t, { publicUrl: PUBLIC, githubApi: github.url, log: (line) => lines.push(line), ...extra });
  return { ...server, github, lines };
}

/** The Connect flow as the owner's browser goes through it: connect (the console posts the manifest to GitHub), GitHub's
 *  redirect back with a code, then its redirect after the App is installed. */
async function connect(server) {
  const started = await server.api("POST", "/integrations/github/connect", {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const cookie = String(started.headers.get("set-cookie") ?? "").split(";")[0];
  const back = await fetch(`${server.baseUrl}/integrations/github/callback?code=code-1&state=${started.body.state}`, { redirect: "manual", headers: { cookie } });
  assert.equal(back.status, 302, await back.text());
  const installed = await fetch(`${server.baseUrl}/integrations/github/installed?installation_id=777&setup_action=install`, { redirect: "manual" });
  assert.equal(installed.status, 302, await installed.text());
  return { started, cookie, back, installed };
}

/** A delivery from the App: `event` with `payload`, signed with its webhook secret (or `signature` as given). */
async function deliver(baseUrl, secret, event, payload, { signature, delivery = randomUUID() } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const res = await fetch(`${baseUrl}/hooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest("hex")}` }, body });
  return { status: res.status, body: await res.json().catch(() => null), body_text: body };
}

const target = (agentId, content = "Review it.") => ({ kind: "start_run", agent_id: agentId, input: { content }, max_cost_usd: 0.5 });
const pr = (extra = {}) => ({ action: "opened", number: 12, pull_request: { draft: false, title: "Add a thing" }, repository: { full_name: "acme/widgets" }, installation: { id: 777 }, sender: { login: "dev" }, ...extra });

test("Connect GitHub starts GitHub's app-manifest flow: the manifest names the server's public hook, its redirect and setup URLs and the App's permissions and events, under a single-use state bound to this browser", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const started = await server.api("POST", "/integrations/github/connect", {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const { action, manifest, state } = started.body;
  assert.match(state, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(action, `https://github.com/settings/apps/new?state=${state}`);
  assert.match(manifest.name, /^[A-Za-z0-9 ._-]{1,34}$/, "a name GitHub takes, which the person may edit");
  assert.deepEqual({ ...manifest, name: undefined }, {
    name: undefined,
    url: PUBLIC,
    hook_attributes: { url: `${PUBLIC}/v2/hooks/github`, active: true },
    redirect_url: `${PUBLIC}/v2/integrations/github/callback`,
    setup_url: `${PUBLIC}/v2/integrations/github/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: { pull_requests: "write", contents: "read", metadata: "read", issues: "read" },
    default_events: ["pull_request", "issue_comment"],
  });
  assert.match(String(started.headers.get("set-cookie")), /HttpOnly; SameSite=Lax; Path=\/v2\/integrations\/github\/callback/, "bound to the browser that started it");
  const org = await server.api("POST", "/integrations/github/connect", { org: "acme" });
  assert.equal(org.body.action, `https://github.com/organizations/acme/settings/apps/new?state=${org.body.state}`);
  assert.notEqual(org.body.state, state, "each start its own state");
  const badOrg = await server.api("POST", "/integrations/github/connect", { org: "no such/org" });
  assert.deepEqual([badOrg.status, badOrg.body.error.fields?.map((f) => f.field)], [422, ["org"]]);
  const doc = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
  assert.ok(doc.paths["/integrations/github/connect"]?.post, "documented");
  assert.deepEqual(schemaProblems(doc, doc.paths["/integrations/github/connect"].post.responses["200"].content["application/json"].schema, started.body), []);
});

test("with no public URL, or no seal key, Connect GitHub is refused in words: GitHub could not reach the hook, or its secrets could not be kept", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const bare = await serve(t);
  const refused = await bare.api("POST", "/integrations/github/connect", {});
  assert.deepEqual([refused.status, refused.body.error.code], [409, "no_public_url"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /GitHub can't reach this server/);
  assert.match(refused.body.error.message, /AGENTRUN_PUBLIC_URL/);
  withEnv(t, {}, ["AGENTRUN_SEAL_KEY"]);
  const unsealed = await serve(t, { publicUrl: PUBLIC });
  const noKey = await unsealed.api("POST", "/integrations/github/connect", {});
  assert.deepEqual([noKey.status, noKey.body.error.code], [409, "no_sealing_key"]);
});

test("the callback takes a state once, from the browser that started it: a bad, a replayed or another browser's state is 400; a good one converts the code, seals the App's fields, drops its client secret, logs and answers no secret, and sends the browser to install the App", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const started = await server.api("POST", "/integrations/github/connect", {});
  const cookie = String(started.headers.get("set-cookie")).split(";")[0];
  const back = (state, headers = { cookie }) => fetch(`${server.baseUrl}/integrations/github/callback?code=code-1&state=${state}`, { redirect: "manual", headers });
  assert.equal((await back("not-a-state")).status, 400, "a state this server never gave");
  assert.equal((await back(started.body.state, {})).status, 400, "another browser: no cookie");
  const good = await back(started.body.state);
  assert.equal(good.status, 302, await good.text());
  assert.equal(good.headers.get("location"), "https://github.com/apps/agentrun-test-app/installations/new");
  assert.equal((await back(started.body.state)).status, 400, "the same state again");
  const conversions = server.github.requests.filter((r) => r.url === "/app-manifests/code-1/conversions");
  assert.deepEqual(conversions.map((r) => r.method), ["POST"], "converted once");

  const { app } = server.github;
  const file = await readFile(join(server.data, "trigger-settings-github.json"), "utf8");
  for (const secret of [app.webhook_secret, app.client_secret, app.pem.split("\n")[1]]) assert.ok(!file.includes(secret), "kept only sealed");
  const view = await server.api("GET", "/integrations/github");
  assert.deepEqual(view.body, { app_id: "4242", slug: "agentrun-test-app", installations: [] });
  const shown = JSON.stringify([started.body, view.body, server.lines]);
  for (const secret of [app.webhook_secret, app.client_secret, app.pem.split("\n")[1], app.client_id]) assert.ok(!shown.includes(secret), "never shown or logged");
  assert.ok(server.lines.some((line) => line.includes("condition=github_connected") && line.includes("app_id=4242")), "said, by its id");

  const again = await server.api("POST", "/integrations/github/connect", {});
  assert.deepEqual([again.status, again.body.error.code], [409, "already_connected"], "one App per server");
  assert.match(again.body.error.message, /disconnect/i);
});

test("a state is good for an hour, then refused", async () => {
  const { ManifestStates } = await import("../dist/github-connection.js");
  let now = Date.parse("2026-11-08T00:00:00Z");
  const states = new ManifestStates(() => now);
  const kept = states.make();
  const late = states.make();
  assert.equal(states.take(kept), true);
  assert.equal(states.take(kept), false, "once");
  now += 60 * 60 * 1000 + 1;
  assert.equal(states.take(late), false, "past its hour");
});

test("the App's JWT is RS256 over iss (the App id), iat a minute back and exp at most ten minutes on", async () => {
  const { appJwt } = await import("../dist/github.js");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const now = Date.parse("2026-11-08T12:00:00Z");
  const [header, claims, signature] = appJwt("4242", privateKey, now).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const { iss, iat, exp } = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(iss, "4242");
  assert.equal(iat, now / 1000 - 60);
  assert.ok(exp > now / 1000 && exp - iat <= 600, `exp ${exp}, iat ${iat}`);
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")));
});

test("an installation is recorded only as GitHub says it is the App's, asked with the App's JWT; Disconnect removes the connection and turns every github trigger off, keeping them", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  await connect(server);
  const asked = server.github.requests.find((r) => r.url === "/app/installations/777");
  assert.match(String(asked.headers.authorization), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "with the App's JWT");
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [{ id: 777, account: "acme" }]);
  const unknown = await fetch(`${server.baseUrl}/integrations/github/installed?installation_id=778`, { redirect: "manual" });
  assert.notEqual(unknown.status, 302, "one GitHub does not know as the App's is not recorded");
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [{ id: 777, account: "acme" }]);

  const made1 = await server.api("POST", "/triggers", { name: "reviews", source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") });
  assert.equal(made1.status, 201, JSON.stringify(made1.body));
  const gone = await server.api("DELETE", "/integrations/github");
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.match(gone.body.note, /delete the App on GitHub/i, "the App itself is GitHub's to delete");
  assert.equal((await server.api("GET", "/integrations/github")).status, 404);
  const off = (await server.api("GET", `/triggers/${made1.body.id}`)).body;
  assert.deepEqual([off.enabled, off.disabled?.reason], [false, "connection_lost"], JSON.stringify(off));
  assert.match(off.disabled.detail, /GitHub/);
  const on = await server.api("PATCH", `/triggers/${made1.body.id}`, { enabled: true });
  assert.deepEqual([on.status, on.body.error?.code], [409, "not_connected"], "not on again with no connection");
});

test("a github trigger needs the connection: 409 not_connected, saying to connect GitHub in Settings; its accept is required", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  const refused = await server.api("POST", "/triggers", { source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "not_connected"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /Connect GitHub in Settings/);
  await connect(server);
  const noAccept = await server.api("POST", "/triggers", { source: { kind: "github" }, target: target("review") });
  assert.deepEqual([noAccept.status, noAccept.body.error.fields?.map((f) => f.field)], [422, ["source.accept"]]);
  const extra = await server.api("POST", "/triggers", { source: { kind: "github", accept: [{ event: "push" }], signature: "github" }, target: target("review") });
  assert.deepEqual([extra.status, extra.body.error.fields?.map((f) => f.field)], [422, ["source.signature"]], "no per-trigger secret or signature");
});

test("demo: one signed pull_request reaches /v2/hooks/github and fires every github trigger whose accept takes it, each its own firing and run, named on the payload's tag; a trigger it does not take fires nothing", { timeout: 120_000 }, async (t) => {
  const server = await connectable(t);
  for (const id of ["review", "triage", "comments"]) await made(server.api, id);
  await connect(server);
  const make = async (name, agentId, accept) => {
    const res = await server.api("POST", "/triggers", { name, source: { kind: "github", accept }, target: target(agentId) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.secret, undefined, "no secret of its own");
    return res.body;
  };
  const review = await make("review", "review", [{ event: "pull_request", actions: ["opened"] }]);
  const triage = await make("triage", "triage", [{ event: "pull_request", where: [{ pointer: "/pull_request/draft", in: [false] }] }]);
  const comments = await make("comments", "comments", [{ event: "issue_comment" }]);
  const { webhook_secret: secret } = server.github.app;
  const delivery = randomUUID();
  const fired = await deliver(server.baseUrl, secret, "pull_request", pr(), { delivery });
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  const hash = `sha256:${createHash("sha256").update(fired.body_text).digest("hex")}`;
  assert.deepEqual(fired.body.firings.map((f) => f.key).sort(), [keyOf("github", review.id, hash), keyOf("github", triage.id, hash)].sort(), "one firing each, each its own key");
  const [one] = await firings(server.api, review.id, 1);
  const [two] = await firings(server.api, triage.id, 1);
  assert.deepEqual([one.status, two.status], ["started", "started"]);
  assert.notEqual(one.run_id, two.run_id, "each its own run");
  assert.deepEqual((await server.api("GET", `/triggers/${comments.id}/firings`)).body.firings, [], "not taken, not fired");
  const { content } = JSON.parse(await readFile(join(runDir(server.data, one.run_id), "serve.json"), "utf8")).input;
  assert.ok(content.includes(`<trigger-payload source="github" scheme="github" event="pull_request" action="opened" delivery="${delivery}" installation="777" repo="acme/widgets" untrusted>`), content);

  const again = await deliver(server.baseUrl, secret, "pull_request", pr());
  assert.equal(again.status, 200, "the same signed body again starts nothing");
  const ignored = await deliver(server.baseUrl, secret, "pull_request_review", pr({ action: "submitted" }));
  assert.deepEqual([ignored.status, ignored.body], [200, { ok: "ignored" }], "an event no trigger takes");
  const relabeled = await deliver(server.baseUrl, secret, "issue_comment", ignored.body_text);
  assert.equal(relabeled.status, 200, JSON.stringify(relabeled.body));
  assert.deepEqual((await server.api("GET", `/triggers/${comments.id}/firings`)).body.firings, [], "the ignored body under an event a rule takes fires nothing: X-GitHub-Event is not signed");
  const bad = await deliver(server.baseUrl, secret, "pull_request", pr({ number: 13 }), { signature: `sha256=${"0".repeat(64)}` });
  assert.equal(bad.status, 401, "a bad signature is the one 401");
  const ping = await deliver(server.baseUrl, secret, "ping", { zen: "Keep it logically awesome.", hook_id: 1 });
  assert.equal(ping.status, 200, JSON.stringify(ping.body));
  const doc = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
  const answers = doc.paths["/hooks/github"].post.responses;
  for (const [code, body] of [["202", fired.body], ["200", ignored.body], ["200", ping.body]]) assert.deepEqual(schemaProblems(doc, answers[code].content["application/json"].schema, body), [], `${code} ${JSON.stringify(body)}`);
});

test("an installation deleted or suspended on GitHub turns every github trigger off, naming the connection; the installation list follows the App's installation events", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  await connect(server);
  const { webhook_secret: secret } = server.github.app;
  const created = await deliver(server.baseUrl, secret, "installation", { action: "created", installation: { id: 778, account: { login: "other" } } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [{ id: 777, account: "acme" }, { id: 778, account: "other" }]);
  const ids = [];
  for (const name of ["a", "b"]) ids.push((await server.api("POST", "/triggers", { name, source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") })).body.id);
  const deleted = await deliver(server.baseUrl, secret, "installation", { action: "deleted", installation: { id: 777, account: { login: "acme" } } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  for (const id of ids) {
    const trigger = (await server.api("GET", `/triggers/${id}`)).body;
    assert.deepEqual([trigger.enabled, trigger.disabled?.reason], [false, "connection_lost"], JSON.stringify(trigger));
    assert.match(trigger.disabled.detail, /installation 777 \(acme\)/);
  }
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [{ id: 778, account: "other" }]);
});
