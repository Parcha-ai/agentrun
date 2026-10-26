// People and who did what, with accounts on: one role table that denies a route it does not name, the admin's People
// routes (the owner is never disabled or demoted, nobody sets their own role), no self-promotion through any endpoint
// the library serves, and the activity log taken from the credential alone.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { ACCOUNT_ROUTES, permits, ROUTE_ROLES, ROUTES } from "../dist/server.js";
import { asPerson, call, client, FAUX, follow, OWNER, scratch, signIn, withOwner } from "./support.mjs";

const BO = { email: "bo@example.com", name: "Bo", password: "bo's long password" };

/** The owner's server with Bo, a member, signed in. */
async function withMember(t) {
  const server = await withOwner(t);
  const { id } = await server.addPerson({ ...BO, role: "member" });
  const { res, cookie } = await signIn(server, BO.email, BO.password);
  assert.equal(res.status, 200, res.text);
  return { ...server, bo: id, boCookie: cookie };
}

test("one table names every route's least role; a route it does not name is denied to everyone, admins included", () => {
  const names = [...ROUTES, ...ACCOUNT_ROUTES].map((route) => route.name);
  for (const name of names) assert.ok(Object.hasOwn(ROUTE_ROLES, name), `${name} has a role`);
  for (const route of ROUTES) assert.ok(["member", "none"].includes(ROUTE_ROLES[route.name]), `${route.name}: every route there was is a member's`);
  assert.deepEqual(Object.entries(ROUTE_ROLES).filter(([, role]) => role === "admin").map(([name]) => name).sort(), ["listPeople", "updatePerson"]);
  const admin = { kind: "person", id: "a", role: "admin" };
  const member = { kind: "person", id: "m", role: "member" };
  for (const who of [admin, member, { kind: "token", role: "admin" }]) {
    assert.equal(permits(who, "noSuchRoute"), false);
    assert.equal(permits(who, "toString"), false, "nothing inherited counts");
  }
  assert.equal(permits(member, "listPeople"), false);
  assert.equal(permits(admin, "listPeople"), true);
  assert.equal(permits(member, "createRun"), true);
});

test("a member works on every agent and run, sees who they are, and gets 403 on the People routes", async (t) => {
  const server = await withMember(t);
  const bo = asPerson(server, server.boCookie);
  const me = await bo("GET", "/me");
  assert.deepEqual([me.status, me.json.kind, me.json.id, me.json.role, me.json.owner], [200, "person", server.bo, "member", false]);
  assert.equal((await bo("POST", "/agents", { definition: { id: "bos", name: "bos", instructions: "Answer.", tools: [] } })).status, 201);
  assert.equal((await bo("GET", "/agents")).status, 200);
  assert.equal((await bo("GET", "/activity")).status, 200);
  for (const [method, path] of [["GET", "/people"], ["PATCH", `/people/${server.bo}`], ["PATCH", `/people/${server.owner.id}`]]) {
    const res = await bo(method, path, { role: "admin" });
    assert.deepEqual([res.status, res.json.error.code], [403, "forbidden"], `${method} ${path}`);
  }
  const token = await call(server.port, { path: "/v2/me", headers: { authorization: `Bearer ${server.token}` } });
  assert.deepEqual(token.json, { kind: "token", id: null, name: null, email: null, role: "admin", owner: false }, "the token is still the bootstrap credential");
});

