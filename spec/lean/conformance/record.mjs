#!/usr/bin/env node
// Records `expected` (and the scripted code-node returns) for conformance cases from the
// TypeScript interpreter. Run after `npm run build`:
//   node spec/lean/conformance/record.mjs <case.json>...
// Review the diff: a recorded change is a behavior change, and `lake exe conformance` must
// then agree with it before the case can land.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCase } from "../../../packages/dsl/test/lean-conformance-harness.mjs";

for (const file of process.argv.slice(2)) {
  const path = resolve(file);
  const c = JSON.parse(readFileSync(path, "utf8"));
  const { expected, codeReturns } = await runCase(c);
  if (Object.keys(codeReturns).length) c.script = { ...(c.script ?? {}), code: codeReturns };
  c.expected = expected;
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
  console.log(`${file}: ${expected.valid === false ? "invalid" : expected.outcome}`);
}
