// Claude Code's login handed to a run under a user of its own as its access token alone (claude-login-token.ts): the
// runner reads the login's file again at every ask, so a renewal written there by anyone is handed at the next ask, and
// it renews the login itself, with the pinned CLI's own request (the Claude adapter's login-refresh.ts), only at an ask
// with less than five minutes left or after the run's CLI was refused (refused): one post per ask at most, one renewal in
// flight per refresh token, the CLI's own refresh lock across processes with the file read again under it, the answer
// written back atomically to the file it came from alone (mode 0600, every other field kept), and a failure refused in
// the old words that say to open Claude Code once to renew it, never retried. No token, old or new, is in any log line,
// error or stack. A signed-out login and one in a form the runner does not read are refused in their own words; every
// value read is held for redaction and told to the claim's watchers. The pinned CLI's own write
// (test/fixtures/credentials-cli-2.1.286.json in the Claude adapter) reads. No key, no network: fake values in scratch
// folders, and a fake token endpoint on loopback (the renewal's fetch is a seam; the request is sent there, never out).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";
import { stranger } from "./fixtures/stranger.mjs";

// Namespaces: a name the module does not export reads as undefined, and its assertion says what is missing.
const tokens = await import("../dist/claude-login-token.js").catch(() => ({}));
const { LOGIN_SIGNED_OUT } = await import("../dist/claude-login.js");
const { hostSecrets } = await import("../dist/secrets.js");
const { loginRefresh = {} } = await import("@parcha/agentrun-harness-claude/facts").catch(() => ({}));

const HOUR = 3_600_000;
const FIXTURE = new URL("../../run-adapters-claude-agent/test/fixtures/credentials-cli-2.1.286.json", import.meta.url);
/** The real fetch, before any test stubs the global one: what the fake endpoint is reached with. */
const realFetch = globalThis.fetch;

/** `text` as `file`'s whole new content, by a rename, as the CLI's own writer and the runner's do: a reader polling the
 *  file never reads it half written. */
function writeWhole(file, text) {
  const temp = `${file}.test-${Math.random().toString(36).slice(2)}`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

/** A login folder in scratch, as the CLI keeps AgentRun's own (0700), and a writer of its credentials file. */
function loginFolder(t) {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "login-token-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const dir = join(data, "claude-login");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const login = { dir, profiles: join(dir, "anthropic") };
  const write = (oauth) => writeWhole(join(dir, ".credentials.json"), JSON.stringify(oauth === undefined ? {} : { claudeAiOauth: oauth }));
  return { data, login, write };
}
const fake = (what) => `not-a-secret-${what}-${Math.random().toString(36).slice(2, 10)}`;
const oauthOf = (accessToken, expiresAt, refreshToken = fake("refresh")) => ({ accessToken, refreshToken, expiresAt, scopes: ["user:inference"], subscriptionType: null, rateLimitTier: null });
const listing = (dir) => readdirSync(dir).sort();

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

/** A fake token endpoint on loopback, answering each post with `answer(post, count)` ({ status, json } or { status,
 *  text }, and any more `headers`); `fetch` is the renewal's seam, which sends the request there whatever URL it names.
 *  `asked`: the URLs the renewal named; `posts`: what reached the endpoint. */
async function tokenEndpoint(t, answer) {
  const posts = [];
  const server = createServer((request, response) => {
    // A probe of the loopback port (a bare GET /) is no post of the renewal's: never parsed or counted.
    if (stranger(request, response)) return;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      const post = { method: request.method, path: request.url, headers: request.headers, body: JSON.parse(body) };
      posts.push(post);
      const { status = 200, json, text, headers = {} } = await answer(post, posts.length);
      response.writeHead(status, { "content-type": json === undefined ? "text/plain" : "application/json", ...headers });
      response.end(json === undefined ? (text ?? "") : JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const { port } = server.address();
  const asked = [];
  const fetch = (url, init) => {
    asked.push(String(url));
    return realFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);
  };
  return { posts, asked, fetch };
}

/** Waits until `ready()` holds, 5 s at most. */
async function until(ready, what) {
  for (let waited = 0; !ready(); waited += 20) {
    if (waited > 5_000) assert.fail(`waited 5 s for ${what}`);
    await sleep(20);
  }
}

/** Every file under `dir`, by its path from `dir`, to its content's hash: what a renewal may have made or changed. */
function snapshot(dir) {
  const files = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        files[`${relative(dir, path)}/`] = "dir";
        walk(path);
      } else files[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return files;
}

test("the runner reads the login's file again at every ask: a renewal another process (the person's own Claude Code) wrote there is handed at the next ask, and a fresh token is never renewed: nothing is posted", async (t) => {
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
  assert.deepEqual(posts, [], "a token with more than the margin left is never renewed: nothing is posted");
});

test("a token with less than five minutes left that the runner could not renew is refused in words that say to open Claude Code once to renew it, the token in none of them (nor the renewal's own words); with more, it is handed and nothing is renewed", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const posts = noPosts(t);
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const near = fake("access-near");
  write(oauthOf(near, now + 4 * 60_000));
  const renewals = [];
  const reader = new tokens.LoginTokens({ login, now: () => now, renew: async (_, seen) => {
    renewals.push(seen);
    throw new Error(`a renewal that failed, saying ${seen}`);
  } });
  await assert.rejects(reader.token(), (error) => {
    assert.equal(error.message, tokens.LOGIN_RUNNING_OUT);
    assert.match(error.message, /less than 5 minutes/);
    assert.match(error.message, /could not renew it/);
    assert.match(error.message, /open Claude Code on this login once to renew it/);
    assert.ok(!error.message.includes(near) && !String(error.stack).includes(near), "the token is in no word of the refusal");
    return true;
  });
  write(oauthOf(near, now - 60_000));
  await assert.rejects(reader.token(), { message: tokens.LOGIN_RUNNING_OUT }, "one past its end: the same words");
  assert.deepEqual(renewals, [near, near], "one renewal asked per ask, never a second within one");
  write(oauthOf(near, now + 5 * 60_000 + 1_000));
  assert.equal(await reader.token(), near, "more than the margin left: handed");
  assert.equal(renewals.length, 2, "and not renewed");
  assert.equal(tokens.LOGIN_MARGIN_MS, 5 * 60_000, "the pinned CLI's own margin before it calls a token expired");
  assert.deepEqual(posts, [], "the seam given, nothing else posts");
});

test("the renewal is one seam (renew): given, it is called under the margin with the login and the token read, then the file is read again; by default, the runner's own reader (loginTokensFor) renews with the pinned CLI's request", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const near = fake("access-near");
  const fresh = fake("access-fresh");
  write(oauthOf(near, now + 60_000));
  const renewals = [];
  const reader = new tokens.LoginTokens({ login, now: () => now, renew: async (at, seen) => { renewals.push([at.dir, seen]); write(oauthOf(fresh, now + HOUR)); } });
  assert.equal(await reader.token(), fresh, "renewed in its own file, then read again");
  assert.deepEqual(renewals, [[login.dir, near]]);
  assert.equal(await reader.token(), fresh);
  assert.equal(renewals.length, 1, "a fresh token asks no renewal");
  // The runner's own reader for a login folder (loginTokensFor): the pinned CLI's renewal, on the global fetch.
  const answered = fake("access-answered");
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ access_token: answered, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => (globalThis.fetch = real));
  const refresh = fake("refresh-default");
  write(oauthOf(near, Date.now() + 60_000, refresh));
  assert.equal(await tokens.loginTokensFor(login).token(), answered, "renewed, not refused");
  assert.deepEqual(calls.map(({ url, body }) => [url, body.grant_type, body.refresh_token]), [[loginRefresh.tokenUrl, "refresh_token", refresh]]);
});

test("under the margin an ask renews the login with the pinned CLI's own request (its token URL, its client id, the file's refresh token and scopes, as JSON), writes the answer back to the same file by a rename at mode 0600 with every other field kept, and hands the new token", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { data, login } = loginFolder(t);
  const now = 1_900_000_000_000;
  const file = join(login.dir, ".credentials.json");
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  const kept = { mcpOAuth: { server: { note: "kept as it was" } }, claudeAiOauth: { ...oauthOf(old.access, now + 60_000, old.refresh), refreshTokenExpiresAt: now + 30 * 24 * HOUR, subscriptionType: "max", rateLimitTier: "tier-kept", extra: "kept" }, other: 7 };
  writeWhole(file, JSON.stringify(kept));
  const before = { inode: statSync(file).ino, folder: listing(login.dir), data: listing(data) };
  const endpoint = await tokenEndpoint(t, () => ({ json: { access_token: next.access, refresh_token: next.refresh, expires_in: 28_800, scope: "user:inference user:profile" } }));
  const reader = new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch });
  assert.equal(await reader.token(), next.access, "the renewed token is handed");
  assert.equal(endpoint.posts.length, 1, "one post");
  assert.deepEqual(endpoint.asked, [loginRefresh.tokenUrl], "to the pinned CLI's token URL");
  const [post] = endpoint.posts;
  assert.equal(post.method, "POST");
  assert.equal(post.path, "/v1/oauth/token");
  assert.match(post.headers["content-type"], /^application\/json\b/);
  assert.deepEqual(post.body, { grant_type: "refresh_token", refresh_token: old.refresh, client_id: loginRefresh.clientId, scope: "user:inference" }, "the CLI's body: its client id where the login names none, the login's own scopes");
  const after = statSync(file);
  assert.equal(after.mode & 0o777, 0o600, "the file's mode stays 0600");
  assert.notEqual(after.ino, before.inode, "replaced by a rename, never written in place");
  assert.deepEqual(listing(login.dir), before.folder, "no temp file and no lock left in the login folder");
  assert.deepEqual(listing(data), before.data, "nor beside it (the CLI's older lock)");
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual({ ...written, claudeAiOauth: null }, { ...kept, claudeAiOauth: null }, "every other field of the file as it was");
  const { accessToken, refreshToken, expiresAt, scopes, ...rest } = written.claudeAiOauth;
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, scopes: _s, ...restBefore } = kept.claudeAiOauth;
  assert.deepEqual(rest, restBefore, "every field of the login the answer does not give, as it was");
  assert.deepEqual([accessToken, refreshToken, expiresAt, scopes], [next.access, next.refresh, now + 28_800_000, ["user:inference", "user:profile"]], "the answer's token, refresh token, end (its expires_in from now) and scopes");
  assert.equal(await reader.token(), next.access, "read again: the renewed file, no second post");
  assert.equal(endpoint.posts.length, 1);
  const held = hostSecrets({});
  assert.ok(held.includes(next.access) && held.includes(next.refresh), "the answer's tokens are held for redaction");
});

test("a renewal writes only the login's own file: no other file in the login folder, beside it or anywhere in the data folder is made or changed, and no temp file or lock is left", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { data, login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  mkdirSync(join(login.dir, "anthropic"));
  writeFileSync(join(login.dir, "anthropic", "profile.json"), "{\"profile\":1}");
  writeFileSync(join(login.dir, "settings.json"), "{\"theme\":\"dark\"}");
  writeFileSync(join(data, "other.txt"), "beside the folder");
  write(oauthOf(fake("access-old"), now + 60_000));
  const before = snapshot(data);
  const fresh = fake("access-new");
  const endpoint = await tokenEndpoint(t, () => ({ json: { access_token: fresh, expires_in: 3600 } }));
  assert.equal(await new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch }).token(), fresh);
  const after = snapshot(data);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort();
  assert.deepEqual(changed, ["claude-login/.credentials.json"], "the login's own file alone");
});

