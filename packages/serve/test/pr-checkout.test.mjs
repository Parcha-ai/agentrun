// The server's checkout of a run's pull request (runner/pr-checkout.ts), on a run's local Workspace, with a folder of bare
// repositories or git's own HTTP server on loopback standing in for GitHub: no network. The checkout lands at the head
// with the base and the merge base reachable (a merge base past the first fetch's depth included), keeps no credential in
// the run's folder, its git config or its remote's URL, is removed at the end, and a run it could not be made for is told
// why in words. The definition and the template field it is declared by (validate.ts, templates.ts), and the payload tag
// it reads (github.ts githubPullOf).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git, gitHttp, pullRepo } from "./fixtures/git-http.mjs";
import { stranger } from "./fixtures/stranger.mjs";

const { prCheckout, repoCheckout, CHECKOUT_DIR } = await import("../dist/runner/pr-checkout.js");
const { githubPullOf } = await import("../dist/github.js");
/** githubPullOf for a run a github trigger started (its launch's inputOrigin). */
const githubPullOf_ = (content) => githubPullOf(content, { payload: true });
const { localWorkspace } = await import("../dist/workspace/local.js");

/** A scratch folder for test `t`, removed after it. */
async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pr-checkout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A run's local folder under `dir`, and its Workspace. */
async function runFolder(dir) {
  const folder = join(dir, "run");
  await mkdir(folder, { recursive: true });
  return { folder, workspace: localWorkspace(folder) };
}

/** A run's first input, as a GitHub pull_request firing gives it (triggers.ts inputOf). */
const firing = (repo, { number = 7, head, base, installation = 777 }) => ({
  content: `Review the pull request.\n\n<trigger-payload source="github" scheme="github" event="pull_request" action="opened" installation="${installation}" repo="${repo}" number="${number}" head_sha="${head}"${base ? ` base_sha="${base}"` : ""} untrusted>\n{"action":"opened"}\n</trigger-payload>\n\n(From the GitHub trigger "prs", received at now.)`,
});

/** Every file under `dir`, as text, for a search of what was left in it. */
async function everyFile(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(await readFile(join(entry.parentPath, entry.name), "latin1"));
  }
  return out.join("\n");
}

test("githubPullOf reads the pull request from the server's payload tag alone, and only on a github trigger's run: its repository, number, head and base; a comment's tag, a webhook's, words before the tag and a bad repository name give none", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  assert.deepEqual(githubPullOf_(firing("acme/widgets", { head, base }).content), { repo: "acme/widgets", number: 7, head, base, installation: 777 });
  assert.deepEqual(githubPullOf_(firing("acme/widgets", { head }).content), { repo: "acme/widgets", number: 7, head, installation: 777 }, "no base named: none guessed");
  assert.equal(githubPullOf_('Review.\n\n<trigger-payload source="github" repo="acme/widgets" number="9" untrusted>\n{}\n</trigger-payload>'), undefined, "a comment's tag has no head");
  assert.equal(githubPullOf_(`Review.\n\n<trigger-payload source="webhook" scheme="github" repo="acme/widgets" number="7" head_sha="${head}" untrusted>\n{}\n</trigger-payload>`), undefined, "a webhook trigger's tag is not the App's");
  assert.equal(githubPullOf_(`Review https://github.com/acme/widgets/pull/7 at ${head}`), undefined, "words name no pull request to fetch");
  for (const repo of ["acme/..", "acme/widgets/extra", "-acme/widgets", "acme/wid gets"]) assert.equal(githubPullOf_(firing(repo, { head }).content), undefined, repo);
  assert.equal(githubPullOf(firing("acme/widgets", { head, base }).content), undefined, "a run no github trigger started: its tag is anyone's text, never read");
});

test("the checkout lands in repo/ at the pull request's head, detached, with its base and a merge base past the first fetch's depth reachable; the run is told so; the end removes it", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  // The base moved on 60 commits past the merge base: deeper than the first fetch (50), so the checkout deepens.
  const { head, base, mergeBase } = pullRepo(gh, "acme/widgets", { shared: 4, ahead: 2, behind: 60 });
  const { folder, workspace } = await runFolder(dir);
  const made = await prCheckout({ workspace, fromGitHub: true, input: firing("acme/widgets", { head, base }), web: `file://${gh}` });
  const repo = join(folder, CHECKOUT_DIR);
  assert.equal(git(repo, "rev-parse", "HEAD"), head, made.note);
  assert.equal(git(repo, "rev-parse", "pr/head"), head);
  assert.equal(git(repo, "rev-parse", "pr/base"), base);
  assert.equal(git(repo, "rev-parse", "pr/merge-base"), mergeBase);
  assert.throws(() => git(repo, "symbolic-ref", "-q", "HEAD"), "detached: HEAD names no branch");
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "the head's readme 1\n");
  assert.equal(git(repo, "diff", "--name-only", "pr/merge-base", "pr/head"), "README.md", "the change read from the merge base");
  assert.equal(git(repo, "remote", "get-url", "origin"), `file://${gh}/acme/widgets.git`);
  assert.match(made.note, new RegExp(`acme/widgets#7 is checked out in repo/, detached at its head ${head}`));
  assert.match(made.note, new RegExp(`merge base ${mergeBase} \\(ref pr/merge-base\\)`));
  await made.end();
  assert.deepEqual(await readdir(folder), [], "the end removed the checkout");
  await made.end();
});

