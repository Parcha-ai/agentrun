// The server's checkout of a run's pull request (runner/pr-checkout.ts), on a run's local Workspace, with a folder of bare
// repositories or git's own HTTP server on loopback standing in for GitHub: no network. The checkout lands at the head
// with the base and the merge base reachable (a merge base past the first fetch's depth included), keeps no credential in
// the run's folder, its git config or its remote's URL, is removed at the end, and a run it could not be made for is told
// why in words. The definition and the template field it is declared by (validate.ts, templates.ts), and the payload tag
// it reads (github.ts githubPullOf).
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git, gitHttp, pullRepo } from "./fixtures/git-http.mjs";

const { prCheckout, CHECKOUT_DIR } = await import("../dist/runner/pr-checkout.js");
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

test("a fetch cut short by the claim's signal (a person's stop) ends at once and leaves its folder to the removal it handed the claim before it started", { timeout: 60_000 }, async (t) => {
  const { createServer } = await import("node:http");
  const dir = await scratch(t);
  // GitHub that never answers: the fetch waits until the signal ends it.
  const asked = [];
  const silent = createServer((req) => asked.push(req));
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const req of asked) req.socket.destroy(); return new Promise((resolve) => silent.close(resolve)); });
  const { folder, workspace } = await runFolder(dir);
  const stop = new AbortController();
  const held = [];
  const started = Date.now();
  const made = prCheckout({ workspace, fromGitHub: true, input: firing("acme/widgets", { head: "a".repeat(40), base: "b".repeat(40) }), web: `http://127.0.0.1:${silent.address().port}`, signal: stop.signal, held: (part) => held.push(part) });
  while (asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort(new Error("stopped by a person"));
  await assert.rejects(made, /stopped by a person/);
  assert.ok(Date.now() - started < 30_000, "the stop did not wait for the fetch");
  assert.equal(held.length, 1, "its removal was the claim's before the fetch started");
  assert.ok((await readdir(folder)).includes(CHECKOUT_DIR), "the cut fetch left its folder");
  await held[0].end();
  assert.deepEqual(await readdir(folder), [], "the claim's release removed it");
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
  const original = readFileSync(manifest, "utf8");
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
  assert.equal((await deliver(server.baseUrl, server.github.app.webhook_secret, "pull_request", event)).status, 202);
  const [fired] = await firings(server.api, trigger.id, 1);
  const { last } = await follow(server.api, fired.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const answer = (await server.api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer;
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.match(String(answer), /the head's readme 1/, "the first turn read the head's file in repo/");
  const minted = checkoutTokens();
  assert.deepEqual(minted.map((entry) => [entry.installation, entry.repositories]), [[777, ["widgets"]]], "one token, for the one repository, contents read alone");
  assert.ok(server.github.revoked.includes(minted[0].token), "revoked at GitHub once the fetch was done");
  assert.ok(site.seen.length > 0 && site.seen.every((request) => request.authorization !== null), "every fetch carried it");
  const folder = folderOf(server.data, "pr", fired.run_id);
  assert.ok(!(await readdir(folder)).includes(CHECKOUT_DIR), "the run's end removed the checkout");
  for (const entry of await readdir(server.data, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const text = await readFile(join(entry.parentPath, entry.name), "latin1");
    assert.ok(!text.includes(minted[0].token), `${join(entry.parentPath, entry.name)} holds no token`);
  }
});