test("two asks under the margin at once post one renewal (one in flight per refresh token, a second reader in this process included), and every ask hands its token", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  write(oauthOf(fake("access-old"), now + 60_000));
  const fresh = fake("access-new");
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  const endpoint = await tokenEndpoint(t, async () => {
    await answered;
    return { json: { access_token: fresh, expires_in: 3600 } };
  });
  const one = new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch });
  const other = new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch });
  const asks = [one.token(), one.token(), other.token()];
  for (const ask of asks) ask.catch(() => undefined);
  await until(() => endpoint.posts.length === 1, "the renewal's post");
  await sleep(200);
  answer();
  assert.deepEqual(await Promise.all(asks), [fresh, fresh, fresh]);
  assert.equal(endpoint.posts.length, 1, "one post for three asks");
});

test("across processes the renewer holds the pinned CLI's refresh lock: while another holder has it, an ask posts nothing, leaves that lock alone and takes the token that holder writes; a lock a dead holder left (older than 60 s) is taken over", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const lock = join(login.dir, ".oauth_refresh.lock");
  write(oauthOf(fake("access-old"), now + 60_000));
  const mine = fake("access-mine");
  const endpoint = await tokenEndpoint(t, () => ({ json: { access_token: mine, expires_in: 3600 } }));
  const reader = new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch });
  // Another process (the CLI on this login, or another runner) holds the lock: it renews now.
  mkdirSync(lock);
  const asked = reader.token();
  // Awaited below; a refusal while it waits is that assertion's, never an unhandled rejection.
  asked.catch(() => undefined);
  await sleep(600);
  assert.equal(endpoint.posts.length, 0, "no post while another holder has the lock");
  assert.ok(existsSync(lock), "its lock is left alone");
  const theirs = fake("access-theirs");
  write(oauthOf(theirs, now + 8 * HOUR, fake("refresh-theirs")));
  rmSync(lock, { recursive: true });
  assert.equal(await asked, theirs, "the token the holder renewed is handed");
  assert.equal(endpoint.posts.length, 0, "and nothing was posted");
  // A dead holder's lock: older than the CLI's stale limit, so it is taken over.
  write(oauthOf(fake("access-old-2"), now + 60_000));
  mkdirSync(lock);
  const long = new Date(Date.now() - 61_000);
  utimesSync(lock, long, long);
  assert.equal(await reader.token(), mine, "renewed under the lock taken over");
  assert.equal(endpoint.posts.length, 1);
  assert.ok(!existsSync(lock), "released after");
});

/** A fake token endpoint that answers as Anthropic does a rotating refresh token: each refresh token it took once is
 *  spent, and posted again it is refused (400 invalid_grant); `pairs` answers each first post, by the token posted. */
async function rotatingEndpoint(t, pairs) {
  const taken = new Set();
  return tokenEndpoint(t, (post) => {
    const sent = post.body.refresh_token;
    if (taken.has(sent) || !pairs.has(sent)) return { status: 400, json: { error: "invalid_grant" } };
    taken.add(sent);
    const { access, refresh } = pairs.get(sent);
    return { json: { access_token: access, refresh_token: refresh, expires_in: 3600 } };
  });
}

test("a renewal whose save fails keeps the new pair in memory: the next ask posts nothing and is handed the new token, each ask tries the save again and one with a working disk writes the pair back (0600, by a rename), and the spent refresh token is never posted again", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { data, login } = loginFolder(t);
  const start = 1_900_000_000_000;
  let clock = start;
  const file = join(login.dir, ".credentials.json");
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  const third = { access: fake("access-third"), refresh: fake("refresh-third") };
  const oldText = JSON.stringify({ claudeAiOauth: oauthOf(old.access, start + 60_000, old.refresh) });
  // The login's file reached through a link: the runner reads it, and never replaces a file that is no plain file
  // (replaceFile), so the save fails at its first step, as one on a full disk fails at its write.
  const elsewhere = join(data, "credentials-elsewhere.json");
  writeFileSync(elsewhere, oldText, { mode: 0o600 });
  symlinkSync(elsewhere, file);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next], [next.refresh, third]]));
  const reader = new tokens.LoginTokens({ login, now: () => clock, fetch: endpoint.fetch });
  assert.equal(await reader.token(), next.access, "renewed: the new token is handed, though its save failed");
  assert.equal(endpoint.posts.length, 1);
  assert.equal(readFileSync(elsewhere, "utf8"), oldText, "the save failed: the file still holds the old pair");
  // The next ask finds the old pair in the file, its refresh token spent: the pair held in memory is handed.
  assert.equal(await reader.token(), next.access, "the next ask is handed the new token, held in memory");
  assert.equal(endpoint.posts.length, 1, "and posts nothing: the spent refresh token is never sent again");
  assert.equal(await new tokens.LoginTokens({ login, now: () => clock, fetch: endpoint.fetch }).token(), next.access, "another reader in this process: the same");
  assert.equal(endpoint.posts.length, 1);
  assert.equal(readFileSync(elsewhere, "utf8"), oldText, "each ask tried the save again, and it still failed");
  // The disk works again: the link is a plain file now, still holding the old pair. The next ask saves the held pair.
  rmSync(file);
  writeWhole(file, oldText);
  const inode = statSync(file).ino;
  assert.equal(await reader.token(), next.access);
  assert.equal(endpoint.posts.length, 1, "the save posts nothing");
  const saved = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
  assert.deepEqual([saved.accessToken, saved.refreshToken, saved.expiresAt], [next.access, next.refresh, start + 3_600_000], "the held pair written back, its end as its answer gave it");
  assert.equal(statSync(file).mode & 0o777, 0o600, "at mode 0600");
  assert.notEqual(statSync(file).ino, inode, "replaced by a rename, never written in place");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no temp file or lock left");
  // Saved: near its end, the saved pair is renewed as any other, its refresh token posted once.
  clock = start + 3_600_000 - 60_000;
  assert.equal(await reader.token(), third.access);
  assert.deepEqual(endpoint.posts.map((post) => post.body.refresh_token), [old.refresh, next.refresh], "each refresh token posted once, the spent one never again");
});

test("a held pair whose save keeps failing is handed until its own token nears its end, then the ask is refused in words that say the renewal could not be saved and what to do, the token in none of them; nothing is posted and nothing retries", async (t) => {
  assert.equal(typeof tokens.LOGIN_NOT_SAVED, "string", "a held pair near its end, never saved, has words of its own");
  const { data, login } = loginFolder(t);
  const start = 1_900_000_000_000;
  let clock = start;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  const elsewhere = join(data, "credentials-elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify({ claudeAiOauth: oauthOf(old.access, start + 60_000, old.refresh) }), { mode: 0o600 });
  symlinkSync(elsewhere, join(login.dir, ".credentials.json"));
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  const reader = new tokens.LoginTokens({ login, now: () => clock, fetch: endpoint.fetch });
  assert.equal(await reader.token(), next.access);
  clock = start + 30 * 60_000;
  assert.equal(await reader.token(), next.access, "half an hour on, still unsaved: the held token, with its time left");
  // Its own token within the margin, still unsaved: refused, in its own words.
  clock = start + 3_600_000 - 4 * 60_000;
  for (const ask of ["first", "second"]) {
    await assert.rejects(reader.token(), (error) => {
      assert.equal(error.message, tokens.LOGIN_NOT_SAVED, ask);
      assert.match(error.message, /could not save/);
      assert.match(error.message, /Settings → Model keys/);
      for (const value of [...Object.values(old), ...Object.values(next)]) assert.ok(!String(error.stack).includes(value), `${ask}: no token in the refusal`);
      return true;
    });
  }
  assert.equal(endpoint.posts.length, 1, "nothing posted after the one renewal: no loop, the spent refresh token never again");
});

test("a held pair's save takes its turn with renewals: it reads the file again under the CLI's refresh lock, so a newer pair another holder (the CLI, or a renewal of this process) wrote after an earlier read is never overwritten with the held one, whose refresh token is spent", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { data, login } = loginFolder(t);
  const start = 1_900_000_000_000;
  const file = join(login.dir, ".credentials.json");
  const lock = join(login.dir, ".oauth_refresh.lock");
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  const newer = { access: fake("access-newer"), refresh: fake("refresh-newer") };
  const oldText = JSON.stringify({ claudeAiOauth: oauthOf(old.access, start + 60_000, old.refresh) });
  const newerText = JSON.stringify({ claudeAiOauth: oauthOf(newer.access, start + 8 * HOUR, newer.refresh) });
  // The save fails first (the file reached through a link, which replaceFile never replaces): the renewed pair is held.
  const elsewhere = join(data, "credentials-elsewhere.json");
  writeFileSync(elsewhere, oldText, { mode: 0o600 });
  symlinkSync(elsewhere, file);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  const reader = new tokens.LoginTokens({ login, now: () => start, fetch: endpoint.fetch });
  assert.equal(await reader.token(), next.access, "renewed, its save failed: the pair is held in memory");
  // The disk works again. For the next ask the file is a named pipe: each read of it waits until the test writes the
  // old pair into it, so the test acts at a known point of the ask, with no timer.
  rmSync(file);
  execFileSync("mkfifo", [file]);
  const asked = reader.token();
  asked.catch(() => undefined);
  // The ask's own read of the token. A new pipe takes the name before that read ends, so the next read waits too.
  const first = await fsp.open(file, "w");
  await first.writeFile(oldText);
  rmSync(file);
  execFileSync("mkfifo", [file]);
  await first.close();
  // The held save's read is open. Another holder renews the login now, as the CLI does: only while it holds the
  // refresh lock. Either way the file is a plain one again before the save's read ends.
  const second = await fsp.open(file, "w");
  let free = true;
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    free = false;
  }
  writeWhole(file, free ? newerText : oldText);
  if (free) rmSync(lock, { recursive: true });
  await second.writeFile(oldText);
  await second.close();
  assert.equal(await asked, next.access, "the held token is handed");
  if (!free) {
    // The save held the lock while it read: the other holder renews once the lock is its own, from the saved pair.
    mkdirSync(lock);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).claudeAiOauth.refreshToken, next.refresh, "the held pair was saved under the lock");
    writeWhole(file, newerText);
    rmSync(lock, { recursive: true });
  }
  const kept = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
  assert.deepEqual([kept.accessToken, kept.refreshToken], [newer.access, newer.refresh], "the newer pair on disk is kept: a held save never writes over a pair another holder wrote after its read");
  assert.equal(await reader.token(), newer.access, "and it is handed");
  assert.equal(endpoint.posts.length, 1, "nothing posted after the one renewal");
});

