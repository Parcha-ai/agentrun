// The owner: one person, one password. The first visit sets it (with the printed code at a public address), a signed
// session cookie carries the sign-in for 30 days, signing out signs out this browser, signing out everywhere ends every
// session, and reset-password clears it. The token
// stays the way in for scripts and the CLI. Every route but capabilities, the contract and health needs one or the other.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { mock, test } from "node:test";
import * as owner from "../dist/owner.js";
import { ROUTES } from "../dist/server.js";
import { writesSecret } from "../dist/secret-writes.js";
import { builtConsole, call, CONSOLE_INDEX, cookieOf, scratch, serve } from "./support.mjs";

const { Owner, peerKey, resetPassword, SignInLimit, SIGN_IN_MAX_WAIT_MS, SIGN_IN_PEERS } = owner;

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
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t), ...options });
  const made = await setup(server, { password: PASSWORD });
  assert.equal(made.status, 201, made.text);
  return { ...server, cookie: cookieOf(made), made };
}

test("the first visit sets the password and signs in: the printed link lands on the console, whose session read says setup, then sign-in; the files are 0600 and hold no password", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, console: await builtConsole(t) });
  assert.match(server.setupUrl, /^http:\/\/127\.0\.0\.1:\d+\/setup$/);
  const session = async (cookie) => (await call(server.port, { path: "/v2/auth/session", headers: cookie ? { cookie } : {} })).json;
  assert.deepEqual((await call(server.port, { path: "/setup" })).headers.location, "/", "the printed link sends the browser to the console, its #code kept");
  assert.equal((await call(server.port, { path: "/" })).status, 200);
  assert.deepEqual(await session(), { accounts: true, password_set: false, signed_in: false, secrets_writable: false, secrets_reason: "sign_in", setup_code: false }, "the console asks for the first password, with no code on an open setup");
  const made = await setup(server, { password: PASSWORD });
  assert.deepEqual([made.status, made.json.signed_in], [201, true], made.text);
  assert.equal((await agents(server, cookieOf(made))).status, 200, "the 201 carries the owner's session");
  assert.deepEqual(await session(cookieOf(made)), { accounts: true, password_set: true, signed_in: true, secrets_writable: true }, "the owner's session may write secrets");
  assert.deepEqual(await session(), { accounts: true, password_set: true, signed_in: false, secrets_writable: false, secrets_reason: "sign_in" }, "another browser is asked to sign in");
  assert.equal((await call(server.port, { path: "/setup" })).headers.location, "/");
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

