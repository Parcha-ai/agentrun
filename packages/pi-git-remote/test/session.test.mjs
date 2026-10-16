import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { GitRemoteError, openRepo } from "../dist/index.js";
import { createSessionCheckout, DEFAULT_BRANCH, sessionBranch } from "../dist/session.js";
import { local } from "../dist/index.js";
import { remoteWith } from "./plain-remote.mjs";
import { rawGit, refsOf, scratch, seededRemote } from "./support.mjs";

const refusal = (fn, why) => assert.throws(fn, (error) => error instanceof GitRemoteError && error.code === "refused" && (why === undefined || why.test(error.message)));

test("the session branch holds the id exactly once and is never a protected name or the seed's own branch", () => {
  assert.equal(sessionBranch(DEFAULT_BRANCH, "abc-123", "main"), "sessions/abc-123");
  assert.equal(sessionBranch("learn/{sessionId}/notes", "abc-123", "main"), "learn/abc-123/notes");
  assert.equal(sessionBranch("refs/heads/s/{sessionId}", "abc-123", "main"), "s/abc-123");
  refusal(() => sessionBranch("sessions/shared", "abc", "main"), /exactly once/);
  refusal(() => sessionBranch("{sessionId}-{sessionId}", "abc", "main"), /exactly once/);
  refusal(() => sessionBranch("{sessionId}", "main", "dev"), /protected/);
  refusal(() => sessionBranch("{sessionId}", "master", "dev"), /protected/);
  refusal(() => sessionBranch("{sessionId}", "HEAD", "dev"), /protected/);
  refusal(() => sessionBranch("{sessionId}", "dev", "dev"), /protected|seeded/);
  refusal(() => sessionBranch("{sessionId}", "dev", "refs/heads/dev"), /protected|seeded/);
  for (const bad of ["", "a/b", "../x", "a b", "-x", ".x", "x".repeat(200), "a\nb"]) refusal(() => sessionBranch(DEFAULT_BRANCH, bad, "main"), /session id/);
});

async function open(t, files = { "notes/a.md": "alpha\n", "src/x.js": "x\n" }) {
  const root = await scratch();
  const { remote, dir: bare, main } = await seededRemote(root, files);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const options = { repo, sessionId: "s1", ref: "main", checkoutDir: path.join(root, "checkout"), seedFile: path.join(root, "state", "s1.json"), allow: ["notes/**"] };
  return { root, bare, main, repo, options };
}

test("a checkout that was never seeded has nothing to end", async (t) => {
  const { options } = await open(t);
  await assert.rejects(createSessionCheckout(options).end(), (error) => error instanceof GitRemoteError && /no seeded checkout/.test(error.message));
});

test("seed, change, end: the commit is on the session branch, built on the seeded commit, and main is where it was", async (t) => {
  const { options, bare, main } = await open(t);
  const checkout = createSessionCheckout(options);
  const seeded = await checkout.seed();
  assert.equal(seeded.sha, main);
  assert.deepEqual([...seeded.files].sort(), ["notes/a.md", "src/x.js"]);
  assert.equal(seeded.resumed, false);
  await writeFile(path.join(options.checkoutDir, "notes/b.md"), "beta\n");
  const outcome = await checkout.end();
  assert.deepEqual([outcome.created, outcome.changed, outcome.branch], [true, ["notes/b.md"], "sessions/s1"]);
  const refs = await refsOf(bare);
  assert.equal(refs["refs/heads/main"], main);
  assert.equal(refs["refs/heads/sessions/s1"], outcome.sha);
  const log = await (await openRepo({ dir: path.join(options.checkoutDir, "..", "reader"), remote: options.repo.remote })).log({ ref: "sessions/s1", max: 2 });
  assert.deepEqual(log.map((c) => c.sha), [outcome.sha, main]);
  assert.deepEqual(log[0].trailers["Session-Id"], ["s1"]);
});

test("a second seed keeps the directory and the seeded commit, even after the remote's main has moved", async (t) => {
  const { options, repo, main, bare, root } = await open(t);
  const first = createSessionCheckout(options);
  await first.seed();
  await writeFile(path.join(options.checkoutDir, "notes/b.md"), "beta\n");
  const seeder = await openRepo({ dir: path.join(root, "seeder2"), remote: repo.remote });
  const moved = await seeder.commitTo("main", { files: { "notes/other.md": "o\n" }, message: "moved" });
  await seeder.push(moved.sha, "main");
  const second = createSessionCheckout(options);
  const kept = await second.seed();
  assert.deepEqual([kept.resumed, kept.sha], [true, main]);
  const outcome = await second.end();
  const log = await repo.log({ ref: "sessions/s1", max: 2 });
  assert.deepEqual(log.map((c) => c.sha), [outcome.sha, main], "built on the seeded commit, not on the moved main");
  assert.deepEqual((await refsOf(bare))["refs/heads/main"], moved.sha);
});