test("a held token Anthropic refused is never handed again: unsaved, the ask is refused in LOGIN_REFUSED_NOT_RENEWED's words; once the disk works and the held pair is saved, the next ask renews from the saved pair, its refresh token posted once, and hands the new token", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { data, login } = loginFolder(t);
  const start = 1_900_000_000_000;
  const file = join(login.dir, ".credentials.json");
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  const third = { access: fake("access-third"), refresh: fake("refresh-third") };
  const oldText = JSON.stringify({ claudeAiOauth: oauthOf(old.access, start + 60_000, old.refresh) });
  const elsewhere = join(data, "credentials-elsewhere.json");
  writeFileSync(elsewhere, oldText, { mode: 0o600 });
  symlinkSync(elsewhere, file);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next], [next.refresh, third]]));
  const reader = new tokens.LoginTokens({ login, now: () => start, fetch: endpoint.fetch });
  assert.equal(await reader.token(), next.access, "renewed, its save failed: the pair is held in memory");
  // The run's CLI is refused the held token (a 401), with most of its hour left.
  await reader.refused(next.access);
  await assert.rejects(reader.token(), { message: tokens.LOGIN_REFUSED_NOT_RENEWED }, "unsaved, the held refresh token is not the file's: refused, never handed again");
  assert.equal(endpoint.posts.length, 1, "and nothing posted");
  // The disk works again, the file still holding the old pair: the next ask saves the held pair and renews from it.
  rmSync(file);
  writeWhole(file, oldText);
  assert.equal(await reader.token(), third.access, "the refusal honoured: renewed from the saved pair, the refused token never handed");
  assert.deepEqual(endpoint.posts.map((post) => post.body.refresh_token), [old.refresh, next.refresh], "each refresh token posted once");
  const saved = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
  assert.deepEqual([saved.accessToken, saved.refreshToken], [third.access, third.refresh], "the renewal written back");
});

/** `lock` taken over as another runner takes a stale one (proper-lockfile): removed, made again, its mtime the new
 *  holder's own (`at`). */
function takeOver(lock, at) {
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(lock);
  utimesSync(lock, at, at);
}

test("a holder whose locks are taken over while its post is out (paused past the 60 s stale time) neither touches nor removes the new holder's locks, and writes its answer back by the pinned CLI's own check, as the CLI does after a compromised lock", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const locks = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  const endpoint = await tokenEndpoint(t, async () => {
    await answered;
    return { json: { access_token: next.access, refresh_token: next.refresh, expires_in: 3600 } };
  });
  const asked = new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch }).token();
  asked.catch(() => undefined);
  await until(() => endpoint.posts.length === 1, "the old holder's post");
  assert.ok(locks.every((lock) => existsSync(lock)), "the old holder holds both locks while it posts");
  // Another runner finds both stale (the old holder paused past 60 s) and takes them over. Its mtime is a whole second
  // away from any the old holder set, so a filesystem that keeps seconds alone still tells them apart.
  const taken = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2_000);
  for (const lock of locks) takeOver(lock, taken);
  answer();
  assert.equal(await asked, next.access, "the answer is handed");
  assert.equal(endpoint.posts.length, 1);
  for (const [lock, where] of [[locks[0], "in the folder"], [locks[1], "beside it"]]) {
    assert.ok(existsSync(lock), `the new holder's lock ${where} is not removed`);
    assert.equal(statSync(lock).mtimeMs, taken.getTime(), `the new holder's lock ${where} is not touched`);
  }
  const saved = JSON.parse(readFileSync(join(login.dir, ".credentials.json"), "utf8")).claudeAiOauth;
  assert.deepEqual([saved.accessToken, saved.refreshToken], [next.access, next.refresh], "written back without the lock, by the CLI's own check (the file still held the refresh token posted)");
});

test("a holder whose locks are taken over before its post (paused past the 60 s stale time) never posts, and neither touches nor removes the new holder's locks: its heartbeat finds the lock another's and stops, its release leaves both, and the ask waits for the new holder as for any other", async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  write(oauthOf(fake("access-old"), now + 60_000));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const endpoint = await tokenEndpoint(t, () => ({ json: { access_token: fake("access-new"), expires_in: 3600 } }));
  const taken = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2_000);
  let takenOver = false;
  let heartbeats = 0;
  /** What the old holder did to a lock once it was another's: a touch or a removal. */
  const after = [];
  // The renewal's lock operations (its file ops seam), each the real one. The old holder pauses as it sets its mtime on
  // the second lock, holding both: another runner takes both over then, and the pause lasts until the old holder's
  // heartbeat has read its first lock again.
  const lockFs = {
    mkdir: (path) => fsp.mkdir(path),
    stat: (path) => {
      if (takenOver && path === current) heartbeats += 1;
      return fsp.stat(path);
    },
    utimes: async (path, atime, mtime) => {
      if (takenOver) {
        // A touch of either lock counts; the takeover mark beside each is set at every try and is no lock.
        if (path === current || path === legacy) after.push(["touch", path]);
        return fsp.utimes(path, atime, mtime);
      }
      await fsp.utimes(path, atime, mtime);
      if (path !== legacy) return;
      takeOver(current, taken);
      takeOver(legacy, taken);
      takenOver = true;
      await until(() => heartbeats >= 1, "the old holder's heartbeat after the takeover");
    },
    // A removal of either lock counts; anything else the holder removes beside them is no lock.
    rm: (path, options) => {
      if (takenOver && (path === current || path === legacy)) after.push(["remove", path]);
      return fsp.rm(path, options);
    },
  };
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 100, lockWaitMs: 600 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(endpoint.posts.length, 0, "the old holder never posts once its locks are another's");
  assert.equal(takenOver, true, "the old holder held both locks and was taken over");
  assert.deepEqual(after, [], "the old holder neither touched nor removed a lock once it was another's");
  for (const lock of [current, legacy]) {
    assert.ok(existsSync(lock), "the new holder's lock is there");
    assert.equal(statSync(lock).mtimeMs, taken.getTime(), "with its own mtime");
  }
  assert.equal(outcome.error?.message, tokens.LOGIN_RUNNING_OUT, "the new holder kept its locks past the wait and wrote nothing: the ask is refused in words, having posted nothing");
});

test("a holder never marks its own live lock lost: the check after its post and its heartbeat's read and touch of the lock never cross, so no lock_lost is said and both locks are released, none left for the 60 s stale time", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  // The wall clock the locks are timed on, the test's: it moves 5 s once the post is out, as between two of the CLI's
  // own beats, so the heartbeat's mtime is 5 s past the one the holder set at the lock's acquisition.
  const wall = Date.now();
  let clock = wall;
  t.mock.method(Date, "now", () => clock);
  // The heartbeat's first touch of the folder's lock on the moved clock: made on disk, then held before the holder takes
  // it as its own mtime, until the test lets it go (or, if the check after the post reads the lock meanwhile, until
  // that read is done and compared).
  let entered;
  const touched = new Promise((resolve) => (entered = resolve));
  let release;
  const touchHeld = new Promise((resolve) => (release = resolve));
  let gated = false;
  let holding = false;
  let crossed = false;
  const lockFs = {
    mkdir: (path) => fsp.mkdir(path),
    stat: async (path) => {
      if (!holding || path !== current) return fsp.stat(path);
      crossed = true;
      const read = await fsp.stat(path);
      setImmediate(release);
      return read;
    },
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      if (path !== current || mtime.getTime() === wall || gated) return;
      gated = true;
      holding = true;
      entered();
      await touchHeld;
      holding = false;
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  const posts = [];
  // The renewal's fetch, the test's own: no socket and no timer between its answer and the check after the post.
  const fetch = async (url, init) => {
    posts.push(JSON.parse(init.body));
    clock = wall + 5_000;
    await answered;
    return { status: 200, json: async () => ({ access_token: next.access, refresh_token: next.refresh, expires_in: 3600 }) };
  };
  const lines = [];
  const renew = tokens.renewLogin({ fetch, now: () => now, log: (fields) => lines.push(fields), lockFs, lockUpdateMs: 20 });
  const asked = new tokens.LoginTokens({ login, now: () => now, renew }).token();
  asked.catch(() => undefined);
  await touched;
  answer();
  // One turn on, a check that does not wait for the heartbeat has read the lock (and lets the touch go itself once it
  // has compared); one that waits has not, and the touch is let go here.
  await new Promise((resolve) => setImmediate(resolve));
  if (!crossed) release();
  assert.equal(await asked, next.access, "the answer is handed");
  assert.equal(posts.length, 1);
  assert.deepEqual(lines.filter((fields) => fields.claude_login === "lock_lost"), [], "a holder never marks its own live lock lost: its check after the post never reads the lock mid-heartbeat");
  assert.ok(!existsSync(current), "its lock in the folder is released, never left behind for the 60 s stale time");
  assert.ok(!existsSync(legacy), "its lock beside the folder is released");
  const saved = JSON.parse(readFileSync(join(login.dir, ".credentials.json"), "utf8")).claudeAiOauth;
  assert.deepEqual([saved.accessToken, saved.refreshToken], [next.access, next.refresh], "the answer written back");
});

/** A point in a test: one runner's lock step waits on `reached`, and another's step calls `reach`. */
function point() {
  let reach;
  const reached = new Promise((resolve) => (reach = resolve));
  return { reach, reached };
}

/** A mkdir refused as in a folder its holder may not write: the older lock beside the login's folder cannot be made
 *  there, and every holder goes on with the lock in the folder alone, as the pinned CLI does. */
const notWritable = (path) => Promise.reject(Object.assign(new Error(`EACCES: permission denied, mkdir '${path}'`), { code: "EACCES" }));

test("two runners that take one stale lock over at once never both hold it: the runner whose new lock the other's delayed removal took finds it another's and never posts, so the login's refresh token is posted once and both hand the one renewal", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  // The second runner as another process: the module loaded again, with its own renewals in flight and its own memory.
  const second = await import("../dist/claude-login-token.js?second-runner").catch(() => ({}));
  assert.equal(typeof second.renewLogin, "function", "a second runner's renewal");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  // The wall clock the locks are timed on, the test's. A dead holder's lock, past the 60 s stale time.
  const wall = Date.now();
  let clock = wall;
  t.mock.method(Date, "now", () => clock);
  mkdirSync(current);
  const dead = new Date(wall - 61_000);
  utimesSync(current, dead, dead);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // Runner A reads the dead lock first, and B starts once A is at its removal. B reads the dead lock too, unless it is
  // kept out of the lock while A takes it over: then each step below that waits for B goes on once B is kept out.
  // Otherwise A removes the dead lock only once B is at its own removal; B's removal waits until A has made its lock,
  // set its mtime and gone on to the older lock, then removes A's new lock, and B makes its own 200 ms later on the
  // clock: within the second the old check took for one holder's mtime. A reads its lock again (its check before the
  // post) only once B holds its own.
  const aAtRemoval = point();
  const bAtRemoval = point();
  const aHolds = point();
  const bHolds = point();
  const bKeptOut = point();
  let aRemoved = false;
  let bRemoved = false;
  let bStarted = false;
  let keptOut = false;
  let aHeld = false;
  const lockFsA = {
    mkdir: (path) => {
      if (path !== legacy) return fsp.mkdir(path);
      aHeld = true;
      clock = wall + 200;
      aHolds.reach();
      return notWritable(path);
    },
    stat: async (path) => {
      if (aHeld && path === current) await Promise.race([bHolds.reached, bKeptOut.reached]);
      return fsp.stat(path);
    },
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: async (path, options) => {
      if (path === current && !aRemoved) {
        aRemoved = true;
        aAtRemoval.reach();
        await Promise.race([bAtRemoval.reached, bKeptOut.reached]);
      }
      return fsp.rm(path, options);
    },
  };
  const lockFsB = {
    mkdir: async (path) => {
      if (!bStarted) {
        bStarted = true;
        await aAtRemoval.reached;
      }
      if (path === legacy) {
        bHolds.reach();
        return notWritable(path);
      }
      try {
        return await fsp.mkdir(path);
      } catch (error) {
        // Refused anything but the lock itself, as it is there: kept out while another runner takes the lock over.
        if (path !== current && error.code === "EEXIST") {
          keptOut = true;
          bKeptOut.reach();
        }
        throw error;
      }
    },
    stat: (path) => fsp.stat(path),
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: async (path, options) => {
      if (path === current && !bRemoved) {
        bRemoved = true;
        bAtRemoval.reach();
        await aHolds.reached;
      }
      return fsp.rm(path, options);
    },
  };
  const ask = (module, lockFs) => {
    const renew = module.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 60_000 });
    return new module.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  };
  const [a, b] = await Promise.all([ask(tokens, lockFsA), ask(second, lockFsB)]);
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "the login's refresh token is posted once: two runners that took one stale lock over at once never both hold it");
  assert.equal(aRemoved, true, "A found the lock dead and removed it");
  assert.ok(bRemoved || keptOut, "B found it dead too: it removed one after A had made its own, or it was kept out of the lock while A took it over");
  assert.deepEqual([a.token, b.token], [next.access, next.access], "both hand the one renewal");
  assert.ok(!existsSync(current), "the lock is released, none left for the 60 s stale time");
});

