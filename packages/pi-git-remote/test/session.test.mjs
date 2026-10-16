import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
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

async function open(t) {
  const root = await scratch();
  const { remote, dir: bare, main } = await seededRemote(root, { "notes/a.md": "alpha\n", "src/x.js": "x\n" });
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
  await assert.rejects(createSessionCheckout({ ...options, ref: "dev" }).seed(), (error) => error.code === "refused" && /another session or ref/.test(error.message));
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
