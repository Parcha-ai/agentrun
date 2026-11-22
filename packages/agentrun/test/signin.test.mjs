// `agentrun login` signs in with a device code (RFC 8628) when the target's GET /v2/capabilities offers it (--to, or a
// server named otherwise from a terminal), and reads a token from stdin as before when it does not. One sign-in runs
// end to end through the CLI; the flow's waits and refusals run in this process on a fake clock, each against a loopback
// device server of its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { main } from "../lib/cli.mjs";
import { SignInError, capabilitiesOf, deviceOffer, deviceSignIn, retryAfterMs } from "../lib/device.mjs";
import { CLOUD_URL } from "../lib/target.mjs";
import { removeAtEnd } from "./support.mjs";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
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
const cli = (env, args, { input = "", timeout = 30_000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
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
const metadataOf = (at) => ({ client_id: "agentrun-cli", device_authorization_endpoint: `${at}/auth/device/code`, token_endpoint: `${at}/auth/device/token`, resource: "https://api.agentrun.example", verification_uri: VERIFY });
const GRANT = { device_code: DEVICE_CODE, user_code: "KQ7-4MZ", verification_uri: VERIFY, verification_uri_complete: `${VERIFY}?code=KQ7-4MZ`, expires_in: 600, interval: 1 };

/** A device server on loopback: capabilities that offer device sign-in, its metadata (no issuer and no scope: the flow
 *  reads neither), the authorization endpoint and the token endpoint, which answers `tokens` in turn (the last one again
 *  once they run out; each may be a function of the request). `routes` replaces any answer by "METHOD /path", given the
 *  origin. It answers and records its own routes alone: anything else (a local tool may GET / on any new loopback
 *  listener) is a bare 404, never recorded. */
async function deviceServer(t, { tokens = [issued], routes = () => ({}) } = {}) {
  const requests = [];
  let polls = 0;
  const server = createServer((req, res) => {
    const table = { ...defaults(origin), ...routes(origin) };
    const route = table[`${req.method} ${req.url.split("?")[0]}`];
    if (!route) return void req.resume().on("end", () => res.writeHead(404).end());
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(request);
      const answer = route(request);
      // A token endpoint that drops the connection: a request that fails.
      if (answer === "drop") return void req.socket.destroy();
      const [status, headers, body] = answer;
      res.writeHead(status, headers).end(body);
    });
  });
  const defaults = (at) => ({
    "GET /v2/capabilities": () => json(200, { version: "test", sign_in: { device: { metadata: `${at}/auth/device`, scope: "agentrun:deploy" } } }),
    "GET /auth/device": () => json(200, metadataOf(at)),
    "POST /auth/device/code": () => json(200, GRANT),
    "POST /auth/device/token": (request) => {
      const answer = tokens[Math.min(polls++, tokens.length - 1)];
      return typeof answer === "function" ? answer(request) : answer;
    },
    "GET /v2/agents/notes": () => json(200, { agent_id: "notes" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  const of = (method, path) => requests.filter((r) => r.method === method && r.url.split("?")[0] === path);
  return { origin, base: `${origin}/v2`, requests, of, polls: () => of("POST", "/auth/device/token") };
}

/** A clock whose `wait` settles at once and moves `now` on by what it waited: each wait is recorded, none is real. */
function fakeClock(start = Date.parse("2026-11-22T04:00:00Z")) {
  const waits = [];
  let at = start;
  return { waits, now: () => at, wait: async (ms) => void (waits.push(ms), (at += ms)) };
}

/** The device sign-in against `server`, in this process on `clock`: the token, or the SignInError it stopped with, and
 *  what it said to the person. */
async function signIn(server, clock = fakeClock()) {
  const said = [];
  const io = { stderr: { write: (chunk) => void said.push(String(chunk)) } };
  try {
    const offer = deviceOffer(await capabilitiesOf(server.base), server.base);
    return { token: await deviceSignIn(server.base, offer, io, clock), said: said.join(""), waits: clock.waits };
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    return { error, said: said.join(""), waits: clock.waits };
  }
}

/** What every sign-in that fails holds to: its exit code, its words, that nothing was written, no secret shown. */
function refusedClean(result, code, words) {
  assert.ok(result.error, `refused, not ${result.token}`);
  assert.equal(result.error.code, code, result.error.message);
  assert.match(result.error.message, words);
  assert.match(result.error.message, /nothing was written/);
  for (const text of [result.error.message, result.said]) assert.ok(!text.includes(TOKEN) && !text.includes(DEVICE_CODE), "no token or device code shown");
}

test("login --to cloud: the device flow asks the capabilities' scope, names this CLI and its version, shows the code, keeps the token where a pasted one goes, and the next command sends it", async (t) => {
  assert.equal(CLOUD_URL, "https://api.agentrun.ai");
  const { env, config } = scratch();
  const server = await deviceServer(t);
  // Cloud's address (AGENTRUN_CLOUD_URL's here) with no /v2: login adds it.
  const login = await cli({ ...env, AGENTRUN_CLOUD_URL: server.origin }, ["login", "--to", "cloud"]);
  assert.equal(login.code, 0, login.err);
  assert.deepEqual(JSON.parse(login.out), { base_url: server.base, config_file: config });
  assert.ok(login.err.includes(`Open ${VERIFY} and enter the code KQ7-4MZ`), login.err);
  for (const text of [login.out, login.err]) assert.ok(!text.includes(TOKEN) && !text.includes(DEVICE_CODE), "no token or device code shown");
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: server.base, api_key: TOKEN });
  assert.equal(statSync(config).mode & 0o777, 0o600);

  assert.deepEqual(server.requests.map((r) => [`${r.method} ${r.url}`, r.headers["user-agent"]]), [
    ["GET /v2/capabilities", `agentrun-cli/${VERSION}`],
    ["GET /auth/device", `agentrun-cli/${VERSION}`],
    ["POST /auth/device/code", `agentrun-cli/${VERSION}`],
    ["POST /auth/device/token", `agentrun-cli/${VERSION}`],
  ]);
  const [authorize] = server.of("POST", "/auth/device/code");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(authorize.body)), { client_id: "agentrun-cli", scope: "agentrun:deploy", audience: "https://api.agentrun.example" });
  assert.equal(authorize.headers.authorization, undefined, "the authorization request carries no token");
  const [poll] = server.polls();
  assert.deepEqual(Object.fromEntries(new URLSearchParams(poll.body)), { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: DEVICE_CODE, client_id: "agentrun-cli", audience: "https://api.agentrun.example" });

  // No flag, no data directory: the config's server and the token the device flow got.
  const next = await cli(env, ["agents", "get", "notes", "--data", join(env.HOME, "nowhere")]);
  assert.equal(next.code, 0, next.err);
  assert.deepEqual(JSON.parse(next.out), { agent_id: "notes" });
  assert.equal(server.of("GET", "/v2/agents/notes").at(-1).headers.authorization, `Bearer ${TOKEN}`);
});

