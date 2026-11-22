// What a suggested agent's create writes into someone's repository (suggestions.ts), rendered from fields a model wrote:
// the check refuses what could escape (a path out of the repository or into .github/, a label that could end a string or
// a comment), every other word lands only in a comment or a string it cannot end, the package checks as the server
// checks one, and each client compiles in its language.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { suggestionsFor } from "./fixtures/faux-scout.mjs";

const { checkSuggestion, clientFile, packageFiles, packageProblems, pullText, readScoutAnswer, repoPath } = await import("../dist/suggestions.js");

const HOSTILE = "*/ process.exit(7); /* \"\"\" ; import os; os.system('x') \"\"\" `whoami` @someone";
const base = () => structuredClone(suggestionsFor()[0]);
const checked = (raw) => {
  const s = checkSuggestion(raw);
  assert.notEqual(typeof s, "string", s);
  return s;
};

test("the check keeps paths inside the repository, the client outside .github/ and .agentrun/, and its extension its language's", () => {
  for (const path of ["/etc/passwd", "../up.ts", "a/../../b.ts", "a\\\\b.ts", "a//b.ts", "./ok/../x.ts"]) assert.equal(repoPath(path), undefined, path);
  assert.equal(repoPath("./src/a.ts"), "src/a.ts");
  const at = (integration) => checkSuggestion({ ...base(), integration: { ...base().integration, ...integration } });
  assert.match(at({ path: ".github/workflows/x.ts" }), /under \.github\//);
  assert.match(at({ path: ".agentrun/agents/x/agent.ts" }), /under \.github\/, \.git or \.agentrun\/agents\//);
  assert.match(at({ path: ".git/hooks/pre-commit.ts" }), /\.git/);
  assert.match(at({ path: "src/x.py" }), /does not end in \.ts or \.mts or \.cts for typescript/);
  assert.match(checkSuggestion({ ...base(), evidence: [{ path: "../secret", line: 1, quote: "x" }] }), /evidence/);
  assert.match(checkSuggestion({ ...base(), key: "Not_Kebab" }), /key/);
});

test("an answer's enum value is a label: one that could end a string or a comment is refused", () => {
  const withEnum = (values) => { const s = base(); s.agent.output[0].enum = values; return checkSuggestion(s); };
  assert.equal(typeof withEnum(["billing", "how-to", "account: other", "v1.2+"]), "object");
  for (const bad of ["*/ x /*", "it's", "a\"b", "a\\b", "a/b", "`x`"]) assert.match(withEnum(["ok", bad]), /enum is not 2 to 12 distinct labels/, bad);
});

test("a model's words in every field land only in comments and strings they cannot end: no client runs them", () => {
  const raw = base();
  raw.title = "Triage\n*/ process.exit(7); /* `whoami`";
  raw.summary = `Reads tickets. ${HOSTILE}`;
  raw.agent.name = "Triage */ hack";
  raw.agent.inputs[0].description = HOSTILE;
  raw.agent.output[2].description = HOSTILE;
  raw.integration.call_site.note = `Call it.\n${HOSTILE}`;
  const s = checked(raw);
  assert.ok(!s.title.includes("\n"), "a title is one line");
  const dir = mkdtempSync(join(tmpdir(), "suggestions-render-"));
  try {
    for (const [language, path] of [["typescript", "a.ts"], ["javascript", "a.mjs"], ["javascript", "c.cjs"], ["python", "a.py"]]) {
      const { content } = clientFile({ ...s, integration: { ...s.integration, language, path } }, "acme/app", "a".repeat(40));
      if (language === "python") {
        writeFileSync(join(dir, path), content);
        // The program Python reads, comments gone: nothing of the hostile text is code.
        const code = execFileSync("python3", ["-I", "-c", "import ast,sys; print(ast.dump(ast.parse(open(sys.argv[1]).read())))", join(dir, path)], { encoding: "utf8" });
        assert.ok(!/system|whoami|exit/.test(code), `python runs model words: ${code.slice(0, 200)}`);
        continue;
      }
      const out = ts.transpileModule(content, { compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
      assert.deepEqual(out.diagnostics?.map((d) => d.messageText) ?? [], [], `${path} parses`);
      assert.ok(!/process\.exit|os\.system|whoami/.test(out.outputText), `${path} runs model words:\n${out.outputText}`);
      if (path.endsWith(".mjs") || path.endsWith(".cjs")) { writeFileSync(join(dir, path), content); execFileSync(process.execPath, ["--check", join(dir, path)]); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The package checks, its body's words are text, and the pull request pings no one.
  assert.deepEqual(packageProblems(s), []);
  assert.match(packageFiles(s).get("agent.md").toString(), /^---\nname: ticket-triage\ndisplay_name: "Triage \*\/ hack"\n/);
  const { body } = pullText(s, { repo: "acme/app", commit: "a".repeat(40), agentId: "agent_1" });
  assert.ok(!/@someone/.test(body), "an @mention is defused");
  assert.match(body, /@​someone/);
});

test("a template placeholder in the model's words is text, never a parameter the package would need", () => {
  const raw = base();
  raw.agent.instructions = `${raw.agent.instructions} Write \${parameters.secret} as it is.`;
  const s = checked(raw);
  assert.deepEqual(packageProblems(s), []);
  assert.match(packageFiles(s).get("agent.md").toString(), /Write \$ \{parameters\.secret\} as it is\./);
});

test("the scout's answer: about another repository, or not an object, is no answer; a key twice keeps the first; past five is cut", () => {
  assert.match(readScoutAnswer({ repository: "other/repo", suggestions: [] }, "acme/app").invalid, /about "other\/repo", not acme\/app/);
  assert.match(readScoutAnswer("text", "acme/app").invalid, /not a JSON object/);
  const twice = readScoutAnswer({ repository: "ACME/app", commit: "nope", app: "An app.", suggestions: [base(), base()] }, "acme/app");
  assert.deepEqual([twice.suggestions.length, twice.commit, twice.dropped], [1, "", ["ticket-triage: a second suggestion with that key"]]);
  const many = readScoutAnswer({ repository: "acme/app", app: "x", suggestions: Array.from({ length: 7 }, (_, i) => ({ ...base(), key: `job-${i}x` })) }, "acme/app");
  assert.equal(many.suggestions.length, 5);
});
