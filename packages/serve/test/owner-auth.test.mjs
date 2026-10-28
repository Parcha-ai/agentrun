// The owner: one person, one password. The first visit sets it (with the printed code at a public address), a signed
// session cookie carries the sign-in for 30 days, signing out ends every session, and reset-password clears it. The token
// stays the way in for scripts and the CLI. Every route but capabilities, the contract and health needs one or the other.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { mock, test } from "node:test";
import * as owner from "../dist/owner.js";
import { ROUTES } from "../dist/server.js";
import { call, cookieOf, scratch, serve } from "./support.mjs";

const { Owner, resetPassword, SIGN_IN_PEERS } = owner;

const json = { "content-type": "application/json" };
/** Test passwords, none a real one. */
const pw = (name) => `not-a-secret-${name}`;
const PASSWORD = pw("owner");
const page = (server) => ({ ...json, origin: `http://127.0.0.1:${server.port}` });
const setup = (server, body, headers = page(server)) => call(server.port, { method: "POST", path: "/v2/setup", headers, body });
const signIn = (server, password, headers = page(server)) => call(server.port, { method: "POST", path: "/v2/auth/sign-in", headers, body: { password } });
const agents = (server, cookie) => call(server.port, { path: "/v2/agents", headers: { cookie } });

/** An open server (no public address) whose owner set PASSWORD: its session cookie. */
async function owned(t, options = {}) {
  const server = await serve(t, { accounts: true, openSetup: true, ...options });
  const made = await setup(server, { password: PASSWORD });
  assert.equal(made.status, 201, made.text);
  return { ...server, cookie: cookieOf(made), made };
}

test("the first visit sets the password and signs in: the page sends a browser to setup, then to sign-in; the files are 0600 and hold no password", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true });
  assert.match(server.setupUrl, /^http:\/\/127\.0\.0\.1:\d+\/setup$/);
  assert.equal((await call(server.port, { path: "/" })).headers.location, "/setup");
  assert.equal((await call(server.port, { path: "/setup" })).status, 200);
  const made = await setup(server, { password: PASSWORD });
  assert.deepEqual([made.status, made.json.signed_in], [201, true], made.text);
  assert.equal((await agents(server, cookieOf(made))).status, 200, "the 201 carries the owner's session");
  assert.equal((await call(server.port, { path: "/" })).headers.location, "/sign-in");
  assert.equal((await call(server.port, { path: "/setup" })).headers.location, "/sign-in");
  for (const file of ["owner.json", ".session-secret"]) assert.equal((await stat(join(server.data, file))).mode & 0o777, 0o600, file);
  const stored = JSON.parse(await readFile(join(server.data, "owner.json"), "utf8"));
  assert.ok(stored.password.N >= 2 ** 15 && stored.password.r >= 8 && stored.password.p >= 1, JSON.stringify(stored.password));
  assert.ok(Buffer.from(stored.password.salt, "base64url").length >= 16, "a 16-byte salt or longer");
  assert.ok(!JSON.stringify(stored).includes(PASSWORD) && !(await readFile(join(server.data, ".session-secret"), "utf8")).includes(PASSWORD));
});

test("a second setup is a 403, and three setups at once make exactly one password", async (t) => {
  const server = await owned(t);
  assert.equal((await setup(server, { password: pw("another") })).status, 403);
  const fresh = await serve(t, { accounts: true, openSetup: true });
  const tries = await Promise.all([pw("first"), pw("second"), pw("third")].map((password) => setup(fresh, { password })));
  assert.deepEqual(tries.map((r) => r.status).sort(), [201, 403, 403], tries.map((r) => r.text).join("\n"));
  const won = [pw("first"), pw("second"), pw("third")][tries.findIndex((r) => r.status === 201)];
  assert.equal((await signIn(fresh, won)).status, 200);
});