test("the poll waits the interval before each poll, again after authorization_pending, and ends with the token", async (t) => {
  const server = await deviceServer(t, { tokens: [pending, pending, issued] });
  const result = await signIn(server);
  assert.equal(result.token, TOKEN);
  assert.deepEqual(result.waits, [1000, 1000, 1000]);
  assert.equal(server.polls().length, 3);
  assert.match(result.said, /the code expires in 10 min/);
});

test("slow_down adds 5 s to the interval, cut at the code's expiry, which stops the wait, exit 4", async (t) => {
  const slow = json(400, { error: "slow_down" });
  const raised = await signIn(await deviceServer(t, { tokens: [slow, issued] }));
  assert.equal(raised.token, TOKEN);
  assert.deepEqual(raised.waits, [1000, 6000]);
  // 4 s to live: after slow_down the next poll would be 6 s on, so the wait ends at the expiry, with no second poll.
  const short = await deviceServer(t, { tokens: [slow], routes: () => ({ "POST /auth/device/code": () => json(200, { ...GRANT, expires_in: 4 }) }) });
  const cut = await signIn(short);
  refusedClean(cut, 4, /expired/);
  assert.deepEqual(cut.waits, [1000, 3000]);
  assert.equal(short.polls().length, 1);
});

test("the code's expiry before approval, the server's expired_token and its access_denied each stop the wait, exit 4", async (t) => {
  const lapsing = await deviceServer(t, { tokens: [pending], routes: () => ({ "POST /auth/device/code": () => json(200, { ...GRANT, expires_in: 3 }) }) });
  const lapsed = await signIn(lapsing);
  refusedClean(lapsed, 4, /expired before the sign-in was approved/);
  assert.deepEqual(lapsed.waits, [1000, 1000, 1000]);
  assert.equal(lapsing.polls().length, 2, "no poll at the expiry");
  for (const [error, words] of [["expired_token", /expired/], ["access_denied", /denied/]]) {
    const server = await deviceServer(t, { tokens: [json(400, { error })] });
    const result = await signIn(server);
    refusedClean(result, 4, words);
    assert.equal(server.polls().length, 1, error);
  }
});

