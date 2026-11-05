// Notes in Claude Code's auto-memory format: parsed front matter, the active ones, and the index the host builds.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as format from "../dist/learn/notes.js";

const note = (head, body = "The body.\n") => `---\n${head}\n---\n${body}`;
const REFUND = note("name: Refund policy path\ndescription: Shopify stores keep their policies at /policies/\ntype: reference", "Open /policies/ first.\n");

test("a note's front matter: name, description and type, active when it has no status, and its body after", () => {
  assert.deepEqual(format.parseNoteFile("refund-policy-path.md", REFUND), {
    file: "refund-policy-path.md", name: "Refund policy path", description: "Shopify stores keep their policies at /policies/", type: "reference",
    status: "active", origin: "run", superseded_by: null, supersedes: [], keys: ["name", "description", "type"], body: "Open /policies/ first.\n",
  });
  const old = format.parseNoteFile("old.md", note('name: "Old: quoted"\ndescription: \'single\'\ntype: feedback\nstatus: superseded\nsuperseded_by: refund-policy-path.md\nsupersedes: [x.md, "y.md"]\nsource: elsewhere'));
  assert.deepEqual([old.name, old.description, old.status, old.superseded_by, old.supersedes], ["Old: quoted", "single", "superseded", "refund-policy-path.md", ["x.md", "y.md"]], "quotes are cut, and a key it does not know is left alone");
  assert.deepEqual(old.keys, ["name", "description", "type", "status", "superseded_by", "supersedes", "source"]);
  assert.deepEqual(format.parseNoteFile("one.md", note("name: O\ndescription: d\ntype: user\nsupersedes: x.md")).supersedes, ["x.md"], "one bare name is a list of one");
  assert.deepEqual(format.parseNoteFile("none.md", note("name: O\ndescription: d\ntype: user\nsupersedes: []")).supersedes, []);
  assert.equal(format.parseNoteFile("r.md", note("name: R\ndescription: d\ntype: user\nstatus: retired")).status, "retired");
  assert.equal(format.parseNoteFile("crlf.md", "---\r\nname: C\r\ndescription: d\r\ntype: project\r\n---\r\nBody.\r\n").body, "Body.\n");
  assert.equal(format.parseNoteFile("bare.md", "---\nname: B\ndescription: d\ntype: user\n---").body, "", "a note may end at its front matter");
  assert.deepEqual([...format.NOTE_TYPES], ["user", "feedback", "project", "reference"]);
});

test("a note out of shape says why, and a file name that is the index, hidden or under a directory is no note's", () => {
  const problems = (file, text) => format.parseNoteFile(file, text);
  assert.deepEqual(problems("a.md", "no front matter\n"), ["it does not start with front matter"]);
  assert.deepEqual(problems("a.md", "---\nname: a\n"), ["its front matter is not closed"]);
  assert.deepEqual(problems("a.md", note("type: lesson")), ["name is missing", "description is missing", "type is not user, feedback, project, reference"]);
  assert.deepEqual(problems("a.md", note("name: a\ndescription: d\ntype: user\nstatus: archived")), ["status is not superseded, retired or pending"]);
  assert.deepEqual(problems("a.md", note("name: a\ndescription: d\ntype: user\norigin: page")), ["origin is not you or run"]);
  assert.deepEqual(problems("a.md", note("name: a\nname: b\ndescription: d\ntype: user")), ["name appears twice"]);
  assert.deepEqual(problems("a.md", note("name: a\ndescription: d\ntype: user\nsuperseded_by: ../x.md")), ["superseded_by is not a note's file name"]);
  assert.deepEqual(problems("a.md", note("name: a\n- list\ndescription: d\ntype: user")), ['the front matter line "- list" is not "key: value"']);
  assert.deepEqual(problems("a.md", note("name: a\ndescription: d\ntype: user\nsupersedes: [b.md, ../c.md]")), ["supersedes is not a list of notes' file names"]);
  assert.deepEqual(problems("a.md", note("name: a\ndescription: d\ntype: user\nsupersedes: [b.md, b.md]")), ["supersedes names a note twice"]);
  for (const file of ["MEMORY.md", ".hidden.md", "dir/a.md", "a.txt", "a b.md"]) assert.ok(Array.isArray(problems(file, REFUND)), file);
});

test("the index: one line per active note, by file name, built from its front matter; empty with none active", () => {
  const notes = [
    format.parseNoteFile("refund-policy-path.md", REFUND),
    format.parseNoteFile("old-refunds.md", note("name: Old refunds\ndescription: Refunds were under /help/\ntype: reference\nstatus: superseded\nsuperseded_by: refund-policy-path.md")),
    format.parseNoteFile("prefers-tables.md", note("name: Prefers   tables\ndescription: The user reads results\ttables\ntype: user")),
    format.parseNoteFile("retired.md", note("name: Retired\ndescription: gone\ntype: project\nstatus: retired")),
  ];
  assert.ok(notes.every((n) => !Array.isArray(n)), JSON.stringify(notes));
  assert.deepEqual(format.activeNotes(notes).map((n) => n.file), ["prefers-tables.md", "refund-policy-path.md"]);
  assert.equal(format.buildIndex(notes), "- [Prefers tables](prefers-tables.md) — The user reads results tables\n- [Refund policy path](refund-policy-path.md) — Shopify stores keep their policies at /policies/\n");
  assert.equal(format.buildIndex([]), "");
  assert.equal(format.buildIndex(notes.slice(1, 2)), "", "a superseded note is not in the index");
  assert.equal(format.INDEX_FILE, "MEMORY.md");
  assert.equal(format.INDEX_LINES, 200);
});

