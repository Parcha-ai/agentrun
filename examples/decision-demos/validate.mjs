// Checks every demo workflow with the DSL's validator and a dry run on each of its inputs (no model, tool or provider
// call). Usage: node examples/decision-demos/validate.mjs [--strip-images]
// --strip-images drops the C1 `images` field first, for a DSL build that does not know it yet.
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const dsl = await import(new URL("../../packages/dsl/dist/index.js", import.meta.url).href);
const strip = process.argv.includes("--strip-images");
const cases = JSON.parse(readFileSync(`${here}use-cases.json`, "utf8"));

const stripImages = (node) => {
  if (Array.isArray(node)) return node.map(stripImages);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([k]) => k !== "images").map(([k, v]) => [k, stripImages(v)]));
};

let failed = 0;
for (const [useCase, { workflow: name, inputs }] of Object.entries(cases)) {
  let workflow = JSON.parse(readFileSync(`${here}workflows/${name}.json`, "utf8"));
  if (strip) workflow = { ...workflow, root: stripImages(workflow.root) };
  const valid = dsl.validateWorkflow(workflow);
  if (!valid.ok) {
    failed++;
    console.log(`FAIL ${useCase}: validate`);
    for (const issue of valid.issues) console.log(`  ${issue.code} ${issue.path}: ${issue.message}`);
    continue;
  }
  console.log(`ok   ${useCase}: validate${valid.warnings?.length ? ` (warnings: ${valid.warnings.join(" | ")})` : ""}`);
  for (const inputName of inputs) {
    const input = JSON.parse(readFileSync(`${here}inputs/${inputName}.json`, "utf8"));
    const dry = await dsl.dryRunWorkflow(workflow, { input });
    const line = `${dry.status.padEnd(7)} ${useCase} dry run on ${inputName}`;
    if (dry.status === "failed") { failed++; console.log(`FAIL ${line}\n  ${dry.problems.join("\n  ")}`); }
    else console.log(`ok   ${line}${dry.skipped?.length ? `\n  skipped: ${dry.skipped.join("\n  skipped: ")}` : ""}`);
  }
}
process.exit(failed ? 1 : 0);