test("a 503 waits as long as its Retry-After asks, in seconds or as an HTTP date, past the doubled interval, then polls on", async (t) => {
  // Interval 1 s: doubled, the next poll would come 2 s on; the server asks 4 s, or a date 10 s on from its answer.
  for (const [header, wait] of [[() => "4", 4000], [(now) => new Date(now + 10_000).toUTCString(), 10_000]]) {
    const clock = fakeClock();
    const server = await deviceServer(t, { tokens: [() => json(503, "", { "retry-after": header(clock.now()) }), issued] });
    const result = await signIn(server, clock);
    assert.equal(result.token, TOKEN);
    assert.deepEqual(result.waits, [1000, wait]);
  }
});

test("429s, 5xx and requests that fail double the wait up to 60 s; an answer of the flow's own goes back to the interval", async (t) => {
  const failed = (status) => json(status, { error: "server_error" });
  const server = await deviceServer(t, { tokens: [failed(500), failed(429), failed(503), failed(502), failed(500), () => "drop", failed(500), pending, issued] });
  const result = await signIn(server);
  assert.equal(result.token, TOKEN);
  assert.deepEqual(result.waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 1000]);
});

test("a URL off the target's origin, a redirect, or a malformed answer is refused before any code is shown or token kept", async (t) => {
  const other = await deviceServer(t);
  const cases = {
    // The metadata's endpoints, on another origin, or over https while the target is on loopback over http.
    "token endpoint elsewhere": (at) => ({ "GET /auth/device": () => json(200, { ...metadataOf(at), token_endpoint: `${other.origin}/auth/device/token` }) }),
    "authorization endpoint elsewhere": (at) => ({ "GET /auth/device": () => json(200, { ...metadataOf(at), device_authorization_endpoint: `${other.origin}/auth/device/code` }) }),
    "endpoint over https on a loopback target": (at) => ({ "GET /auth/device": () => json(200, { ...metadataOf(at), token_endpoint: `${at.replace("http:", "https:")}/auth/device/token` }) }),
    // Redirects, even to the same origin, are never followed.
    "metadata redirects": (at) => ({ "GET /auth/device": () => [302, { location: `${at}/auth/device2` }, ""], "GET /auth/device2": () => json(200, metadataOf(at)) }),
    "authorization redirects": (at) => ({ "POST /auth/device/code": () => [307, { location: `${at}/auth/device/code2` }, ""], "POST /auth/device/code2": () => json(200, GRANT) }),
    // Malformed answers.
    "metadata not JSON": () => ({ "GET /auth/device": () => [200, { "content-type": "application/json" }, "{not json"] }),
    "metadata missing its token endpoint": (at) => ({ "GET /auth/device": () => json(200, { ...metadataOf(at), token_endpoint: undefined }) }),
    "metadata too large": (at) => ({ "GET /auth/device": () => json(200, { ...metadataOf(at), padding: "x".repeat(70_000) }) }),
    "grant not JSON": () => ({ "POST /auth/device/code": () => [200, { "content-type": "application/json" }, "{not json"] }),
    "grant an array": () => ({ "POST /auth/device/code": () => json(200, [GRANT]) }),
    "grant too large": () => ({ "POST /auth/device/code": () => json(200, { ...GRANT, padding: "x".repeat(70_000) }) }),
    "grant with no expiry": () => ({ "POST /auth/device/code": () => json(200, { ...GRANT, expires_in: 0 }) }),
    "grant interval a string": () => ({ "POST /auth/device/code": () => json(200, { ...GRANT, interval: "5" }) }),
    "grant user code with a control character": () => ({ "POST /auth/device/code": () => json(200, { ...GRANT, user_code: "KQ7\u001b[2J" }) }),
    "grant verification over http elsewhere": () => ({ "POST /auth/device/code": () => json(200, { ...GRANT, verification_uri: "http://console.agentrun.example/device" }) }),
    "grant refused": () => ({ "POST /auth/device/code": () => json(400, { error: "invalid_client" }) }),
  };
  for (const [name, routes] of Object.entries(cases)) {
    const server = await deviceServer(t, { routes });
    const result = await signIn(server);
    refusedClean(result, 1, /./);
    assert.equal(server.polls().length, 0, `${name}: no poll`);
    assert.equal(result.said, "", `${name}: no code shown`);
    assert.equal(server.of("GET", "/auth/device2").length + server.of("POST", "/auth/device/code2").length, 0, `${name}: no redirect followed`);
  }
  assert.deepEqual(other.requests, [], "nothing was sent to the other origin");
});

