// Claude Code's login on this machine (claude-login.ts): claude-agent on a person's own Claude plan, through the CLI that
// holds the login. The server asks that CLI `auth status` and nothing else: a fake CLI stands in for the pinned one here,
// answering the status a test sets and noting each call (its arguments and the variables it got). Its login directory's
// credentials file is a FIFO, which holds any open of it, so a server that read it would hang there. The mode is turned on
// with the owner's word, refused in one line where more than one person can start runs, and gone, routes and all, under
// AGENTRUN_CLAUDE_CODE_LOGIN=off, where claude-agent runs on the model keys as it does without it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import * as claude from "@parcha/agentrun-harness-claude";
import { CLAUDE_LOGIN_ENV, CLAUDE_LOGIN_SETTING, claudeLoginOf, claudeLoginSwitchedOff, claudeLoginView, dropRefusedLogin, envAtPlace, LOGIN_ANSWERS_DIR, LOGIN_SIGNED_OUT, LOGIN_UNKNOWN, loginAt as checkedLoginAt, loginBeforeRun, loginForRun, loginOnRunnerOnly, loginServes, settingFor, startLoginHere, turnOffClaudeLogin, turnOnBody, turnOnClaudeLogin, whyNotOneOwner, withClaudeLogin } from "../dist/claude-login.js";
import { ClaudeSignIns } from "../dist/claude-sign-in.js";
import { MODEL_KEYS, hostModel } from "../dist/model.js";
import { providerFor } from "../dist/provider.js";
import { agent, FAUX, follow, secretWritePath, serve, withEnv } from "./support.mjs";

secretWritePath(["GET", "PUT", "DELETE"], /^\/settings\/claude-login$/);
secretWritePath(["POST"], /^\/settings\/claude-login\/login$/);
secretWritePath(["PUT", "DELETE"], /^\/settings\/harness-keys\/[^/]+\/[^/]+$/);

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_DEFAULT_MODEL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", CLAUDE_LOGIN_ENV, ...MODEL_KEYS.map((row) => row.field)];
const OPERATIONS = [["GET", "/settings/claude-login", "getClaudeLogin"], ["PUT", "/settings/claude-login", "turnOnClaudeLogin"], ["DELETE", "/settings/claude-login", "turnOffClaudeLogin"], ["POST", "/settings/claude-login/login", "startClaudeLogin"]];
const SIGNED_OUT = { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
const SIGNED_IN = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "person@example.com", orgName: "Example", subscriptionType: "max" };
/** A person's home for the tests that read paths alone: a folder of the test's own user, as the server's HOME must be to
 *  count as the person's (claude-login.ts homeOf). Nothing is written in it. */
const UP = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claude-login-person-"));
after(() => rmSync(UP, { recursive: true, force: true }));
/** The login at a place as loginAt's check gives it: undefined where its folders are refused. */
const loginAt = (...args) => checkedLoginAt(...args).login;

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
  // of ours. Both run in the person's home (on macOS the login keychain, where the CLI keeps its tokens, is under it);
  // the sign-in also gets their desktop, so the CLI can open their browser.
  const calls = fake.calls();
  assert.ok(calls.length >= 4, JSON.stringify(calls));
  for (const call of calls.filter((call) => call.argv.startsWith("auth "))) {
    assert.ok(["auth status --json", "auth login --claudeai"].includes(call.argv), call.argv);
    assert.equal(call.secure, login);
    assert.equal(call.profiles, join(login, "anthropic"));
    const signIn = call.argv === "auth login --claudeai";
    assert.equal(call.home, process.env.HOME, JSON.stringify(call));
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

// The login is a model only for a run on the runner (loginForRun): an agent on Claude Agent in a box runs on the model
// keys. With none, its run is refused for its model, and the refusal says why the login that reads signed in does not
// run it, and that moving the agent to the runner does: in its words, and as `details.login_on_runner` for the console's
// offer. The box is Docker on a fake `docker` first on PATH (fixtures/fake-docker.mjs): nothing is pulled or run.
const FAKE_DOCKER = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const RUNNER_ONLY = "Claude Code's login on this machine runs agents on the runner only, and this agent runs in the docker box";
/** A server for test `t` with a Docker box (a fake `docker`) and no model key, and the fake CLI that answers for its
 *  login; `vars` set where it starts. */
async function withDockerBox(t, vars = {}) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-docker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "bin", "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_DOCKER}' "$@"\n`, { mode: 0o755 });
  const fake = await fakeCli(t);
  withEnv(t, { PATH: [dirname(fake.cli), join(dir, "bin"), process.env.PATH].join(delimiter), FAKE_DOCKER_STATE: join(dir, "state"), AGENTRUN_BOXES: "docker", ...vars }, [...MODEL_VARS, "AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  const { api } = await serve(t, { faux: undefined, harnesses: false });
  return { api, fake };
}
test("a run of an agent on Claude Agent in a box, while the login is on and reads signed in, is refused in words that say the login runs agents on the runner only and that this one runs in the box, with details.login_on_runner", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await withDockerBox(t);
  const boxed = agent("boxed", { harness: "claude-agent", place: { mode: "sandbox", box: "docker" } });
  assert.equal((await api("POST", "/agents", boxed)).status, 201);

  // Off: refused for its model, with no word of the login.
  const off = await api("POST", "/agents/boxed/runs", { input: { content: "Say hi." } });
  assert.equal(off.status, 409, JSON.stringify(off.body));
  assert.match(off.body.error.message, /claude-agent needs ANTHROPIC_API_KEY/);
  assert.doesNotMatch(off.body.error.message, /runner only/, "a refusal with the login off spoke of the login");
  assert.equal(off.body.error.details.login_on_runner, undefined);

  fake.status(SIGNED_IN);
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_in");
  const on = await api("POST", "/agents/boxed/runs", { input: { content: "Say hi." } });
  assert.equal(on.status, 409, JSON.stringify(on.body));
  assert.equal(on.body.error.code, "agent_not_runnable");
  assert.match(on.body.error.message, /No model yet for claude-agent/);
  assert.ok(on.body.error.message.includes(RUNNER_ONLY), `the refusal of a box agent on Claude Agent while the login reads signed in does not say the login runs agents on the runner only: ${on.body.error.message}`);
  assert.equal(on.body.error.details.login_on_runner, true, `the refusal's details do not offer the move to the runner: ${JSON.stringify(on.body.error.details)}`);
});

// The move is offered only where the login would run the agent once it is moved: on Anthropic's own model, or on none
// (the test above; the login's default is Anthropic's). An OpenRouter model, Anthropic's through OpenRouter included,
// goes on OpenRouter's key on the runner too, so its refusal names that key and offers no move.
test("an agent on Claude Agent in a box on an OpenRouter model, while the login reads signed in, is refused for OpenRouter's key with no move to the runner offered; one on Anthropic's own model is offered the move", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await withDockerBox(t);
  fake.status(SIGNED_IN);
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_in");
  const place = { mode: "sandbox", box: "docker" };
  assert.equal((await api("POST", "/agents", agent("routed", { harness: "claude-agent", model: "openrouter/anthropic/claude-sonnet-5.5", place }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("own", { harness: "claude-agent", model: "anthropic/claude-sonnet-5-5", place }))).status, 201);

  const routed = await api("POST", "/agents/routed/runs", { input: { content: "Say hi." } });
  assert.equal(routed.status, 409, JSON.stringify(routed.body));
  assert.equal(routed.body.error.code, "agent_not_runnable");
  assert.match(routed.body.error.message, /OPENROUTER_API_KEY/, "the refusal of an OpenRouter model does not name OpenRouter's key");
  assert.ok(!routed.body.error.message.includes(RUNNER_ONLY), `an OpenRouter model, which the login never runs, was told to move to the runner: ${routed.body.error.message}`);
  assert.equal(routed.body.error.details.login_on_runner, undefined, `an OpenRouter model, which the login never runs, was offered the move to the runner: ${JSON.stringify(routed.body.error.details)}`);

  const own = await api("POST", "/agents/own/runs", { input: { content: "Say hi." } });
  assert.equal(own.status, 409, JSON.stringify(own.body));
  assert.ok(own.body.error.message.includes(RUNNER_ONLY), own.body.error.message);
  assert.equal(own.body.error.details.login_on_runner, true, JSON.stringify(own.body.error.details));
});

// An agent that names no model runs on the host's default for its harness, on the runner too: AGENT_MODEL first, when
// the harness runs it (model.ts hostModel). Where that is an OpenRouter model, the moved agent still needs OpenRouter's
// key, so the move is not offered; where it is Anthropic's own, the login runs it and the move is.
test("an agent on Claude Agent in a box that names no model, on a host whose AGENT_MODEL is an OpenRouter model, is offered no move to the runner while the login reads signed in; on a host whose AGENT_MODEL is Anthropic's own it is", { timeout: 120_000 }, async (t) => {
  for (const [model, offered] of [["openrouter/anthropic/claude-sonnet-5.5", false], ["anthropic/claude-sonnet-5-5", true]]) {
    await t.test(model, async (t) => {
      const { api, fake } = await withDockerBox(t, { AGENT_MODEL: model });
      fake.status(SIGNED_IN);
      assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_in");
      assert.equal((await api("POST", "/agents", agent("unnamed", { harness: "claude-agent", place: { mode: "sandbox", box: "docker" } }))).status, 201);
      const run = await api("POST", "/agents/unnamed/runs", { input: { content: "Say hi." } });
      assert.equal(run.status, 409, JSON.stringify(run.body));
      assert.equal(run.body.error.code, "agent_not_runnable");
      assert.equal(run.body.error.message.includes(RUNNER_ONLY), offered, `the refusal of a box agent with no model, on a host whose AGENT_MODEL is ${model}, ${offered ? "does not offer" : "offers"} the move to the runner: ${run.body.error.message}`);
      assert.equal(run.body.error.details.login_on_runner, offered ? true : undefined, `details.login_on_runner on a host whose AGENT_MODEL is ${model}: ${JSON.stringify(run.body.error.details)}`);
    });
  }
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
  // Turned on over a data folder of the test's own, as the owner's turn-on saves it.
  const own = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-saved-"));
  t.after(() => rmSync(own, { recursive: true, force: true }));
  const row = settingFor("agentrun", own);
  const saved = { get: async () => row };
  assert.equal(await loginForRun(saved, own, env, "claude-agent", { mode: "runner" }), undefined);
  // On, a runner place goes on the login (with the person's home, the env's HOME) and a sandbox place on the keys.
  assert.deepEqual(await loginForRun(saved, own, { HOME: UP }, "claude-agent", { mode: "runner" }), { dir: join(own, "claude-login"), profiles: join(own, "claude-login", "anthropic"), userHome: UP });
  assert.equal(await loginForRun(saved, own, {}, "claude-agent", { mode: "sandbox", box: "e2b" }), undefined);
});

// The login's model rule, which providerFor and the refusal's move offer (loginOnRunnerOnly) both ask. The console copies
// it (its lib/claudeLogin.ts loginServes: it reads no server code), and its claudeLogin.test.ts names these same cases.
test("loginServes: the login runs no model and Anthropic's own; an OpenRouter model, Anthropic's included, and any other vendor's go on their key", () => {
  const cases = [[undefined, true], ["", true], ["anthropic/claude-sonnet-5-5", true], ["openrouter/anthropic/claude-sonnet-5.5", false], ["openai/gpt-6.1-sol", false]];
  for (const [model, served] of cases) assert.equal(loginServes(model), served, String(model));
  // The offer follows it: a box agent on an OpenRouter model is offered no move, one on Anthropic's or none is.
  const env = withClaudeLogin({}, { dir: "/data/claude-login", profiles: "/data/claude-login/anthropic" });
  const box = { mode: "sandbox", box: "docker" };
  for (const [model, served] of cases) assert.equal(loginOnRunnerOnly(env, "claude-agent", model, box) !== undefined, served, String(model));
});

test("Claude Code's login on this machine on: claude-agent's Anthropic models go on it with no key and no port; other harnesses and named gateway or OpenRouter models keep their keys", () => {
  const at = { dir: "/data/claude-login", profiles: "/data/claude-login/anthropic" };
  const env = withClaudeLogin({ ANTHROPIC_API_KEY: "not-a-secret", OPENROUTER_API_KEY: "not-a-secret" }, at);
  const onLogin = providerFor("anthropic-messages", env, { provider: "anthropic", modelId: "claude-haiku-5-5" }, "claude-agent");
  assert.deepEqual(onLogin.login, at);
  assert.equal(onLogin.billing, "plan");
  assert.equal(onLogin.priceModel.provider, "claude-login");
  // Anthropic's own models go on the login, an OpenRouter one (Anthropic's included) on its key, and a revision naming
  // none gets Anthropic's (loginServes, case by case below).
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
  // A key made in the console for an app is one more caller, as a second token is (api-keys.ts).
  assert.equal(whyNotOneOwner({ apiOnly: false, tokens: 1, keys: 0 }), undefined);
  assert.equal(whyNotOneOwner({ apiOnly: false, tokens: 1, keys: 1 }), "This server has an API key made for apps (Settings → AgentRun API keys), so more than one caller can start runs here: a Claude plan is one person's. Revoke it first.");
  assert.match(whyNotOneOwner({ apiOnly: false, tokens: 1, keys: 3 }), /^This server has 3 API keys made for apps .*Revoke them first\.$/);
  // Keys that open nothing here (a server on its owner's own sign-in) are said as that: none is a second caller now.
  assert.equal(whyNotOneOwner({ apiOnly: false, tokens: 1, keys: 2, keysDormant: true }), "This server keeps 2 API keys made for apps (Settings → AgentRun API keys). They open nothing here, and would open the server at a start that takes keys again: a Claude plan is one person's. Revoke them first.");
  assert.equal(whyNotOneOwner({ apiOnly: false, tokens: 1, keys: 0, keysDormant: true }), undefined);
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

/** A stand-in CLI for test `t` that keeps a login as the pinned CLI does on Linux: its credentials in
 *  `CLAUDE_SECURESTORAGE_CONFIG_DIR` (set and empty: `$HOME/.claude`), else in its config dir (`CLAUDE_CONFIG_DIR`, else
 *  `$HOME/.claude`), and the account it signed in to in its config dir's
 *  `.claude.json` (`CLAUDE_CONFIG_DIR`, else the home). `auth login` writes both and leaves `ended` beside itself; `auth
 *  status` says signed in where the credentials are, with the account's email where the account is. `mode`: `sign`
 *  (signs in at once), `wait` (waits for a browser that never answers, its pid in `pids()`), `refuse` (exits 1). Each
 *  call is noted with the variables it got; a CLI still waiting is ended after the test. */
async function signInCli(t, mode) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-sign-in-cli-"));
  const [cli, record, pidFile, ended] = ["claude", "calls.jsonl", "pids", "ended"].map((name) => join(dir, name));
  writeFileSync(
    cli,
    `#!/bin/sh
if [ "\${CLAUDE_SECURESTORAGE_CONFIG_DIR+set}" = set ]; then secure="\${CLAUDE_SECURESTORAGE_CONFIG_DIR:-$HOME/.claude}"; else secure="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi
account="\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
printf '{"argv":"%s","home":"%s","config":"%s","secure":"%s","configSet":"%s","secureSet":"%s"}\\n' "$*" "$HOME" "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" "\${CLAUDE_CONFIG_DIR+set}" "\${CLAUDE_SECURESTORAGE_CONFIG_DIR+set}" >> '${record}'
if [ "$1 $2" = "auth login" ]; then
  if [ '${mode}' = wait ]; then echo $$ >> '${pidFile}'; exec sleep 300; fi
  if [ '${mode}' = refuse ]; then exit 1; fi
  mkdir -p "$secure"
  printf '{"claudeAiOauth":{"accessToken":"fake","scopes":["user:inference"]}}' > "$secure/.credentials.json"
  printf '{"oauthAccount":{"emailAddress":"person@example.com"}}' > "$account"
  : > '${ended}'
  exit 0
fi
if [ "$1 $2" = "auth status" ]; then
  if [ ! -f "$secure/.credentials.json" ]; then echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'
  elif [ -f "$account" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"person@example.com"}'
  else echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; fi
fi
`,
    { mode: 0o755 },
  );
  const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  t.after(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ended already.
      }
    }
  });
  const calls = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { cli, calls, pids, ended };
}

