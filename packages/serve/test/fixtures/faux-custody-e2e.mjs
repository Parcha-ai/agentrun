// pi's faux model for the custody end-to-end test (custody-runner-e2e.test.mjs): told to use the keys, it calls the monid
// tool (whose vendor echoes the key it was sent back in its error), then the signed-in MCP server's `add`, writes what it
// saw into a file of the run's folder, and answers with what it saw. It also files this process's environment (names and
// values), as the run's own process holds it, for the test to read: the run's keys are read from the store at its claim and
// put on that run's tool environment alone, never on this process's.
import { readFileSync, writeFileSync } from "node:fs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (process.env.CUSTODY_E2E_ENV_REPORT) {
    let environ = "";
    try { environ = readFileSync("/proc/self/environ", "latin1"); } catch {}
    writeFileSync(process.env.CUSTODY_E2E_ENV_REPORT, JSON.stringify({ env: process.env, environ }));
  }
  if (results.length === 0) return faux.message(faux.toolCall("monid__faux__person__enrich", { body: { name: "Ada" } }), { stopReason: "toolUse" });
  if (results.length === 1) return faux.message(faux.toolCall("mcp__docs__add", { a: 2, b: 3 }), { stopReason: "toolUse" });
  const saw = results.map(textOf).join(" | ");
  if (results.length === 2) return faux.message(faux.toolCall("write", { path: "notes.txt", content: `What I saw: ${saw}` }), { stopReason: "toolUse" });
  return faux.message(`Saw: ${saw}`);
}
