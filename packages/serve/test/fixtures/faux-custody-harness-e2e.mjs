// The faux harness's script for the custody end-to-end test on a CLI harness (custody-runner-e2e.test.mjs): the same run as
// fixtures/faux-custody-e2e.mjs gives pi. One action per paid request: the monid tool (whose vendor quotes the key it was
// sent back in its error), the signed-in MCP server's `add`, a note written into the run's folder, and an answer. It files
// this process's environment, as the run's harness holds it, for the test to read.
import { readFileSync, writeFileSync } from "node:fs";

export function script() {
  if (process.env.CUSTODY_E2E_ENV_REPORT) {
    let environ = "";
    try { environ = readFileSync("/proc/self/environ", "latin1"); } catch {}
    writeFileSync(process.env.CUSTODY_E2E_ENV_REPORT, JSON.stringify({ env: process.env, environ }));
  }
  return [
    { call: "monid__faux__person__enrich", args: { body: { name: "Ada" } }, usd: 0.001 },
    { call: "mcp__docs__add", args: { a: 2, b: 3 }, usd: 0.001 },
    { call: "write", args: { path: "notes.txt", content: "What I saw: the tools answered." }, usd: 0.001 },
    { say: "Saw the tools' answers.", usd: 0.001 },
  ];
}