/** Whether process `pid` is still there. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A server on loopback whose `claude` on PATH is a signInCli in `mode`, in a home of the test's own with none of the
 *  CLI's folder variables but `vars`. */
async function signInServer(t, mode, options = {}, vars = {}) {
  const fake = await signInCli(t, mode);
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-sign-in-home-"));
  withEnv(t, { PATH: `${dirname(fake.cli)}${delimiter}${process.env.PATH}`, HOME: home, ...vars }, [...MODEL_VARS, "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "ANTHROPIC_CONFIG_DIR", "XDG_CONFIG_HOME", "DISPLAY"]);
  const server = await serve(t, { faux: undefined, harnesses: false, runner: false, ...options });
  return { ...server, fake, home };
}

/** The view once the sign-in the server started no longer waits (or there is none), 10 s at most. */
async function signInSettled(api) {
  let view;
  await until(async () => {
    view = (await api("GET", "/settings/claude-login")).body;
    return view.sign_in?.state !== "waiting";
  }, "the sign-in ended");
  return view;
}

test("Open the CLI's sign-in here signs the CLI in at the login's own folder: the account it signed in to is there, and the login reads signed in as it", { timeout: 120_000 }, async (t) => {
  const { api, data, fake } = await signInServer(t, "sign");
  const login = loginAt("agentrun", data).dir;
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_out");
  const started = await api("POST", "/settings/claude-login/login");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await until(() => existsSync(fake.ended), "the CLI's sign-in ended");
  // `auth login` writes the account to its config dir: the sign-in's must be the login's folder, never a temporary one.
  assert.ok(existsSync(join(login, ".claude.json")), "the sign-in left the account it signed in to (.claude.json) in the login's folder");
  const view = await signInSettled(api);
  assert.equal(view.state, "signed_in", JSON.stringify(view));
  assert.equal(view.account?.email, "person@example.com", JSON.stringify(view));
  assert.equal(view.folder, login);
  assert.equal(view.sign_in?.state, "signed_in", JSON.stringify(view.sign_in));
  // The sign-in and every status check asked about the same folder: the sign-in with it as its config dir, each status
  // check on a copy of its account file outside it (the CLI rewrites the one in its config dir on start).
  for (const call of fake.calls()) {
    assert.equal(call.secure, login, JSON.stringify(call));
    if (call.argv === "auth status --json") assert.ok(call.config && relative(login, call.config).startsWith(".."), JSON.stringify(call));
    else assert.equal(call.config, login, JSON.stringify(call));
  }
});

test("a sign-in no browser answers within its limit is ended and says so, apart from any other end", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await signInServer(t, "wait", { claudeSignInLimitMs: 200 });
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).status, 200);
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 200);
  const view = await signInSettled(api);
  assert.equal(view.sign_in?.state, "timed_out", JSON.stringify(view.sign_in));
  assert.equal(view.sign_in.limit_ms, 200);
  assert.ok(Date.parse(view.sign_in.ended_at) >= Date.parse(view.sign_in.started_at), JSON.stringify(view.sign_in));
  assert.equal(view.state, "signed_out");
  for (const pid of fake.pids()) assert.equal(alive(pid), false, "the CLI that waited is gone");
});

test("a sign-in the CLI ends without signing in says its exit code", { timeout: 120_000 }, async (t) => {
  const { api } = await signInServer(t, "refuse");
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).status, 200);
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 200);
  const view = await signInSettled(api);
  assert.deepEqual([view.sign_in?.state, view.sign_in?.exit_code], ["failed", 1], JSON.stringify(view.sign_in));
  assert.equal(view.state, "signed_out");
});

test("a sign-in that waits for the browser says so to every read, for 10 minutes by default; a second press ends it before the next starts, and a turn-off ends it", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await signInServer(t, "wait");
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).status, 200);
  const first = await api("POST", "/settings/claude-login/login");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.sign_in?.state, "waiting", JSON.stringify(first.body));
  assert.equal(first.body.sign_in.limit_ms, 10 * 60_000);
  assert.ok(Date.parse(first.body.sign_in.started_at) <= Date.now());
  await until(() => fake.pids().length === 1, "the first sign-in waits");
  const [one] = fake.pids();
  // A reload reads it from the server.
  const reread = (await api("GET", "/settings/claude-login")).body;
  assert.deepEqual(reread.sign_in, first.body.sign_in);
  // One CLI at a time holds the browser's port: a second press ends the one that waits first.
  const second = await api("POST", "/settings/claude-login/login");
  assert.equal(second.body.sign_in?.state, "waiting", JSON.stringify(second.body));
  assert.equal(alive(one), false, "the first sign-in was ended before the second started");
  await until(() => fake.pids().length === 2, "the second sign-in waits");
  const two = fake.pids()[1];
  const off = await api("DELETE", "/settings/claude-login");
  assert.equal(off.body.state, "off");
  assert.equal(off.body.sign_in, undefined, JSON.stringify(off.body.sign_in));
  assert.equal(alive(two), false, "turning the mode off ended the sign-in that waited");
});

test("a sign-in that waits for the browser ends with the server's stop, which waits for its CLI to go, so no CLI keeps the browser's port from the next server", { timeout: 120_000 }, async (t) => {
  const { api, fake, stop } = await signInServer(t, "wait");
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).status, 200);
  assert.equal((await api("POST", "/settings/claude-login/login")).body.sign_in?.state, "waiting");
  await until(() => fake.pids().length === 1, "the sign-in waits");
  const [pid] = fake.pids();
  assert.equal(alive(pid), true);
  // The CLI ends on SIGTERM; the stop resolves only once its process is gone.
  await stop();
  assert.equal(alive(pid), false, "the server's stop ended the sign-in that waited");
});

test("a turn-on that moves the login to another place ends a sign-in that waits, which signed in at the old place; one that keeps the place leaves it waiting", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await signInServer(t, "wait");
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true, place: "agentrun" })).status, 200);
  assert.equal((await api("POST", "/settings/claude-login/login")).body.sign_in?.state, "waiting");
  await until(() => fake.pids().length === 1, "the sign-in waits");
  const [pid] = fake.pids();
  // The same place again: the sign-in still signs in where the login is.
  const same = (await api("PUT", "/settings/claude-login", { only_me: true, place: "agentrun" })).body;
  assert.equal(same.sign_in?.state, "waiting", JSON.stringify(same.sign_in));
  assert.equal(alive(pid), true, "a turn-on at the same place left the sign-in waiting");
  // Another place: the waiting CLI would sign in at the old one, so the PUT ends it and answers once it is gone.
  const moved = (await api("PUT", "/settings/claude-login", { only_me: true, place: "machine" })).body;
  assert.equal(moved.place, "machine");
  assert.equal(alive(pid), false, "the turn-on that moved the login ended the sign-in that waited at the old place");
  assert.equal(moved.sign_in, undefined, JSON.stringify(moved.sign_in));
  assert.notEqual((await api("GET", "/settings/claude-login")).body.sign_in?.state, "waiting");
});

test("this machine's login is the folder the CLI uses: CLAUDE_CONFIG_DIR when the server has it as an absolute path, else ~/.claude; the view names it", { timeout: 120_000 }, async (t) => {
  assert.equal(loginAt("machine", "/d", { HOME: UP }).dir, `${UP}/.claude`);
  assert.deepEqual(loginAt("machine", "/d", { HOME: UP, CLAUDE_CONFIG_DIR: `${UP}/elsewhere` }), { dir: `${UP}/elsewhere`, profiles: `${UP}/.config/anthropic`, userHome: UP });
  assert.equal(loginAt("machine", "/d", { HOME: UP, CLAUDE_CONFIG_DIR: "elsewhere" }).dir, `${UP}/.claude`, "a relative one is read against a working directory the server does not share");
  assert.equal(loginAt("agentrun", "/d", { HOME: UP, CLAUDE_CONFIG_DIR: `${UP}/elsewhere` }).dir, "/d/claude-login", "AgentRun's own login is in its data");

  const folder = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-config-dir-"));
  const { api, data, fake, home } = await signInServer(t, "sign", {}, { CLAUDE_CONFIG_DIR: folder });
  const before = (await api("GET", "/settings/claude-login")).body;
  assert.deepEqual(before.machine, { folder, source: "CLAUDE_CONFIG_DIR" }, JSON.stringify(before));
  assert.equal(before.folder, loginAt("agentrun", data).dir);
  const on = (await api("PUT", "/settings/claude-login", { only_me: true, place: "machine" })).body;
  assert.equal(on.place, "machine");
  assert.equal(on.folder, folder);
  assert.ok(on.command.startsWith(`CLAUDE_CONFIG_DIR=${folder} CLAUDE_SECURESTORAGE_CONFIG_DIR=${folder} `), on.command);
  // The person's own claude uses that folder too: a status check runs the CLI on a copy of its account file, never on
  // the folder's own, with the folder's tokens.
  const asked = fake.calls().filter((call) => call.argv === "auth status --json");
  assert.ok(asked.length >= 1);
  for (const call of asked) {
    assert.notEqual(call.config, folder, JSON.stringify(call));
    assert.ok(call.config && relative(folder, call.config).startsWith(".."), JSON.stringify(call));
    assert.equal(call.secure, folder, JSON.stringify(call));
    // In the person's home (the server's), where macOS keeps the login keychain.
    assert.equal(call.home, home, JSON.stringify(call));
  }
});

// The person's own claude on its default folder runs with no folder variable: its tokens in ~/.claude (on macOS the
// Keychain item with no suffix), the account it signed in to in ~/.claude.json. "This machine" there is read and signed
// in exactly so, never with ~/.claude as a config dir (which reads and writes ~/.claude/.claude.json, and on macOS names
// a Keychain item of its own).
test("this machine's login on the CLI's default folder is asked as the person's own claude: no folder variable, in their home, so a login their own claude made reads signed in as its account", { timeout: 120_000 }, async (t) => {
  const { api, fake, home } = await signInServer(t, "sign");
  // What the person's own `claude auth login` left: the tokens in ~/.claude, the account in ~/.claude.json.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", scopes: ["user:inference"] } }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "person@example.com" } }));
  const on = (await api("PUT", "/settings/claude-login", { only_me: true, place: "machine" })).body;
  assert.equal(on.state, "signed_in", JSON.stringify(on));
  assert.equal(on.account?.email, "person@example.com", JSON.stringify(on));
  assert.equal(on.folder, join(home, ".claude"));
  // The line a person runs is their own claude's, so what it signs in is what AgentRun then reads: it clears both folder
  // variables, which their terminal may export while the server has neither, under env, which any shell runs.
  assert.equal(on.command, `env -u CLAUDE_CONFIG_DIR -u CLAUDE_SECURESTORAGE_CONFIG_DIR ANTHROPIC_CONFIG_DIR=${join(home, ".config", "anthropic")} ${fake.cli} auth login`);
  // The status check runs in their home on a copy of ~/.claude.json (its own config dir, outside the home, which the
  // CLI's startup writes then reach in place of theirs), with the tokens where a run reads them: on macOS an empty
  // credentials dir (the item with no suffix), elsewhere ~/.claude.
  const asked = fake.calls().filter((call) => call.argv === "auth status --json");
  assert.ok(asked.length >= 1);
  for (const call of asked) {
    assert.deepEqual([call.configSet, call.secureSet, call.home], ["set", "set", home], JSON.stringify(call));
    assert.ok(call.config && relative(home, call.config).startsWith(".."), JSON.stringify(call));
    assert.equal(call.secure, process.platform === "darwin" ? "" : join(home, ".claude"), JSON.stringify(call));
  }
  // The login carries `home` only on the default folder: that is what tells its variables apart. Every login carries the
  // person's home as `userHome`, where the status check, the sign-in and a run on macOS run.
  assert.deepEqual(loginAt("machine", "/d", { HOME: UP }), { dir: `${UP}/.claude`, profiles: `${UP}/.config/anthropic`, home: UP, userHome: UP });
  assert.equal(loginAt("machine", "/d", { HOME: UP, CLAUDE_CONFIG_DIR: `${UP}/elsewhere` }).home, undefined);
});

test("Open the CLI's sign-in here on the CLI's default folder signs in where the person's own claude keeps its login: the account in ~/.claude.json, none in ~/.claude", { timeout: 120_000 }, async (t) => {
  const { api, fake, home } = await signInServer(t, "sign");
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true, place: "machine" })).body.state, "signed_out");
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 200);
  await until(() => existsSync(fake.ended), "the CLI's sign-in ended");
  assert.ok(existsSync(join(home, ".claude.json")), "the sign-in left the account where the person's own claude keeps it (~/.claude.json)");
  assert.equal(existsSync(join(home, ".claude", ".claude.json")), false, "no account file of AgentRun's making in ~/.claude");
  assert.ok(existsSync(join(home, ".claude", ".credentials.json")));
  const view = await signInSettled(api);
  assert.equal(view.state, "signed_in", JSON.stringify(view));
  assert.equal(view.account?.email, "person@example.com", JSON.stringify(view));
  const signIn = fake.calls().find((call) => call.argv === "auth login --claudeai");
  assert.deepEqual([signIn?.configSet, signIn?.secureSet, signIn?.home], ["", "", home], JSON.stringify(signIn));
});

