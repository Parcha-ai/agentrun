// Accounts (AGENTRUN_ACCOUNTS=1): the accounts database and its secret, first-run setup with the printed code or from the
// environment, the address every link is built from, the library's allowlisted endpoints, sessions, the one write gate,
// rate limits per client address, and the setup and sign-in pages.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { call, client, cookieOf, FAUX, follow, OWNER, SHAPES, scratch, serve, shapesOf, startRun, withOwner } from "./support.mjs";

const json = { "content-type": "application/json" };
const DAY_MS = 86_400_000;
const codeOf = (setupUrl) => new URL(setupUrl).hash.slice("#code=".length);
const setup = (port, body, headers) => call(port, { method: "POST", path: "/v2/setup", headers: { ...json, ...headers }, body });

/** The accounts database of `data`, opened beside the server for what a test plants or reads. */
function authDb(t, data) {
  const db = new DatabaseSync(join(data, "auth.sqlite"));
  t.after(() => db.close());
  return db;
}

/** A server on `data` that the test may close itself, to start another on the same directory; closed after the test
 *  otherwise. */
async function started(t, data, options = {}) {
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, ...options });
  let closed;
  const close = () => (closed ??= server.close());
  t.after(close);
  return { ...server, close };
}

/** Lines the bin printed until `done` matches all of them, or it exits: its stdout, stderr and exit code. */
async function bin(t, args, env, done = /\?token=.*\n/) {
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const killer = setTimeout(() => child.kill("SIGTERM"), 15_000);
  t.after(() => (clearTimeout(killer), child.kill("SIGTERM")));
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  for await (const chunk of child.stdout) {
    out += chunk;
    if (done.test(out)) break;
  }
  const code = child.exitCode ?? (done.test(out) ? null : await new Promise((resolve) => child.once("exit", resolve)));
  return { out, err, code };
}

test("with accounts on: auth.sqlite (WAL) and .auth-secret are 0600, each start prints a fresh 128-bit setup code, the secret is kept, and the contract's answers keep their keys", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await started(t, data);
  assert.match(one.setupUrl, new RegExp(`^${one.url}/setup#code=[A-Za-z0-9_-]{22}$`));
  for (const name of ["auth.sqlite", ".auth-secret"]) assert.equal((await stat(join(data, name))).mode & 0o777, 0o600, name);
  const secret = await readFile(join(data, ".auth-secret"), "utf8");
  assert.match(secret, /^[A-Za-z0-9_-]{43}\n$/, "32 random bytes");
  const api = client(one.baseUrl, one.token);
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  await follow(api, run_id, ["completed"]);
  assert.deepEqual(await shapesOf(api, "calc", run_id), { ...SHAPES, revision: [...SHAPES.revision, "by"] }, "only the revision list, this server's own answer, says who");
  const off = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body, (await off.api("GET", "/capabilities")).body, "capabilities are the same with accounts off");
  await one.close();
  const two = await started(t, data);
  assert.notEqual(codeOf(two.setupUrl), codeOf(one.setupUrl), "a new code on each start");
  assert.equal(await readFile(join(data, ".auth-secret"), "utf8"), secret, "the secret is made once");
  const db = authDb(t, data);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ["user", "session", "account", "verification", "rateLimit", "activity"]) assert.ok(tables.includes(table), table);
});