test("the password is 12 characters or more, counted as characters, and at most 1024 bytes; setup keeps no other field", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true });
  for (const [body, field] of [[{ password: "x".repeat(11) }, "password"], [{ password: "x".repeat(1025) }, "password"], [{ password: PASSWORD, name: "Ana" }, "name"], [{}, "password"]]) {
    const res = await setup(server, body);
    assert.deepEqual([res.status, res.json.error.fields.map((f) => f.field)], [422, [field]], JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await setup(server, { password: "🔑".repeat(12) })).status, 201, "twelve characters, though more bytes");
});

test("at a public address setup takes the printed code (or the token): none or a wrong one is a 403, the fifth wrong one voids it", async (t) => {
  const server = await serve(t, { accounts: true });
  const code = new URL(server.setupUrl).hash.slice("#code=".length);
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await setup(server, { password: PASSWORD })).status, 403);
  for (let i = 0; i < 4; i++) assert.equal((await setup(server, { password: PASSWORD, code: "wrong" })).status, 403);
  assert.equal((await setup(server, { password: PASSWORD, code })).status, 403, "the fifth wrong code voided it");
  const byToken = await setup(server, { password: PASSWORD }, { ...json, authorization: `Bearer ${server.token}` });
  assert.equal(byToken.status, 201, "the token stands in for the code");
});

test("sign-in: the password gives a session cookie, HttpOnly, SameSite=Strict, Path=/, 30 days; a wrong one is a 401 and sets nothing", async (t) => {
  const server = await owned(t);
  const wrong = await signIn(server, "not the password");
  assert.deepEqual([wrong.status, wrong.headers["set-cookie"]], [401, undefined]);
  const right = await signIn(server, PASSWORD);
  assert.equal(right.status, 200, right.text);
  const [line] = right.headers["set-cookie"];
  assert.match(line, new RegExp(`^agentrun-${server.port}-session=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; `));
  for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) assert.ok(line.split("; ").includes(part), `${part} in ${line}`);
  assert.ok(!line.includes("Secure"), "plain http");
  assert.equal((await agents(server, cookieOf(right))).status, 200);
  const https = await signIn(server, PASSWORD, { ...json, origin: `https://127.0.0.1:${server.port}`, "x-forwarded-proto": "https" });
  assert.match(https.headers["set-cookie"][0], /^__Host-agentrun-session=.*; Secure$/);
});

test("sign-in tries are limited per address: the eleventh in 15 minutes is a 429, and a forwarded-for header does not reset it", async (t) => {
  const server = await owned(t);
  for (let i = 0; i < 10; i++) assert.equal((await signIn(server, "not the password", { ...page(server), "x-forwarded-for": `10.0.0.${i}`, "x-agentrun-client-ip": `10.0.1.${i}` })).status, 401);
  const limited = await signIn(server, PASSWORD, { ...page(server), "x-forwarded-for": "10.9.9.9" });
  assert.deepEqual([limited.status, limited.json.error.code], [429, "rate_limited"]);
});

test("every cookie write is the page's: sign-in, setup and sign-out from another origin are 403, a form body is 415, and a cookie writes /v2 only from the page", async (t) => {
  const server = await owned(t);
  const evil = { ...json, origin: "https://evil.example" };
  assert.equal((await signIn(server, PASSWORD, evil)).status, 403);
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/sign-out", headers: { ...evil, cookie: server.cookie }, body: {} })).status, 403);
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/sign-in", headers: { "content-type": "application/x-www-form-urlencoded", origin: page(server).origin }, body: "password=x" })).status, 415);
  const write = (headers) => call(server.port, { method: "POST", path: "/v2/agents", headers: { cookie: server.cookie, ...headers }, body: { definition: { id: "a1", name: "a1", instructions: "Answer.", tools: [] } } });
  assert.equal((await write(evil)).status, 401, "a cookie from another origin is no credential");
  assert.equal((await write(page(server))).status, 201);
});