// The person's own claude with CLAUDE_SECURESTORAGE_CONFIG_DIR set keeps its tokens in that folder (on macOS the Keychain
// item named with its hash); set and empty, in ~/.claude (on macOS the item with no suffix). The account stays where the
// config dir says. "This machine" on a server started with it is asked and signed in so, and a run reaches the same tokens.
test("this machine's login honours CLAUDE_SECURESTORAGE_CONFIG_DIR in the server's environment as the person's own claude does: the status check, the sign-in, the shown line and a run name its credentials there, and the view says so", { timeout: 120_000 }, async (t) => {
  const profiles = `${UP}/.config/anthropic`;
  const at = (vars) => loginAt("machine", "/d", { HOME: UP, ...vars });
  // The CLI's default folder, its credentials elsewhere.
  const own = at({ CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/secure` });
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(claude.claudeSignInEnv(own, platform), { HOME: UP, CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/secure`, ANTHROPIC_CONFIG_DIR: profiles }, platform);
    assert.deepEqual(claude.claudeLoginEnv(own, platform), { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/secure`, ANTHROPIC_CONFIG_DIR: profiles }, platform);
  }
  // Set and empty: on macOS empty still (the item with no suffix); elsewhere the folder it means, ~/.claude, absolute,
  // since a status check or a run has a home of its own.
  const empty = at({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
  assert.deepEqual(claude.claudeSignInEnv(empty, "darwin"), { HOME: UP, CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeLoginEnv(empty, "darwin"), { CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeSignInEnv(empty, "linux"), { HOME: UP, CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/.claude`, ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeLoginEnv(empty, "linux"), { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/.claude`, ANTHROPIC_CONFIG_DIR: profiles });
  // A CLAUDE_CONFIG_DIR folder: the account there, the credentials where the variable says.
  const folder = at({ CLAUDE_CONFIG_DIR: `${UP}/elsewhere`, CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/secure` });
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(claude.claudeSignInEnv(folder, platform), { CLAUDE_CONFIG_DIR: `${UP}/elsewhere`, CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/secure`, ANTHROPIC_CONFIG_DIR: profiles }, platform);
    assert.deepEqual(claude.claudeLoginEnv(folder, platform), { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/secure`, ANTHROPIC_CONFIG_DIR: profiles }, platform);
  }
  const folderEmpty = at({ CLAUDE_CONFIG_DIR: `${UP}/elsewhere`, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
  assert.deepEqual(claude.claudeSignInEnv(folderEmpty, "darwin"), { CLAUDE_CONFIG_DIR: `${UP}/elsewhere`, CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeSignInEnv(folderEmpty, "linux"), { CLAUDE_CONFIG_DIR: `${UP}/elsewhere`, CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/.claude`, ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeLoginEnv(folderEmpty, "darwin"), { CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  // A relative one is not taken, as with CLAUDE_CONFIG_DIR; AgentRun's own login never reads it.
  assert.deepEqual(claude.claudeSignInEnv(at({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "secure" }), "linux"), { HOME: UP, ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(loginAt("agentrun", "/d", { HOME: UP, CLAUDE_SECURESTORAGE_CONFIG_DIR: `${UP}/secure` }), { dir: "/d/claude-login", profiles: "/d/claude-login/anthropic", userHome: UP });

  // A server started with it: the view names it, and the sign-in and every status check keep the tokens there.
  const secure = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-secure-dir-"));
  const { api, fake, home } = await signInServer(t, "sign", {}, { CLAUDE_SECURESTORAGE_CONFIG_DIR: secure });
  const before = (await api("GET", "/settings/claude-login")).body;
  assert.deepEqual(before.machine, { folder: join(home, ".claude"), source: "default", credentials: secure }, JSON.stringify(before));
  const on = (await api("PUT", "/settings/claude-login", { only_me: true, place: "machine" })).body;
  assert.equal(on.state, "signed_out", JSON.stringify(on));
  assert.equal(on.command, `env -u CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR=${secure} ANTHROPIC_CONFIG_DIR=${join(home, ".config", "anthropic")} ${fake.cli} auth login`);
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 200);
  await until(() => existsSync(fake.ended), "the CLI's sign-in ended");
  assert.ok(existsSync(join(secure, ".credentials.json")), "the sign-in kept the tokens where the person's own claude with that variable does");
  assert.ok(existsSync(join(home, ".claude.json")), "and the account where it keeps it with no CLAUDE_CONFIG_DIR");
  const view = await signInSettled(api);
  assert.equal(view.state, "signed_in", JSON.stringify(view));
  // The sign-in runs with no config dir; each status check on a copy of the account file outside the home. Both name the
  // credentials where the variable says.
  for (const call of fake.calls()) {
    const status = call.argv === "auth status --json";
    assert.deepEqual([call.configSet, call.secure, call.home], [status ? "set" : "", secure, home], JSON.stringify(call));
    if (status) assert.ok(call.config && relative(home, call.config).startsWith(".."), JSON.stringify(call));
  }
});

// Which machine a login was turned on for. A laptop's hostname moves with its network (one name at home, another at the
// office), so a name never says it; the data folder stays where it is.

/** `os.hostname()` answers `name` for the rest of test `t`, in the server this process runs too: its import of node:os is
 *  a live binding, which syncBuiltinESMExports moves to the stub, and back after the test. */
function hostnameAs(t, name) {
  const os = createRequire(import.meta.url)("node:os");
  const real = os.hostname;
  os.hostname = () => name;
  syncBuiltinESMExports();
  t.after(() => {
    os.hostname = real;
    syncBuiltinESMExports();
  });
}

test("a login turned on here still reads as this machine's after the machine's hostname changes, as a laptop's does with its network: runs here go on it, never on a key that is not there", { timeout: 120_000 }, async (t) => {
  const fake = await fakeCli(t);
  withEnv(t, { PATH: `${dirname(fake.cli)}${delimiter}${process.env.PATH}` }, MODEL_VARS);
  const { api, data, store } = await serve(t, { faux: undefined, harnesses: false, runner: false });
  assert.equal((await api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_out");
  hostnameAs(t, `not-${hostname()}`);
  const view = (await api("GET", "/settings/claude-login")).body;
  assert.equal(view.state, "signed_out", `the login turned on here reads as another machine's under a new hostname: ${JSON.stringify(view)}`);
  assert.deepEqual(await loginForRun(store.settings, data, {}, "claude-agent", { mode: "runner" }), loginAt("agentrun", data, {}), "a run here goes on the login under a new hostname");
});

test("two data folders are two machines: each gets an id of its own, and a login turned on over one reads as another machine's from the other", async (t) => {
  const [one, two] = await Promise.all(["one", "two"].map((name) => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), `claude-login-machine-${name}-`))));
  t.after(() => {
    for (const data of [one, two]) rmSync(data, { recursive: true, force: true });
  });
  const row = settingFor("agentrun", one);
  const saved = { get: async () => row };
  assert.deepEqual(await loginForRun(saved, one, {}, "claude-agent", { mode: "runner" }), loginAt("agentrun", one, {}), "the data folder it was turned on over runs on it");
  assert.equal(await loginForRun(saved, two, {}, "claude-agent", { mode: "runner" }), undefined, "a login turned on over another data folder reads as another machine's");
  const ids = [one, two].map((data) => readFileSync(join(data, "machine-id"), "utf8").trim());
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(ids[0], ids[1]);
});

// The start route (POST /settings/claude-login/login, startLoginHere) is the third reader of the machine id, beside the
// view and a run's loginForRun: a sign-in started for another machine's login would sign this machine's CLI in to a
// login no run here reads.
test("the CLI's sign-in is refused for a login turned on over another data folder (another machine's id): no CLI starts, and the answer says to sign in there; over its own data folder it starts", async (t) => {
  const [one, two] = await Promise.all(["one", "two"].map((name) => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), `claude-login-start-${name}-`))));
  const signIns = new ClaudeSignIns();
  t.after(async () => {
    await signIns.close();
    for (const data of [one, two]) rmSync(data, { recursive: true, force: true });
  });
  const pinned = join(two, "claude");
  writeFileSync(pinned, "", { mode: 0o755 });
  const setting = settingFor("agentrun", one);
  const started = [];
  const depsOver = (data) => ({
    signIns,
    settings: { get: async (key) => (key === CLAUDE_LOGIN_SETTING ? setting : undefined), put: async () => {}, remove: async () => {} },
    data,
    env: { HOME: data, PATH: "/usr/bin:/bin" },
    pinned: async () => pinned,
    refused: () => undefined,
    sameMachine: true,
    claude: async () => ({
      claudeLoginCommand: () => "claude auth login",
      claudeLoginStatus: async () => ({ signedIn: false, method: "none" }),
      // A stand-in sign-in that waits until it is stopped.
      startClaudeLogin: (cli, login) => {
        started.push({ cli, dir: login.dir });
        let end;
        const ended = new Promise((resolve) => { end = resolve; });
        return { ended, stop: () => end({ end: "stopped" }) };
      },
    }),
    changed: async () => {},
  });
  const other = depsOver(two);
  assert.equal((await claudeLoginView(other)).state, "other_machine", "the view reads it as another machine's");
  await assert.rejects(startLoginHere(other), (error) => {
    assert.equal(error.code, "agent_not_runnable");
    assert.equal(error.message, "It was turned on for another machine: sign in there.");
    return true;
  });
  assert.deepEqual(started, [], "no CLI's sign-in started for another machine's login");
  // The same request over the data folder it was turned on over starts the CLI's sign-in.
  const own = await startLoginHere(depsOver(one));
  assert.equal(own.sign_in?.state, "waiting", JSON.stringify(own));
  assert.deepEqual(started, [{ cli: pinned, dir: join(one, "claude-login") }]);
});

/** A gate a test holds a call at: `wait` resolves once `open()` is called. */
function latch() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

/** Whether `promise` settles while the event loop turns 20 times. The stand-ins below answer at once, with no I/O, so a
 *  call nothing holds settles within the first turn, and one waiting on a held call does not settle at all. */
async function settlesNow(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 20 && !settled; i++) await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

/** The login routes over stand-ins, for test `t`: the setting in `rows`, turned on at AgentRun's own folder; the pinned
 *  CLI a file; each sign-in's CLI a stand-in that waits until it is stopped (`started`: the folder each one signs in at,
 *  and whether it was stopped). `deps(over)`: the routes' deps with `over` laid on them. `stale(keeps)`: the sign-ins
 *  still waiting at a folder other than `keeps` (undefined: every one still waiting). */
async function loginRig(t) {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-race-"));
  const signIns = new ClaudeSignIns();
  t.after(async () => {
    await signIns.close();
    rmSync(data, { recursive: true, force: true });
  });
  const pinned = join(data, "claude");
  writeFileSync(pinned, "", { mode: 0o755 });
  const env = { HOME: data, PATH: "/usr/bin:/bin" };
  const rows = new Map([[CLAUDE_LOGIN_SETTING, settingFor("agentrun", data)]]);
  const settings = { get: async (key) => rows.get(key) ?? null, put: async (key, value) => void rows.set(key, value), remove: async (key) => void rows.delete(key) };
  const started = [];
  const cli = {
    claudeLoginCommand: () => "claude auth login",
    claudeLoginStatus: async () => ({ signedIn: false, method: "none" }),
    startClaudeLogin: (_cli, login) => {
      const one = { dir: login.dir, stopped: false };
      started.push(one);
      let end;
      const ended = new Promise((resolve) => { end = resolve; });
      return { ended, stop: () => { one.stopped = true; end({ end: "stopped" }); } };
    },
  };
  const deps = (over) => ({ signIns, settings, data, env, pinned: async () => pinned, refused: () => undefined, turn: (work) => work(), sameMachine: true, claude: async () => cli, saved: () => {}, changed: async () => {}, ...over });
  const stale = (keeps) => started.filter((one) => !one.stopped && one.dir !== keeps);
  return { data, env, rows, settings, started, signIns, pinned, deps, stale };
}

// A sign-in reads the setting, then looks up the CLI, then starts it. A move of the login or a turn-off that lands in
// between must not leave that sign-in waiting with what it read before: at a place the login no longer reads, or for a
// login that is off, holding the browser's callback port. Here the sign-in is held inside that gap (its lookup of the
// pinned CLI waits on the test), and the change is asked while it is held. Where nothing holds the change, it answers
// inside the gap; where the change waits its turn behind the sign-in on the sign-ins' queue (ClaudeSignIns.serial), it
// cannot answer first, and the sign-in is let go then. Either way, once both have answered no sign-in may wait at the
// old place.
const RACE_CHANGES = [
  ["a turn-on that moves the login to the other place", (deps) => turnOnClaudeLogin(deps, { only_me: true, place: "machine" }), "machine"],
  ["a turn-off", (deps) => turnOffClaudeLogin(deps), undefined],
];
for (const [change, ask, place] of RACE_CHANGES) {
  test(`${change}, asked while a sign-in's start is between its read of the setting and the CLI's start, leaves no sign-in waiting with the setting it read`, { timeout: 10_000 }, async (t) => {
    const rig = await loginRig(t);
    // The pause point: the sign-in's first lookup of the pinned CLI, after its read of the setting and before its start.
    const inGap = latch();
    const gap = latch();
    let held = false;
    const pressed = startLoginHere(rig.deps({ pinned: async () => { if (!held) { held = true; inGap.open(); await gap.wait; } return rig.pinned; } }));
    await inGap.wait;
    // The change's own request: the same sign-ins, seen through a wrapper that says when it asks for a turn (the one way
    // to start or end a sign-in), so a change that asks for one any way is let through and never waits on the held
    // sign-in here.
    const waits = latch();
    const watched = { view: () => rig.signIns.view(), serial: (work) => { waits.open(); return rig.signIns.serial(work); }, close: () => rig.signIns.close() };
    const changing = ask(rig.deps({ signIns: watched }));
    const first = await Promise.race([changing.then(() => "answered inside the gap"), waits.wait.then(() => "waited its turn")]);
    gap.open();
    const [, answer] = await Promise.all([pressed, changing]);
    assert.equal(answer.state, place === undefined ? "off" : "signed_out", JSON.stringify(answer));
    assert.equal(rig.rows.get(CLAUDE_LOGIN_SETTING)?.place, place, "the change was saved");
    const keeps = place === undefined ? undefined : loginAt(place, rig.data, rig.env).dir;
    assert.deepEqual(rig.stale(keeps), [], `${change} (it ${first}): a sign-in still waits where the login no longer is`);
    assert.ok(rig.started.length >= 1, "the sign-in started");
  });
}

// A change first ends the sign-in that waits, then saves. A start pressed between the two must not run there: it would
// read the setting the change is replacing and leave its CLI waiting at the old place, or for a login that is off. Here
// the change is held between its stop and its save (its write of the setting waits on the test), a start is pressed
// while it is held, and the change is let go. The stop and the save are one turn on the sign-ins' queue, so the start
// waits for the save and starts on what it saved: at the new place, or refused once the login is off.
const SAVE_GAP_WHY = "a sign-in started between the change's stop and its save still waits where the login no longer is";
for (const [change, ask, place] of RACE_CHANGES) {
  test(`${change}, with a start pressed between its stop of the waiting sign-in and its save, leaves no sign-in waiting with the setting it replaced`, { timeout: 10_000 }, async (t) => {
    const rig = await loginRig(t);
    assert.equal((await startLoginHere(rig.deps())).sign_in?.state, "waiting", "a sign-in waits at AgentRun's own folder before the change");
    // The pause point: the change's write of the setting, after its stop.
    const atSave = latch();
    const save = latch();
    const held = (write) => async (...args) => { atSave.open(); await save.wait; return write(...args); };
    const changing = ask(rig.deps({ settings: { ...rig.settings, put: held(rig.settings.put), remove: held(rig.settings.remove) } }));
    await atSave.wait;
    const pressing = startLoginHere(rig.deps());
    const ran = await settlesNow(pressing);
    save.open();
    const [changed, pressed] = await Promise.allSettled([changing, pressing]);
    const keeps = place === undefined ? undefined : loginAt(place, rig.data, rig.env).dir;
    const during = ran ? "the start ran while the save was held" : "the start waited for the save";
    assert.deepEqual(rig.stale(keeps), [], `${change} (${during}): ${SAVE_GAP_WHY}`);
    assert.equal(changed.status, "fulfilled", String(changed.reason));
    assert.equal(rig.rows.get(CLAUDE_LOGIN_SETTING)?.place, place, "the change was saved");
    assert.equal(rig.started[0].stopped, true, "the change ended the sign-in that waited before it");
    if (place === undefined) {
      assert.equal(pressed.status, "rejected", "a start pressed during a turn-off is refused once it lands");
      assert.equal(pressed.reason.message, "Turn on Claude Code's login on this machine first.");
    } else {
      assert.equal(pressed.status, "fulfilled", String(pressed.reason));
      assert.deepEqual(rig.started.filter((one) => !one.stopped).map((one) => one.dir), [keeps], "the start pressed during the change signs in where the change saved");
    }
  });
}

// A change's turn holds the sign-ins' queue only while it stops and saves, and hands the server the login it saved
// (`saved`) inside it, so two changes never leave the server's copy out of order. The server's reread of the keys after
// it (`changed`: the runs' listings, what a revision needs, the harnesses' offers) can take seconds; a sign-in pressed
// meanwhile goes on at once, on what the change saved.
const REREAD_WHY = "a sign-in pressed while the change reread the keys waited for that reread";
for (const [change, ask, place] of RACE_CHANGES) {
  test(`${change} hands the server the login it saved inside its turn and rereads the keys after it: a start pressed during the reread is not held by it`, { timeout: 10_000 }, async (t) => {
    const rig = await loginRig(t);
    const told = [];
    const atReread = latch();
    const reread = latch();
    const changing = ask(rig.deps({ saved: (login) => void told.push(["saved", login?.dir]), changed: async () => { told.push(["changed"]); atReread.open(); await reread.wait; } }));
    await atReread.wait;
    const pressing = startLoginHere(rig.deps());
    const ran = await settlesNow(pressing);
    reread.open();
    const [changed, pressed] = await Promise.allSettled([changing, pressing]);
    assert.ok(ran, `${change}: ${REREAD_WHY}`);
    assert.equal(changed.status, "fulfilled", String(changed.reason));
    const keeps = place === undefined ? undefined : loginAt(place, rig.data, rig.env).dir;
    assert.deepEqual(told, [["saved", keeps], ["changed"]], "the server is handed the saved login, then rereads the keys");
    if (place === undefined) assert.equal(pressed.reason?.message, "Turn on Claude Code's login on this machine first.");
    else assert.deepEqual(rig.started.filter((one) => !one.stopped).map((one) => one.dir), [keeps], "the start signs in where the change saved");
  });
}

// The server probes the harnesses' offers again after a change of what they are made from (keysChanged), and the probe
// can take seconds. The rereads of two changes can overlap, as a login change's runs after its turn. Whatever lands last
// must be offers made from what the server reads then. The probe is held at claude-agent's check by a test harness table
// (fixtures/held-offers.cjs), with no timers: the test lets it go once the other change has answered, and a change
// answers only once the probe it started has landed. `probes(why)` counts the probes from the server's log lines.
const HELD_TABLE = createRequire(import.meta.url).resolve("./fixtures/held-offers.cjs");
const held = createRequire(import.meta.url)(HELD_TABLE);