test("an admin changes a role or disables a person, which ends all their sessions; the owner is never disabled or demoted, and nobody sets their own role", async (t) => {
  const server = await withMember(t);
  const ana = asPerson(server, server.cookie);
  const people = await ana("GET", "/people");
  assert.deepEqual(people.json.people.map((p) => [p.email, p.role, p.owner, p.disabled]), [[OWNER.email, "admin", true, false], [BO.email, "member", false, false]]);
  for (const [body, field] of [[{}, "role"], [{ role: "owner" }, "role"], [{ disabled: "yes" }, "disabled"], [{ email: "x@example.com" }, "email"]]) {
    const res = await ana("PATCH", `/people/${server.bo}`, body);
    assert.deepEqual([res.status, res.json.error.code, res.json.error.fields[0].field], [422, "input_invalid", field], JSON.stringify(body));
  }
  assert.equal((await ana("PATCH", "/people/nobody", { role: "admin" })).status, 404);
  for (const body of [{ role: "member" }, { disabled: true }, { role: "admin" }]) {
    const self = await ana("PATCH", `/people/${server.owner.id}`, body);
    assert.deepEqual([self.status, self.json.error.code], [403, "forbidden"], `the owner on themselves: ${JSON.stringify(body)}`);
  }
  const promoted = await ana("PATCH", `/people/${server.bo}`, { role: "admin" });
  assert.deepEqual([promoted.status, promoted.json.role], [200, "admin"]);
  assert.equal((await call(server.port, { path: "/v2/me", headers: { cookie: server.boCookie } })).status, 401, "a role change ends the person's sessions");
  const again = await signIn(server, BO.email, BO.password);
  const bo = asPerson(server, again.cookie);
  assert.equal((await bo("GET", "/people")).status, 200, "the new session carries the new role");
  for (const body of [{ role: "member" }, { disabled: true }]) {
    const res = await bo("PATCH", `/people/${server.owner.id}`, body);
    assert.deepEqual([res.status, res.json.error.code], [403, "forbidden"], `another admin on the owner: ${JSON.stringify(body)}`);
  }
  assert.equal((await bo("PATCH", `/people/${server.bo}`, { role: "member" })).status, 403, "not even down");
  const disabled = await ana("PATCH", `/people/${server.bo}`, { disabled: true });
  assert.deepEqual([disabled.status, disabled.json.disabled], [200, true]);
  assert.equal((await bo("GET", "/me")).status, 401, "disabling ends the person's sessions");
  const refused = await signIn(server, BO.email, BO.password);
  assert.equal(refused.res.status, 403, "and they cannot sign in");
  assert.equal(refused.cookie, "");
  const enabled = await ana("PATCH", `/people/${server.bo}`, { disabled: false });
  assert.deepEqual([enabled.status, enabled.json.disabled, enabled.json.role], [200, false, "admin"]);
});

test("a member cannot make themselves more through any endpoint the library serves: role, owner, banned and emailVerified stay the server's", async (t) => {
  const server = await withMember(t);
  const raise = { role: "admin", owner: true, banned: false, emailVerified: true, banReason: "x" };
  const first = await signIn(server, BO.email, BO.password, raise);
  assert.equal(first.res.status, 200);
  const bo = (path, body, cookie = server.boCookie) => call(server.port, { method: "POST", path: `/v2/auth${path}`, headers: { cookie, origin: server.origin, "content-type": "application/json" }, body });
  const update = await bo("/update-user", { name: "Bob", ...raise });
  assert.deepEqual([update.status, update.json.error.code, update.json.error.fields.map((f) => f.field).sort()], [422, "input_invalid", ["banReason", "banned", "emailVerified", "owner", "role"]]);
  assert.equal((await bo("/update-user", { name: "Bob" })).status, 200, "the name is theirs to set");
  const changed = await bo("/change-password", { currentPassword: BO.password, newPassword: "bo's newer long password", ...raise });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await call(server.port, { path: "/v2/me", headers: { cookie: first.cookie } })).status, 401, "a new password ends the person's other sessions");
  const now = changed.headers["set-cookie"].map((line) => line.split(";")[0]).join("; ");
  for (const path of ["/revoke-other-sessions", "/revoke-session", "/sign-out"]) assert.ok([200, 400].includes((await bo(path, { token: "none", ...raise }, now)).status), path);
  const db = new DatabaseSync(join(server.data, "auth.sqlite"), { readOnly: true });
  t.after(() => db.close());
  const row = db.prepare(`SELECT name, role, owner, banned, banReason, emailVerified FROM "user" WHERE id = ?`).get(server.bo);
  assert.deepEqual({ ...row }, { name: "Bob", role: "member", owner: 0, banned: 0, banReason: null, emailVerified: 0 });
});