test("every fetch the checkout makes runs with Git's background maintenance and gc off, the deepening fetches included: a detached gc would write into .git/objects while the checkout's removal deletes it", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  // 60 commits behind forces deepening fetches after the first.
  const { head, base } = pullRepo(gh, "acme/widgets", { shared: 4, ahead: 2, behind: 60 });
  const { workspace } = await runFolder(dir);
  // The run's shell has a fixed PATH, so the spy goes in front of it: a `git` that records its arguments, then runs the real one.
  const spy = join(dir, "spy");
  const log = join(dir, "git-calls.log");
  await mkdir(spy);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(spy, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const spied = Object.create(workspace);
  spied.exec = (argv, options) => workspace.exec(argv, { ...options, env: { ...options.env, PATH: `${spy}:${options.env.PATH}` } });
  const made = await prCheckout({ workspace: spied, fromGitHub: true, input: firing("acme/widgets", { head, base }), web: `file://${gh}` });
  const fetches = readFileSync(log, "utf8").split("\n").filter((line) => / fetch /.test(` ${line} `));
  assert.ok(fetches.length >= 2, `the first fetch and at least one deepening: ${fetches.join(" | ")}`);
  for (const line of fetches) {
    assert.match(line, /maintenance\.auto=false/, `no background maintenance: ${line}`);
    assert.match(line, /gc\.auto=0/, `no auto gc: ${line}`);
  }
  await made.end();
});

test("a merge base the shallow fetch shows through an old side branch is not taken while a newer one is cut off: the checkout deepens to the true merge base", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  // main: 45 commits (c0..c44), the base at c44. The pull request branches at c40 and has 60 commits, then merges a side
  // branch that left c0 (its merge commit is the head). The first fetch (50 deep) reaches c0 through the side branch and
  // so sees c0 as common to both, while the true merge base c40 lies past the branch's 50th commit.
  const work = join(dir, "work");
  await mkdir(work, { recursive: true });
  const commit = (file, text) => {
    writeFileSync(join(work, file), `${text}\n`);
    git(work, "add", file);
    git(work, "commit", "-q", "-m", `${file}: ${text}`);
  };
  git(work, "init", "-q", "-b", "main");
  let c40;
  for (let i = 0; i < 45; i++) {
    commit("main.txt", `main ${i}`);
    if (i === 0) git(work, "branch", "side");
    if (i === 40) c40 = git(work, "rev-parse", "HEAD");
  }
  const base = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "side");
  commit("side.txt", "an old side branch");
  git(work, "checkout", "-q", "-b", "feature", c40);
  for (let i = 0; i < 60; i++) commit("README.md", `the head's readme ${i}`);
  git(work, "merge", "-q", "--no-ff", "-m", "merge the side branch", "side");
  const head = git(work, "rev-parse", "HEAD");
  const bare = join(gh, "acme", "widgets.git");
  await mkdir(join(gh, "acme"), { recursive: true });
  git(dir, "clone", "-q", "--bare", work, bare);
  const { folder, workspace } = await runFolder(dir);
  const made = await prCheckout({ workspace, fromGitHub: true, input: firing("acme/widgets", { head, base }), web: `file://${gh}` });
  const repo = join(folder, CHECKOUT_DIR);
  assert.equal(git(repo, "rev-parse", "HEAD"), head, made.note);
  assert.equal(git(repo, "rev-parse", "pr/merge-base"), c40, "the newest shared commit, not the old one the side branch shows");
  await made.end();
});

test("a claim that lets go late removes only its own checkout: a later claim's checkout of the same run stays until that claim lets go", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const { head, base } = pullRepo(gh, "acme/widgets");
  const { folder, workspace } = await runFolder(dir);
  const input = firing("acme/widgets", { head, base });
  const lost = await prCheckout({ workspace, fromGitHub: true, input, web: `file://${gh}` });
  // The lease passed to another claim, which checks out the same run before the lost one's release runs.
  const next = await prCheckout({ workspace, fromGitHub: true, input, web: `file://${gh}` });
  await lost.end();
  assert.equal(git(join(folder, CHECKOUT_DIR), "rev-parse", "HEAD"), head, "the later claim's checkout is still there");
  await next.end();
  assert.deepEqual(await readdir(folder), [], "its own claim's release removed it");
});

