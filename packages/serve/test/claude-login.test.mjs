// Claude Code's login on this machine (claude-login.ts): claude-agent on a person's own Claude plan, through the CLI that
// holds the login. The server asks that CLI `auth status` and nothing else: a fake CLI stands in for the pinned one here,
// answering the status a test sets and noting each call (its arguments and the variables it got). Its login directory's
// credentials file is a FIFO, which holds any open of it, so a server that read it would hang there. The mode is turned on
// with the owner's word, refused in one line where more than one person can start runs, and gone, routes and all, under
// AGENTRUN_CLAUDE_CODE_LOGIN=off, where claude-agent runs on the model keys as it does without it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { CLAUDE_LOGIN_ENV, claudeLoginSwitchedOff, envAtPlace, LOGIN_SIGNED_IN_MS, LOGIN_SIGNED_OUT, LOGIN_UNKNOWN, loginBeforeRun, loginForRun, turnOnBody, whyNotOneOwner, withClaudeLogin } from "../dist/claude-login.js";
import { MODEL_KEYS, hostModel } from "../dist/model.js";
import { providerFor } from "../dist/provider.js";
import { agent, follow, secretWritePath, serve, withEnv } from "./support.mjs";

secretWritePath(["GET", "PUT", "DELETE"], /^\/settings\/claude-login$/);
secretWritePath(["POST"], /^\/settings\/claude-login\/login$/);

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_DEFAULT_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", CLAUDE_LOGIN_ENV, ...MODEL_KEYS.map((row) => row.field)];
const OPERATIONS = [["GET", "/settings/claude-login", "getClaudeLogin"], ["PUT", "/settings/claude-login", "turnOnClaudeLogin"], ["DELETE", "/settings/claude-login", "turnOffClaudeLogin"], ["POST", "/settings/claude-login/login", "startClaudeLogin"]];
const SIGNED_OUT = { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
const SIGNED_IN = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "person@example.com", orgName: "Example", subscriptionType: "max" };

/** A fake Claude Code CLI for test `t`: `status` sets what its `auth status` answers; `calls()` are its calls, each its
 *  arguments and the variables it got that matter here. */
async function fakeCli(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-cli-"));
  const [cli, record, answer] = ["claude", "calls.jsonl", "status.json"].map((name) => join(dir, name));
  writeFileSync(
    cli,
    `#!/bin/sh
printf '{"argv":"%s","home":"%s","display":"%s","config":"%s","secure":"%s","profiles":"%s","key":"%s","token":"%s","base":"%s","oauth":"%s"}\\n' "$*" "$HOME" "$DISPLAY" "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" "$ANTHROPIC_CONFIG_DIR" "\${ANTHROPIC_API_KEY:+set}" "\${ANTHROPIC_AUTH_TOKEN:+set}" "\${ANTHROPIC_BASE_URL:+set}" "\${CLAUDE_CODE_OAUTH_TOKEN:+set}" >> '${record}'
if [ "$1 $2" = "auth status" ]; then cat '${answer}'; fi
`,
    { mode: 0o755 },
  );
  const status = (said) => writeFileSync(answer, JSON.stringify(said));
  status(SIGNED_OUT);
  const calls = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { cli, status, calls };
}

const offerOf = async (api) => (await api("GET", "/capabilities")).body.harnesses.find((offer) => offer.id === "claude-agent");

