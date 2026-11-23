// The server's checkout of the repository a run names (runner/pr-checkout.ts repoCheckout, the definition's `checkout:
// repository`): the head of its default branch, one commit deep, in repo/ before the first turn, with a folder of bare
// repositories or git's own HTTP server on loopback standing in for GitHub. It reads the repository from the run's start
// (`repo`) or the first https://github.com URL its owner's words name, mints for that one repository with contents read
// alone, keeps no credential, is removed at the end, and tells a run it could not be made for why.
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git, gitHttp, pullRepo } from "./fixtures/git-http.mjs";

const { repoCheckout, CHECKOUT_DIR } = await import("../dist/runner/pr-checkout.js");
const { localWorkspace } = await import("../dist/workspace/local.js");

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "repo-checkout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runFolder(dir) {
  const folder = join(dir, "run");
  await mkdir(folder, { recursive: true });
  return { folder, workspace: localWorkspace(folder) };
}

test("the checkout lands in repo/ at the head of the default branch the run's words name, one commit deep, detached; the run is told the branch and the commit; the end removes it", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  // main is the default branch: its head is the pull fixture's base, and a feature branch beside it is not fetched.
  const { base, head } = pullRepo(gh, "acme/widgets", { shared: 3, ahead: 1, behind: 2 });
  const { folder, workspace } = await runFolder(dir);
  const made = await repoCheckout({ workspace, input: { content: "Scan https://github.com/acme/widgets for places an agent would help." }, web: `file://${gh}` });
  const repo = join(folder, CHECKOUT_DIR);
  assert.equal(git(repo, "rev-parse", "HEAD"), base, made.note);
  assert.equal(git(repo, "rev-parse", "repo/head"), base);
  assert.throws(() => git(repo, "symbolic-ref", "-q", "HEAD"), "detached: HEAD names no branch");
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1", "one commit deep");
  assert.throws(() => git(repo, "cat-file", "-e", head), "the feature branch's head was never fetched");
  assert.equal(await readFile(join(repo, "main.txt"), "utf8"), "base 1\n");
  assert.equal(made.note, `The repository acme/widgets is checked out in repo/ at the head of its default branch main, commit ${base} (ref repo/head), by the server before this run began. Its 1 file is listed in repo/.git/agentrun-files, one path a line. It is a shallow clone (that one commit, no history), and no credential is kept in it.`);
  assert.equal(await readFile(join(repo, ".git", "agentrun-files"), "utf8"), "main.txt\n", "the file list, for an agent with read and no shell");
  await made.end();
  assert.deepEqual(await readdir(folder), [], "the end removed the checkout");
});

test("the start's repo comes before the words; a run that names no repository, or a name GitHub would never give, gets a note and no checkout", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const { base } = pullRepo(gh, "acme/widgets");
  pullRepo(gh, "acme/other");
  const { folder, workspace } = await runFolder(dir);
  const named = await repoCheckout({ workspace, repo: "acme/widgets", input: { content: "Look at https://github.com/acme/other too." }, web: `file://${gh}` });
  assert.equal(git(join(folder, CHECKOUT_DIR), "rev-parse", "HEAD"), base, "the start's repo, not the URL in the words");
  await named.end();
  const none = await repoCheckout({ workspace, input: { content: "Scan my app." }, web: `file://${gh}` });
  assert.match(none.note, /^No checkout was made: this run names no GitHub repository/);
  assert.deepEqual(await readdir(folder), []);
  const odd = await repoCheckout({ workspace, repo: "acme/..", input: { content: "x" }, web: `file://${gh}` });
  assert.match(odd.note, /^No checkout was made/);
  const missing = await repoCheckout({ workspace, input: { content: "Scan https://github.com/acme/nowhere" }, web: `file://${gh}` });
  assert.match(missing.note, /^The repository acme\/nowhere could not be checked out \(.*did not give its default branch/);
  assert.deepEqual(await readdir(folder), [], "what the failed fetch made is gone");
});

test("with the GitHub App, the fetch carries a token minted for the one repository with contents read alone, revoked after, held by the redactor, and kept nowhere in the folder", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, "gh");
  const { base } = pullRepo(gh, "acme/private");
  const token = `ghs_${"R".repeat(36)}`;
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const server = await gitHttp(t, gh, { authorization });
  const mints = [];
  const held = [];
  const revoked = [];
  const mint = async (target, permissions) => (mints.push({ target, permissions }), { ok: true, token, expires_at: Date.now() + 3600_000 });
  const { folder, workspace } = await runFolder(dir);
  const made = await repoCheckout({ workspace, input: { content: "Scan https://github.com/acme/private." }, mint, revoke: async (gone) => void revoked.push(gone), hold: (secrets) => held.push(...secrets), web: server.url });
  assert.equal(git(join(folder, CHECKOUT_DIR), "rev-parse", "HEAD"), base, made.note);
  assert.deepEqual(mints, [{ target: { repo: "acme/private" }, permissions: { contents: "read" } }]);
  assert.deepEqual(revoked, [token]);
  assert.ok(held.includes(token));
  assert.ok(server.seen.length > 0 && server.seen.every((request) => request.authorization === authorization), "every request carried the token's header");
  const config = await readFile(join(folder, CHECKOUT_DIR, ".git", "config"), "utf8");
  assert.ok(!/extraheader|x-access-token|credential/i.test(config), config);
  await made.end();
  assert.deepEqual(await readdir(folder), []);

  // Not installed there: anonymous, which a private repository refuses, and the run is told why.
  const refused = await repoCheckout({ workspace, input: { content: "Scan https://github.com/acme/private." }, mint: async () => ({ ok: false, reason: "not_installed", message: "x" }), web: server.url });
  assert.match(refused.note, /fetched with no token: the GitHub App is not installed on acme\/private/);
  assert.deepEqual(await readdir(folder), []);
});

test("an agent's definition and a template's manifest take checkout repository, and the template sets it on the agent", async (t) => {
  const { definitionIssues } = await import("../dist/validate.js");
  const { bodyOf } = await import("../dist/store/agent-body.js");
  assert.deepEqual(definitionIssues({ name: "a", instructions: "x", checkout: "repository" }), []);
  assert.equal(bodyOf({ kind: "agentic", instructions: "x", checkout: "repository" }).body.checkout, "repository");
  const { compiled, packageView, readPackage } = await import("../dist/templates.js");
  const dir = join(await scratch(t), "code-review");
  cpSync(new URL("../templates/code-review/", import.meta.url).pathname, dir, { recursive: true });
  const manifest = join(dir, "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/^checkout: .*$/m, "checkout: repository"));
  const p = readPackage(dir);
  assert.equal(packageView(p).checkout, "repository");
  assert.equal(compiled(p, { owner: "acme", repo: "widgets" }, { mcp: [], defaultTools: [], grants: [] }).agent.definition.checkout, "repository");
});
