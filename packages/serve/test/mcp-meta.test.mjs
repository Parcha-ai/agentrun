// A meta tool (one that runs other actions by name: Composio's COMPOSIO_MULTI_EXECUTE_TOOL, Klavis Strata's
// execute_action, Zapier's execute actions, Arcade's UseTool, Docker's mcp-exec, Cloudflare's portal_execute and code
// mode) is never granted: a grant of it could not name the real action, so allow would cover every inner action and deny
// could target none. The rule is a closed list of known names, a generic name matched with its provider's host; a meta
// tool the list does not know stays an MCP tool like any other, asked by default. Through the API against the fake MCP
// server: the server's tools read the meta tool grantable false with the reason; a grant of it is 422 in those words, and
// a direct tool of the same server is granted; Klavis's generic execute_action on a host that is not Klavis's is not
// refused. A grant saved before the rule is refused at the launch, when the run's tools are pinned.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpGateway, mcpPinOf } from "../dist/mcp-gateway.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, answerFlow, flowAgent, follow, serve as serveOf, withEnv } from "./support.mjs";

const TOKEN = `not-a-secret-${"mcp-meta-bearer-0123"}`;
const REASON = "it runs other actions by name, so a grant can't name the real action. Use the server's direct tools instead.";
const serve = (t) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t));
const object = { type: "object", properties: {} };
const answer = () => ({ content: [{ type: "text", text: "ran" }] });