/** A server on the held table for test `t`: the fake CLI on PATH, no model key, and `options` laid on it. `harnesses()`: its capabilities' harnesses now; `probes(why)`: how many probes of the offers it
 *  has made for `why`; `logged(event)`: resolves once the server has logged a line of `event`. */
async function heldServer(t, options = {}) {
  const fake = await fakeCli(t);
  withEnv(t, { PATH: `${dirname(fake.cli)}${delimiter}${process.env.PATH}` }, MODEL_VARS);
  t.after(() => held.answer(undefined));
  const lines = [];
  const waiting = [];
  const log = (line) => {
    lines.push(line);
    for (const wait of waiting) if (line.includes(` event=${wait.event} `)) wait.resolve();
  };
  const server = await serve(t, { faux: undefined, harnesses: false, runner: false, harnessTable: HELD_TABLE, log, ...options });
  const harnesses = async () => (await server.api("GET", "/capabilities")).body.harnesses;
  const probes = (why) => lines.filter((line) => line.includes(" event=harness_offers ") && line.includes(` why=${why} `)).length;
  const logged = (event) => new Promise((resolve) => {
    if (lines.some((line) => line.includes(` event=${event} `))) resolve();
    else waiting.push({ event, resolve });
  });
  return { ...server, harnesses, probes, logged };
}
const claudeAgentIn = (harnesses) => harnesses.find((offer) => offer.id === "claude-agent");

// A turn-on finds the offers' inputs changed and probes them. A turn-off that lands meanwhile finds the offers held made
// from its own inputs (the turn-on's probe has not landed). The turn-on's probe, landing after it, must not put back
// offers made from the login being on. Both reds run on a faux server: a server that asks Ollama (no faux, no model
// gateway) probes again at the capabilities read itself whenever the offers held are not made from the inputs read now
// (ollamaNow), so there a late probe's offers are replaced before any read shows them; on any other server they stand
// until the next change. The held check answers ON_REASON, so the offers the turn-on's probe lands are told apart.
const PROBE_WHY = "a probe from before the turn-off landed after it and put back an offer made from the login being on";
const ON_REASON = "made from the login being on";
test("a turn-off that lands while the turn-on's probe of the offers is still out leaves claude-agent needing a key once that probe ends", { timeout: 60_000 }, async (t) => {
  const { api, harnesses } = await heldServer(t, { faux: FAUX });
  const before = await harnesses();
  assert.notEqual(claudeAgentIn(before).reason, ON_REASON, "the held check's reason is in no offer before its probe");

  const probe = held.hold((env) => claudeLoginOf(env) !== undefined, ON_REASON);
  t.after(() => probe.release());
  const turningOn = api("PUT", "/settings/claude-login", { only_me: true });
  await probe.reached;
  const off = await api("DELETE", "/settings/claude-login");
  probe.release();
  const on = await turningOn;
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.state, "off");
  const after = await harnesses();
  assert.notEqual(claudeAgentIn(after).reason, ON_REASON, `${PROBE_WHY}: ${JSON.stringify(claudeAgentIn(after))}`);
  assert.deepEqual(after, before, `${PROBE_WHY}: the offers are not the starting state's`);
});

// The same for any two changes whose second lands back on the inputs the offers held were made from: a model key saved
// (its probe held), then deleted. OpenAI's key is not checked against OpenAI as it is saved (key-check.ts NOT_CHECKED),
// so nothing here reaches the network. Faux, and the held check answering KEY_REASON, as above.
const KEY_WHY = "a probe from before the key's delete landed after it and put back offers made from the key being saved";
const KEY_REASON = "made from the key being saved";
test("a model key deleted while its save's probe of the offers is still out leaves the starting state's offers once that probe ends", { timeout: 60_000 }, async (t) => {
  const { api, harnesses } = await heldServer(t, { faux: FAUX });
  const before = await harnesses();

  const probe = held.hold((env) => env.OPENAI_API_KEY !== undefined, KEY_REASON);
  t.after(() => probe.release());
  const saving = api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: "fake-test-key" } });
  await probe.reached;
  const deleted = await api("DELETE", "/settings/tool-keys/openai");
  probe.release();
  const saved = await saving;
  assert.equal(saved.status, 204, JSON.stringify(saved.body));
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  const after = await harnesses();
  assert.notEqual(claudeAgentIn(after).reason, KEY_REASON, `${KEY_WHY}: ${JSON.stringify(claudeAgentIn(after))}`);
  assert.deepEqual(after, before, KEY_WHY);
});

// A plan-billed recipe (harness-recipe.ts) for the harness keys' route alone: never installed, never run.
async function planRecipeFile(t) {
  const { archivePlatform } = await import("../dist/harness-archive.js");
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-recipe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "recipe.json");
  writeFileSync(file, `${JSON.stringify({
    id: "model-agent",
    label: "Model Agent",
    release: { registry: "model-agent", version: "1.0.0", archives: { [archivePlatform()]: { url: "https://releases.example.invalid/model-agent-1.0.0.tar.bz2", format: "tar.bz2", sha256: "0".repeat(64), cmd: "./agent" } } },
    env: { MODEL_AGENT_MODE: "plan", MODEL_AGENT_VENDOR: "127.0.0.1:9", MODEL_AGENT_MODEL: "vendor-model" },
    model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["127.0.0.1:9"] },
    files: { ".config/model-agent/settings.json": "{\"telemetry\": false}\n" },
    state: [".model-agent/sessions"],
    declares: { load: true, mcp: "http" },
    keys: ["MODEL_AGENT_API_KEY"],
  }, null, 2)}\n`);
  return file;
}

// A tool key is none of the offers' inputs (offersEnvOf). While the offers held are current and no probe made from other
// inputs is out, its save or delete starts no probe, and a probe it finds out made from the inputs read now (a harness
// key's, which may find newer facts) is left to land. This test holds that case; the next holds the offers behind the
// inputs with the probe out made from them. With a probe from other inputs out, or none out and the offers behind, a
// tool key's change probes, and a probe out is dropped as it lands. It runs on a faux server, as the two late-probe
// tests do: a server that asks Ollama reads the host's Ollama listing at each capabilities read (ollamaNow), so a model
// pulled or Ollama started during the test would start a probe this test did not cause. The facts here are the held
// table's: claude-agent's check answers FACT from the harness key's save on.
const FACT = "the probe after the harness key's save found this";
const TOOL_KEY_PROBED = "a tool key's change, which changes none of the offers' inputs, started a probe of the offers";
const FACT_WHY = "a tool key's change while a probe made from the inputs read now was out dropped that probe: the facts it found never landed";
test("while the offers held are current and no probe from other inputs is out, a tool key's change starts no probe of the offers, and one made while a probe from the inputs read now is out leaves that probe's facts standing once it lands", { timeout: 60_000 }, async (t) => {
  const { api, harnesses, probes } = await heldServer(t, { faux: FAUX, harnessRecipes: [await planRecipeFile(t)] });
  assert.equal((await api("DELETE", "/settings/tool-keys/typesafe")).status, 204);
  assert.equal(probes("key"), 0, `${TOOL_KEY_PROBED} with no probe out`);
  assert.notEqual(claudeAgentIn(await harnesses()).reason, FACT);

  held.answer(FACT);
  const probe = held.hold(() => true);
  t.after(() => probe.release());
  const saving = api("PUT", "/settings/harness-keys/model-agent/MODEL_AGENT_API_KEY", { value: "not-a-secret-harness-key" });
  await probe.reached;
  const deleted = await api("DELETE", "/settings/tool-keys/typesafe");
  probe.release();
  const saved = await saving;
  assert.equal(saved.status, 204, JSON.stringify(saved.body));
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  const offer = claudeAgentIn(await harnesses());
  assert.equal(offer.reason, FACT, `${FACT_WHY}: ${JSON.stringify(offer)}`);
  assert.equal(probes("key"), 0, `${TOOL_KEY_PROBED} while one made from the inputs read now was out`);
});

// The held offers behind the inputs: a turn-on's probe is out (held), made from the inputs a tool key's change reads.
// The change waits for that probe to land (its harness_offers_wait line), starts none, and drops none: the offers end as
// that probe found them. The turn-on's probe is a change's (why=key) too, so one probe for `key` is the turn-on's alone.
const WAITED_WHY = "a tool key's change while the probe out was made from the inputs read now dropped that probe: the offers it found never landed";
test("while the offers held are behind the inputs and the probe out was made from the inputs read now, a tool key's change waits for that probe, starts none and drops none", { timeout: 60_000 }, async (t) => {
  const { api, harnesses, probes, logged } = await heldServer(t, { faux: FAUX });
  const probe = held.hold((env) => claudeLoginOf(env) !== undefined, ON_REASON);
  t.after(() => probe.release());
  const turningOn = api("PUT", "/settings/claude-login", { only_me: true });
  await probe.reached;
  const deleting = api("DELETE", "/settings/tool-keys/typesafe");
  // Waiting, the change logs that it waits; not waiting, it answers on its own.
  await Promise.race([logged("harness_offers_wait"), deleting]);
  probe.release();
  const [on, deleted] = await Promise.all([turningOn, deleting]);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.equal(probes("key"), 1, `${TOOL_KEY_PROBED} while the probe out was made from the inputs read now`);
  const offer = claudeAgentIn(await harnesses());
  assert.equal(offer.reason, ON_REASON, `${WAITED_WHY}: ${JSON.stringify(offer)}`);
});

// The wait above is only for a probe out made from the inputs the change reads. A change to other inputs while the offers
// lag (the login turned on while a model key's save has its probe out) probes them, and the probe out is dropped: the
// offers end made from the turn-on's inputs, not from the ones the key's save read.
const OTHER_WHY = "a change to other inputs than the probe out's waited for that probe: the offers ended made from the inputs it read";
test("while the offers held are behind the inputs, a change to inputs other than the probe out's probes them and does not wait for that probe", { timeout: 60_000 }, async (t) => {
  const { api, harnesses, probes, logged } = await heldServer(t, { faux: FAUX });
  const probe = held.hold((env) => env.OPENAI_API_KEY !== undefined, KEY_REASON);
  t.after(() => probe.release());
  const saving = api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: "fake-test-key" } });
  await probe.reached;
  const turningOn = api("PUT", "/settings/claude-login", { only_me: true });
  // Waiting, the change logs that it waits; probing, it answers on its own.
  await Promise.race([logged("harness_offers_wait"), turningOn]);
  probe.release();
  const [saved, on] = await Promise.all([saving, turningOn]);
  assert.equal(saved.status, 204, JSON.stringify(saved.body));
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const offer = claudeAgentIn(await harnesses());
  assert.notEqual(offer.reason, KEY_REASON, `${OTHER_WHY}: ${JSON.stringify(offer)}`);
  assert.equal(probes("key"), 2, "the key's save and the turn-on each probe once");
});

// A probe that fails never lands. When it was the latest one, no probe is out after it, so a change back to the inputs
// the offers held were made from reuses them and starts none. A model key saved (its probe held, then failing) and
// deleted. A failed probe logs no harness_offers line, so the delete's would be the only one for `key`.
const FAILED = new Error("the probe of the offers failed here");
test("after the latest probe of the offers fails, a change back to the inputs the offers held were made from starts no probe", { timeout: 60_000 }, async (t) => {
  const { api, harnesses, probes } = await heldServer(t, { faux: FAUX });
  const before = await harnesses();
  const probe = held.hold((env) => env.OPENAI_API_KEY !== undefined, FAILED);
  t.after(() => probe.release());
  const saving = api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: "fake-test-key" } });
  await probe.reached;
  probe.release();
  const saved = await saving;
  assert.equal(saved.status, 500, `the save's probe failed, so the save fails: ${JSON.stringify(saved.body)}`);
  const deleted = await api("DELETE", "/settings/tool-keys/openai");
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.equal(probes("key"), 0, "a change back to the inputs the offers held were made from probed again after the latest probe out had failed");
  assert.deepEqual(await harnesses(), before, "the offers are not the starting state's");
});

// A tool key's change that waits for the probe out (the turn-on's, held) answers for its own key whatever becomes of that
// probe: its key is stored before it waits, so another request's probe failing, or being overtaken, is no failure of its
// own. Parallel's key is a tool key (none of the offers' inputs) and, on a faux server with no fake Parallel, is stored
// unchecked (key-check.ts); the capabilities show it as the decision provider it unlocks (decisionsOf), read from the
// keys at each compose, so they show it once something has composed them after the save.
const parallelShown = async (api) => (await api("GET", "/capabilities")).body.workflows.decisions.providers.find((provider) => provider.id === "parallel")?.available === true;
const PARALLEL_KEY = { values: { PARALLEL_API_KEY: "fake-test-key" } };
const NOT_COMPOSED = "the capabilities never composed the tool key the change saved";
test("a tool key's change that waits for the probe out answers for its own key though that probe fails: it probes again for the inputs it read", { timeout: 60_000 }, async (t) => {
  const { api, logged, probes } = await heldServer(t, { faux: FAUX });
  assert.equal(await parallelShown(api), false, "Parallel shows before its key is saved");
  const probe = held.hold((env) => claudeLoginOf(env) !== undefined, FAILED);
  t.after(() => probe.release());
  const turningOn = api("PUT", "/settings/claude-login", { only_me: true });
  await probe.reached;
  const saving = api("PUT", "/settings/tool-keys/parallel", PARALLEL_KEY);
  await Promise.race([logged("harness_offers_wait"), saving]);
  probe.release();
  const [, saved] = await Promise.all([turningOn, saving]);
  assert.equal(saved.status, 204, `a tool key's change answered the failure of the probe it waited for, another request's, though its key was stored: ${JSON.stringify(saved.body)}`);
  assert.equal(await parallelShown(api), true, NOT_COMPOSED);
  // The failed probe landed nothing, so the offers held are still behind the inputs the change read: it probes them itself.
  assert.equal(probes("key"), 1, "a tool key's change whose waited-for probe failed left the offers behind the inputs it read: it did not probe them again");
});

// The other order: the probe the change waits for is overtaken by a later one (a turn-off's) that then fails. The
// change's key must still show: it settles on the latest probe, never on the dropped one, which lands nothing.
test("a tool key's change that waits for the probe out answers for its own key once that probe is overtaken by one that fails", { timeout: 60_000 }, async (t) => {
  const { api, logged } = await heldServer(t, { faux: FAUX });
  const onProbe = held.hold((env) => claudeLoginOf(env) !== undefined, ON_REASON);
  t.after(() => onProbe.release());
  const turningOn = api("PUT", "/settings/claude-login", { only_me: true });
  await onProbe.reached;
  const saving = api("PUT", "/settings/tool-keys/parallel", PARALLEL_KEY);
  await Promise.race([logged("harness_offers_wait"), saving]);
  const offProbe = held.hold((env) => claudeLoginOf(env) === undefined, FAILED);
  t.after(() => offProbe.release());
  const turningOff = api("DELETE", "/settings/claude-login");
  await offProbe.reached;
  offProbe.release();
  await turningOff;
  onProbe.release();
  const [, saved] = await Promise.all([turningOn, saving]);
  assert.equal(saved.status, 204, JSON.stringify(saved.body));
  assert.equal(await parallelShown(api), true, `${NOT_COMPOSED}: it settled on the probe it first waited for, which a later probe overtook`);
});

// A change waiting for the probe out wakes once a later probe overtakes it: it does not wait on for a probe whose offers
// are dropped. The turn-on's probe stays held to the end; the turn-off's lands. The save has answered by then: one more
// round trip to the server after the turn-off's answer lets its answer, written before, arrive.
test("a tool key's change that waits for the probe out answers once a later probe overtakes that probe, not when the dropped probe ends", { timeout: 60_000 }, async (t) => {
  const { api, logged } = await heldServer(t, { faux: FAUX });
  const onProbe = held.hold((env) => claudeLoginOf(env) !== undefined, ON_REASON);
  t.after(() => onProbe.release());
  const turningOn = api("PUT", "/settings/claude-login", { only_me: true });
  await onProbe.reached;
  let answered = false;
  const saving = api("PUT", "/settings/tool-keys/parallel", PARALLEL_KEY).then((res) => { answered = true; return res; });
  await Promise.race([logged("harness_offers_wait"), saving]);
  const off = await api("DELETE", "/settings/claude-login");
  assert.equal(off.status, 200, JSON.stringify(off.body));
  await api("GET", "/capabilities");
  assert.equal(answered, true, "a tool key's change waited on for the probe it first waited for, after a later probe overtook it and landed");
  const saved = await saving;
  assert.equal(saved.status, 204, JSON.stringify(saved.body));
  assert.equal(await parallelShown(api), true, NOT_COMPOSED);
  onProbe.release();
  await turningOn;
});

