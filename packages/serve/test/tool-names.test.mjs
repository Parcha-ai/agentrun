// One tool-name grammar: an MCP tool's name is read the same at each place that takes one. Its tool settings (set), a
// learned workflow's tools (learn) and an agent's grant (grant) all accept a name, or all refuse it.
import { test } from "node:test";
import assert from "node:assert/strict";

const { settingsIssues } = await import("../dist/tool-plane.js");
const { learnedWorkflowTools } = await import("../dist/tools.js");
const { blockersOf } = await import("../dist/runnable.js");

/** Whether the server's tool settings take `name` as a key. */
const set = (name) => settingsIssues({ [name]: { permission: "deny" } }).length === 0;
/** Whether a learned workflow may name `name`, granted by its own name. */
const learn = (name) => learnedWorkflowTools([name], undefined, { mcp: true }).includes(name);
/** Whether an agent on pi may be granted `name`, its server saved and listing the tool. */
const grant = async (name) => {
  const tool = name.slice(name.indexOf("/") + 1);
  const blockers = await blockersOf({}, { kind: "agentic", instructions: "Do it.", tools: [name], harness: "pi", model: "anthropic/claude-sonnet-5-5" }, {}, { mcp: () => [{ name: tool, inputSchema: { type: "object" } }] });
  return !blockers.some((b) => b.field === "definition.tools[0]");
};

test("an MCP tool's name is accepted or refused alike at set, learn and grant", async () => {
  const cases = [
    // A Composio action, through its MCP server (the composio preset): upper case and underscores.
    ["mcp:github/GITHUB_CREATE_AN_ISSUE", true],
    ["mcp:linear-app/create_issue", true],
    ["mcp:hn/HACKERNEWS_GET_FRONTPAGE", true],
    // A dot is no character of a tool's name on the model APIs: refused everywhere, never set or learned but not granted.
    ["mcp:linear/issue.create", false],
    // A tool's name is at most 64 characters.
    [`mcp:docs/${"a".repeat(65)}`, false],
    // A server's name is lowercase letters, digits and dashes, starting with a letter.
    ["mcp:My_Server/search", false],
    ["mcp:my.server/search", false],
  ];
  for (const [name, ok] of cases) {
    assert.deepEqual({ name, set: set(name), learn: learn(name), grant: await grant(name) }, { name, set: ok, learn: ok, grant: ok });
  }
});

test("a server's wildcard is a settings key of a well-formed server only", () => {
  assert.equal(set("mcp:github/*"), true);
  assert.equal(set("mcp:My_Server/*"), false);
});