test("signing out ends every session: a copy of the cookie made before is a 401 after, on every browser", async (t) => {
  const server = await owned(t);
  const other = cookieOf(await signIn(server, PASSWORD));
  assert.equal((await agents(server, other)).status, 200);
  const out = await call(server.port, { method: "POST", path: "/v2/auth/sign-out", headers: { ...page(server), cookie: server.cookie }, body: {} });
  assert.equal(out.status, 200, out.text);
  assert.match(out.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await agents(server, server.cookie)).status, 401);
  assert.equal((await agents(server, other)).status, 401, "another browser's session ended too");
  const session = await call(server.port, { path: "/v2/auth/session", headers: { cookie: other } });
  assert.deepEqual(session.json, { password_set: true, signed_in: false });
  assert.equal((await signIn(server, PASSWORD)).status, 200, "and the password still signs in");
});

test("a session's end is in its signed payload: a cookie past its 30 days, or with its epoch or MAC changed, is no session", async (t) => {
  const server = await owned(t);
  const secret = Buffer.from((await readFile(join(server.data, ".session-secret"), "utf8")).trim(), "base64url");
  const { epoch } = JSON.parse(await readFile(join(server.data, "owner.json"), "utf8"));
  const forge = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `agentrun-${server.port}-session=${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  assert.equal((await agents(server, forge({ iat: Date.now(), exp: Date.now() + 60_000, epoch }))).status, 200, "the control: a well-made cookie works");
  assert.equal((await agents(server, forge({ iat: 0, exp: Date.now() - 1, epoch }))).status, 401, "past its end");
  assert.equal((await agents(server, forge({ iat: Date.now(), exp: Date.now() + 60_000, epoch: epoch - 1 }))).status, 401, "another epoch");
  const [name, value] = server.cookie.split("=");
  assert.equal((await agents(server, `${name}=${value.slice(0, -2)}xx`)).status, 401, "a changed MAC");
});

test("reset-password clears the password and ends every session; the next visit sets a new one; the CLI does it where the data is", async (t) => {
  const server = await owned(t);
  resetPassword(server.data);
  assert.equal((await agents(server, server.cookie)).status, 401, "a session from before is over");
  assert.equal((await call(server.port, { path: "/" })).headers.location, "/setup");
  assert.equal((await setup(server, { password: pw("new") })).status, 201);
  assert.equal((await signIn(server, PASSWORD)).status, 401, "the old password is gone");
  const cli = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "reset-password", "--data", server.data], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /password is cleared/);
  assert.equal((await signIn(server, pw("new"))).status, 403, "no password until the next visit sets one");
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/reset-password", headers: page(server), body: {} })).status, 404, "never an HTTP route");
});

test("every route, called with no credential, is a 401 but capabilities, the contract and health; the owner's session and the token are let into every one", async (t) => {
  const server = await owned(t);
  for (const route of ROUTES) {
    const path = `/v2${route.pattern.source.replace(/^\^\\\//, "/").replace(/\$$/, "").replace(/\(\[\^\/\]\+\)/g, "x").replace(/\\\//g, "/").replace(/\\\./g, ".")}`;
    const body = route.method === "GET" || route.method === "HEAD" ? undefined : {};
    const anonymous = await call(server.port, { method: route.method, path, headers: body ? page(server) : {}, body });
    if (["getCapabilities", "getOpenapi", "getHealth"].includes(route.name)) assert.ok([200, 503].includes(anonymous.status), `${route.method} ${path}: ${anonymous.status}`);
    else assert.equal(anonymous.status, 401, `${route.method} ${path} with no credential: ${anonymous.text}`);
    for (const headers of [{ ...(body ? page(server) : {}), cookie: server.cookie }, { ...(body ? json : {}), authorization: `Bearer ${server.token}` }]) {
      const res = await call(server.port, { method: route.method, path, headers, body });
      assert.ok(![401, 403].includes(res.status), `${route.method} ${path} with ${headers.cookie ? "the session" : "the token"}: ${res.status} ${res.text}`);
    }
  }
});

test("accounts off: no owner file, no setup or sign-in, and the token works as before", async (t) => {
  const server = await serve(t);
  assert.equal(server.setupUrl, undefined);
  for (const path of ["/setup", "/sign-in"]) assert.equal((await call(server.port, { path })).status, 404, path);
  for (const path of ["/v2/setup", "/v2/auth/sign-in", "/v2/auth/session"]) assert.equal((await call(server.port, { method: "POST", path, headers: page(server), body: {} })).status, 404, path);
  await assert.rejects(stat(join(server.data, "owner.json")));
  assert.equal((await call(server.port, { path: "/v2/agents", headers: { authorization: `Bearer ${server.token}` } })).status, 200);
});

test("the bin: accounts on with no AGENTRUN_ACCOUNTS, the first-visit line with no public address, the code line with one, none with AGENTRUN_ACCOUNTS=0", { timeout: 60_000 }, async (t) => {
  const bin = async (env, done) => {
    const { spawn } = await import("node:child_process");
    const data = join(await scratch(t), "agents");
    const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTRUN_PUBLIC_URL: "", RENDER_EXTERNAL_URL: "", AGENTRUN_ACCOUNTS: "", ...env } });
    t.after(() => child.kill("SIGTERM"));
    let out = "";
    for await (const chunk of child.stdout) {
      out += chunk;
      if (done.test(out)) break;
    }
    child.kill("SIGTERM");
    return out;
  };
  const open = await bin({}, /Set your password: .*\n/);
  assert.match(open, /^Set your password: http:\/\/127\.0\.0\.1:\d+\/setup \(/m);
  assert.match(open, /^Open http:\/\/127\.0\.0\.1:\d+\/$/m, "with accounts on, the Open line holds no token");
  assert.match(await bin({ AGENTRUN_PUBLIC_URL: "http://127.0.0.1:8123" }, /Set up this server: .*\n/), /^Set up this server: http:\/\/127\.0\.0\.1:8123\/setup#code=[A-Za-z0-9_-]{22}$/m);
  assert.doesNotMatch(await bin({ AGENTRUN_ACCOUNTS: "0" }, /\?token=.*\n/), /Set your password|Set up this server/);
});

