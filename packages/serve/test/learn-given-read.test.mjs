// What a run started from and what it read of its learning: `given`, every note named in its `# Learned` section
// (whole, or as an index line naming its file), and `read`, the note files it opened with the read tool. Whether a run
// applied a note is not measured: the two counts say what it had and what it looked at.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import * as learning from "../dist/learning.js";
import { outcomeOf } from "../dist/usage.js";
import { noteRuns } from "../dist/learning-run.js";
import { openapiDocument } from "../dist/openapi.js";
import { note } from "./learn-format-support.mjs";

const shown = learning.secretsShown([]);
const seedOf = (notes, index) => ({ sha: "a".repeat(40), notes, files: Object.keys(notes), skipped: [], ...(index ? { index } : {}) });

test("given: a run whose notes all fit its budget is given each one whole, and the pin names them", () => {
  const seed = seedOf({ "units.md": note({ name: "Check units" }), "tables.md": note({ name: "Answer in tables" }) });
  assert.deepEqual(learning.givenOf(seed, { budget: 8000, read: true, shown }).map(({ file, name }) => [file, name]).sort(), [["tables.md", "Answer in tables"], ["units.md", "Check units"]]);
});

test("given: past the budget, the notes given whole and those its index names are given; a note in neither is not", () => {
  const big = note({ name: "Big", body: `${"x".repeat(3000)}\n` });
  const seed = seedOf({ "units.md": note({ name: "Check units" }), "big.md": big, "other.md": note({ name: "Other", body: `${"y".repeat(3000)}\n` }) }, "- [Check units](units.md) — units\n- [Big](big.md) — big\n");
  const given = learning.givenOf(seed, { budget: 900, read: true, shown }).map(({ file }) => file).sort();
  assert.deepEqual(given, ["big.md", "units.md"], JSON.stringify(given));
});

test("a run's learning shows given and read, never used: given from its start, read once it settled", () => {
  const record = { state: "seeded", reason: null, detail: null, at: "2026-11-05T00:00:00.000Z", given: [{ file: "units.md", name: "Check units" }], read: [{ file: "units.md", name: "Check units" }] };
  assert.deepEqual(learning.notesView(record, shown, false), { given: [{ file: "units.md", name: "Check units" }] });
  assert.deepEqual(learning.notesView(record, shown, true), { given: [{ file: "units.md", name: "Check units" }], read: [{ file: "units.md", name: "Check units" }] });
});

test("the ledger keeps the files a run was given and read, and the agent's notes count the runs of each", () => {
  const line = outcomeOf("r1", "a", { state: "merged", reason: null, at: "2026-11-05T00:00:00.000Z", given: [{ file: "units.md", name: "U" }, { file: "tables.md", name: "T" }], read: [{ file: "units.md", name: "U" }] });
  assert.deepEqual([line.given, line.read], [["units.md", "tables.md"], ["units.md"]]);
  const counts = noteRuns([{ given: ["units.md", "tables.md"], read: ["units.md"] }, { given: ["units.md"], read: [] }, null]);
  assert.deepEqual(counts.get("units.md"), { given: 2, read: 1 });
  assert.deepEqual(counts.get("tables.md"), { given: 1, read: 0 });
});

test("the contract: a run's learning has given and read (no used); a note's view has its runs' counts", () => {
  const schemas = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.properties && typeof node.properties === "object") schemas.push(node);
    for (const value of Object.values(node)) walk(value);
  };
  walk(openapiDocument(() => undefined));
  const runLearning = schemas.filter((schema) => "learned" in schema.properties && "pending" in schema.properties);
  assert.ok(runLearning.length > 0, "a run's learning schema");
  for (const schema of runLearning) assert.ok("given" in schema.properties && "read" in schema.properties && !("used" in schema.properties), Object.keys(schema.properties).join(","));
  const noteViews = schemas.filter((schema) => "superseded_by" in schema.properties && "origin" in schema.properties);
  assert.ok(noteViews.length > 0, "a note's view schema");
  for (const schema of noteViews) assert.deepEqual(Object.keys(schema.properties.runs?.properties ?? {}).sort(), ["given", "read"]);
});

test("given: an index line a person edited to name two notes, neither of which fits whole, gives the run both", () => {
  const big = (name, fill) => note({ name, body: `${fill.repeat(3000)}\n` });
  const seed = seedOf({ "units.md": big("Check units", "u"), "tables.md": big("Answer in tables", "t") }, "- [Check units](units.md) and [Answer in tables](tables.md) — both\n");
  const given = learning.givenOf(seed, { budget: 900, read: true, shown }).map(({ file }) => file).sort();
  assert.deepEqual(given, ["tables.md", "units.md"], JSON.stringify(given));
});

test("the ledger reads a run's learning whose given or read holds an entry out of shape: the entries with a file count, and nothing throws", () => {
  const line = outcomeOf("r1", "a", { state: "merged", reason: null, at: "2026-11-05T00:00:00.000Z", given: [null, { file: "a.md", name: "a" }, { name: "no file" }, "b.md"], read: [null, { file: "a.md", name: "a" }] });
  assert.deepEqual([line.given, line.read], [["a.md"], ["a.md"]]);
  assert.deepEqual(noteRuns([line]).get("a.md"), { given: 1, read: 1 });
});