test("a directory seeded for another session or ref is refused, not adopted", async (t) => {
  const { options } = await open(t);
  await createSessionCheckout(options).seed();
  await assert.rejects(createSessionCheckout({ ...options, ref: "dev" }).seed(), (error) => error.code === "refused" && /another session, ref, remote or branch/.test(error.message));
  await mkdir(path.join(options.checkoutDir, "extra"), { recursive: true });
  await assert.rejects(createSessionCheckout({ ...options, sessionId: "s2", seedFile: path.join(path.dirname(options.seedFile), "s2.json") }).seed(), (error) => error.code === "refused");
});

test("a seed record the package did not write is refused", async (t) => {
  const { options } = await open(t);
  await mkdir(path.dirname(options.seedFile), { recursive: true });
  await writeFile(options.seedFile, "{not json");
  await assert.rejects(createSessionCheckout(options).seed(), (error) => error.code === "refused" && /not JSON/.test(error.message));
  await writeFile(options.seedFile, JSON.stringify({ v: 9 }));
  await assert.rejects(createSessionCheckout(options).seed(), (error) => error.code === "refused" && /not one this version wrote/.test(error.message));
});

test("relative paths and an empty allowlist are refused when the checkout is made", async (t) => {
  const { options } = await open(t);
  refusal(() => createSessionCheckout({ ...options, checkoutDir: "relative/dir" }), /absolute/);
  refusal(() => createSessionCheckout({ ...options, seedFile: "relative.json" }), /absolute/);
  refusal(() => createSessionCheckout({ ...options, allow: [] }), /allowlist/);
  refusal(() => createSessionCheckout({ ...options, ref: "" }), /ref/);
});

test("the seeded text of a file is the commit's, not the working copy's", async (t) => {
  const { options } = await open(t);
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  await writeFile(path.join(options.checkoutDir, "notes/a.md"), "edited\n");
  assert.equal(await checkout.seeded("notes/a.md"), "alpha\n");
  assert.equal(await checkout.seeded("notes/none.md"), undefined);
});

test("a symlink the allowlist reaches refuses the whole end, and nothing is pushed", async (t) => {
  const { options, bare, main } = await open(t);
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  await writeFile(path.join(options.checkoutDir, "notes/fine.md"), "fine\n");
  await symlink("/etc/hostname", path.join(options.checkoutDir, "notes/leak.md"));
  await assert.rejects(checkout.end(), (error) => error.code === "refused" && /notes\/leak\.md.*a symlink/.test(error.message));
  assert.deepEqual(await refsOf(bare), { "refs/heads/main": main });
});

test("a change that no pattern names is never committed", async (t) => {
  const { options, bare } = await open(t);
  const checkout = createSessionCheckout({ ...options, allow: ["notes/*.md"] });
  await checkout.seed();
  await writeFile(path.join(options.checkoutDir, "notes/keep.md"), "keep\n");
  await writeFile(path.join(options.checkoutDir, "notes/skip.txt"), "skip\n");
  await writeFile(path.join(options.checkoutDir, "src/x.js"), "changed\n");
  const outcome = await checkout.end();
  assert.deepEqual(outcome.changed, ["notes/keep.md"]);
  const reader = await openRepo({ dir: path.join(options.checkoutDir, "..", "reader"), remote: options.repo.remote });
  assert.deepEqual((await reader.list("", outcome.sha)).map((e) => e.path).sort(), ["notes/a.md", "notes/keep.md", "src/x.js"]);
  assert.equal(await reader.read("src/x.js", outcome.sha), "x\n");
  assert.ok(await refsOf(bare));
});

