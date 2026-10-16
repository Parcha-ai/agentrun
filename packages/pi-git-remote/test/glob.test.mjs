import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAllowlist } from "../dist/glob.js";
import { GitRemoteError } from "../dist/index.js";

const refusal = (patterns) => assert.throws(() => compileAllowlist(patterns), (error) => error instanceof GitRemoteError && error.code === "refused");

test("a pattern names whole segments: * stays in one segment, ** crosses any number, ? is one character", () => {
  const { matches } = compileAllowlist(["notes/**", "docs/*.md", "skills/*/SKILL.md", "a?c.txt", "**/keep.json"]);
  for (const yes of ["notes/a.md", "notes/deep/er/b.md", "notes/.hidden", "docs/x.md", "skills/s/SKILL.md", "abc.txt", "keep.json", "x/y/keep.json"]) assert.ok(matches(yes), yes);
  for (const no of ["notes", "other/notes/a.md", "docs/sub/x.md", "docs/x.txt", "skills/SKILL.md", "skills/a/b/SKILL.md", "ac.txt", "abbc.txt", "Notes/a.md", "keep.jsonx"]) assert.ok(!matches(no), no);
});

test("a directory can hold a match only when a pattern could name something below it", () => {
  const { mayContain } = compileAllowlist(["notes/**", "docs/*.md", "**/keep.json", "a/b"]);
  for (const yes of ["", "notes", "notes/deep", "docs", "anything", "a"]) assert.ok(mayContain(yes), yes);
  const strict = compileAllowlist(["notes/**", "docs/*.md", "a/b"]);
  for (const no of ["build", "node_modules", ".git", "docs/sub", "a/b", "other/notes"]) assert.ok(!strict.mayContain(no), no);
  assert.ok(strict.mayContain("docs") && strict.mayContain("a") && strict.mayContain("notes/x/y"));
});

test("a pattern that tries more than * ? and ** is refused, not read as literal text", () => {
  refusal([]);
  refusal([""]);
  refusal(["/abs/**"]);
  refusal(["notes/"]);
  refusal(["notes//a.md"]);
  refusal(["./notes/**"]);
  refusal(["../x"]);
  refusal(["a/../b"]);
  refusal(["!notes/**"]);
  refusal(["notes/[ab].md"]);
  refusal(["notes/{a,b}.md"]);
  refusal(["no\\tes"]);
  refusal(["a**b"]);
  refusal(["x\u0000y"]);
  refusal(["a".repeat(600)]);
  refusal([42]);
});

test("a pattern with many stars does not blow up on a path built to defeat a backtracking matcher", () => {
  const { matches } = compileAllowlist(["*a*a*a*a*a*a*a*a*a*a*b"]);
  const started = Date.now();
  assert.equal(matches("a".repeat(250)), false);
  assert.ok(Date.now() - started < 500);
});
