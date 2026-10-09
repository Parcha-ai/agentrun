import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captionFor } from "../page/caption.ts";
import { PipeFeed } from "../pipe-feed.ts";
import { parseReadbackLine, readbackNote, ReadbackWatcher, type ReadbackNote } from "../readback.ts";
import { fold } from "../reduce.ts";

// Lines as 03's server writes them (pipe/server.ts: log("pipe.readback", {...})); the digests are made up.
const D = "ab".repeat(32);
const line = (event: string, data: Record<string, unknown>) => JSON.stringify({ at: "2026-10-09T10:00:00.000Z", event, ...data });
const readback = (over: Record<string, unknown> = {}) => line("pipe.readback", { run: "r1", generation: 2, startedAfterMs: 120, ms: 340, files: 12, bytes: 1_300_000, digest: D, kept: D, acked: D, match: true, ackedMatch: true, ...over });

test("a read-back equal to the pipe's seal and to what the tab acknowledged is the verified result", () => {
  assert.deepEqual(parseReadbackLine(readback()), { kind: "verified", run: "r1", files: 12, bytes: 1_300_000, ms: 340 });
});

test("only two strict trues are a verdict of zero loss; anything else is shown for what it is", () => {
  assert.equal(parseReadbackLine(readback({ ackedMatch: null }))?.kind, "unacked", "the leaving host acknowledged nothing");
  assert.equal(parseReadbackLine(readback({ match: false }))?.kind, "differs");
  assert.equal(parseReadbackLine(readback({ ackedMatch: false }))?.kind, "differs");
  assert.equal(parseReadbackLine(readback({ match: "true" })), undefined, "a string is not a verdict");
  assert.equal(parseReadbackLine(readback({ ackedMatch: "true" })), undefined);
  assert.equal(parseReadbackLine(readback({ ackedMatch: undefined })), undefined, "a missing field is not a verdict");
  assert.equal(parseReadbackLine(readback({ files: "12" })), undefined);
  assert.equal(parseReadbackLine(readback({ run: undefined })), undefined);
});

test("the mismatch and failure events are read, with counts only", () => {
  assert.deepEqual(parseReadbackLine(line("pipe.readback-mismatch", { run: "r1", generation: 2, missing: ["a/b"], extra: [], differ: ["c", "d"], changedSinceRelease: ["c"] })), { kind: "paths", run: "r1", missing: 1, extra: 0, differ: 2, changedSinceRelease: 1 });
  assert.deepEqual(parseReadbackLine(line("pipe.readback-failed", { run: "r1", generation: 2, error: "S3 said no" })), { kind: "failed", run: "r1" });
});

test("any other line is not read, including the one that holds the run's link", () => {
  for (const l of [
    line("serve.run", { run: "r1", link: "http://127.0.0.1:1234/run/r1#SECRETVALUE" }),
    line("pipe.released", { run: "r1", digest: D }),
    "not json at all pipe.readback",
    '["pipe.readback"]',
    "",
  ]) assert.equal(parseReadbackLine(l), undefined, l);
});

test("only a verified read-back carries evidence, and no note carries a digest, a path or an error", () => {
  const notes: ReadbackNote[] = [
    readbackNote(parseReadbackLine(readback())!),
    readbackNote(parseReadbackLine(readback({ ackedMatch: null }))!),
    readbackNote(parseReadbackLine(readback({ match: false, ackedMatch: false }))!),
    readbackNote(parseReadbackLine(line("pipe.readback-mismatch", { run: "r1", missing: ["secret/path.txt"], extra: [], differ: [], changedSinceRelease: [] }))!),
    readbackNote(parseReadbackLine(line("pipe.readback-failed", { run: "r1", error: "bucket-name-xyz denied" }))!),
  ];
  assert.deepEqual(notes.map((n) => n.evidence), ["independent-readback", undefined, undefined, undefined, undefined]);
  assert.deepEqual(notes.map((n) => n.measured), [true, false, true, true, false]);
  for (const n of notes) assert.doesNotMatch(n.text, new RegExp(`${D}|secret/path|bucket-name|SECRET`));
  assert.match(notes[0]!.text, /12 files, 1\.2 MB, identical to what the tab had acknowledged and to what the pipe sealed \(read in 340 ms\)\. Nothing was lost\./);
  assert.match(notes[2]!.text, /DIFFERS from what the pipe sealed and from what the tab had acknowledged/);
  for (const n of notes.slice(1)) assert.doesNotMatch(n.text, /nothing was lost|zero loss/i, "no other result claims zero loss");
});

