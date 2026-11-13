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

test("parseToolName reads each shape of a catalog name, and formatToolName writes it back", async () => {
  const { formatToolName, isMcpName, mcpNameOf, parseToolName } = await import("../dist/tool-names.js");
  const shapes = [
    ["read", { kind: "plain", name: "read" }],
    ["monid.discover", { kind: "plain", name: "monid.discover" }],
    ["mcp:github/GITHUB_CREATE_AN_ISSUE", { kind: "mcp", server: "github", tool: "GITHUB_CREATE_AN_ISSUE" }],
    ["mcp:linear-app/*", { kind: "mcp-server", server: "linear-app" }],
  ];
  for (const [name, parsed] of shapes) {
    assert.deepEqual(parseToolName(name), parsed, name);
    assert.equal(formatToolName(parsed), name);
  }
  for (const name of ["mcp:srv", "mcp:srv/a/b", "mcp:srv/a.b", "mcp:-srv/x", "Read", "mcp:srv/", ""]) assert.equal(parseToolName(name), undefined, name);
  assert.equal(mcpNameOf("mcp:linear-app/*"), undefined, "a wildcard is no one tool");
  assert.ok(isMcpName("mcp:srv/a.b") && !isMcpName("monid.run"), "the namespace holds a malformed MCP name too");
});