/** The setup links the server prints while `body` runs (Owner prints them to stdout): their codes, in order. */
async function printedCodes(body) {
  const codes = [];
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    for (const m of String(chunk).matchAll(/^Set up this server: \S+\/setup#code=([A-Za-z0-9_-]{22}) \(or paste AGENTRUN_TOKEN\)$/gm)) codes.push(m[1]);
    return write.call(this, chunk, ...rest);
  };
  try { await body(); } finally { process.stdout.write = write; }
  return codes;
}

test("at a public address setup takes the printed code (or the token): a wrong one is a 403, and the fifth voids it and prints a new one, which the refusal says", async (t) => {
  const server = await serve(t, { accounts: true });
  const code = new URL(server.setupUrl).hash.slice("#code=".length);
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  let fifth;
  const printed = await printedCodes(async () => {
    for (let i = 0; i < 4; i++) assert.equal((await setup(server, { password: PASSWORD, code: "wrong" })).status, 403);
    fifth = await setup(server, { password: PASSWORD, code: "wrong" });
  });
  assert.equal(fifth.status, 403);
  assert.match(fifth.json.error.message, /a new one is in the server's log/, "the voiding try says a new code was printed");
  assert.equal(printed.length, 1, "a new code is printed when the fifth wrong one voids the old");
  assert.notEqual(printed[0], code);
  const old = await setup(server, { password: PASSWORD, code });
  assert.equal(old.status, 403, "the voided code is refused");
  assert.equal((await setup(server, { password: PASSWORD, code: printed[0] })).status, 201, "the new printed code sets the password");
});

test("at a public address a setup with no code is refused and never counts against the printed code: after five, the code from the log still sets the password", async (t) => {
  const server = await serve(t, { accounts: true });
  const code = new URL(server.setupUrl).hash.slice("#code=".length);
  const printed = await printedCodes(async () => {
    for (const body of [{ password: PASSWORD }, { password: PASSWORD, code: "" }, { password: PASSWORD }, { password: PASSWORD }, { password: PASSWORD }, { password: PASSWORD }]) {
      const r = await setup(server, body);
      assert.equal(r.status, 403);
      assert.match(r.json.error.message, /setup code/, r.text);
    }
  });
  assert.deepEqual(printed, [], "no new code: the printed one still stands");
  assert.equal((await setup(server, { password: PASSWORD, code })).status, 201, "the code from the log, after six tries with none");
});

test("the server's API token in the code field stands in for the setup code; a wrong token counts as a wrong code", async (t) => {
  const server = await serve(t, { accounts: true });
  assert.equal((await setup(server, { password: PASSWORD, code: server.token })).status, 201, "the token as the code");
  const other = await serve(t, { accounts: true });
  let fifth;
  const printed = await printedCodes(async () => {
    for (let i = 0; i < 4; i++) assert.equal((await setup(other, { password: PASSWORD, code: `${other.token}x` })).status, 403);
    fifth = await setup(other, { password: PASSWORD, code: `${other.token}x` });
  });
  assert.match(fifth.json.error.message, /a new one is in the server's log/, "five wrong tokens void the code, as five wrong codes do");
  assert.equal(printed.length, 1);
  assert.ok(!fifth.text.includes(other.token), "the refusal never says the token");
});

test("the token stands in for the setup code at a public address", async (t) => {
  const server = await serve(t, { accounts: true });
  const byToken = await setup(server, { password: PASSWORD }, { ...json, authorization: `Bearer ${server.token}` });
  assert.equal(byToken.status, 201);
});

test("the session read says whether setup takes a code, never the code: true at a public address, false on open setup, absent once a password is set", async (t) => {
  const session = async (server) => (await call(server.port, { path: "/v2/auth/session" })).json;
  const coded = await serve(t, { accounts: true });
  const code = new URL(coded.setupUrl).hash.slice("#code=".length);
  const before = await session(coded);
  assert.deepEqual(before, { accounts: true, password_set: false, signed_in: false, secrets_writable: false, secrets_reason: "sign_in", setup_code: true });
  assert.ok(!JSON.stringify(before).includes(code), "the code itself is never in the answer");
  const open = await serve(t, { accounts: true, openSetup: true });
  assert.deepEqual(await session(open), { accounts: true, password_set: false, signed_in: false, secrets_writable: false, secrets_reason: "sign_in", setup_code: false });
  assert.equal((await setup(coded, { password: PASSWORD, code })).status, 201);
  assert.deepEqual(await session(coded), { accounts: true, password_set: true, signed_in: false, secrets_writable: false, secrets_reason: "sign_in" }, "no setup_code once a password is set");
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

// key-gate: documentation-range addresses (RFC 5737, RFC 3849) as forwarded clients under test
const CLIENT = "192.0.2.10";
const OTHER = "198.51.100.20";
const V6 = (host) => `2001:db8:1:2::${host}`;

test("sign-in tries are limited per address: the eleventh in 15 minutes waits a second and says so, and with no trusted proxy a forwarded-for header is never read", async (t) => {
  const server = await owned(t);
  for (let i = 0; i < 10; i++) assert.equal((await signIn(server, "not the password", { ...page(server), "x-forwarded-for": `${CLIENT}${i}`, "x-agentrun-client-ip": OTHER })).status, 401);
  const limited = await signIn(server, PASSWORD, { ...page(server), "x-forwarded-for": OTHER });
  assert.deepEqual([limited.status, limited.json.error.code], [429, "rate_limited"]);
  const wait = limited.json.error.retry_after_ms;
  assert.ok(wait > 0 && wait <= 1000, `the first wait past the free tries is a second at most: ${wait}`);
  assert.equal(limited.headers["retry-after"], "1");
  assert.match(limited.json.error.message, /from this address; try again in 1 s/);
});

test("behind a trusted proxy each visitor counts by the address it forwards for: a guesser's limit never holds the owner, and one IPv6 /64 is one address", async (t) => {
  const server = await owned(t, { trustedProxies: ["loopback"] });
  const from = (client) => ({ ...page(server), "x-forwarded-for": client });
  for (let i = 0; i < 10; i++) assert.equal((await signIn(server, "not the password", from(CLIENT))).status, 401);
  assert.equal((await signIn(server, "not the password", from(CLIENT))).status, 429, "the guesser waits");
  assert.equal((await signIn(server, PASSWORD, from(OTHER))).status, 200, "the owner, at another address, signs in");
  // A client that puts its own X-Forwarded-For in front: the proxy appends the address it saw, and that one counts.
  assert.equal((await signIn(server, "not the password", from(`${OTHER}, ${CLIENT}`))).status, 429, "a forged first hop is not the client");
  for (let i = 0; i < 10; i++) assert.equal((await signIn(server, "not the password", from(V6(i.toString(16))))).status, 401);
  assert.equal((await signIn(server, "not the password", from(V6("ffff")))).status, 429, "another address in the same /64 is the same visitor");
  assert.equal((await signIn(server, "not the password", from("2001:db8:1:3::1"))).status, 401, "the next /64 is another");
});

test("a sign-in body sent slowly holds nothing of the limit: eleven left unfinished, the owner's sign-in still goes through", async (t) => {
  const server = await owned(t);
  const { connect } = await import("node:net");
  const open = [];
  for (let i = 0; i < 11; i++) {
    const socket = connect(server.port, "127.0.0.1"); // key-gate: loopback, the server under test
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`POST /v2/auth/sign-in HTTP/1.1\r\nhost: 127.0.0.1:${server.port}\r\norigin: ${page(server).origin}\r\ncontent-type: application/json\r\ncontent-length: 64\r\n\r\n{"password":"not`);
    open.push(socket);
  }
  t.after(() => { for (const socket of open) socket.destroy(); });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await signIn(server, PASSWORD)).status, 200, "the unfinished bodies took none of this address's tries");
});

test("an X-Forwarded-For from an address not trusted as a proxy is logged once a start, with that address; from a trusted one, not at all; and render.yaml trusts none", async (t) => {
  const tried = async (options) => {
    const lines = [];
    const server = await owned(t, { ...options, log: (line) => lines.push(line) });
    for (const client of [CLIENT, OTHER]) await signIn(server, "not the password", { ...page(server), "x-forwarded-for": client });
    return lines.filter((line) => / event=forwarded_untrusted /.test(line));
  };
  const none = await tried({});
  assert.equal(none.length, 1, `once a start, with no proxy trusted: ${none.join("\n")}`);
  assert.match(none[0], / event=forwarded_untrusted peer=(::ffff:)?127\.0\.0\.1$/); // key-gate: loopback, the test's own connection
  assert.equal((await tried({ trustedProxies: [`${CLIENT}/32`] })).length, 1, "a proxy trusted that is not the peer: still said");
  assert.deepEqual(await tried({ trustedProxies: ["loopback"] }), [], "from a trusted proxy: nothing to say");
  const render = await readFile(new URL("../../../render.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(render, /key: AGENTRUN_TRUSTED_PROXIES/, "Render publishes no proxy address: render.yaml trusts none");
});

test("the trusted proxies must parse: a start with one that does not is refused, naming the option", async (t) => {
  await assert.rejects(serve(t, { accounts: true, openSetup: true, trustedProxies: ["not-an-address"] }), /trustedProxies: .*not-an-address/);
});

test("every cookie write is the page's: sign-in, setup and sign-out from another origin are 403, a form body is 415, and a cookie writes /v2 only from the page", async (t) => {
  const server = await owned(t);
  const evil = { ...json, origin: "https://evil.example" };
  assert.equal((await signIn(server, PASSWORD, evil)).status, 403);
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/sign-out", headers: { ...evil, cookie: server.cookie }, body: {} })).status, 403);
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/sign-out-everywhere", headers: { ...evil, cookie: server.cookie }, body: {} })).status, 403);
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/sign-in", headers: { "content-type": "application/x-www-form-urlencoded", origin: page(server).origin }, body: "password=x" })).status, 415);
  const write = (headers) => call(server.port, { method: "POST", path: "/v2/agents", headers: { cookie: server.cookie, ...headers }, body: { definition: { id: "a1", name: "a1", instructions: "Answer.", tools: [] } } });
  assert.equal((await write(evil)).status, 401, "a cookie from another origin is no credential");
  assert.equal((await write(page(server))).status, 201);
});

test("signing out signs out this browser only: its session is revoked on the server and its cookie cleared, and another browser stays signed in", async (t) => {
  const server = await owned(t);
  const other = cookieOf(await signIn(server, PASSWORD));
  // A copy of this browser's cookie, taken before it signs out (another profile, a backup).
  const copied = server.cookie;
  assert.equal((await agents(server, copied)).status, 200);
  const out = await call(server.port, { method: "POST", path: "/v2/auth/sign-out", headers: { ...page(server), cookie: server.cookie }, body: {} });
  assert.equal(out.status, 200, out.text);
  assert.match(out.headers["set-cookie"][0], /Max-Age=0/, "this browser's cookie is cleared");
  assert.equal((await agents(server, copied)).status, 401, "the copied cookie's session is revoked on the server");
  assert.deepEqual((await call(server.port, { path: "/v2/auth/session", headers: { cookie: copied } })).json, { accounts: true, password_set: true, signed_in: false, secrets_writable: false, secrets_reason: "sign_in" });
  assert.equal((await call(server.port, { path: "/api/stats", headers: { cookie: copied } })).status, 401, "and the page's data refuses it");
  assert.equal((await agents(server, other)).status, 200, "another browser's session stays");
  assert.deepEqual((await call(server.port, { path: "/v2/auth/session", headers: { cookie: other } })).json, { accounts: true, password_set: true, signed_in: true, secrets_writable: true });
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/sign-out", headers: { ...page(server) }, body: {} })).status, 401, "a browser with no session has none to end");
});

test("a revoked session is kept only until it would have ended: its record goes with its expiry, and the owner file stays small", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const dir = await scratch(t);
  const me = new Owner(dir, true);
  await me.setFirst(PASSWORD, undefined, false);
  const first = me.session();
  me.revoke(first);
  assert.equal(me.valid(first), false);
  const ownerFile = () => JSON.parse(readFileSync(join(dir, owner.OWNER_FILE), "utf8"));
  assert.equal(ownerFile().revoked.length, 1);
  assert.ok(!JSON.stringify(ownerFile()).includes(first.split(".")[1]), "the cookie's MAC is never kept");
  // Past its 30 days the record goes at the next revoke.
  mock.timers.tick(31 * 24 * 3_600_000);
  const second = me.session();
  me.revoke(second);
  assert.equal(ownerFile().revoked.length, 1, "the expired record is swept");
  assert.equal(me.valid(second), false);
  // Signing out everywhere moves the epoch: the list empties.
  me.signOutEverywhere();
  assert.deepEqual(ownerFile().revoked ?? [], []);
});

test("signing out everywhere ends every session: a copy of the cookie made before is a 401 after, on every browser", async (t) => {
  const server = await owned(t);
  const other = cookieOf(await signIn(server, PASSWORD));
  assert.equal((await agents(server, other)).status, 200);
  const out = await call(server.port, { method: "POST", path: "/v2/auth/sign-out-everywhere", headers: { ...page(server), cookie: server.cookie }, body: {} });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json, { signed_out: true });
  assert.match(out.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await agents(server, server.cookie)).status, 401);
  assert.equal((await agents(server, other)).status, 401, "another browser's session ended too");
  const session = await call(server.port, { path: "/v2/auth/session", headers: { cookie: other } });
  assert.deepEqual(session.json, { accounts: true, password_set: true, signed_in: false, secrets_writable: false, secrets_reason: "sign_in" });
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/sign-out-everywhere", headers: { ...page(server) }, body: {} })).status, 401, "it takes a session");
  assert.equal((await signIn(server, PASSWORD)).status, 200, "and the password still signs in");
});

test("a session's end is in its signed payload: a cookie past its 30 days, with its epoch or MAC changed, or with no id, is no session", async (t) => {
  const server = await owned(t);
  const secret = Buffer.from((await readFile(join(server.data, ".session-secret"), "utf8")).trim(), "base64url");
  const { epoch } = JSON.parse(await readFile(join(server.data, "owner.json"), "utf8"));
  const forge = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `agentrun-${server.port}-session=${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  assert.equal((await agents(server, forge({ sid: "s1", iat: Date.now(), exp: Date.now() + 60_000, epoch }))).status, 200, "the control: a well-made cookie works");
  assert.equal((await agents(server, forge({ iat: Date.now(), exp: Date.now() + 60_000, epoch }))).status, 401, "no session id (nothing a sign-out could revoke)");
  assert.equal((await agents(server, forge({ sid: "s2", iat: 0, exp: Date.now() - 1, epoch }))).status, 401, "past its end");
  assert.equal((await agents(server, forge({ sid: "s3", iat: Date.now(), exp: Date.now() + 60_000, epoch: epoch - 1 }))).status, 401, "another epoch");
  const [name, value] = server.cookie.split("=");
  assert.equal((await agents(server, `${name}=${value.slice(0, -2)}xx`)).status, 401, "a changed MAC");
});

test("reset-password clears the password and ends every session; the next visit sets a new one; the CLI does it where the data is", async (t) => {
  const server = await owned(t);
  resetPassword(server.data);
  assert.equal((await agents(server, server.cookie)).status, 401, "a session from before is over");
  assert.equal((await call(server.port, { path: "/v2/auth/session" })).json.password_set, false, "the console asks for a new password");
  assert.equal((await setup(server, { password: pw("new") })).status, 201);
  assert.equal((await signIn(server, PASSWORD)).status, 401, "the old password is gone");
  const cli = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "reset-password", "--data", server.data], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /password is cleared/);
  assert.equal((await signIn(server, pw("new"))).status, 403, "no password until the next visit sets one");
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/reset-password", headers: page(server), body: {} })).status, 404, "never an HTTP route");
});

test("every route, called with no credential, is a 401 but capabilities, the contract, health, an MCP server's OAuth callback and client document, and GitHub's two browser legs back to Connect (a 302); the owner's session and the token are let into every one but the MCP endpoint, which takes the token only, approving a note, answering a tool call's approval, a run's live computer view or its hand-back, which take the session only, and a webhook trigger's hook, which takes its signature only", async (t) => {
  const server = await owned(t);
  for (const route of ROUTES) {
    const path = `/v2${route.pattern.source.replace(/^\^\\\//, "/").replace(/\$$/, "").replace(/\(\[\^\/\]\+\)/g, "x").replace(/\\\//g, "/").replace(/\\\./g, ".")}`;
    // A write goes as the page sends it (its Origin, JSON); a DELETE carries no body, as a browser's does: Node's client
    // would send one with no length, and the server would read it as the next request.
    const writes = route.method !== "GET" && route.method !== "HEAD";
    const body = writes && route.method !== "DELETE" ? {} : undefined;
    const anonymous = await call(server.port, { method: route.method, path, headers: writes ? page(server) : {}, body });
    if (["getCapabilities", "getOpenapi", "getHealth", "getAuthSession"].includes(route.name)) assert.ok([200, 503].includes(anonymous.status), `${route.method} ${path}: ${anonymous.status}`);
    // The browser back from an authorization server carries no token: its state and the cookie its start set are the
    // check (403 without the cookie).
    else if (["mcpOAuthCallback", "mcpOAuthClient"].includes(route.name)) assert.ok([200, 400, 403].includes(anonymous.status), `${route.method} ${path}: ${anonymous.status}`);
    // So is the browser GitHub sends back after it makes the App (the callback) or installs it (installed): its state and
    // the cookie Connect set are the check, and both legs only ever send it on (302), to the console with why on a failure.
    else if (["gitHubCallback", "gitHubInstalled"].includes(route.name)) assert.equal(anonymous.status, 302, `${route.method} ${path}: ${anonymous.status}`);
    else assert.equal(anonymous.status, 401, `${route.method} ${path} with no credential: ${anonymous.text}`);
    for (const headers of [{ ...(writes ? page(server) : {}), cookie: server.cookie }, { ...(body ? json : {}), authorization: `Bearer ${server.token}` }]) {
      const res = await call(server.port, { method: route.method, path, headers, body });
      if (route.name === "callMcp" && headers.cookie) assert.equal(res.status, 401, `${route.method} ${path} with the session alone: ${res.status} ${res.text}`);
      // A webhook trigger's request is let in by its signature alone (standard-webhooks.ts): neither the session nor the
      // token stands for it.
      else if (route.name === "receiveHook") assert.equal(res.status, 401, `${route.method} ${path} with ${headers.cookie ? "the session" : "the token"}: ${res.status} ${res.text}`);
      // Approving or restoring a note and answering a tool call's approval take the owner's session alone: a token,
      // whoever holds it, is 403 (learn-pending.test.mjs, learn-restore.test.mjs, tool-gate.test.mjs). So does a run's live
      // computer view, a full-control credential for its session, and its hand-back (browser-live.test.mjs,
      // browser-take-over.test.mjs).
      else if ((route.name === "approveLearningFile" || route.name === "restoreLearningFile" || route.name === "answerApproval" || route.name === "getRunBrowser" || route.name === "handBackRunBrowser" || route.name === "getRunComputer") && !headers.cookie) assert.equal(res.status, 403, `${route.method} ${path} with the token: ${res.status} ${res.text}`);
      // A secret write takes the owner's session alone (secret-writes.ts): the token is 403 on it. Which requests are secret
      // writes is the operation's predicate's to say of this body: an MCP server's PUT with no credential in it is not.
      else if (writesSecret(route.name, body) && !headers.cookie) assert.equal(res.status, 403, `${route.method} ${path} with the token: ${res.status} ${res.text}`);
      // An OAuth callback takes neither: only the cookie its own start set in the browser that started it.
      else if (route.name === "mcpOAuthCallback") assert.equal(res.status, 403, `${route.method} ${path}: ${res.status} ${res.text}`);
      else assert.ok(![401, 403].includes(res.status), `${route.method} ${path} with ${headers.cookie ? "the session" : "the token"}: ${res.status} ${res.text}`);
    }
  }
});

test("accounts off: no owner file, no setup or sign-in routes (their old addresses only send the browser to the console), and the token works as before", async (t) => {
  const server = await serve(t);
  assert.equal(server.setupUrl, undefined);
  for (const path of ["/setup", "/sign-in"]) assert.equal((await call(server.port, { path })).headers.location, "/", path);
  for (const path of ["/v2/setup", "/v2/auth/sign-in"]) assert.equal((await call(server.port, { method: "POST", path, headers: page(server), body: {} })).status, 404, path);
  // The session read answers here too, with no user field: only whether this caller may write a secret (secret-writes.ts).
  assert.equal((await call(server.port, { method: "POST", path: "/v2/auth/session", headers: page(server), body: {} })).status, 405, "the session is read, never posted");
  assert.deepEqual((await call(server.port, { path: "/v2/auth/session" })).json, { accounts: false, secrets_writable: false, secrets_reason: "sign_in" });
  await assert.rejects(stat(join(server.data, "owner.json")));
  assert.equal((await call(server.port, { path: "/v2/agents", headers: { authorization: `Bearer ${server.token}` } })).status, 200);
});

// Any listener but loopback reaches whoever reaches the port: setup there takes the printed code (or the token), even with
// no public address, so no one who finds the port first becomes the owner.
const ANY = "0.0.0.0"; // key-gate: the all-interfaces listener the image binds, the case under test

test("open setup holds only on a loopback listener: bound to every interface with no public address, setup takes the printed code", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, host: ANY });
  assert.equal(server.setupOpen, false);
  const code = new URL(server.setupUrl).hash.slice("#code=".length);
  assert.match(code, /^[A-Za-z0-9_-]{22}$/, "the setup link carries its code");
  assert.deepEqual((await call(server.port, { path: "/v2/auth/session" })).json.setup_code, true);
  const none = await setup(server, { password: PASSWORD });
  assert.equal(none.status, 403, "no code: refused");
  assert.equal((await setup(server, { password: PASSWORD, code })).status, 201, "the printed code sets the password");
});