// A hold no check took is dropped as it is released, so a test that ends before its held check runs leaves no hold for
// the next server's checks.
const UNTAKEN = "the reason of a hold released before any check took it";
test("a hold of the held table released before any check took it holds and answers no later check", { timeout: 60_000 }, async (t) => {
  held.hold(() => true, UNTAKEN).release();
  const { harnesses } = await heldServer(t, { faux: FAUX });
  const offer = claudeAgentIn(await harnesses());
  assert.notEqual(offer.reason, UNTAKEN, `a hold released before any check took it answered the next server's first check: ${JSON.stringify(offer)}`);
});

// A turn starts or ends the sign-in through its own `turn`. A start or stop of the sign-ins' own beside it would be a
// turn of its own, so one called inside a turn would wait for that turn to end, for ever, and the server's stop (which
// waits for the sign-ins' close) with it. The sign-ins offer none: their queue (serial), the view and the server's close.
test("the sign-ins start and end a sign-in only in a turn on their queue: they offer no start or stop of their own, which a turn calling it would wait on for ever", () => {
  assert.deepEqual(Object.getOwnPropertyNames(ClaudeSignIns.prototype).sort(), ["close", "constructor", "serial", "view"], "the sign-ins offer a start or stop beside a turn's, which one called inside a turn waits on for ever");
  // A class field is the instance's own, not the prototype's: the one the sign-ins have is their limit.
  assert.deepEqual(Object.keys(new ClaudeSignIns()), ["limitMs"], "the sign-ins offer a start or stop beside a turn's, which one called inside a turn waits on for ever");
});

test("the machine's id is a file of the owner's alone (0600) in the data folder, kept across a restart, so the login stays this machine's; a setting saved with a hostname and no id reads as another machine's until turned on again", { timeout: 180_000 }, async (t) => {
  const fake = await fakeCli(t);
  withEnv(t, { PATH: `${dirname(fake.cli)}${delimiter}${process.env.PATH}` }, MODEL_VARS);
  const first = await serve(t, { faux: undefined, harnesses: false, runner: false });
  assert.equal((await first.api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_out");
  const file = join(first.data, "machine-id");
  const id = readFileSync(file, "utf8");
  assert.match(id.trim(), /^[0-9a-f]{32}$/);
  if (process.platform !== "win32") assert.equal((statSync(file).mode & 0o777).toString(8), "600", "the id file is the owner's alone");
  await first.stop();

  const second = await serve(t, { faux: undefined, harnesses: false, runner: false, data: first.data });
  assert.equal((await second.api("GET", "/settings/claude-login")).body.state, "signed_out", "the next start on the same data reads the login as this machine's");
  assert.equal(readFileSync(file, "utf8"), id, "the next start keeps the id it finds");
  // A row a server before the id saved names its machine by hostname alone: another machine's, until turned on again.
  await second.store.settings.put("claude_login", { v: 1, place: "agentrun", host: hostname(), only_me: true });
  assert.equal((await second.api("GET", "/settings/claude-login")).body.state, "other_machine");
  assert.equal((await second.api("PUT", "/settings/claude-login", { only_me: true })).body.state, "signed_out", "turned on again, it is this machine's");
  assert.equal(readFileSync(file, "utf8"), id);
});

// The person's home: the status check, the sign-in and a run on macOS all run in it. It is read once, where the login is
// made (homeOf: the server's HOME when its user owns it, else that user's own home), and every use takes it from the login, so a server
// handed an env whose HOME is not os.homedir()'s answer runs them all in one home.
test("the person's home is read once, where the login is made: with the server's HOME apart from os.homedir(), the status check, the sign-in and a run's status check all run in that HOME, on AgentRun's own folder and on a CLAUDE_CONFIG_DIR folder", { skip: process.platform === "win32" ? "a sh stand-in CLI" : false, timeout: 120_000 }, async (t) => {
  const fake = await fakeCli(t);
  const person = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-person-"));
  assert.notEqual(person, homedir(), "the server's HOME is not os.homedir()'s answer");
  const folder = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-config-dir-"));
  const signIns = new ClaudeSignIns();
  t.after(() => signIns.close());
  for (const [place, extra] of [["agentrun", {}], ["machine", { CLAUDE_CONFIG_DIR: folder }]]) {
    const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-data-"));
    const env = { HOME: person, PATH: `${dirname(fake.cli)}${delimiter}${process.env.PATH}`, ...extra };
    const rows = new Map([[CLAUDE_LOGIN_SETTING, settingFor(place, data)]]);
    const settings = { get: async (key) => rows.get(key) ?? null, put: async (key, value) => void rows.set(key, value), remove: async (key) => void rows.delete(key) };
    const deps = { signIns, settings, data, env, pinned: async () => undefined, refused: () => undefined, sameMachine: true, claude: async () => claude, changed: async () => {} };
    const from = fake.calls().length;
    assert.equal((await claudeLoginView(deps)).state, "signed_out", place);
    await startLoginHere(deps);
    await until(() => fake.calls().slice(from).some((call) => call.argv === "auth login --claudeai"), `${place}: the CLI's sign-in started`);
    // A run's status check, as the run spec asks it (cli-run-spec.ts), on the login loginForRun gives the run.
    const login = await loginForRun(settings, data, env, "claude-agent", { mode: "runner" });
    assert.ok(login, `${place}: a run here goes on the login`);
    await claude.claudeLoginStatus(fake.cli, login, { path: env.PATH });
    const calls = fake.calls().slice(from).filter((call) => call.argv.startsWith("auth "));
    assert.ok(calls.some((call) => call.argv === "auth status --json") && calls.some((call) => call.argv === "auth login --claudeai"), JSON.stringify(calls));
    for (const call of calls) assert.equal(call.home, person, `${place}: ${call.argv} runs in the server's HOME: ${JSON.stringify(call)}`);
  }
});

// The person's home is the home of the user the server runs as. A server started under a sudo that keeps HOME (root, with
// the person's HOME) would otherwise sign the CLI in there as root, leaving root-owned files the person's own CLI can't
// read; a service account that inherited someone's HOME would read that person's login as its own. "/" stands for a HOME
// another user owns (root's, and this test is not root); no file in either home is read or written.
test("a HOME the server's user does not own is not the person's home: the login is in that user's own home, as the system has it", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns /" : false }, async (t) => {
  const own = userInfo().homedir;
  assert.equal(statSync(own).uid, process.geteuid(), "this test's user owns its own home");
  assert.notEqual(statSync("/").uid, process.geteuid());
  // `homeApart`: the env's HOME is not this home, so the line a person runs carries it.
  assert.deepEqual(loginAt("machine", "/d", { HOME: "/" }), { dir: join(own, ".claude"), profiles: join(own, ".config", "anthropic"), home: own, userHome: own, homeApart: true });
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-data-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const saved = { get: async () => settingFor("agentrun", data) };
  assert.deepEqual(await loginForRun(saved, data, { HOME: "/" }, "claude-agent", { mode: "runner" }), { dir: join(data, "claude-login"), profiles: join(data, "claude-login", "anthropic"), userHome: own, homeApart: true }, "a run's CLI runs in that user's own home");
});

// Where the server's user owns neither its HOME nor its own home (a service account whose home is /nonexistent, with a
// HOME it inherited), there is no home its login could be written in. `uid` stands in for a user that owns neither: one
// past this test's own, so the HOME (a folder of the test's) and the test's own home are another user's to it.
test("a server whose user owns neither its HOME nor its own home refuses the login in words: the view says why and offers no sign-in, a turn-on and the CLI's sign-in are refused, and nothing is written, asked or started", { skip: process.platform === "win32" ? "no uid" : false }, async (t) => {
  const rig = await loginRig(t);
  const uid = process.geteuid() + 1;
  const asked = [];
  const claude = {
    claudeLoginCommand: () => "claude auth login",
    claudeLoginStatus: async () => (asked.push("status"), { signedIn: true, method: "claude.ai" }),
    startClaudeLogin: () => (asked.push("sign-in"), { ended: new Promise(() => {}), stop: () => {} }),
  };
  const writes = [];
  const settings = { ...rig.settings, put: async (...args) => (writes.push(args[0]), rig.settings.put(...args)) };
  const deps = rig.deps({ uid, claude: async () => claude, settings });
  const why = new RegExp(`^Claude Code's login on this machine needs a home this server's user owns: it runs as uid ${uid}, and neither its HOME \\(${rig.data.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) nor that user's own home \\(.+\\) is a folder it owns\\.`);

  const view = await claudeLoginView(deps);
  assert.match(view.refused ?? "", why, JSON.stringify(view));
  assert.equal(view.can_start, false);
  assert.equal(view.state, "off", "a login turned on here is none while no home is the server's user's");
  await assert.rejects(startLoginHere(deps), (error) => error.code === "forbidden" && error.message === view.refused);
  rig.rows.clear();
  await assert.rejects(turnOnClaudeLogin(deps, { only_me: true }), (error) => error.code === "forbidden" && error.message === view.refused);
  assert.deepEqual(writes, [], "no setting written");
  assert.deepEqual(asked, [], "the CLI was not asked, and no sign-in started");
  assert.deepEqual(rig.started, []);
  // The server's own user, which owns that HOME, has its login there.
  rig.rows.set(CLAUDE_LOGIN_SETTING, settingFor("agentrun", rig.data));
  const ownView = await claudeLoginView(rig.deps({ claude: async () => claude }));
  assert.equal(ownView.refused, undefined, JSON.stringify(ownView));
  assert.equal(ownView.state, "signed_in");
});

// This machine's login takes more folders from the server's env than its home: the CLI's config dir
// (CLAUDE_CONFIG_DIR), its credentials dir (CLAUDE_SECURESTORAGE_CONFIG_DIR) and the Anthropic profiles
// (ANTHROPIC_CONFIG_DIR, else XDG_CONFIG_HOME's anthropic). Each is the server's user's to write, as the home is, or the
// CLI run as that user (root under a sudo that keeps the env) leaves files in another user's folder that user's own CLI
// can't read. "/" stands for a folder another user owns (root's, and these tests are not root), as above.
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The words this machine's login is refused in where `name` gives it `folder`, which the server's user (`who`, as the
 *  words name it) neither owns nor would make in a folder it owns. */
const notOwnFolder = (who, name, folder) => new RegExp(`^Claude Code's login on this machine needs its folders to be this server's user's own: it runs as ${literally(who)}, and ${literally(folder)}, the folder ${name} gives it, is not a folder it owns, nor one it would make in a folder it owns\\. Start the server as the person whose Claude plan it is\\.$`);
/** The end of the words a folder open to others' writes is refused in: `at`, the folder open so, has `mode`, and the
 *  chmod that closes it. */
const openTail = (at, mode) => `is open to writes by others than its owner: ${literally(at)} has mode ${(mode & 0o7777).toString(8).padStart(4, "0")}, which its group or anyone may write in\\. Make it writable by its owner alone \\(chmod g-w,o-w ${literally(at)}\\): a umask of 002 makes new folders so\\.$`;
/** The words this machine's login is refused in where `name` gives it `folder`, and `at` on its way (or the folder
 *  itself, or the one it is to be made in) is open to writes by its group or anyone, with `mode`. */
const openFolder = (who, name, folder, at, mode) => new RegExp(`^Claude Code's login on this machine needs its folders to be this server's user's own: it runs as ${literally(who)}, and ${literally(folder)}, the folder ${name} gives it, ${openTail(at, mode)}`);
/** The same for the home: `which` is "its HOME" or "that user's own home", `home` the folder named so. */
const openHome = (who, which, home, at, mode) => new RegExp(`^Claude Code's login on this machine needs a home only this server's user may write in: it runs as ${literally(who)}, and ${which} \\(${literally(home)}\\) ${openTail(at, mode)}`);
/** Each variable that gives this machine's login a folder: the folder it gives for `value`, and where the login has it. */
const LOGIN_FOLDER_VARS = [
  ["CLAUDE_CONFIG_DIR", (value) => value, (login) => login.dir],
  ["CLAUDE_SECURESTORAGE_CONFIG_DIR", (value) => value, (login) => login.secure],
  ["XDG_CONFIG_HOME", (value) => join(value, "anthropic"), (login) => login.profiles],
  ["ANTHROPIC_CONFIG_DIR", (value) => value, (login) => login.profiles],
];
/** A stand-in for the harness that notes in `asked` each time the CLI would be asked or started. */
const askedClaude = (asked) => ({
  claudeLoginCommand: () => "claude auth login",
  claudeLoginStatus: async () => (asked.push("status"), { signedIn: true, method: "claude.ai" }),
  startClaudeLogin: () => {
    asked.push("sign-in");
    let end;
    return { ended: new Promise((resolve) => { end = resolve; }), stop: () => end({ end: "stopped" }) };
  },
});
const RUNNER = { mode: "runner" };

/** That this machine's login, on `rig` with `deps`, is refused in words matching `why` everywhere it is read: the
 *  Settings view (none, and no sign-in offered), the CLI's sign-in and a turn-on (403, in the view's words, nothing
 *  saved), and a run (none on it). `what` names the case. */
async function refusedEverywhere(rig, deps, why, what) {
  rig.rows.set(CLAUDE_LOGIN_SETTING, settingFor("machine", rig.data));
  const view = await claudeLoginView(deps);
  assert.match(view.refused ?? "", why, `${what}: the view says why: ${JSON.stringify(view)}`);
  assert.equal(view.can_start, false, `${what}: no sign-in offered`);
  assert.equal(view.state, "off", `${what}: no login here`);
  await assert.rejects(startLoginHere(deps), (error) => error.code === "forbidden" && error.message === view.refused, `${what}: the sign-in is refused`);
  assert.equal(await loginForRun(rig.settings, rig.data, deps.env, "claude-agent", RUNNER, deps.uid), undefined, `${what}: a run goes on a login it refuses`);
  rig.rows.clear();
  await assert.rejects(turnOnClaudeLogin(deps, { only_me: true, place: "machine" }), (error) => error.code === "forbidden" && error.message === view.refused, `${what}: the turn-on is refused`);
  assert.equal(rig.rows.has(CLAUDE_LOGIN_SETTING), false, `${what}: no setting saved`);
}

test("each folder the server's env gives this machine's login must be one its user owns, or would make in one it owns: another user's folder, one still to make in it, or a link to it refuses the login in words in the view, the sign-in, the turn-on and a run; a folder of its own, made or still to make, or a link to one, is the login's", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns /" : false, timeout: 60_000 }, async (t) => {
  const who = `uid ${process.geteuid()} (${userInfo().username})`;
  const mine = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-folders-"));
  t.after(() => rmSync(mine, { recursive: true, force: true }));
  mkdirSync(join(mine, "own"), { mode: 0o700 });
  symlinkSync("/", join(mine, "to-root"));
  symlinkSync(join(mine, "own"), join(mine, "to-own"));
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-data-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const saved = { get: async () => settingFor("machine", data) };
  for (const [name, gives, has] of LOGIN_FOLDER_VARS) {
    for (const value of ["/", "/agentrun-test-folder-never-made", join(mine, "to-root")]) {
      const rig = await loginRig(t);
      const asked = [];
      const deps = rig.deps({ env: { ...rig.env, [name]: value }, claude: async () => askedClaude(asked) });
      await refusedEverywhere(rig, deps, notOwnFolder(who, name, gives(value)), `${name}=${value}`);
      assert.deepEqual(asked, [], `${name}=${value}: the CLI was not asked, and no sign-in started`);
    }
    // The login has each folder's real path: a link of the user's own is followed.
    const real = realpathSync(mine);
    for (const [value, at] of [[join(mine, "own"), join(real, "own")], [join(mine, "still", "to-make"), join(real, "still", "to-make")], [join(mine, "to-own"), join(real, "own")]]) {
      const login = await loginForRun(saved, data, { HOME: UP, [name]: value }, "claude-agent", RUNNER);
      assert.ok(login, `${name}=${value}: a folder of the server's user's own is the login's`);
      assert.equal(has(login), gives(at), `${name}=${value}: ${JSON.stringify(login)}`);
    }
  }
  // AgentRun's own login keeps its folders in its data: the env's are not its, and refuse nothing there.
  const rig = await loginRig(t);
  rig.rows.set(CLAUDE_LOGIN_SETTING, settingFor("agentrun", rig.data));
  const env = { ...rig.env, ...Object.fromEntries(LOGIN_FOLDER_VARS.map(([name]) => [name, "/"])) };
  assert.equal((await claudeLoginView(rig.deps({ env, claude: async () => askedClaude([]) }))).refused, undefined);
  assert.ok(await loginForRun(rig.settings, rig.data, env, "claude-agent", RUNNER), "AgentRun's own login runs");
});