/** The fake MCP server with `tools` added, saved as `name`. */
async function saved(t, api, name, tools) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  for (const tool of tools) fake.tools[tool] = { description: `${tool}, for the test.`, input: object, run: answer };
  const put = await api("PUT", `/settings/mcp-servers/${name}`, { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return put.body;
}

test("Composio's COMPOSIO_MULTI_EXECUTE_TOOL reads grantable false with the reason and a grant of it is 422 in words; the server's direct tool is granted", async (t) => {
  const { api } = await serve(t);
  const view = await saved(t, api, "composio", ["COMPOSIO_MULTI_EXECUTE_TOOL", "GMAIL_SEND_EMAIL"]);
  const byName = Object.fromEntries(view.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([byName.COMPOSIO_MULTI_EXECUTE_TOOL.grantable, byName.COMPOSIO_MULTI_EXECUTE_TOOL.reason], [false, REASON], "the save's answer");
  assert.equal(byName.GMAIL_SEND_EMAIL.grantable, undefined, "a direct tool is grantable as any");
  const read = (await api("GET", "/settings/mcp-servers/composio")).body.tools.find((tool) => tool.name === "COMPOSIO_MULTI_EXECUTE_TOOL");
  assert.deepEqual([read.grantable, read.reason], [false, REASON], "a read says so too");
  const refused = await api("POST", "/agents", agent("meta", { tools: ["mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.ok(JSON.stringify(refused.body).includes(`mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${REASON}`), JSON.stringify(refused.body));
  assert.equal((await api("POST", "/agents", agent("direct", { tools: ["mcp:composio/GMAIL_SEND_EMAIL"] }))).status, 201, "the direct tool is granted");
  const doc = (await api("GET", "/openapi.json")).body;
  const served = doc.paths["/settings/mcp-servers/{name}"].get.responses["200"].content["application/json"].schema;
  assert.deepEqual(served.properties.tools.items.properties.grantable?.const, false, "the served document names grantable on an MCP tool");
});

test("a generic name is a meta tool only on its provider's host: Klavis's execute_action on a host that is not Klavis's is granted", async (t) => {
  const { api } = await serve(t);
  const view = await saved(t, api, "local", ["execute_action"]);
  assert.equal(view.tools.find((tool) => tool.name === "execute_action").grantable, undefined);
  assert.equal((await api("POST", "/agents", agent("generic", { tools: ["mcp:local/execute_action"] }))).status, 201);
  // The list itself: the generic names only on their hosts, the provider-named ones anywhere.
  const { metaToolOf } = await import("../dist/mcp-meta.js");
  assert.equal(metaToolOf("https://strata.klavis.ai/mcp/?strata_id=x", "execute_action")?.reason, REASON);
  assert.equal(metaToolOf("https://klavis.ai.example.com/mcp", "execute_action"), undefined, "a host that only looks like Klavis's");
  assert.equal(metaToolOf("https://mcp.zapier.com/api/mcp/s/x/mcp", "write_code_action")?.reason, REASON);
  // A host written with its final dot is the same host.
  assert.equal(metaToolOf("https://strata.klavis.ai./mcp/?strata_id=x", "execute_action")?.reason, REASON, "klavis.ai. is klavis.ai");
  assert.equal(metaToolOf("https://mcp.zapier.com./api/mcp/s/x/mcp", "write_code_action")?.reason, REASON, "mcp.zapier.com. is mcp.zapier.com");
  assert.equal(metaToolOf("http://127.0.0.1:9/mcp", "write_code_action"), undefined);
  for (const name of ["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "execute_zapier_write_action", "Arcade_UseTool", "mcp-exec", "portal_execute", "portal_codemode_execute"]) {
    assert.equal(metaToolOf("http://127.0.0.1:9/mcp", name)?.reason, REASON, name);
  }
  for (const name of ["COMPOSIO_SEARCH_TOOLS", "add", "execute", "code"]) assert.equal(metaToolOf("http://127.0.0.1:9/mcp", name), undefined, `${name} runs nothing by name, or is no known meta tool`);
});

test("a meta tool granted before the rule is refused at the launch, when the run's tools are pinned", () => {
  const source = { server: () => ({ url: "http://127.0.0.1:9/mcp", tools: [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: object }, { name: "GMAIL_SEND_EMAIL", inputSchema: object }] }), headers: () => undefined };
  assert.throws(() => mcpPinOf(["mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL"], source), new RegExp(`mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(Object.keys(mcpPinOf(["mcp:composio/GMAIL_SEND_EMAIL"], source)), ["composio"]);
});

test("a grant of a meta tool is 422 on a harness that doesn't bind MCP tools too, never a setup warning", async (t) => {
  const { api } = await serve(t);
  await saved(t, api, "composio", ["COMPOSIO_MULTI_EXECUTE_TOOL"]);
  const refused = await api("POST", "/agents", agent("opencode-meta", { harness: "opencode", tools: ["mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.ok(JSON.stringify(refused.body).includes(`can't be granted: ${REASON}`), JSON.stringify(refused.body));
});

test("a grant of a meta tool is 422 in the same words on every harness that binds MCP tools: pi, claude-agent and codex", async (t) => {
  const { api } = await serve(t);
  await saved(t, api, "composio", ["COMPOSIO_MULTI_EXECUTE_TOOL", "GMAIL_SEND_EMAIL"]);
  const words = [];
  for (const harness of ["pi", "claude-agent", "codex"]) {
    const refused = await api("POST", "/agents", agent(`meta-${harness}`, { harness, tools: ["mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL"] }));
    assert.equal(refused.status, 422, `${harness}: ${JSON.stringify(refused.body)}`);
    const field = refused.body.error.fields.find((one) => one.field === "definition.tools[0]");
    assert.deepEqual([field?.reason, field?.message], ["not_an_option", `mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${REASON}`], `${harness}: ${JSON.stringify(refused.body)}`);
    words.push(field.message);
    // The same server's direct tool is no meta tool on this harness either.
    const direct = await api("POST", "/agents", agent(`direct-${harness}`, { harness, tools: ["mcp:composio/GMAIL_SEND_EMAIL"] }));
    assert.ok(!JSON.stringify(direct.body).includes("can't be granted"), `${harness}: ${JSON.stringify(direct.body)}`);
  }
  assert.equal(new Set(words).size, 1, "one refusal, word for word, on every harness");
});

test("a run's pin made before the rule, holding a meta tool, refuses its next launch in words; the gateway never sends a pinned meta tool", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t);
  await saved(t, api, "composio", ["COMPOSIO_MULTI_EXECUTE_TOOL", "GMAIL_SEND_EMAIL"]);
  assert.equal((await api("POST", "/agents", agent("old", { tools: ["mcp:composio/GMAIL_SEND_EMAIL"] }))).status, 201);
  const run = await api("POST", "/agents/old/runs", { input: { content: "Hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  // The pin as one made before the rule would be: the meta tool beside the direct one.
  const file = join(data, "runs", runId, "mcp-tools.json");
  const pin = JSON.parse(await readFile(file, "utf8"));
  pin.composio.tools.push({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: object });
  await writeFile(file, JSON.stringify(pin));
  // The message's launch is refused at once: the run fails in words (the message is answered 409 once it has).
  const again = await api("POST", `/runs/${runId}/messages`, { content: "Again." });
  assert.ok([202, 409].includes(again.status), JSON.stringify(again.body));
  const { last } = await follow(api, runId, ["failed", "completed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([last.status, view.error?.message], ["failed", `mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${REASON}`], JSON.stringify(view.error));
  const gateway = mcpGateway({ pin: { composio: { url: "http://127.0.0.1:9/mcp", tools: [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: object }] } }, credentials: { composio: { url: "http://127.0.0.1:9/mcp" } }, work: () => data });
  const said = await gateway.call("composio", "COMPOSIO_MULTI_EXECUTE_TOOL", {}, { signal: new AbortController().signal });
  assert.deepEqual([said.isError, said.content[0].text], [true, `mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${REASON} Nothing was sent.`]);
});

test("a workflow's own grants are held to the rule too: one that lists a meta tool is 422 at the save, never saved to fail its launches; one that lists a direct MCP tool saves", async (t) => {
  const { api } = await serve(t);
  await saved(t, api, "composio", ["COMPOSIO_MULTI_EXECUTE_TOOL", "GMAIL_SEND_EMAIL"]);
  const refused = await api("POST", "/agents", flowAgent("flow-meta", undefined, { tools: ["mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.ok(JSON.stringify(refused.body).includes(`mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${REASON}`), JSON.stringify(refused.body));
  const ordinary = await api("POST", "/agents", flowAgent("flow-direct", undefined, { tools: ["mcp:composio/GMAIL_SEND_EMAIL"] }));
  assert.ok(![422].includes(ordinary.status), `a workflow that lists a direct MCP tool saves: ${JSON.stringify(ordinary.body)}`);
});

test("the workflow check agrees with the save: a workflow that lists a meta tool reads not ok, with the same words", async (t) => {
  const { api } = await serve(t);
  await saved(t, api, "composio", ["COMPOSIO_MULTI_EXECUTE_TOOL", "GMAIL_SEND_EMAIL"]);
  const checked = (await api("POST", "/workflows/validate", { workflow: answerFlow(), tools: ["mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL"] })).body;
  assert.equal(checked.ok, false, JSON.stringify(checked));
  assert.ok(checked.issues.some((issue) => issue.message === `mcp:composio/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${REASON}`), JSON.stringify(checked.issues));
  const direct = (await api("POST", "/workflows/validate", { workflow: answerFlow(), tools: ["mcp:composio/GMAIL_SEND_EMAIL"] })).body;
  assert.ok(!direct.issues.some((issue) => /can't be granted/.test(issue.message)), JSON.stringify(direct.issues));
});
