// `agentrun login --to URL` signs in with a device code (RFC 8628) when the target's GET /v2/capabilities offers it, and
// reads a token from stdin as before when it does not. Each sign-in runs against a loopback device server of its own;
// the stdin path also runs against a real server started with a faux model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./support.mjs";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const DEVICE = new URL("../lib/device.mjs", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "AGENTRUN_CLOUD_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];
const TOKEN = "device-issued-token-0123456789";
const DEVICE_CODE = "device-code-never-shown-abcdef";
const VERIFY = "https://console.agentrun.example/device";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-signin-"));
  removeAtEnd(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name)));
  return { dir, config: join(dir, ".config", "agentrun", "config.json"), env: { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), AGENTRUN_BOXES: "none" } };
}

/** The CLI in a child process (a server in this one answers it), killed after `timeout` ms, its code then null. */
const cli = (env, args, { input = "", timeout = 30_000, cwd } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.once("close", (code, signal) => (clearTimeout(timer), resolve({ code, signal, out, err })));
  child.stdin.end(input);
});

const json = (status, body, headers = {}) => [status, { "content-type": "application/json", ...headers }, typeof body === "string" ? body : JSON.stringify(body)];
const pending = json(400, { error: "authorization_pending" });
const issued = json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600 });

/** A device server on loopback: capabilities that offer device sign-in, its metadata, the authorization endpoint and the
 *  token endpoint, which answers `tokens` in turn (the last one again once they run out). `routes` replaces any answer
 *  by "METHOD /path", given the origin. Every request is recorded, with the time it came. */
