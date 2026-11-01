// Notes in Claude Code's auto-memory format: parsed front matter, the active ones, and the index the host builds.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as learn from "../dist/index.js";

const note = (head, body = "The body.\n") => `---\n${head}\n---\n${body}`;
const REFUND = note("name: Refund policy path\ndescription: Shopify stores keep their policies at /policies/\ntype: reference", "Open /policies/ first.\n");

test("a note's front matter: name, description and type, active when it has no status, and its body after", () => {
  assert.deepEqual(learn.parseNoteFile("refund-policy-path.md", REFUND), {
    file: "refund-policy-path.md", name: "Refund policy path", description: "Shopify stores keep their policies at /policies/", type: "reference",
    status: "active", superseded_by: null, body: "Open /policies/ first.\n",
  });
  const old = learn.parseNoteFile("old.md", note('name: "Old: quoted"\ndescription: \'single\'\ntype: feedback\nstatus: superseded\nsuperseded_by: refund-policy-path.md\nsupersedes: [x.md]'));
  assert.deepEqual([old.name, old.description, old.status, old.superseded_by], ["Old: quoted", "single", "superseded", "refund-policy-path.md"], "quotes are cut, and a key it does not know is left alone");
  assert.equal(learn.parseNoteFile("r.md", note("name: R\ndescription: d\ntype: user\nstatus: retired")).status, "retired");
  assert.equal(learn.parseNoteFile("crlf.md", "---\r\nname: C\r\ndescription: d\r\ntype: project\r\n---\r\nBody.\r\n").body, "Body.\n");
  assert.equal(learn.parseNoteFile("bare.md", "---\nname: B\ndescription: d\ntype: user\n---").body, "", "a note may end at its front matter");
  assert.deepEqual([...learn.NOTE_TYPES], ["user", "feedback", "project", "reference"]);
});

test("a note out of shape says why, and a file name that is the index, hidden or under a directory is no note's", () => {
  const problems = (file, text) => learn.parseNoteFile(file, text);
  assert.deepEqual(problems("a.md", "no front matter\n"), ["it does not start with front matter"]);
  assert.deepEqual(problems("a.md", "---\nname: a\n"), ["its front matter is not closed"]);
  assert.deepEqual(problems("a.md", note("type: lesson")), ["name is missing", "description is missing", "type is not user, feedback, project, reference"]);
  assert.deepEqual(problems("a.md", note("name: a\ndescription: d\ntype: user\nstatus: archived")), ["status is not superseded or retired"]);
  assert.deepEqual(problems("a.md", note("name: a\nname: b\ndescription: d\ntype: user")), ["name appears twice"]);
  assert.deepEqual(problems("a.md", note("name: a\ndescription: d\ntype: user\nsuperseded_by: ../x.md")), ["superseded_by is not a note's file name"]);
  assert.deepEqual(problems("a.md", note("name: a\n- list\ndescription: d\ntype: user")), ['the front matter line "- list" is not "key: value"']);
  for (const file of ["MEMORY.md", ".hidden.md", "dir/a.md", "a.txt", "a b.md"]) assert.ok(Array.isArray(problems(file, REFUND)), file);
});

test("the index: one line per active note, by file name, built from its front matter; empty with none active", () => {
  const notes = [
    learn.parseNoteFile("refund-policy-path.md", REFUND),
    learn.parseNoteFile("old-refunds.md", note("name: Old refunds\ndescription: Refunds were under /help/\ntype: reference\nstatus: superseded\nsuperseded_by: refund-policy-path.md")),
    learn.parseNoteFile("prefers-tables.md", note("name: Prefers   tables\ndescription: The user reads results\ttables\ntype: user")),
    learn.parseNoteFile("retired.md", note("name: Retired\ndescription: gone\ntype: project\nstatus: retired")),
  ];
  assert.ok(notes.every((n) => !Array.isArray(n)), JSON.stringify(notes));
  assert.deepEqual(learn.activeNotes(notes).map((n) => n.file), ["prefers-tables.md", "refund-policy-path.md"]);
  assert.equal(learn.buildIndex(notes), "- [Prefers tables](prefers-tables.md) — The user reads results tables\n- [Refund policy path](refund-policy-path.md) — Shopify stores keep their policies at /policies/\n");
  assert.equal(learn.buildIndex([]), "");
  assert.equal(learn.buildIndex(notes.slice(1, 2)), "", "a superseded note is not in the index");
  assert.equal(learn.INDEX_FILE, "MEMORY.md");
  assert.equal(learn.INDEX_LINES, 200);
});

test("what a run reads of the index: its first 200 lines, cut to whole lines within 25 KB, as Claude Code loads its own", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `- [n${i}](n${i}.md) — note ${i}`);
  assert.equal(learn.loadedIndex(`${lines.join("\n")}\n`), lines.slice(0, 200).join("\n"));
  assert.equal(learn.loadedIndex("- [a](a.md) — a\n"), "- [a](a.md) — a\n", "a short index is read whole");
  const long = Array.from({ length: 100 }, (_, i) => `- [n${i}](n${i}.md) — ${"x".repeat(400)}`);
  const read = learn.loadedIndex(long.join("\n"));
  assert.ok(Buffer.byteLength(read) <= learn.INDEX_BYTES, `${Buffer.byteLength(read)} bytes`);
  assert.equal(read, long.slice(0, read.split("\n").length).join("\n"), "whole lines only");
  assert.equal(read.split("\n").length, 59);
});