test("setup takes the printed code from this server's origin only, keeps it through a refused form, and five wrong codes void it until the next start", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await started(t, data);
  const origin = `http://127.0.0.1:${one.port}`;
  const code = codeOf(one.setupUrl);
  for (const [why, headers] of [["no Origin", {}], ["another origin", { origin: "https://evil.example" }], ["the null origin", { origin: "null" }]]) {
    const refused = await setup(one.port, { code, ...OWNER }, headers);
    assert.deepEqual([refused.status, refused.json.error.code], [403, "forbidden"], why);
  }
  const form = await setup(one.port, { code, ...OWNER, password: "too short", extra: 1 }, { origin });
  assert.deepEqual([form.status, form.json.error.code, form.json.error.fields.map((f) => f.field).sort()], [422, "input_invalid", ["extra", "password"]]);
  assert.equal((await setup(one.port, { code, ...OWNER }, { origin, "content-type": "text/plain" })).status, 415);
  for (let i = 0; i < 5; i++) {
    const wrong = await setup(one.port, { code: `${code.slice(0, -1)}${code.endsWith("A") ? "B" : "A"}`, ...OWNER }, { origin });
    assert.deepEqual([wrong.status, wrong.json.error.code], [403, "forbidden"], `wrong code ${i + 1}`);
  }
  const voided = await setup(one.port, { code, ...OWNER }, { origin });
  assert.deepEqual([voided.status, voided.json.error.code], [403, "forbidden"], "the right code after five wrong ones");
  await one.close();
  const two = await started(t, data);
  const twoOrigin = `http://127.0.0.1:${two.port}`;
  const made = await setup(two.port, { code: codeOf(two.setupUrl), ...OWNER }, { origin: twoOrigin });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual({ ...made.json, id: undefined, created_at: undefined }, { id: undefined, name: "Ana", email: "ana@example.com", role: "admin", owner: true, disabled: false, created_at: undefined });
  const me = await call(two.port, { path: "/v2/me", headers: { cookie: cookieOf(made) } });
  assert.deepEqual([me.status, me.json.id, me.json.role, me.json.owner], [200, made.json.id, "admin", true], "setup signs the owner in");
  for (const headers of [{ origin: twoOrigin }, { authorization: `Bearer ${two.token}` }]) {
    const again = await setup(two.port, { code: codeOf(two.setupUrl), ...OWNER, email: "eve@example.com" }, headers);
    assert.deepEqual([again.status, again.json.error.code], [403, "forbidden"], "a code of the contract's closed list");
  }
});

test("the setup code is good for 30 minutes", async (t) => {
  const server = await serve(t, { accounts: true });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * 60_000 });
  const late = await setup(server.port, { code: codeOf(server.setupUrl), ...OWNER }, { origin: `http://127.0.0.1:${server.port}` });
  assert.deepEqual([late.status, late.json.error.code], [403, "forbidden"]);
});

/** A POST /v2/setup whose headers go now and whose body goes at `send()`: its answer. */
function heldSetup(port, body, headers) {
  const text = JSON.stringify(body);
  let send;
  const answer = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/v2/setup", headers: { ...json, ...headers, "content-length": Buffer.byteLength(text) } }, (res) => {
      let out = "";
      res.on("data", (chunk) => (out += chunk)).on("end", () => resolve({ status: res.statusCode, text: out }));
    });
    req.once("error", reject);
    req.flushHeaders();
    send = () => req.end(text);
  });
  return { answer, send: () => send() };
}

test("setups at the same moment make exactly one owner, with the token or with the one code; the code is spent once taken", async (t) => {
  const owners = (data) => authDb(t, data).prepare(`SELECT count(*) AS n FROM "user" WHERE owner = 1`).get().n;
  for (const how of ["token", "code"]) {
    const data = join(await scratch(t), "agents");
    const server = await started(t, data);
    const headers = how === "token" ? { authorization: `Bearer ${server.token}` } : { origin: `http://127.0.0.1:${server.port}` };
    const code = codeOf(server.setupUrl);
    // All three are in before any body: each has passed the server's first look at its headers when the bodies land.
    const held = [0, 1, 2].map((i) => heldSetup(server.port, { ...(how === "code" ? { code } : {}), ...OWNER, email: `owner${i}@example.com` }, headers));
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const request of held) request.send();
    const answers = await Promise.all(held.map((request) => request.answer));
    assert.deepEqual(answers.map((a) => a.status).sort(), [201, 403, 403], `${how}: ${answers.map((a) => a.text)}`);
    assert.equal(owners(data), 1, `${how}: one owner`);
    assert.equal(authDb(t, data).prepare(`SELECT count(*) AS n FROM "user"`).get().n, 1, `${how}: nobody else made`);
  }
});

test("the server's token as the Bearer stands in for the code, for scripts: no Origin needed; a wrong Bearer is a 401", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await started(t, data);
  const wrong = await setup(one.port, OWNER, { authorization: "Bearer not-the-token" });
  assert.deepEqual([wrong.status, wrong.json.error.code], [401, "unauthenticated"]);
  const made = await setup(one.port, OWNER, { authorization: `Bearer ${one.token}` });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.owner, true);
  await one.close();
  const two = await started(t, data);
  assert.equal(two.setupUrl, undefined, "no setup code once there is an owner");
});