test("a runner takes a stale lock over only while it is the lock it inspected: one another holder (the CLI) made in its place since is never removed, and the refresh token that holder posted is never posted again", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  mkdirSync(current);
  const dead = new Date(Date.now() - 61_000);
  utimesSync(current, dead, dead);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // The CLI's lock, made in the dead one's place: a whole second away from any mtime the runner sets.
  const theirs = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2_000);
  let inspected = false;
  let theyHold = false;
  let decide;
  /** What the runner did once the lock it read was replaced: "waits" (it found the CLI's and left it) or "removed". */
  const decided = new Promise((resolve) => (decide = resolve));
  const lockFs = {
    mkdir: async (path) => {
      if (path === legacy) return notWritable(path);
      try {
        return await fsp.mkdir(path);
      } catch (error) {
        if (inspected && error.code === "EEXIST") decide("waits");
        throw error;
      }
    },
    // The runner's first read of the dead lock. Once it is read, and before the runner acts on it, the CLI takes that
    // lock over as dead too (removed, made again, its own mtime set) and posts the login's refresh token under it.
    stat: async (path) => {
      const read = await fsp.stat(path);
      if (path === current && !inspected) {
        inspected = true;
        takeOver(current, theirs);
        theyHold = true;
        const response = await endpoint.fetch(loginRefresh.tokenUrl ?? "https://token.invalid/v1/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: old.refresh }) });
        await response.json();
      }
      return read;
    },
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: async (path, options) => {
      await fsp.rm(path, options);
      if (path === current && theyHold) decide("removed");
    },
  };
  /** The CLI writes its renewal back, then releases its lock while it is still its own. */
  const theyWrite = () => {
    write(oauthOf(next.access, now + 8 * HOUR, next.refresh));
    if (existsSync(current) && statSync(current).mtimeMs === theirs.getTime()) rmSync(current, { recursive: true });
  };
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 60_000 });
  const asked = new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  const how = await decided;
  const kept = existsSync(current) && statSync(current).mtimeMs === theirs.getTime();
  // A runner that waits takes the CLI's write when it lands; one that took the lock posts before the CLI writes.
  if (how === "waits") theyWrite();
  const outcome = await asked;
  if (how !== "waits") theyWrite();
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "the login's refresh token is posted once, by the CLI that took the lock over after the runner read it: the runner never removes that lock nor posts under one made in its place");
  assert.equal(kept, true, "the CLI's lock, made after the runner read the dead one, is left as it is");
  assert.equal(outcome.token, next.access, "the runner waits for the CLI's write and hands its token");
});

test("two runners never interleave a stale lock's takeover: while one runner that read the dead lock has yet to remove it, another runner never makes the lock its own, so the late removal never lands in a lock that runner posts under and the login's refresh token is posted once", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  // Runner U as another process: the module loaded again, with its own renewals in flight and its own memory.
  const other = await import("../dist/claude-login-token.js?takeover-runner").catch(() => ({}));
  assert.equal(typeof other.renewLogin, "function", "a second runner's renewal");
  const { data, login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  mkdirSync(current);
  const dead = new Date(Date.now() - 61_000);
  utimesSync(current, dead, dead);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // Runner T reads the dead lock (twice: the read and the read right before its removal) and is held at its removal.
  // U starts then. T goes on once U's post is out (U took the lock and passed its check before the post), or once U was
  // kept out of the lock twice (its first ask and the next one, after its poll). U's post is held until T has posted, so
  // U's answer is not written back before T reads the file.
  const tAtRemoval = point();
  const uGoes = point();
  const tPosted = point();
  let tHeld = false;
  let uStarted = false;
  let uKeptOut = 0;
  const lockFsT = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    stat: (path) => fsp.stat(path),
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: async (path, options) => {
      if (path === current && !tHeld) {
        tHeld = true;
        tAtRemoval.reach();
        await uGoes.reached;
      }
      return fsp.rm(path, options);
    },
  };
  const lockFsU = {
    mkdir: async (path) => {
      if (!uStarted) {
        uStarted = true;
        await tAtRemoval.reached;
      }
      if (path === legacy) return notWritable(path);
      try {
        return await fsp.mkdir(path);
      } catch (error) {
        // Refused anything but the lock itself, as it is there: kept out while another runner takes the lock over.
        if (path !== current && error.code === "EEXIST" && ++uKeptOut === 2) uGoes.reach();
        throw error;
      }
    },
    stat: (path) => fsp.stat(path),
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: (path, options) => fsp.rm(path, options),
  };
  const fetchT = (url, init) => {
    tPosted.reach();
    return endpoint.fetch(url, init);
  };
  const fetchU = async (url, init) => {
    uGoes.reach();
    await tPosted.reached;
    return endpoint.fetch(url, init);
  };
  const ask = (module, lockFs, fetch) => {
    const renew = module.renewLogin({ fetch, now: () => now, lockFs, lockUpdateMs: 60_000 });
    return new module.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  };
  const [tOutcome, uOutcome] = await Promise.all([ask(tokens, lockFsT, fetchT), ask(other, lockFsU, fetchU)]);
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once: a takeover held before its removal while another runner posts never removes that runner's lock, for that runner never takes the lock meanwhile");
  assert.equal(tHeld, true, "T read the dead lock and was held at its removal");
  assert.deepEqual([tOutcome.token, uOutcome.token], [next.access, next.access], "both hand the one renewal");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no lock or takeover mark is left in the login folder");
  assert.deepEqual(listing(data), ["claude-login"], "and none beside it");
});

test("a runner takes a lock as its own only by the mtime it set: a lock another holder (the CLI) made in its place between the runner's touch and its read of it back, its mtime a fraction of a second off, is never taken as the runner's, and nothing is posted under it", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  mkdirSync(current);
  const dead = new Date(Date.now() - 61_000);
  utimesSync(current, dead, dead);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  /** The mtime the runner set on the lock it made, and the CLI's, 300 ms after it. */
  let set;
  let theirs;
  let decide;
  /** What the runner did once its new lock was replaced: "waits" (it found the CLI's and left it) or "posted". */
  const decided = new Promise((resolve) => (decide = resolve));
  const lockFs = {
    mkdir: async (path) => {
      if (path === legacy) return notWritable(path);
      try {
        return await fsp.mkdir(path);
      } catch (error) {
        if (theirs && path === current && error.code === "EEXIST") decide("waits");
        throw error;
      }
    },
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      if (path === current && set === undefined) set = mtime.getTime();
    },
    // The runner's read of its new lock back, once it set its mtime. Before that read, the CLI, which read the dead lock
    // too, removes the runner's lock late, makes its own with its own mtime, and posts the login's refresh token.
    stat: async (path) => {
      if (path === current && set !== undefined && !theirs) {
        theirs = new Date(set + 300);
        takeOver(current, theirs);
        const response = await endpoint.fetch(loginRefresh.tokenUrl ?? "https://token.invalid/v1/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: old.refresh }) });
        await response.json();
      }
      return fsp.stat(path);
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const fetch = (url, init) => {
    decide("posted");
    return endpoint.fetch(url, init);
  };
  /** The CLI writes its renewal back, then releases its lock while it is still its own. */
  const theyWrite = () => {
    write(oauthOf(next.access, now + 8 * HOUR, next.refresh));
    if (existsSync(current) && statSync(current).mtimeMs === theirs.getTime()) rmSync(current, { recursive: true });
  };
  const renew = tokens.renewLogin({ fetch, now: () => now, lockFs, lockUpdateMs: 60_000 });
  const asked = new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  const how = await decided;
  if (how === "waits") theyWrite();
  const outcome = await asked;
  if (how !== "waits") theyWrite();
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once, by the holder that made its lock between the runner's touch and its read back: the runner never takes a mtime it did not set as its own");
  assert.equal(outcome.token, next.access, "the runner waits for the CLI's write and hands its token");
});

test("a runner that died mid-takeover never wedges the lock: the takeover marks a dead runner left behind, past the stale time, are cleared, and the next renewal takes the lock over, posts once and leaves no mark", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { data, login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  // A runner died mid-takeover of both locks: its dead lock in the folder, and its takeover mark beside each lock, all
  // past the 60 s stale time.
  const dead = new Date(Date.now() - 61_000);
  for (const path of [current, `${current}.takeover`, `${legacy}.takeover`]) {
    mkdirSync(path);
    utimesSync(path, dead, dead);
  }
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // A short wait: a renewal kept out by the marks gives up in 2 s, well inside the test's own time.
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockWaitMs: 2_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once: the dead runner's marks were cleared and the lock taken over");
  assert.equal(outcome.token, next.access, "the renewal is handed");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no lock or takeover mark is left in the login folder");
  assert.deepEqual(listing(data), ["claude-login"], "and none beside it");
});

test("a runner's takeover mark is removed only while it is still that runner's: one another runner made in its place, after clearing it as dead while this runner stalled, is left to it, and the renewal posts once", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const mark = `${current}.takeover`;
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  /** The other runner's mark: a whole second away from any mtime the runner's own mark has. */
  let theirs;
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    stat: (path) => fsp.stat(path),
    // The runner stalls as it sets its new lock's mtime, inside its takeover, past the stale time: another runner finds
    // its mark dead, removes it and makes its own, which it holds while this runner goes on.
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      if (path !== current || theirs) return;
      theirs = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2_000);
      rmSync(mark, { recursive: true });
      mkdirSync(mark);
      utimesSync(mark, theirs, theirs);
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 60_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.ok(theirs, "the other runner made its mark while the runner was inside its takeover");
  assert.ok(existsSync(mark) && statSync(mark).mtimeMs === theirs.getTime(), "the other runner's live mark is still there: a runner's release removes only the mark it made itself");
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "the refresh token is posted once");
  assert.equal(outcome.token, next.access, "the renewal is handed");
});

