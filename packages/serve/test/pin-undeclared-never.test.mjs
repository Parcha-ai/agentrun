// A pinned call carries only what it may, on pi, claude-agent and codex under approvals never: a template pins Slack's
// SLACK_SEND_MESSAGE `channel`, Gmail's GMAIL_SEND_EMAIL `recipient_email` and GitHub's GITHUB_CREATE_AN_ISSUE
// `owner`/`repo`, each served by the fake MCP server under its real listing (fixtures/composio-pinned-tools.json). A call
// that adds an argument the listing does not declare (`channel_id`, `to`, `repository`: aliases the real servers take)
// is refused, never parked and never sent, directly and through a nested call (tools_call where the harness offers it,
// past the deferral threshold, so beside idle tools; Claude Code, which never offers it, from a codemode script); a call
// of declared arguments alone runs with no one asked. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callsOf, HARNESSES, harnessSetup, IDLE_TOOLS, TOOLS_CALL_HARNESSES } from "./fixtures/mcp-harness-setup.mjs";
import { follow, scratch, whenFree } from "./support.mjs";

const LISTED = JSON.parse(readFileSync(new URL("./fixtures/composio-pinned-tools.json", import.meta.url), "utf8"));
/** The three tools under their real listings, each answering with the arguments it was sent. */
const TOOLS = Object.fromEntries(LISTED.map(({ name, description, inputSchema }) => [name, { description, input: inputSchema, run: (args) => ({ content: [{ type: "text", text: `${name} sent ${Object.keys(args).sort().join(",")}` }] }) }]));
const SEND = "mcp:fake/SLACK_SEND_MESSAGE";
const EMAIL = "mcp:fake/GMAIL_SEND_EMAIL";
const ISSUE = "mcp:fake/GITHUB_CREATE_AN_ISSUE";

const IDLE = Object.keys(IDLE_TOOLS);

/** A package that sends to one channel, one inbox and one repository, with `idle` tools of the fake's beside them. */
function pinnedPackage(dir, name, harness, idle = []) {
  mkdirSync(join(dir, name), { recursive: true });
  const tools = ["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL", "GITHUB_CREATE_AN_ISSUE", ...idle].join(", ");
  writeFileSync(join(dir, name, "agent.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: Sends to one channel, one inbox and one repository, unattended.\nharness: [${harness}]\nmcp:\n  - source: url\n    toolkit: fake\n    tools: [${tools}]\n    required: true\n    allow: [${tools}]\n    pin: { SLACK_SEND_MESSAGE: { channel: C0123 }, GMAIL_SEND_EMAIL: { recipient_email: ops@example.com }, GITHUB_CREATE_AN_ISSUE: { owner: acme, repo: widgets } }\napprovals: never\n---\nCall the tool you are asked to call.\n`);
}

for (const harness of HARNESSES) {
  const nested = TOOLS_CALL_HARNESSES.has(harness) ? "tools_call" : "codemode";
  test(`${harness}: a pinned tool takes only its listed arguments: an undeclared alias is refused unsent, directly and through ${nested}; declared arguments run unasked`, { timeout: 300_000 }, async (t) => {
    const dir = join(await scratch(t), "templates");
    pinnedPackage(dir, `pinned-${harness}`, harness);
    pinnedPackage(dir, `pinned-many-${harness}`, harness, IDLE);
    const { api, fake, prompt, host } = await harnessSetup(t, harness, dir, { tools: { ...TOOLS, ...IDLE_TOOLS } });
    const applied = await whenFree(() => api("POST", `/templates/pinned-${harness}/apply`, { grants: [SEND, EMAIL, ISSUE] }));
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const sent = () => ["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL", "GITHUB_CREATE_AN_ISSUE"].map((tool) => callsOf(fake, tool).length).reduce((a, b) => a + b, 0);
    const run = async (content, id = applied.body.agent_id) => {
      const started = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content } }));
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const { last } = await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
      return { last, answer: last.status === "completed" ? ((await api("GET", `/runs/${started.body.run_id}`)).body.result?.final_answer ?? "") : "" };
    };

    const aliases = [
      ["SLACK_SEND_MESSAGE", { channel: "C0123", channel_id: "C0EVIL", markdown_text: "hi" }, /`channel_id` is not an argument of SLACK_SEND_MESSAGE; a pinned tool takes only its listed arguments \(channel is pinned\)/],
      ["GMAIL_SEND_EMAIL", { recipient_email: "ops@example.com", to: "mallory@example.com", subject: "hi", body: "hi" }, /`to` is not an argument of GMAIL_SEND_EMAIL; a pinned tool takes only its listed arguments \(recipient_email is pinned\)/],
      ["GITHUB_CREATE_AN_ISSUE", { owner: "acme", repo: "widgets", repository: "mallory/loot", title: "hi" }, /`repository` is not an argument of GITHUB_CREATE_AN_ISSUE; a pinned tool takes only its listed arguments \(owner and repo are pinned\)/],
    ];
    for (const [tool, args, words] of aliases) {
      const { last, answer } = await run(prompt(tool, args));
      assert.equal(last.status, "completed", `${tool}: nothing asks and nothing fails, ${JSON.stringify(last)}`);
      assert.equal(sent(), 0, `${tool}: the call with an undeclared argument never reached the MCP server`);
      // pi checks a call against a listing that closes itself (Slack's: additionalProperties false) before the gate, and
      // refuses an unknown field in its own words; every other listing here is open, so the gate's words are read.
      const ownCheck = harness === "pi" && TOOLS[tool].input.additionalProperties === false;
      assert.match(answer, ownCheck ? new RegExp(`${words.source}|Validation failed for tool "mcp__fake__${tool}":\\s+- channel_id: unknown field`) : words, `${tool}: the model read why`);
    }

    // Through a nested call: the inner call is held to the same listing. tools_call is offered only past the deferral
    // threshold, so on the agent with the idle tools too; Claude Code offers none, so from a codemode script there.
    const INNER = "mcp__fake__GMAIL_SEND_EMAIL";
    const aliased = { recipient_email: "ops@example.com", to: "mallory@example.com", subject: "hi" };
    let through;
    if (nested === "tools_call") {
      const many = await whenFree(() => api("POST", `/templates/pinned-many-${harness}/apply`, { grants: [SEND, EMAIL, ISSUE, ...IDLE.map((tool) => `mcp:fake/${tool}`)] }));
      assert.equal(many.status, 201, JSON.stringify(many.body));
      through = await run(host("tools_call", { name: INNER, args: aliased }), many.body.agent_id);
    } else through = await run(host("codemode", { script: `return await tools.${INNER}(${JSON.stringify(aliased)});` }));
    assert.equal(through.last.status, "completed", `${nested}: nothing asks and nothing fails, ${JSON.stringify(through.last)}`);
    assert.equal(sent(), 0, `${nested}: the call with an undeclared argument never reached the MCP server`);
    assert.match(through.answer, /`to` is not an argument of GMAIL_SEND_EMAIL/, `${nested}: the model read why`);

    // Declared arguments alone: it runs, unasked.
    const ok = await run(prompt("GMAIL_SEND_EMAIL", { recipient_email: "ops@example.com", subject: "hi", body: "hi" }));
    assert.equal(ok.last.status, "completed", JSON.stringify(ok.last));
    assert.equal(callsOf(fake, "GMAIL_SEND_EMAIL").length, 1, "the declared call ran once, with no one asked");
    assert.match(ok.answer, /GMAIL_SEND_EMAIL sent body,recipient_email,subject/);
  });
}