test("headless: AGENTRUN_OWNER_EMAIL alone makes the owner at start, once; an address that is no email stops the start", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const one = await started(t, data, { owner: { email: "ops@example.com" } });
  assert.equal(one.setupUrl, undefined);
  const people = async (server) => (await call(server.port, { path: "/v2/people", headers: { authorization: `Bearer ${server.token}` } })).json.people.map((p) => [p.email, p.role, p.owner]);
  assert.deepEqual(await people(one), [["ops@example.com", "admin", true]]);
  const me = await call(one.port, { path: "/v2/me", headers: { cookie: await one.signInAs("ops@example.com") } });
  assert.deepEqual([me.status, me.json.email, me.json.owner], [200, "ops@example.com", true]);
  assert.equal((await call(one.port, { path: "/setup" })).headers.location, "/sign-in");
  await one.close();
  const two = await started(t, data, { owner: { email: "someone-else@example.com" } });
  assert.deepEqual(await people(two), [["ops@example.com", "admin", true]], "an owner is made only when there is none");
  await assert.rejects(started(t, join(dir, "other"), { owner: { email: "not an email" } }), /email/i);
});

test("the bin with AGENTRUN_ACCOUNTS=1 prints the setup link, none with AGENTRUN_OWNER_EMAIL; a non-loopback address without AGENTRUN_PUBLIC_URL stops it", { timeout: 30_000 }, async (t) => {
  const dir = await scratch(t);
  const on = await bin(t, ["--data", join(dir, "a"), "--port", "0"], { AGENTRUN_ACCOUNTS: "1" }, /Set up this server: .*\n/);
  assert.match(on.out, /^Set up this server: http:\/\/127\.0\.0\.1:\d+\/setup#code=[A-Za-z0-9_-]{22}$/m, on.out);
  const owned = await bin(t, ["--data", join(dir, "b"), "--port", "0"], { AGENTRUN_ACCOUNTS: "1", AGENTRUN_OWNER_EMAIL: "ops@example.com" });
  assert.equal(owned.code, null, owned.err);
  assert.doesNotMatch(owned.out, /Set up this server/);
  const db = authDb(t, join(dir, "b"));
  assert.deepEqual(db.prepare(`SELECT email, owner FROM "user"`).all().map((row) => [row.email, row.owner]), [["ops@example.com", 1]]);
  const open = await bin(t, ["--data", join(dir, "c"), "--port", "0", "--listen", "0.0.0.0"], { AGENTRUN_ACCOUNTS: "1", AGENTRUN_PUBLIC_URL: "" });
  assert.equal(open.code, 1, open.err);
  assert.match(open.err, /AGENTRUN_PUBLIC_URL/);
});

test("every link and the cookie come from the address fixed at start, never from Host: https gives __Host-agentrun-session, Secure, and only that origin may write", async (t) => {
  const dir = await scratch(t);
  await assert.rejects(started(t, join(dir, "a"), { host: "0.0.0.0" }), /AGENTRUN_PUBLIC_URL/);
  await assert.rejects(started(t, join(dir, "b"), { publicUrl: "https://agentrun.example.com/sub" }), /origin/);
  const publicUrl = "https://agentrun.example.com";
  const server = await serve(t, { accounts: true, host: "0.0.0.0", publicUrl });
  assert.match(server.setupUrl, /^https:\/\/agentrun\.example\.com\/setup#code=/);
  const code = codeOf(server.setupUrl);
  const forged = await setup(server.port, { code, ...OWNER }, { host: "evil.example", origin: "http://evil.example" });
  assert.equal(forged.status, 403, "an Origin that matches a forged Host is not this server's");
  const made = await setup(server.port, { code, ...OWNER }, { host: "evil.example", origin: publicUrl });
  assert.equal(made.status, 201, made.text);
  const [line, ...more] = made.headers["set-cookie"];
  assert.deepEqual(more, []);
  const [pair, ...attributes] = line.split("; ");
  assert.match(pair, /^__Host-agentrun-session=/);
  assert.deepEqual(attributes.sort(), ["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Strict", "Secure"]);
  const out = (origin) => call(server.port, { method: "POST", path: "/v2/auth/sign-out", headers: { ...json, host: "evil.example", origin, cookie: cookieOf(made) }, body: {} });
  assert.equal((await out(`http://127.0.0.1:${server.port}`)).status, 403, "only the fixed origin may write");
  assert.equal((await out(`http://localhost:${server.port}`)).status, 403, "with a public URL, localhost is not an origin either");
  assert.equal((await out(publicUrl)).status, 200);
});

test("on plain http the cookie is agentrun-<port>-session: HttpOnly, SameSite=Strict, Path=/, no Domain; every sign-in makes a new session", async (t) => {
  const server = await withOwner(t);
  assert.equal(server.setCookie.length, 1);
  const [pair, ...attributes] = server.setCookie[0].split("; ");
  assert.match(pair, new RegExp(`^agentrun-${server.port}-session=`));
  assert.deepEqual(attributes.sort(), ["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Strict"]);
  const second = await server.signInAs(OWNER.email);
  assert.match(second, new RegExp(`^agentrun-${server.port}-session=[^;]+$`));
  assert.notEqual(second, pair);
  for (const cookie of [pair, second]) assert.equal((await call(server.port, { path: "/v2/me", headers: { cookie } })).status, 200);
});

test("a session lasts 7 days idle, each use a day or more on moves it, and serve refuses and deletes one older than 30 days", async (t) => {
  const server = await withOwner(t);
  const db = authDb(t, server.data);
  const token = decodeURIComponent(server.cookie.split("=")[1]).split(".")[0];
  const row = () => db.prepare("SELECT expiresAt, createdAt FROM session WHERE token = ?").get(token);
  db.prepare("UPDATE session SET expiresAt = ? WHERE token = ?").run(new Date(Date.now() + 5 * DAY_MS).toISOString(), token);
  const used = await call(server.port, { path: "/v2/me", headers: { cookie: server.cookie } });
  assert.equal(used.status, 200);
  assert.ok(Math.abs(Date.parse(row().expiresAt) - (Date.now() + 7 * DAY_MS)) < 60_000, "used two days into its week, it runs 7 days from now");
  assert.match(used.headers["set-cookie"]?.[0] ?? "", /Max-Age=604800/, "and the browser's cookie moves with it");
  db.prepare("UPDATE session SET createdAt = ? WHERE token = ?").run(new Date(Date.now() - 31 * DAY_MS).toISOString(), token);
  const old = await call(server.port, { path: "/v2/me", headers: { cookie: server.cookie } });
  assert.deepEqual([old.status, old.json.error.code], [401, "unauthenticated"]);
  assert.equal(row(), undefined, "deleted");
  const second = await server.signInAs(OWNER.email);
  const secondToken = decodeURIComponent(second.split("=")[1]).split(".")[0];
  db.prepare("UPDATE session SET createdAt = ? WHERE token = ?").run(new Date(Date.now() - 31 * DAY_MS).toISOString(), secondToken);
  const library = await call(server.port, { path: "/v2/auth/get-session", headers: { cookie: second } });
  assert.deepEqual([library.status, library.json], [200, null], "the library's own endpoints never see it either");
  assert.equal(db.prepare("SELECT count(*) AS n FROM session WHERE token = ?").get(secondToken).n, 0);
});

test("under /v2/auth only the allowlisted endpoints answer, each on its one method; every other path, the password and magic-link endpoints, sign-up and the admin routes among them, is a 404", async (t) => {
  const server = await withOwner(t);
  const headers = { cookie: server.cookie, origin: server.origin, ...json };
  for (const path of [
    "/v2/auth/sign-up/email", "/v2/auth/admin/set-role", "/v2/auth/admin/create-user", "/v2/auth/admin/list-users", "/v2/auth/admin/ban-user", "/v2/auth/delete-user",
    "/v2/auth/change-email", "/v2/auth/forget-password", "/v2/auth/request-password-reset", "/v2/auth/reset-password", "/v2/auth/send-verification-email", "/v2/auth/verify-email",
    "/v2/auth/sign-in/social", "/v2/auth/sign-in/magic-link", "/v2/auth/list-accounts", "/v2/auth/ok", "/v2/auth/error", "/v2/auth/update-session",
    "/v2/auth/list-sessions", "/v2/auth/revoke-session", "/v2/auth/sign-in/email", "/v2/auth/change-password", "/v2/auth/verify-password", "/v2/auth/set-password",
    "/v2/auth/magic-link/verify",
    "/v2/auth/sign-in/email/", "/v2/auth//sign-in/email", "/v2/auth/./sign-in/email", "/v2/auth/sign-in/%65mail", "/v2/auth/update-user/../admin/set-role", "/v2/auth/Sign-In/Email", "//v2/auth/sign-in/email",
  ]) {
    for (const method of ["GET", "POST"]) {
      const res = await call(server.port, { method, path, headers, body: method === "POST" ? { role: "admin" } : undefined });
      assert.deepEqual([res.status, res.json?.error?.code], [404, "not_found"], `${method} ${path}`);
    }
  }
  for (const [path, method, wrong] of [["/v2/auth/get-session", "GET", "POST"], ["/v2/auth/sign-out", "POST", "GET"], ["/v2/auth/update-user", "POST", "GET"]]) {
    const res = await call(server.port, { method: wrong, path, headers, body: wrong === "POST" ? {} : undefined });
    assert.deepEqual([res.status, res.json.error.code, res.headers.allow], [405, "method_not_allowed", method], `${wrong} ${path}`);
  }
  // The session's token lives in the HttpOnly cookie only: no answer a page's script can read carries it.
  const token = (cookie) => decodeURIComponent(cookie.split("=")[1]).split(".")[0];
  const session = await call(server.port, { path: "/v2/auth/get-session", headers });
  assert.deepEqual([session.status, session.json.user.email, session.json.session.token], [200, OWNER.email, undefined]);
  assert.ok(!session.text.includes(token(server.cookie)), "get-session holds no token");
  assert.ok(!server.setupText.includes(token(server.cookie)), "the setup answer that signed the owner in holds no token");
  assert.equal("token" in server.owner, false);
});

test("one write gate in front of every route, the library's included: a cookie's write needs this server's Origin and a JSON body; a Bearer request needs neither", async (t) => {
  const server = await withOwner(t);
  const write = (path, headers, body = { definition: { id: "gated", name: "gated", instructions: "Answer.", tools: [] } }) => call(server.port, { method: "POST", path, headers: { cookie: server.cookie, ...headers }, body });
  for (const path of ["/v2/agents", "/v2/auth/sign-out", "/v2/auth/update-user"]) {
    for (const [why, headers, status, code] of [
      ["no Origin", json, 403, "forbidden"],
      ["another origin", { ...json, origin: "https://evil.example" }, 403, "forbidden"],
      ["the null origin", { ...json, origin: "null" }, 403, "forbidden"],
      ["localhost on another port", { ...json, origin: `http://localhost:${server.port + 1}` }, 403, "forbidden"],
      ["a third loopback name", { ...json, origin: `http://[::1]:${server.port}` }, 403, "forbidden"],
      ["a form's body", { "content-type": "application/x-www-form-urlencoded", origin: server.origin }, 415, "unsupported_media_type"],
      ["a text body", { "content-type": "text/plain", origin: server.origin }, 415, "unsupported_media_type"],
    ]) {
      const refused = await write(path, headers);
      assert.deepEqual([refused.status, refused.json?.error?.code], [status, code], `${path}: ${why}`);
    }
  }
  assert.equal((await write("/v2/agents", { ...json, origin: server.origin })).status, 201);
  const local = await write("/v2/agents", { ...json, origin: `http://localhost:${server.port}` }, { definition: { id: "from-localhost", name: "from-localhost", instructions: "Answer.", tools: [] } });
  assert.equal(local.status, 201, "on the loopback default, localhost on the same port is the other fixed origin");
  const bearer = await call(server.port, { method: "POST", path: "/v2/agents", headers: { ...json, authorization: `Bearer ${server.token}` }, body: { definition: { id: "by-token", name: "by-token", instructions: "Answer.", tools: [] } } });
  assert.equal(bearer.status, 201, "the Bearer is not ambient, so it needs no Origin");
  assert.equal((await call(server.port, { path: "/v2/me", headers: { cookie: server.cookie } })).status, 200, "nothing above signed the owner out");
  const out = await write("/v2/auth/sign-out", { ...json, origin: server.origin }, {});
  assert.equal(out.status, 200);
  assert.equal((await call(server.port, { path: "/v2/me", headers: { cookie: server.cookie } })).status, 401);
});

test("the page's old cookie still works with accounts, and its writes must come from the fixed origin, not one the Host names", async (t) => {
  const server = await withOwner(t);
  const opened = await call(server.port, { path: `/?token=${server.token}` });
  assert.equal(opened.status, 303);
  const cookie = cookieOf(opened);
  assert.equal((await call(server.port, { path: "/v2/agents", headers: { cookie } })).status, 200);
  const body = { definition: { id: "paged", name: "paged", instructions: "Answer.", tools: [] } };
  const elsewhere = await call(server.port, { method: "POST", path: "/v2/agents", headers: { cookie, ...json, origin: `http://localhost:${server.port + 1}` }, body });
  assert.equal(elsewhere.status, 401);
  const local = await call(server.port, { method: "POST", path: "/v2/agents", headers: { cookie, ...json, host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` }, body: { definition: { ...body.definition, id: "paged-local", name: "paged-local" } } });
  assert.equal(local.status, 201, "localhost on the same port is the loopback default's other origin");
  assert.equal((await call(server.port, { method: "POST", path: "/v2/agents", headers: { cookie, ...json, origin: server.origin }, body })).status, 201);
});

test("the library's rate limits count per client address, the socket's peer: a header a client sends never picks the bucket", async (t) => {
  const server = await withOwner(t);
  const ask = (from, i) => call(server.port, { path: "/v2/auth/get-session", from, headers: { cookie: server.cookie, "x-agentrun-client-ip": `203.0.113.${i % 250}`, "x-forwarded-for": `198.51.100.${i % 250}` } });
  // The library's default: 100 requests to a path in 10 s from one address.
  const statuses = [];
  for (let i = 0; i < 102; i++) statuses.push((await ask("127.0.0.1", i)).status);
  assert.deepEqual([statuses.indexOf(429), statuses.at(-1)], [100, 429], `the 101st in 10 s, whatever the headers say: ${statuses.filter((s) => s === 429).length} refused`);
  assert.equal((await ask("127.0.0.2", 9)).status, 200, "another address has its own bucket");
  assert.ok(authDb(t, server.data).prepare(`SELECT count(*) AS n FROM "rateLimit"`).get().n > 0, "kept in the accounts database");
});

test("the setup and sign-in pages: static, CSP 'self', no inline script; a browser that is not signed in gets setup with no owner, sign-in after; a session gets the page", async (t) => {
  const server = await serve(t, { accounts: true });
  const page = (path, headers) => call(server.port, { path, headers });
  for (const path of ["/setup.js", "/account.css"]) {
    const file = await page(path);
    assert.equal(file.status, 200, path);
    assert.match(file.headers["content-security-policy"], /script-src 'self'/);
  }
  for (const [path, title] of [["/", "Set up this server"], ["/?token=wrong", "Set up this server"]]) {
    const res = await page(path);
    assert.equal(res.status, 401, path);
    assert.match(res.text, new RegExp(title), path);
  }
  const setupPage = await page("/setup");
  assert.equal(setupPage.status, 200);
  assert.match(setupPage.headers["content-security-policy"], /default-src 'self'; script-src 'self'/);
  assert.equal(setupPage.headers["x-content-type-options"], "nosniff");
  assert.equal((await page("/sign-in")).headers.location, "/setup");
  const made = await setup(server.port, { code: codeOf(server.setupUrl), ...OWNER }, { origin: `http://127.0.0.1:${server.port}` });
  const cookie = cookieOf(made);
  assert.equal((await page("/setup")).headers.location, "/sign-in");
  const signInPage = await page("/sign-in");
  assert.equal(signInPage.status, 200);
  assert.match((await page("/")).text, /<h1>Sign in<\/h1>/);
  for (const html of [setupPage.text, signInPage.text]) assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|https?:|<script>/i);
  assert.match(setupPage.text, /<script src="\/setup\.js"><\/script>/);
  const signedIn = await page("/", { cookie });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.text, /data-serve="store"/);
  assert.equal((await page("/api/store", { cookie })).status, 200);
  assert.equal((await page("/api/store")).status, 401);
});