test("the bin: listening on every interface with no public address prints the setup link with its code, never the open first-visit line", { timeout: 60_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const root = await scratch(t);
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", join(root, "agents"), "--port", "0", "--listen", ANY], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root, AGENTRUN_PUBLIC_URL: "", RENDER_EXTERNAL_URL: "", AGENTRUN_ACCOUNTS: "" } });
  t.after(() => child.kill("SIGTERM"));
  let out = "";
  for await (const chunk of child.stdout) {
    out += chunk;
    if (/^Open .*\n/m.test(out)) break;
  }
  child.kill("SIGTERM");
  assert.match(out, /^Set up this server: \S+\/setup#code=[A-Za-z0-9_-]{22} \(or paste AGENTRUN_TOKEN\)$/m);
  assert.doesNotMatch(out, /Set your password/);
});

test("the bin: accounts on with no AGENTRUN_ACCOUNTS, the first-visit line with no public address, the code line with one, none with AGENTRUN_ACCOUNTS=0", { timeout: 60_000 }, async (t) => {
  const bin = async (env, done) => {
    const { spawn } = await import("node:child_process");
    const root = await scratch(t);
    const data = join(root, "agents");
    // A home of its own: a first start counts the sessions in its home for setup's offer, and this machine's are not the test's.
    const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root, AGENTRUN_PUBLIC_URL: "", RENDER_EXTERNAL_URL: "", AGENTRUN_ACCOUNTS: "", ...env } });
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
  assert.match(await bin({ AGENTRUN_PUBLIC_URL: "http://127.0.0.1:8123" }, /Set up this server: .*\n/), /^Set up this server: http:\/\/127\.0\.0\.1:8123\/setup#code=[A-Za-z0-9_-]{22} \(or paste AGENTRUN_TOKEN\)$/m);
  assert.doesNotMatch(await bin({ AGENTRUN_ACCOUNTS: "0" }, /\?token=.*\n/), /Set your password|Set up this server/);
});

