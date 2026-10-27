// No passwords on day one: the library's password endpoints are the 404 every unknown path is, setup takes no password
// and signs the owner in, nobody's password hash is stored, and the pages ask for none.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { call, cookieOf, serve } from "./support.mjs";

const json = { "content-type": "application/json" };
const PASSWORD_PATHS = ["/sign-in/email", "/change-password", "/sign-up/email", "/reset-password", "/forget-password", "/request-password-reset", "/verify-password", "/set-password"];
/** The magic-link plugin is loaded for setup's sign-in, and none of its endpoints is a client's yet. */
const MAGIC_LINK_PATHS = ["/sign-in/magic-link", "/magic-link/verify"];

/** An answer as the unknown path `path` would give it: status, error code, retryable, and message with the path cut. */
const shapeOf = (res, path) => ({ status: res.status, allow: res.headers.allow, setCookie: res.headers["set-cookie"], keys: Object.keys(res.json?.error ?? {}).sort(), code: res.json?.error?.code, retryable: res.json?.error?.retryable, message: res.json?.error?.message?.replace(path, "<path>") });

test("every password endpoint and every magic-link endpoint under /v2/auth answers exactly what an unknown path does, on every method, signed in by the token or by nothing", async (t) => {
  const server = await serve(t, { accounts: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const unknown = "/v2/auth/no-such-endpoint";
  for (const headers of [{ ...json, origin }, { ...json, origin, authorization: `Bearer ${server.token}` }]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      // DELETE goes without a body: node sends one with no length, which no server can frame.
      const body = method === "GET" || method === "DELETE" ? undefined : { email: "ana@example.com", password: "correct horse battery", newPassword: "another long password", currentPassword: "correct horse battery", token: "t" };
      const expected = shapeOf(await call(server.port, { method, path: unknown, headers, body }), unknown);
      assert.equal(expected.status, 404);
      for (const path of [...PASSWORD_PATHS, ...MAGIC_LINK_PATHS].map((p) => `/v2/auth${p}`)) {
        const res = await call(server.port, { method, path, headers, body });
        assert.deepEqual(shapeOf(res, path), expected, `${method} ${path}`);
      }
    }
  }
});

test("setup takes no password: a password field is a 422 not_allowed, and {name, email} makes the owner and signs them in at once", async (t) => {
  const server = await serve(t, { accounts: true });
  const bearer = { ...json, authorization: `Bearer ${server.token}` };
  const refused = await call(server.port, { method: "POST", path: "/v2/setup", headers: bearer, body: { name: "Ana", email: "ana@example.com", password: "correct horse battery" } });
  assert.equal(refused.status, 422, refused.text);
  assert.deepEqual([refused.status, refused.json.error.code, refused.json.error.fields.map((f) => [f.field, f.reason])], [422, "input_invalid", [["password", "not_allowed"]]]);
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: bearer, body: { name: "Ana", email: "ana@example.com" } });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.headers["set-cookie"].length, 1);
  const me = await call(server.port, { path: "/v2/me", headers: { cookie: cookieOf(made) } });
  assert.deepEqual([me.status, me.json.email, me.json.owner], [200, "ana@example.com", true], "the 201 carries the owner's session");
});

test("no password hash is stored for anyone: the owner from setup, the owner from the environment and a person added server-side have no credential", async (t) => {
  const server = await serve(t, { accounts: true });
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, authorization: `Bearer ${server.token}` }, body: { name: "Ana", email: "ana@example.com" } });
  assert.equal(made.status, 201, made.text);
  await server.addPerson({ email: "bo@example.com", name: "Bo", role: "member" });
  const headless = await serve(t, { accounts: true, owner: { email: "ops@example.com" } });
  for (const data of [server.data, headless.data]) {
    const db = new DatabaseSync(join(data, "auth.sqlite"), { readOnly: true });
    t.after(() => db.close());
    assert.ok(db.prepare(`SELECT count(*) AS n FROM "user"`).get().n >= 1, "the check reads people that exist");
    assert.deepEqual(db.prepare("SELECT providerId, password FROM account").all().map((row) => ({ ...row })), [], data);
  }
});

test("the setup and sign-in pages and their scripts ask for no password; the sign-in page has no form and no script yet", async (t) => {
  const server = await serve(t, { accounts: true });
  const texts = {};
  for (const path of ["/setup", "/setup.js"]) {
    const res = await call(server.port, { path });
    assert.equal(res.status, 200, path);
    texts[path] = res.text;
  }
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, authorization: `Bearer ${server.token}` }, body: { name: "Ana", email: "ana@example.com" } });
  assert.equal(made.status, 201, made.text);
  const signIn = await call(server.port, { path: "/sign-in" });
  assert.equal(signIn.status, 200);
  texts["/sign-in"] = signIn.text;
  assert.doesNotMatch(signIn.text, /<form|<input|<script/i, "nothing to fill in until sign-in links");
  assert.equal((await call(server.port, { path: "/sign-in.js" })).status, 404);
  for (const [path, text] of Object.entries(texts)) {
    assert.ok(text.length > 100, `${path} was read`);
    assert.doesNotMatch(text, /password/i, path);
  }
});