// The note goes through the page's own caption rule: verified is MEASURED, the rest never is a zero-loss claim.
const feedNotes = (...results: string[]) => {
  const feed = new PipeFeed({ run: "r1", clock: () => 5000 });
  for (const r of results) feed.addNote(readbackNote(parseReadbackLine(r)!));
  return feed;
};

test("a verified read-back reaches the stage as a MEASURED zero-loss caption, and a bad one as a measured difference", () => {
  const ok = feedNotes(readback());
  assert.equal(ok.events.at(-1)?.t, "note");
  assert.equal((ok.events.at(-1) as { evidence?: string }).evidence, "independent-readback");
  const cap = captionFor(fold([{ t: "run", at: 0, run: "r1", origin: 0, environments: [] }, ...ok.events]), 5100);
  assert.equal(cap?.tag, "measured");
  assert.match(cap!.text, /Nothing was lost/);
  const bad = feedNotes(readback({ match: false }));
  const badCap = captionFor(fold([{ t: "run", at: 0, run: "r1", origin: 0, environments: [] }, ...bad.events]), 5100);
  assert.match(badCap!.text, /DIFFERS/);
  assert.doesNotMatch(badCap!.text, /Nothing was lost/);
});

test("an unacknowledged read-back is a note with no caption and no claim", () => {
  const feed = feedNotes(readback({ ackedMatch: null }));
  assert.equal(feed.events.length, 1);
  assert.equal(captionFor(fold([{ t: "run", at: 0, run: "r1", origin: 0, environments: [] }, ...feed.events]), 5100), null);
});

// The watcher, on a real file.
function watch(run = "r1") {
  const dir = mkdtempSync(join(tmpdir(), "d5-readback-"));
  const file = join(dir, "server.log");
  const got: ReadbackNote[] = [];
  const w = new ReadbackWatcher({ file: () => file, run: () => run, key: () => "K", feedKey: () => "K", onNote: (n) => got.push(n) });
  return { dir, file, got, w, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the watcher starts at the end of the file it first sees, reads what is appended, and holds a half line until it is whole", () => {
  const { file, got, w, done } = watch();
  try {
    writeFileSync(file, `${readback({ files: 1 })}\n${line("serve.run", { run: "r1", link: "http://h/run/r1#SECRETVALUE" })}\n`);
    w.poll();
    assert.equal(got.length, 0, "what happened before the stage watched is not replayed");
    const whole = `${readback({ files: 7 })}\n`;
    appendFileSync(file, whole.slice(0, 40));
    w.poll();
    assert.equal(got.length, 0, "half a line");
    appendFileSync(file, whole.slice(40));
    w.poll();
    assert.equal(got.length, 1);
    assert.match(got[0]!.text, /7 files/);
    w.poll();
    assert.equal(got.length, 1, "read once");
  } finally {
    done();
  }
});