/** Waits until `done()` holds, 10 s at most. */
async function until(done, what) {
  const end = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`not within 10 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("Claude Code's login on this machine: turned on with the owner's word, its status asked of the CLI alone, the CLI's own sign-in started here, turned off", { timeout: 180_000 }, async (t) => {
  // No pinned CLI here (claude-agent installs on first use), so the server asks the `claude` on PATH: the fake. A Claude
  // token a person may set in their own server env is never passed on.
  const fake = await fakeCli(t);
  withEnv(t, { PATH: `${dirname(fake.cli)}${delimiter}${process.env.PATH}`, CLAUDE_CODE_OAUTH_TOKEN: "not-a-secret", DISPLAY: ":42" }, MODEL_VARS);
  const { api, data } = await serve(t, { faux: undefined, harnesses: false });
  const login = join(data, "claude-login");

  // No key: claude-agent runs nothing.
  assert.equal((await offerOf(api)).available, false);
  const before = await api("GET", "/settings/claude-login");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.state, "off");
  assert.equal(before.body.place, "agentrun");
  assert.equal(before.body.can_start, true, "a server on loopback with no public address starts the sign-in on its own machine");
  assert.match(before.body.command, new RegExp(`CLAUDE_SECURESTORAGE_CONFIG_DIR=${login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .* auth login$`));

  // The owner's word that they alone run agents here, and a place the mode knows.
  for (const body of [{}, { only_me: false }, { only_me: true, place: "elsewhere" }]) {
    const refused = await api("PUT", "/settings/claude-login", body);
    assert.equal(refused.status, 422, JSON.stringify(body));
  }
  const on = await api("PUT", "/settings/claude-login", { only_me: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.state, "signed_out");

  // The login's credentials file is a FIFO from here on: any open of it waits for a writer that never comes.
  assert.equal(spawnSync("mkfifo", [join(login, ".credentials.json")]).status, 0);

  // On, with no key: claude-agent runs Anthropic's model on the login.
  const offer = await offerOf(api);
  assert.equal(offer.available, true, JSON.stringify(offer));
  assert.equal(offer.default_model, "anthropic/claude-sonnet-5-5");

  // Signed in: the account the CLI says, for display; no token in any answer.
  fake.status(SIGNED_IN);
  const signedIn = await api("GET", "/settings/claude-login");
  assert.deepEqual(signedIn.body.account, { method: "claude.ai", email: "person@example.com", organization: "Example", plan: "max" });
  assert.equal(signedIn.body.state, "signed_in");
  assert.doesNotMatch(JSON.stringify(signedIn.body), /not-a-secret/);

  // The CLI's own sign-in, started on this machine: it opens the browser and keeps what it gets.
  const started = await api("POST", "/settings/claude-login/login");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await until(() => fake.calls().some((call) => call.argv === "auth login --claudeai"), "the CLI's sign-in started");

  // Every call the server made was the CLI's status or its sign-in, at the login's place, with no key, token or endpoint
  // of ours. A status check runs under a home of its own; the sign-in gets the person's home and desktop, so the CLI can
  // open their browser.
  const calls = fake.calls();
  assert.ok(calls.length >= 4, JSON.stringify(calls));
  for (const call of calls.filter((call) => call.argv.startsWith("auth "))) {
    assert.ok(["auth status --json", "auth login --claudeai"].includes(call.argv), call.argv);
    assert.equal(call.secure, login);
    assert.equal(call.profiles, join(login, "anthropic"));
    const signIn = call.argv === "auth login --claudeai";
    assert.equal(call.home === process.env.HOME, signIn, JSON.stringify(call));
    assert.equal(call.display, signIn ? ":42" : "", JSON.stringify(call));
    assert.deepEqual([call.key, call.token, call.base, call.oauth], ["", "", "", ""], JSON.stringify(call));
  }
  // Nothing opened the credentials file: no reader holds the FIFO now, and every request above answered.
  assert.throws(() => openSync(join(login, ".credentials.json"), constants.O_WRONLY | constants.O_NONBLOCK), { code: "ENXIO" });

  // Off: claude-agent needs a key again; the login stays as the CLI keeps it.
  const off = await api("DELETE", "/settings/claude-login");
  assert.equal(off.body.state, "off");
  assert.equal((await offerOf(api)).available, false);
  assert.ok(existsSync(join(login, ".credentials.json")));
});

test("a run on a signed-out login is refused in words, asked of the pinned CLI, never sent on a key", { timeout: 180_000 }, async (t) => {
  withEnv(t, { ANTHROPIC_API_KEY: "not-a-secret" }, MODEL_VARS);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_out", "the pinned CLI says AgentRun's own login directory holds no login");
  assert.equal((await api("POST", "/agents", agent("planned", { harness: "claude-agent", model: "anthropic/claude-haiku-5-5" }))).status, 201);
  const run = await api("POST", "/agents/planned/runs", { input: { content: "Say hi." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["failed"], { deadlineMs: 90_000 });
  const failed = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.ok(JSON.stringify(failed.error).includes(LOGIN_SIGNED_OUT), JSON.stringify(failed.error));
});

test("the switch, unset, follows the listen address: 0.0.0.0 has the mode off, 127.0.0.1 has it; off wins on loopback, on turns it on past it", () => {
  assert.match(claudeLoginSwitchedOff({}, "0.0.0.0"), /listens on 0\.0\.0\.0, past loopback/);
  assert.match(claudeLoginSwitchedOff({}, "::"), /listens on ::/);
  for (const listen of ["127.0.0.1", "localhost", "::1"]) assert.equal(claudeLoginSwitchedOff({}, listen), undefined, listen);
  for (const off of ["off", "0", "false", "no", " OFF "]) assert.equal(claudeLoginSwitchedOff({ [CLAUDE_LOGIN_ENV]: off }, "127.0.0.1"), `${CLAUDE_LOGIN_ENV}=off`, off);
  for (const on of ["on", "1", "true", "yes"]) assert.equal(claudeLoginSwitchedOff({ [CLAUDE_LOGIN_ENV]: on }, "0.0.0.0"), undefined, on);
  // `on` past loopback still refuses more than one person, and a run in a sandbox place goes on the keys.
  assert.match(whyNotOneOwner({ apiOnly: false, tokens: 2 }), /more than one person/);
});

test("an API-only server serves no claude-login route, and its capabilities say so", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const server = await serve(t, { faux: undefined, runner: false, apiOnly: true });
  const get = (path) => fetch(`${server.url}/v2${path}`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal((await get("/settings/claude-login")).status, 404);
  assert.equal((await (await get("/capabilities")).json()).features.claude_login, false);
});

test("AGENTRUN_CLAUDE_CODE_LOGIN=off: every route is 404 by name, a saved turn-on is dropped at the start, and claude-agent runs on the model keys", { timeout: 180_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const first = await serve(t, { faux: undefined, runner: false });
  assert.equal((await first.api("PUT", "/settings/claude-login", { only_me: true })).status, 200);
  assert.equal((await offerOf(first.api)).available, true);
  assert.equal((await first.api("GET", "/capabilities")).body.features.claude_login, true, "the routes answer: capabilities say so");
  await first.stop();

  process.env[CLAUDE_LOGIN_ENV] = "off";
  const lines = [];
  const second = await serve(t, { faux: undefined, data: first.data, runner: false, log: (line) => lines.push(line) });
  for (const [method, path, name] of OPERATIONS) {
    const answer = await second.api(method, path, method === "PUT" ? { only_me: true } : undefined);
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.match(answer.body.error.message, new RegExp(`^${name}: .*${CLAUDE_LOGIN_ENV}=off\\.$`), JSON.stringify(answer.body));
  }
  assert.equal((await offerOf(second.api)).available, false, "no key: claude-agent runs nothing");
  // The console asks capabilities first, so a page never asks a route that answers 404 (a browser logs every one).
  assert.equal((await second.api("GET", "/capabilities")).body.features.claude_login, false, "the routes are 404: capabilities say so");
  assert.ok(lines.some((line) => line.includes(`turned off: ${CLAUDE_LOGIN_ENV}=off`)), lines.join("\n"));
  await second.stop();

  // Dropped, not set aside: with the switch unset again on loopback, the mode is there and off until turned on.
  delete process.env[CLAUDE_LOGIN_ENV];
  const { api } = await serve(t, { faux: undefined, data: first.data, runner: false });
  assert.equal((await api("GET", "/settings/claude-login")).body.state, "off");
  assert.equal((await offerOf(api)).available, false);

  // A key: claude-agent runs on it.
  const env = withClaudeLogin({ ANTHROPIC_API_KEY: "not-a-secret", [CLAUDE_LOGIN_ENV]: "off" }, { dir: "/nowhere", profiles: "/nowhere/anthropic" });
  const provider = providerFor("anthropic-messages", env, { provider: "anthropic", modelId: "claude-haiku-5-5" }, "claude-agent");
  assert.equal(provider.login, undefined);
  assert.equal(await provider.credential(), "not-a-secret");
  assert.equal(hostModel(env, "default", "claude-agent"), hostModel({ ANTHROPIC_API_KEY: "not-a-secret" }, "default", "claude-agent"));
  const saved = { get: async () => ({ v: 1, place: "agentrun", host: hostname(), only_me: true }) };
  assert.equal(await loginForRun(saved, "/data", env, "claude-agent", { mode: "runner" }), undefined);
  // On, a runner place goes on the login and a sandbox place on the keys.
  assert.deepEqual(await loginForRun(saved, "/data", {}, "claude-agent", { mode: "runner" }), { dir: "/data/claude-login", profiles: "/data/claude-login/anthropic" });
  assert.equal(await loginForRun(saved, "/data", {}, "claude-agent", { mode: "sandbox", box: "e2b" }), undefined);
});

test("Claude Code's login on this machine on: claude-agent's Anthropic models go on it with no key and no port; other harnesses and named gateway or OpenRouter models keep their keys", () => {
  const at = { dir: "/data/claude-login", profiles: "/data/claude-login/anthropic" };
  const env = withClaudeLogin({ ANTHROPIC_API_KEY: "not-a-secret", OPENROUTER_API_KEY: "not-a-secret" }, at);
  const onLogin = providerFor("anthropic-messages", env, { provider: "anthropic", modelId: "claude-haiku-5-5" }, "claude-agent");
  assert.deepEqual(onLogin.login, at);
  assert.equal(onLogin.billing, "plan");
  assert.equal(onLogin.priceModel.provider, "claude-login");
  assert.equal(providerFor("anthropic-messages", env, { provider: "openrouter", modelId: "anthropic/claude-haiku-5.5" }, "claude-agent").login, undefined);
  assert.equal(providerFor("anthropic-messages", env, { provider: "anthropic", modelId: "claude-haiku-5-5" }, "opencode").login, undefined);
  assert.equal(hostModel(env, "default", "claude-agent"), "anthropic/claude-sonnet-5-5");
  // The carrier is no variable: a spawn's environment never has it, a spread keeps it.
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]);
  assert.deepEqual(providerFor("anthropic-messages", { ...env }, { provider: "anthropic", modelId: "claude-haiku-5-5" }, "claude-agent").login, at);
  // A revision's checks at a sandbox place read env without the login, so they ask for a key before the run is queued;
  // a runner place's keep it, and the server's own env is left as it was.
  assert.equal(providerFor("anthropic-messages", envAtPlace(env, { mode: "sandbox", box: "e2b" }), { provider: "anthropic", modelId: "claude-haiku-5-5" }, "claude-agent").login, undefined);
  assert.equal(envAtPlace(env, { mode: "runner" }), env);
  assert.deepEqual(providerFor("anthropic-messages", env, { provider: "anthropic", modelId: "claude-haiku-5-5" }, "claude-agent").login, at);
});

test("one owner: refused in one line where more than one person can start runs, and a saved turn-on dropped there at the start", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  assert.equal(whyNotOneOwner({ apiOnly: false, tokens: 1 }), undefined);
  assert.match(whyNotOneOwner({ apiOnly: true, tokens: 1 }), /^This server has no owner .*one person's\.$/);
  assert.deepEqual(turnOnBody({ only_me: true }), { place: "agentrun" });
  assert.deepEqual(turnOnBody({ only_me: true, place: "machine" }), { place: "machine" });
  assert.ok("problem" in turnOnBody({ place: "machine" }));

  const first = await serve(t, { faux: undefined, runner: false });
  assert.equal((await first.api("PUT", "/settings/claude-login", { only_me: true })).status, 200);
  await first.stop();

  const lines = [];
  const { api } = await serve(t, { faux: undefined, data: first.data, runner: false, token: "not-a-secret-token-0123456789abcdef", tokens: [{ id: "second", token: "not-a-secret-token-fedcba9876543210" }], log: (line) => lines.push(line) });
  const view = await api("GET", "/settings/claude-login");
  assert.equal(view.body.state, "off", "the saved turn-on went at the start");
  assert.equal(view.body.refused, "This server takes 2 API tokens, so more than one person can start runs here: a Claude plan is one person's.");
  assert.equal(view.body.can_start, false);
  assert.ok(lines.some((line) => line.includes("turned off: This server takes 2 API tokens")), lines.join("\n"));
  const refused = await api("PUT", "/settings/claude-login", { only_me: true });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.message, view.body.refused);
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 403);
});

// A run's check (loginBeforeRun) on a busy host: the CLI, started in an empty home, can take longer than the check's
// timeout. That is no answer, not a signed-out login, so it never refuses the run. Each test has a login of its own,
// since checks are shared by CLI and login.
let logins = 0;
const nextLogin = () => ({ dir: `/fake/login-${++logins}`, profiles: `/fake/login-${logins}/anthropic` });
const late = () => Object.assign(new Error("the claude CLI gave no login status within 15 s"), { name: "LoginStatusTimeout" });

test("a run's login check that times out is asked once more, and a second timeout lets the run go on", async () => {
  const login = nextLogin();
  let calls = 0;
  await loginBeforeRun(login, "/fake/claude", async () => { calls++; throw late(); });
  assert.equal(calls, 2);
  // A timeout, then an answer: the answer decides.
  calls = 0;
  await loginBeforeRun(nextLogin(), "/fake/claude", async () => (++calls === 1 ? Promise.reject(late()) : { signedIn: true }));
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(loginBeforeRun(nextLogin(), "/fake/claude", async () => (++calls === 1 ? Promise.reject(late()) : { signedIn: false })), { message: LOGIN_SIGNED_OUT });
});

test("a run's login check still refuses a signed-out login and an answer that reads as none, at once", async () => {
  let calls = 0;
  await assert.rejects(loginBeforeRun(nextLogin(), "/fake/claude", async () => { calls++; return { signedIn: false }; }), { message: LOGIN_SIGNED_OUT });
  await assert.rejects(loginBeforeRun(nextLogin(), "/fake/claude", async () => { calls++; throw new Error("the claude CLI gave no login status"); }), (error) => error.message.startsWith(`${LOGIN_UNKNOWN}: `));
  assert.equal(calls, 2);
});

test("runs that start together on one login share one check, and a signed-in answer stands for LOGIN_SIGNED_IN_MS", async () => {
  const login = nextLogin();
  let calls = 0;
  let answer;
  const status = () => { calls++; return new Promise((resolve) => { answer = resolve; }); };
  let clock = 1_000;
  const now = () => clock;
  const runs = [1, 2, 3].map(() => loginBeforeRun(login, "/fake/claude", status, { now }));
  answer({ signedIn: true });
  await Promise.all(runs);
  assert.equal(calls, 1);
  clock += LOGIN_SIGNED_IN_MS - 1;
  await loginBeforeRun(login, "/fake/claude", async () => { calls++; return { signedIn: true }; }, { now });
  assert.equal(calls, 1, "within the window, no new check");
  clock += 2;
  await loginBeforeRun(login, "/fake/claude", async () => { calls++; return { signedIn: true }; }, { now });
  assert.equal(calls, 2, "after it, the CLI is asked again");
  // Another CLI on the same login is its own check.
  await loginBeforeRun(login, "/fake/other-claude", async () => { calls++; return { signedIn: true }; }, { now });
  assert.equal(calls, 3);
});

test("a signed-out answer is never kept: the next run asks again, so signing in counts at once", async () => {
  const login = nextLogin();
  let signedIn = false;
  let calls = 0;
  const status = async () => { calls++; return { signedIn }; };
  await assert.rejects(loginBeforeRun(login, "/fake/claude", status), { message: LOGIN_SIGNED_OUT });
  signedIn = true;
  await loginBeforeRun(login, "/fake/claude", status);
  assert.equal(calls, 2);
});

test("on a CLI slower than the check's timeout, a run's check asks twice and the run is not refused", async () => {
  const { claudeLoginStatus } = await import("@parcha/agentrun-harness-claude");
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-slow-"));
  const cli = join(dir, "claude");
  // A CLI that never answers: each check ends at its timeout however slowly the child starts, and the calls are counted here.
  writeFileSync(cli, "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 });
  const ended = [];
  const status = (at, login) => claudeLoginStatus(at, login, { timeoutMs: 300 }).catch((error) => { ended.push(error.name); throw error; });
  const started = Date.now();
  await loginBeforeRun(nextLogin(), cli, status);
  assert.deepEqual(ended, ["LoginStatusTimeout", "LoginStatusTimeout"]);
  assert.ok(Date.now() - started < 30_000, "two timeouts, not a wait for an answer");
});