test("with the GitHub App, the fetch carries a token minted for the one repository with contents read alone, held by the run's redactor, and the run's folder keeps none: not in .git/config, the remote's URL or any file", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const { head, base, mergeBase } = pullRepo(gh, "acme/private");
  const token = `ghs_${"T".repeat(36)}`;
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const server = await gitHttp(t, gh, { authorization });
  const mints = [];
  const held = [];
  const mint = async (target, permissions) => (mints.push({ target, permissions }), { ok: true, token, expires_at: Date.now() + 3600_000 });
  const { folder, workspace } = await runFolder(dir);
  const revoked = [];
  const made = await prCheckout({ workspace, fromGitHub: true, input: firing("acme/private", { head, base }), mint, revoke: async (gone) => void revoked.push(gone), hold: (secrets) => held.push(...secrets), web: server.url });
  assert.deepEqual(revoked, [token], "revoked once the fetch was done");
  const repo = join(folder, CHECKOUT_DIR);
  assert.equal(git(repo, "rev-parse", "HEAD"), head, made.note);
  assert.equal(git(repo, "rev-parse", "pr/merge-base"), mergeBase);
  assert.deepEqual(mints, [{ target: { repo: "acme/private", installation: 777 }, permissions: { contents: "read" } }]);
  assert.ok(held.includes(token), "the token joined the run's redactor before it was used");
  assert.ok(server.seen.length > 0 && server.seen.every((request) => request.authorization === authorization), "every request carried the token's header");
  assert.equal(git(repo, "remote", "get-url", "origin"), `${server.url}/acme/private.git`, "the remote's URL holds no credential");
  const config = await readFile(join(repo, ".git", "config"), "utf8");
  assert.ok(!/extraheader|x-access-token|credential/i.test(config), config);
  const left = await everyFile(folder);
  for (const secret of [token, authorization, authorization.slice("Basic ".length)]) assert.ok(!left.includes(secret), "no file of the run's folder holds the token");
  assert.ok(!made.note.includes(token));
  await made.end();
  assert.deepEqual(await readdir(folder), []);
});

/** Each checkout's script, run with the App's token over `server`: a pull request's (deepened past its first fetch) and
 *  a repository's, each landing at its commit in the run's folder. */
const SCRIPTS = {
  pull_request: { run: (options, server) => prCheckout({ ...options, fromGitHub: true, input: firing("acme/private", server.pull), web: server.url }), at: (pull) => pull.head },
  repository: { run: (options, server) => repoCheckout({ ...options, repo: "acme/private", web: server.url }), at: (pull) => pull.base },
};

/** A git server holding acme/private (60 commits behind, so the pull request's checkout deepens; `shape` is pullRepo's),
 *  which takes only the App's token's header, and a mint that gives that token. */
async function privateServer(t, dir, shape = { shared: 4, ahead: 2, behind: 60 }) {
  const gh = join(dir, "gh");
  const pull = pullRepo(gh, "acme/private", shape);
  const token = `ghs_${"H".repeat(36)}`;
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const server = await gitHttp(t, gh, { authorization });
  return { url: server.url, seen: server.seen, pull, authorization, mint: async () => ({ ok: true, token, expires_at: Date.now() + 3600_000 }) };
}

/** The system's own `name`, found in /usr/bin and /bin. */
const system = (name) => execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();

/** A program `name` in `folder` that appends its name to `marks`, then runs the real one: what a program planted ahead of
 *  the system's would do. */
function planted(folder, name, marks) {
  writeFileSync(join(folder, name), `#!${system("sh")}\nprintf '%s\\n' '${name}' >> '${marks}'\nexec '${system(name)}' "$@"\n`, { mode: 0o755 });
}

/** git's subcommand in a logged argument list: the first word that is not an option or a `-c` option's value. */
function subcommandOf(args) {
  const words = args.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "-c") i++;
    else if (!words[i].startsWith("-")) return words[i];
  }
  return undefined;
}