test("a line about another run is ignored, and a file that replaced the log (a restarted server) is read from its start", () => {
  const dir = mkdtempSync(join(tmpdir(), "d5-readback-"));
  const file = join(dir, "server.log");
  const got: ReadbackNote[] = [];
  const w = new ReadbackWatcher({ file: () => file, run: () => "r2", key: () => "K", feedKey: () => "K", onNote: (n) => got.push(n) });
  try {
    writeFileSync(file, "");
    w.poll();
    appendFileSync(file, `${readback({ run: "r1" })}\n${readback({ run: "r2", files: 3 })}\n`);
    w.poll();
    assert.deepEqual(got.map((n) => /(\d+) files/.exec(n.text)?.[1]), ["3"]);
    const next = join(dir, "next.log");
    writeFileSync(next, `${readback({ run: "r2", files: 9 })}\n`);
    renameSync(next, file);
    w.poll();
    assert.deepEqual(got.map((n) => /(\d+) files/.exec(n.text)?.[1]), ["3", "9"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing log, or none named yet, is not an error", () => {
  const got: ReadbackNote[] = [];
  new ReadbackWatcher({ file: () => undefined, run: () => "r1", key: () => "K", feedKey: () => "K", onNote: (n) => got.push(n) }).poll();
  new ReadbackWatcher({ file: () => join(tmpdir(), "d5-no-such-log-file"), run: () => "r1", key: () => "K", feedKey: () => "K", onNote: (n) => got.push(n) }).poll();
  assert.equal(got.length, 0);
});

// A retake: a new server writes a new log and a new link (a new key: its secret differs, even with the same port and run name). The stage's
// feed follows the link a moment later. A read-back is shown only on the take it belongs to: the one whose link key it was read under.
function retake(feedRun: string) {
  const dir = mkdtempSync(join(tmpdir(), "d5-readback-retake-"));
  const file = join(dir, "server.log");
  const got: ReadbackNote[] = [];
  const at = { link: "K1", feed: "K1", run: feedRun };
  const w = new ReadbackWatcher({ file: () => file, run: () => at.run, key: () => at.link, feedKey: () => at.feed, onNote: (n) => got.push(n) });
  writeFileSync(file, `${readback({ run: feedRun, files: 1 })}\n`);
  w.poll();
  const server = (link: string, run: string, files: number) => {
    const next = join(dir, "next.log");
    writeFileSync(next, `${readback({ run, files })}\n`);
    renameSync(next, file);
    at.link = link;
  };
  const files = () => got.map((n) => /(\d+) files/.exec(n.text)?.[1]);
  return { got, at, w, server, files, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a new server's read-back that lands before the feed has followed the new link is held, then shown on the new take", () => {
  const t = retake("old");
  try {
    t.server("K2", "new", 4);
    t.w.poll();
    assert.deepEqual(t.files(), [], "the feed is still on the old take: not shown, and not lost");
    t.at.feed = "K2";
    t.at.run = "new";
    t.w.poll();
    assert.deepEqual(t.files(), ["4"]);
    t.w.poll();
    assert.deepEqual(t.files(), ["4"], "once");
  } finally {
    t.done();
  }
});

test("a retake that keeps the run's name does not hand its read-back to the old take", () => {
  const t = retake("take");
  try {
    t.server("K2", "take", 6);
    t.w.poll();
    assert.deepEqual(t.files(), [], "the name matches, the link key does not: the feed is on the old take");
    t.at.feed = "K2";
    t.w.poll();
    assert.deepEqual(t.files(), ["6"]);
  } finally {
    t.done();
  }
});

test("a second retake before the feed follows the first: the first's held results are dropped, never shown on the second", () => {
  const t = retake("take");
  try {
    t.server("K2", "take", 7);
    t.w.poll();
    t.server("K3", "take", 8);
    t.w.poll();
    t.at.feed = "K3";
    t.w.poll();
    assert.deepEqual(t.files(), ["8"], "only the take the feed shows");
    t.at.feed = "K2";
    t.w.poll();
    assert.deepEqual(t.files(), ["8"], "and the dropped result does not come back");
  } finally {
    t.done();
  }
});

test("a result is never shown on a feed that is on another take, and one for a run the feed does not show is dropped", () => {
  const t = retake("old");
  try {
    t.server("K2", "other", 2);
    t.at.feed = "K2";
    t.w.poll();
    assert.deepEqual(t.files(), [], "the feed adopted the link but shows another run's name");
    const none = retake("old");
    none.at.link = "";
    none.w.poll();
    none.done();
  } finally {
    t.done();
  }
});

test("the server caps each list of differing paths at 50, so a full list is shown as a lower bound", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `f${i}`);
  const r = parseReadbackLine(line("pipe.readback-mismatch", { run: "r1", missing: fifty, extra: ["x"], differ: [], changedSinceRelease: fifty }));
  assert.ok(r && r.kind === "paths");
  const text = readbackNote(r!).text;
  assert.match(text, /at least 50 missing, 0 changed and 1 extra paths; at least 50 of them were written/);
  assert.match(readbackNote(parseReadbackLine(line("pipe.readback-mismatch", { run: "r1", missing: ["a"], extra: [], differ: ["b", "c"], changedSinceRelease: [] }))!).text, /1 missing, 2 changed and 0 extra paths; 0 of them were written/);
});
