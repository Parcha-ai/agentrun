import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { codeStorage, GitRemoteError, https, MAIN, openRepo } from "../dist/index.js";
import { filesContaining, makeSecret, rawGit, recordingGit, refsOf, scratch, sha256 } from "./support.mjs";
import { basicFor, plantEchoingRefusal, plantRefPolicy, serverRepos, startGitServer } from "./smart-http.mjs";

const REPO = "agents/a1";
const PLAIN = `${REPO}.git`;
const EPHEMERAL = `${REPO}+ephemeral.git`;
const WHOLE = { timeout: 120_000 };
const formatted = (username, password) => `username=${username}\npassword=${password}\n`;
/** An https URL carrying userinfo, built at test time. */
function withUserinfo(url, username, password) {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.href;
}
const everything = (error) => `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;

/** A TLS smart-HTTP server over bare repositories (the first seeded with main), with a ref policy planted in each, a
 *  recording git that runs for real and trusts only that server's certificate, and `host` to open a repo through it. */
async function fixture({ ephemeral = false, echoToken = false } = {}) {
  const root = await scratch();
  const serverRoot = path.join(root, "server");
  const names = ephemeral ? [PLAIN, EPHEMERAL] : [PLAIN];
  const { dirs, main } = await serverRepos(serverRoot, names);
  for (const dir of Object.values(dirs)) await plantRefPolicy(dir, "run");
  const server = await startGitServer({ root: serverRoot, names, echoToken });
  const fake = await recordingGit(root, { live: true, inject: { GIT_SSL_CAINFO: server.caFile } });
  let opened = 0;
  const host = (remote) => openRepo({ dir: path.join(root, `host-${opened++}`), remote, git: fake.git });
  return { root, server, dirs, main, fake, host };
}

const isNetwork = (call) => (call.verb === "fetch" || call.verb === "push") && call.argv.some((a) => a.startsWith("https://"));

/** The token reached git only as the fd-3 file: not argv, not the environment, not a URL, not any file under the root. */
async function assertTokenStaysInMemory(f, token) {
  const calls = await f.fake.calls();
  const network = calls.filter(isNetwork);
  assert.ok(network.length >= 3, "git talked to the server in several processes");
  const expected = sha256(formatted("t", token));
  for (const call of network) {
    assert.equal(call.fd3, expected, `${call.verb} inherited the credential on fd 3`);
    assert.equal(call.helpers, 1, "every other credential helper was cleared before ours");
  }
  for (const call of calls.filter((c) => !isNetwork(c))) assert.equal(call.fd3, null, `${call.verb} got no credential`);
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.argv).includes(token), `${call.verb}: not in argv`);
    assert.ok(!JSON.stringify(call.env).includes(token), `${call.verb}: not in the environment`);
    assert.ok(!call.argv.some((a) => /^https:\/\/[^/]*@/.test(a)), `${call.verb}: no userinfo in a URL`);
  }
  assert.deepEqual(await filesContaining(f.root, token), [], "no file under the root holds it: host repositories, the server's, the call log");
}

/** Every request that carried a credential carried this token, and the server answered it. */
function assertOnlyThisToken(f, token) {
  const seen = f.server.requests;
  assert.ok(seen.some((r) => r.authorization === basicFor(token) && r.status === 200), "an authenticated request succeeded");
  for (const r of seen) {
    if (r.authorization === null) assert.equal(r.status, 401, "git's first request carries no credential and is challenged");
    else assert.equal(r.authorization, basicFor(token), "Basic, user t, this token");
  }
  assert.deepEqual(f.server.rejected, [], "nothing but git's own requests reached the server");
}

test("https: clone-side reads and a push work through a TLS smart-HTTP server, and the token never leaves the fd-3 file", WHOLE, async () => {
  const f = await fixture();
  const token = makeSecret();
  f.server.allow(token, "run");
  const remote = () => https(f.server.url(PLAIN), () => ({ username: "t", password: token }));
  const repo = await f.host(remote());
  assert.equal(await repo.resolve(MAIN), f.main);
  assert.equal(await repo.read("README.md", f.main), "seed\n");
  const into = path.join(f.root, "work");
  await mkdir(into);
  assert.deepEqual((await repo.checkout(MAIN, { into })).files, ["README.md"]);

  const run = await repo.commitTo("runs/r1", { files: { "inbox/r1.md": "a lesson\n" }, message: "r1", trailers: { "Run-Id": "r1" } });
  await repo.push(run.sha, "runs/r1");
  assert.deepEqual(await refsOf(f.dirs[PLAIN]), { "refs/heads/main": f.main, "refs/heads/runs/r1": run.sha });

  const other = await f.host(remote());
  assert.equal(await other.resolve("runs/r1"), run.sha, "a second host fetches what the first pushed");
  assert.equal(await other.read("inbox/r1.md", run.sha), "a lesson\n");
  assert.equal((await other.commitTo("runs/r1", { files: { "inbox/r1.md": "again\n" }, message: "r1", trailers: { "Run-Id": "r1" } })).created, false);

  assertOnlyThisToken(f, token);
  await assertTokenStaysInMemory(f, token);
});

test("codeStorage: the same flow, as user t with the JWT as the Basic password, from an async token callback", WHOLE, async () => {
  const f = await fixture();
  const token = makeSecret();
  f.server.allow(token, "run");
  const remote = codeStorage({ origin: f.server.origin, repo: REPO, token: async () => token });
  assert.equal(remote.url, f.server.url(PLAIN));
  assert.equal(remote.pushUrl, undefined, "no hidden namespace unless asked");
  const repo = await f.host(remote);
  assert.equal(await repo.resolve(MAIN), f.main);
  const run = await repo.commitTo("runs/r1", { files: { "inbox/r1.md": "a lesson\n" }, message: "r1", trailers: { "Run-Id": "r1" } });
  await repo.push(run.sha, "runs/r1");
  assert.equal((await refsOf(f.dirs[PLAIN]))["refs/heads/runs/r1"], run.sha);
  assert.ok(f.server.requests.every((r) => r.name === PLAIN), "every request names <repo>.git");

  assertOnlyThisToken(f, token);
  await assertTokenStaysInMemory(f, token);
});

test("a token minted again is the one the next git process uses; a revoked token never comes back", WHOLE, async () => {
  const f = await fixture();
  const minted = [];
  const mint = async () => {
    const token = makeSecret();
    if (minted.length) f.server.revoke(minted.at(-1));
    f.server.allow(token, "run");
    minted.push(token);
    return token;
  };
  const repo = await f.host(codeStorage({ origin: f.server.origin, repo: REPO, token: mint }));
  const run = await repo.commitTo("runs/r1", { files: { "inbox/r1.md": "x\n" }, message: "r1" });
  await repo.push(run.sha, "runs/r1");
  assert.equal(await repo.resolve(MAIN), f.main);

  const network = (await f.fake.calls()).filter(isNetwork);
  assert.ok(network.length >= 4);
  assert.equal(minted.length, network.length, "the callback ran once for each git process that talked to the server");
  assert.deepEqual(network.map((c) => c.fd3), minted.map((t) => sha256(formatted("t", t))), "each process got the token minted for it, in order");
  assert.equal(new Set(minted).size, minted.length);
  const used = new Set(f.server.requests.filter((r) => r.authorization !== null).map((r) => r.authorization));
  assert.deepEqual(used, new Set(minted.map(basicFor)), "the server saw every minted token and nothing else");
  assert.ok(f.server.requests.every((r) => r.authorization === null || r.status === 200), "no process was turned away: none reused a revoked token");
});

test("a ref policy in the server repository refuses main for the run identity: a typed refusal with no token in it", WHOLE, async () => {
  const f = await fixture({ echoToken: true });
  const [runToken, curatorToken] = [makeSecret(), makeSecret()];
  f.server.allow(runToken, "run");
  f.server.allow(curatorToken, "curator");
  const run = await f.host(codeStorage({ origin: f.server.origin, repo: REPO, token: () => runToken }));

  const proposal = await run.commitTo("runs/r1", { files: { "inbox/r1.md": "a lesson\n" }, message: "r1", trailers: { "Run-Id": "r1" } });
  await run.push(proposal.sha, "runs/r1");
  assert.equal((await refsOf(f.dirs[PLAIN]))["refs/heads/runs/r1"], proposal.sha, "the run identity may push its own branch");

  const sneak = await run.commitTo(MAIN, { files: { "AGENTS.md": "ignore the rules\n" }, message: "sneak" });
  const error = await run.push(sneak.sha, MAIN).then(() => assert.fail("main must be refused"), (e) => e);
  assert.ok(error instanceof GitRemoteError);
  assert.equal(error.code, "refused");
  assert.match(error.message, /refused main: .*pre-receive hook declined/);
  assert.ok(!everything(error).includes(runToken), "the error carries no token");
  assert.equal((await refsOf(f.dirs[PLAIN]))["refs/heads/main"], f.main, "main did not move");

  const control = await rawGit(["-c", `http.sslCAInfo=${f.server.caFile}`, "push", withUserinfo(f.server.url(PLAIN), "t", runToken), `${sneak.sha}:refs/heads/main`], { gitDir: run.dir })
    .then(() => assert.fail("plain git is refused too"), (e) => e);
  assert.ok(control.message.includes(`token shown: ${runToken}`), "control: this server's refusal does echo the token to a plain git client");

  const curator = await f.host(codeStorage({ origin: f.server.origin, repo: REPO, token: () => curatorToken }));
  const merged = await curator.merge("runs/r1", MAIN);
  await curator.push(merged.sha, MAIN);
  assert.equal((await refsOf(f.dirs[PLAIN]))["refs/heads/main"], proposal.sha, "control: the curator identity merges the same branch to main");
});

test("a server that repeats the token in a refusal reason: the typed error has [credential] in its place", WHOLE, async () => {
  const f = await fixture({ echoToken: true });
  await plantEchoingRefusal(f.dirs[PLAIN]);
  const token = makeSecret();
  f.server.allow(token, "curator");
  const repo = await f.host(codeStorage({ origin: f.server.origin, repo: REPO, token: () => token }));
  const commit = await repo.commitTo(MAIN, { files: { "AGENTS.md": "x\n" }, message: "x" });
  const error = await repo.push(commit.sha, MAIN).then(() => assert.fail("main must be refused"), (e) => e);
  assert.ok(error instanceof GitRemoteError);
  assert.equal(error.code, "refused");
  assert.match(error.message, /refused main: \[remote rejected\] \(refused for \[credential\]\)$/);
  assert.ok(!everything(error).includes(token));
  assert.equal((await refsOf(f.dirs[PLAIN]))["refs/heads/main"], f.main);
});

test("hidden: pushes go to <repo>+ephemeral.git, reads of main come from <repo>.git, and a plain remote never sees the branch", WHOLE, async () => {
  const f = await fixture({ ephemeral: true });
  const token = makeSecret();
  f.server.allow(token, "run");
  const hidden = () => codeStorage({ origin: f.server.origin, repo: REPO, token: () => token, hidden: true });
  const remote = hidden();
  assert.equal(remote.url, f.server.url(PLAIN));
  assert.equal(remote.pushUrl, f.server.url(EPHEMERAL));

  const run = await f.host(remote);
  assert.equal(await run.resolve(MAIN), f.main, "main is read from <repo>.git");
  const proposal = await run.commitTo("runs/r1", { files: { "inbox/r1.md": "a lesson\n" }, message: "r1", trailers: { "Run-Id": "r1" } });
  await run.push(proposal.sha, "runs/r1");
  assert.deepEqual(await refsOf(f.dirs[EPHEMERAL]), { "refs/heads/runs/r1": proposal.sha });
  assert.deepEqual(await refsOf(f.dirs[PLAIN]), { "refs/heads/main": f.main }, "the plain repository is untouched");
  const pushes = f.server.requests.filter((r) => r.tail === "git-receive-pack");
  assert.ok(pushes.length >= 1);
  assert.ok(pushes.every((r) => r.name === EPHEMERAL), "every push went to the ephemeral path");

  const before = f.server.requests.filter((r) => r.name === EPHEMERAL).length;
  const reader = await f.host(codeStorage({ origin: f.server.origin, repo: REPO, token: () => token }));
  assert.equal(await reader.resolve("runs/r1"), undefined, "a normal clone does not see the run branch");
  assert.equal(await reader.resolve(MAIN), f.main);
  assert.equal(f.server.requests.filter((r) => r.name === EPHEMERAL).length, before, "a plain remote never contacts the ephemeral path");

  const restarted = await f.host(hidden());
  assert.equal(await restarted.resolve("runs/r1"), proposal.sha, "the hidden remote fetches the push URL too");
  assert.deepEqual(await restarted.commitTo("runs/r1", { files: { "inbox/r1.md": "y\n" }, message: "r1", trailers: { "Run-Id": "r1" } }), { sha: proposal.sha, created: false });
});

test("a URL with userinfo, a query or a fragment is refused before any git process starts, and the refusal never repeats it", async () => {
  const root = await scratch();
  const fake = await recordingGit(root);
  const secret = makeSecret();
  const credential = () => ({ username: "t", password: "unused" });
  const cases = [
    () => https(withUserinfo("https://git.example.test/acme.git", "bot", secret), credential),
    () => https(`https://${secret}@git.example.test/acme.git`, credential),
    () => https("https://git.example.test/acme.git", credential, { pushUrl: withUserinfo("https://git.example.test/acme+ephemeral.git", "bot", secret) }),
    () => https(`https://git.example.test/acme.git?token=${secret}`, credential),
    () => https(`https://git.example.test/acme.git#${secret}`, credential),
    () => https(`http://git.example.test/${secret}.git`, credential),
    () => codeStorage({ origin: withUserinfo("https://git.example.test", "bot", secret), repo: REPO, token: () => secret }),
    () => codeStorage({ origin: `https://git.example.test/?token=${secret}`, repo: REPO, token: () => secret }),
    () => codeStorage({ origin: `http://git.example.test/${secret}`, repo: REPO, token: () => secret }),
  ];
  for (const [i, make] of cases.entries()) {
    assert.throws(make, (e) => e instanceof GitRemoteError && e.code === "refused" && !everything(e).includes(secret), `case ${i}`);
  }
  await assert.rejects(
    openRepo({ dir: path.join(root, "h"), remote: { kind: "https", url: withUserinfo("https://git.example.test/acme.git", "bot", secret), credential }, git: fake.git }),
    (e) => e.code === "refused" && /userinfo/.test(e.message) && !everything(e).includes(secret));
  assert.deepEqual(await fake.calls(), [], "git never ran");
});

