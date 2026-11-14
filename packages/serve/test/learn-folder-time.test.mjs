// A commit's time as the learning folder's snapshot keeps it (learn/folder.ts commitTime): git's %cI carries the offset
// git's version and the committer's zone give it ("+00:00", "+02:00", or "Z"), and the snapshot rebuilt from git must
// say the same time the incremental snapshot (nextSnapshot) wrote: UTC in whole seconds, ending "Z".
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitTime, nextSnapshot, parseRead } from "../dist/learn/folder.js";

/** The script's `read` with one commit at `cI` and no tree or blob, as learning.sh prints it. */
function readWith(cI) {
  const sha = "a".repeat(40);
  const log = `\x1e${[sha, cI, "learning: init", "", "", "", ""].join("\x1f")}\0MEMORY.md\0`;
  const head = `agentrun-read 1 ${sha} 0 ${Buffer.byteLength(log)} 0\n`;
  return Buffer.from(`${head}${log}`, "utf8");
}

test("parseRead keeps every commit time in UTC ending Z, whatever offset git printed: +00:00, +02:00 and Z read as one instant", () => {
  for (const [printed, kept] of [["2026-11-10T05:18:16+00:00", "2026-11-10T05:18:16Z"], ["2026-11-10T07:18:16+02:00", "2026-11-10T05:18:16Z"], ["2026-11-10T05:18:16Z", "2026-11-10T05:18:16Z"]]) {
    const [record] = parseRead(readWith(printed)).records;
    assert.equal(record.commit.at, kept, printed);
  }
});

test("a commit time read from git and the one nextSnapshot writes for the same second are the same text", () => {
  const seconds = Date.parse("2026-11-10T05:18:16Z") / 1000;
  const { snapshot } = nextSnapshot(undefined, undefined, seconds);
  assert.equal(snapshot.at, "2026-11-10T05:18:16Z");
  assert.equal(commitTime("2026-11-10T05:18:16+00:00"), snapshot.at);
  assert.equal(commitTime("not a time"), "not a time", "text that is no time is kept as it is");
});