test("with accounts on, the token link signs no browser in: it sets no cookie, and a cookie made from the token is no credential, before or after signing out everywhere", async (t) => {
  const server = await owned(t);
  const link = await call(server.port, { path: `/?token=${encodeURIComponent(server.token)}` });
  assert.deepEqual([link.status, link.headers.location, link.headers["set-cookie"]], [303, "/", undefined], "the token leaves the address, and signs nothing in");
  const kept = await call(server.port, { path: `/?view=runs&token=${encodeURIComponent(server.token)}` });
  assert.deepEqual([kept.status, kept.headers.location], [303, "/?view=runs"], "other parameters stay");
  assert.deepEqual([(await call(server.port, { path: "/" })).text], [CONSOLE_INDEX], "then the console, which asks for the password");
  const tokenCookie = `agentrun-${server.port}=${createHmac("sha256", server.token).update("agentrun-serve page").digest("base64url")}`;
  const out = await call(server.port, { method: "POST", path: "/v2/auth/sign-out-everywhere", headers: { ...page(server), cookie: server.cookie }, body: {} });
  assert.equal(out.status, 200, out.text);
  for (const cookie of [tokenCookie, `${tokenCookie}; ${server.cookie}`]) {
    assert.equal((await agents(server, cookie)).status, 401, "the token's page cookie outlives no sign-out");
    assert.equal((await call(server.port, { path: "/v2/auth/session", headers: { cookie } })).json.signed_in, false, "the console asks for the password");
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

const shape = (answer) => (answer.ok ? { ok: true, untracked: answer.untracked } : answer);
// Let a try in and end it at once, a right password: the server's count of tries under way is back where it was.
const tried = (limit, address) => { const answer = limit.allow(address); if (answer.ok) answer.done(false); return shape(answer); };

test("the sign-in limit keeps a bounded table: expired addresses are swept, a full table counts a new address by the server's budget only, and a waiting one keeps waiting", () => {
  let now = 1_000_000;
  const limit = new SignInLimit(SIGN_IN_PEERS, () => now);
  for (let i = 0; i < 10; i++) assert.equal(tried(limit, "held").ok, true);
  assert.equal(tried(limit, "held").ok, false);
  for (let i = 1; i < SIGN_IN_PEERS; i++) assert.deepEqual(tried(limit, `peer-${i}`), { ok: true, untracked: false });
  assert.deepEqual(tried(limit, "one-more"), { ok: true, untracked: true }, "a full table lets a new address in, uncounted by itself");
  assert.equal(tried(limit, "held").ok, false, "a flood of new addresses never resets a waiting one");
  assert.deepEqual(tried(limit, "peer-1"), { ok: true, untracked: false }, "an address already counted still counts");
  now += 15 * 60_000;
  assert.deepEqual(tried(limit, "one-more"), { ok: true, untracked: false }, "expired addresses are swept");
  assert.equal(tried(limit, "held").ok, true);
});

test("past its free tries an address waits a second, then twice that each time, never more than a minute, and is told how long", () => {
  let now = 0;
  const limit = new SignInLimit(SIGN_IN_PEERS, () => now);
  for (let i = 0; i < 10; i++) assert.equal(tried(limit, "a").ok, true);
  const waits = [];
  for (let i = 0; i < 9; i++) {
    const held = tried(limit, "a");
    assert.equal(held.ok, false);
    assert.equal(held.by, "address");
    waits.push(held.retryAfterMs);
    now += held.retryAfterMs;
    assert.equal(tried(limit, "a").ok, true, "let in once the wait is over");
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(SIGN_IN_MAX_WAIT_MS, 60_000);
  assert.equal(tried(limit, "b").ok, true, "another address is not held");
});

test("wrong passwords past the server's budget hold every address, a minute at most, so a spread of addresses gains nothing and the owner can always try again", () => {
  let now = 0;
  const limit = new SignInLimit(SIGN_IN_PEERS, () => now);
  for (let i = 0; i < 100; i++) {
    const guess = limit.allow(`guesser-${i}`);
    assert.equal(guess.ok, true);
    guess.done(true);
  }
  const held = tried(limit, "owner");
  assert.deepEqual([held.ok, held.by, held.retryAfterMs], [false, "server", 1000]);
  now += 1000;
  assert.equal(tried(limit, "owner").ok, true, "after the wait the owner's try goes through");
  for (let i = 0; i < 10; i++) { now += SIGN_IN_MAX_WAIT_MS; const guess = limit.allow(`guesser-x${i}`); assert.equal(guess.ok, true, `guesser ${i} after a minute`); guess.done(true); }
  const later = tried(limit, "owner");
  assert.deepEqual([later.ok, later.by, later.retryAfterMs], [false, "server", SIGN_IN_MAX_WAIT_MS], "110 wrong in the window: the wait is a minute, never more");
  now += 15 * 60_000;
  assert.equal(tried(limit, "owner").ok, true, "a quiet window clears the budget");
});

test("a try let in holds its place in the server's budget until it ends, so tries at once never outrun it: within the budget no more than its places, past it one at a time", () => {
  let now = 0;
  const limit = new SignInLimit(SIGN_IN_PEERS, () => now);
  const under = [];
  for (let i = 0; i < 100; i++) {
    const answer = limit.allow(`spread-${i}`);
    assert.equal(answer.ok, true, `try ${i} at once`);
    under.push(answer);
  }
  assert.deepEqual(shape(limit.allow("one-more")), { ok: false, retryAfterMs: 1000, by: "server" }, "the 101st at once waits, though nothing has failed yet");
  under[0].done(false);
  under[0].done(true);
  const more = limit.allow("one-more");
  assert.equal(more.ok, true, "a right password frees its place, once");
  more.done(true);
  for (const answer of under.slice(1)) answer.done(true);
  now += 1000;
  const alone = limit.allow("owner");
  assert.equal(alone.ok, true, "past the budget, after the wait, one try goes in");
  assert.deepEqual(shape(limit.allow("another")), { ok: false, retryAfterMs: 1000, by: "server" }, "and only one at a time");
  alone.done(false);
});

test("the limit's key: IPv4 as it is, IPv4-mapped IPv6 as IPv4, IPv6 by its /64, anything else as given", () => {
  assert.equal(peerKey(CLIENT), CLIENT);
  assert.equal(peerKey(`::ffff:${CLIENT}`), CLIENT);
  assert.equal(peerKey(V6("1")), "2001:db8:1:2::/64");
  assert.equal(peerKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.notEqual(peerKey("2001:db8:1:3::1"), peerKey(V6("1")));
  assert.equal(peerKey("::1"), "0:0:0:0::/64");
  assert.equal(peerKey("unknown"), "unknown");
});

test("on Render the setup takes the code: with RENDER_EXTERNAL_URL and no AGENTRUN_PUBLIC_URL, setup with no code is a 403 and with the printed code a 201; AGENTRUN_PUBLIC_URL wins when both are set", { timeout: 60_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const start = async (env) => {
    const root = await scratch(t);
    const data = join(root, "agents");
    // A home of its own: a first start counts the sessions in its home for setup's offer, and this machine's are not the test's.
    const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root, AGENTRUN_PUBLIC_URL: "", AGENTRUN_ACCOUNTS: "", ...env } });
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
  const code = /^Set up this server: https:\/\/agentrun-example\.onrender\.com\/setup#code=([A-Za-z0-9_-]{22}) \(or paste AGENTRUN_TOKEN\)$/m.exec(render.out)?.[1];
  assert.ok(code && render.port, render.out);
  assert.equal((await setup(render, { password: PASSWORD })).status, 403);
  const made = await setup(render, { password: PASSWORD, code });
  assert.equal(made.status, 201, made.text);
  const both = await start({ RENDER_EXTERNAL_URL: "https://agentrun-example.onrender.com", AGENTRUN_PUBLIC_URL: "https://agents.example.com" });
  assert.match(both.out, /^Set up this server: https:\/\/agents\.example\.com\/setup#code=[A-Za-z0-9_-]{22} \(or paste AGENTRUN_TOKEN\)$/m);
  assert.match(both.out, /^AGENTRUN_BASE_URL=https:\/\/agents\.example\.com\/v2$/m);
});

test("a sign-in from a new address when the limit's table is full goes through, held by the server's budget only, and the log says sign_in_table_full", async (t) => {
  const lines = [];
  const server = await owned(t, { signInAddresses: 0, log: (line) => lines.push(line) });
  const full = await signIn(server, PASSWORD);
  assert.equal(full.status, 200, full.text);
  assert.ok(lines.some((line) => / event=auth_failed route=\/v2\/auth\/sign-in reason=sign_in_table_full$/.test(line)), lines.join("\n"));
});
