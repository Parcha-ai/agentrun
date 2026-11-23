// Claude Code's login handed to a run under a user of its own as its access token alone (claude-login-token.ts): the
// runner reads the login's file again at every ask, so a renewal written there by the person's own Claude Code is handed
// at the next ask; a token with less than five minutes left is refused in words that say to open Claude Code once to
// renew it; the runner never posts anything anywhere (no renewal of its own: `renew` is the one seam for one, absent);
// a signed-out login and one in a form the runner does not read are refused in their own words; no value of the file is
// in any error; every value read is held for redaction and told to the claim's watchers. The pinned CLI's own write
// (test/fixtures/credentials-cli-2.1.286.json in the Claude adapter) reads. No key, no network: fake values in scratch
// folders.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Namespaces: a name the module does not export reads as undefined, and its assertion says what is missing.
const tokens = await import("../dist/claude-login-token.js").catch(() => ({}));
const { LOGIN_SIGNED_OUT } = await import("../dist/claude-login.js");
const { hostSecrets } = await import("../dist/secrets.js");

const HOUR = 3_600_000;
const FIXTURE = new URL("../../run-adapters-claude-agent/test/fixtures/credentials-cli-2.1.286.json", import.meta.url);

/** A login folder in scratch, as the CLI keeps AgentRun's own (0700), and a writer of its credentials file. */
function loginFolder(t) {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "login-token-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const dir = join(data, "claude-login");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const login = { dir, profiles: join(dir, "anthropic") };
  const write = (oauth) => writeFileSync(join(dir, ".credentials.json"), JSON.stringify(oauth === undefined ? {} : { claudeAiOauth: oauth }), { mode: 0o600 });
  return { data, login, write };
}
const fake = (what) => `not-a-secret-${what}-${Math.random().toString(36).slice(2, 10)}`;
const oauthOf = (accessToken, expiresAt, refreshToken = fake("refresh")) => ({ accessToken, refreshToken, expiresAt, scopes: ["user:inference"], subscriptionType: null, rateLimitTier: null });

/** globalThis.fetch replaced for the test: every call counted, none answered. */
function noPosts(t) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error("no request leaves a test");
  };
  t.after(() => (globalThis.fetch = real));
  return calls;
}

test("the runner reads the login's file again at every ask: a renewal another process (the person's own Claude Code) wrote there is handed at the next ask, and nothing is posted", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token (claude-login-token.ts LoginTokens)");
  const posts = noPosts(t);
  const { login, write } = loginFolder(t);
  const first = fake("access-a");
  const renewed = fake("access-b");
  write(oauthOf(first, Date.now() + HOUR));
  const reader = new tokens.LoginTokens({ login });
  assert.equal(await reader.token(), first);
  assert.equal(await reader.token(), first, "read again, the same file: the same token");
  // Claude Code, run by the person on this login, renewed it: its own write, a new token and a new end.
  write(oauthOf(renewed, Date.now() + 8 * HOUR));
  assert.equal(await reader.token(), renewed, "the renewal is handed at the next ask, with no restart and no cache");
  assert.deepEqual(posts, [], "the runner posts nothing: no renewal of its own");
});

test("a token with less than five minutes left is refused in words that say to open Claude Code once to renew it, the token in none of them; with more, it is handed; nothing is posted", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const posts = noPosts(t);
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const near = fake("access-near");
  write(oauthOf(near, now + 4 * 60_000));
  const reader = new tokens.LoginTokens({ login, now: () => now });
  await assert.rejects(reader.token(), (error) => {
    assert.equal(error.message, tokens.LOGIN_RUNNING_OUT);
    assert.match(error.message, /less than 5 minutes/);
    assert.match(error.message, /open Claude Code on this login once to renew it/);
    assert.ok(!error.message.includes(near) && !String(error.stack).includes(near), "the token is in no word of the refusal");
    return true;
  });
  write(oauthOf(near, now - 60_000));
  await assert.rejects(reader.token(), { message: tokens.LOGIN_RUNNING_OUT }, "one past its end: the same words");
  write(oauthOf(near, now + 5 * 60_000 + 1_000));
  assert.equal(await reader.token(), near, "more than the margin left: handed");
  assert.equal(tokens.LOGIN_MARGIN_MS, 5 * 60_000, "the pinned CLI's own margin before it calls a token expired");
  assert.deepEqual(posts, [], "the runner posts nothing: no renewal of its own");
});

test("the one seam for a renewal of the runner's own (renew): absent by default; given, it is called under the margin and the file is read again", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const near = fake("access-near");
  const fresh = fake("access-fresh");
  write(oauthOf(near, now + 60_000));
  const renewals = [];
  const reader = new tokens.LoginTokens({ login, now: () => now, renew: async (at) => { renewals.push(at.dir); write(oauthOf(fresh, now + HOUR)); } });
  assert.equal(await reader.token(), fresh, "renewed in its own file, then read again");
  assert.deepEqual(renewals, [login.dir]);
  assert.equal(await reader.token(), fresh);
  assert.equal(renewals.length, 1, "a fresh token asks no renewal");
  // The runner's own reader for a login folder (loginTokensFor) takes no renewal: under the margin it refuses.
  write(oauthOf(near, Date.now() + 60_000));
  await assert.rejects(tokens.loginTokensFor(login).token(), { message: tokens.LOGIN_RUNNING_OUT });
});