test("who did it: every change to an agent or a run is kept with the principal that authenticated it, shown on the revision list and the activity routes, never on the contract's answers", async (t) => {
  const server = await withOwner(t);
  const ana = asPerson(server, server.cookie);
  const token = client(server.baseUrl, server.token);
  assert.equal((await ana("POST", "/agents", { definition: { id: "calc", name: "calc", instructions: "Answer.", tools: [] } })).status, 201);
  const first = (await token("GET", "/agents/calc/revisions")).body.revisions[0].revision;
  assert.equal((await token("PUT", "/agents/calc/definition", { definition: { instructions: "Answer at once." } })).status, 200);
  assert.equal((await ana("POST", "/agents/calc/current", { revision: first })).status, 200);
  assert.equal((await ana("POST", "/agents/calc/archive")).status, 200);
  assert.equal((await token("POST", "/agents/calc/unarchive")).status, 200);
  const run = await token("POST", "/agents/calc/runs", { input: { content: "Take your time" } });
  assert.equal(run.status, 202);
  const runId = run.body.run_id;
  assert.equal((await ana("POST", `/runs/${runId}/messages`, { content: "Hurry up." })).status, 202);
  assert.equal((await ana("POST", `/runs/${runId}/stop`)).status, 200);
  assert.equal((await token("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(token, runId, ["cancelled"]);
  assert.equal((await ana("POST", `/runs/${runId}/archive`)).status, 200);
  assert.equal((await ana("POST", `/runs/${runId}/unarchive`)).status, 200);
  const anaBy = { kind: "person", id: server.owner.id, name: OWNER.name };
  const tokenBy = { kind: "token", id: null, name: null };
  const ofRun = await ana("GET", `/runs/${runId}/activity`);
  assert.equal(ofRun.status, 200);
  assert.deepEqual(ofRun.json.activity.map((a) => [a.action, a.by, a.run_id, a.agent_id]), [
    ["run.unarchive", anaBy, runId, "calc"], ["run.archive", anaBy, runId, "calc"], ["run.cancel", tokenBy, runId, "calc"],
    ["run.stop", anaBy, runId, "calc"], ["run.message", anaBy, runId, "calc"], ["run.create", tokenBy, runId, "calc"],
  ]);
  assert.match(ofRun.json.activity[0].at, /^\d{4}-\d\d-\d\dT/);
  const ofAgent = await token("GET", "/activity?agent=calc");
  assert.deepEqual(ofAgent.body.activity.slice(6).map((a) => [a.action, a.by.kind]), [["agent.unarchive", "token"], ["agent.archive", "person"], ["agent.set_current", "person"], ["agent.update", "token"], ["agent.create", "person"]]);
  assert.equal(ofAgent.body.next_cursor, null);
  const paged = await token("GET", "/activity?agent=calc&limit=4");
  assert.equal(paged.body.activity.length, 4);
  assert.equal((await token("GET", `/activity?agent=calc&limit=4&cursor=${paged.body.next_cursor}`)).body.activity[0].action, "run.message");
  assert.deepEqual((await token("GET", "/activity?agent=other")).body.activity, []);
  const revisions = (await ana("GET", "/agents/calc/revisions")).json.revisions;
  assert.deepEqual(revisions.map((r) => [r.version, r.by]).sort(), [[1, anaBy], [2, tokenBy]]);
  for (const answer of [(await ana("GET", "/agents/calc")).json, (await ana("GET", `/runs/${runId}`)).json, ...(await ana("GET", "/runs")).json.runs, ...(await ana("GET", "/agents")).json.agents]) {
    assert.equal("by" in answer, false, "the contract's answers carry no one");
  }
  assert.equal((await call(server.port, { path: `/v2/runs/${runId}/activity` })).status, 401);
  assert.equal((await ana("GET", "/runs/run_missing/activity")).status, 404);
});

test("no GET changes anything: walking every GET route as a signed-in person writes no activity and moves no agent", async (t) => {
  const server = await withOwner(t);
  const ana = asPerson(server, server.cookie);
  assert.equal((await ana("POST", "/agents", { definition: { id: "calc", name: "calc", instructions: "Answer.", tools: [] } })).status, 201);
  const run = await ana("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  await follow(client(server.baseUrl, server.token), run.json.run_id, ["completed"]);
  const before = { activity: (await ana("GET", "/activity")).json.activity, agent: (await ana("GET", "/agents/calc")).headers.etag };
  const ids = { agent: "calc", run: run.json.run_id };
  for (const route of [...ROUTES, ...ACCOUNT_ROUTES].filter((r) => r.method === "GET")) {
    const path = route.pattern.source.replace(/^\^\\\//, "/").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\(\.\+\)/, "answer.txt").replace(/\(\[\^\/\]\+\)/, route.name.match(/Run|Timeline|File|Activity/) && route.name !== "listRuns" ? ids.run : ids.agent);
    const res = await ana("GET", path);
    assert.notEqual(res.status, 500, `${route.name} ${path}`);
  }
  assert.deepEqual({ activity: (await ana("GET", "/activity")).json.activity, agent: (await ana("GET", "/agents/calc")).headers.etag }, before);
});

test("the activity log is kept across restarts in the accounts database", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: FAUX, accounts: true });
  let closed;
  const close = () => (closed ??= one.close());
  t.after(close);
  assert.equal((await client(one.baseUrl, one.token)("POST", "/agents", { definition: { id: "kept", name: "kept", instructions: "Answer.", tools: [] } })).status, 201);
  await close();
  const two = await startServe({ data, port: 0, faux: FAUX, accounts: true });
  t.after(() => two.close());
  const api = client(two.baseUrl, two.token);
  assert.deepEqual((await api("GET", "/activity")).body.activity.map((a) => [a.action, a.agent_id, a.by.kind]), [["agent.create", "kept", "token"]]);
  assert.equal((await api("GET", "/agents/kept/revisions")).body.revisions[0].by.kind, "token");
});
