// The server's learning code as one surface (src/learn/index.ts): every name the rest of the server imports, each the
// same binding as in its own module.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as check from "../dist/learn/check.js";
import * as corrections from "../dist/learn/corrections.js";
import * as learn from "../dist/learn/index.js";
import * as invisible from "../dist/learn/invisible.js";
import * as secrets from "../dist/learn/secrets.js";
import * as workflowDraft from "../dist/learn/workflow-draft.js";

const VALUES = {
  check: ["CAPS", "checkDraft", "printable", "unstorable"],
  corrections: ["CORRECTIONS_CAP", "CORRECTIONS_FILE", "correctionLine", "correctionsProblems", "problemWords"],
  invisible: ["hiddenCharacter"],
  secrets: ["learnedSecretShapes", "MIN_SECRET", "PRINT_MAX", "redactLearned", "redactSecrets", "secretShapes", "valueMatcher"],
  workflowDraft: ["decodedStrings", "draftDryRun", "draftFiles", "draftProblems", "DRY_RUN_FAILED", "frontKeys", "frontMatter", "held", "isHeld", "LEARNED_KEYS", "LEARNED_MAX_TURNS", "learnedFront", "learnedPlace", "learnedStatus", "NO_TOOL_LIST", "readmeOf", "released", "restorable", "restoredLearned", "retiredFrom", "retiredLearned", "setsStatus", "statusOnOneLine", "UNCLEAR_FRONT", "unclearFront", "WORKFLOW_NAME", "WORKFLOWS_DIR"],
};
const MODULES = { check, corrections, invisible, secrets, workflowDraft };
const TYPES = ["Change", "DraftCheckInput", "DraftDryRun", "DraftProblem", "DraftReader", "LearnedPlace", "Problem", "Rule"];

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