test("a token answer that redirects or is malformed is refused, exit 1", async (t) => {
  const cases = {
    redirect: [302, { location: "/auth/device/token2" }, ""],
    "token type mac": json(200, { access_token: TOKEN, token_type: "mac" }),
    "token with a space": json(200, { access_token: `${TOKEN} x`, token_type: "bearer" }),
    "no token": json(200, { token_type: "bearer" }),
    "not JSON": [200, { "content-type": "application/json" }, "<html>"],
  };
  for (const [name, answer] of Object.entries(cases)) {
    const server = await deviceServer(t, { tokens: [answer], routes: () => ({ "POST /auth/device/token2": () => issued }) });
    const result = await signIn(server);
    refusedClean(result, 1, /./);
    assert.equal(server.polls().length, 1, name);
    assert.equal(server.of("POST", "/auth/device/token2").length, 0, `${name}: no redirect followed`);
  }
});

test("Retry-After: delay seconds or an HTTP date, in ms from now, never cut short; anything else, or a time past, is none", () => {
  const now = Date.parse("2026-11-22T04:00:00Z");
  assert.equal(retryAfterMs("4", now), 4000);
  assert.equal(retryAfterMs("600", now), 600_000, "a wait past 300 s is the server's to ask; the code's expiry bounds it");
  assert.equal(retryAfterMs("Sun, 22 Nov 2026 04:00:10 GMT", now), 10_000);
  for (const value of [null, "", "0", "-5", "1.5", "4s", "soon", "Sun, 22 Nov 2026 03:59:00 GMT", "9".repeat(400)]) assert.equal(retryAfterMs(value, now), 0, String(value));
});

test("the device offer: an http target or URL off loopback is refused, and so is every URL off the target's origin, a relative one, and an offer that is no object", () => {
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
    // Another origin: host (localhost is not 127.0.0.1), port, scheme; or no origin at all.
    [offer("https://evil.example/auth/device"), "https://api.agentrun.example/v2"],
    [offer("http://localhost:7340/auth/device"), "http://127.0.0.1:7340/v2"],
    [offer("https://api.agentrun.example:8443/auth/device"), "https://api.agentrun.example/v2"],
    [offer("/auth/device"), "https://api.agentrun.example/v2"],
    // A user, a fragment, a query, a backslash, port 0.
    [offer("https://someone@api.agentrun.example/auth/device"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example/auth/device#x"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example/auth/device?x=1"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example\\@evil.example/auth/device"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example:0/auth/device"), "https://api.agentrun.example:0/v2"],
    // A scope that is no scope, and an offer that is no object.
    [offer("https://api.agentrun.example/auth/device", ""), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example/auth/device", "a\"b"), "https://api.agentrun.example/v2"],
    [offer("https://api.agentrun.example/auth/device", "agentrun:deploy\nx"), "https://api.agentrun.example/v2"],
    [{ sign_in: { device: "yes" } }, "https://api.agentrun.example/v2"],
  ];
  for (const [capabilities, base] of refused) assert.throws(() => deviceOffer(capabilities, base), (error) => error.code === 1 || error.code === 2, JSON.stringify(capabilities));
});