async function deviceServer(t, { tokens = [issued], routes = () => ({}) } = {}) {
  const requests = [];
  let polls = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), at: Date.now() };
      requests.push(request);
      const table = { ...defaults(origin), ...routes(origin) };
      const route = table[`${req.method} ${req.url.split("?")[0]}`];
      const [status, headers, body] = route ? route(request) : [404, {}, ""];
      res.writeHead(status, headers).end(body);
    });
  });
  const defaults = (at) => ({
    "GET /v2/capabilities": () => json(200, { version: "test", sign_in: { device: { metadata: `${at}/auth/device`, scope: "agentrun:deploy" } } }),
    "GET /auth/device": () => json(200, { issuer: at, client_id: "agentrun-cli", device_authorization_endpoint: `${at}/auth/device/code`, token_endpoint: `${at}/auth/device/token`, scope: "research:read research:write", resource: "https://api.agentrun.example", verification_uri: VERIFY }),
    "POST /auth/device/code": () => json(200, { device_code: DEVICE_CODE, user_code: "KQ7-4MZ", verification_uri: VERIFY, verification_uri_complete: `${VERIFY}?code=KQ7-4MZ`, expires_in: 600, interval: 1 }),
    "POST /auth/device/token": () => tokens[Math.min(polls++, tokens.length - 1)],
    "GET /v2/agents/notes": () => json(200, { agent_id: "notes" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  const of = (method, path) => requests.filter((r) => r.method === method && r.url.split("?")[0] === path);
  return { origin, base: `${origin}/v2`, requests, of, polls: () => of("POST", "/auth/device/token") };
}

/** What every sign-in that fails holds to: its exit code, its words, nothing written, no stack trace, no secret shown. */
function refusedClean(result, code, words, config) {
  assert.equal(result.code, code, `exit ${result.code}: ${result.err}`);
  assert.match(result.err, words);
  assert.match(result.err, /nothing was written/);
  assert.doesNotMatch(result.err, /\n\s+at \S+ \(|TypeError|SyntaxError/, "no crash");
  assert.equal(existsSync(config), false, "no config written");
  for (const text of [result.out, result.err]) assert.ok(!text.includes(TOKEN) && !text.includes(DEVICE_CODE), "no token or device code shown");
}

test("login --to: the device flow asks the capabilities' scope, shows the code, polls past authorization_pending at the interval, keeps the token where a pasted one goes, and the next command sends it", async (t) => {
  const { env, config } = scratch();
  const server = await deviceServer(t, { tokens: [pending, pending, issued] });
  // The address with no /v2: login adds it, as it adds it for cloud.
  const login = await cli(env, ["login", "--to", server.origin]);
  assert.equal(login.code, 0, login.err);
  assert.deepEqual(JSON.parse(login.out), { base_url: server.base, config_file: config });
  assert.match(login.err, new RegExp(`${VERIFY.replace(/[.]/g, "\\.")}`));
  assert.match(login.err, /KQ7-4MZ/);
  for (const text of [login.out, login.err]) assert.ok(!text.includes(TOKEN) && !text.includes(DEVICE_CODE), "no token or device code shown");
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: server.base, api_key: TOKEN });
  assert.equal(statSync(config).mode & 0o777, 0o600);

  const [authorize] = server.of("POST", "/auth/device/code");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(authorize.body)), { client_id: "agentrun-cli", scope: "agentrun:deploy", audience: "https://api.agentrun.example" });
  assert.equal(authorize.headers.authorization, undefined, "the authorization request carries no token");
  const polls = server.polls();
  assert.equal(polls.length, 3);
  for (const poll of polls) {
    const form = Object.fromEntries(new URLSearchParams(poll.body));
    assert.equal(form.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(form.device_code, DEVICE_CODE);
    assert.equal(form.client_id, "agentrun-cli");
  }
  assert.ok(polls[0].at - authorize.at >= 900, "the first poll waits the interval");
  for (let i = 1; i < polls.length; i++) assert.ok(polls[i].at - polls[i - 1].at >= 900, `poll ${i + 1} waits the interval after authorization_pending`);

  // No flag, no data directory: the config's server and the token the device flow got.
  const next = await cli(env, ["agents", "get", "notes", "--data", join(env.HOME, "nowhere")]);
  assert.equal(next.code, 0, next.err);
  assert.deepEqual(JSON.parse(next.out), { agent_id: "notes" });
  assert.equal(server.of("GET", "/v2/agents/notes").at(-1).headers.authorization, `Bearer ${TOKEN}`);
});

test("login --to: slow_down adds 5 s to the interval, and the code's expiry stops the wait with nothing written", async (t) => {
  const { env, config } = scratch();
  // Interval 1 s, 4 s to live: after slow_down the next poll would be 6 s on, past the expiry, so there is one poll only.
  const server = await deviceServer(t, {
    tokens: [json(400, { error: "slow_down" })],
    routes: () => ({ "POST /auth/device/code": () => json(200, { device_code: DEVICE_CODE, user_code: "KQ7-4MZ", verification_uri: VERIFY, expires_in: 4, interval: 1 }) }),
  });
  const began = Date.now();
  const result = await cli(env, ["login", "--to", server.base]);
  refusedClean(result, 4, /expired/, config);
  assert.equal(server.polls().length, 1, "no poll after slow_down until the raised interval");
  assert.ok(Date.now() - began >= 3500, "it waited until the code expired");
});

test("login --to: the server's expired_token and access_denied each stop the wait, exit 4, with nothing written", async (t) => {
  for (const [error, words] of [["expired_token", /expired/], ["access_denied", /denied/]]) {
    const { env, config } = scratch();
    const server = await deviceServer(t, { tokens: [json(400, { error })] });
    const result = await cli(env, ["login", "--to", server.base]);
    refusedClean(result, 4, words, config);
    assert.equal(server.polls().length, 1, error);
  }
});

test("login --to: a URL off the target's origin, a redirect, or a malformed answer is refused before any code is shown or token kept", async (t) => {
  const other = await deviceServer(t);
  const ok = (at) => ({ issuer: at, client_id: "agentrun-cli", device_authorization_endpoint: `${at}/auth/device/code`, token_endpoint: `${at}/auth/device/token`, scope: "research:read research:write", resource: "https://api.agentrun.example" });
  const grant = { device_code: DEVICE_CODE, user_code: "KQ7-4MZ", verification_uri: VERIFY, expires_in: 600, interval: 1 };
  const cases = {
    // The metadata URL the capabilities name, on another host (localhost for 127.0.0.1), another port, or https.
    "metadata on another host": (at) => ({ "GET /v2/capabilities": () => json(200, { sign_in: { device: { metadata: `${at.replace("127.0.0.1", "localhost")}/auth/device`, scope: "agentrun:deploy" } } }) }),
    "metadata on another port": () => ({ "GET /v2/capabilities": () => json(200, { sign_in: { device: { metadata: `${other.origin}/auth/device`, scope: "agentrun:deploy" } } }) }),
    "metadata relative": () => ({ "GET /v2/capabilities": () => json(200, { sign_in: { device: { metadata: "/auth/device", scope: "agentrun:deploy" } } }) }),
    "metadata with a user": (at) => ({ "GET /v2/capabilities": () => json(200, { sign_in: { device: { metadata: at.replace("//", "//someone@") + "/auth/device", scope: "agentrun:deploy" } } }) }),
    "scope not a scope": (at) => ({ "GET /v2/capabilities": () => json(200, { sign_in: { device: { metadata: `${at}/auth/device`, scope: "agentrun:deploy\nx" } } }) }),
    "device not an object": () => ({ "GET /v2/capabilities": () => json(200, { sign_in: { device: "yes" } }) }),
    // The metadata's endpoints and issuer, on another origin.
    "token endpoint elsewhere": (at) => ({ "GET /auth/device": () => json(200, { ...ok(at), token_endpoint: `${other.origin}/auth/device/token` }) }),
    "authorization endpoint elsewhere": (at) => ({ "GET /auth/device": () => json(200, { ...ok(at), device_authorization_endpoint: `${other.origin}/auth/device/code` }) }),
    "issuer elsewhere": (at) => ({ "GET /auth/device": () => json(200, { ...ok(at), issuer: other.origin }) }),
    "endpoint over https on a loopback target": (at) => ({ "GET /auth/device": () => json(200, { ...ok(at), token_endpoint: `${at.replace("http:", "https:")}/auth/device/token` }) }),
    // Redirects, even to the same origin, are never followed.
    "metadata redirects": (at) => ({ "GET /auth/device": () => [302, { location: `${at}/auth/device2` }, ""], "GET /auth/device2": () => json(200, ok(at)) }),
    "authorization redirects": (at) => ({ "POST /auth/device/code": () => [307, { location: `${at}/auth/device/code2` }, ""], "POST /auth/device/code2": () => json(200, grant) }),
    // Malformed answers.
    "metadata not JSON": () => ({ "GET /auth/device": () => [200, { "content-type": "application/json" }, "{not json"] }),
    "metadata missing its token endpoint": (at) => ({ "GET /auth/device": () => json(200, { ...ok(at), token_endpoint: undefined }) }),
    "metadata too large": (at) => ({ "GET /auth/device": () => json(200, { ...ok(at), padding: "x".repeat(70_000) }) }),
    "grant not JSON": () => ({ "POST /auth/device/code": () => [200, { "content-type": "application/json" }, "{not json"] }),
    "grant an array": () => ({ "POST /auth/device/code": () => json(200, [grant]) }),
    "grant too large": () => ({ "POST /auth/device/code": () => json(200, { ...grant, padding: "x".repeat(70_000) }) }),
    "grant with no expiry": () => ({ "POST /auth/device/code": () => json(200, { ...grant, expires_in: 0 }) }),
    "grant interval a string": () => ({ "POST /auth/device/code": () => json(200, { ...grant, interval: "5" }) }),
    "grant user code with a control character": () => ({ "POST /auth/device/code": () => json(200, { ...grant, user_code: "KQ7\u001b[2J" }) }),
    "grant verification over http elsewhere": () => ({ "POST /auth/device/code": () => json(200, { ...grant, verification_uri: "http://console.agentrun.example/device" }) }),
    "grant refused": () => ({ "POST /auth/device/code": () => json(400, { error: "invalid_client" }) }),
  };
  for (const [name, routes] of Object.entries(cases)) {
    const { env, config } = scratch();
    const server = await deviceServer(t, { routes });
    const result = await cli(env, ["login", "--to", server.base]);
    refusedClean(result, 1, /./, config);
    assert.equal(server.polls().length, 0, `${name}: no poll`);
    assert.doesNotMatch(result.err, /KQ7/, `${name}: no code shown`);
    assert.equal(server.of("GET", "/auth/device2").length + server.of("POST", "/auth/device/code2").length, 0, `${name}: no redirect followed`);
  }
  // Its own paths only: a local tool that lists dev servers may GET / on any new loopback listener.
  assert.deepEqual(other.requests.filter((r) => /^\/(?:v2|auth)\//.test(r.url)).map((r) => `${r.method} ${r.url}`), [], "nothing was sent to the other origin");
});

test("login --to: a token answer that redirects or is malformed is refused, exit 1, with nothing written", async (t) => {
  const cases = {
    redirect: [302, { location: "/auth/device/token2" }, ""],
    "token type mac": json(200, { access_token: TOKEN, token_type: "mac" }),
    "token with a space": json(200, { access_token: `${TOKEN} x`, token_type: "bearer" }),
    "no token": json(200, { token_type: "bearer" }),
    "not JSON": [200, { "content-type": "application/json" }, "<html>"],
  };
  for (const [name, answer] of Object.entries(cases)) {
    const { env, config } = scratch();
    const server = await deviceServer(t, { tokens: [answer] });
    const result = await cli(env, ["login", "--to", server.base]);
    refusedClean(result, 1, /./, config);
    assert.equal(server.polls().length, 1, name);
    assert.equal(server.of("POST", "/auth/device/token2").length, 0, `${name}: no redirect followed`);
  }
});

test("login --to: a 503 waits as long as its Retry-After asks, as an HTTP date too, past the doubled interval, then polls on", async (t) => {
  const { env, config } = scratch();
  let n = 0;
  const answers = [
    // Interval 1 s: doubled, the next poll would come 2 s on; the date asks 3 s or more (it is whole seconds).
    () => json(503, "", { "retry-after": new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() }),
    () => issued,
  ];
  const server = await deviceServer(t, { routes: () => ({ "POST /auth/device/token": () => answers[Math.min(n++, answers.length - 1)]() }) });
  const result = await cli(env, ["login", "--to", server.base]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: server.base, api_key: TOKEN });
  const polls = server.polls();
  assert.equal(polls.length, 2);
  assert.ok(polls[1].at - polls[0].at >= 3900, `the date's wait was kept: ${polls[1].at - polls[0].at} ms`);
});

test("Retry-After: delay seconds or an HTTP date, in ms from now, never cut short; anything else, or a time past, is none", async () => {
  const { retryAfterMs } = await import(DEVICE);
  const now = Date.parse("2026-11-22T04:00:00Z");
  assert.equal(retryAfterMs("4", now), 4000);
  assert.equal(retryAfterMs("600", now), 600_000, "a wait past 300 s is the server's to ask; the code's expiry bounds it");
  assert.equal(retryAfterMs("Sun, 22 Nov 2026 04:00:10 GMT", now), 10_000);
  for (const value of [null, "", "0", "-5", "1.5", "4s", "soon", "Sun, 22 Nov 2026 03:59:00 GMT", "9".repeat(400)]) assert.equal(retryAfterMs(value, now), 0, String(value));
});

test("the device checks: an http target or URL off loopback is refused, and so is every URL off the target's origin", async () => {
  const { deviceOffer } = await import(DEVICE);
  const offer = (metadata, scope = "agentrun:deploy") => ({ sign_in: { device: { metadata, scope } } });
  assert.equal(deviceOffer({ version: "x" }, "https://api.agentrun.example/v2"), undefined, "no sign_in: no offer");
  assert.equal(deviceOffer({ sign_in: {} }, "https://api.agentrun.example/v2"), undefined, "no sign_in.device: no offer");
  const taken = deviceOffer(offer("https://api.agentrun.example/auth/device"), "https://api.agentrun.example/v2");
  assert.equal(taken.metadata.href, "https://api.agentrun.example/auth/device");
  assert.equal(taken.scope, "agentrun:deploy");
  const refused = [
    // http off loopback, the target's own origin or not.
    [offer("http://api.agentrun.example/auth/device"), "http://api.agentrun.example/v2"],
    [offer("http://api.agentrun.example/auth/device"), "https://api.agentrun.example/v2"],
    // Another origin: host, port, scheme.
    [offer("https://evil.example/auth/device"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example:8443/auth/device"), "https://api.agentrun.example/v2"],
    // A user, a fragment, a query, a backslash, port 0.
    [offer("https://someone@api.agentrun.example/auth/device"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example/auth/device#x"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example/auth/device?x=1"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example\\@evil.example/auth/device"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example:0/auth/device"), "https://api.agentrun.example:0/v2"],
    // A scope that is no scope.
    [offer("https://api.agentrun.example/auth/device", ""), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example/auth/device", "a\"b"), "https://api.agentrun.example/v2"],
  ];
  for (const [capabilities, base] of refused) assert.throws(() => deviceOffer(capabilities, base), (error) => error.code === 1 || error.code === 2, JSON.stringify(capabilities));
});

test("login --to: a target with no sign_in.device takes the token from stdin as before, against a real server and a fake one", async (t) => {
  const { dir, env, config } = scratch();
  const faux = join(dir, "faux.mjs");
  writeFileSync(faux, 'export default (context, faux) => faux.message("The answer is 42.");\n');
  const data = join(dir, "data");
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", faux], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0" } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const base = JSON.parse(readFileSync(join(data, ".server.json"), "utf8")).base_url;
  const token = readFileSync(join(data, ".token"), "utf8").trim();
  // On a terminal it would ask for the token as before: stdin is read, so a wrong one is refused and nothing written.
  const wrong = await cli(env, ["login", "--to", base], { input: "fake-test-key\n" });
  assert.equal(wrong.code, 4, wrong.err);
  assert.match(wrong.err, /refused the token; nothing was written/);
  assert.equal(existsSync(config), false);
  const done = await cli(env, ["login", "--to", base], { input: `${token}\n` });
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(JSON.parse(done.out), { base_url: base, config_file: config });
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: base, api_key: token });
  const listed = await cli(env, ["agents", "list", "--data", join(dir, "nowhere")]);
  assert.equal(listed.code, 0, listed.err);
  assert.ok(Array.isArray(JSON.parse(listed.out).agents));
  assert.ok(!(done.out + done.err + listed.out + listed.err).includes(token), "no output holds the token");

  // A target whose capabilities name sign_in but no device: stdin as well, its check the agents list.
  const fake = scratch();
  const server = await deviceServer(t, { routes: () => ({ "GET /v2/capabilities": () => json(200, { sign_in: {} }), "GET /v2/agents": () => json(200, { agents: [], next_cursor: null }) }) });
  const taken = await cli(fake.env, ["login", "--to", server.base], { input: "fake-test-key\n" });
  assert.equal(taken.code, 0, taken.err);
  assert.equal(server.of("GET", "/auth/device").length, 0, "no device flow");
  assert.equal(server.of("GET", "/v2/agents").at(-1).headers.authorization, "Bearer fake-test-key");
  assert.deepEqual(JSON.parse(readFileSync(fake.config, "utf8")), { base_url: server.base, api_key: "fake-test-key" });

  // --to and --base-url name the server twice: refused.
  const both = await cli(fake.env, ["login", "--to", server.base, "--base-url", server.base], { input: "fake-test-key\n" });
  assert.equal(both.code, 2, both.err);
});

test("login --to cloud names AgentRun cloud's address, or AGENTRUN_CLOUD_URL's", async (t) => {
  const { env, config } = scratch();
  const server = await deviceServer(t);
  const result = await cli({ ...env, AGENTRUN_CLOUD_URL: server.origin }, ["login", "--to", "cloud"]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: server.base, api_key: TOKEN });
  const { CLOUD_URL } = await import(new URL("../lib/target.mjs", import.meta.url).pathname);
  assert.equal(CLOUD_URL, "https://api.agentrun.ai");
});