// A server under a sudo that keeps the env (`sudo -E`) runs as root with the person's HOME and the person's
// CLAUDE_CONFIG_DIR. `uid` 0 stands for root here: "/" is root's, and the test's folders are the test user's, so the
// person's to root. Root signing in there would leave root-owned files in the person's folders: refused, and nothing is
// written in them.
test("a server that runs as another user than the one owning the folders its env names (root under a sudo that keeps the env) refuses this machine's login, and writes nothing there: with root's own HOME and the person's CLAUDE_CONFIG_DIR, and with the person's HOME", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns the test's folders" : false, timeout: 60_000 }, async (t) => {
  const person = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-person-config-"));
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-person-home-"));
  t.after(() => [person, home].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const rig = await loginRig(t);
  const asked = [];
  const asRoot = (env) => rig.deps({ uid: 0, env: { ...rig.env, ...env }, claude: async () => askedClaude(asked) });
  await refusedEverywhere(rig, asRoot({ HOME: "/", CLAUDE_CONFIG_DIR: person }), notOwnFolder("uid 0", "CLAUDE_CONFIG_DIR", person), "root, its own HOME, the person's CLAUDE_CONFIG_DIR");
  await refusedEverywhere(rig, asRoot({ HOME: home }), homeNotOwned("uid 0", home), "root, the person's HOME");
  assert.deepEqual(asked, [], "the CLI was not asked, and no sign-in started");
  assert.deepEqual(rig.started, []);
  assert.deepEqual(readdirSync(person), [], "nothing written in the person's CLAUDE_CONFIG_DIR");
  assert.deepEqual(readdirSync(home), [], "nothing written in the person's HOME");
});

/** The words a login is refused in where the server's user (`who`, as the words name it) owns neither its HOME
 *  (`given`) nor its own home. */
const homeNotOwned = (who, given) => new RegExp(`^Claude Code's login on this machine needs a home this server's user owns: it runs as ${literally(who)}, and neither its HOME \\(${literally(given)}\\) nor that user's own home \\(.+\\) is a folder it owns\\.`);

/** The nearest folder at or above the temporary folder that root owns, that anyone may write in, and whose sticky bit
 *  keeps each entry its maker's (/tmp, say); else the first such of the usual ones; undefined where there is none. A link
 *  the test's user makes there sits in a folder no one but root and that link's maker can change. */
const STICKY = (() => {
  const near = [];
  for (let at = process.env.TMPDIR ?? tmpdir(); !near.includes(at); at = dirname(at)) near.push(at);
  return [...near, "/tmp", "/private/tmp", "/var/tmp"].find((at) => {
    try {
      const folder = lstatSync(at);
      accessSync(at, constants.W_OK);
      return folder.isDirectory() && folder.uid === 0 && (folder.mode & 0o1002) === 0o1002;
    } catch {
      return false;
    }
  });
})();
const ROOT_LINKS_SKIP = process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root made the test's links" : STICKY === undefined ? "no folder here that root owns with the sticky bit" : false;

// A link is judged wherever it is on the way to a login folder, not only as its last name, and a trailing slash hides
// none. `uid` 0 stands for root under a sudo that keeps the env, as above, so the links the test makes are the person's.
// Each leads to root's "/": `<link>/usr` is root's own /usr, and `<link>/` is "/" itself, both folders root owns, but the
// person could point the link elsewhere (a folder of theirs) once the check has looked, and root's CLI would write its
// login there. One link is in a folder of the person's (their home, say); one is in the temporary folder that root owns
// with the sticky bit (STICKY), where nothing else on the way is the person's: the link alone refuses there.
async function refusedThroughPersonsLinks(t, valueOf) {
  const mine = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-links-"));
  t.after(() => rmSync(mine, { recursive: true, force: true }));
  symlinkSync("/", join(mine, "current"));
  const loose = join(STICKY, `agentrun-claude-login-link-${randomBytes(6).toString("hex")}`);
  symlinkSync("/", loose);
  t.after(() => rmSync(loose, { force: true }));
  const rig = await loginRig(t);
  const asked = [];
  const asRoot = (env) => rig.deps({ uid: 0, env: { ...rig.env, ...env }, claude: async () => askedClaude(asked) });
  for (const link of [loose, join(mine, "current")]) {
    const value = valueOf(link);
    await refusedEverywhere(rig, asRoot({ HOME: "/", CLAUDE_CONFIG_DIR: value }), notOwnFolder("uid 0", "CLAUDE_CONFIG_DIR", value), `root, its own HOME, CLAUDE_CONFIG_DIR=${value}`);
    await refusedEverywhere(rig, asRoot({ HOME: value }), homeNotOwned("uid 0", value), `root, HOME=${value}`);
  }
  assert.deepEqual(asked, [], "the CLI was not asked, and no sign-in started");
  assert.deepEqual(rig.started, []);
}

test("a link another user made above this machine's login folder or its home refuses the login in the view, the sign-in, the turn-on and a run, though the folder it leads to is the server's user's: root, with CLAUDE_CONFIG_DIR or HOME through the person's link to root's /", { skip: ROOT_LINKS_SKIP, timeout: 60_000 }, (t) => refusedThroughPersonsLinks(t, (link) => join(link, "usr")));

test("a trailing slash hides no link: another user's link as the last name of this machine's login folder or its home, written with a trailing slash, refuses the login in the view, the sign-in, the turn-on and a run: root, with CLAUDE_CONFIG_DIR or HOME the person's link to root's /, and a slash after it", { skip: ROOT_LINKS_SKIP, timeout: 60_000 }, (t) => refusedThroughPersonsLinks(t, (link) => `${link}/`));

/** A folder root owns, that neither its group nor anyone else may write in, inside this process's own folder in /proc,
 *  which is the test's user's (`/proc/<pid>/net/stat`, say): a folder of root's in another user's folder, for `uid` 0.
 *  Undefined where there is none (no /proc). */
const ROOTS_IN_PERSONS = (() => {
  const net = `/proc/${process.pid}/net`;
  try {
    if (lstatSync(`/proc/${process.pid}`).uid !== process.geteuid() || lstatSync(net).uid !== process.geteuid()) return undefined;
    return readdirSync(net).map((name) => join(net, name)).find((at) => {
      const folder = lstatSync(at);
      return folder.isDirectory() && folder.uid === 0 && (folder.mode & 0o022) === 0;
    });
  } catch {
    return undefined;
  }
})();

// A folder of root's inside another user's folder (one a sudo that kept the env left in the person's home, say) is the
// person's to rename and put a folder of theirs in its place once the check has looked, as their link is theirs to
// point elsewhere. So every folder above the login's is judged too: each must be the server's user's or root's.
test("a folder of root's inside another user's folder, as this machine's login folder or its home, refuses the login in the view, the sign-in, the turn-on and a run: root, with CLAUDE_CONFIG_DIR or HOME a folder of its own in the person's", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns the test's folders" : ROOTS_IN_PERSONS === undefined ? "no folder of root's in one of the test user's here" : false, timeout: 60_000 }, async (t) => {
  const rig = await loginRig(t);
  const asked = [];
  const asRoot = (env) => rig.deps({ uid: 0, env: { ...rig.env, ...env }, claude: async () => askedClaude(asked) });
  const value = ROOTS_IN_PERSONS;
  await refusedEverywhere(rig, asRoot({ HOME: "/", CLAUDE_CONFIG_DIR: value }), notOwnFolder("uid 0", "CLAUDE_CONFIG_DIR", value), `root, its own HOME, CLAUDE_CONFIG_DIR=${value}`);
  await refusedEverywhere(rig, asRoot({ HOME: value }), homeNotOwned("uid 0", value), `root, HOME=${value}`);
  assert.deepEqual(asked, [], "the CLI was not asked, and no sign-in started");
});

// A folder still to make is made by the CLI in the nearest folder above it that is there. In one that others may write
// in, sticky or not (/tmp), another user can make it first, as theirs: refused, root's /tmp included.
test("a folder still to make, in a folder others may write in, refuses this machine's login in the view, the sign-in, the turn-on and a run: root, with CLAUDE_CONFIG_DIR a folder still to make in the sticky temporary folder", { skip: ROOT_LINKS_SKIP, timeout: 60_000 }, async (t) => {
  const rig = await loginRig(t);
  const asked = [];
  const asRoot = (env) => rig.deps({ uid: 0, env: { ...rig.env, ...env }, claude: async () => askedClaude(asked) });
  const value = join(STICKY, `agentrun-claude-login-never-made-${randomBytes(6).toString("hex")}`);
  await refusedEverywhere(rig, asRoot({ HOME: "/", CLAUDE_CONFIG_DIR: value }), openFolder("uid 0", "CLAUDE_CONFIG_DIR", value, STICKY, lstatSync(STICKY).mode), `root, its own HOME, CLAUDE_CONFIG_DIR=${value}`);
  assert.deepEqual(asked, [], "the CLI was not asked, and no sign-in started");
  assert.equal(existsSync(value), false);
});

// A home of the server's user's own that its group or anyone may write in is refused, at either place, in words that say
// so and name the chmod that closes it, not in words that say it is not the user's. `uid` 0 stands for root: the sticky
// temporary folder (STICKY) is root's and open to all, and the test user's own home is not root's.
test("a home its group or anyone may write in refuses the login, at either place, in words that name the open folder, its mode and the chmod that closes it: root, with HOME the sticky temporary folder", { skip: ROOT_LINKS_SKIP, timeout: 60_000 }, async (t) => {
  const rig = await loginRig(t);
  const asked = [];
  const deps = rig.deps({ uid: 0, env: { ...rig.env, HOME: STICKY }, claude: async () => askedClaude(asked) });
  const why = openHome("uid 0", "its HOME", STICKY, STICKY, lstatSync(STICKY).mode);
  await refusedEverywhere(rig, deps, why, `root, HOME=${STICKY}`);
  rig.rows.set(CLAUDE_LOGIN_SETTING, settingFor("agentrun", rig.data));
  const view = await claudeLoginView(deps);
  assert.match(view.refused ?? "", why, `AgentRun's own login too: ${JSON.stringify(view)}`);
  assert.equal(view.state, "off");
  assert.deepEqual(asked, [], "the CLI was not asked, and no sign-in started");
});

// A folder of this machine's login still to make is made by AgentRun, 0700 whatever the umask, before the CLI's sign-in
// and at a turn-on, in the folder the check found the user's own; then checked again, and the CLI gets that check's
// login. Under a umask of 002 (a group of the user's own, as some distributions give each user) a folder the CLI made
// would be 0775, open to its group, and the view after the sign-in would refuse the login the CLI just signed in.
test("a folder of this machine's login still to make is made 0700 before the CLI's sign-in and at a turn-on, whatever the umask, so the view after the sign-in does not refuse the login the CLI signed in there", { skip: process.platform === "win32" ? "no modes" : process.geteuid() === 0 ? "root may write anywhere" : false, timeout: 60_000 }, async (t) => {
  const was = process.umask(0o002);
  t.after(() => process.umask(was));
  const mine = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-make-"));
  t.after(() => rmSync(mine, { recursive: true, force: true }));
  const real = realpathSync(mine);
  const madeBy = [];
  const cliMakes = {
    ...askedClaude([]),
    startClaudeLogin: (_cli, login) => {
      // The CLI makes its folders as its own mkdir and the umask give them.
      madeBy.push(login);
      for (const dir of [login.dir, login.profiles]) mkdirSync(dir, { recursive: true });
      let end;
      return { ended: new Promise((resolve) => { end = resolve; }), stop: () => end({ end: "stopped" }) };
    },
  };
  const modes = (...dirs) => dirs.map((dir) => `${dir} ${(lstatSync(dir).mode & 0o777).toString(8)}`);
  const rig = await loginRig(t);
  rig.rows.set(CLAUDE_LOGIN_SETTING, settingFor("machine", rig.data));
  const deps = rig.deps({ env: { ...rig.env, CLAUDE_CONFIG_DIR: join(mine, "config", "to-make"), ANTHROPIC_CONFIG_DIR: join(mine, "profiles", "to-make") }, claude: async () => cliMakes });
  await startLoginHere(deps);
  assert.deepEqual(madeBy.map((login) => [login.dir, login.profiles]), [[join(real, "config", "to-make"), join(real, "profiles", "to-make")]]);
  const made = ["config", join("config", "to-make"), "profiles", join("profiles", "to-make")].map((name) => join(real, name));
  assert.deepEqual(modes(...made), made.map((dir) => `${dir} 700`), "made 0700 before the CLI started");
  const after = await claudeLoginView(deps);
  assert.equal(after.refused, undefined, `the view after the sign-in: ${JSON.stringify(after)}`);
  assert.equal(after.state, "signed_in");

  const other = await loginRig(t);
  other.rows.clear();
  const turned = join(mine, "turned", "on");
  const view = await turnOnClaudeLogin(other.deps({ env: { ...other.env, CLAUDE_CONFIG_DIR: turned }, claude: async () => askedClaude([]) }), { only_me: true, place: "machine" });
  assert.equal(view.refused, undefined, JSON.stringify(view));
  assert.deepEqual(modes(join(real, "turned"), join(real, "turned", "on")), [`${join(real, "turned")} 700`, `${join(real, "turned", "on")} 700`], "a turn-on makes it 0700 too");
});

// A person's own server, with a link of theirs to a folder of theirs anywhere on the way (a home moved to another disk,
// say), keeps its login. The login has the real paths, and the CLI gets those: a link changed after the check, by
// anyone, redirects nothing.
test("a link the server's user made to a folder of its own, above this machine's login folder or its home or as their last name, with a trailing slash or none, keeps the login, and the login and the CLI's variables have the real paths", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns /" : false, timeout: 60_000 }, async (t) => {
  const mine = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-own-links-"));
  t.after(() => rmSync(mine, { recursive: true, force: true }));
  mkdirSync(join(mine, "own", "claude"), { recursive: true, mode: 0o700 });
  symlinkSync(join(mine, "own"), join(mine, "current"));
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-data-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const saved = { get: async () => settingFor("machine", data) };
  const current = join(mine, "current");
  const own = join(realpathSync(mine), "own");
  for (const [home, homeAt] of [[current, own], [`${current}/`, own], [join(current, "claude"), join(own, "claude")]]) {
    for (const [value, at] of [[join(current, "claude"), join(own, "claude")], [`${join(current, "claude")}/`, join(own, "claude")], [`${current}/`, own], [join(current, "still", "to-make"), join(own, "still", "to-make")]]) {
      const env = { HOME: home, CLAUDE_CONFIG_DIR: value, CLAUDE_SECURESTORAGE_CONFIG_DIR: value, ANTHROPIC_CONFIG_DIR: value };
      const login = await loginForRun(saved, data, env, "claude-agent", RUNNER);
      const what = `HOME=${home}, the folder variables ${value}`;
      assert.ok(login, `${what}: the login is the server's user's own`);
      assert.deepEqual([login.dir, login.secure, login.profiles, login.userHome], [at, at, at, homeAt], `${what}: ${JSON.stringify(login)}`);
      assert.deepEqual(claude.claudeLoginEnv(login), { CLAUDE_SECURESTORAGE_CONFIG_DIR: at, ANTHROPIC_CONFIG_DIR: at }, `${what}: the CLI's variables`);
    }
  }
});

