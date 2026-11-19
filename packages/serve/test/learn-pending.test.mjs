// A workflow draft that calls a tool with no price is kept, and waits: the merge commits its README.md with `status:
// pending`, no run is given it, and the run's learning names it as waiting. It waits until a person acts on it: a retire
// takes it out of the waiting list, and approving it takes the owner's password session in the console alone: every
// token is refused, the server's own included, and so is a page cookie a token mints (accounts off). Capabilities say
// so to each caller: approve true for that session alone, else approve_needs "password". The approval is one host
// commit with the `Approved-Via: console` trailer, logged without the draft's text.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { currentLearning, seedOf } from "../dist/learning.js";
import { pendingTestHooks } from "../dist/learning-routes.js";
import { workflow } from "./learn-format-support.mjs";
import { fedBack, git, LEARN, learner, made, repoOf } from "./learn-support.mjs";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";
import { call, cookieOf, serve } from "./support.mjs";

const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const WAITS = "paperdepot24-first";
const README = `workflows/${WAITS}/README.md`;
const FILE = `/agents/buyer/learning/files/${encodeURIComponent(README)}`;

/** A learner with two drafts on main: answer-in-tables active, paperdepot24-first held for its owner's OK. */
async function learnedPending(t, options = {}) {
  const server = await serve(t, { learning: "on", faux: LEARN, ...options });
  await made(server.api, learner("buyer"));
  await landWorkflows(server.data, "buyer", [
    { name: "answer-in-tables", description: "Answers every question as a small table", workflow: JSON.parse(workflow({ name: "answer-in-tables" })) },
    { name: WAITS, description: "Buys office paper from PaperDepot24 first", workflow: JSON.parse(workflow({ name: WAITS })), status: "pending" },
  ]);
  return { ...server, repo: repoOf(server.data, "buyer") };
}

test("a pending draft waits until a person acts on it: a retire takes it out of the folder's waiting list, as it retires an active one, and capabilities say a draft waits", { timeout: 150_000 }, async (t) => {
  const { api, repo } = await learnedPending(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.learning, { pending: true, approve: false, approve_needs: "password" });
  assert.deepEqual((await api("GET", "/agents/buyer")).body.learning, { pending: 1 });
  const etag = (await api("GET", FILE)).headers.get("etag");
  const retired = await api("POST", `${FILE}/retire`, undefined, { "if-match": etag });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.match(git(repo, ["show", `main:${README}`]), /\nstatus: retired\nretired_from: pending\n---$/, "git() trims its last newline");
  assert.equal(git(repo, ["log", "-1", "--format=%s", "main"]), `learning: retired by a person: ${README}`);
  assert.deepEqual((await api("GET", "/agents/buyer")).body.learning, { pending: 0 });
});

test("a run's whole learning reads no folder unless its merge held something for the owner's OK", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("plain"));
  const { view } = await fedBack(api, "plain");
  assert.equal(view.learning.state, "merged", JSON.stringify(view.learning));
  const reads = pendingTestHooks.reads;
  assert.equal((await api("GET", `/runs/${view.run_id}/learning`)).status, 200);
  assert.equal((await api("GET", `/runs/${view.run_id}`)).status, 200);
  assert.equal(pendingTestHooks.reads, reads, "a merge that held nothing reads no status");
});

test("what a run held reads as it stands on main now: a draft approved since is the run's, its pending gone; one retired is said no more; a run whose every item was retired says so; still pending, it waits; no status read, as written", () => {
  const held = { state: "merged", reason: null, detail: "stored", at: "2026-11-07T00:00:00Z", workflows: [{ file: "workflows/w/workflow.json", name: "w", pending: true }] };
  const now = (status) => currentLearning(held, new Map(Object.entries(status).map(([file, value]) => [file, { status: value }])));
  assert.deepEqual(now({ "workflows/w/workflow.json": "pending" }), held, "it still waits");
  const approved = now({ "workflows/w/workflow.json": "active" });
  assert.deepEqual([approved.workflows, approved.detail], [[{ file: "workflows/w/workflow.json", name: "w" }], "stored"]);
  const retired = now({ "workflows/w/workflow.json": "retired" });
  assert.deepEqual([retired.workflows, retired.detail], [[], "What it learned was retired since."]);
  const corrected = currentLearning({ ...held, corrections: 1 }, new Map([["workflows/w/workflow.json", { status: "retired" }]]));
  assert.deepEqual([corrected.workflows, corrected.detail], [[], "stored"], "its correction is still kept");
  assert.equal(currentLearning(held, undefined), held, "a folder not read: as written");
  assert.equal(currentLearning({ ...held, state: "dropped" }, new Map()).workflows, held.workflows, "only a merge holds anything");
});

