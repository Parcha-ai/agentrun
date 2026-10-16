import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS, LearnError, learningId, parseLearning, renderLearning } from "../dist/index.js";
import { learning } from "./support.mjs";

const SHA = "a".repeat(40);
const ENTRY = learning("L-0123456789ab", "Registries match the legal name without the suffix; search both forms.", {
  type: "fact", scope: "kyb", provenance: { runs: ["run-1", "run-7"], sha: SHA, untrusted: true }, uses: 4, supersedes: ["L-ba9876543210"],
});

test("a learning renders to one fixed file and parses back to the same learning", () => {
  const file = renderLearning(ENTRY);
  assert.equal(file, [
    "---", "id: L-0123456789ab", "type: fact", "scope: kyb", "status: active", "provenance:", '  runs: ["run-1","run-7"]', `  sha: ${SHA}`, "  untrusted: true",
    "uses: 4", 'supersedes: ["L-ba9876543210"]', "---", ENTRY.text, "",
  ].join("\n"));
  assert.equal(renderLearning(ENTRY), file, "byte-stable");
  assert.deepEqual(parseLearning(file), ENTRY);
  const multi = { ...ENTRY, text: "First line.\n\nMore detail.\n\n" };
  assert.equal(parseLearning(renderLearning(multi)).text, "First line.\n\nMore detail.");
});

test("the id is L- and 12 hex of SHA-256 over the run id and the text: the same pair always gives the same id", () => {
  const id = learningId("run-1", ENTRY.text);
  assert.match(id, /^L-[0-9a-f]{12}$/);
  assert.equal(learningId("run-1", ENTRY.text), id);
  assert.notEqual(learningId("run-2", ENTRY.text), id);
  assert.notEqual(learningId("run-1", `${ENTRY.text} `), id);
  assert.throws(() => learningId("../run", "x"), { code: "invalid" });
  assert.throws(() => learningId("run-1", "  "), { code: "invalid" });
});

test("parse refuses anything renderLearning would not write", () => {
  const file = renderLearning(ENTRY);
  const cases = {
    "no frontmatter": ENTRY.text,
    "unclosed": file.replace("\n---\n", "\n--\n"),
    "unknown key": file.replace("uses: 4", "uses: 4\nowner: me"),
    "repeated key": file.replace("uses: 4", "uses: 4\nuses: 5"),
    "missing key": file.replace("scope: kyb\n", ""),
    "missing provenance key": file.replace("  untrusted: true\n", ""),
    "bad id": file.replace("id: L-0123456789ab", "id: L-XYZ"),
    "bad type": file.replace("type: fact", "type: used"),
    "bad status": file.replace("status: active", "status: live"),
    "bad scope": file.replace("scope: kyb", "scope: Some Scope"),
    "bad runs": file.replace('["run-1","run-7"]', '["../x"]'),
    "empty runs": file.replace('["run-1","run-7"]', "[]"),
    "runs not a list": file.replace('["run-1","run-7"]', "run-1"),
    "bad sha": file.replace(SHA, "main"),
    "bad untrusted": file.replace("untrusted: true", "untrusted: yes"),
    "negative uses": file.replace("uses: 4", "uses: -1"),
    "self supersede": file.replace("L-ba9876543210", "L-0123456789ab"),
    "empty body": file.slice(0, file.lastIndexOf("---\n") + 4),
    "carriage return": file.replace(ENTRY.text, "a\r\nb"),
    "too large": file + "x".repeat(CAPS.learning),
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.throws(() => parseLearning(text), (e) => e instanceof LearnError && (e.code === "format" || e.code === "too_large"), name);
  }
  assert.throws(() => renderLearning({ ...ENTRY, text: "x".repeat(CAPS.learning) }), { code: "too_large" });
  assert.throws(() => renderLearning({ ...ENTRY, type: "used" }), { code: "format" });
});