test("a holder's heartbeat keeps the lock only by the mtime it set: one another holder sets on the same directory between the heartbeat's touch and its next read marks the lock lost, and nothing is posted under it", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  write(oauthOf(fake("access-old"), now + 60_000));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const endpoint = await tokenEndpoint(t, () => ({ json: { access_token: fake("access-new"), expires_in: 3600 } }));
  // The holder makes the lock in the folder and is held at the older lock beside it (before its check before the post)
  // until its heartbeat has touched the lock and read it again. Right after the heartbeat's touch, another holder sets
  // its own mtime, 300 ms on, on the same directory.
  let made = false;
  let touched = false;
  const readAgain = point();
  const lockFs = {
    mkdir: async (path) => {
      if (path !== legacy) return fsp.mkdir(path);
      await readAgain.reached;
      return notWritable(path);
    },
    stat: async (path) => {
      const read = await fsp.stat(path);
      if (touched && path === current) readAgain.reach();
      return read;
    },
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      if (path !== current) return;
      if (!made) {
        made = true;
        return;
      }
      if (touched) return;
      const theirs = new Date(mtime.getTime() + 300);
      await fsp.utimes(path, theirs, theirs);
      touched = true;
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const lines = [];
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, log: (fields) => lines.push(fields), lockFs, lockUpdateMs: 20, lockWaitMs: 300 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(touched, true, "another holder set its mtime on the lock right after the heartbeat's touch");
  assert.equal(endpoint.posts.length, 0, "nothing posted: another holder set the lock's mtime between the heartbeat's touch and its next read, so the lock is not the holder's");
  assert.deepEqual(lines.filter((fields) => fields.claude_login === "lock_lost"), [{ claude_login: "lock_lost", at: "before_post" }], "the check before the post finds the lock another's");
  assert.equal(outcome.error?.message, tokens.LOGIN_RUNNING_OUT, "the other holder kept the lock past the wait and wrote nothing: the ask is refused in words, having posted nothing");
});

/** A transient failure of the filesystem, as a stat may meet one. */
const ioError = (path) => Object.assign(new Error(`EIO: i/o error, stat '${path}'`), { code: "EIO" });

test("a runner whose touch of its new lock finds it gone never removes what is at the path then: a lock another holder (the CLI) made there after removing the runner's is left to it, and nothing is posted", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  write(oauthOf(fake("access-old"), now + 60_000));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const posts = [];
  const fetch = async (url, init) => {
    posts.push(init.body);
    throw new Error("no request leaves a test");
  };
  // The CLI's lock: a whole second away from any mtime the runner sets.
  const theirs = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2_000);
  /** The error the runner's touch met. */
  let touch;
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    stat: (path) => fsp.stat(path),
    // The runner's touch of the lock it just made. The CLI (which read a dead lock there too) removes that lock late, so
    // the touch finds it gone; before the runner acts on that, the CLI makes its own lock at the path.
    utimes: async (path, atime, mtime) => {
      if (path !== current || touch) return fsp.utimes(path, atime, mtime);
      rmSync(current, { recursive: true, force: true });
      touch = await fsp.utimes(path, atime, mtime).then(() => ({ code: "none" }), (error) => error);
      mkdirSync(current);
      utimesSync(current, theirs, theirs);
      if (touch instanceof Error) throw touch;
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const renew = tokens.renewLogin({ fetch, now: () => now, lockFs, lockUpdateMs: 60_000, lockWaitMs: 300 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(touch?.code, "ENOENT", "the runner's touch found its new lock gone");
  assert.ok(existsSync(current) && statSync(current).mtimeMs === theirs.getTime(), "the CLI's lock, made at the path after the runner's touch found its own lock gone, is left as it is: a runner never removes by its path a lock that is no longer the one it made");
  assert.equal(posts.length, 0, "nothing is posted while another holder has the lock");
  assert.equal(outcome.error?.message, tokens.LOGIN_RUNNING_OUT, "the ask is refused in words, having posted nothing");
});

/** Red (b)'s order with a replacement of the test's choosing. A dead lock in the folder (the older lock beside it cannot
 *  be made); the runner takes it over, and between its touch of its new lock and its read of it back the CLI, which read
 *  the dead lock too, removes the runner's lock late, makes its own there with the mtime `theirsAt(set)` (milliseconds;
 *  `set` is the mtime the runner set) and posts the login's refresh token. `view`: how the runner's reads of the lock
 *  see it (its filesystem). The CLI writes its renewal back, then releases its lock. Resolves to the number of posts of
 *  the login's refresh token, the runner's outcome, the renewed token, `set`, and the CLI's lock as read once made. */
async function replacedBeforeReadBack(t, theirsAt, view = (read) => read) {
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  mkdirSync(current);
  const dead = new Date(Date.now() - 61_000);
  utimesSync(current, dead, dead);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  let set;
  let theirs;
  let decide;
  /** What the runner did once its new lock was replaced: "waits" (it found the CLI's and left it) or "posted". */
  const decided = new Promise((resolve) => (decide = resolve));
  const lockFs = {
    mkdir: async (path) => {
      if (path === legacy) return notWritable(path);
      try {
        return await fsp.mkdir(path);
      } catch (error) {
        if (theirs && path === current && error.code === "EEXIST") decide("waits");
        throw error;
      }
    },
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      if (path === current && set === undefined) set = mtime.getTime();
    },
    stat: async (path) => {
      if (path === current && set !== undefined && !theirs) {
        rmSync(current, { recursive: true, force: true });
        mkdirSync(current);
        // In seconds: a Date keeps whole milliseconds alone.
        const at = theirsAt(set) / 1000;
        utimesSync(current, at, at);
        theirs = statSync(current);
        const response = await endpoint.fetch(loginRefresh.tokenUrl ?? "https://token.invalid/v1/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: old.refresh }) });
        await response.json();
      }
      const read = await fsp.stat(path);
      return path === current ? view(read) : read;
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const fetch = (url, init) => {
    decide("posted");
    return endpoint.fetch(url, init);
  };
  /** The CLI writes its renewal back, then releases its lock while it is still its own. */
  const theyWrite = () => {
    write(oauthOf(next.access, now + 8 * HOUR, next.refresh));
    if (existsSync(current) && statSync(current).ino === theirs.ino) rmSync(current, { recursive: true });
  };
  const renew = tokens.renewLogin({ fetch, now: () => now, lockFs, lockUpdateMs: 60_000 });
  const asked = new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  const how = await decided;
  if (how === "waits") theyWrite();
  const outcome = await asked;
  if (how !== "waits") theyWrite();
  return { posts: endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, outcome, renewed: next.access, set, theirs };
}

test("a runner takes a lock as its own only by the mtime it set, to the microsecond: a lock another holder (the CLI) made in its place between its touch and its read back, in the same millisecond, is never taken as the runner's, and nothing is posted under it", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  // Half a millisecond on: what the kernel's own time of a mkdir in the runner's millisecond can be.
  const { posts, outcome, renewed, set, theirs } = await replacedBeforeReadBack(t, (set) => set + 0.5);
  const off = Math.abs(theirs.mtimeMs - set);
  assert.ok(off > 0.01 && off < 1, `the CLI's lock carries an mtime inside the runner's millisecond, about half of one off it (the scratch filesystem keeps microseconds): ${off} ms`);
  assert.equal(posts, 1, "posted once, by the holder whose lock's mtime was half a millisecond off the runner's own: an mtime the runner did not set, however near, is another holder's");
  assert.equal(outcome.token, renewed, "the runner waits for the CLI's write and hands its token");
});

test("on a filesystem that keeps whole seconds alone, a runner takes a lock as its own only by the second its own mtime falls in: a lock another holder (the CLI) made in its place between its touch and its read back, at the next whole second as the CLI's lock library sets it there, is never taken as the runner's", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  // The wall clock the locks are timed on, the test's: inside a second, so the second's start and the next one differ.
  const wall = Math.floor(Date.now() / 1000) * 1000 + 400;
  t.mock.method(Date, "now", () => wall);
  const seconds = (read) => ({ dev: read.dev, ino: read.ino, mtimeMs: Math.floor(read.mtimeMs / 1000) * 1000 });
  const { posts, outcome, renewed, set, theirs } = await replacedBeforeReadBack(t, (set) => Math.ceil(set / 1000) * 1000, seconds);
  assert.equal(set, wall, "the runner set the clock's time, inside a second");
  assert.equal(theirs.mtimeMs, wall + 600, "the CLI's lock carries the next whole second");
  assert.equal(posts, 1, "posted once, by the holder whose lock carries the next whole second: on a filesystem that keeps seconds alone, the runner's own mtime reads as the start of its second, and no other");
  assert.equal(outcome.token, renewed, "the runner waits for the CLI's write and hands its token");
});

test("a holder's lock is its own only as the directory it made: another directory put at the path with the holder's own mtime, to the millisecond, is not its lock, and nothing is posted under it", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  write(oauthOf(fake("access-old"), now + 60_000));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const posts = [];
  const fetch = async (url, init) => {
    posts.push(init.body);
    throw new Error("no request leaves a test");
  };
  let set;
  let made;
  let theirs;
  // The holder makes the lock in the folder. Before it goes on from the older lock beside the folder to its check before
  // the post, another directory, made while the holder's still stood (so never its inode), takes its place at the path
  // and is given the holder's own mtime.
  const lockFs = {
    mkdir: async (path) => {
      if (path !== legacy) return fsp.mkdir(path);
      if (!theirs) {
        made = statSync(current);
        const other = `${current}-other`;
        mkdirSync(other);
        rmSync(current, { recursive: true });
        renameSync(other, current);
        utimesSync(current, new Date(set), new Date(set));
        theirs = statSync(current);
      }
      return notWritable(path);
    },
    stat: (path) => fsp.stat(path),
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      if (path === current && set === undefined) set = mtime.getTime();
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const renew = tokens.renewLogin({ fetch, now: () => now, lockFs, lockUpdateMs: 60_000, lockWaitMs: 300 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.ok(theirs, "another directory took the holder's lock's place");
  assert.notEqual(theirs.ino, made.ino, "it is another directory");
  assert.ok(Math.abs(theirs.mtimeMs - set) < 0.01, "with the holder's own mtime");
  assert.equal(posts.length, 0, "nothing posted: another directory at the path, though it carries the holder's own mtime, is not the lock the holder made");
  assert.equal(outcome.error?.message, tokens.LOGIN_RUNNING_OUT, "the ask is refused in words, having posted nothing");
  assert.equal(statSync(current).ino, theirs.ino, "the other directory is left as it is");
});

test("a runner whose read of its new lock back fails removes that lock while it is still the one it made, so a failed read never keeps the lock from the next try: the next try takes it and posts once", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  let touched = false;
  let failed = false;
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      if (path === current) touched = true;
    },
    // The runner's first read of its new lock back fails once (EIO).
    stat: async (path) => {
      if (path === current && touched && !failed) {
        failed = true;
        throw ioError(path);
      }
      return fsp.stat(path);
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  // A short wait: a lock left behind by the failed read keeps the renewal out until it gives up, in 1 s.
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 60_000, lockWaitMs: 1_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(failed, true, "the runner's read of its new lock back failed once");
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once: the lock whose read back failed was removed, so the next try made it again and took it");
  assert.equal(outcome.token, next.access, "the renewal is handed");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no lock or takeover mark is left in the login folder");
});

test("a holder's heartbeat whose read of the lock fails for a reason other than the lock being gone tries again at the next beat: the lock is not lost, and the renewal posts under it once", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // The holder makes the lock in the folder and is held at the older lock beside it (before its check before the post)
  // until its heartbeat has read the lock. That read, the first after the holder's read back, fails once (EIO).
  let readBack = false;
  let failed = false;
  const beatFailed = point();
  const lockFs = {
    mkdir: async (path) => {
      if (path !== legacy) return fsp.mkdir(path);
      await beatFailed.reached;
      return notWritable(path);
    },
    stat: async (path) => {
      if (path !== current) return fsp.stat(path);
      if (!readBack) {
        readBack = true;
        return fsp.stat(path);
      }
      if (!failed) {
        failed = true;
        beatFailed.reach();
        throw ioError(path);
      }
      return fsp.stat(path);
    },
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: (path, options) => fsp.rm(path, options),
  };
  const lines = [];
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, log: (fields) => lines.push(fields), lockFs, lockUpdateMs: 20, lockWaitMs: 300 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(failed, true, "the heartbeat's read of the lock failed once");
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once: a heartbeat's read that failed (EIO) is tried again at the next beat, never taken as the lock lost");
  assert.deepEqual(lines.filter((fields) => fields.claude_login === "lock_lost"), [], "no lock_lost is said");
  assert.equal(outcome.token, next.access, "the renewal is handed");
  assert.ok(!existsSync(current), "its lock is released, none left for the 60 s stale time");
});

test("a runner whose touch of its new lock finds it gone waits for the holder that took the lock, as for any other: the renewal that holder writes is handed, and the runner never posts", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const posts = [];
  const fetch = async (url, init) => {
    posts.push(init.body);
    throw new Error("no request leaves a test");
  };
  // The CLI's lock: a whole second away from any mtime the runner sets.
  const theirs = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2_000);
  /** The error the runner's touch met. */
  let touch;
  let wrote = false;
  const lockFs = {
    // The runner's next try at the lock finds the CLI's there. The CLI writes its renewal back then, as its post lands
    // after the runner's touch.
    mkdir: async (path) => {
      if (path === legacy) return notWritable(path);
      try {
        return await fsp.mkdir(path);
      } catch (error) {
        if (path === current && touch && !wrote) {
          wrote = true;
          write(oauthOf(next.access, now + 8 * HOUR, next.refresh));
        }
        throw error;
      }
    },
    stat: (path) => fsp.stat(path),
    // The runner's touch of the lock it just made. The CLI (which read a dead lock there too) removes that lock late, so
    // the touch finds it gone; before the runner acts on that, the CLI makes its own lock at the path.
    utimes: async (path, atime, mtime) => {
      if (path !== current || touch) return fsp.utimes(path, atime, mtime);
      rmSync(current, { recursive: true, force: true });
      touch = await fsp.utimes(path, atime, mtime).then(() => ({ code: "none" }), (error) => error);
      mkdirSync(current);
      utimesSync(current, theirs, theirs);
      if (touch instanceof Error) throw touch;
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const renew = tokens.renewLogin({ fetch, now: () => now, lockFs, lockUpdateMs: 60_000, lockWaitMs: 5_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(touch?.code, "ENOENT", "the runner's touch found its new lock gone");
  assert.equal(outcome.token, next.access, `the ask waits for the holder that took the lock and is handed the renewal it writes, never refused at the touch that found the runner's own lock gone (${outcome.error?.message})`);
  assert.equal(posts.length, 0, "the runner never posts: the lock was another holder's");
  assert.ok(existsSync(current) && statSync(current).mtimeMs === theirs.getTime(), "the CLI's lock is left to it");
});

test("on a filesystem that keeps whole seconds alone, a runner's own lock and takeover mark read back as the start of the second it set their mtime in, and are its own: with no other holder, the runner posts once and leaves no lock or mark", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { data, login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // The wall clock the locks are timed on, the test's: the real one, never on a whole second, so a mtime the runner
  // sets is never a whole second and only the whole-second rule can take a seconds-only read of it as the runner's own.
  const real = Date.now;
  t.mock.method(Date, "now", () => {
    const at = real();
    return at % 1000 === 0 ? at + 1 : at;
  });
  /** Each mtime the runner set, by path, and each of its reads of the lock in the folder: what it set, what it read. */
  const sets = new Map();
  const reads = [];
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    // Every read of a lock or mark as such a filesystem keeps it: its mtime in whole seconds.
    stat: async (path) => {
      const read = await fsp.stat(path);
      const seen = { dev: read.dev, ino: read.ino, mtimeMs: Math.floor(read.mtimeMs / 1000) * 1000 };
      if (path === current) reads.push({ set: sets.get(path), mtimeMs: seen.mtimeMs });
      return seen;
    },
    utimes: async (path, atime, mtime) => {
      await fsp.utimes(path, atime, mtime);
      sets.set(path, mtime.getTime());
    },
    rm: (path, options) => fsp.rm(path, options),
  };
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 60_000, lockWaitMs: 1_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once, by the runner: on a filesystem that keeps whole seconds alone, its own lock and mark, read back as the start of the second it set them in, are its own");
  assert.equal(outcome.token, next.access, "the renewal is handed");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no lock or takeover mark is left: each release read its own as its own");
  assert.deepEqual(listing(data), ["claude-login"], "and none beside the folder");
  assert.ok(reads.length > 0 && reads.every(({ set, mtimeMs }) => set % 1000 !== 0 && mtimeMs === Math.floor(set / 1000) * 1000), `every read of the runner's lock showed the start of the second it set, never the mtime itself: ${JSON.stringify(reads)}`);
});

test("a runner's release of its takeover mark whose read fails for a reason other than the mark being gone reads it again and removes it while it is still its own: one transient failure never leaves the mark standing for the 60 s stale time, holding every runner on the login", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const mark = `${current}.takeover`;
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // The runner's reads of its mark: the first its read back once made, the second its release's, which fails once (EIO).
  let markReads = 0;
  let failed = false;
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    stat: async (path) => {
      if (path === mark && ++markReads === 2) {
        failed = true;
        throw ioError(path);
      }
      return fsp.stat(path);
    },
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: (path, options) => fsp.rm(path, options),
  };
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 60_000, lockWaitMs: 1_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(failed, true, "the release's read of the runner's mark failed once");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no takeover mark is left: a release whose read of its mark failed (EIO) reads it again and removes the mark it made");
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once");
  assert.equal(outcome.token, next.access, "the renewal is handed");
});

