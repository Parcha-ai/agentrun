// A fake MCP server's calls reach an llm grader and the eval's report as the run's timeline shows them, under the run's
// cut: a value the run's cut holds, handed by the agent to a fake tool, reaches neither. The fake's own log, each call's
// arguments whole, is read only to match a tool_used grader's args, never shown. Each answer of a fake carries its own
// stamp (`fake-call <nonce>`, first in its text), which the fake logs: a timeline call is paired with the logged call
// whose stamp its result starts with, never by its arguments, and no stamp reaches a grader or the report. The package's
// agent and its grader are played by fixtures/faux-template-eval.mjs.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callsOf, evalTemplate, graderInput, mcpCallsOf } from "../dist/template-eval.js";
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

/** A fake's stamp, as it heads each of its answers. */
const STAMP = /fake-call [0-9a-f]{32}/;
const nonce = (digit) => digit.repeat(32);
const stamp = (digit) => `fake-call ${nonce(digit)}`;

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
  // The agent's answer echoes the fake's whole result, its stamp too: the answer as graded and reported holds none.
  assert.match(run.answer ?? "", /^The CRM said: updated 7/, run.answer);

  // The grader's input: the fake's call under the run's cut, the held value nowhere, no stamp anywhere.
  const input = graderInputs().find((one) => one.includes("\"summary\": \"mcp-held\""));
  assert.ok(input, "the grader's input was logged");
  assert.ok(!input.includes(HELD), "the grader's input holds no held value");
  assert.doesNotMatch(input, STAMP, "no fake's stamp reaches a grader: not in the answer, a call's result nor the mcp calls");
  const mcp = input.slice(input.indexOf("<mcp-calls untrusted>"));
  assert.ok(input.includes("<mcp-calls untrusted>"), input);
  assert.match(mcp, /mcp:crm\/update_contact/);
  assert.match(mcp, /\[redacted\]/, "the note as the timeline cuts it");

  // The report's mcp_calls: the same call (its stamp reached the timeline, so it paired), the held value nowhere.
  assert.deepEqual((run.mcp_calls ?? []).map((call) => call.tool), ["mcp:crm/update_contact"]);
  assert.ok(!JSON.stringify(run.mcp_calls).includes(HELD), JSON.stringify(run.mcp_calls));
  assert.ok(!JSON.stringify(report).includes(HELD), "nothing in the report holds the held value");
  assert.doesNotMatch(JSON.stringify(report), STAMP, "nothing in the report holds a fake's stamp");

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
    { tool: "mcp:crm/get_contact", arguments: { id: "7" }, status: "success", result: `${stamp("1")}\nAda` },
    { tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "failed", refused: true, result: "Refused: denied" },
    { tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "success", result: `${stamp("2")}\nupdated 7` },
    { tool: "mcp:mail/send", arguments: {}, status: "success", result: `${stamp("3")}\nsent` },
    { tool: "bash", arguments: { command: "ls" }, status: "success", result: "a" },
  ];
  const received = [
    { tool: "mcp:crm/get_contact", arguments: { id: "7" }, nonce: nonce("1") },
    { tool: "mcp:crm/update_contact", arguments: { id: "7" }, nonce: nonce("2") },
    { tool: "mcp:mail/send", arguments: {}, nonce: nonce("3") },
  ];
  assert.deepEqual(mcpCallsOf(calls, ["crm"], received).map((call) => `${call.tool} ${call.status} ${call.result}`), ["mcp:crm/get_contact success Ada", "mcp:crm/update_contact success updated 7"], "a refused call never reached the fake; another server's and a built-in's are not a fake's; a shown result holds no stamp");
  assert.deepEqual(mcpCallsOf(calls, [], received), []);
});