test("https and codeStorage build the URLs they should and refuse what is not a usable remote", () => {
  const credential = () => ({ username: "t", password: "unused" });
  const plain = https("https://git.example.test/acme.git", credential);
  assert.deepEqual({ ...plain }, { kind: "https", url: "https://git.example.test/acme.git", credential });
  assert.ok(Object.isFrozen(plain));
  assert.equal(https("https://git.example.test/a.git", credential, { pushUrl: "https://git.example.test/b.git" }).pushUrl, "https://git.example.test/b.git");
  assert.throws(() => https("https://git.example.test/a.git", undefined), { code: "refused" });
  assert.throws(() => https("https://git.example.test/a.git", "a string"), { code: "refused" });

  const token = () => "unused";
  const cs = (extra) => codeStorage({ origin: "https://git.example.test", repo: "agents/a1", token, ...extra });
  assert.equal(cs().url, "https://git.example.test/agents/a1.git");
  assert.equal(cs().pushUrl, undefined);
  assert.equal(cs({ hidden: false }).pushUrl, undefined);
  assert.equal(cs({ hidden: true }).url, "https://git.example.test/agents/a1.git");
  assert.equal(cs({ hidden: true }).pushUrl, "https://git.example.test/agents/a1+ephemeral.git");
  const proxied = cs({ origin: "https://gateway.example.test:8443/git/", hidden: true });
  assert.deepEqual([proxied.url, proxied.pushUrl], ["https://gateway.example.test:8443/git/agents/a1.git", "https://gateway.example.test:8443/git/agents/a1+ephemeral.git"]);
  assert.equal(cs({ repo: "users/U2abc.def_g-h" }).url, "https://git.example.test/users/U2abc.def_g-h.git");
  assert.equal(proxied.kind, "https");
  assert.equal(typeof proxied.credential, "function");

  for (const bad of [{ origin: undefined }, { origin: "" }, { origin: "git.example.test" }, { origin: "ssh://git.example.test" }, { origin: "file:///tmp/x" }]) {
    assert.throws(() => cs(bad), { code: "refused" }, JSON.stringify(bad));
  }
  const repos = ["", "/agents/a1", "agents/a1/", "agents//a1", "agents/../a1", "agents/.a1", "./a1", "agents/a1.git", "agents/a1+ephemeral", "agents/a b", "agents/a1?x=1", "agents/a1#x",
    "agents/a%2e1", "agents\\a1", "a/b/c/d/e", "agents/é", "x".repeat(201), undefined, 7];
  for (const repo of repos) assert.throws(() => cs({ repo }), { code: "refused" }, JSON.stringify(repo));
  assert.throws(() => cs({ token: undefined }), { code: "refused" });
  assert.throws(() => cs({ token: "a-string-is-not-a-callback" }), { code: "refused" });
  assert.throws(() => cs({ hidden: "yes" }), { code: "refused" });
  assert.throws(() => codeStorage(undefined), { code: "refused" });
});

