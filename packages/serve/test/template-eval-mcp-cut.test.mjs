// A fake MCP server's calls reach an llm grader and the eval's report as the run's timeline shows them, under the run's
// cut: a value the run's cut holds, handed by the agent to a fake tool, reaches neither. The fake's own log, each call's
// arguments whole, is read only to match a tool_used grader's args, never shown. The package's agent and its grader are
// played by fixtures/faux-template-eval.mjs.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callsOf, evalTemplate, mcpCallsOf } from "../dist/template-eval.js";
import { scratch } from "./support.mjs";

const PKG = new URL("./fixtures/templates-eval/evalpkg", import.meta.url).pathname;
const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");
const graderInputs = () => readFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));

// A held value, made at runtime (no credential-shaped literal for the source export), in this process's environment
// under a key's name: the eval's own server holds it (hostSecrets), so it is in the run's cut.
const HELD = ["not", "a", "real", "key", "mcp", "4f1c9e2b7a6d"].join("-");
process.env.AGENTRUN_TEST_MCP_CUT_API_KEY = HELD;

test("a held value the agent hands a fake MCP tool reaches neither the grader's input nor the report's mcp_calls; a tool_used grader still matches the call", { timeout: 300_000 }, async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const at = join(dir, "evals", "mcp-held");
  mkdirSync(join(at, "graders"), { recursive: true });
  mkdirSync(join(at, "fixtures"), { recursive: true });
  cpSync(join(PKG, "evals", "mcp-match", "fixtures", "crm.json"), join(at, "fixtures", "crm.json"));
  writeFileSync(join(at, "case.yaml"), "parameters:\n  team: blue\nmcp:\n  crm: fixtures/crm.json\ngrants: [mcp:crm/get_contact, mcp:crm/update_contact]\n");
  writeFileSync(join(at, "prompt.md"), '---\ndescription: MCP-CUT-CASE updates contact 7 with a note that holds a key.\n---\nCall mcp__crm__update_contact with {"id": "7", "fields": {"note": "{{env:AGENTRUN_TEST_MCP_CUT_API_KEY}}"}}\nAnswer:\nThe CRM said: {{last-result}}\n\n```json\n{"verdict": "good", "score": 50, "summary": "mcp-held"}\n```\n');
  writeFileSync(join(at, "graders", "judged.md"), '---\ntype: llm\n---\nPass if the CRM said "updated 7".\n');
  writeFileSync(join(at, "graders", "updated.md"), '---\ntype: tool_used\ntool: mcp:crm/update_contact\ncount: 1\nargs: { id: "7" }\n---\n');
  const report = await evalTemplate({ dir, cases: ["mcp-held"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  assert.match(run.answer ?? "", /^The CRM said: updated 7/, run.answer);

  // The grader's input: the fake's call under the run's cut, the held value nowhere.
  const input = graderInputs().find((one) => one.includes("\"summary\": \"mcp-held\""));
  assert.ok(input, "the grader's input was logged");
  assert.ok(!input.includes(HELD), "the grader's input holds no held value");
  const mcp = input.slice(input.indexOf("<mcp-calls untrusted>"));
  assert.ok(input.includes("<mcp-calls untrusted>"), input);
  assert.match(mcp, /mcp:crm\/update_contact/);
  assert.match(mcp, /\[redacted\]/, "the note as the timeline cuts it");

  // The report's mcp_calls: the same call, the held value nowhere.
  assert.deepEqual((run.mcp_calls ?? []).map((call) => call.tool), ["mcp:crm/update_contact"]);
  assert.ok(!JSON.stringify(run.mcp_calls).includes(HELD), JSON.stringify(run.mcp_calls));
  assert.ok(!JSON.stringify(report).includes(HELD), "nothing in the report holds the held value");

  // A tool_used grader matches on the fake's own log, which nothing shows.
  const updated = run.graders.find((g) => g.grader === "updated.md");
  assert.equal(updated.pass, true, JSON.stringify(updated));
});

test("mcpCallsOf shows a faked server's calls from the timeline, less any the run refused (the one that ran shows, not its refused twin); callsOf keeps a refused row's mark", async () => {
  const rows = [
    { kind: "tool_use", tool_name: "bash", tool_use_id: "a", tool_input: { command: "ls" } },
    { kind: "tool_result", tool_use_id: "a", tool_status: "failed", refused: true, tool_result_text: "Refused: denied" },
    { kind: "tool_use", tool_name: "bash", tool_use_id: "b", tool_input: { command: "pwd" } },
    { kind: "tool_result", tool_use_id: "b", tool_status: "success", tool_result_text: "/work" },
  ];
  const [refused, ran] = callsOf(rows, "pi");
  assert.equal(refused.refused, true, JSON.stringify(refused));
  assert.equal("refused" in ran, false, JSON.stringify(ran));
  const calls = [
    { tool: "mcp:crm/get_contact", arguments: { id: "7" }, status: "success" },
    { tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "failed", refused: true },
    { tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "success" },
    { tool: "mcp:mail/send", arguments: {}, status: "success" },
    { tool: "bash", arguments: { command: "ls" }, status: "success" },
  ];
  const received = [{ tool: "mcp:crm/get_contact", arguments: { id: "7" } }, { tool: "mcp:crm/update_contact", arguments: { id: "7" } }, { tool: "mcp:mail/send", arguments: {} }];
  assert.deepEqual(mcpCallsOf(calls, ["crm"], received).map((call) => `${call.tool} ${call.status}`), ["mcp:crm/get_contact success", "mcp:crm/update_contact success"], "a refused call never reached the fake; another server's and a built-in's are not a fake's");
  assert.deepEqual(mcpCallsOf(calls, [], received), []);
});

test("mcpCallsOf leaves out a call that never reached the fake: a shown call pairs with one in the fake's log whose arguments its cut copy fits, then any left pair in order", () => {
  const calls = [
    // Never reached the fake (it couldn't be reached): the timeline has it, the fake's log doesn't.
    { tool: "mcp:crm/update_contact", arguments: { note: "[redacted]", id: "2" }, status: "failed" },
    { tool: "mcp:crm/update_contact", arguments: { note: "[redacted]", id: "23" }, status: "success" },
    // Logged by the fake as it came, not as the timeline shows it: paired in order all the same.
    { tool: "mcp:crm/get_contact", arguments: { id: 9 }, status: "success" },
  ];
  const received = [
    { tool: "mcp:crm/update_contact", arguments: { note: "a value the run held", id: "23" } },
    { tool: "mcp:crm/get_contact", arguments: { id: "9" } },
  ];
  assert.deepEqual(mcpCallsOf(calls, ["crm"], received).map((call) => `${call.tool} ${JSON.stringify(call.arguments)}`), ['mcp:crm/update_contact {"note":"[redacted]","id":"23"}', 'mcp:crm/get_contact {"id":9}']);
  assert.deepEqual(mcpCallsOf(calls, ["crm"], []), [], "nothing reached the fakes");
  // As many shown as reached each tool: two alike, one logged.
  const twice = [{ tool: "mcp:crm/get_contact", arguments: { id: "9" }, status: "failed" }, { tool: "mcp:crm/get_contact", arguments: { id: "9" }, status: "success" }];
  assert.equal(mcpCallsOf(twice, ["crm"], [{ tool: "mcp:crm/get_contact", arguments: { id: "9" } }]).length, 1);
});
