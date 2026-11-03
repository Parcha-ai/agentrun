// The server's learning code as one surface (src/learn/index.ts): every name the rest of the server, and the branches
// above it, import, each the same binding as in its own module.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as check from "../dist/learn/check.js";
import * as grade from "../dist/learn/grade.js";
import * as learn from "../dist/learn/index.js";
import * as invisible from "../dist/learn/invisible.js";
import * as notes from "../dist/learn/notes.js";
import * as reflect from "../dist/learn/reflect.js";
import * as secrets from "../dist/learn/secrets.js";

const VALUES = {
  check: ["CAPS", "checkNote", "checkProposal", "mergeProblems", "printable"],
  grade: ["GRADE_CAPS", "GRADE_RUBRIC", "gradePrompt", "parseVerdict"],
  invisible: ["hiddenCharacter"],
  reflect: ["reflectPrompt"],
  notes: ["activeNotes", "buildIndex", "INDEX_BYTES", "INDEX_FILE", "INDEX_LINES", "indexLine", "loadedIndex", "NOTE_FILE", "NOTE_STATUSES", "NOTE_TYPES", "parseNoteFile", "retire", "supersede"],
  secrets: ["MIN_SECRET", "PRINT_MAX", "redactSecrets", "secretShapes", "valueMatcher"],
};
const MODULES = { check, grade, invisible, reflect, notes, secrets };
const TYPES = ["Base", "Change", "CheckInput", "GradeInput", "IndexEntry", "LearnedNote", "NoteStatus", "NoteText", "NoteType", "Problem", "ProposalCheck", "ProposedNote", "Rule", "Verdict", "VerdictItem"];

test("the index exports every value of the learning modules, each the same binding as its module's, and nothing else", () => {
  assert.deepEqual(Object.keys(learn).sort(), Object.values(VALUES).flat().sort());
  for (const [module, names] of Object.entries(VALUES)) {
    for (const name of names) {
      assert.notEqual(learn[name], undefined, name);
      assert.equal(learn[name], MODULES[module][name], `${name} is ${module}'s`);
    }
  }
});

test("the index exports the types too, as its declarations say", () => {
  const declared = readFileSync(new URL("../dist/learn/index.d.ts", import.meta.url), "utf8");
  const exported = [...declared.matchAll(/export\s*\{([^}]*)\}\s*from/g)].flatMap((m) => m[1].split(",")).map((name) => name.trim()).filter(Boolean);
  const types = exported.filter((name) => name.startsWith("type ")).map((name) => name.slice("type ".length));
  assert.deepEqual(types.sort(), [...TYPES].sort());
});

test("what the branches above #1378 import from @parcha/agentrun-learn, the index has", () => {
  const values = ["INDEX_FILE", "loadedIndex", "NOTE_FILE", "parseNoteFile", "redactSecrets", "secretShapes", "valueMatcher", "parseVerdict", "CAPS", "checkProposal", "printable", "buildIndex", "supersede", "mergeProblems", "NOTE_STATUSES", "NOTE_TYPES"];
  for (const name of values) assert.notEqual(learn[name], undefined, name);
  for (const name of ["LearnedNote", "Problem", "Verdict", "NoteText", "IndexEntry"]) assert.ok(TYPES.includes(name), name);
  assert.equal(learn.parseVerdict("not json", ["a.md"]).merge, false, "parseVerdict resolves, and fails closed");
});