test("a token callback that throws, returns nothing, or returns a line break fails as an error that never holds the value", WHOLE, async () => {
  const f = await fixture();
  const token = makeSecret();
  f.server.allow(token, "run");
  const open = (callback) => f.host(codeStorage({ origin: f.server.origin, repo: REPO, token: callback }));
  await assert.rejects(open(() => { throw new Error("the vault is down"); }), (e) => e.code === "git" && /credential callback failed/.test(e.message));
  await assert.rejects(open(async () => undefined), { code: "refused" });
  await assert.rejects(open(async () => ""), { code: "refused" });
  await assert.rejects(open(async () => `${token}\nurl=https://elsewhere.example.test/`), (e) => e.code === "refused" && !everything(e).includes(token));
  assert.deepEqual(f.server.requests, [], "no request was made without a usable credential");
});

test("a token the server does not know fails as a git error that never repeats it", WHOLE, async () => {
  const f = await fixture();
  const wrong = makeSecret();
  await assert.rejects(f.host(codeStorage({ origin: f.server.origin, repo: REPO, token: () => wrong })),
    (e) => e instanceof GitRemoteError && e.code === "git" && /Authentication failed/.test(e.message) && !everything(e).includes(wrong));
  assert.ok(f.server.requests.some((r) => r.authorization === basicFor(wrong) && r.status === 401), "the server saw it and turned it away");
  assert.deepEqual(await filesContaining(f.root, wrong), []);
});

