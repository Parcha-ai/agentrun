// A shipped template with learning on that has a decision field declares it: its front matter's `learning` is an object
// whose agree_on names the dotted paths of the decision in its output schema (kyb: verdict.decision; inbound-lead:
// next_step.action). One whose answer is generated text (market-monitor's digest, release-notes' notes) has none and
// stays `learning: true`: it compares the whole answer. readPackage refuses an agree_on path the output schema does not
// declare as required at every level, so a template's check never compares on a field its answer may leave out.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

const { folderFiles, packageView, readPackage, readPackages, TEMPLATES_DIR } = await import("../dist/templates.js");

/** Where `path` leads in `schema`, each segment a required property of an object schema, or why it does not. */
function declared(schema, path) {
  let node = schema;
  for (const segment of path.split(".")) {
    if (node?.type !== "object" || !node.properties || !Object.hasOwn(node.properties, segment)) return `${segment} is no property`;
    if (!(node.required ?? []).includes(segment)) return `${segment} is not required`;
    node = node.properties[segment];
  }
  return node;
}

test("the shipped templates with learning on: kyb and inbound-lead declare their decision's path, the generated-text ones compare the whole answer", () => {
  const byName = Object.fromEntries(readPackages().map((p) => [p.name, p]));
  assert.deepEqual(byName.kyb.learning, { agree_on: ["verdict.decision"] });
  assert.deepEqual(byName["inbound-lead"].learning, { agree_on: ["next_step.action"] });
  assert.equal(byName["market-monitor"].learning, true, "a digest is generated text: no decision field");
  assert.equal(byName["release-notes"].learning, true, "release notes are generated text: no decision field");
  assert.deepEqual(packageView(byName.kyb).learning, { agree_on: ["verdict.decision"] }, "GET /v2/templates lists it");
});

test("every shipped template's agree_on path is declared in its output schema, required at every level, and its leaf is a closed choice", () => {
  const learning = readPackages().filter((p) => p.learning !== undefined && p.learning !== false);
  assert.ok(learning.length >= 4, learning.map((p) => p.name).join(", "));
  for (const p of learning) {
    for (const path of p.learning.agree_on ?? []) {
      assert.ok(p.outputSchema, `${p.name} declares agree_on with no output schema`);
      const leaf = declared(p.outputSchema, path);
      assert.equal(typeof leaf, "object", `${p.name}: ${path}: ${leaf}`);
      assert.ok(Array.isArray(leaf.enum), `${p.name}: ${path} is an enum (a decision, not free text)`);
    }
  }
});

/** The kyb package with its manifest's `learning` line replaced by `line`. */
const kybWith = (line) => {
  const files = folderFiles(join(TEMPLATES_DIR, "kyb"));
  return { ...files, text: (path) => (path === "agent.md" ? files.text(path).replace(/^learning: .*$/m, line) : files.text(path)) };
};
const problemsOf = (line) => {
  try {
    readPackage(kybWith(line), { evalFixtures: false });
    return [];
  } catch (error) {
    return error.problems ?? [String(error)];
  }
};

test("a manifest's learning object is checked as a definition's, and each agree_on path must be a required field of the output schema", () => {
  assert.deepEqual(problemsOf('learning: { agree_on: ["verdict.decision"], compile_after: 10 }'), []);
  assert.deepEqual(problemsOf('learning: { agree_on: ["verdict..decision"] }'), ["agent.md: learning.agree_on[0] is not a dotted path into the answer's JSON object (e.g. verdict.decision): an empty segment"]);
  assert.deepEqual(problemsOf('learning: { agree_on: ["verdict.outcome"] }'), ["agent.md: learning.agree_on[0] is verdict.outcome, which kyb.schema.json does not declare: outcome is no property of verdict"]);
  assert.deepEqual(problemsOf('learning: { agree_on: ["verdict.conditions"] }'), ["agent.md: learning.agree_on[0] is verdict.conditions, which kyb.schema.json does not require: an answer may leave conditions out of verdict, and a path missing on both sides never agrees"]);
  // No output schema: nothing to check the paths against and nothing makes an answer hold them, so refused (#3182 r2 P2).
  const noOutput = (line) => {
    const files = kybWith(line);
    try {
      readPackage({ ...files, text: (path) => (path === "agent.md" ? files.text(path).replace(/^output: .*\n/m, "") : files.text(path)) }, { evalFixtures: false });
      return [];
    } catch (error) {
      return error.problems ?? [String(error)];
    }
  };
  assert.deepEqual(noOutput('learning: { agree_on: ["verdict.decision"] }'), ["agent.md: learning.agree_on names fields of the answer, so the package declares the answer's schema (output: {schema}) that holds them"]);
  assert.deepEqual(noOutput("learning: true"), [], "learning with no agree_on needs no output schema");
  // A parent the schema lets be null (or any non-object) is refused: {"verdict": null} is a valid answer, and a path
  // through it never resolves, even on two identical answers (#3182 review, PRRT_kwDOUmdVMs64_0mW).
  const nullableVerdict = (line) => {
    const files = kybWith(line);
    try {
      readPackage({ ...files, text: (path) => (path === "kyb.schema.json" ? files.text(path).replace(/("verdict": \{\s*"type": )"object"/, '$1["object", "null"]') : files.text(path)) }, { evalFixtures: false });
      return [];
    } catch (error) {
      return error.problems ?? [String(error)];
    }
  };
  assert.deepEqual(nullableVerdict('learning: { agree_on: ["verdict.decision"] }'), ["agent.md: learning.agree_on[0] is verdict.decision, which kyb.schema.json does not make verdict an object only: an answer may give it as null or another type, and a path through it never resolves"]);
  assert.deepEqual(problemsOf("learning: on"), ["agent.md: learning is true, false or an object of the loop's numbers ({compile_after?, agree_min?, alone_min?, agree_on?, audit_every?, audit_every_later?, audit_later_after?, hold_window?, hold_disagree?, stop_window?}, on with those set)"]);
});
