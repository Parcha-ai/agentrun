#!/usr/bin/env node
// Builds the validator-sweep corpus: every workflow the repository's own test suites hand
// to the DSL's public validation and run entry points, plus the author skill's examples
// and the conformance cases, each with the TypeScript validator's verdict. Run after
// `npm run build`:
//   node spec/lean/sweep/collect.mjs [out.json]
// `lake exe validator-sweep out.json` then asserts the Lean validator accepts every
// workflow the TypeScript validator accepts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const out = resolve(process.argv[2] ?? join(root, "spec/lean/.lake/validator-corpus.json"));
const { validateWorkflow } = await import(join(root, "packages/dsl/dist/index.js"));
const capture = mkdtempSync(join(tmpdir(), "lean-sweep-"));
const register = join(root, "spec/lean/sweep/capture-register.mjs");

const suites = [
  ["packages/dsl/test", /\.test\.mjs$/],
  ["packages/pi/test", /\.test\.mjs$/],
  ["examples", /\.test\.mjs$/],
];
const problems = [];
for (const [dir, pattern] of suites) {
  const files = readdirSync(join(root, dir)).filter((f) => pattern.test(f)).map((f) => join(dir, f));
  const before = readdirSync(capture).length;
  try {
    execFileSync(process.execPath, ["--test", ...files], {
      cwd: root, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LEAN_SWEEP_DIR: capture, NODE_OPTIONS: `--import=${register}` },
    });
  } catch (error) {
    problems.push(`${dir}: the suite failed under the capture hook (exit ${error.status}); its corpus would be incomplete`);
  }
  const captured = readdirSync(capture).length - before;
  if (captured === 0) problems.push(`${dir}: the suite contributed no workflows; the capture hook is not reaching it`);
  console.log(`${dir}: ${files.length} test files, ${captured} new validations captured`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

const entries = new Map();
const add = (source, workflow, inputKeys) => {
  const text = JSON.stringify({ workflow, inputKeys });
  if (!entries.has(text)) entries.set(text, { source, workflow, inputKeys });
};
for (const file of readdirSync(capture)) {
  const entry = JSON.parse(readFileSync(join(capture, file), "utf8"));
  add(relative(root, entry.source), entry.workflow, entry.inputKeys);
}
rmSync(capture, { recursive: true, force: true });
const skillExamples = "packages/dsl/skills/author/examples";
for (const file of readdirSync(join(root, skillExamples)).filter((f) => f.endsWith(".json") && !f.endsWith(".input.json"))) {
  const workflow = JSON.parse(readFileSync(join(root, skillExamples, file), "utf8"));
  add(`${skillExamples}/${file}`, workflow, null);
  const inputFile = join(root, skillExamples, file.replace(/\.json$/, ".input.json"));
  if (existsSync(inputFile)) add(`${skillExamples}/${file}`, workflow, Object.keys(JSON.parse(readFileSync(inputFile, "utf8"))));
}
const cases = "spec/lean/conformance";
for (const file of readdirSync(join(root, cases)).filter((f) => f.endsWith(".json"))) {
  const c = JSON.parse(readFileSync(join(root, cases, file), "utf8"));
  add(`${cases}/${file}`, c.workflow, null);
  add(`${cases}/${file}`, c.workflow, Object.keys(c.input ?? {}));
}

const corpus = [...entries.values()].map((entry) => {
  let accepted = false;
  try {
    accepted = validateWorkflow(entry.workflow, entry.inputKeys ? { inputKeys: entry.inputKeys } : undefined).ok;
  } catch { /* A document the validator cannot even read is a rejection. */ }
  return { ...entry, tsAccepts: accepted };
});
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(corpus));
const accepted = corpus.filter((e) => e.tsAccepts).length;
console.log(`${corpus.length} validations collected (${accepted} accepted by the TypeScript validator) -> ${relative(root, out)}`);