test("with accounts on, the token link signs no browser in: it sets no cookie, and a cookie made from the token is no credential, before or after signing out everywhere", async (t) => {
  const server = await owned(t);
  const link = await call(server.port, { path: `/?token=${encodeURIComponent(server.token)}` });
  assert.deepEqual([link.status, link.headers.location, link.headers["set-cookie"]], [303, "/sign-in", undefined]);
  const tokenCookie = `agentrun-${server.port}=${createHmac("sha256", server.token).update("agentrun-serve page").digest("base64url")}`;
  const out = await call(server.port, { method: "POST", path: "/v2/auth/sign-out", headers: { ...page(server), cookie: server.cookie }, body: {} });
  assert.equal(out.status, 200, out.text);
  for (const cookie of [tokenCookie, `${tokenCookie}; ${server.cookie}`]) {
    assert.equal((await agents(server, cookie)).status, 401, "the token's page cookie outlives no sign-out");
    assert.equal((await call(server.port, { path: "/", headers: { cookie } })).headers.location, "/sign-in");
  }
  assert.equal((await call(server.port, { path: "/v2/agents", headers: { authorization: `Bearer ${server.token}` } })).status, 200, "the token stays for scripts");
});

test("a setup code is compared as bytes: one with characters outside ASCII is a wrong try, a 403 that counts toward the five", async (t) => {
  const server = await serve(t, { accounts: true });
  const code = new URL(server.setupUrl).hash.slice("#code=".length);
  const odd = await setup(server, { password: PASSWORD, code: "\u00e9".repeat(code.length) });
  assert.deepEqual([odd.status, odd.json.error?.code], [403, "forbidden"], odd.text);
  for (let i = 0; i < 4; i++) assert.equal((await setup(server, { password: PASSWORD, code: "wrong" })).status, 403);
  assert.equal((await setup(server, { password: PASSWORD, code })).status, 403, "the odd code was the first of the five");
});

