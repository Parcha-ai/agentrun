import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createGitRunner, GitRemoteError, MAIN, openRepo } from "../dist/index.js";
import { bareRepo, filesContaining, makeSecret, rawGit, recordingGit, scratch, sha256 } from "./support.mjs";

const URL_OF = "https://git.example.test/acme.git";
const NETWORK = new Set(["fetch", "push"]);
const formatted = (username, password) => `username=${username}\npassword=${password}\n`;
/** An https URL carrying userinfo, built at test time. */
function withUserinfo(url, username, password) {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.href;
}

test("real git reads the credential through the fd-3 helper, and never runs a helper from the repository's config", async () => {
  const root = await scratch();
  const markers = path.join(root, "markers");
  await mkdir(markers);
  const gitDir = await bareRepo(path.join(root, "host.git"));
  await rawGit(["config", "credential.helper", `!touch '${markers}/repo-helper'`], { gitDir });
  await rawGit(["config", `credential.${URL_OF}.helper`, `!touch '${markers}/url-helper'`], { gitDir });
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  await mkdir(home);
  await mkdir(tmp);
  const run = createGitRunner({ gitDir, home, tmp });
  const password = makeSecret();
  const ask = "protocol=https\nhost=git.example.test\npath=acme.git\n\n";
  const filled = await run(["credential", "fill"], { input: ask, credential: { username: "t", password } });
  assert.match(filled.stdout.toString(), new RegExp(`^username=t$`, "m"));
  assert.ok(filled.stdout.toString().includes(`password=${password}\n`), "git got the password from fd 3");
  const without = await run(["credential", "fill"], { input: ask, allowFail: true });
  assert.notEqual(without.code, 0, "with no credential, git neither prompts nor finds one");
  assert.match(without.stderr, /terminal prompts disabled/);
  assert.deepEqual(await readdir(markers), [], "the repository's own helpers never ran");
  assert.deepEqual(await readdir(tmp), [], "the credential's file was unlinked before it was written");
  assert.deepEqual(await filesContaining(root, password), []);
});

test("the credential never appears in argv, the environment, a URL or a file: a recording git on an https remote", async () => {
  const root = await scratch();
  const fake = await recordingGit(root);
  const password = makeSecret();
  let asked = 0;
  const remote = { kind: "https", url: URL_OF, credential: async () => { asked += 1; return { username: "t", password }; } };
  const repo = await openRepo({ dir: path.join(root, "host"), remote, git: fake.git });
  const { sha } = await repo.commitTo("runs/r1", { files: { "inbox/r1.md": "a lesson\n" }, message: "r1", trailers: { "Run-Id": "r1" } });
  await repo.push(sha, "runs/r1");
  await repo.log({ ref: MAIN });

  const calls = await fake.calls();
  const network = calls.filter((c) => NETWORK.has(c.verb));
  assert.deepEqual(network.map((c) => c.verb), ["fetch", "fetch", "push", "fetch", "fetch"]);
  assert.equal(asked, network.length, "asked once per git process that talks to the remote");
  const expected = sha256(formatted("t", password));
  for (const call of network) {
    assert.equal(call.fd3, expected, `${call.verb} inherited the credential on fd 3`);
    assert.equal(call.helpers, 1, "every other helper was cleared before ours");
    assert.equal(call.helperOut, expected, "the helper prints exactly what git needs");
  }
  for (const call of calls.filter((c) => !NETWORK.has(c.verb))) assert.equal(call.fd3, null, `${call.verb} got no credential`);
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.argv).includes(password), `${call.verb}: not in argv`);
    assert.ok(!JSON.stringify(call.env).includes(password), `${call.verb}: not in the environment`);
    assert.ok(!call.argv.some((a) => /^https:\/\/[^/]*@/.test(a)), `${call.verb}: no userinfo in a URL`);
  }
  assert.deepEqual(await filesContaining(root, password), [], "no file anywhere holds it, the host repository included");
});

test("a git that prints the credential when it fails: the error carries [credential], never the value", async () => {
  const root = await scratch();
  const fake = await recordingGit(root, { leak: true });
  const password = makeSecret();
  const repo = await openRepo({ dir: path.join(root, "host"), remote: { kind: "https", url: URL_OF, credential: () => ({ username: "t", password }) }, git: fake.git });
  const { sha } = await repo.commitTo(MAIN, { files: { "a.md": "a\n" }, message: "a" });
  const error = await repo.push(sha, MAIN).then(() => assert.fail("the push should fail"), (e) => e);
  assert.ok(error instanceof GitRemoteError);
  assert.equal(error.code, "git");
  assert.ok(error.message.includes("[credential]"), error.message);
  assert.ok(!`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(password));
});

test("openRepo refuses a remote URL with userinfo and never repeats it", async () => {
  const root = await scratch();
  const fake = await recordingGit(root);
  const password = makeSecret();
  const remotes = [
    { kind: "https", url: withUserinfo(URL_OF, "bot", password) },
    { kind: "https", url: withUserinfo(URL_OF, password, "") },
    { kind: "https", url: URL_OF, pushUrl: withUserinfo("https://git.example.test/acme-hidden.git", "bot", password) },
  ];
  for (const [i, remote] of remotes.entries()) {
    await assert.rejects(openRepo({ dir: path.join(root, `host-${i}`), remote, git: fake.git }), (e) =>
      e instanceof GitRemoteError && e.code === "refused" && /userinfo/.test(e.message) && !`${e.message}${e.stack}`.includes(password));
  }
  assert.deepEqual(await fake.calls(), [], "git never ran");
});

test("a credential with a line break, a local remote with a credential, and a callback that throws are refused without the value", async () => {
  const root = await scratch();
  const fake = await recordingGit(root);
  const password = makeSecret();
  const injected = { kind: "https", url: URL_OF, credential: () => ({ username: "t", password: `${password}\nurl=https://elsewhere.example.test/` }) };
  await assert.rejects(openRepo({ dir: path.join(root, "h1"), remote: injected, git: fake.git }), (e) => e.code === "refused" && !e.message.includes(password));
  const bare = await bareRepo(path.join(root, "remote.git"));
  await assert.rejects(openRepo({ dir: path.join(root, "h2"), remote: { kind: "local", url: bare, credential: () => ({ username: "t", password }) } }), { code: "refused" });
  const throwing = { kind: "https", url: URL_OF, credential: () => { throw new Error("the vault is down"); } };
  await assert.rejects(openRepo({ dir: path.join(root, "h3"), remote: throwing, git: fake.git }), (e) => e.code === "git" && /credential callback failed/.test(e.message));
  const none = { kind: "https", url: URL_OF, credential: () => undefined };
  await openRepo({ dir: path.join(root, "h4"), remote: none, git: fake.git });
  const fetches = (await fake.calls()).filter((c) => c.verb === "fetch");
  assert.deepEqual(fetches.map((c) => [c.fd3, c.helpers]), [[null, 0]], "no credential: no descriptor and no helper");
  assert.deepEqual(await filesContaining(root, password), []);
});
