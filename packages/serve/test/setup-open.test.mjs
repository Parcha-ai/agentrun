// The first run with no public address (the CLI with no AGENTRUN_PUBLIC_URL, as `docker run` gives it): the first person
// to open the page creates the owner's account, with no setup code, and is signed in. Exactly one owner, ever; a server
// with a public address still takes the code; writes from any other origin are refused.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { call, cookieOf, serve } from "./support.mjs";

const json = { "content-type": "application/json" };
const setup = (server, body, origin = `http://127.0.0.1:${server.port}`) => call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body });

test("a fresh server with open setup: its link has no code, the first account made is the owner and signed in, and a second setup is 403", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true });
  assert.match(server.setupUrl, /^http:\/\/127\.0\.0\.1:\d+\/setup$/);
  const made = await setup(server, { name: "Ana", email: "ana@example.com" });
  assert.equal(made.status, 201, made.text);
  const me = await call(server.port, { path: "/v2/me", headers: { cookie: cookieOf(made) } });
  assert.deepEqual([me.json.email, me.json.owner, me.json.role], ["ana@example.com", true, "admin"]);
  const second = await setup(server, { name: "Bo", email: "bo@example.com" });
  assert.equal(second.status, 403, second.text);
});

test("three setups at once on a fresh open server make exactly one owner; the others are 403", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true });
  const answers = await Promise.all(["a", "b", "c"].map((who) => setup(server, { name: who, email: `${who}@example.com` })));
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 403, 403], answers.map((a) => a.text).join("\n"));
  const db = new DatabaseSync(join(server.data, "auth.sqlite"), { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare(`SELECT count(*) AS n FROM "user"`).get().n, 1);
});

test("without open setup (a public address), a setup with no code is 403 and makes nobody", async (t) => {
  const server = await serve(t, { accounts: true });
  assert.match(server.setupUrl, /#code=/);
  const refused = await setup(server, { name: "Ana", email: "ana@example.com" });
  assert.equal(refused.status, 403, refused.text);
  assert.match(refused.json.error.message, /setup code/);
});

test("listening on every address with open setup: the loopback origin makes the owner, any other origin is 403", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, host: "0.0.0.0" });
  assert.match(server.setupUrl, /^http:\/\/127\.0\.0\.1:\d+\/setup$/);
  const foreign = await setup(server, { name: "Eve", email: "eve@example.com" }, "http://192.0.2.1:7340");
  assert.equal(foreign.status, 403, foreign.text);
  const made = await setup(server, { name: "Ana", email: "ana@example.com" }, `http://localhost:${server.port}`);
  assert.equal(made.status, 201, made.text);
});