/** For the rest of test `t`: just before this process's `nth` lstat of `link` (the login's walk looks at each link with
 *  lstat, one walk one look), `link` is made again leading to `to`, as another user who may write in the link's folder
 *  could swap it between one look and the next. Gives the undo, also run after `t`. */
function linkSwapsAt(t, link, nth, to) {
  const fs = createRequire(import.meta.url)("node:fs");
  const real = fs.lstatSync;
  let seen = 0;
  fs.lstatSync = function lstatSwapping(path, ...rest) {
    if (path === link && ++seen === nth) {
      fs.unlinkSync(link);
      fs.symlinkSync(to, link);
    }
    return real.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  let undone = false;
  const undo = () => {
    if (undone) return;
    undone = true;
    fs.lstatSync = real;
    syncBuiltinESMExports();
  };
  t.after(undo);
  return undo;
}

// The check and the login are one walk. Were they two, a link another user can swap (in a folder they may write in)
// could lead to the server's user's own folder for the one and elsewhere for the other; a login that then fell back to
// the path as given would hand the CLI a name that leads wherever that link leads now. Here the test user's link
// (CLAUDE_CONFIG_DIR) leads to its own folder or to root's "/" (no folder of its own), and is swapped before the 1st, 2nd,
// 3rd or 4th look at it, each way round. Whatever each read decides, the path as given reaches no CLI, no CLI variable
// and no sign-in line: a run, the CLI's sign-in, the view (its line and its status check) and a turn-on (the login it
// hands the server) each get the real folder, or nothing.
test("the login's folders are walked once for each decision: a link swapped between one look and the next hands no run, no sign-in, no status check, no sign-in line and no turn-on the folder as given, only its real path or nothing", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns /" : false, timeout: 120_000 }, async (t) => {
  const readers = {
    run: async (rig, deps) => [await loginForRun(rig.settings, rig.data, deps.env, "claude-agent", RUNNER, deps.uid)],
    "sign-in": async (rig, deps) => void (await startLoginHere(deps)),
    view: async (rig, deps) => [(await claudeLoginView(deps)).command],
    "turn-on": async (rig, deps) => {
      rig.rows.clear();
      return [(await turnOnClaudeLogin(deps, { only_me: true, place: "machine" })).command];
    },
  };
  let handedReal = 0;
  for (const [reader, read] of Object.entries(readers)) {
    for (const [first, then] of [["own", "/"], ["/", "own"]]) {
      for (const nth of [1, 2, 3, 4, 99]) {
        const mine = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-swap-"));
        t.after(() => rmSync(mine, { recursive: true, force: true }));
        const real = realpathSync(mine);
        const own = join(real, "own");
        mkdirSync(own, { mode: 0o700 });
        const link = join(real, "link");
        const target = (which) => (which === "own" ? own : "/");
        symlinkSync(target(first), link);
        const rig = await loginRig(t);
        rig.rows.set(CLAUDE_LOGIN_SETTING, settingFor("machine", rig.data));
        const handed = [];
        const stub = {
          claudeLoginCommand: (login) => (handed.push(login), `claude auth login ${JSON.stringify(login)}`),
          claudeLoginStatus: async (_cli, login) => (handed.push(login), { signedIn: true, method: "claude.ai" }),
          startClaudeLogin: (_cli, login) => {
            handed.push(login);
            let end;
            return { ended: new Promise((resolve) => { end = resolve; }), stop: () => end({ end: "stopped" }) };
          },
        };
        const deps = rig.deps({ env: { ...rig.env, CLAUDE_CONFIG_DIR: link }, claude: async () => stub, saved: (login) => void (login && handed.push(login)) });
        const undo = linkSwapsAt(t, link, nth, target(then));
        const what = `${reader}, the link leading to ${first} then ${then} from look ${nth}`;
        let lines = [];
        try {
          lines = (await read(rig, deps)) ?? [];
        } catch (error) {
          assert.equal(error.code, "forbidden", `${what}: refused, or nothing: ${error.stack}`);
        }
        undo();
        for (const login of [...handed, ...lines]) {
          if (login === undefined) continue;
          const said = typeof login === "string" ? login : JSON.stringify([login, claude.claudeLoginEnv(login)]);
          assert.ok(!said.includes(link), `${what}: the path as given reached the CLI, its variables or the line: ${said}`);
          if (typeof login !== "string" && login.dir === own) handedReal++;
        }
      }
    }
  }
  assert.ok(handedReal > 0, "a link that leads to the server's user's own folder hands on its real path");
});

// A folder on the way that its group or anyone may write in, with no sticky bit to keep each entry its maker's, lets
// another user put a folder or a link of theirs in the place of the next one once the check has looked; one open so as
// the login folder itself lets them put their files in it, and as the folder the CLI makes the login's in, make that
// first. All are refused. The sticky bit (as /tmp has it) keeps a folder on the way, but not the login folder itself
// nor the one it is made in. The words say which folder is open, its mode, and the chmod that closes it, not that the
// folder is not the user's (it is): a umask of 002 (a group of the user's own, as some distributions give each user)
// makes folders 0775, and a volume whose group is set for a pod gives 2775.
test("a folder its group or anyone may write in, on the way to this machine's login folder with no sticky bit, or as that folder itself or the one it is to be made in, refuses the login in the view, the sign-in, the turn-on and a run, in words that name the open folder, its mode and the chmod that closes it; with the sticky bit, one on the way keeps it", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root may write anywhere" : false, timeout: 60_000 }, async (t) => {
  const who = `uid ${process.geteuid()} (${userInfo().username})`;
  const mine = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-open-"));
  t.after(() => rmSync(mine, { recursive: true, force: true }));
  const open = join(mine, "open");
  mkdirSync(join(open, "claude"), { recursive: true, mode: 0o700 });
  for (const mode of [0o777, 0o770, 0o775, 0o2775]) {
    chmodSync(open, mode);
    for (const value of [join(open, "claude"), open, join(open, "still", "to-make")]) {
      const rig = await loginRig(t);
      const asked = [];
      const deps = rig.deps({ env: { ...rig.env, CLAUDE_CONFIG_DIR: value }, claude: async () => askedClaude(asked) });
      const what = `CLAUDE_CONFIG_DIR=${value}, ${open} ${mode.toString(8)}`;
      await refusedEverywhere(rig, deps, openFolder(who, "CLAUDE_CONFIG_DIR", value, realpathSync(open), mode), what);
      assert.deepEqual(asked, [], `${what}: the CLI was not asked, and no sign-in started`);
    }
  }
  chmodSync(open, 0o1777);
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-data-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const saved = { get: async () => settingFor("machine", data) };
  assert.ok(await loginForRun(saved, data, { HOME: UP, CLAUDE_CONFIG_DIR: join(open, "claude") }, "claude-agent", RUNNER), "with the sticky bit, a folder on the way keeps the login");
  assert.equal(await loginForRun(saved, data, { HOME: UP, CLAUDE_CONFIG_DIR: open }, "claude-agent", RUNNER), undefined, "with the sticky bit, the login folder itself still refuses it");
  assert.equal(await loginForRun(saved, data, { HOME: UP, CLAUDE_CONFIG_DIR: join(open, "still", "to-make") }, "claude-agent", RUNNER), undefined, "with the sticky bit, the folder the login is to be made in still refuses it");
});

/** Whether the test's user owns its own home as the system has it, held as the login's home must be. */
const ownHomeHeld = (() => {
  try {
    const home = lstatSync(userInfo().homedir);
    return home.isDirectory() && home.uid === process.geteuid() && (home.mode & 0o022) === 0;
  } catch {
    return false;
  }
})();

// A server whose env's HOME is another user's (root under a sudo that keeps the env, with the person's HOME) keeps its
// login in its own user's home (homeOf). A terminal with that env is in the other user's home, so a line that left HOME
// to the terminal would sign the CLI in there, where the server never reads. The line the view shows carries the home.
// Here the test's user stands for root, and "/" (root's) for the person's HOME; its own home is only named, not read.
test("a server whose env's HOME is another user's shows a sign-in line that carries its own user's home, at either place, so the line signs in where the server reads; with its own HOME, the line leaves HOME to the terminal", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns /" : !ownHomeHeld ? "the test user's own home is not one it holds" : false, timeout: 60_000 }, async (t) => {
  const rig = await loginRig(t);
  const own = realpathSync(userInfo().homedir);
  const withLine = async () => ({ ...askedClaude([]), claudeLoginCommand: claude.claudeLoginCommand });
  const carriesHome = (line, home) => line.includes(` HOME=${home} `) || line.includes(` HOME='${home}' `) || line.startsWith(`HOME=${home} `) || line.startsWith(`HOME='${home}' `);
  for (const place of ["machine", "agentrun"]) {
    rig.rows.set(CLAUDE_LOGIN_SETTING, settingFor(place, rig.data));
    const view = await claudeLoginView(rig.deps({ env: { PATH: rig.env.PATH, HOME: "/" }, claude: withLine }));
    assert.equal(view.refused, undefined, `${place}: ${JSON.stringify(view)}`);
    assert.ok(carriesHome(view.command, own), `${place}, the person's HOME: the line carries the server's user's own home: ${view.command}`);
    const mine = await claudeLoginView(rig.deps({ env: { PATH: rig.env.PATH, HOME: UP }, claude: withLine }));
    assert.doesNotMatch(mine.command, /(^| )HOME=/, `${place}, its own HOME: ${mine.command}`);
  }
});

// A login saved before is kept at the start of a server that refuses its folders: refused in words while they are, so no
// runner, in this process or another, runs on it, and the reason is logged. The person mends the folders (a chmod, or
// the server started as the right user with that user's variables) and has the login back; deleting the setting would
// have turned off a login that ran before, for a reason a chmod mends. Here, one saved on this machine's
// CLAUDE_CONFIG_DIR, and a later start whose CLAUDE_CONFIG_DIR is another user's folder ("/", as above).
test("a login saved on this machine's folders is kept at the start of a server whose env gives it a folder its user does not own: refused in words there, no run on it, and the reason logged; a start with the folder its own again has the login", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root owns /" : false, timeout: 120_000 }, async (t) => {
  const folder = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-config-dir-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const first = await signInServer(t, "sign", {}, { CLAUDE_CONFIG_DIR: folder });
  const on = await first.api("PUT", "/settings/claude-login", { only_me: true, place: "machine" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.place, "machine");
  await first.stop();

  process.env.CLAUDE_CONFIG_DIR = "/";
  const lines = [];
  const second = await serve(t, { faux: undefined, harnesses: false, runner: false, data: first.data, log: (line) => lines.push(line) });
  const why = notOwnFolder(`uid ${process.geteuid()} (${userInfo().username})`, "CLAUDE_CONFIG_DIR", "/");
  assert.ok(lines.some((line) => /kept, and not used while it is refused: Claude Code's login on this machine needs its folders/.test(line)), `the start logs why it does not use the login: ${lines.join("\n")}`);
  assert.ok(!lines.some((line) => /turned off/.test(line)), `the start turns nothing off: ${lines.join("\n")}`);
  const refused = (await second.api("GET", "/settings/claude-login")).body;
  assert.equal(refused.state, "off", JSON.stringify(refused));
  assert.match(refused.refused ?? "", why);
  assert.equal(await loginForRun(second.store.settings, first.data, process.env, "claude-agent", RUNNER), undefined, "no run goes on it");
  const again = await second.api("PUT", "/settings/claude-login", { only_me: true, place: "machine" });
  assert.equal(again.status, 403);
  assert.match(again.body.error.message, why);
  await second.stop();

  process.env.CLAUDE_CONFIG_DIR = folder;
  const third = await serve(t, { faux: undefined, harnesses: false, runner: false, data: first.data });
  const view = (await third.api("GET", "/settings/claude-login")).body;
  assert.equal(view.place, "machine", `kept: ${JSON.stringify(view)}`);
  assert.notEqual(view.state, "off", `kept, and the login again: ${JSON.stringify(view)}`);
  assert.equal(view.refused, undefined);
  assert.equal(view.folder, realpathSync(folder));
});

// A folder its group may write in (a home or a folder on a volume whose group is set for a pod, 2775, or one made under
// a umask of 002, 0775) is refused, and a chmod mends it: a start keeps the setting, logs why, and turns nothing off.
// One refused for the switch or for more than one owner is still turned off, as before.
test("a start keeps a login saved on a folder its group may write in, and logs why it does not use it; one refused for the switch is turned off", { skip: process.platform === "win32" ? "no uid" : process.geteuid() === 0 ? "root may write anywhere" : false }, async (t) => {
  const mine = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-kept-"));
  t.after(() => rmSync(mine, { recursive: true, force: true }));
  const open = join(mine, "open");
  mkdirSync(open, { mode: 0o700 });
  const signIns = new ClaudeSignIns();
  t.after(() => signIns.close());
  for (const mode of [0o775, 0o2775]) {
    chmodSync(open, mode);
    const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-data-"));
    t.after(() => rmSync(data, { recursive: true, force: true }));
    const rows = new Map([[CLAUDE_LOGIN_SETTING, settingFor("machine", data)]]);
    const settings = { get: async (key) => rows.get(key) ?? null, remove: async (key) => void rows.delete(key) };
    const lines = [];
    await dropRefusedLogin(signIns, settings, undefined, { HOME: UP, CLAUDE_CONFIG_DIR: open }, (line) => lines.push(line));
    assert.ok(rows.has(CLAUDE_LOGIN_SETTING), `${mode.toString(8)}: the setting is kept`);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /^Claude Code's login on this machine is kept, and not used while it is refused: Claude Code's login on this machine needs its folders/, lines[0]);
    await dropRefusedLogin(signIns, settings, `${CLAUDE_LOGIN_ENV}=off`, { HOME: UP, CLAUDE_CONFIG_DIR: open }, () => {});
    assert.equal(rows.has(CLAUDE_LOGIN_SETTING), false, `${mode.toString(8)}: the switch's refusal turns it off`);
  }
});

// A status check copies the account file into a folder of its own in the temporary folder and removes it when it ends;
// a server killed outright (SIGKILL) mid-check runs no `finally`, and leaves the folder with the copy in it.
test("a status check's folder that a killed server left in the temporary folder is removed when a server starts, once older than twice a check's limit; a fresh one, which another server's live check may hold, stays", { skip: process.platform === "win32" ? "no uid" : false, timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-status-sweep-"));
  const folder = (name) => {
    const path = join(tmp, name);
    mkdirSync(join(path, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "config", ".claude.json"), "{}\n", { mode: 0o600 });
    return path;
  };
  const stale = folder("agentrun-claude-status-Ab12Cd");
  const fresh = folder("agentrun-claude-status-Ef34Gh");
  const past = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, past, past);
  withEnv(t, { TMPDIR: tmp }, MODEL_VARS);
  await serve(t, { faux: undefined, harnesses: false, runner: false });
  assert.equal(existsSync(stale), false, "the stale folder, with the copy in it, is gone once the server has started");
  assert.ok(existsSync(join(fresh, "config", ".claude.json")), "the fresh folder stays");
});

// A Claude-plan run's login check on a loaded host (loginBeforeRun). The status checks here are stand-ins: a check the
// CLI outlasted throws as the harness's does (claudeLoginStatus: `code` "timed_out", its limit, its words).
const timedOut = () => Object.assign(new Error("the claude CLI gave no login status: the check timed out after 15 s"), { code: "timed_out", limitMs: 15_000 });
const SAID_IN = { signedIn: true, method: "claude.ai" };
const SAID_OUT = { signedIn: false, method: "none" };

/** A stand-in status check that answers `answers` in turn (an Error is thrown) and counts how often it was asked. */
function statusOf(...answers) {
  let calls = 0;
  const status = async () => {
    const said = answers[Math.min(calls++, answers.length - 1)];
    if (said instanceof Error) throw said;
    return said;
  };
  return { status, calls: () => calls };
}

/** The data folder these checks keep their answers in, one for them all, so another login's answer is there to be told
 *  apart. */
const ANSWERS = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-answers-"));
test.after(() => rmSync(ANSWERS, { recursive: true, force: true }));