test("a signed-out login (no file, no claudeAiOauth, a token the CLI cleared) and one in a form the runner does not read are refused in their own words, never with a value of the file in them", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const file = join(login.dir, ".credentials.json");
  const reader = new tokens.LoginTokens({ login });
  await assert.rejects(reader.token(), { message: LOGIN_SIGNED_OUT }, "no file: signed out");
  write(undefined);
  await assert.rejects(reader.token(), { message: LOGIN_SIGNED_OUT }, "no claudeAiOauth (the CLI's sign-out): signed out");
  write({ accessToken: "", refreshToken: "", expiresAt: 0 });
  await assert.rejects(reader.token(), { message: LOGIN_SIGNED_OUT }, "a token the CLI cleared on a dead refresh token: signed out");
  const kept = fake("kept");
  const sealed = (why, text) => [why, text];
  for (const [why, text] of [
    sealed("not JSON (a sealed or encrypted store)", `sealed:${kept}`),
    sealed("an array", JSON.stringify([kept])),
    sealed("a claudeAiOauth of another shape", JSON.stringify({ claudeAiOauth: kept })),
    sealed("an end that is no number", JSON.stringify({ claudeAiOauth: { accessToken: kept, expiresAt: "soon" } })),
  ]) {
    writeFileSync(file, text, { mode: 0o600 });
    await assert.rejects(reader.token(), (error) => {
      assert.equal(error.message, tokens.LOGIN_SEALED, why);
      assert.match(error.message, /AGENTRUN_RUN_USER=same/);
      assert.match(error.message, /model_key/);
      assert.ok(!String(error.stack).includes(kept), `${why}: no value of the file in the refusal`);
      return true;
    });
  }
  rmSync(file);
  mkdirSync(file);
  await assert.rejects(reader.token(), { message: tokens.LOGIN_SEALED }, "a file the runner cannot read as one");
});

test("every value the runner reads from the login is held for redaction, and each token it hands is told to the claim's watchers", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const access = fake("access-held");
  const refresh = fake("refresh-held");
  write(oauthOf(access, Date.now() + HOUR, refresh));
  const reader = new tokens.LoginTokens({ login });
  const told = [];
  reader.watch((values) => told.push(...values));
  assert.equal(await reader.token(), access);
  assert.deepEqual(told, [access], "the watcher (a claim's redactor) hears the token handed");
  const held = hostSecrets({});
  assert.ok(held.includes(access) && held.includes(refresh), "the access and the refresh token are this process's secrets, cut from what it writes");
});

test("a run's own process holds each token its runner hands before its CLI has it, and with no reader handed it is refused in words, never moved to a model key", async (t) => {
  assert.equal(typeof tokens.heldTokenLogin, "function", "a run's own process wraps its runner's reader (claude-login-token.ts heldTokenLogin)");
  const handed = fake("access-handed");
  const redacted = [];
  const login = tokens.heldTokenLogin({ token: async () => handed }, (values) => redacted.push(...values));
  assert.equal(await login.token(), handed);
  assert.deepEqual(redacted, [handed], "held by the run's redactors");
  assert.ok(hostSecrets({}).includes(handed), "and by this process's own");
  assert.deepEqual(Object.keys(login), ["token"], "a reader alone: no folder, no refresh token");
  assert.throws(() => tokens.heldTokenLogin(undefined, () => {}), (error) => {
    assert.equal(error.message, tokens.LOGIN_NOT_HANDED);
    assert.match(error.message, /AGENTRUN_RUN_USER=same/);
    assert.match(error.message, /model_key/);
    return true;
  });
});

test("the pinned CLI's own write of a login (credentials-cli-2.1.286.json) reads: its access token, to its end", async (t) => {
  // The fixture is the shape Claude Code 2.1.286 writes to .credentials.json in its credentials directory, made by reading
  // the pinned CLI's own write path (no run of it, no real login): its plaintext store's update writes
  // `{ ...existing, claudeAiOauth: { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes,
  // subscriptionType, rateLimitTier, clientId } }` as JSON at mode 0600, `expiresAt` in milliseconds. Every value in it is
  // fake. The Claude adapter's pins test checks the same field list is still in the pinned CLI.
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const written = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const { login } = loginFolder(t);
  writeFileSync(join(login.dir, ".credentials.json"), JSON.stringify(written), { mode: 0o600 });
  const end = written.claudeAiOauth.expiresAt;
  assert.equal(await new tokens.LoginTokens({ login, now: () => end - HOUR }).token(), written.claudeAiOauth.accessToken);
  await assert.rejects(new tokens.LoginTokens({ login, now: () => end - 60_000 }).token(), { message: tokens.LOGIN_RUNNING_OUT });
});

test("a runner says on its data folder, by its name, whether its runs on the login stay in its own process: a file its user alone reads, taken back by a start with users of their own", async (t) => {
  assert.equal(typeof tokens.sayLoginRunner, "function", "a runner says on the data folder how its runs on the login run");
  const { data } = loginFolder(t);
  tokens.sayLoginRunner(data, "host/one runner", "process");
  const said = join(tokens.loginRunnersDir(data), "host_one_runner");
  assert.equal(readFileSync(said, "utf8"), "host/one runner\n", "its name, kept whole in the file whatever the file's name");
  assert.equal(statSync(said).mode & 0o777, 0o600);
  assert.equal(statSync(tokens.loginRunnersDir(data)).mode & 0o777, 0o700);
  const live = (names) => ({ live: async () => names.map((runner) => ({ runner })) });
  assert.equal(await tokens.loginRunnerInProcess(data, live(["host/one runner"])), "host/one runner");
  assert.equal(await tokens.loginRunnerInProcess(data, live([])), undefined, "its row stale: none");
  tokens.sayLoginRunner(data, "host/one runner", "uid");
  assert.equal(await tokens.loginRunnerInProcess(data, live(["host/one runner"])), undefined, "started again with users of their own: none");
  assert.equal(await tokens.loginRunnerInProcess(join(data, "elsewhere"), live(["host/one runner"])), undefined, "no runner said anything on another folder");
});