test("what a run reads of the index: its first 200 lines, cut to whole lines within 25 KB, as Claude Code loads its own", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `- [n${i}](n${i}.md) — note ${i}`);
  assert.equal(format.loadedIndex(`${lines.join("\n")}\n`), lines.slice(0, 200).join("\n"));
  assert.equal(format.loadedIndex("- [a](a.md) — a\n"), "- [a](a.md) — a\n", "a short index is read whole");
  const long = Array.from({ length: 100 }, (_, i) => `- [n${i}](n${i}.md) — ${"x".repeat(400)}`);
  const read = format.loadedIndex(long.join("\n"));
  assert.ok(Buffer.byteLength(read) <= format.INDEX_BYTES, `${Buffer.byteLength(read)} bytes`);
  assert.equal(read, long.slice(0, read.split("\n").length).join("\n"), "whole lines only");
  assert.equal(read.split("\n").length, 59);
});

test("supersede: the host marks an old note superseded by a new one, in place of any status it had, and leaves the rest", () => {
  const marked = format.supersede(REFUND, "refund-v2.md");
  assert.equal(marked, "---\nname: Refund policy path\ndescription: Shopify stores keep their policies at /policies/\ntype: reference\nstatus: superseded\nsuperseded_by: refund-v2.md\n---\nOpen /policies/ first.\n");
  const parsed = format.parseNoteFile("refund-policy-path.md", marked);
  assert.deepEqual([parsed.status, parsed.superseded_by, parsed.body], ["superseded", "refund-v2.md", "Open /policies/ first.\n"]);
  assert.equal(format.buildIndex([parsed]), "", "it leaves the index");
  const twice = format.supersede(format.supersede("---\r\nname: C\r\ndescription: d\r\ntype: user\r\nstatus: retired\r\n---\r\nBody.\r\n", "a.md"), "b.md");
  assert.equal(twice, "---\nname: C\ndescription: d\ntype: user\nstatus: superseded\nsuperseded_by: b.md\n---\nBody.\n");
  assert.throws(() => format.supersede("no front matter", "a.md"), /front matter/);
  assert.throws(() => format.supersede(REFUND, "../a.md"), /file name/);
});

test("a pending note waits for its owner: it parses, holds its origin, and is in no index; approve makes it active and keeps its origin; the host's merge sets origin, and status pending for one that waits", () => {
  const asked = note("name: Buy from PaperDepot first\ndescription: Prices\ntype: user\norigin: you\nstatus: pending");
  const parsed = format.parseNoteFile("paperdepot.md", asked);
  assert.deepEqual([parsed.status, parsed.origin], ["pending", "you"]);
  assert.deepEqual([...format.NOTE_STATUSES], ["active", "superseded", "retired", "pending"]);
  assert.deepEqual([...format.NOTE_ORIGINS], ["you", "run"]);
  assert.equal(format.buildIndex([parsed]), "", "a pending note is not in the index, so no run reads it");
  const approved = format.approve(asked);
  assert.equal(approved, "---\nname: Buy from PaperDepot first\ndescription: Prices\ntype: user\norigin: you\n---\nThe body.\n");
  assert.equal(format.parseNoteFile("paperdepot.md", approved).status, "active");
  assert.equal(format.buildIndex([format.parseNoteFile("paperdepot.md", approved)]), "- [Buy from PaperDepot first](paperdepot.md) — Prices\n");
  assert.equal(format.retire(asked), "---\nname: Buy from PaperDepot first\ndescription: Prices\ntype: user\norigin: you\nstatus: retired\n---\nThe body.\n", "a pending note can be retired");
  assert.equal(format.mergedNote(REFUND, { origin: "run" }), REFUND, "a note the run worked out carries no origin line: absent reads as run");
  assert.equal(format.mergedNote(note("name: T\ndescription: d\ntype: user\norigin: run"), { origin: "you", pending: true }), "---\nname: T\ndescription: d\ntype: user\norigin: you\nstatus: pending\n---\nThe body.\n", "the host's own lines, in place of any");
  assert.equal(format.mergedNote(note("name: T\ndescription: d\ntype: user\norigin: you"), { origin: "run" }), note("name: T\ndescription: d\ntype: user"));
  assert.throws(() => format.mergedNote(REFUND, { origin: "page" }), /origin/);
});

test("a run's note merged with no `type:` reads as a project note on main; the merge adds no type line, so the host's own lines stay within the cap", () => {
  const text = "---\nname: Ships from Reno\ndescription: Where orders ship from\n---\nWe ship from Reno.\n";
  const merged = format.mergedNote(text, { origin: "you", pending: true });
  assert.equal(merged, "---\nname: Ships from Reno\ndescription: Where orders ship from\norigin: you\nstatus: pending\n---\nWe ship from Reno.\n");
  const parsed = format.parseNoteFile("ships-from-reno.md", merged);
  assert.equal(Array.isArray(parsed) ? parsed.join("; ") : parsed.type, "project");
});
