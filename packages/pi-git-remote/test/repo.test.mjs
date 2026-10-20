import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { GitRemoteError, local, MAIN, openRepo, RUN_ID_TRAILER } from "../dist/index.js";
import { bareRepo, rawGit, recordingGit, refsOf, scratch, seededRemote } from "./support.mjs";

const count = async (gitDir, range) => Number((await rawGit(["rev-list", "--count", range], { gitDir })).toString().trim());

test("openRepo makes a bare repository with no sample hooks, opens it again, and refuses a directory that is neither", async () => {
  const root = await scratch();
  const remote = local(await bareRepo(path.join(root, "remote.git")));
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  assert.equal((await rawGit(["rev-parse", "--is-bare-repository"], { gitDir: repo.dir })).toString().trim(), "true");
  assert.ok(!existsSync(path.join(repo.dir, "hooks")), "--template= copies no sample hooks");
  assert.equal(await repo.resolve(MAIN), undefined, "an empty remote has no main");
  const again = await openRepo({ dir: repo.dir, remote });
  assert.equal(again.dir, repo.dir);
  const other = path.join(root, "not-a-repo");
  await mkdir(other);
  await writeFile(path.join(other, "notes.txt"), "x");
  await assert.rejects(openRepo({ dir: other, remote }), (e) => e instanceof GitRemoteError && e.code === "refused");
  await assert.rejects(openRepo({ dir: path.join(root, "h2"), remote, limits: { maxFiles: 0 } }), { code: "refused" });
});

test("commitTo starts a new branch at main, writes regular files, deletes with null, and makes no commit when nothing changes", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root, { "README.md": "seed\n", "old.md": "old\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const first = await repo.commitTo("runs/r1", {
    files: { "inbox/r1.md": "a lesson\n", "old.md": null, "bin.dat": new Uint8Array([0, 1, 2, 255]) },
    message: "run r1 proposes",
    trailers: { "Run-Id": "r1", Note: ["one", "two"] },
  });
  assert.equal(first.created, true);
  const [entry] = await repo.log({ ref: "runs/r1", max: 1 });
  assert.deepEqual(entry, { sha: first.sha, parents: [main], subject: "run r1 proposes", trailers: { "Run-Id": ["r1"], Note: ["one", "two"] } });
  assert.deepEqual((await repo.list("", first.sha)).map((e) => [e.path, e.mode]), [["README.md", "100644"], ["bin.dat", "100644"], ["inbox/r1.md", "100644"]]);
  assert.equal(await repo.read("old.md", first.sha), undefined);
  assert.equal(await repo.read("inbox/r1.md", first.sha), "a lesson\n");
  assert.deepEqual(await refsOf(dir), { "refs/heads/main": main }, "commitTo is local; nothing reaches the remote before push");
  const same = await repo.commitTo("runs/r1", { files: { "inbox/r1.md": "a lesson\n" }, message: "no change" });
  assert.deepEqual(same, { sha: first.sha, created: false });
  const root2 = await repo.commitTo("fresh", { files: { "a.md": "a\n" }, message: "on main", parent: main });
  assert.equal((await repo.log({ ref: "fresh", max: 1 }))[0].parents[0], main);
  assert.equal(root2.created, true);
});

test("allowEmpty makes a commit that changes no file, so its message and trailers are the record", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  assert.deepEqual(await repo.commitTo(MAIN, { files: {}, message: "nothing" }), { sha: main, created: false });
  const empty = await repo.commitTo(MAIN, { files: {}, message: "held one", trailers: { "Curated-Run": "r1" }, allowEmpty: true, parent: main });
  assert.equal(empty.created, true);
  await repo.push(empty.sha, MAIN);
  const [entry] = await repo.log({ max: 1 });
  assert.deepEqual(entry, { sha: empty.sha, parents: [main], subject: "held one", trailers: { "Curated-Run": ["r1"] } });
  const tree = async (rev) => (await rawGit(["rev-parse", `${rev}^{tree}`], { gitDir: dir })).toString().trim();
  assert.equal(await tree(empty.sha), await tree(main));
});

