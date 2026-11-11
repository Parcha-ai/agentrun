// A cut diff's note names where each file past the cut starts in the filed copy and how many lines it runs
// (filed-answer.ts diffIndex), so a reader reads the files it needs by range and passes a generated one by. A file wholly
// shown is not named; an answer that is no diff gets no index.
import assert from "node:assert/strict";
import { test } from "node:test";

const { diffIndex, filedAnswer } = await import("../dist/filed-answer.js");

const file = (path, n) => [`diff --git a/${path} b/${path}`, "--- a/" + path, "+++ b/" + path, `@@ -1,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+line ${i}`)];
const diff = [...file("src/a.ts", 4), ...file("lib/cmd.generated.mjs", 2000), ...file("src/b.ts", 10)];

test("each file past the cut, from the line it starts at, with its lines; a file wholly shown is not named", () => {
  assert.equal(diffIndex(diff, 8), "; files past the cut, from the line each starts at (its lines): lib/cmd.generated.mjs 9 (2004), src/b.ts 2013 (14)");
  assert.equal(diffIndex(["no", "diff"], 1), "");
});

test("the filed answer's note carries the index after the offset to go on", async () => {
  const kept = new Map();
  const note = await filedAnswer({ write: async (path, text) => void kept.set(path, text) }, "evidence/mcp/github", "get_diff", diff.join("\n"), 200);
  assert.match(note, /read it with offset=\d+ to go on; files past the cut, from the line each starts at \(its lines\): .*lib\/cmd\.generated\.mjs 9 \(2004\), src\/b\.ts 2013 \(14\)\]$/);
  const filed = kept.get("evidence/mcp/github/get_diff.txt").split("\n");
  assert.equal(filed[2012], "diff --git a/src/b.ts b/src/b.ts", "the index's line is the filed copy's");
});