test("mcpCallsOf pairs a timeline call only with the logged call whose stamp heads its result: which call shows, whatever its arguments look like", () => {
  const which = (calls, received) => mcpCallsOf(calls, ["crm"], received).map((call) => call.id);
  // Failed then succeeded, the same arguments: the first never reached the fake (no stamp), the second did.
  assert.deepEqual(which([
    { id: "failed", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "failed", result: "connect ECONNREFUSED" },
    { id: "ran", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "success", result: `${stamp("a")}\nupdated 7` },
  ], [{ tool: "mcp:crm/update_contact", arguments: { id: "7" }, nonce: nonce("a") }]), ["ran"], "the call that ran shows, never its failed twin");
  // An argument the timeline cut at 2,000 characters.
  assert.deepEqual(which([
    { id: "cut", tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { note: `${"x".repeat(2000)}...` } }, status: "success", result: `${stamp("b")}\nupdated 7` },
  ], [{ tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { note: "x".repeat(5000) } }, nonce: nonce("b") }]), ["cut"]);
  // A held number, shown as the string "[redacted]".
  assert.deepEqual(which([
    { id: "held", tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { pin: "[redacted]" } }, status: "success", result: `${stamp("c")}\nupdated 7` },
  ], [{ tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { pin: 482915 } }, nonce: nonce("c") }]), ["held"]);
  // Its keys in another order.
  assert.deepEqual(which([
    { id: "reordered", tool: "mcp:crm/update_contact", arguments: { fields: { b: 1, a: 2 }, id: "7" }, status: "success", result: `${stamp("d")}\nupdated 7` },
  ], [{ tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { a: 2, b: 1 } }, nonce: nonce("d") }]), ["reordered"]);
  // An agent-typed "[redacted]": a decoy that never reached the fake is no wildcard.
  assert.deepEqual(which([
    { id: "decoy", tool: "mcp:crm/update_contact", arguments: { id: "[redacted]" }, status: "failed", result: "the server could not be reached" },
    { id: "real", tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { note: "hi" } }, status: "success", result: `${stamp("e")}\nupdated 7` },
  ], [{ tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { note: "hi" } }, nonce: nonce("e") }]), ["real"]);
  // A stamp the agent copied into its arguments pairs nothing: the stamp is read from the result, which the fake wrote.
  assert.deepEqual(which([
    { id: "copied", tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { note: stamp("f") } }, status: "failed", result: "the server could not be reached" },
    { id: "own", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "success", result: `${stamp("f")}\nupdated 7` },
  ], [{ tool: "mcp:crm/update_contact", arguments: { id: "7" }, nonce: nonce("f") }]), ["own"]);
  // A call the fake logged under another tool is not this one's, and a logged call pairs once.
  assert.deepEqual(which([
    { id: "other-tool", tool: "mcp:crm/get_contact", arguments: { id: "7" }, status: "success", result: `${stamp("1")}\nAda` },
    { id: "first", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "success", result: `${stamp("2")}\nupdated 7` },
    { id: "again", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "success", result: `${stamp("2")}\nupdated 7` },
  ], [{ tool: "mcp:crm/update_contact", arguments: { id: "7" }, nonce: nonce("1") }, { tool: "mcp:crm/update_contact", arguments: { id: "7" }, nonce: nonce("2") }]), ["first"]);
  assert.deepEqual(which([{ id: "x", tool: "mcp:crm/get_contact", arguments: { id: "9" }, status: "success", result: `${stamp("9")}\nno such contact` }], []), [], "nothing reached the fakes");
});

test("an llm grader's input holds no fake's stamp: not in an answer that echoes one, a file, a call's result or its arguments", () => {
  const input = graderInput({ type: "llm", file: "g.md", rubric: "Pass if updated." }, "Update contact 7.", {
    answer: `Done: ${stamp("7")}\nupdated 7`,
    calls: [{ tool: "mcp:crm/update_contact", arguments: { id: "7", note: stamp("8") }, status: "success", result: `${stamp("7")}\nupdated 7` }],
    mcpCalls: [{ tool: "mcp:crm/update_contact", arguments: { id: "7", note: stamp("8") }, status: "success" }],
    fakeLog: [],
    files: ["notes.md"],
    finalFiles: [{ name: "notes.md", bytes: 60, text: `The CRM said ${stamp("7")}` }],
  });
  assert.doesNotMatch(input, STAMP, input);
  assert.match(input, /Done: updated 7/, "the answer stays, less its stamp");
  assert.match(input, /The CRM said /);
});