test("a branch of the session's name that carries no Session-Id trailer is never added to", async (t) => {
  const { options, bare, main } = await open(t);
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  await rawGit(["update-ref", "refs/heads/sessions/s1", main], { gitDir: bare });
  await writeFile(path.join(options.checkoutDir, "notes/b.md"), "beta\n");
  await assert.rejects(checkout.end(), (error) => error.code === "refused" && /not this session's/.test(error.message));
  assert.equal((await refsOf(bare))["refs/heads/sessions/s1"], main);
});

test("a second end for the same session commits nothing", async (t) => {
  const { options, bare } = await open(t);
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  await writeFile(path.join(options.checkoutDir, "notes/b.md"), "beta\n");
  const first = await checkout.end();
  const second = await checkout.end();
  assert.deepEqual([first.created, second.created, second.sha], [true, false, first.sha]);
  assert.equal((await refsOf(bare))["refs/heads/sessions/s1"], first.sha);
});

test("a seeded entry the checkout skipped is not seen as a deletion", async (t) => {
  const root = await scratch();
  const { bare } = await remoteWith(root, { "notes/a.md": "alpha\n", "notes/link.md": { link: "a.md" } });
  const repo = await openRepo({ dir: path.join(root, "host"), remote: local(bare) });
  const options = { repo, sessionId: "s1", ref: "main", checkoutDir: path.join(root, "checkout"), seedFile: path.join(root, "state", "s1.json"), allow: ["notes/**"] };
  const checkout = createSessionCheckout(options);
  const seeded = await checkout.seed();
  assert.deepEqual(seeded.files, ["notes/a.md"]);
  assert.deepEqual(seeded.skipped.map((s) => s.path), ["notes/link.md"]);
  const outcome = await checkout.end();
  assert.deepEqual([outcome.created, outcome.changed], [false, []]);
  assert.deepEqual(Object.keys(await refsOf(bare)), ["refs/heads/main"]);
});

const treeAt = async (repo, sha) => Object.fromEntries(await Promise.all((await repo.list("", sha)).map(async (e) => [e.path, await repo.read(e.path, sha)])));

test("a file put back or removed after an earlier end is a change: the saved state moves with each end, and survives a restart", async (t) => {
  const { options, repo } = await open(t);
  const dir = options.checkoutDir;
  const first = createSessionCheckout(options);
  await first.seed();
  await writeFile(path.join(dir, "notes/a.md"), "alpha, revised\n");
  await writeFile(path.join(dir, "notes/b.md"), "beta\n");
  const one = await first.end();
  assert.deepEqual(await treeAt(repo, one.sha), { "notes/a.md": "alpha, revised\n", "notes/b.md": "beta\n", "src/x.js": "x\n" });
  await writeFile(path.join(dir, "notes/a.md"), "alpha\n");
  await rm(path.join(dir, "notes/b.md"));
  const second = createSessionCheckout(options);
  assert.equal((await second.seed()).resumed, true);
  const two = await second.end();
  assert.deepEqual([two.created, two.changed], [true, ["notes/a.md", "notes/b.md"]]);
  assert.deepEqual(await treeAt(repo, two.sha), { "notes/a.md": "alpha\n", "src/x.js": "x\n" });
  assert.equal((await repo.log({ ref: "sessions/s1", max: 3 })).length, 3);
});

test("an empty checkout directory that this session left is kept, not seeded again, and the deletion is committed", async (t) => {
  const { options, repo } = await open(t, { "notes/a.md": "alpha\n" });
  const first = createSessionCheckout(options);
  await first.seed();
  await rm(path.join(options.checkoutDir, "notes"), { recursive: true });
  const again = createSessionCheckout(options);
  const kept = await again.seed();
  assert.equal(kept.resumed, true);
  assert.deepEqual(await readdir(options.checkoutDir), [], "nothing was put back");
  const outcome = await again.end();
  assert.deepEqual([outcome.created, outcome.changed], [true, ["notes/a.md"]]);
  assert.deepEqual(await treeAt(repo, outcome.sha), {});
});

test("a checkout made for one remote is never adopted for another", async (t) => {
  const { options, root } = await open(t);
  await createSessionCheckout(options).seed();
  const other = await seededRemote(path.join(root, "other"), { "notes/a.md": "alpha\n", "src/x.js": "x\n" });
  const repo = await openRepo({ dir: path.join(root, "host2"), remote: other.remote });
  await assert.rejects(createSessionCheckout({ ...options, repo }).seed(), (error) => error.code === "refused" && /another session, ref, remote or branch/.test(error.message));
});

test("a checkout directory replaced by a link is refused at the end and at a restart, and nothing is pushed", async (t) => {
  const { options, root, bare, main } = await open(t);
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(path.join(elsewhere, "notes"), { recursive: true });
  await writeFile(path.join(elsewhere, "notes/stolen.md"), "not the session's\n");
  await rename(options.checkoutDir, `${options.checkoutDir}.moved`);
  await symlink(elsewhere, options.checkoutDir);
  await assert.rejects(checkout.end(), (error) => error.code === "refused" && /link or not a directory|not where it was seeded/.test(error.message));
  await assert.rejects(createSessionCheckout(options).seed(), (error) => error.code === "refused" && /link or not a directory/.test(error.message));
  assert.deepEqual(await refsOf(bare), { "refs/heads/main": main });
});

test("a checkout directory reached through a replaced parent is refused: it is no longer where it was seeded", async (t) => {
  const root = await scratch();
  const { remote, dir: bare, main } = await seededRemote(root, { "notes/a.md": "alpha\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const options = { repo, sessionId: "s1", ref: "main", checkoutDir: path.join(root, "parent", "checkout"), seedFile: path.join(root, "state", "s1.json"), allow: ["**"] };
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  await mkdir(path.join(root, "elsewhere", "checkout", "notes"), { recursive: true });
  await writeFile(path.join(root, "elsewhere", "checkout", "notes/stolen.md"), "not the session's\n");
  await rename(path.join(root, "parent"), path.join(root, "parent.moved"));
  await symlink(path.join(root, "elsewhere"), path.join(root, "parent"));
  await assert.rejects(checkout.end(), (error) => error.code === "refused" && /not where it was seeded/.test(error.message));
  assert.deepEqual(await refsOf(bare), { "refs/heads/main": main });
});

test("a file named __proto__ is written and deleted like any other", async (t) => {
  const { options, repo } = await open(t, Object.fromEntries([["__proto__", "seeded\n"], ["notes/a.md", "alpha\n"]]));
  const checkout = createSessionCheckout({ ...options, allow: ["__proto__", "constructor", "notes/**"] });
  await checkout.seed();
  await writeFile(path.join(options.checkoutDir, "constructor"), "made\n");
  await rm(path.join(options.checkoutDir, "__proto__"));
  const outcome = await checkout.end();
  assert.deepEqual(outcome.changed, ["__proto__", "constructor"]);
  assert.deepEqual(await treeAt(repo, outcome.sha), { constructor: "made\n", "notes/a.md": "alpha\n" });
});

test("a push that failed does not make the saved state the pushed one: contents put back before the retry are the change they are", async (t) => {
  const { options, repo, bare } = await open(t);
  const note = path.join(options.checkoutDir, "notes/a.md");
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  await writeFile(note, "B\n");
  await checkout.end();
  await writeFile(note, "C\n");
  // The remote can be read but not written: the commit is made here, the push fails.
  execFileSync("chmod", ["-R", "a-w", path.join(bare, "objects")]);
  try {
    await assert.rejects(checkout.end());
  } finally {
    execFileSync("chmod", ["-R", "u+w", path.join(bare, "objects")]);
  }
  await writeFile(note, "B\n");
  const retry = await checkout.end();
  assert.equal(retry.created, true);
  assert.equal((await treeAt(repo, retry.sha))["notes/a.md"], "B\n", "the contents C that were discarded are not pushed");
  assert.equal((await refsOf(bare))["refs/heads/sessions/s1"], retry.sha);
});

test("a deletion is seen when the allowlist is wider on a later start than at the seed", async (t) => {
  const { options, repo } = await open(t);
  const narrow = createSessionCheckout({ ...options, allow: ["notes/**"] });
  await narrow.seed();
  const wide = createSessionCheckout({ ...options, allow: ["notes/**", "src/**"] });
  assert.equal((await wide.seed()).resumed, true);
  await rm(path.join(options.checkoutDir, "src/x.js"));
  await writeFile(path.join(options.checkoutDir, "notes/a.md"), "alpha\n");
  const outcome = await wide.end();
  assert.deepEqual([outcome.created, outcome.changed], [true, ["src/x.js"]]);
  assert.deepEqual(await treeAt(repo, outcome.sha), { "notes/a.md": "alpha\n" });
});

test("a checkout saved for one branch is not adopted under another branch pattern", async (t) => {
  const { options, repo } = await open(t);
  const checkout = createSessionCheckout(options);
  await checkout.seed();
  await writeFile(path.join(options.checkoutDir, "notes/b.md"), "beta\n");
  await checkout.end();
  const elsewhere = createSessionCheckout({ ...options, branch: "other/{sessionId}" });
  await assert.rejects(elsewhere.seed(), (error) => error.code === "refused" && /another session, ref, remote or branch/.test(error.message));
  assert.equal(await repo.resolve("other/s1"), undefined);
});
