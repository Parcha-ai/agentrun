// A fake MCP server's calls reach an llm grader and the eval's report as the run's timeline shows them, under the run's
// cut: a value the run's cut holds, handed by the agent to a fake tool, reaches neither. The fake's own log, each call's
// arguments whole, is read only to match a tool_used grader's args, never shown. The calls shown are the timeline's calls
// on a faked server's tools that ran: not refused before they ran, and with a result. A fake answers as its fixture is
// written, so the agent and a script it runs read what a real server of that shape answers. The package's agent and its
// grader are played by fixtures/faux-template-eval.mjs.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callsOf, evalTemplate, mcpCallsOf, startFake } from "../dist/template-eval.js";
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

test("mcpCallsOf leaves out a call the run refused before it ran, though it has a result: the one that ran shows, not its refused twin; callsOf keeps a refused row's mark", () => {
  const rows = [
    { kind: "tool_use", tool_name: "bash", tool_use_id: "a", tool_input: { command: "ls" } },
    { kind: "tool_result", tool_use_id: "a", tool_status: "failed", refused: true, tool_result_text: "Refused: denied" },
    { kind: "tool_use", tool_name: "bash", tool_use_id: "b", tool_input: { command: "pwd" } },
    { kind: "tool_result", tool_use_id: "b", tool_status: "success", tool_result_text: "/work" },
  ];
  const [refused, ran] = callsOf(rows, "pi");
  assert.equal(refused.refused, true, JSON.stringify(refused));
  assert.equal("refused" in ran, false, JSON.stringify(ran));
  // The refused twin has a result row and a status, as a refused call's row does: only its mark leaves it out.
  const calls = [
    { id: "refused", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "failed", refused: true, result: "Refused: denied" },
    { id: "ran", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "success", result: "updated 7" },
  ];
  assert.deepEqual(mcpCallsOf(calls, ["crm"]).map((call) => call.id), ["ran"]);
  assert.deepEqual(mcpCallsOf(calls, []), [], "no server faked, no fake's calls");
});

test("mcpCallsOf shows each call on a faked server's tools that ran, as the timeline shows it, in order: not one with no result, not another server's or a built-in's; one that failed on its way shows with its error", () => {
  const calls = [
    { id: "got", tool: "mcp:crm/get_contact", arguments: { id: "7" }, status: "success", result: "Ada" },
    { id: "cut-off", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: null, result: null },
    { id: "unreached", tool: "mcp:crm/update_contact", arguments: { id: "7" }, status: "failed", result: "connect ECONNREFUSED" },
    { id: "held", tool: "mcp:crm/update_contact", arguments: { id: "7", fields: { pin: "[redacted]", note: `${"x".repeat(1997)}...` } }, status: "success", result: "updated 7" },
    { id: "mail", tool: "mcp:mail/send", arguments: {}, status: "success", result: "sent" },
    { id: "bash", tool: "bash", arguments: { command: "ls" }, status: "success", result: "a" },
  ];
  const shown = mcpCallsOf(calls, ["crm"]);
  assert.deepEqual(shown.map((call) => `${call.id} ${call.status}`), ["got success", "unreached failed", "held success"], "a call cut off has no outcome; a failed one is never shown as a success");
  assert.deepEqual(shown[2], calls[3], "its arguments as the timeline shows them, never compared with or replaced by the fake's log");
});

test("a fake answers as its fixture is written: a JSON text answer parses as the fixture's value, as a script reads it, and an answer of structured content alone comes with no text added", async () => {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const contact = { id: "7", name: "Ada", tags: ["vip"] };
  const input = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
  const fixture = { server: "crm", description: "Contacts.", tools: {
    get_contact: { description: "A contact.", input, answers: [{ when: { id: "7" }, result: { content: [{ type: "text", text: JSON.stringify(contact) }] } }] },
    contact_record: { description: "A contact's record.", input, answers: [{ when: { id: "7" }, result: { structuredContent: contact } }] },
  } };
  const fake = await startFake("crm", fixture);
  const client = new Client({ name: "eval-test", version: "1.0.0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  let texted, structured;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(fake.url)));
    texted = await client.callTool({ name: "get_contact", arguments: { id: "7" } });
    structured = await client.callTool({ name: "contact_record", arguments: { id: "7" } });
  } finally {
    await client.close().catch(() => undefined);
    await fake.close();
  }
  assert.deepEqual(texted.content, fixture.tools.get_contact.answers[0].result.content, "the fixture's answer, nothing added");
  assert.deepEqual(JSON.parse(texted.content[0].text), contact, "its text parses as JSON, as codemode's scriptValue parses it");
  assert.deepEqual(structured.structuredContent, contact);
  assert.deepEqual((structured.content ?? []).filter((part) => part.type === "text"), [], "no text block hides the structured content from the run's MCP client");
  assert.deepEqual(fake.calls.map((call) => Object.keys(call).sort()), [["arguments", "tool"], ["arguments", "tool"]], "the fake logs each call's tool and arguments");
});
