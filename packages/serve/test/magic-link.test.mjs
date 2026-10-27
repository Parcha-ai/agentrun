// Sign-in links: a person an admin added asks for a link by email, gets it mailed (or printed to the server's log
// without SMTP), and opens it once, within 15 minutes, to a session. Every email gets the same answer.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { asPerson, call, cookieOf, withOwner } from "./support.mjs";

const BO = { email: "bo@example.com", name: "Bo" };

/** The owner's server whose sign-in links land in `sent`. */
async function withMail(t) {
  const sent = [];
  const server = await withOwner(t, { mail: async (message) => void sent.push(message) });
  const ask = (email) => call(server.port, { method: "POST", path: "/v2/auth/request-link", headers: { "content-type": "application/json", origin: server.origin }, body: { email } });
  /** The path of the last link sent to `email`. */
  const linkOf = (email) => {
    const message = sent.findLast((m) => m.to === email);
    assert.ok(message, `a link went to ${email}`);
    const url = new URL(/https?:\/\/\S+\/v2\/auth\/verify\?token=\S+/.exec(message.text)[0]);
    return `${url.pathname}${url.search}`;
  };
  return { ...server, sent, ask, linkOf };
}

test("an admin adds a person, who asks for a link and opens it to a session as themselves", async (t) => {
  const server = await withMail(t);
  const added = await asPerson(server, server.cookie)("POST", "/people", BO);
  assert.deepEqual([added.status, added.json.email, added.json.role, added.json.disabled], [201, BO.email, "member", false], added.text);
  const asked = await server.ask(BO.email);
  assert.deepEqual([asked.status, asked.json.sent], [200, true], asked.text);
  assert.equal(server.sent.length, 1);
  assert.match(server.sent[0].text, /works once, within 15 minutes/);
  const opened = await call(server.port, { path: server.linkOf(BO.email) });
  assert.deepEqual([opened.status, opened.headers.location], [303, "/"], opened.text);
  const me = await call(server.port, { path: "/v2/me", headers: { cookie: cookieOf(opened) } });
  assert.deepEqual([me.status, me.json.email, me.json.role], [200, BO.email, "member"], me.text);
});

test("a link signs in once: opened again it goes back to the sign-in page with no session", async (t) => {
  const server = await withMail(t);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  await server.ask(BO.email);
  const link = server.linkOf(BO.email);
  assert.equal((await call(server.port, { path: link })).headers.location, "/");
  const again = await call(server.port, { path: link });
  assert.deepEqual([again.status, again.headers.location, again.headers["set-cookie"]], [303, "/sign-in#link=invalid", undefined]);
});

test("a link more than 15 minutes old signs nobody in", async (t) => {
  const server = await withMail(t);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  await server.ask(BO.email);
  const db = new DatabaseSync(join(server.data, "auth.sqlite"));
  t.after(() => db.close());
  const aged = db.prepare(`UPDATE verification SET expiresAt = ? WHERE expiresAt > ?`).run(new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());
  assert.ok(aged.changes >= 1, "the link's record was aged");
  const opened = await call(server.port, { path: server.linkOf(BO.email) });
  assert.deepEqual([opened.status, opened.headers.location, opened.headers["set-cookie"]], [303, "/sign-in#link=invalid", undefined]);
});

test("an unknown email, a disabled person and a known one get the same answer; only the known one gets a link", async (t) => {
  const server = await withMail(t);
  const added = await asPerson(server, server.cookie)("POST", "/people", BO);
  const cy = await asPerson(server, server.cookie)("POST", "/people", { email: "cy@example.com" });
  assert.equal((await asPerson(server, server.cookie)("PATCH", `/people/${cy.json.id}`, { disabled: true })).status, 200);
  const answers = [];
  for (const email of [BO.email, "nobody@example.com", "cy@example.com"]) {
    const res = await server.ask(email);
    answers.push({ status: res.status, body: res.text, setCookie: res.headers["set-cookie"] });
  }
  assert.equal(added.status, 201);
  assert.deepEqual(answers[1], answers[0], "an unknown email is answered as a known one");
  assert.deepEqual(answers[2], answers[0], "a disabled person is answered as a known one");
  assert.deepEqual(server.sent.map((m) => m.to), [BO.email]);
});

test("without SMTP the link is printed to the server's log", async (t) => {
  const server = await withOwner(t);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (said.push(String(chunk)), write.call(process.stderr, chunk, ...rest));
  t.after(() => void (process.stderr.write = write));
  const asked = await call(server.port, { method: "POST", path: "/v2/auth/request-link", headers: { "content-type": "application/json", origin: server.origin }, body: { email: BO.email } });
  assert.equal(asked.status, 200);
  const line = said.find((s) => s.includes(`sign-in link for ${BO.email}`));
  assert.ok(line, said.join(""));
  const path = new URL(/https?:\/\/\S+\/v2\/auth\/verify\?token=\S+/.exec(line)[0]);
  assert.equal((await call(server.port, { path: `${path.pathname}${path.search}` })).headers.location, "/");
});

test("asking for a link is a write: from another origin it is refused, and a body with more than the email is a 422", async (t) => {
  const server = await withMail(t);
  const foreign = await call(server.port, { method: "POST", path: "/v2/auth/request-link", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: { email: BO.email } });
  assert.equal(foreign.status, 403, foreign.text);
  const extra = await server.ask(undefined).then(() => call(server.port, { method: "POST", path: "/v2/auth/request-link", headers: { "content-type": "application/json", origin: server.origin }, body: { email: BO.email, redirect: "https://evil.example" } }));
  assert.deepEqual([extra.status, extra.json.error.fields.map((f) => f.field).sort()], [422, ["redirect"]]);
  assert.equal((await call(server.port, { path: "/v2/auth/request-link" })).status, 405);
});

test("only an admin adds people: a member is refused, an email that is here already and a bad email are 422s", async (t) => {
  const server = await withMail(t);
  const added = await asPerson(server, server.cookie)("POST", "/people", BO);
  assert.equal(added.status, 201);
  await server.ask(BO.email);
  const bo = asPerson(server, cookieOf(await call(server.port, { path: server.linkOf(BO.email) })));
  assert.deepEqual([(await bo("POST", "/people", { email: "dee@example.com" })).status], [403]);
  const twice = await asPerson(server, server.cookie)("POST", "/people", { email: "BO@example.com" });
  assert.deepEqual([twice.status, twice.json.error.fields.map((f) => [f.field, f.reason])], [422, [["email", "not_an_option"]]]);
  const bad = await asPerson(server, server.cookie)("POST", "/people", { email: "not an email" });
  assert.deepEqual([bad.status, bad.json.error.fields.map((f) => f.field)], [422, ["email"]]);
});