for (const [kind, script] of Object.entries(SCRIPTS)) {
  test(`checkout ${kind}, run: the Authorization header is in the environment of the git calls that reach GitHub alone (fetch, ls-remote), never of the script or any other git call; every git call runs with core.hooksPath=/dev/null; git init copies no template, so neither a template's hook nor its config runs`, { timeout: 120_000 }, async (t) => {
    const dir = await scratch(t);
    const server = await privateServer(t, dir);
    const { folder, workspace } = await runFolder(dir);
    // A git in front of the run's PATH that logs whether the header is in its environment and its arguments, then runs the
    // real one; a template (as an image's /usr/share/git-core/templates would be) whose hooks and config hooksPath would
    // leave a mark if git ran them.
    const spy = join(dir, "spy");
    const log = join(dir, "git-calls.log");
    const marks = join(dir, "hook-marks.log");
    await mkdir(spy);
    writeFileSync(join(spy, "git"), `#!${system("sh")}\nprintf '%s\\t%s\\t%s\\n' "\${GIT_CONFIG_VALUE_0+header}" "\${GIT_CONFIG_COUNT+count}" "$*" >> '${log}'\nexec '${system("git")}' "$@"\n`, { mode: 0o755 });
    const template = join(dir, "template");
    const hooks = join(dir, "hooks");
    await mkdir(join(template, "hooks"), { recursive: true });
    await mkdir(hooks);
    for (const at of [join(template, "hooks"), hooks]) {
      for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) writeFileSync(join(at, hook), `#!/bin/sh\nprintf '%s\\n' '${at}/${hook}' >> '${marks}'\n`, { mode: 0o755 });
    }
    writeFileSync(join(template, "config"), `[core]\n\thooksPath = ${hooks}\n`);
    const spied = Object.create(workspace);
    spied.exec = (argv, options) => workspace.exec(argv, { ...options, env: { ...options.env, PATH: `${spy}:${options.env.PATH}`, GIT_TEMPLATE_DIR: template } });
    const made = await script.run({ workspace: spied, mint: server.mint }, server);
    assert.equal(git(join(folder, CHECKOUT_DIR), "rev-parse", "HEAD"), script.at(server.pull), made.note);
    assert.ok(server.seen.length > 0 && server.seen.every((request) => request.authorization === server.authorization), "every request carried the token's header");
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => {
      const [header, count, args] = line.split("\t");
      return { header: header === "header", count: count === "count", args, command: subcommandOf(args) };
    });
    t.diagnostic(calls.map((call) => `${call.header ? "H" : "-"} ${call.args}`).join(" | "));
    const network = new Set(["fetch", "ls-remote"]);
    assert.ok(calls.filter((call) => call.command === "fetch").length >= (kind === "pull_request" ? 2 : 1), "the fetches ran (a pull request's deepened)");
    for (const call of calls) {
      assert.equal(call.header, network.has(call.command), `the header is in ${call.command}'s environment only if it reaches GitHub: ${call.args}`);
      assert.equal(call.count, network.has(call.command), `GIT_CONFIG_COUNT likewise: ${call.args}`);
      assert.match(` ${call.args} `, / -c core\.hooksPath=\/dev\/null /, `hooks off: ${call.args}`);
      if (network.has(call.command)) {
        assert.match(` ${call.args} `, / -c http\.sslVerify=true /, `TLS verified on a call that reaches GitHub: ${call.args}`);
        assert.match(` ${call.args} `, / -c http\.proxy= /, `no proxy on a call that reaches GitHub: ${call.args}`);
      }
    }
    const init = calls.find((call) => call.command === "init");
    assert.match(` ${init?.args} `, / --template= /, "git init copies no template");
    assert.ok(!existsSync(marks), `no hook ran: ${existsSync(marks) ? readFileSync(marks, "utf8") : ""}`);
    await made.end();
  });

  test(`checkout ${kind}, run: a proxy, sslVerify=false and an insteadOf, generic and for the fetch's own URL, that another writer of the run's folder puts in its ${CHECKOUT_DIR}/.git/config before the fetch are never read by a git that reaches GitHub: the fetch runs in a private folder and goes to GitHub itself`, { timeout: 120_000 }, async (t) => {
    const dir = await scratch(t);
    const server = await privateServer(t, dir);
    const { folder, workspace } = await runFolder(dir);
    // A proxy that keeps the requests for the repository sent to it (an absolute URL, CONNECT, or the repository's own
    // paths, as an insteadOf would send them), and answers none. Anything else that dials a new loopback port is not counted.
    const reached = [];
    const proxy = createServer((socket) => {
      socket.once("data", (chunk) => {
        const line = chunk.toString("latin1").split("\r\n")[0];
        if (/^(?:CONNECT \S+|[A-Z]+ https?:\/\/\S+|[A-Z]+ \S*(?:info\/refs|git-upload-pack)\S*) HTTP\//.test(line)) reached.push(line);
        socket.destroy();
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => proxy.close(resolve)));
    const at = `http://127.0.0.1:${proxy.address().port}`;
    // A git in front of the run's PATH. Once the remote is added, it writes the keys into the run folder's
    // ${CHECKOUT_DIR}/.git/config, as a writer to the shared folder could before the fetch: the generic ones, the fetch URL's
    // own (which beat a generic -c), and an insteadOf. Each call that reaches GitHub logs its folder and the proxy and
    // sslVerify keys git reads there.
    const spy = join(dir, "spy");
    const planted = join(dir, "planted");
    const seen = join(dir, "seen.log");
    await mkdir(spy);
    const target = join(folder, CHECKOUT_DIR, ".git");
    const config = `[http]\\n\\tproxy = ${at}\\n\\tsslVerify = false\\n[http "${server.url}/"]\\n\\tproxy = ${at}\\n\\tsslVerify = false\\n[url "${at}/"]\\n\\tinsteadOf = ${server.url}/\\n`;
    writeFileSync(
      join(spy, "git"),
      [
        `#!${system("sh")}`,
        `case " $* " in *" fetch "*|*" ls-remote "*) { printf 'cwd %s\\n' "$PWD"; '${system("git")}' config --get-regexp '(proxy|sslverify|insteadof)$'; } >> '${seen}' 2>/dev/null ;; esac`,
        `'${system("git")}' "$@"; code=$?`,
        `case " $* " in *" remote add origin "*) mkdir -p '${target}' && printf '${config}' >> '${target}/config' && : > '${planted}' ;; esac`,
        "exit $code",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const spied = Object.create(workspace);
    spied.exec = (argv, options) => workspace.exec(argv, { ...options, env: { ...options.env, PATH: `${spy}:${options.env.PATH}` } });
    const made = await script.run({ workspace: spied, mint: server.mint }, server);
    assert.deepEqual(reached, [], `no request went to the planted address: ${made.note}`);
    assert.ok(existsSync(planted), "the keys were planted before the fetch");
    const log = readFileSync(seen, "utf8");
    assert.ok(!log.includes(at), `no git that reaches GitHub read the planted keys: ${log}`);
    const folders = [...log.matchAll(/^cwd (.*)$/gm)].map(([, cwd]) => cwd);
    assert.ok(folders.length > 0, "the calls that reach GitHub were logged");
    for (const cwd of folders) {
      assert.ok(!cwd.startsWith(folder), `the fetch ran outside the run's folder: ${cwd}`);
      assert.equal(existsSync(cwd), false, `the private folder ${cwd} is gone`);
    }
    assert.equal(git(join(folder, CHECKOUT_DIR), "rev-parse", "HEAD"), script.at(server.pull), made.note);
    assert.ok(!readFileSync(join(target, "config"), "utf8").includes(at), "the checkout's config is the one the script wrote");
    assert.ok(server.seen.length > 0, "the fetch reached GitHub itself");
    await made.end();
  });

  test(`checkout ${kind}, run: the repository moved into ${CHECKOUT_DIR}/ is whole: its own .git with the refs, the shallow file and the owner file, no worktree pointing elsewhere, and git status and merge-base work there`, { timeout: 120_000 }, async (t) => {
    const dir = await scratch(t);
    // A history longer than the deepened fetches, so both kinds end shallow and a .git/shallow is there to move.
    const server = await privateServer(t, dir, { shared: 200, ahead: 2, behind: 60 });
    const { folder, workspace } = await runFolder(dir);
    const made = await script.run({ workspace, mint: server.mint }, server);
    const repo = join(folder, CHECKOUT_DIR);
    assert.equal(git(repo, "rev-parse", "HEAD"), script.at(server.pull), made.note);
    assert.ok((await stat(join(repo, ".git"))).isDirectory(), ".git is a folder, not a gitdir file");
    assert.equal(git(repo, "rev-parse", "--show-toplevel"), await realpath(repo), "the work tree is the checkout's own folder");
    assert.throws(() => git(repo, "config", "--get", "core.worktree"), undefined, "no core.worktree");
    assert.ok(readFileSync(join(repo, ".git", "shallow"), "utf8").trim().length > 0, "the shallow file came with it");
    assert.ok(readFileSync(join(repo, ".git", "agentrun-claim"), "utf8").trim().length > 0, "the owner file came with it");
    assert.ok(Number(git(repo, "rev-list", "--count", "--all")) > 0, "every ref's history walks to its shallow edges");
    assert.equal(git(repo, "status", "--porcelain"), "", "git status works, and the checkout is clean");
    if (kind === "pull_request") {
      for (const ref of ["pr/head", "pr/base", "pr/merge-base"]) git(repo, "rev-parse", "--verify", `refs/${ref}`);
      assert.equal(git(repo, "merge-base", "refs/pr/base", "refs/pr/head"), git(repo, "rev-parse", "refs/pr/merge-base"), "merge-base works over the shallow history");
    } else {
      assert.equal(git(repo, "merge-base", "HEAD", "refs/repo/head"), git(repo, "rev-parse", "refs/repo/head"), "merge-base works, at refs/repo/head");
    }
    await made.end();
    assert.deepEqual(await readdir(folder), [], "the end removed it");
  });

  test(`checkout ${kind}, run: sh, git and every program the script runs are the system's (/usr/bin, /bin), never one a folder ahead of them on the run's PATH holds (/usr/local/bin, which an image or a root agent may fill)`, { timeout: 120_000 }, async (t) => {
    const dir = await scratch(t);
    const server = await privateServer(t, dir);
    const { folder, workspace } = await runFolder(dir);
    // /usr/local/bin, as the run's PATH has it, stood in for by a folder holding a planted sh and git.
    const local = join(dir, "usr-local-bin");
    const marks = join(dir, "planted.log");
    await mkdir(local);
    for (const name of ["sh", "git", "rm", "cat"]) planted(local, name, marks);
    const paths = [];
    const spied = Object.create(workspace);
    spied.exec = (argv, options) => {
      paths.push(options.env.PATH);
      return workspace.exec(argv, { ...options, env: { ...options.env, PATH: options.env.PATH.split(":").map((one) => (one === "/usr/local/bin" ? local : one)).join(":") } });
    };
    const made = await script.run({ workspace: spied, mint: server.mint }, server);
    assert.equal(git(join(folder, CHECKOUT_DIR), "rev-parse", "HEAD"), script.at(server.pull), made.note);
    await made.end();
    assert.deepEqual(await readdir(folder), [], "the end removed it");
    assert.ok(!existsSync(marks), `no planted program ran: ${existsSync(marks) ? readFileSync(marks, "utf8") : ""}`);
    for (const path of paths) assert.match(path, /^\/usr\/bin:\/bin:/, "the checkout's exec and its removal find programs in /usr/bin and /bin first");
  });
}

test("with no App, a public repository is fetched anonymously; a private one is not, and the run is told why and to read through the GitHub tools, with no half folder left", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const pub = pullRepo(gh, "acme/public");
  const anonymous = await gitHttp(t, gh);
  const { folder, workspace } = await runFolder(dir);
  const made = await prCheckout({ workspace, fromGitHub: true, input: firing("acme/public", pub), web: anonymous.url });
  assert.equal(git(join(folder, CHECKOUT_DIR), "rev-parse", "HEAD"), pub.head, made.note);
  assert.ok(anonymous.seen.every((request) => request.authorization === null), "no header at all");
  await made.end();

  const priv = pullRepo(gh, "acme/secret");
  const locked = await gitHttp(t, gh, { authorization: "Basic never" });
  const notInstalled = async () => ({ ok: false, reason: "not_installed", message: "The GitHub App isn't installed on acme/secret." });
  const refused = await prCheckout({ workspace, fromGitHub: true, input: firing("acme/secret", priv), mint: notInstalled, web: locked.url });
  assert.match(refused.note, /^The pull request acme\/secret#7 could not be checked out \(/);
  assert.match(refused.note, /fetched with no token: the GitHub App is not installed on acme\/secret/);
  assert.match(refused.note, /there is no repo\/ folder: read the change through the GitHub tools/);
  assert.deepEqual(await readdir(folder), [], "what the failed fetch made is gone");
  await refused.end();
});

test("a run in a workspace on a server whose GitHub App is connected: a private repository's checkout, of its pull request or the repository it names, says the run doesn't use the server's App, never that the server has none", { timeout: 120_000 }, async (t) => {
  const IN_WORKSPACE = "a workspace doesn't use this server's GitHub App, so only public repositories are read";
  const { storeOn } = await import("./store-helpers.mjs");
  const { seal } = await import("../dist/sealing.js");
  const { store } = await storeOn(t);
  const key = Buffer.alloc(32, 7);
  for (const [field, value] of [["app_id", "4242"], ["private_key", "not-a-key"]]) await store.triggerSettings.put({ adapter: "github", scope: "server", field, sealed: seal(key, Buffer.from(value, "utf8"), `trigger_settings|github|server|${field}`).toString("base64") });
  await store.agents.create({ id: "scoped", name: "scoped", workspace: "org:acme" }, { id: "rev-scoped", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-scoped", agentId: "scoped", revisionId: "rev-scoped" });
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const priv = pullRepo(gh, "acme/secret");
  const locked = await gitHttp(t, gh, { authorization: "Basic never" });
  const { folder, workspace } = await runFolder(dir);
  const { prCheckoutForClaim } = await import("../dist/runner/pr-checkout.js");
  const deps = { store, sealKey: key, githubApi: "http://127.0.0.1:1", githubWeb: locked.url };
  const pull = await prCheckoutForClaim(deps, "run-scoped", workspace, { input: firing("acme/secret", priv), inputOrigin: { kind: "trigger", source: "github" } }, { hold: () => {} });
  assert.match(pull.note, /^The pull request acme\/secret#7 could not be checked out \(/);
  assert.ok(pull.note.includes(`fetched with no token: ${IN_WORKSPACE}: `), pull.note);
  const repo = await prCheckoutForClaim(deps, "run-scoped", workspace, { input: { content: "Scan https://github.com/acme/secret." } }, { hold: () => {} }, undefined, undefined, "repository");
  assert.ok(repo.note.includes(`fetched with no token: ${IN_WORKSPACE}: `), repo.note);
  for (const note of [pull.note, repo.note]) assert.doesNotMatch(note, /has no GitHub App/);
  assert.ok(locked.seen.length > 0 && locked.seen.every((request) => request.authorization === null), "every fetch was anonymous");
  assert.deepEqual(await readdir(folder), []);
});

test("a head the repository does not have, a run no pull request started, and a payload tag in a run no github trigger started each get a note and no checkout", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const { base } = pullRepo(gh, "acme/widgets");
  const { folder, workspace } = await runFolder(dir);
  const gone = await prCheckout({ workspace, fromGitHub: true, input: firing("acme/widgets", { head: "c".repeat(40), base }), web: `file://${gh}` });
  assert.match(gone.note, /could not be checked out \(file:\/\/.*acme\/widgets did not give its commits/);
  assert.deepEqual(await readdir(folder), []);
  const none = await prCheckout({ workspace, fromGitHub: true, input: { content: "Review https://github.com/acme/widgets/pull/7." }, web: `file://${gh}` });
  assert.match(none.note, /^No checkout was made: this run was not started by a GitHub pull request event/);
  assert.deepEqual(await readdir(folder), []);
  // The same tag typed into a run no github trigger started (an API caller's own words) names nothing to fetch.
  const typed = await prCheckout({ workspace, input: firing("acme/widgets", { head: "c".repeat(40), base }), web: `file://${gh}` });
  assert.match(typed.note, /^No checkout was made/);
  assert.deepEqual(await readdir(folder), []);
});

test("a fetch cut short by the claim's signal (a person's stop) ends at once: no repo/ in the run's folder, and the private repository it was fetching into goes with the removal it handed the claim before it started", { timeout: 60_000 }, async (t) => {
  const { createServer } = await import("node:http");
  const dir = await scratch(t);
  // GitHub that never answers: the fetch waits until the signal ends it.
  const asked = [];
  const silent = createServer((req, res) => stranger(req, res) || asked.push(req));
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const req of asked) req.socket.destroy(); return new Promise((resolve) => silent.close(resolve)); });
  const { folder, workspace } = await runFolder(dir);
  // The checkout's id is the script's last argument; its private repository is named by it.
  const argvs = [];
  const seen = Object.create(workspace);
  seen.exec = (argv, options) => (argvs.push(argv), workspace.exec(argv, options));
  const stop = new AbortController();
  const held = [];
  const started = Date.now();
  const made = prCheckout({ workspace: seen, fromGitHub: true, input: firing("acme/widgets", { head: "a".repeat(40), base: "b".repeat(40) }), web: `http://127.0.0.1:${silent.address().port}`, signal: stop.signal, held: (part) => held.push(part) });
  while (asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort(new Error("stopped by a person"));
  await assert.rejects(made, /stopped by a person/);
  assert.ok(Date.now() - started < 30_000, "the stop did not wait for the fetch");
  assert.equal(held.length, 1, "its removal was the claim's before the fetch started");
  assert.deepEqual(await readdir(folder), [], "the cut fetch left nothing in the run's folder");
  const fetching = join("/tmp", `agentrun-checkout-${argvs[0].at(-1)}`);
  assert.ok(existsSync(join(fetching, ".git")), `the stop killed the script before it could remove ${fetching}`);
  await held[0].end();
  assert.equal(existsSync(fetching), false, "the claim's release removed the private repository");
  assert.deepEqual(await readdir(folder), []);
});

test("an agent's definition takes checkout pull_request on an agentic revision, none to clear it, and nothing else; its body keeps pull_request alone", async () => {
  const { definitionIssues } = await import("../dist/validate.js");
  const { bodyOf } = await import("../dist/store/agent-body.js");
  assert.deepEqual(definitionIssues({ name: "a", instructions: "x", checkout: "pull_request" }), []);
  assert.deepEqual(definitionIssues({ name: "a", instructions: "x", checkout: "none" }), []);
  assert.deepEqual(definitionIssues({ name: "a", instructions: "x", checkout: "branch" }).map((i) => [i.field, i.reason]), [["definition.checkout", "not_an_option"]]);
  assert.deepEqual(definitionIssues({ name: "a", workflow: {}, checkout: "pull_request" }).map((i) => [i.field, i.reason]), [["definition.checkout", "not_allowed"]]);
  assert.equal(bodyOf({ kind: "agentic", instructions: "x", checkout: "pull_request" }).body.checkout, "pull_request");
  assert.equal(bodyOf({ kind: "agentic", instructions: "x" }).body.checkout, undefined);
});

test("a template's manifest takes checkout pull_request, shows it, and sets it on the agent at apply; any other value is a problem of the package", async (t) => {
  const { compiled, packageView, PackageError, readPackage } = await import("../dist/templates.js");
  const dir = join(await scratch(t), "code-review");
  cpSync(new URL("../templates/code-review/", import.meta.url).pathname, dir, { recursive: true });
  const manifest = join(dir, "agent.md");
  // The manifest with no checkout of its own (code-review ships one), so each case below sets it, or none.
  const original = readFileSync(manifest, "utf8").replace(/^checkout: .*\n/m, "");
  writeFileSync(manifest, original.replace("\nlearning: false\n", "\nlearning: false\ncheckout: pull_request\n"));
  const p = readPackage(dir);
  assert.equal(packageView(p).checkout, "pull_request");
  assert.equal(compiled(p, { repo: "acme/widgets" }, { mcp: [], defaultTools: [], grants: [] }).agent.definition.checkout, "pull_request");
  writeFileSync(manifest, original);
  assert.equal(compiled(readPackage(dir), { repo: "acme/widgets" }, { mcp: [], defaultTools: [], grants: [] }).agent.definition.checkout, undefined, "none declared, none set");
  writeFileSync(manifest, original.replace("\nlearning: false\n", "\nlearning: false\ncheckout: branch\n"));
  assert.throws(() => readPackage(dir), (error) => error instanceof PackageError && error.problems.some((problem) => /checkout is pull_request/.test(problem)));
});

test("end to end: an agent with checkout pull_request, started by the App's pull_request event, reads repo/ at the head on its first turn; the token was minted for the one repository with contents read and revoked after the fetch, no file of the server's data holds it, and the run's end removed the checkout", { timeout: 180_000 }, async (t) => {
  const { connect, connectable, deliver } = await import("./github-support.mjs");
  const { agent, follow } = await import("./support.mjs");
  const { firings } = await import("./trigger-support.mjs");
  const { runFolder: folderOf } = await import("../dist/workspace/paths.js");
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const { head, base } = pullRepo(gh, "acme/widgets");
  let server;
  // GitHub's site takes only a token the fake GitHub minted for widgets with contents read.
  const checkoutTokens = () => server.github.tokens.filter((entry) => entry.permissions?.contents === "read" && Object.keys(entry.permissions).length === 1);
  const site = await gitHttp(t, gh, { authorization: (given) => checkoutTokens().some((entry) => given === `Basic ${Buffer.from(`x-access-token:${entry.token}`).toString("base64")}`) });
  server = await connectable(t, { faux: new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname, harnesses: true, githubWeb: site.url });
  await connect(server);
  assert.equal((await server.api("POST", "/agents", agent("pr", { tools: ["read"], checkout: "pull_request" }))).status, 201);
  assert.equal((await server.api("GET", "/agents/pr")).body.definition?.checkout ?? (await server.api("GET", "/agents/pr/definition")).body.checkout, "pull_request");
  const trigger = (await server.api("POST", "/triggers", { name: "prs", source: { kind: "github", accept: [{ event: "pull_request" }] }, target: { kind: "start_run", agent_id: "pr", input: { content: 'Call read with {"path":"repo/README.md"}' }, max_cost_usd: 0.5 } })).body;
  const event = { action: "opened", pull_request: { number: 7, head: { sha: head }, base: { sha: base } }, repository: { full_name: "acme/widgets" }, installation: { id: 777 } };
  // The removal is held where the test says: once the fetch is done (the token's revoke), the claim file the removal reads
  // is swapped for a named pipe, so the removal's `cat` opens it only when the test's own open of the pipe meets it. That
  // meeting is the removal having begun, and it goes on only when the test writes the claim into the pipe.
  let runKnown;
  const known = new Promise((resolve) => (runKnown = resolve));
  let swapped;
  const swap = new Promise((resolve) => (swapped = resolve));
  let pipe;
  let claimId;
  server.github.hooks.onRevoke = async (token) => {
    if (!checkoutTokens().some((entry) => entry.token === token)) return;
    pipe = join(folderOf(server.data, "pr", await known), CHECKOUT_DIR, ".git", "agentrun-claim");
    claimId = readFileSync(pipe, "utf8");
    rmSync(pipe);
    execFileSync("mkfifo", [pipe]);
    swapped();
  };
  assert.equal((await deliver(server.baseUrl, server.github.app.webhook_secret, "pull_request", event)).status, 202);
  const [fired] = await firings(server.api, trigger.id, 1);
  runKnown(fired.run_id);
  await swap;
  const meeting = await open(pipe, "w");
  // The write and the close are in a finally: a failed assertion never leaves the removal's `cat` waiting on the pipe.
  try {
    assert.notEqual((await server.api("GET", `/runs/${fired.run_id}`)).body.status, "completed", "the run is not final while its checkout is still being removed");
  } finally {
    await meeting.writeFile(claimId);
    await meeting.close();
  }
  const { last } = await follow(server.api, fired.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const answer = (await server.api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer;
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.match(String(answer), /the head's readme 1/, "the first turn read the head's file in repo/");
  const minted = checkoutTokens();
  assert.deepEqual(minted.map((entry) => [entry.installation, entry.repositories]), [[777, ["widgets"]]], "one token, for the one repository, contents read alone");
  assert.ok(server.github.revoked.includes(minted[0].token), "revoked at GitHub once the fetch was done");
  assert.ok(site.seen.length > 0 && site.seen.every((request) => request.authorization !== null), "every fetch carried it");
  const folder = folderOf(server.data, "pr", fired.run_id);
  assert.ok(!(await readdir(folder)).includes(CHECKOUT_DIR), "the run's end removed the checkout before it read final");
  for (const entry of await readdir(server.data, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const text = await readFile(join(entry.parentPath, entry.name), "latin1");
    assert.ok(!text.includes(minted[0].token), `${join(entry.parentPath, entry.name)} holds no token`);
  }
});