test("approving a pending draft takes the owner's password session in the console alone: the server's token (what an agent's MCP client or a script holds) is 403, and no credential or a cookie from another origin 401; the console makes it active, given to the next run, logged as by {user, via: console} without its text; capabilities say approve to that session alone", { timeout: 180_000 }, async (t) => {
  const server = await learnedPending(t, { accounts: true, openSetup: true });
  const { api, data, port, repo } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const path = `/v2${FILE}`;
  const etag = (await api("GET", FILE)).headers.get("etag");
  const approve = (headers) => call(port, { method: "POST", path: `${path}/approve`, headers: { "if-match": etag, ...headers }, body: {} });
  for (const [why, headers] of [
    ["the server's token, which an agent's MCP client or a script holds", { ...json, authorization: `Bearer ${server.token}` }],
    ["the server's token from the page's own origin", { ...json, origin, authorization: `Bearer ${server.token}` }],
    ["the owner's cookie and the token both", { ...json, cookie, origin, authorization: `Bearer ${server.token}` }],
  ]) {
    const res = await approve(headers);
    assert.equal(res.status, 403, `${why}: ${res.text}`);
  }
  // The page's cookie stands in for nothing from another origin, or without a JSON body: no credential, 401, as every route.
  for (const [why, headers] of [["no credential", json], ["the owner's cookie from another origin", { ...json, cookie, origin: "http://elsewhere.example" }], ["the owner's cookie with no JSON body type", { cookie, origin }]]) {
    const res = await approve(headers);
    assert.equal(res.status, 401, `${why}: ${res.text}`);
  }
  assert.match(git(repo, ["show", `main:${README}`]), /status: pending/, "nothing approved it");
  // The MCP endpoint's tools call routes with the caller's token: none approves, and the route refuses that token anyway.
  const tools = await call(port, { method: "POST", path: "/v2/mcp", headers: { ...json, authorization: `Bearer ${server.token}` }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.ok(!tools.text.includes("approve"), "no MCP tool approves a draft");
  assert.deepEqual((await seedOf(data, "buyer")).workflows.map(({ name }) => name), ["answer-in-tables"], "no run is given it while it waits");
  // The console: its session, its own origin, a JSON body, under If-Match.
  const stale = await approve({ ...json, cookie, origin, "if-match": '"0000000000000000000000000000000000000000"' });
  assert.equal(stale.status, 412, stale.text);
  const approved = await approve({ ...json, cookie, origin });
  assert.equal(approved.status, 200, approved.text);
  assert.doesNotMatch(approved.text, /status: pending/);
  assert.equal(git(repo, ["show", `main:${README}`]), `---\nname: ${WAITS}\ndescription: Buys office paper from PaperDepot24 first\n---`, "active, its status line dropped and nothing else (git() trims)");
  assert.deepEqual(git(repo, ["log", "-1", "--format=%an%n%s%n%b", "main"]).split("\n").filter(Boolean), ["agentrun-serve", `learning: approved by a person: ${README}`, "Changed-By: user", "Approved-Via: console"]);
  const [top] = (await api("GET", "/agents/buyer/learning/log")).body.items;
  assert.deepEqual([top.by, top.reason, top.files], [{ user: true, via: "console" }, `approved by a person: ${README}`, [README]]);
  assert.ok(Date.parse(top.at) > 0 && !JSON.stringify(top).includes("Buys office paper"), "when, and never the draft's text");
  assert.equal((await approve({ ...json, cookie, origin, "if-match": approved.headers.etag })).status, 400, "an active draft is not waiting");
  // Capabilities, as each caller reads them: the owner's password session may approve; the token, on the same server,
  // reads what approving needs.
  assert.deepEqual(JSON.parse((await call(port, { path: "/v2/capabilities", headers: { cookie } })).text).learning, { pending: true, approve: true });
  assert.deepEqual((await api("GET", "/capabilities")).body.learning, { pending: true, approve: false, approve_needs: "password" });
  // The next run starts from it: its seed lays it.
  assert.deepEqual((await seedOf(data, "buyer")).workflows.map(({ name }) => name).sort(), ["answer-in-tables", WAITS]);
});

test("a run's own credentials cannot approve: each secret the runner holds for its runs, and the server's token, are refused on approve, and the draft stays pending", { timeout: 150_000 }, async (t) => {
  // A key the runner holds for its runs (a key-named value in its environment): what a run on the runner could read.
  const held = `not-a-secret-${"held"}-${randomBytes(12).toString("hex")}`;
  const { withEnv } = await import("./support.mjs");
  withEnv(t, { LEARN_PROBE_API_KEY: held });
  const server = await learnedPending(t, { accounts: true, openSetup: true });
  const { api, port, repo } = server;
  const etag = (await api("GET", FILE)).headers.get("etag");
  for (const value of [held, server.token]) {
    const res = await call(port, { method: "POST", path: `/v2${FILE}/approve`, headers: { ...json, origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${value}`, "if-match": etag }, body: {} });
    assert.ok(res.status === 401 || res.status === 403, `a credential a run could hold: ${res.status} ${res.text}`);
  }
  assert.match(git(repo, ["show", `main:${README}`]), /status: pending/, "nothing approved it");
});

test("with accounts off nothing approves, the launch link's console session included, and capabilities say so", { timeout: 150_000 }, async (t) => {
  const server = await learnedPending(t);
  const { api, port } = server;
  const unavailable = { pending: true, approve: false, approve_needs: "password" };
  assert.deepEqual((await api("GET", "/capabilities")).body.learning, unavailable);
  // The launch link sets the accounts-off console session: no password session, so it approves nothing.
  const link = await call(port, { path: `/?launch=${server.launchCode}` });
  const cookie = cookieOf(link);
  assert.ok(cookie, "the link sets the page's cookie");
  assert.deepEqual(JSON.parse((await call(port, { path: "/v2/capabilities", headers: { cookie } })).text).learning, unavailable, "the page reads why it can't");
  const etag = (await api("GET", FILE)).headers.get("etag");
  const origin = `http://127.0.0.1:${port}`;
  const res = await call(port, { method: "POST", path: `/v2${FILE}/approve`, headers: { ...json, cookie, origin, "if-match": etag }, body: {} });
  assert.equal(res.status, 403, res.text);
});