test("login reads the token from stdin off a terminal: --to a server with no sign_in.device, and --base-url whatever the server offers", async (t) => {
  // The fake's agents list takes the one token it knows, as a token check does.
  const agents = (request) => (request.headers.authorization === "Bearer fake-test-key" ? json(200, { agents: [], next_cursor: null }) : json(401, { error: { code: "unauthorized", message: "Unknown token." } }));
  const plain = await deviceServer(t, { routes: () => ({ "GET /v2/capabilities": () => json(200, { sign_in: {} }), "GET /v2/agents": agents }) });
  const { env, config } = scratch();
  const wrong = await cli(env, ["login", "--to", plain.base], { input: "another-key\n" });
  assert.equal(wrong.code, 4, wrong.err);
  assert.match(wrong.err, /refused the token; nothing was written/);
  assert.equal(existsSync(config), false);
  const taken = await cli(env, ["login", "--to", plain.base], { input: "fake-test-key\n" });
  assert.equal(taken.code, 0, taken.err);
  assert.equal(plain.of("GET", "/auth/device").length, 0, "no device flow");
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: plain.base, api_key: "fake-test-key" });

  // --base-url off a terminal reads stdin, as a script gives it, though the server offers a device sign-in.
  const offering = await deviceServer(t, { routes: () => ({ "GET /v2/agents": agents }) });
  const scripted = scratch();
  const piped = await cli(scripted.env, ["login", "--base-url", offering.base], { input: "fake-test-key\n" });
  assert.equal(piped.code, 0, piped.err);
  assert.deepEqual(offering.requests.map((r) => `${r.method} ${r.url}`), ["GET /v2/agents?limit=1"], "no capabilities asked, no device flow");
  assert.deepEqual(JSON.parse(readFileSync(scripted.config, "utf8")), { base_url: offering.base, api_key: "fake-test-key" });

  // --to and --base-url name the server twice: refused.
  const both = await cli(env, ["login", "--to", plain.base, "--base-url", plain.base], { input: "fake-test-key\n" });
  assert.equal(both.code, 2, both.err);
});

test("login --base-url or AGENTRUN_BASE_URL on a terminal takes the device sign-in when the server offers one, else refuses a typed token as before", async (t) => {
  /** The CLI in this process with stdin a terminal: its exit code and what it wrote, and the config's path. */
  const onTerminal = async (args, extra = {}) => {
    const { env, config } = scratch();
    let out = "";
    let err = "";
    const io = { stdin: Object.assign(Readable.from([]), { isTTY: true }), stdout: { isTTY: false, write: (c) => ((out += c), true), on() {} }, stderr: { isTTY: false, write: (c) => ((err += c), true) } };
    return { code: await main(args, { ...env, ...extra }, io), out, err, config };
  };
  // Offered: the device flow runs (the person denies it here, before any wait).
  const offering = await deviceServer(t, { routes: () => ({ "POST /auth/device/code": () => json(400, { error: "access_denied" }) }) });
  const denied = await onTerminal(["login", "--base-url", offering.base]);
  assert.equal(denied.code, 4, denied.err);
  assert.match(denied.err, /The sign-in was denied; nothing was written\./);
  assert.deepEqual(offering.requests.map((r) => `${r.method} ${r.url}`), ["GET /v2/capabilities", "GET /auth/device", "POST /auth/device/code"]);
  assert.equal(existsSync(denied.config), false);
  // Not offered, or the probe refused (a redirect): the refusal of a token typed on a terminal, exit 2, as before.
  const plain = await deviceServer(t, { routes: () => ({ "GET /v2/capabilities": () => json(200, { sign_in: {} }) }) });
  const redirecting = await deviceServer(t, { routes: (at) => ({ "GET /v2/capabilities": () => [302, { location: `${at}/elsewhere` }, ""] }) });
  for (const [server, args, extra] of [[plain, ["login"], { AGENTRUN_BASE_URL: plain.base }], [redirecting, ["login", "--base-url", redirecting.base]]]) {
    const refused = await onTerminal(args, extra);
    assert.equal(refused.code, 2, refused.err);
    assert.match(refused.err, /read from stdin, never typed on a terminal/);
    assert.deepEqual(server.requests.map((r) => `${r.method} ${r.url}`), ["GET /v2/capabilities"]);
    assert.equal(existsSync(refused.config), false);
  }
});
