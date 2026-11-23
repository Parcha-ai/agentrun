// Claude Code's login on this machine (claude-login.ts): claude-agent on a person's own Claude plan, through the CLI that
// holds the login. The server asks that CLI `auth status` and nothing else: a fake CLI stands in for the pinned one here,
// answering the status a test sets and noting each call (its arguments and the variables it got). Its login directory's
// credentials file is a FIFO, which holds any open of it, so a server that read it would hang there. The mode is turned on
// with the owner's word, refused in one line where more than one person can start runs, and gone, routes and all, under
// AGENTRUN_CLAUDE_CODE_LOGIN=off, where claude-agent runs on the model keys as it does without it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import * as claude from "@parcha/agentrun-harness-claude";
import { CLAUDE_LOGIN_ENV, claudeLoginSwitchedOff, envAtPlace, LOGIN_SIGNED_OUT, loginAt, loginForRun, turnOnBody, whyNotOneOwner, withClaudeLogin } from "../dist/claude-login.js";
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
  // The sign-in and every status check asked about the same folder.
  for (const call of fake.calls()) assert.deepEqual([call.argv, call.config, call.secure], [call.argv, login, login]);
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
  assert.equal(loginAt("machine", "/d", { HOME: "/u/p" }).dir, "/u/p/.claude");
  assert.deepEqual(loginAt("machine", "/d", { HOME: "/u/p", CLAUDE_CONFIG_DIR: "/u/p/elsewhere" }), { dir: "/u/p/elsewhere", profiles: "/u/p/.config/anthropic" });
  assert.equal(loginAt("machine", "/d", { HOME: "/u/p", CLAUDE_CONFIG_DIR: "elsewhere" }).dir, "/u/p/.claude", "a relative one is read against a working directory the server does not share");
  assert.equal(loginAt("agentrun", "/d", { HOME: "/u/p", CLAUDE_CONFIG_DIR: "/u/p/elsewhere" }).dir, "/d/claude-login", "AgentRun's own login is in its data");

  const folder = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-config-dir-"));
  const { api, data, fake } = await signInServer(t, "sign", {}, { CLAUDE_CONFIG_DIR: folder });
  const before = (await api("GET", "/settings/claude-login")).body;
  assert.deepEqual(before.machine, { folder, source: "CLAUDE_CONFIG_DIR" }, JSON.stringify(before));
  assert.equal(before.folder, loginAt("agentrun", data).dir);
  const on = (await api("PUT", "/settings/claude-login", { only_me: true, place: "machine" })).body;
  assert.equal(on.place, "machine");
  assert.equal(on.folder, folder);
  assert.ok(on.command.startsWith(`CLAUDE_CONFIG_DIR=${folder} CLAUDE_SECURESTORAGE_CONFIG_DIR=${folder} `), on.command);
  const asked = fake.calls().filter((call) => call.argv === "auth status --json");
  assert.ok(asked.length >= 1);
  for (const call of asked) assert.deepEqual([call.config, call.secure], [folder, folder]);
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
  // variables, which their terminal may export while the server has neither, in a subshell of their own shell.
  assert.equal(on.command, `(unset CLAUDE_CONFIG_DIR CLAUDE_SECURESTORAGE_CONFIG_DIR; ANTHROPIC_CONFIG_DIR=${join(home, ".config", "anthropic")} ${fake.cli} auth login)`);
  const asked = fake.calls().filter((call) => call.argv === "auth status --json");
  assert.ok(asked.length >= 1);
  for (const call of asked) assert.deepEqual([call.configSet, call.secureSet, call.home], ["", "", home], JSON.stringify(call));
  // The login carries the person's home only on the default folder: that is what tells its variables apart.
  assert.deepEqual(loginAt("machine", "/d", { HOME: "/u/p" }), { dir: "/u/p/.claude", profiles: "/u/p/.config/anthropic", home: "/u/p" });
  assert.equal(loginAt("machine", "/d", { HOME: "/u/p", CLAUDE_CONFIG_DIR: "/u/p/elsewhere" }).home, undefined);
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
  const profiles = "/u/p/.config/anthropic";
  const at = (vars) => loginAt("machine", "/d", { HOME: "/u/p", ...vars });
  // The CLI's default folder, its credentials elsewhere.
  const own = at({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/secure" });
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(claude.claudeSignInEnv(own, platform), { HOME: "/u/p", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/secure", ANTHROPIC_CONFIG_DIR: profiles }, platform);
    assert.deepEqual(claude.claudeLoginEnv(own, platform), { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/secure", ANTHROPIC_CONFIG_DIR: profiles }, platform);
  }
  // Set and empty: on macOS empty still (the item with no suffix); elsewhere the folder it means, ~/.claude, absolute,
  // since a status check or a run has a home of its own.
  const empty = at({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
  assert.deepEqual(claude.claudeSignInEnv(empty, "darwin"), { HOME: "/u/p", CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeLoginEnv(empty, "darwin"), { CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeSignInEnv(empty, "linux"), { HOME: "/u/p", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/.claude", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeLoginEnv(empty, "linux"), { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/.claude", ANTHROPIC_CONFIG_DIR: profiles });
  // A CLAUDE_CONFIG_DIR folder: the account there, the credentials where the variable says.
  const folder = at({ CLAUDE_CONFIG_DIR: "/u/p/elsewhere", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/secure" });
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(claude.claudeSignInEnv(folder, platform), { CLAUDE_CONFIG_DIR: "/u/p/elsewhere", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/secure", ANTHROPIC_CONFIG_DIR: profiles }, platform);
    assert.deepEqual(claude.claudeLoginEnv(folder, platform), { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/secure", ANTHROPIC_CONFIG_DIR: profiles }, platform);
  }
  const folderEmpty = at({ CLAUDE_CONFIG_DIR: "/u/p/elsewhere", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
  assert.deepEqual(claude.claudeSignInEnv(folderEmpty, "darwin"), { CLAUDE_CONFIG_DIR: "/u/p/elsewhere", CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeSignInEnv(folderEmpty, "linux"), { CLAUDE_CONFIG_DIR: "/u/p/elsewhere", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/.claude", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(claude.claudeLoginEnv(folderEmpty, "darwin"), { CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_CONFIG_DIR: profiles });
  // A relative one is not taken, as with CLAUDE_CONFIG_DIR; AgentRun's own login never reads it.
  assert.deepEqual(claude.claudeSignInEnv(at({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "secure" }), "linux"), { HOME: "/u/p", ANTHROPIC_CONFIG_DIR: profiles });
  assert.deepEqual(loginAt("agentrun", "/d", { HOME: "/u/p", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/u/p/secure" }), { dir: "/d/claude-login", profiles: "/d/claude-login/anthropic" });

  // A server started with it: the view names it, and the sign-in and every status check keep the tokens there.
  const secure = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "claude-secure-dir-"));
  const { api, fake, home } = await signInServer(t, "sign", {}, { CLAUDE_SECURESTORAGE_CONFIG_DIR: secure });
  const before = (await api("GET", "/settings/claude-login")).body;
  assert.deepEqual(before.machine, { folder: join(home, ".claude"), source: "default", credentials: secure }, JSON.stringify(before));
  const on = (await api("PUT", "/settings/claude-login", { only_me: true, place: "machine" })).body;
  assert.equal(on.state, "signed_out", JSON.stringify(on));
  assert.equal(on.command, `(unset CLAUDE_CONFIG_DIR; CLAUDE_SECURESTORAGE_CONFIG_DIR=${secure} ANTHROPIC_CONFIG_DIR=${join(home, ".config", "anthropic")} ${fake.cli} auth login)`);
  assert.equal((await api("POST", "/settings/claude-login/login")).status, 200);
  await until(() => existsSync(fake.ended), "the CLI's sign-in ended");
  assert.ok(existsSync(join(secure, ".credentials.json")), "the sign-in kept the tokens where the person's own claude with that variable does");
  assert.ok(existsSync(join(home, ".claude.json")), "and the account where it keeps it with no CLAUDE_CONFIG_DIR");
  const view = await signInSettled(api);
  assert.equal(view.state, "signed_in", JSON.stringify(view));
  for (const call of fake.calls()) assert.deepEqual([call.configSet, call.secure, call.home], ["", secure, home], JSON.stringify(call));
});
