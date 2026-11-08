// Connect GitHub, through the API: one GitHub App per server, made with GitHub's app-manifest flow against a fake GitHub
// the test runs (its conversions and installations endpoints), its secrets kept sealed and never shown or logged; then
// a `github` trigger source on that App's one hook, /v2/hooks/github, verified with the App's webhook secret, where one
// event fires every trigger whose accept takes it, each its own firing; an installation removed turns them off.
import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { callback, CONNECTED, connect, connectable, deliver, failedWith, held, install, PUBLIC, SEAL, startConnect } from "./github-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { runDir, serve, withEnv } from "./support.mjs";
import { firings, keyOf, made } from "./trigger-support.mjs";

const target = (agentId, content = "Review it.") => ({ kind: "start_run", agent_id: agentId, input: { content }, max_cost_usd: 0.5 });
const pr = (extra = {}) => ({ action: "opened", number: 12, pull_request: { number: 12, draft: false, title: "Add a thing" }, repository: { full_name: "acme/widgets" }, installation: { id: 777 }, sender: { login: "dev" }, ...extra });

test("Connect GitHub starts GitHub's app-manifest flow: the manifest names the server's public hook, its redirect and setup URLs and the App's permissions and events, under a single-use state bound to this browser", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const started = await startConnect(server, {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const { action, manifest, state } = started.body;
  assert.match(state, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(action, `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`, "GitHub reads the state from the form's URL; the form posts only the manifest");
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
  const org = await startConnect(server, { org: "acme" });
  assert.equal(org.body.action, `https://github.com/organizations/acme/settings/apps/new?state=${encodeURIComponent(org.body.state)}`);
  assert.notEqual(org.body.state, state, "each start its own state");
  const badOrg = await startConnect(server, { org: "no such/org" });
  assert.deepEqual([badOrg.status, badOrg.body.error.fields?.map((f) => f.field)], [422, ["org"]]);
  const doc = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
  assert.ok(doc.paths["/integrations/github/connect"]?.post, "documented");
  assert.deepEqual(schemaProblems(doc, doc.paths["/integrations/github/connect"].post.responses["200"].content["application/json"].schema, started.body), []);
});

test("with no public URL, or no seal key, Connect GitHub is refused in words: GitHub could not reach the hook, or its secrets could not be kept", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const bare = await serve(t);
  const refused = await bare.api("POST", "/integrations/github/connect", {});
  assert.deepEqual([refused.status, refused.body.error.code], [409, "github_no_public_url"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /^GitHub can't reach this server: set its public URL first/);
  assert.match(refused.body.error.message, /AGENTRUN_PUBLIC_URL/);
  withEnv(t, {}, ["AGENTRUN_SEAL_KEY"]);
  const unsealed = await serve(t, { publicUrl: PUBLIC });
  const noKey = await startConnect(unsealed, {});
  assert.deepEqual([noKey.status, noKey.body.error.code], [409, "github_no_seal_key"], JSON.stringify(noKey.body));
  assert.match(noKey.body.error.message, /AGENTRUN_SEAL_KEY/, "names the setting");
});

test("the callback takes a state once, from the browser that started it: a bad, a replayed or another browser's state sends the browser to the console with state_invalid, a code GitHub does not convert with conversion_failed; a good one converts the code, seals the App's fields, drops its client secret, logs and answers no secret, and sends the browser to install the App", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const started = await startConnect(server, {});
  const cookie = String(started.headers.get("set-cookie")).split(";")[0];
  const back = (state, headers = { cookie }, code = "code-1") => fetch(`${server.baseUrl}/integrations/github/callback?code=${code}&state=${state}`, { redirect: "manual", headers });
  const sentTo = async (res) => [res.status, res.headers.get("location")];
  assert.deepEqual(await sentTo(await back("not-a-state")), [302, failedWith("state_invalid")], "a state this server never gave");
  assert.deepEqual(await sentTo(await back(started.body.state, {})), [302, failedWith("state_invalid")], "another browser: no cookie");
  const good = await back(started.body.state);
  assert.equal(good.status, 302, await good.text());
  const installAt = new URL(good.headers.get("location"));
  assert.equal(`${installAt.origin}${installAt.pathname}`, "https://github.com/apps/agentrun-test-app/installations/new");
  assert.match(installAt.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{32,}$/, "a fresh install state GitHub passes on to the setup URL");
  assert.ok(good.headers.getSetCookie().some((line) => /Path=\/v2\/integrations\/github\/installed/.test(line) && /HttpOnly/.test(line)), "its cookie, on the installed redirect's path");
  assert.deepEqual(await sentTo(await back(started.body.state)), [302, failedWith("state_invalid")], "the same state again");
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

  const again = await startConnect(server, {});
  assert.deepEqual([again.status, again.body.error.code], [409, "github_already_connected"], "one App per server");
  assert.equal(again.body.error.message, "This server already has a GitHub App. Disconnect it first.");
});

test("a code GitHub does not convert sends the browser to the console with conversion_failed, and keeps nothing", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const started = await startConnect(server, {});
  const cookie = String(started.headers.get("set-cookie")).split(";")[0];
  const back = await fetch(`${server.baseUrl}/integrations/github/callback?code=code-unknown&state=${started.body.state}`, { redirect: "manual", headers: { cookie } });
  assert.deepEqual([back.status, back.headers.get("location")], [302, failedWith("conversion_failed")]);
  assert.equal((await server.api("GET", "/integrations/github")).status, 404, "nothing kept");
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
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [{ id: 777, account: "acme" }]);

  const made1 = await server.api("POST", "/triggers", { name: "reviews", source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") });
  assert.equal(made1.status, 201, JSON.stringify(made1.body));
  const gone = await server.api("DELETE", "/integrations/github");
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(gone.body, { disconnected: true, triggers_off: 1, note: "Delete the App itself on GitHub: https://github.com/organizations/acme/settings/apps/agentrun-test-app" }, "the App itself is GitHub's to delete");
  assert.equal((await server.api("GET", "/integrations/github")).status, 404);
  const off = (await server.api("GET", `/triggers/${made1.body.id}`)).body;
  assert.deepEqual([off.enabled, off.disabled?.reason], [false, "connection_lost"], JSON.stringify(off));
  assert.match(off.disabled.detail, /GitHub/);
  const on = await server.api("PATCH", `/triggers/${made1.body.id}`, { enabled: true });
  assert.deepEqual([on.status, on.body.error?.code], [409, "github_not_connected"], "not on again with no connection");
});

test("a github trigger needs the connection: 409 github_not_connected, saying to connect GitHub in Settings; its accept is required", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  const refused = await server.api("POST", "/triggers", { source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "github_not_connected"], JSON.stringify(refused.body));
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
  assert.ok(content.includes(`<trigger-payload source="github" scheme="github" event="pull_request" action="opened" delivery="${delivery}" installation="777" repo="acme/widgets" number="12" untrusted>`), content);

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

test("an installation deleted or suspended on GitHub leaves the list; github triggers turn off only when none is left, naming it; one unsuspended comes back to the list and turns nothing on", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  await connect(server);
  const { webhook_secret: secret } = server.github.app;
  // As GitHub sends them: the installation, its account and its App; and as GitHub holds them by then (the fake's).
  const event = (action, id, login) => deliver(server.baseUrl, secret, "installation", { action, installation: { id, account: { login }, app_id: 4242 } });
  const { installations } = server.github;
  const list = async () => (await server.api("GET", "/integrations/github")).body.installations;
  installations.set(778, { account: "other", suspended_at: null });
  assert.equal((await event("created", 778, "other")).status, 200);
  assert.deepEqual(await list(), [{ id: 777, account: "acme" }, { id: 778, account: "other" }]);
  const ids = [];
  for (const name of ["a", "b"]) ids.push((await server.api("POST", "/triggers", { name, source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") })).body.id);
  const states = async () => Promise.all(ids.map(async (id) => (await server.api("GET", `/triggers/${id}`)).body));
  installations.delete(777);
  assert.equal((await event("deleted", 777, "acme")).status, 200);
  assert.deepEqual(await list(), [{ id: 778, account: "other" }], "one deleted leaves the list");
  assert.deepEqual((await states()).map((t) => t.enabled), [true, true], "another is left: they stay on");
  installations.get(778).suspended_at = new Date().toISOString();
  assert.equal((await event("suspend", 778, "other")).status, 200);
  assert.deepEqual(await list(), [], "the last one suspended");
  for (const trigger of await states()) {
    assert.deepEqual([trigger.enabled, trigger.disabled?.reason], [false, "connection_lost"], JSON.stringify(trigger));
    assert.match(trigger.disabled.detail, /installation 778 \(other\)/);
  }
  installations.get(778).suspended_at = null;
  assert.equal((await event("unsuspend", 778, "other")).status, 200);
  assert.deepEqual(await list(), [{ id: 778, account: "other" }], "back in the list");
  assert.deepEqual((await states()).map((t) => t.enabled), [false, false], "and nothing turned on");
});

test("X-GitHub-Event is not signed: a signed issue_comment body resent as an installation event changes nothing, and an installation event GitHub does not bear out (still installed, another App's) is not taken", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  await connect(server);
  const id = (await server.api("POST", "/triggers", { name: "a", source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") })).body.id;
  const { webhook_secret: secret } = server.github.app;
  const list = async () => (await server.api("GET", "/integrations/github")).body.installations;
  const relabeled = await deliver(server.baseUrl, secret, "installation", { action: "deleted", comment: { id: 1, body: "gone" }, issue: { number: 3 }, installation: { id: 777 }, repository: { full_name: "acme/widgets" } });
  assert.equal(relabeled.status, 200, JSON.stringify(relabeled.body));
  const notGone = await deliver(server.baseUrl, secret, "installation", { action: "deleted", installation: { id: 777, account: { login: "acme" }, app_id: 4242 } });
  assert.equal(notGone.status, 200, "GitHub still holds it: not taken");
  const other = await deliver(server.baseUrl, secret, "installation", { action: "created", installation: { id: 999, account: { login: "mallory" }, app_id: 1 } });
  assert.equal(other.status, 200, "another App's: not taken");
  assert.deepEqual(await list(), [{ id: 777, account: "acme" }], "the list as it was");
  assert.equal((await server.api("GET", `/triggers/${id}`)).body.enabled, true, "the trigger still on");
});

test("two Connects at once: the one whose code GitHub converts after the other's App is kept is sent back with already_connected, and the first App stays", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const [first, second] = [await startConnect(server), await startConnect(server)];
  const cookie = (started) => String(started.headers.get("set-cookie")).split(";")[0];
  const hold = held();
  server.github.holds["code-2"] = hold.promise;
  const late = fetch(`${server.baseUrl}/integrations/github/callback?code=code-2&state=${second.body.state}`, { redirect: "manual", headers: { cookie: cookie(second) } });
  while (!server.github.requests.some((r) => r.url === "/app-manifests/code-2/conversions")) await new Promise((resolve) => setTimeout(resolve, 20));
  const done = await fetch(`${server.baseUrl}/integrations/github/callback?code=code-1&state=${first.body.state}`, { redirect: "manual", headers: { cookie: cookie(first) } });
  assert.equal(done.status, 302);
  hold.release();
  const answer = await late;
  assert.deepEqual([answer.status, answer.headers.get("location")], [302, failedWith("already_connected")]);
  assert.equal((await server.api("GET", "/integrations/github")).body.app_id, "4242", "the first App, not overwritten");
});

test("an installation checked while GitHub is disconnected and connected again, to another App, is dropped, not written into the new connection", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const started = await startConnect(server);
  const back = await callback(server, "code-1", started.body.state, String(started.headers.get("set-cookie")).split(";")[0]);
  assert.equal(back.status, 302);
  const hold = held();
  server.github.holds.installation = hold.promise;
  const installing = install(server, 777, back);
  while (!server.github.requests.some((r) => r.url === "/app/installations/777")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await server.api("DELETE", "/integrations/github")).status, 200);
  const again = await startConnect(server);
  assert.equal((await fetch(`${server.baseUrl}/integrations/github/callback?code=code-2&state=${again.body.state}`, { redirect: "manual", headers: { cookie: String(again.headers.get("set-cookie")).split(";")[0] } })).status, 302);
  hold.release();
  const answer = await installing;
  assert.deepEqual([answer.status, answer.headers.get("location")], [302, failedWith("installation_unverified")]);
  assert.deepEqual((await server.api("GET", "/integrations/github")).body, { app_id: "4343", slug: "agentrun-test-app-2", installations: [] }, "the new App holds no installation of the old one");
});

test("Connect started at an address other than the public URL is refused before any state, 409 github_wrong_origin, naming where to open the server", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const refused = await startConnect(server, {}, { wrong: true });
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "github_wrong_origin"], JSON.stringify(refused.body));
  assert.equal(refused.body.error.message, `Open this server at ${PUBLIC} to connect GitHub.`);
  assert.deepEqual(refused.body.error.details, { public_url: PUBLIC }, "the URL as a field, for the console's link");
  assert.equal(refused.headers.get("set-cookie"), null, "no state cookie set");
});

test("the installed redirect records an installation only with the install state its callback sent to GitHub and that browser's cookie: without them it records nothing and lands on the console, as GitHub's own install pages do; with them, one GitHub does not know is installation_unverified", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  const started = await startConnect(server);
  const back = await callback(server, "code-1", started.body.state, String(started.headers.get("set-cookie")).split(";")[0]);
  const list = async () => (await server.api("GET", "/integrations/github")).body.installations;
  for (const [what, options] of [["no state", { state: null, cookie: null }], ["no cookie", { cookie: null }], ["another state", { state: "not-a-state" }]]) {
    const unbound = await install(server, 777, back, options);
    assert.deepEqual([unbound.status, unbound.headers.get("location")], [302, CONNECTED], what);
    assert.deepEqual(await list(), [], `${what}: nothing recorded (an install from GitHub's own pages arrives as its signed installation event)`);
  }
  const unknown = await install(server, 778, back);
  assert.deepEqual([unknown.status, unknown.headers.get("location")], [302, failedWith("installation_unverified")], "bound, but GitHub does not know it as the App's");
  assert.deepEqual(await list(), []);
});

test("a key whose last line is short shows nothing of itself where the server's secrets are cut: the whole key and every line are listed, the short one too", async (t) => {
  const { openServerSecrets } = await import("../dist/server-secrets.js");
  const { SealedSettings } = await import("../dist/sealed-settings.js");
  const { redactedAnswer } = await import("../dist/key-refusal.js");
  const { github } = await import("../dist/trigger-github.js");
  const { scratch } = await import("./support.mjs");
  const { randomBytes } = await import("node:crypto");
  const data = await scratch(t);
  const key = randomBytes(32);
  const kind = ["RSA", "PRIVATE", "KEY-----"].join(" ");
  const lines = [randomBytes(48).toString("base64"), randomBytes(48).toString("base64"), "Zq7=="];
  const pem = `-----BEGIN ${kind}\n${lines.join("\n")}\n-----END ${kind}\n`;
  new SealedSettings(data, "github", github.settings, key, () => {}).set("server", "private_key", pem);
  const { secrets } = openServerSecrets(data, { AGENTRUN_SEAL_KEY: key.toString("base64") }, [github]);
  const held = secrets.values();
  for (const line of lines) assert.ok(held.includes(line), `listed: ${line}`);
  const shown = redactedAnswer(`the run printed: ${pem} and ended`, held);
  for (const line of lines) assert.ok(!shown.includes(line), `nothing of the key shows: ${shown}`);
});

test("an installation event checked while GitHub is disconnected and connected again, to another App, is dropped: nothing lands in the new connection, and no trigger turns off", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  await connect(server);
  const id = (await server.api("POST", "/triggers", { name: "a", source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") })).body.id;
  const { webhook_secret: secret } = server.github.app;
  server.github.installations.delete(777);
  const hold = held();
  server.github.holds.installation = hold.promise;
  const asked = server.github.requests.length;
  const event = deliver(server.baseUrl, secret, "installation", { action: "deleted", installation: { id: 777, account: { login: "acme" }, app_id: 4242 } });
  while (!server.github.requests.slice(asked).some((r) => r.url === "/app/installations/777")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await server.api("DELETE", "/integrations/github")).status, 200);
  const again = await startConnect(server);
  assert.equal((await callback(server, "code-2", again.body.state, String(again.headers.get("set-cookie")).split(";")[0])).status, 302);
  assert.equal((await server.api("PATCH", `/triggers/${id}`, { enabled: true })).status, 200, "on again under the new App");
  hold.release();
  assert.equal((await event).status, 200);
  assert.equal((await server.api("GET", `/triggers/${id}`)).body.enabled, true, "the old App's event turned nothing off");
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [], "and wrote nothing into the new App");
});

test("GitHub out of reach when an installation event is checked answers 503, so GitHub shows the delivery failed and it can be sent again; the list is repaired from GitHub's own when the connection is read", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await connect(server);
  const { webhook_secret: secret } = server.github.app;
  server.github.installations.set(778, { account: "other", suspended_at: null });
  server.github.failures.installation = 500;
  const event = await deliver(server.baseUrl, secret, "installation", { action: "created", installation: { id: 778, account: { login: "other" }, app_id: 4242 } });
  assert.equal(event.status, 503, JSON.stringify(event.body));
  assert.ok(server.lines.some((line) => line.includes("condition=github_unavailable")), "said");
  delete server.github.failures.installation;
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [{ id: 777, account: "acme" }, { id: 778, account: "other" }], "the read repairs the list from GitHub's");
});

test("a read of the connection that finds GitHub holds no installation of the App left turns every github trigger off, as a missed deletion would have", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await made(server.api, "review");
  await connect(server);
  const id = (await server.api("POST", "/triggers", { name: "a", source: { kind: "github", accept: [{ event: "pull_request" }] }, target: target("review") })).body.id;
  server.github.installations.delete(777);
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, []);
  const trigger = (await server.api("GET", `/triggers/${id}`)).body;
  assert.deepEqual([trigger.enabled, trigger.disabled?.reason], [false, "connection_lost"], JSON.stringify(trigger));
});