test("the sign-in limit keeps a bounded table: expired addresses are swept, a full table refuses a new address, and a limited one stays limited", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const owner = new Owner(await scratch(t), true);
  for (let i = 0; i < 10; i++) assert.equal(owner.allow("held"), "ok");
  assert.equal(owner.allow("held"), "limited");
  for (let i = 1; i < SIGN_IN_PEERS; i++) assert.equal(owner.allow(`peer-${i}`), "ok");
  assert.equal(owner.allow("one-more"), "full", "a full table refuses a new address");
  assert.equal(owner.allow("held"), "limited", "a flood of new addresses never resets a limited one");
  assert.equal(owner.allow("peer-1"), "ok", "an address already counted still counts");
  mock.timers.tick(15 * 60_000);
  assert.equal(owner.allow("one-more"), "ok", "expired addresses are swept");
  assert.equal(owner.allow("held"), "ok");
});

test("on Render the setup takes the code: with RENDER_EXTERNAL_URL and no AGENTRUN_PUBLIC_URL, setup with no code is a 403 and with the printed code a 201; AGENTRUN_PUBLIC_URL wins when both are set", { timeout: 60_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const start = async (env) => {
    const data = join(await scratch(t), "agents");
    const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTRUN_PUBLIC_URL: "", AGENTRUN_ACCOUNTS: "", ...env } });
    t.after(() => child.kill("SIGTERM"));
    let out = "";
    for await (const chunk of child.stdout) {
      out += chunk;
      if (/^Open .*\n/m.test(out)) break;
    }
    return { out, port: Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\//m.exec(out)?.[1]) };
  };
  const render = await start({ RENDER_EXTERNAL_URL: "https://agentrun-example.onrender.com" });
  assert.doesNotMatch(render.out, /Set your password/, "a Render deploy is never an open setup");
  const code = /^Set up this server: https:\/\/agentrun-example\.onrender\.com\/setup#code=([A-Za-z0-9_-]{22})$/m.exec(render.out)?.[1];
  assert.ok(code && render.port, render.out);
  assert.equal((await setup(render, { password: PASSWORD })).status, 403);
  const made = await setup(render, { password: PASSWORD, code });
  assert.equal(made.status, 201, made.text);
  const both = await start({ RENDER_EXTERNAL_URL: "https://agentrun-example.onrender.com", AGENTRUN_PUBLIC_URL: "https://agents.example.com" });
  assert.match(both.out, /^Set up this server: https:\/\/agents\.example\.com\/setup#code=[A-Za-z0-9_-]{22}$/m);
  assert.match(both.out, /^AGENTRUN_BASE_URL=https:\/\/agents\.example\.com\/v2$/m);
});

test("a sign-in from a new address when the limit's table is full is a 429 at the route, with retry-after, and the log says sign_in_table_full", async (t) => {
  const lines = [];
  const server = await owned(t, { signInAddresses: 0, log: (line) => lines.push(line) });
  const full = await signIn(server, PASSWORD);
  assert.deepEqual([full.status, full.json.error?.code, full.headers["retry-after"], full.headers["set-cookie"]], [429, "rate_limited", "900", undefined], full.text);
  assert.ok(lines.some((line) => / event=auth_failed route=\/v2\/auth\/sign-in reason=sign_in_table_full$/.test(line)), lines.join("\n"));
});

test("the sign-in page's forgot line names the data directory: reset-password --data DIR, and the image's /data", async (t) => {
  const server = await owned(t);
  const page = await call(server.port, { path: "/sign-in" });
  assert.equal(page.status, 200);
  assert.match(page.text, /agentrun-serve reset-password --data DIR/);
  assert.match(page.text, /reset-password --data \/data/);
});