/** A login of its own, so no test's earlier answer is another's. */
async function ownLogin() {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-check-"));
  return { dir: join(dir, "claude-login"), profiles: join(dir, "claude-login", "anthropic"), userHome: dir };
}

/** A clock that reads `start` plus what `at(ms)` last set. */
function clock(start) {
  let now = start;
  return { now: () => now, at: (ms) => { now = start + ms; } };
}

/** Asserts `error` is the run's refusal for a login whose CLI could not say, in words that name the timeout. */
const unknownByTimeout = (error) => {
  assert.ok(error.message.startsWith(LOGIN_UNKNOWN), error.message);
  assert.match(error.message, /timed out after 15 s/, "the words say the check timed out, and after how long");
  return true;
};

test("a Claude-plan run whose login check times out once asks again, and goes on when that answer is signed in", async () => {
  const login = await ownLogin();
  const fake = statusOf(timedOut(), SAID_IN);
  await loginBeforeRun(login, "claude", fake.status, { data: ANSWERS });
  assert.equal(fake.calls(), 2, "status was asked twice");
});

test("a Claude-plan run whose login check times out twice goes on when the same login answered signed in 2 minutes before in this server", async () => {
  const login = await ownLogin();
  const time = clock(1_000_000);
  await loginBeforeRun(login, "claude", statusOf(SAID_IN).status, { data: ANSWERS, now: time.now });
  time.at(2 * 60_000);
  const fake = statusOf(timedOut(), timedOut());
  await loginBeforeRun(login, "claude", fake.status, { data: ANSWERS, now: time.now });
  assert.equal(fake.calls(), 2, "asked twice before the earlier answer is taken");
});

test("a Claude-plan run whose login check times out twice is refused with LOGIN_UNKNOWN, in words that name the timeout, when the login never answered signed in here, answered 11 minutes ago, answered after now (the clock set back since), or only another login did", async () => {
  const never = await ownLogin();
  const first = statusOf(timedOut(), timedOut());
  await assert.rejects(loginBeforeRun(never, "claude", first.status, { data: ANSWERS }), unknownByTimeout);
  assert.equal(first.calls(), 2, "no earlier answer: asked twice, then refused");

  const old = await ownLogin();
  const time = clock(1_000_000);
  await loginBeforeRun(old, "claude", statusOf(SAID_IN).status, { data: ANSWERS, now: time.now });
  time.at(11 * 60_000);
  const stale = statusOf(timedOut(), timedOut());
  await assert.rejects(loginBeforeRun(old, "claude", stale.status, { data: ANSWERS, now: time.now }), unknownByTimeout);
  assert.equal(stale.calls(), 2, "an answer 11 minutes old: asked twice, then refused");

  // Another login (another folder) answered signed in a minute before: that answer is not this login's.
  const other = await ownLogin();
  time.at(0);
  await loginBeforeRun(other, "claude", statusOf(SAID_IN).status, { data: ANSWERS, now: time.now });
  time.at(60_000);
  const fresh = await ownLogin();
  await assert.rejects(loginBeforeRun(fresh, "claude", statusOf(timedOut(), timedOut()).status, { data: ANSWERS, now: time.now }), unknownByTimeout);
  // The same folder with its credentials kept apart is another login too.
  await assert.rejects(loginBeforeRun({ ...other, secure: join(other.userHome, "elsewhere") }, "claude", statusOf(timedOut(), timedOut()).status, { data: ANSWERS, now: time.now }), unknownByTimeout);

  // An answer noted a minute after now (the clock set back since) stands for nothing.
  const ahead = await ownLogin();
  time.at(60_000);
  await loginBeforeRun(ahead, "claude", statusOf(SAID_IN).status, { data: ANSWERS, now: time.now });
  time.at(0);
  await assert.rejects(loginBeforeRun(ahead, "claude", statusOf(timedOut(), timedOut()).status, { data: ANSWERS, now: time.now }), unknownByTimeout, "an answer from a minute after now stood for a run whose checks timed out");
});

test("a signed-out answer is never asked again nor overridden by an earlier signed-in one: the run is refused at once with LOGIN_SIGNED_OUT, and that earlier answer is gone, so a timeout after it is refused", async () => {
  const login = await ownLogin();
  const time = clock(1_000_000);
  await loginBeforeRun(login, "claude", statusOf(SAID_IN).status, { data: ANSWERS, now: time.now });
  time.at(60_000);
  const slow = statusOf(timedOut(), timedOut());
  await loginBeforeRun(login, "claude", slow.status, { data: ANSWERS, now: time.now });
  assert.equal(slow.calls(), 2, "two timeouts a minute after a signed-in answer: the run goes on");

  time.at(2 * 60_000);
  const out = statusOf(SAID_OUT, SAID_IN);
  await assert.rejects(loginBeforeRun(login, "claude", out.status, { data: ANSWERS, now: time.now }), (error) => {
    assert.equal(error.message, LOGIN_SIGNED_OUT);
    return true;
  });
  assert.equal(out.calls(), 1, "a signed-out answer is the answer: status asked once");

  time.at(3 * 60_000);
  await assert.rejects(loginBeforeRun(login, "claude", statusOf(timedOut(), timedOut()).status, { data: ANSWERS, now: time.now }), unknownByTimeout);
});

test("the Settings view feeds the same answer: after it read the login signed in, a run whose two checks time out goes on; after it read signed out, one is refused; a check that times out there reads unknown and is asked once", async () => {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-view-"));
  const pinned = join(data, "claude");
  writeFileSync(pinned, "", { mode: 0o755 });
  const setting = settingFor("agentrun", data);
  let said = SAID_IN;
  let asked = 0;
  const deps = {
    signIns: { view: () => undefined },
    settings: { get: async (key) => (key === CLAUDE_LOGIN_SETTING ? setting : undefined), put: async () => {}, remove: async () => {} },
    data,
    env: { HOME: data, PATH: "/usr/bin:/bin" },
    pinned: async () => pinned,
    refused: () => undefined,
    sameMachine: false,
    claude: async () => ({
      claudeLoginCommand: () => "claude auth login",
      claudeLoginStatus: async () => {
        asked++;
        if (said instanceof Error) throw said;
        return said;
      },
    }),
    changed: async () => {},
  };
  const login = loginAt("agentrun", data, deps.env);

  assert.equal((await claudeLoginView(deps)).state, "signed_in");
  const slow = statusOf(timedOut(), timedOut());
  await loginBeforeRun(login, pinned, slow.status, { data });
  assert.equal(slow.calls(), 2, "the run asked twice, then took the view's answer");

  said = SAID_OUT;
  assert.equal((await claudeLoginView(deps)).state, "signed_out");
  await assert.rejects(loginBeforeRun(login, pinned, statusOf(timedOut(), timedOut()).status, { data }), unknownByTimeout);

  said = timedOut();
  asked = 0;
  assert.equal((await claudeLoginView(deps)).state, "unknown", "a timeout in the view reads unknown");
  assert.equal(asked, 1, "the view never asks again: a person waits on it");
});

// The server and its runner can be two processes on one machine and one data folder (`agentrun-serve --no-runner` beside
// `agentrun-serve runner --data`): the Settings view's answer is the server's, a run's check is the runner's. So the
// answer is kept in the data folder, and a runner process that never asked itself takes it. Another data folder is
// another machine's (machineId): its runner takes none. A signed-out answer in the view removes it.
const RUNNER_CHECK = `
const [dist, data, login] = process.argv.slice(1);
const { loginBeforeRun } = await import(dist);
const timedOut = () => Object.assign(new Error("the claude CLI gave no login status: the check timed out after 15 s"), { code: "timed_out", limitMs: 15000 });
try {
  await loginBeforeRun(JSON.parse(login), "claude", async () => { throw timedOut(); }, { data });
  process.stdout.write("went on");
} catch (error) {
  process.stdout.write(error.message);
}`;
/** A run's check of `login` in a runner process of its own on `data`, whose two status checks time out: "went on", or the
 *  refusal's words. The process is ended after `limitMs`, which fails the test in the words `held`. */
function runnerCheck(data, login, { limitMs = 60_000, held } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", RUNNER_CHECK, new URL("../dist/claude-login.js", import.meta.url).href, data, JSON.stringify(login)], { env, encoding: "utf8", timeout: limitMs });
  assert.equal(ran.status, 0, ran.signal ? `${held ?? "the runner's check never ended"} (ended after ${limitMs / 1000} s)` : ran.stderr);
  return ran.stdout;
}
test("a runner in a process of its own on the same data folder takes the Settings view's signed-in answer when its two checks time out; one on another data folder does not, and a signed-out answer in the view takes it away", async (t) => {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-shared-"));
  const elsewhere = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-elsewhere-"));
  t.after(() => [data, elsewhere].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const pinned = join(data, "claude");
  writeFileSync(pinned, "", { mode: 0o755 });
  const setting = settingFor("agentrun", data);
  let said = SAID_IN;
  const deps = {
    signIns: { view: () => undefined },
    settings: { get: async (key) => (key === CLAUDE_LOGIN_SETTING ? setting : undefined), put: async () => {}, remove: async () => {} },
    data,
    env: { HOME: data, PATH: "/usr/bin:/bin" },
    pinned: async () => pinned,
    refused: () => undefined,
    sameMachine: false,
    claude: async () => ({ claudeLoginCommand: () => "claude auth login", claudeLoginStatus: async () => said }),
    changed: async () => {},
  };
  const login = loginAt("agentrun", data, deps.env);

  assert.equal((await claudeLoginView(deps)).state, "signed_in");
  assert.equal(runnerCheck(data, login), "went on", "a runner process on the same data folder refused a run right after the Settings view read the login signed in: the answer never reached it");
  assert.ok(runnerCheck(elsewhere, login).startsWith(LOGIN_UNKNOWN), "a runner on another data folder, another machine's, took this one's answer");

  said = SAID_OUT;
  assert.equal((await claudeLoginView(deps)).state, "signed_out");
  assert.ok(runnerCheck(data, login).startsWith(LOGIN_UNKNOWN), "a runner process took a signed-in answer the Settings view had since read signed out");
});

// The answer file is the server's own note: a run's check reads it only as a small regular file at its name (never
// through a link, never a FIFO, which would hold the check's read, and so the server's event loop, for ever), and a
// note keeps the answers folder at 0700 and leaves nothing beside the file when it can't be put in place.
/** A data folder of its own where `login` answered signed in now, and the answers folder and file name that holds it. */
async function noted(t, login) {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-note-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await loginBeforeRun(login, "claude", statusOf(SAID_IN).status, { data });
  const dir = join(data, LOGIN_ANSWERS_DIR);
  const names = readdirSync(dir);
  assert.equal(names.length, 1, `one answer file: ${names}`);
  return { data, dir, name: names[0], file: join(dir, names[0]) };
}

test("a FIFO at the answer file's name holds no run's check: it is no answer, and the run whose checks time out is refused", { skip: process.platform === "win32" ? "no mkfifo" : false }, async (t) => {
  const login = await ownLogin();
  const { data, file } = await noted(t, login);
  rmSync(file);
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
  const said = runnerCheck(data, login, { limitMs: 10_000, held: "a run's check held on a FIFO at the answer file's name, reading it as an answer" });
  assert.ok(said.startsWith(LOGIN_UNKNOWN), said);
});

test("a link, or a file longer than a time, at the answer file's name stands for no answer", async (t) => {
  const login = await ownLogin();
  const { data, file } = await noted(t, login);
  const elsewhere = join(data, "elsewhere");
  writeFileSync(elsewhere, `${Date.now()}\n`);
  rmSync(file);
  symlinkSync(elsewhere, file);
  await assert.rejects(loginBeforeRun(login, "claude", statusOf(timedOut(), timedOut()).status, { data }), unknownByTimeout, "a link at the answer file's name, to a fresh time, stood for a run whose checks timed out");
  rmSync(file);
  writeFileSync(file, `${Date.now()}`.padEnd(4096, " ") + "\n", { mode: 0o600 });
  await assert.rejects(loginBeforeRun(login, "claude", statusOf(timedOut(), timedOut()).status, { data }), unknownByTimeout, "a 4 KiB file at the answer file's name stood for a run whose checks timed out");
});

test("a note keeps the answers folder at 0700: one made wider before is tightened, and a link in its place is not written through", { skip: process.platform === "win32" ? "no modes" : false }, async (t) => {
  const login = await ownLogin();
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-login-note-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const dir = join(data, LOGIN_ANSWERS_DIR);
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  await loginBeforeRun(login, "claude", statusOf(SAID_IN).status, { data });
  assert.equal((statSync(dir).mode & 0o777).toString(8), "700", "an answers folder made 0755 before kept its mode after a note");
  assert.equal(readdirSync(dir).length, 1, "the answer was noted");

  const away = join(data, "away");
  mkdirSync(away, { mode: 0o700 });
  rmSync(dir, { recursive: true });
  symlinkSync(away, dir);
  await loginBeforeRun(login, "claude", statusOf(SAID_IN).status, { data });
  assert.deepEqual(readdirSync(away), [], "a note went through a link at the answers folder's name");
});

test("a note whose file can't be put in place leaves nothing beside it", async (t) => {
  const login = await ownLogin();
  const { dir, name, file } = await noted(t, login);
  rmSync(file);
  mkdirSync(file);
  writeFileSync(join(file, "in-the-way"), "");
  await loginBeforeRun(login, "claude", statusOf(SAID_IN).status, { data: dirname(dir) });
  assert.deepEqual(readdirSync(dir), [name], "a note whose rename failed left the file it wrote aside");
});

test("an answer is this machine's: once the data folder's machine id is another (the file made again), an answer noted under the old id stands for no run, though its file is still there", async (t) => {
  const login = await ownLogin();
  const { data, file } = await noted(t, login);
  await loginBeforeRun(login, "claude", statusOf(timedOut(), timedOut()).status, { data });
  writeFileSync(join(data, "machine-id"), `${"ab".repeat(16)}\n`, { mode: 0o600 });
  assert.ok(existsSync(file), "the answer noted under the old id is still there");
  await assert.rejects(loginBeforeRun(login, "claude", statusOf(timedOut(), timedOut()).status, { data }), unknownByTimeout, "an answer noted under the machine's old id stood after the id changed");
});

test("only a check that gave no answer is asked again or goes on by an earlier signed-in answer: a CLI that is not there, or any other failure, refuses the run at once with LOGIN_UNKNOWN in its own words", async () => {
  const login = await ownLogin();
  const time = clock(1_000_000);
  await loginBeforeRun(login, "claude", statusOf(SAID_IN).status, { data: ANSWERS, now: time.now });
  time.at(60_000);

  const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT", errno: -2, syscall: "spawn claude", path: "claude" });
  const gone = statusOf(missing, SAID_IN);
  await assert.rejects(loginBeforeRun(login, "claude", gone.status, { data: ANSWERS, now: time.now }), (error) => {
    assert.equal(error.message, `${LOGIN_UNKNOWN}: spawn claude ENOENT`);
    return true;
  });
  assert.equal(gone.calls(), 1, "a CLI that is not there: status asked once, and the signed-in answer a minute before does not stand in");

  const broken = statusOf(new Error("EACCES: permission denied, open '.claude.json'"), SAID_IN);
  await assert.rejects(loginBeforeRun(login, "claude", broken.status, { data: ANSWERS, now: time.now }), (error) => {
    assert.equal(error.message, `${LOGIN_UNKNOWN}: EACCES: permission denied, open '.claude.json'`);
    return true;
  });
  assert.equal(broken.calls(), 1, "an error with no code: status asked once");

  // A CLI that answered, in time, nothing that reads as a status gave no answer too, as the harness says by its code.
  const noStatus = () => Object.assign(new Error("the claude CLI gave no login status"), { code: "no_status" });
  const garbled = statusOf(noStatus(), SAID_IN);
  await loginBeforeRun(login, "claude", garbled.status, { data: ANSWERS, now: time.now });
  assert.equal(garbled.calls(), 2, "no status once, then signed in: asked twice, and the run goes on");
  time.at(2 * 60_000);
  const twice = statusOf(noStatus(), noStatus());
  await loginBeforeRun(login, "claude", twice.status, { data: ANSWERS, now: time.now });
  assert.equal(twice.calls(), 2, "no status twice, a minute after a signed-in answer: the run goes on by it");
});
