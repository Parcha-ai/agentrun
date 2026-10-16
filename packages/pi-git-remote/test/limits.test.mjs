import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { caseCollisions, DEFAULT_LIMITS, GitRemoteError, modeRefusal, openRepo, pathRefusal } from "../dist/index.js";
import { refsOf, scratch, seededRemote } from "./support.mjs";

test("pathRefusal refuses .git in every spelling git or a case-insensitive file system treats as .git", () => {
  const dotGit = [
    ".git", ".GIT", ".Git/config", "a/.git/hooks/post-checkout", ".git.", ".git ", ".git. . ", "learnings/.git./x",
    "git~1", "GIT~2/hooks/x", ".git::$INDEX_ALLOCATION/hooks/x", ".git:stream",
    ".g\u200cit", ".gi\u200dt/hooks/x", "\u200e.git", ".git\ufeff", ".\u206agit", ".g\u202eit", "a/.G\u200bIT/x",
    "\uff0egit/hooks/post-checkout", ".g\u0131t/hooks/post-checkout", ".\uff47\uff49\uff54", "\uff0egit\uff0fx",
  ];
  for (const p of dotGit) assert.equal(pathRefusal(p), "a .git segment", JSON.stringify(p));
  for (const p of [".gitignore", ".gitattributes", ".github/workflows/ci.yml", "git", "my.git", ".git-hooks/x", "a.git/b", "learnings/L-1.md"]) {
    assert.equal(pathRefusal(p), undefined, JSON.stringify(p));
  }
});

test("pathRefusal refuses absolute paths, .., empty or dot segments, backslashes, control characters and overlong names", () => {
  const cases = {
    "": "empty",
    "/etc/passwd": "absolute",
    "../x": "a .. segment",
    "a/../b": "a .. segment",
    "a//b": "not canonical",
    "./a": "not canonical",
    "a/": "not canonical",
    "a\\b": "a backslash",
    "a\nb": "a control character",
    "a\tb": "a control character",
    "a\u0085b": "a control character",
    [`${"x".repeat(256)}`]: "a segment too long",
    [`${"abcdefgh/".repeat(120)}x`]: "too long",
  };
  for (const [p, reason] of Object.entries(cases)) assert.equal(pathRefusal(p), reason, JSON.stringify(p));
});

test("modeRefusal allows regular files only", () => {
  assert.equal(modeRefusal("100644"), undefined);
  assert.equal(modeRefusal("100755"), undefined);
  assert.equal(modeRefusal("120000"), "a symlink");
  assert.equal(modeRefusal("160000"), "a submodule");
  assert.equal(modeRefusal("040000"), "a directory");
  assert.equal(modeRefusal("100664"), "mode 100664");
});

test("caseCollisions finds paths and directories that differ only in case or Unicode form, limited to the touched ones", () => {
  assert.deepEqual(caseCollisions(["Notes.md", "notes.md"]), [["Notes.md", "notes.md"]]);
  assert.deepEqual(caseCollisions(["Docs/a.md", "docs/b.md"]), [["Docs", "docs"]]);
  assert.deepEqual(caseCollisions(["caf\u00e9.md", "cafe\u0301.md"]), [["cafe\u0301.md", "caf\u00e9.md"]]);
  assert.deepEqual(caseCollisions(["a\u200cb.md", "ab.md"]), [["ab.md", "a\u200cb.md"]]);
  assert.deepEqual(caseCollisions(["A.md", "a.md", "x/B.md", "x/b.md"], ["x/b.md"]), [["x/B.md", "x/b.md"]]);
  assert.deepEqual(caseCollisions(["a.md", "b/c.md"]), []);
});

test("commitTo refuses bad paths, too many files, files over the cap, a file and a directory at one path, and case collisions; nothing moves", async () => {
  const root = await scratch();
  const { dir, remote } = await seededRemote(root, { "Notes.md": "n\n", "dir/a.md": "a\n" });
  const repo = await openRepo({ dir: path.join(root, "host"), remote, limits: { maxFiles: 3, maxFileBytes: 64 } });
  assert.deepEqual(repo.limits, { ...DEFAULT_LIMITS, maxFiles: 3, maxFileBytes: 64 });
  const before = { remote: await refsOf(dir), host: await refsOf(repo.dir) };
  const refusals = [
    { "a/.git/hooks/post-checkout": "#!/bin/sh\n" },
    { "../escape.md": "x" },
    { "/abs.md": "x" },
    { "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" },
    { "big.md": "x".repeat(65) },
    { "x": "file", "x/y.md": "under it" },
    { "notes.md": "collides with Notes.md on the base tree" },
    { "new/One.md": "1", "new/one.md": "2" },
    { "dir/a.md/inner.md": "a file of the base tree used as a directory" },
    { "ok.md": 42 },
  ];
  for (const files of refusals) {
    await assert.rejects(repo.commitTo("main", { files, message: "refused" }), (error) => error instanceof GitRemoteError && error.code === "refused", JSON.stringify(Object.keys(files)));
  }
  await assert.rejects(repo.commitTo("bad..branch", { files: { "a.md": "a" }, message: "m" }), { code: "refused" });
  await assert.rejects(repo.commitTo("main", { files: { "a.md": "a" }, message: "  " }), { code: "refused" });
  await assert.rejects(repo.commitTo("main", { files: { "a.md": "a" }, message: "m", trailers: { "Run-Id": "two\nlines" } }), { code: "refused" });
  assert.deepEqual(await refsOf(dir), before.remote);
  assert.deepEqual(await refsOf(repo.dir), before.host);
  const ok = await repo.commitTo("main", { files: { "c.md": "x".repeat(64) }, message: "at the cap" });
  assert.equal(ok.created, true);
});