test("branches lists the branches under a prefix, here and on the remote, at the commit resolve gives", async () => {
  const root = await scratch();
  const { remote, main } = await seededRemote(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const other = await openRepo({ dir: path.join(root, "other"), remote });
  const r1 = await other.commitTo("runs/r1", { files: { "inbox/r1.md": "1\n" }, message: "r1" });
  await other.push(r1.sha, "runs/r1");
  const r2 = await other.commitTo("runs/r2", { files: { "inbox/r2.md": "2\n" }, message: "r2" });
  await other.push(r2.sha, "runs/r2");
  const x = await other.commitTo("runsx", { files: { "x.md": "x\n" }, message: "x" });
  await other.push(x.sha, "runsx");
  const mine = await repo.commitTo("runs/r3", { files: { "inbox/r3.md": "3\n" }, message: "r3" });
  assert.deepEqual(await repo.branches("runs/"), [{ name: "runs/r1", sha: r1.sha }, { name: "runs/r2", sha: r2.sha }, { name: "runs/r3", sha: mine.sha }]);
  assert.deepEqual((await repo.branches("")).map((b) => b.name), ["main", "runs/r1", "runs/r2", "runs/r3", "runsx"]);
  assert.equal((await repo.branches("")).find((b) => b.name === "main").sha, main);
  assert.deepEqual(await repo.branches("nothing/"), []);
  for (const bad of ["runs", "../", "runs//", "/"]) await assert.rejects(repo.branches(bad), { code: "refused" }, bad);
});

test("commitTo builds on an explicit parent and refuses a parent the branch is not at", async () => {
  const root = await scratch();
  const { remote, main } = await seededRemote(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const a = await repo.commitTo(MAIN, { files: { "a.md": "a\n" }, message: "a", parent: main });
  await assert.rejects(repo.commitTo(MAIN, { files: { "b.md": "b\n" }, message: "b", parent: main }), (e) => e instanceof GitRemoteError && e.code === "conflict");
  const b = await repo.commitTo(MAIN, { files: { "b.md": "b\n" }, message: "b", parent: a.sha });
  assert.equal((await repo.log({ max: 1 }))[0].parents[0], a.sha);
  assert.equal(b.created, true);
  await assert.rejects(repo.commitTo("x", { files: { "c.md": "c" }, message: "c", parent: "f".repeat(40) }), { code: "missing" });
});

test("push sends a commit by sha; a remote that moved is a conflict, nothing is forced, and the next write builds on the remote", async () => {
  const root = await scratch();
  const { dir, remote, seeder, main } = await seededRemote(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const mine = await repo.commitTo(MAIN, { files: { "mine.md": "mine\n" }, message: "mine" });
  const theirs = await seeder.commitTo(MAIN, { files: { "theirs.md": "theirs\n" }, message: "theirs" });
  await seeder.push(theirs.sha, MAIN);
  await assert.rejects(repo.push(mine.sha, MAIN), (e) => e instanceof GitRemoteError && e.code === "conflict");
  assert.equal((await refsOf(dir))["refs/heads/main"], theirs.sha, "the remote keeps its own main");
  const retry = await repo.commitTo(MAIN, { files: { "mine.md": "mine\n" }, message: "mine again" });
  assert.equal((await repo.log({ max: 1 }))[0].parents[0], theirs.sha, "the remote wins over a local commit it moved past");
  await repo.push(retry.sha, MAIN);
  await repo.push(main, "runs/at-seed");
  assert.equal((await refsOf(dir))["refs/heads/runs/at-seed"], main);
  await assert.rejects(repo.push(main, MAIN), { code: "conflict" }, "pushing an older commit is never forced");
  await assert.rejects(repo.push("0".repeat(40), MAIN), { code: "missing" });
  await assert.rejects(repo.push("HEAD", MAIN), { code: "refused" });
});

test("commitTo is idempotent by Run-Id after a restart: a fresh host with an empty local repo finds the commit on the remote and commits nothing", async () => {
  const root = await scratch();
  const { dir, remote, main } = await seededRemote(root);
  const first = await openRepo({ dir: path.join(root, "host-1"), remote });
  const made = await first.commitTo("runs/r1", { files: { "inbox/r1.md": "written at 10:00\n" }, message: "run r1", trailers: { [RUN_ID_TRAILER]: "r1" } });
  await first.push(made.sha, "runs/r1");
  assert.deepEqual(await first.commitTo("runs/r1", { files: { "inbox/r1.md": "written at 10:05\n" }, message: "run r1", trailers: { "Run-Id": "r1" } }), { sha: made.sha, created: false });
  const restarted = await openRepo({ dir: path.join(root, "host-2"), remote });
  const again = await restarted.commitTo("runs/r1", { files: { "inbox/r1.md": "written at 10:07\n" }, message: "run r1", trailers: { "Run-Id": "r1" } });
  assert.deepEqual(again, { sha: made.sha, created: false });
  assert.equal(await count(dir, `${main}..refs/heads/runs/r1`), 1);
  const other = await restarted.commitTo("runs/r1", { files: { "inbox/r1.md": "another run\n" }, message: "run r2", trailers: { "Run-Id": "r2" } });
  assert.equal(other.created, true, "another Run-Id on the same branch is a new commit");
});

test("read, list and resolve: text at a sha, entries under a prefix, absent paths and refs", async () => {
  const root = await scratch();
  const { remote, main } = await seededRemote(root, { "a.md": "a\n", "learnings/L-1.md": "one\n", "learnings/deep/L-2.md": "two\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  assert.equal(await repo.resolve(MAIN), main);
  assert.equal(await repo.resolve(main), main);
  assert.equal(await repo.resolve("nope"), undefined);
  assert.equal(await repo.resolve("0".repeat(40)), undefined);
  assert.equal(await repo.read("learnings/deep/L-2.md", main), "two\n");
  assert.equal(await repo.read("learnings", main), undefined, "a directory is not a file");
  assert.equal(await repo.read("absent.md", main), undefined);
  assert.deepEqual((await repo.list("learnings", main)).map((e) => [e.path, e.size]), [["learnings/L-1.md", 4], ["learnings/deep/L-2.md", 4]]);
  assert.deepEqual((await repo.list("learnings/", MAIN)).length, 2);
  assert.deepEqual(await repo.list("absent", main), []);
  await assert.rejects(repo.read("../a.md", main), { code: "refused" });
  await assert.rejects(repo.read("a.md", "0".repeat(40)), { code: "missing" });
  assert.deepEqual(await repo.list(":(glob)*", main), [], "pathspec magic is read as a literal path");
});

test("checkout copies regular files into an empty directory, never executable, and refuses a non-empty directory or one inside the host repository", async () => {
  const root = await scratch();
  const { remote, main } = await seededRemote(root, { "AGENTS.md": "# Rules\n", ".agents/skills/cite/SKILL.md": "# Cite\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const into = path.join(root, "work");
  const out = await repo.checkout(MAIN, { into });
  assert.deepEqual(out, { sha: main, files: [".agents/skills/cite/SKILL.md", "AGENTS.md"], skipped: [] });
  assert.equal(await readFile(path.join(into, ".agents/skills/cite/SKILL.md"), "utf8"), "# Cite\n");
  assert.equal(statSync(path.join(into, "AGENTS.md")).mode & 0o111, 0);
  await assert.rejects(repo.checkout(MAIN, { into }), { code: "refused" }, "not empty");
  await assert.rejects(repo.checkout(MAIN, { into: path.join(repo.dir, "inside") }), { code: "refused" });
  await assert.rejects(repo.checkout("nope", { into: path.join(root, "w2") }), { code: "missing" });
  assert.deepEqual(await readdir(path.join(root, "w2")).catch(() => []), []);
});

test("merge fast-forwards, makes a merge commit when both sides moved, and reports a conflict without moving anything", async () => {
  const root = await scratch();
  const { dir, remote, seeder } = await seededRemote(root, { "notes.md": "1\n2\n3\n4\n5\n6\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const run = await repo.commitTo("runs/r1", { files: { "inbox/r1.md": "x\n" }, message: "r1" });
  await repo.push(run.sha, "runs/r1");
  const ff = await repo.merge("runs/r1", MAIN);
  assert.deepEqual(ff, { sha: run.sha, changed: true, fastForward: true });
  assert.deepEqual(await repo.merge("runs/r1", MAIN), { sha: run.sha, changed: false, fastForward: false });
  await repo.push(ff.sha, MAIN);

  const feature = await repo.commitTo("feature", { files: { "notes.md": "1 feature\n2\n3\n4\n5\n6\n" }, message: "feature" });
  await repo.push(feature.sha, "feature");
  const moved = await seeder.commitTo(MAIN, { files: { "notes.md": "1\n2\n3\n4\n5\n6 main\n" }, message: "main moves" });
  await seeder.push(moved.sha, MAIN);
  const merged = await repo.merge("feature", MAIN);
  assert.equal(merged.fastForward, false);
  assert.deepEqual((await repo.log({ max: 1 }))[0].parents, [moved.sha, feature.sha]);
  assert.equal(await repo.read("notes.md", merged.sha), "1 feature\n2\n3\n4\n5\n6 main\n");
  await repo.push(merged.sha, MAIN);

  const left = await repo.commitTo("left", { files: { "notes.md": "LEFT\n" }, message: "left" });
  const right = await seeder.commitTo(MAIN, { files: { "notes.md": "RIGHT\n" }, message: "right" });
  await seeder.push(right.sha, MAIN);
  await repo.fetch();
  const before = { remote: await refsOf(dir), host: await refsOf(repo.dir) };
  await assert.rejects(repo.merge("left", MAIN), (e) => e instanceof GitRemoteError && e.code === "conflict" && e.paths.includes("notes.md"));
  assert.deepEqual({ remote: await refsOf(dir), host: await refsOf(repo.dir) }, before, "a conflict moves no ref");
  assert.ok(left.created);
  await assert.rejects(repo.merge("nope", MAIN), { code: "missing" });
});

test("revert undoes an older commit under newer ones; a second revert changes nothing; a conflicting revert moves nothing", async () => {
  const root = await scratch();
  const { remote, main } = await seededRemote(root, { "keep.md": "k\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const older = await repo.commitTo(MAIN, { files: { "learnings/L-1.md": "one\n" }, message: "learn one" });
  const newer = await repo.commitTo(MAIN, { files: { "learnings/L-2.md": "two\n" }, message: "learn two" });
  await repo.push(newer.sha, MAIN);
  const reverted = await repo.revert(older.sha, MAIN, { trailers: { "Learning-Id": "L-1" } });
  assert.equal(reverted.changed, true);
  const [entry] = await repo.log({ max: 1 });
  assert.equal(entry.subject, 'Revert "learn one"');
  assert.deepEqual(entry.trailers, { "Learning-Id": ["L-1"], Reverts: [older.sha] });
  assert.deepEqual((await repo.list("", reverted.sha)).map((e) => e.path), ["keep.md", "learnings/L-2.md"]);
  assert.equal(await repo.read("learnings/L-1.md", newer.sha), "one\n", "history keeps it");
  assert.deepEqual(await repo.revert(older.sha, MAIN), { sha: reverted.sha, changed: false });
  await repo.push(reverted.sha, MAIN);
  assert.deepEqual((await repo.log({ path: "learnings/L-1.md" })).map((e) => e.sha), [reverted.sha, older.sha]);

  const edit = await repo.commitTo(MAIN, { files: { "keep.md": "k edited\n" }, message: "edit" });
  await repo.commitTo(MAIN, { files: { "keep.md": "k edited twice\n" }, message: "edit again" });
  const host = await refsOf(repo.dir);
  await assert.rejects(repo.revert(edit.sha, MAIN), (e) => e instanceof GitRemoteError && e.code === "conflict" && e.paths.includes("keep.md"));
  assert.deepEqual(await refsOf(repo.dir), host);
  await assert.rejects(repo.revert(main, MAIN), { code: "refused" }, "a root commit");
  const elsewhere = await repo.commitTo("side", { files: { "s.md": "s\n" }, message: "side" });
  await assert.rejects(repo.revert(elsewhere.sha, MAIN), { code: "refused" }, "not on main");
});

test("log filters by path and by trailer", async () => {
  const root = await scratch();
  const { remote } = await seededRemote(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const a = await repo.commitTo(MAIN, { files: { "a.md": "a\n" }, message: "a", trailers: { "Curated-Run": "r1" } });
  const b = await repo.commitTo(MAIN, { files: { "b.md": "b\n" }, message: "b", trailers: { "Curated-Run": "r2", "Learning-Id": "L-2" } });
  const c = await repo.commitTo(MAIN, { files: { "a.md": "a2\n" }, message: "c\n\nThe body names Curated-Run: r1 inline, which is not a trailer." });
  assert.deepEqual((await repo.log({ path: "a.md" })).map((e) => e.sha), [c.sha, a.sha]);
  assert.deepEqual((await repo.log({ trailer: { key: "Curated-Run" } })).map((e) => e.sha), [b.sha, a.sha]);
  assert.deepEqual((await repo.log({ trailer: { key: "Curated-Run", value: "r1" } })).map((e) => e.sha), [a.sha]);
  assert.deepEqual((await repo.log({ trailer: { key: "curated-run", value: "r2" } })).map((e) => e.sha), [b.sha]);
  assert.equal((await repo.log({ max: 2 })).length, 2);
  assert.deepEqual(await repo.log({ ref: "nope" }), []);
});

test("a remote with a push URL: pushes land there, both are fetched, and commitTo finds a Run-Id pushed there", async () => {
  const root = await scratch();
  const { dir: mainDir, main } = await seededRemote(root);
  const hidden = await bareRepo(path.join(root, "hidden.git"));
  const remote = { kind: "local", url: mainDir, pushUrl: hidden };
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const run = await repo.commitTo("runs/r1", { files: { "inbox/r1.md": "x\n" }, message: "r1", trailers: { "Run-Id": "r1" } });
  await repo.push(run.sha, "runs/r1");
  assert.equal((await refsOf(hidden))["refs/heads/runs/r1"], run.sha);
  assert.deepEqual(await refsOf(mainDir), { "refs/heads/main": main });
  const restarted = await openRepo({ dir: path.join(root, "host-2"), remote });
  assert.deepEqual(await restarted.commitTo("runs/r1", { files: { "inbox/r1.md": "y\n" }, message: "r1", trailers: { "Run-Id": "r1" } }), { sha: run.sha, created: false });
  assert.equal(await restarted.resolve("runs/r1"), run.sha);
});

test("calls on one Repo run one at a time", async () => {
  const root = await scratch();
  const { remote } = await seededRemote(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const made = await Promise.all(Array.from({ length: 6 }, (_, i) => repo.commitTo(`runs/r${i}`, { files: { [`inbox/r${i}.md`]: `${i}\n` }, message: `r${i}` })));
  await Promise.all(made.map((m, i) => repo.push(m.sha, `runs/r${i}`)));
  assert.equal(new Set(made.map((m) => m.sha)).size, 6);
  const chained = [];
  for (let i = 0; i < 3; i++) chained.push(repo.commitTo(MAIN, { files: { [`n${i}.md`]: `${i}\n` }, message: `n${i}` }));
  const shas = (await Promise.all(chained)).map((c) => c.sha);
  assert.deepEqual((await repo.log({ max: 3 })).map((e) => e.sha), shas.reverse(), "each commit built on the one before");
});

const reaches = (gitDir, sha, tip) => rawGit(["merge-base", "--is-ancestor", sha, tip], { gitDir }).then(() => true, () => false);

test("two Repo handles on one directory never drop each other's commits: a write whose branch moved fails with conflict", async () => {
  const root = await scratch();
  const { remote } = await seededRemote(root);
  const dir = path.join(root, "host");
  const handles = [await openRepo({ dir, remote }), await openRepo({ dir, remote })];
  for (let round = 0; round < 4; round++) {
    const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      handles[i % 2].commitTo(MAIN, { files: { [`r${round}-${i}.md`]: `${i}\n` }, message: `r${round}-${i}` })));
    const tip = (await rawGit(["rev-parse", "refs/heads/main"], { gitDir: dir })).toString().trim();
    for (const result of settled) {
      if (result.status === "rejected") assert.equal(result.reason.code, "conflict", String(result.reason));
      else assert.ok(await reaches(dir, result.value.sha, tip), "a commit reported as made is on the branch");
    }
    assert.ok(settled.some((r) => r.status === "fulfilled"));
  }
});

test("a push URL ahead of the fetch URL wins: a fresh host resolves the newer tip and builds on it", async () => {
  const root = await scratch();
  const { dir: mainDir, main } = await seededRemote(root);
  const hidden = await bareRepo(path.join(root, "hidden.git"));
  const remote = { kind: "local", url: mainDir, pushUrl: hidden };
  const first = await openRepo({ dir: path.join(root, "host-1"), remote });
  await first.push(main, MAIN);
  const next = await first.commitTo(MAIN, { files: { "b.md": "b\n" }, message: "b" });
  await first.push(next.sha, MAIN);
  assert.deepEqual([(await refsOf(mainDir))["refs/heads/main"], (await refsOf(hidden))["refs/heads/main"]], [main, next.sha]);
  const fresh = await openRepo({ dir: path.join(root, "host-2"), remote });
  assert.equal(await fresh.resolve(MAIN), next.sha);
  const built = await fresh.commitTo(MAIN, { files: { "c.md": "c\n" }, message: "c" });
  assert.equal((await fresh.log({ max: 1 }))[0].parents[0], next.sha);
  await fresh.push(built.sha, MAIN);
});

test("read and list on a branch fetch first: a remote that moved is seen at once; a sha reads locally", async () => {
  const root = await scratch();
  const { remote, seeder, main } = await seededRemote(root, { "a.md": "old\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const moved = await seeder.commitTo(MAIN, { files: { "a.md": "new\n", "b.md": "b\n" }, message: "moves" });
  await seeder.push(moved.sha, MAIN);
  assert.equal(await repo.read("a.md", MAIN), "new\n");
  assert.deepEqual((await repo.list("", MAIN)).map((e) => e.path), ["a.md", "b.md"]);
  assert.equal(await repo.read("a.md", main), "old\n");
});

test("checkout reads and writes in bounded batches: hundreds of files and files larger than a batch all arrive whole", async () => {
  const root = await scratch();
  const big = { maxFiles: 1000, maxFileBytes: 8 * 1024 * 1024 };
  const remoteDir = await bareRepo(path.join(root, "remote.git"));
  const seeder = await openRepo({ dir: path.join(root, "seeder"), remote: local(remoteDir), limits: big });
  const files = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`small/f${String(i).padStart(3, "0")}.md`, `file ${i}\n`]));
  for (let i = 0; i < 3; i++) files[`large/l${i}.bin`] = Buffer.alloc(6 * 1024 * 1024, 97 + i);
  const { sha } = await seeder.commitTo(MAIN, { files, message: "many and large" });
  await seeder.push(sha, MAIN);
  const fake = await recordingGit(root);
  const repo = await openRepo({ dir: path.join(root, "host"), remote: local(remoteDir), limits: big, git: fake.git });
  const into = path.join(root, "work");
  const out = await repo.checkout(MAIN, { into });
  const reads = (await fake.calls()).filter((c) => c.verb === "cat-file" && c.argv.includes("--batch"));
  assert.ok(reads.length >= 4, `the tree is read in bounded batches, not at once (${reads.length} reads)`);
  assert.equal(out.files.length, 603);
  assert.deepEqual(out.skipped, []);
  assert.equal(await readFile(path.join(into, "small/f599.md"), "utf8"), "file 599\n");
  for (let i = 0; i < 3; i++) assert.ok((await readFile(path.join(into, `large/l${i}.bin`))).equals(files[`large/l${i}.bin`]));
});

test("a commit message holding control characters keeps its trailers, so a retry finds it by Run-Id", async () => {
  const root = await scratch();
  const { remote } = await seededRemote(root);
  const odd = ["a", "b", "c", "d"].join(String.fromCharCode(0x1f)) + String.fromCharCode(0x1e) + String.fromCharCode(0x1d) + "e";
  const repo = await openRepo({ dir: path.join(root, "host"), remote });
  const made = await repo.commitTo("runs/odd", { files: { "inbox/odd.md": "x\n" }, message: odd, trailers: { "Run-Id": "odd" } });
  await repo.push(made.sha, "runs/odd");
  const [entry] = await repo.log({ ref: "runs/odd", max: 1 });
  assert.deepEqual([entry.subject, entry.trailers], [odd, { "Run-Id": ["odd"] }]);
  const fresh = await openRepo({ dir: path.join(root, "host-2"), remote });
  assert.deepEqual(await fresh.commitTo("runs/odd", { files: { "inbox/odd.md": "y\n" }, message: "retry", trailers: { "Run-Id": "odd" } }), { sha: made.sha, created: false });
});

test("a directory reopened without its push URL ignores the push side's refs, and leaves them for a handle that has one", async () => {
  const root = await scratch();
  const { dir: mainDir, main } = await seededRemote(root);
  const hidden = await bareRepo(path.join(root, "hidden.git"));
  const dir = path.join(root, "host");
  const split = await openRepo({ dir, remote: { kind: "local", url: mainDir, pushUrl: hidden } });
  await split.push(main, MAIN);
  const ahead = await split.commitTo(MAIN, { files: { "b.md": "b\n" }, message: "b" });
  await split.push(ahead.sha, MAIN);
  const run = await split.commitTo("runs/r1", { files: { "inbox/r1.md": "x\n" }, message: "r1", trailers: { "Run-Id": "r1" } });
  await split.push(run.sha, "runs/r1");
  for (const ref of ["refs/heads/main", "refs/heads/runs/r1"]) await rawGit(["update-ref", "-d", ref], { gitDir: dir });
  const plain = await openRepo({ dir, remote: local(mainDir) });
  assert.deepEqual(Object.keys(await refsOf(dir)).filter((ref) => ref.startsWith("refs/remotes/pushed/")), ["refs/remotes/pushed/main", "refs/remotes/pushed/runs/r1"]);
  assert.equal(await plain.resolve("runs/r1"), undefined);
  assert.equal(await plain.resolve(MAIN), main, "the fetch URL's main, not the push side's");
  assert.equal((await plain.commitTo("runs/r1", { files: { "inbox/r1.md": "y\n" }, message: "r1", trailers: { "Run-Id": "r1" } })).created, true);
  assert.equal(await split.resolve(MAIN), ahead.sha, "the handle with the push URL still sees the newer tip");
});
