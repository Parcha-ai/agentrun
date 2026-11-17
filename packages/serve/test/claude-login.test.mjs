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
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { CLAUDE_LOGIN_ENV, LOGIN_SIGNED_OUT, loginForRun, turnOnBody, whyNotOneOwner, withClaudeLogin } from "../dist/claude-login.js";
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

test("AGENTRUN_CLAUDE_CODE_LOGIN=off: every route is 404 by name and claude-agent runs on the model keys, a saved turn-on notwithstanding", { timeout: 180_000 }, async (t) => {
  withEnv(t, {}, MODEL_VARS);
  const first = await serve(t, { faux: undefined, runner: false });
  assert.equal((await first.api("PUT", "/settings/claude-login", { only_me: true })).status, 200);
  assert.equal((await offerOf(first.api)).available, true);
  await first.stop();

  process.env[CLAUDE_LOGIN_ENV] = "off";
  const { api } = await serve(t, { faux: undefined, data: first.data, runner: false });
  for (const [method, path, name] of OPERATIONS) {
    const answer = await api(method, path, method === "PUT" ? { only_me: true } : undefined);
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.match(answer.body.error.message, new RegExp(`^${name}: `), JSON.stringify(answer.body));
  }
  assert.equal((await offerOf(api)).available, false, "no key: claude-agent runs nothing, the saved turn-on read by no one");

  // A key: claude-agent runs on it.
  const env = withClaudeLogin({ ANTHROPIC_API_KEY: "not-a-secret", [CLAUDE_LOGIN_ENV]: "off" }, { dir: "/nowhere", profiles: "/nowhere/anthropic" });
  const provider = providerFor("anthropic-messages", env, { provider: "anthropic", modelId: "claude-haiku-5-5" }, "claude-agent");
  assert.equal(provider.login, undefined);
  assert.equal(await provider.credential(), "not-a-secret");
  assert.equal(hostModel(env, "default", "claude-agent"), hostModel({ ANTHROPIC_API_KEY: "not-a-secret" }, "default", "claude-agent"));
  assert.equal(await loginForRun({ get: async () => ({ v: 1, place: "agentrun", host: "any", only_me: true }) }, "/data", env, "claude-agent"), undefined);
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