test("a holder's release of its lock whose read fails for a reason other than the lock being gone reads it again and removes it while it is still its own: one transient failure never leaves the lock standing for the 60 s stale time", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  /** Whether the login's file holds the renewal: the holder writes it back under the lock, then releases the lock. */
  const savedNow = () => JSON.parse(readFileSync(join(login.dir, ".credentials.json"), "utf8")).claudeAiOauth.accessToken === next.access;
  // The holder's first read of its lock once the renewal is written back, its release's, fails once (EIO).
  let failed = false;
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    stat: async (path) => {
      if (path === current && !failed && savedNow()) {
        failed = true;
        throw ioError(path);
      }
      return fsp.stat(path);
    },
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: (path, options) => fsp.rm(path, options),
  };
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs, lockUpdateMs: 60_000, lockWaitMs: 1_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(failed, true, "the release's read of the holder's lock failed once");
  assert.ok(!existsSync(current), "its lock is released: a release whose read of the lock failed (EIO) reads it again and removes it while it is still its own, never left for the 60 s stale time");
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once");
  assert.equal(outcome.token, next.access, "the renewal is handed");
});

test("a read of the lock that fails for a reason other than the lock being gone, in the holder's check before its post, is said as an unread lock, never as a lock lost: the holder releases it, tries again and posts once", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // The holder's reads of its lock: the first its read back once made, the second its check before the post, which
  // fails once (EIO). No heartbeat reads it meanwhile.
  let reads = 0;
  let failed = false;
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    stat: async (path) => {
      if (path === current && ++reads === 2) {
        failed = true;
        throw ioError(path);
      }
      return fsp.stat(path);
    },
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: (path, options) => fsp.rm(path, options),
  };
  const lines = [];
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, log: (fields) => lines.push(fields), lockFs, lockUpdateMs: 60_000, lockWaitMs: 5_000 });
  const outcome = await new tokens.LoginTokens({ login, now: () => now, renew }).token().then((token) => ({ token }), (error) => ({ error }));
  assert.equal(failed, true, "the check before the post failed to read the lock once");
  assert.deepEqual(lines.filter((fields) => fields.claude_login === "lock_lost"), [], "a read that failed (EIO) in the check before the post is never said as the lock lost: no other holder took it");
  assert.deepEqual(lines.filter((fields) => fields.claude_login === "lock_unread"), [{ claude_login: "lock_unread", at: "before_post" }], "it is said in its own word, at its place");
  assert.equal(endpoint.posts.filter((post) => post.body.refresh_token === old.refresh).length, 1, "posted once, at the next try");
  assert.equal(outcome.token, next.access, "the renewal is handed");
  assert.ok(!existsSync(current), "its lock is released");
});

test("a renewal whose save fails to read the login's file (an I/O error, not the file gone) keeps the new pair in memory, the refresh token Anthropic rotated in it the only one left: the next ask saves it and is handed its token, and a later ask renews with the new refresh token", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const start = 1_900_000_000_000;
  let clock = start;
  const file = join(login.dir, ".credentials.json");
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  const third = { access: fake("access-third"), refresh: fake("refresh-third") };
  write(oauthOf(old.access, start + 60_000, old.refresh));
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next], [next.refresh, third]]));
  // Anthropic has answered the post of the old refresh token, rotating it: the renewal's next read of the file, its
  // save's, fails once (EIO).
  let failNext = false;
  const failed = [];
  const fetch = async (url, init) => {
    const answer = await endpoint.fetch(url, init);
    if (JSON.parse(init.body).refresh_token === old.refresh) failNext = true;
    return answer;
  };
  const readFile = async (path) => {
    if (failNext) {
      failNext = false;
      failed.push(path);
      throw Object.assign(new Error(`EIO: i/o error, read '${path}'`), { code: "EIO" });
    }
    return fsp.readFile(path, "utf8");
  };
  const lines = [];
  const renew = tokens.renewLogin({ fetch, now: () => clock, log: (fields) => lines.push(fields), readFile });
  const reader = new tokens.LoginTokens({ login, now: () => clock, renew });
  assert.equal(await reader.token(), next.access, "the ask is handed the renewed token");
  assert.deepEqual(failed, [file], "the save's read of the login's file failed once (EIO)");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).claudeAiOauth.refreshToken, old.refresh, "unsaved: the file still holds the spent refresh token");
  const asked = await reader.token().catch((error) => error.message);
  assert.equal(asked, next.access, "a save whose read of the file failed (EIO) keeps the renewed pair in memory: the next ask is handed its token, never refused for the spent refresh token left in the file");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).claudeAiOauth.refreshToken, next.refresh, "the next ask saved the held pair, its new refresh token in the file");
  // Near the new token's end: renewed with the new refresh token, each posted once.
  clock = start + 3_600_000 - 60_000;
  assert.equal(await reader.token(), third.access, "a later ask renews with the new refresh token");
  assert.deepEqual(endpoint.posts.map((post) => post.body.refresh_token), [old.refresh, next.refresh], "each refresh token posted once, the spent one never again");
  assert.deepEqual(lines.filter((fields) => fields.saved === "no"), [{ claude_login: "renewed", saved: "no", reason: "file_unread" }], "the save held for the failed read is said as one, never as a newer pair");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no temp file or lock left");
});

