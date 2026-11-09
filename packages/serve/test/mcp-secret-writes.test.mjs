// MCP's slice of the secret writes (SECRETS-PLAN.md): which operations' bodies carry an MCP secret value, so the one gate
// in the server's dispatch takes them from the owner's signed-in page alone. A value is a bearer token or a header's
// value in a saved server's auth, an OAuth client_secret at a sign-in's start, or the private-network OAuth hosts (the
// whole body: it widens where sign-ins send their codes and tokens). Everything else an API token may still do: a server
// with no credential, a change of prices, tools or url that keeps the saved credential, a preview (nothing is kept).
import assert from "node:assert/strict";
import { test } from "node:test";

const { mcpWritesSecret } = await import("../dist/mcp-secret-writes.js");
const TOKEN = `not-a-secret-${"bearer"}`;

test("the table: true only for a body that carries an MCP secret value, or the private-network hosts", () => {
  for (const [operation, body, writes, why] of [
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "bearer", token: TOKEN } }, true, "a bearer token"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "headers", headers: { "X-Api-Key": TOKEN } } }, true, "a header's value"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "headers", headers: { "X-Api-Key": "" } } }, true, "a header named with a value, empty or not, is a value sent"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "none", token: TOKEN } }, true, "a token in any auth, even one the save then refuses"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "none" } }, false, "no credential"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp" }, false, "no auth at all"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "bearer" }, prices: { add: 0.01 } }, false, "prices, the saved bearer kept"],
    ["saveMcpServer", { url: "https://mcp.example.test/v2/mcp", auth: { type: "headers" } }, false, "a new url, the saved headers kept"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "headers", headers: {} } }, false, "no header named"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "oauth" } }, false, "oauth keeps its sign-in"],
    ["saveMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "github_app" } }, false, "a github_app server keeps nothing: its token is minted per run"],
    ["saveMcpServer", null, false, "no body"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", client_id: "corp-app", client_secret: TOKEN }, true, "a client secret"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", client_id: "corp-app" }, false, "a client id alone"],
    ["startMcpOAuth", { url: "https://mcp.example.test/mcp", scopes: ["read"] }, false, "no client"],
    ["previewMcpServer", { url: "https://mcp.example.test/mcp", auth: { type: "bearer", token: TOKEN } }, false, "a preview keeps nothing"],
    ["putMcpPrivateHosts", { hosts: [] }, true, "the private-network hosts, whatever the body"],
    ["deleteMcpServer", undefined, false, "a delete carries none"],
    ["refreshMcpServer", {}, false, "a refresh carries none"],
    ["createAgent", { auth: { type: "bearer", token: TOKEN } }, false, "not an MCP operation"],
  ]) assert.equal(mcpWritesSecret(operation, body), writes, `${operation}: ${why}`);
});
