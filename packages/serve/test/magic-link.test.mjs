// Sign-in links: a person an admin added asks for a link by email and gets it mailed, or printed to the server's log
// without SMTP. The link opens the sign-in page with its token in the fragment; only the page's Continue (a same-origin
// POST) spends it, once, within 15 minutes. Every email gets the same answer, as fast.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { asPerson, call, cookieOf, withOwner } from "./support.mjs";

const BO = { email: "bo@example.com", name: "Bo" };
const json = { "content-type": "application/json" };

/** The link in `text`: its page's path, and the token and email in its fragment. */
function linkIn(text) {
  const url = new URL(/https?:\/\/\S+\/sign-in#token=\S+/.exec(text)[0]);
  const fragment = new URLSearchParams(url.hash.slice(1));
  return { path: url.pathname, token: fragment.get("token"), email: fragment.get("email") };
}

/** The owner's server whose sign-in links land in `sent`, each after `delayMs`. */
async function withMail(t, delayMs = 0) {
  const sent = [];
  const server = await withOwner(t, { mail: async (message) => void (await new Promise((resolve) => setTimeout(resolve, delayMs)), sent.push(message)) });
  const ask = (email) => call(server.port, { method: "POST", path: "/v2/auth/request-link", headers: { ...json, origin: server.origin }, body: { email } });
  const until = async (n) => {
    for (let i = 0; sent.length < n; i++) {
      assert.ok(i < 100, `${n} links sent`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const verify = (token) => call(server.port, { method: "POST", path: "/v2/auth/verify", headers: { ...json, origin: server.origin }, body: { token } });
  /** The last link sent to `email`, once it is sent. */
  const linkOf = async (email, n = 1) => (await until(n), linkIn(sent.findLast((m) => m.to === email).text));
  return { ...server, sent, ask, verify, linkOf, until };
}

test("an admin adds a person, who asks for a link; fetching the link spends nothing, and Continue signs them in as themselves", async (t) => {
  const server = await withMail(t);
  const added = await asPerson(server, server.cookie)("POST", "/people", BO);
  assert.deepEqual([added.status, added.json.email, added.json.role, added.json.disabled], [201, BO.email, "member", false], added.text);
  const asked = await server.ask(BO.email);
  assert.deepEqual([asked.status, asked.json.sent], [200, true], asked.text);
  const link = await server.linkOf(BO.email);
  assert.match(server.sent[0].text, /works once, within 15 minutes/);
  assert.deepEqual([link.path, link.email], ["/sign-in", BO.email]);
  const fetched = await call(server.port, { path: link.path });
  assert.deepEqual([fetched.status, fetched.headers["set-cookie"]], [200, undefined], "a scanner's fetch of the link gets the page and no session");
  assert.match(fetched.text, /Continue/);
  const opened = await server.verify(link.token);
  assert.deepEqual([opened.status, opened.json.signed_in], [200, true], opened.text);
  const me = await call(server.port, { path: "/v2/me", headers: { cookie: cookieOf(opened) } });
  assert.deepEqual([me.status, me.json.email, me.json.role], [200, BO.email, "member"], me.text);
});

test("a link signs in once: its token posted again is a 401 with no cookie", async (t) => {
  const server = await withMail(t);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  await server.ask(BO.email);
  const { token } = await server.linkOf(BO.email);
  assert.equal((await server.verify(token)).status, 200);
  const again = await server.verify(token);
  assert.deepEqual([again.status, again.json.error.code, again.headers["set-cookie"]], [401, "unauthenticated", undefined]);
});

test("a link more than 15 minutes old signs nobody in", async (t) => {
  const server = await withMail(t);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  await server.ask(BO.email);
  const { token } = await server.linkOf(BO.email);
  const db = new DatabaseSync(join(server.data, "auth.sqlite"));
  t.after(() => db.close());
  const aged = db.prepare(`UPDATE verification SET expiresAt = ? WHERE expiresAt > ?`).run(new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());
  assert.ok(aged.changes >= 1, "the link's record was aged");
  const opened = await server.verify(token);
  assert.deepEqual([opened.status, opened.headers["set-cookie"]], [401, undefined]);
});

test("an unknown email, a disabled person and a known one get the same answer as fast, though mail takes 800 ms; only the known one gets a link", async (t) => {
  const server = await withMail(t, 800);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  const cy = await asPerson(server, server.cookie)("POST", "/people", { email: "cy@example.com" });
  assert.equal((await asPerson(server, server.cookie)("PATCH", `/people/${cy.json.id}`, { disabled: true })).status, 200);
  await server.until(2);
  const answers = [];
  for (const email of [BO.email, "nobody@example.com", "cy@example.com"]) {
    const from = Date.now();
    const res = await server.ask(email);
    answers.push({ status: res.status, body: res.text, setCookie: res.headers["set-cookie"], fast: Date.now() - from < 200 });
  }
  assert.deepEqual(answers[0], { status: 200, body: answers[0].body, setCookie: undefined, fast: true }, "a known email is answered before its mail goes");
  assert.deepEqual(answers[1], answers[0], "an unknown email is answered as a known one");
  assert.deepEqual(answers[2], answers[0], "a disabled person is answered as a known one");
  // Adding Bo and Cy mailed each a first link; of the three asks, only Bo's makes another.
  await server.until(3);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.deepEqual(server.sent.map((m) => m.to).sort(), [BO.email, BO.email, "cy@example.com"]);
});

test("without SMTP the link is printed to the server's log, and it signs in", async (t) => {
  const server = await withOwner(t);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (said.push(String(chunk)), write.call(process.stderr, chunk, ...rest));
  t.after(() => void (process.stderr.write = write));
  const asked = await call(server.port, { method: "POST", path: "/v2/auth/request-link", headers: { ...json, origin: server.origin }, body: { email: BO.email } });
  assert.equal(asked.status, 200);
  for (let i = 0; !said.some((s) => s.includes(`sign-in link for ${BO.email}`)); i++) {
    assert.ok(i < 100, said.join(""));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { token } = linkIn(said.find((s) => s.includes(`sign-in link for ${BO.email}`)));
  const opened = await call(server.port, { method: "POST", path: "/v2/auth/verify", headers: { ...json, origin: server.origin }, body: { token } });
  assert.equal(opened.status, 200, opened.text);
});

test("both are writes: from another origin they are refused, a body with more than its one field is a 422, and GET is a 405", async (t) => {
  const server = await withMail(t);
  for (const [path, body] of [["/v2/auth/request-link", { email: BO.email }], ["/v2/auth/verify", { token: "x" }]]) {
    const foreign = await call(server.port, { method: "POST", path, headers: { ...json, origin: "https://evil.example" }, body });
    assert.equal(foreign.status, 403, `${path}: ${foreign.text}`);
    const extra = await call(server.port, { method: "POST", path, headers: { ...json, origin: server.origin }, body: { ...body, redirect: "https://evil.example" } });
    assert.deepEqual([extra.status, extra.json.error.fields.map((f) => f.field).sort()], [422, ["redirect"]], path);
    assert.equal((await call(server.port, { path })).status, 405, path);
  }
});

test("only an admin adds people: a member is refused, an email that is here already and a bad email are 422s", async (t) => {
  const server = await withMail(t);
  assert.equal((await asPerson(server, server.cookie)("POST", "/people", BO)).status, 201);
  await server.ask(BO.email);
  const bo = asPerson(server, cookieOf(await server.verify((await server.linkOf(BO.email)).token)));
  assert.equal((await bo("POST", "/people", { email: "dee@example.com" })).status, 403);
  const twice = await asPerson(server, server.cookie)("POST", "/people", { email: "BO@example.com" });
  assert.deepEqual([twice.status, twice.json.error.fields.map((f) => [f.field, f.reason])], [422, [["email", "not_an_option"]]]);
  const bad = await asPerson(server, server.cookie)("POST", "/people", { email: "not an email" });
  assert.deepEqual([bad.status, bad.json.error.fields.map((f) => f.field)], [422, ["email"]]);
});

test("with no mail server, an admin's add answers the new person's one-time link, which signs them in once", async (t) => {
  const server = await withOwner(t);
  const added = await asPerson(server, server.cookie)("POST", "/people", BO);
  assert.equal(added.status, 201, added.text);
  const link = linkIn(added.json.sign_in_link);
  assert.equal(link.email, BO.email);
  const verify = () => call(server.port, { method: "POST", path: "/v2/auth/verify", headers: { ...json, origin: server.origin }, body: { token: link.token } });
  const opened = await verify();
  assert.equal(opened.status, 200, opened.text);
  const me = await call(server.port, { path: "/v2/me", headers: { cookie: cookieOf(opened) } });
  assert.equal(me.json.email, BO.email);
  assert.equal((await verify()).status, 401, "once");
});

test("with a mail server, an admin's add answers no link and mails it", async (t) => {
  const server = await withMail(t);
  const added = await asPerson(server, server.cookie)("POST", "/people", BO);
  assert.equal(added.status, 201, added.text);
  assert.equal(added.json.sign_in_link, undefined);
  assert.equal((await server.linkOf(BO.email)).email, BO.email);
});