test("an ask that reads the old pair while the renewal that rotated its refresh token is saving the new pair joins that renewal and is handed the new token, never refused for the refresh token that renewal spent; once saved, an ask that read the old pair is sent back to the file, and a spent refresh token is still never posted again", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const file = join(login.dir, ".credentials.json");
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // Anthropic has answered the post of the old refresh token with a new one (the old one is spent): the renewal's next
  // read of the file, its save's, waits until the test lets it go, the file still holding the old pair.
  let holdNext = false;
  let saving = false;
  let letGo;
  const held = new Promise((resolve) => (letGo = resolve));
  let reads = 0;
  const fetch = async (url, init) => {
    const answer = await endpoint.fetch(url, init);
    if (JSON.parse(init.body).refresh_token === old.refresh) holdNext = true;
    return answer;
  };
  const readFile = async (path) => {
    if (holdNext) {
      holdNext = false;
      saving = true;
      await held;
    } else reads++;
    return fsp.readFile(path, "utf8");
  };
  const renew = tokens.renewLogin({ fetch, now: () => now, readFile });
  const first = new tokens.LoginTokens({ login, now: () => now, renew });
  const other = new tokens.LoginTokens({ login, now: () => now, renew });
  const renewing = first.token();
  renewing.catch(() => undefined);
  await until(() => saving, "the save's read of the file, after the post");
  const readsBefore = reads;
  const asked = other.token().catch((error) => error.message);
  await until(() => reads > readsBefore, "the other ask's read of the file");
  await sleep(100);
  letGo();
  assert.equal(await asked, next.access, "an ask that read the old pair while the renewal that spent its refresh token was saving the new pair joins that renewal and is handed the new token, never refused in LOGIN_RUNNING_OUT's words");
  assert.equal(await renewing, next.access, "the renewal's own ask is handed the new token");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).claudeAiOauth.refreshToken, next.refresh, "the new pair saved");
  // An ask that read the old pair before the save landed and renews only after it: nothing is posted, and it is sent
  // back to the file (undefined), which holds the new pair.
  assert.equal(await renew(login, old.access, undefined), undefined, "a renewal asked for the old pair once the new one is saved sends the ask back to the file");
  assert.equal(await other.token(), next.access, "the file hands the new token");
  assert.deepEqual(endpoint.posts.map((post) => post.body.refresh_token), [old.refresh], "one post for both asks");
  // A copy of the old pair put back in the file (restored from a backup, say): its refresh token is spent, and a new
  // request with it is refused before its post.
  write(oauthOf(old.access, now + 60_000, old.refresh));
  await assert.rejects(other.token(), { message: tokens.LOGIN_RUNNING_OUT }, "an ask on the spent refresh token is refused in LOGIN_RUNNING_OUT's words");
  assert.deepEqual(endpoint.posts.map((post) => post.body.refresh_token), [old.refresh], "a spent refresh token is never posted again: a new request with it is refused before its post");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no temp file or lock left");
});

/** The refresh locks' file operations for `login`, its older lock beside the folder never made (the CLI goes on without
 *  it), each read of its lock in the folder counted (`reads.n`) and failed (EIO) while `fails(n)` holds. */
function lockReads(login, fails) {
  const [current, legacy] = [join(login.dir, ".oauth_refresh.lock"), `${realpathSync(login.dir)}.lock`];
  const reads = { n: 0, failed: [] };
  const lockFs = {
    mkdir: (path) => (path === legacy ? notWritable(path) : fsp.mkdir(path)),
    stat: async (path) => {
      if (path === current && fails(++reads.n)) {
        reads.failed.push(reads.n);
        throw ioError(path);
      }
      return fsp.stat(path);
    },
    utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
    rm: (path, options) => fsp.rm(path, options),
  };
  return { current, reads, lockFs };
}

test("a held pair's save whose read of its lock fails for a reason other than the lock being gone writes nothing under it: the pair stays held, said as an unread lock, and the next ask saves it", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { data, login } = loginFolder(t);
  const start = 1_900_000_000_000;
  const file = join(login.dir, ".credentials.json");
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  const oldText = JSON.stringify({ claudeAiOauth: oauthOf(old.access, start + 60_000, old.refresh) });
  // The first save fails (the file reached through a link, which the runner never replaces): the renewed pair is held.
  const elsewhere = join(data, "credentials-elsewhere.json");
  writeFileSync(elsewhere, oldText, { mode: 0o600 });
  symlinkSync(elsewhere, file);
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // Armed for the next ask: its reads of the lock are the read back once made (1), the save's check before its write (2,
  // failed once: EIO) and the release's (3).
  let armed = false;
  const { current, reads, lockFs } = lockReads(login, (n) => armed && n === 2);
  const lines = [];
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => start, log: (fields) => lines.push(fields), lockFs, lockUpdateMs: 60_000, lockWaitMs: 1_000 });
  const reader = new tokens.LoginTokens({ login, now: () => start, renew });
  assert.equal(await reader.token(), next.access, "renewed, its save failed: the pair is held");
  rmSync(file);
  writeWhole(file, oldText);
  armed = true;
  reads.n = 0;
  assert.equal(await reader.token(), next.access, "the held token is handed");
  assert.deepEqual(reads.failed, [2], "the save's check of its lock failed once");
  assert.equal(readFileSync(file, "utf8"), oldText, "a save whose read of its lock failed (EIO) writes nothing under it: the file keeps its old pair");
  assert.deepEqual(lines.filter((fields) => fields.reason === "lock_unread"), [{ claude_login: "renewed", saved: "no", reason: "lock_unread" }], "said as an unread lock, never as one lost");
  assert.ok(!existsSync(current), "its lock is released");
  armed = false;
  assert.equal(await reader.token(), next.access);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).claudeAiOauth.refreshToken, next.refresh, "the next ask saved the held pair");
  assert.equal(endpoint.posts.length, 1, "nothing posted after the one renewal");
});

test("a read of the lock that fails for a reason other than the lock being gone, in the holder's check after its post, is said as an unread lock at that place, never as a lock lost: the answer is written back and the lock released", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // The holder's reads of its lock: the read back once made (1), the check before the post (2), the check after it (3,
  // failed once: EIO) and the release's (4). No heartbeat reads it meanwhile.
  const { current, reads, lockFs } = lockReads(login, (n) => n === 3);
  const lines = [];
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, log: (fields) => lines.push(fields), lockFs, lockUpdateMs: 60_000, lockWaitMs: 1_000 });
  assert.equal(await new tokens.LoginTokens({ login, now: () => now, renew }).token(), next.access, "the renewal is handed");
  assert.deepEqual(reads.failed, [3], "the check after the post failed to read the lock once");
  assert.deepEqual(lines.filter((fields) => fields.at === "after_post"), [{ claude_login: "lock_unread", at: "after_post" }], "a read that failed (EIO) in the check after the post is said as an unread lock, never as the lock lost: no other holder took it");
  assert.equal(JSON.parse(readFileSync(join(login.dir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken, next.refresh, "the answer written back");
  assert.equal(endpoint.posts.length, 1, "posted once");
  assert.ok(!existsSync(current), "its lock is released");
});

test("a holder's release whose two reads of its lock both fail (not the lock gone) never removes it: a lock it cannot read may be another holder's, so it is left for the 60 s stale time", { timeout: 20_000 }, async (t) => {
  assert.equal(typeof tokens.renewLogin, "function", "the runner's renewal (renewLogin)");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const old = { access: fake("access-old"), refresh: fake("refresh-old") };
  const next = { access: fake("access-new"), refresh: fake("refresh-new") };
  write(oauthOf(old.access, now + 60_000, old.refresh));
  const endpoint = await rotatingEndpoint(t, new Map([[old.refresh, next]]));
  // The holder's reads of its lock: the read back (1), the checks before and after the post (2, 3), then the release's
  // two reads (4, 5), both failed (EIO).
  const { current, reads, lockFs } = lockReads(login, (n) => n >= 4);
  const removed = [];
  const watched = { ...lockFs, rm: (path, options) => (removed.push(path), fsp.rm(path, options)) };
  const renew = tokens.renewLogin({ fetch: endpoint.fetch, now: () => now, lockFs: watched, lockUpdateMs: 60_000, lockWaitMs: 1_000 });
  assert.equal(await new tokens.LoginTokens({ login, now: () => now, renew }).token(), next.access, "the renewal is handed");
  assert.deepEqual(reads.failed, [4, 5], "both of the release's reads failed");
  assert.ok(!removed.includes(current) && existsSync(current), "a release whose two reads of the lock failed (EIO) never removes it: left for the stale time");
});

test("a renewal Anthropic refuses (400 invalid_grant) or that fails (a 5xx) refuses the ask in LOGIN_RUNNING_OUT's words, posts once for that ask and never again on its own as the clock goes on, and leaves the file byte for byte as it was; a refresh token refused as invalid_grant is never posted again", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  for (const [why, answer, nextAskPosts] of [
    ["400 invalid_grant", { status: 400, json: { error: "invalid_grant", error_description: "the refresh token was revoked" } }, 0],
    ["503", { status: 503, text: "upstream unavailable" }, 1],
  ]) {
    const { login, write } = loginFolder(t);
    let clock = 1_900_000_000_000;
    write(oauthOf(fake("access"), clock + 60_000));
    const file = join(login.dir, ".credentials.json");
    const bytes = readFileSync(file);
    const endpoint = await tokenEndpoint(t, () => answer);
    const reader = new tokens.LoginTokens({ login, now: () => clock, fetch: endpoint.fetch });
    await assert.rejects(reader.token(), { message: tokens.LOGIN_RUNNING_OUT }, why);
    assert.equal(endpoint.posts.length, 1, `${why}: one post for the ask, no retry`);
    // The clock goes on, as a loop would see it: nothing posts on its own.
    for (let step = 0; step < 5; step++) {
      clock += 10 * 60_000;
      await sleep(60);
    }
    assert.equal(endpoint.posts.length, 1, `${why}: nothing retries between asks`);
    await assert.rejects(reader.token(), { message: tokens.LOGIN_RUNNING_OUT }, `${why}: the next ask`);
    assert.equal(endpoint.posts.length, 1 + nextAskPosts, `${why}: the next ask posts ${nextAskPosts}`);
    assert.deepEqual(readFileSync(file), bytes, `${why}: the file byte for byte as it was`);
    assert.deepEqual(listing(login.dir), [".credentials.json"], `${why}: no temp file or lock left`);
  }
});