test("the test server answers only git's own requests: a stray probe is closed, never challenged or recorded", WHOLE, async () => {
  const f = await fixture();
  const ask = (method, target, headers = {}) => new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port: new URL(f.server.origin).port, method, path: target, headers, ca: f.server.ca }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, challenge: res.headers["www-authenticate"] ?? null }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.deepEqual(await ask("GET", "/"), { status: 404, challenge: null });
  assert.deepEqual(await ask("GET", `/${PLAIN}/info/refs`), { status: 404, challenge: null });
  assert.deepEqual(await ask("GET", `/${PLAIN}/info/refs?service=git-receive-pack&x=1`), { status: 404, challenge: null });
  assert.deepEqual(await ask("GET", "/agents/other.git/info/refs?service=git-upload-pack"), { status: 404, challenge: null });
  assert.deepEqual(await ask("GET", `/${PLAIN}/HEAD`), { status: 404, challenge: null });
  assert.deepEqual(await ask("POST", `/${PLAIN}/git-receive-pack`, { "content-type": "text/plain" }), { status: 404, challenge: null });
  assert.equal(f.server.requests.length, 0, "none of those is a git request");
  assert.equal(f.server.rejected.length, 6);

  assert.deepEqual(await ask("GET", `/${PLAIN}/info/refs?service=git-upload-pack`), { status: 401, challenge: 'Basic realm="git"' });
  assert.equal(f.server.requests.length, 1);

  const plaintext = await new Promise((resolve) => {
    const socket = net.connect(Number(new URL(f.server.origin).port), "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    const got = [];
    socket.on("data", (chunk) => got.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(got).toString("latin1")));
    socket.on("error", () => undefined);
  });
  assert.ok(!/^HTTP\/1\.[01] [0-9]+/.test(plaintext), "a plaintext probe gets no HTTP answer from the TLS port");
  assert.equal(f.server.requests.length, 1);
});