test("the renewal never follows a redirect: a 307 to another origin gets no request there, so the refresh token goes to the token endpoint alone; the ask is refused in LOGIN_RUNNING_OUT's words, the file keeps its pair byte for byte, and the refresh token is not taken as refused (the next ask posts it again, to the endpoint alone)", { timeout: 30_000 }, async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  // Another origin on loopback (another port): every request that reaches it is counted with its body, and it answers
  // a token, as a host the refresh token was steered to would.
  const elsewhere = [];
  const other = createServer((request, response) => {
    if (stranger(request, response)) return;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      elsewhere.push({ method: request.method, path: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: fake("access-elsewhere"), expires_in: 3600 }));
    });
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    other.closeAllConnections();
    other.close(resolve);
  }));
  const location = `http://127.0.0.1:${other.address().port}/v1/oauth/token`;
  // The token endpoint answers the post with a 307 there: a fetch that follows it posts the same body again, there.
  const endpoint = await tokenEndpoint(t, () => ({ status: 307, text: "", headers: { location } }));
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const refresh = fake("refresh-kept");
  write(oauthOf(fake("access-near"), now + 60_000, refresh));
  const file = join(login.dir, ".credentials.json");
  const bytes = readFileSync(file);
  const reader = new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch });
  // One ask, bounded by its own timer: an ask that hangs fails here rather than stalling the file.
  const ask = async () => {
    const timer = new AbortController();
    try {
      return await Promise.race([
        reader.token().then((token) => ({ token }), (error) => ({ error })),
        sleep(10_000, undefined, { signal: timer.signal }).then(() => ({ hung: true }), () => undefined),
      ]);
    } finally {
      timer.abort();
    }
  };
  const first = await ask();
  assert.ok(!first.hung, "the ask ended within 10 s");
  assert.deepEqual(elsewhere.map(({ method, path }) => `${method} ${path}`), [], "the redirect was followed: a request (the refresh token in its body) reached another origin");
  assert.equal(endpoint.posts.length, 1, "the token endpoint saw the one post");
  assert.equal(endpoint.posts[0].body.refresh_token, refresh, "the file's refresh token, to the token endpoint");
  assert.equal(first.token, undefined, "no token handed");
  assert.equal(first.error?.message, tokens.LOGIN_RUNNING_OUT, "refused in the words of a renewal that failed under the margin");
  assert.ok(!String(first.error?.stack).includes(refresh), "the refresh token is in no word of the refusal");
  assert.deepEqual(readFileSync(file), bytes, "the file keeps its pair byte for byte");
  assert.deepEqual(listing(login.dir), [".credentials.json"], "no temp file or lock left");
  // A redirect is not invalid_grant: the refresh token is still the login's, and the next ask posts it again, to the
  // token endpoint alone.
  const second = await ask();
  assert.ok(!second.hung, "the next ask ended within 10 s");
  assert.equal(second.error?.message, tokens.LOGIN_RUNNING_OUT, "the next ask: the same words");
  assert.equal(endpoint.posts.length, 2, "the next ask posts again: a redirect did not mark the refresh token refused");
  assert.equal(endpoint.posts[1].body.refresh_token, refresh);
  assert.equal(elsewhere.length, 0, "nothing reached another origin at the next ask either");
  assert.deepEqual(readFileSync(file), bytes, "the file still keeps its pair byte for byte");
});

test("the run's CLI's 401 (refused): the next ask renews the refused token once, though it had hours left, and hands the new one; a refused token another holder renewed meanwhile is never renewed again; a failed renewal is refused in words", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const { login, write } = loginFolder(t);
  const now = 1_900_000_000_000;
  const sent = fake("access-sent");
  write(oauthOf(sent, now + 2 * HOUR));
  const fresh = fake("access-fresh");
  const endpoint = await tokenEndpoint(t, (_, count) => (count === 1 ? { json: { access_token: fresh, expires_in: 3600 } } : { status: 400, json: { error: "invalid_grant" } }));
  const reader = new tokens.LoginTokens({ login, now: () => now, fetch: endpoint.fetch });
  assert.equal(await reader.token(), sent, "hours left: handed as it is");
  assert.equal(endpoint.posts.length, 0);
  await reader.refused(sent);
  assert.equal(await reader.token(), fresh, "the refused token renewed at the next ask");
  assert.equal(endpoint.posts.length, 1, "once");
  assert.equal(await reader.token(), fresh, "and handed again with no post");
  assert.equal(endpoint.posts.length, 1);
  // Refused, but another holder renewed it before the runner was told: its token is handed, nothing posted.
  const theirs = fake("access-theirs");
  write(oauthOf(theirs, now + 2 * HOUR, fake("refresh-theirs")));
  await reader.refused(fresh);
  assert.equal(await reader.token(), theirs);
  assert.equal(endpoint.posts.length, 1);
  // Refused with hours left, and the renewal refused too: words that say Anthropic refused it, never that it runs out
  // in less than 5 minutes, the token in none of them.
  await reader.refused(theirs);
  await assert.rejects(reader.token(), (error) => {
    assert.equal(error.message, tokens.LOGIN_REFUSED_NOT_RENEWED);
    assert.equal(error.message, "Claude refused this login and it could not be renewed; open Claude Code once to sign in again.");
    assert.ok(!/5 minutes/.test(error.message), "not the margin's words: the token had hours left");
    assert.ok(!String(error.stack).includes(theirs));
    return true;
  });
  assert.equal(endpoint.posts.length, 2, "one post for that ask");
});

test("a failed renewal is refused in the words of its own case: under the margin, that the login runs out in less than 5 minutes; after Anthropic refused a token with hours left, that Claude refused it; both say to open Claude Code once", async (t) => {
  assert.equal(typeof tokens.LOGIN_REFUSED_NOT_RENEWED, "string", "the 401 case has words of its own");
  assert.notEqual(tokens.LOGIN_REFUSED_NOT_RENEWED, tokens.LOGIN_RUNNING_OUT);
  for (const words of [tokens.LOGIN_RUNNING_OUT, tokens.LOGIN_REFUSED_NOT_RENEWED]) assert.match(words, /open Claude Code (on this login )?once/, "the same fix");
  const now = 1_900_000_000_000;
  const refusing = await tokenEndpoint(t, () => ({ status: 400, json: { error: "invalid_grant" } }));
  // Margin: less than 5 minutes left, the renewal refused.
  const margin = loginFolder(t);
  margin.write(oauthOf(fake("access-near"), now + 60_000));
  await assert.rejects(new tokens.LoginTokens({ login: margin.login, now: () => now, fetch: refusing.fetch }).token(), { message: tokens.LOGIN_RUNNING_OUT }, "margin: the margin's words");
  // 401: hours left, refused by Anthropic, the renewal refused.
  const refused = loginFolder(t);
  const sent = fake("access-hours");
  refused.write(oauthOf(sent, now + 3 * HOUR, fake("refresh-hours")));
  const reader = new tokens.LoginTokens({ login: refused.login, now: () => now, fetch: refusing.fetch });
  assert.equal(await reader.token(), sent);
  await reader.refused(sent);
  await assert.rejects(reader.token(), { message: tokens.LOGIN_REFUSED_NOT_RENEWED }, "401: the refusal's words");
  // A refused token that is also near its end: Anthropic's refusal is what is true and said.
  const both = loginFolder(t);
  const near = fake("access-both");
  both.write(oauthOf(near, now + 6 * 60_000, fake("refresh-both")));
  const late = { at: now };
  const reader2 = new tokens.LoginTokens({ login: both.login, now: () => late.at, fetch: refusing.fetch });
  assert.equal(await reader2.token(), near);
  await reader2.refused(near);
  late.at = now + 2 * 60_000;
  await assert.rejects(reader2.token(), { message: tokens.LOGIN_REFUSED_NOT_RENEWED });
});

test("no token, old or new, access or refresh, is in any log line, error or stack of a renewal: one that lands, a 400 invalid_grant, a 5xx, and a request that throws with the request in its words", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const lines = [];
  const consoleWas = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoleWas[level] = console[level];
    console[level] = (...args) => lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
  }
  t.after(() => Object.assign(console, consoleWas));
  const now = 1_900_000_000_000;
  const outcomes = [];
  for (const [why, answer] of [
    ["renewed", (v) => ({ json: { access_token: v.newAccess, refresh_token: v.newRefresh, expires_in: 3600 } })],
    ["400 invalid_grant", (v) => ({ status: 400, json: { error: "invalid_grant", error_description: `refresh token ${v.oldRefresh} was revoked, not renewed to ${v.newAccess}` } })],
    ["503", (v) => ({ status: 503, text: `upstream saw ${v.oldRefresh} for ${v.oldAccess}` })],
    ["throws", undefined],
  ]) {
    const v = { oldAccess: fake("old-access"), oldRefresh: fake("old-refresh"), newAccess: fake("new-access"), newRefresh: fake("new-refresh") };
    const { login, write } = loginFolder(t);
    write(oauthOf(v.oldAccess, now + 60_000, v.oldRefresh));
    let posted = 0;
    let fetch;
    if (answer) {
      const endpoint = await tokenEndpoint(t, () => answer(v));
      fetch = async (url, init) => {
        posted += 1;
        return endpoint.fetch(url, init);
      };
    } else {
      fetch = async (_, init) => {
        posted += 1;
        throw Object.assign(new Error(`connect refused sending ${init.body}; would have got ${v.newAccess}`), { cause: new Error(String(init.body)) });
      };
    }
    const reader = new tokens.LoginTokens({ login, now: () => now, fetch, log: (fields) => lines.push(JSON.stringify(fields)) });
    const texts = [];
    try {
      const handed = await reader.token();
      assert.equal(why, "renewed", `${why}: refused`);
      assert.equal(handed, v.newAccess, "the renewed token is handed (the one place it goes)");
    } catch (error) {
      assert.notEqual(why, "renewed", `renewed: ${error?.message}`);
      assert.equal(error.message, tokens.LOGIN_RUNNING_OUT, why);
      texts.push(error.message, String(error.stack), String(error), inspect(error, { depth: 6 }), String(error.cause ?? ""));
    }
    assert.equal(posted, 1, `${why}: the renewal was sent, once`);
    outcomes.push({ why, v, texts });
  }
  assert.ok(lines.length >= 4, `each renewal told the log its outcome (${lines.length} lines)`);
  for (const { why, v, texts } of outcomes) {
    for (const [name, value] of Object.entries(v)) {
      for (const text of [...lines, ...texts]) assert.ok(!text.includes(value), `${why}: the ${name} is in "${text.slice(0, 200)}"`);
    }
  }
});

test("a signed-out login (no file, no claudeAiOauth, a token the CLI cleared) and one in a form the runner does not read are refused in their own words, never with a value of the file in them", async (t) => {
  assert.equal(typeof tokens.LoginTokens, "function", "the runner has a reader of the login's access token");
  const posts = noPosts(t);
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
  assert.deepEqual(posts, [], "none of these is renewed");
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

test("a run's own process holds each token its runner hands before its CLI has it, and tells its runner a token Anthropic refused", async (t) => {
  assert.equal(typeof tokens.heldTokenLogin, "function", "a run's own process wraps its runner's reader (claude-login-token.ts heldTokenLogin)");
  const handed = fake("access-handed");
  const redacted = [];
  const told = [];
  const login = tokens.heldTokenLogin({ token: async () => handed, refused: async (sent) => void told.push(sent) }, (values) => redacted.push(...values));
  assert.equal(await login.token(), handed);
  assert.deepEqual(redacted, [handed], "held by the run's redactors");
  assert.ok(hostSecrets({}).includes(handed), "and by this process's own");
  assert.deepEqual(Object.keys(login), ["token", "refused"], "a reader alone: no folder, no refresh token");
  await login.refused(handed);
  assert.deepEqual(told, [handed], "the refused token told to the runner, which renews it");
});

test("the pinned CLI's own write of a login (credentials-cli-2.1.286.json) reads: its access token, to its end; within the margin it is renewed with the login's own client id and scopes", async (t) => {
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
  const bodies = [];
  const failing = async (_, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(new tokens.LoginTokens({ login, now: () => end - 60_000, fetch: failing }).token(), { message: tokens.LOGIN_RUNNING_OUT });
  assert.deepEqual(bodies, [{ grant_type: "refresh_token", refresh_token: written.claudeAiOauth.refreshToken, client_id: written.claudeAiOauth.clientId, scope: written.claudeAiOauth.scopes.join(" ") }], "the login names its client and scopes: the CLI sends those");
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
