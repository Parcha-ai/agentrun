// `agentrun export AGENT --out DIR`: the agent's current revision written as a template package folder, from a server
// in this process (a local install's: its MCP servers may be on loopback). Both lists of the server's report are printed;
// with anything blocked, or an agent the server does not export, it exits 2 and writes nothing.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "../../serve/test/fixtures/fake-mcp-server.mjs";
import { serve } from "../../serve/test/support.mjs";
import { cli, scratch } from "./support.mjs";

const TEMPLATES = new URL("../../serve/dist/templates.js", import.meta.url).pathname;

/** A scratch HOME, a server in this process with no runner (nothing here runs), its client, and the CLI sent to it. */
async function started(t) {
  const { dir, env } = scratch("export");
  const server = await serve(t, { runner: false });
  const agentrun = (args) => cli({ ...env, AGENTRUN_API_KEY: server.token }, [...args, "--base-url", server.baseUrl]);
  return { dir, token: server.token, api: server.api, agentrun };
}

test("demo: agentrun export writes the agent as a package folder readPackage takes, prints what the target remakes, and exits 0", { timeout: 120_000 }, async (t) => {
  const { dir, token, api, agentrun } = await started(t);
  const skill = "---\nname: triage\ndescription: How an inbound message is sorted.\n---\nSort it by urgency first.\n";
  const made = await api("POST", "/agents", { definition: { id: "inbox-triage", name: "Inbox triage", description: "Sorts the inbox.", instructions: "Sort each message you are given.", tools: ["read"], skills: ["triage"], max_cost_usd: 1, learning: false }, skills: { "triage/SKILL.md": skill } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const hook = await api("POST", "/triggers", { name: "Inbound", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "inbox-triage", input: { content: "A message." } } });
  assert.equal(hook.status, 201, JSON.stringify(hook.body));

  const out = join(dir, "inbox-triage");
  const exported = await agentrun(["export", "inbox-triage", "--out", out]);
  assert.equal(exported.code, 0, exported.err);
  const printed = JSON.parse(exported.out);
  assert.equal(printed.name, "inbox-triage");
  assert.deepEqual(printed.blocked, []);
  assert.ok(printed.remade.some((entry) => entry.kind === "trigger" && entry.name === "Inbound"), "the webhook trigger is printed as remade");
  assert.equal(printed.folder, out);
  // The folder holds the server's files, byte for byte, and is a package as `agentrun template validate` reads one.
  const answer = (await api("GET", "/agents/inbox-triage/package")).body;
  assert.equal(printed.sha256, answer.sha256);
  for (const file of answer.files) assert.deepEqual(readFileSync(join(out, file.path)), Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"), file.path);
  assert.equal(readFileSync(join(out, "skills", "triage", "SKILL.md"), "utf8"), skill);
  const { readPackage } = await import(TEMPLATES);
  const pkg = readPackage(out);
  assert.equal(pkg.instructions, "Sort each message you are given.");
  assert.deepEqual(pkg.triggers.map((trigger) => trigger.name), ["Inbound"]);
  const validated = await agentrun(["template", "validate", out]);
  assert.equal(validated.code, 0, validated.err);
  assert.ok(!`${exported.out}${exported.err}`.includes(token), "the token is never printed");
  // A folder that already holds files is not written over.
  const again = await agentrun(["export", "inbox-triage", "--out", out]);
  assert.equal(again.code, 2, again.err);
  assert.match(again.err, /not empty/);
});

test("agentrun export writes nothing and exits 2 when the report blocks the export, or the server does not export the agent", { timeout: 120_000 }, async (t) => {
  const { dir, api, agentrun } = await started(t);
  // An MCP server on this machine's loopback: the target can't reach it.
  const local = await startFakeMcp({ name: "local" });
  t.after(() => local.close());
  const saved = await api("PUT", "/settings/mcp-servers/local", { url: local.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const made = await api("POST", "/agents", { definition: { id: "local-tools", name: "Local tools", instructions: "Use the local tools.", tools: ["read", "mcp:local/add"], skills: [] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const out = join(dir, "local-tools");
  const blocked = await agentrun(["export", "local-tools", "--out", out]);
  assert.equal(blocked.code, 2, blocked.err);
  const printed = JSON.parse(blocked.out);
  assert.ok(printed.blocked.some((entry) => entry.kind === "mcp_server" && entry.name === "local"), blocked.out);
  assert.equal(printed.folder, null);
  assert.match(blocked.err, /[Nn]othing was written/);
  assert.equal(existsSync(out), false, "nothing written");

  // A feed whose URL carries a token: blocked by its field, the token printed nowhere and written nowhere.
  const token = `leak-token-${"cli-export"}-4d7e`;
  const fed = await api("POST", "/agents", { definition: { id: "fed", name: "Fed", instructions: "Say what changed.", tools: ["read"], skills: [], max_cost_usd: 1 } });
  assert.equal(fed.status, 201, JSON.stringify(fed.body));
  const feed = await api("POST", "/triggers", { name: "Status", enabled: false, source: { kind: "feed", urls: [`https://status.example.com/feed.xml?token=${token}`], every_s: 3600 }, target: { kind: "start_run", agent_id: "fed", input: { content: "A new status." } } });
  assert.equal(feed.status, 201, JSON.stringify(feed.body));
  const fedOut = join(dir, "fed");
  const leaked = await agentrun(["export", "fed", "--out", fedOut]);
  assert.equal(leaked.code, 2, leaked.err);
  assert.deepEqual(JSON.parse(leaked.out).blocked.map((entry) => [entry.kind, entry.name]), [["trigger", "Status: source.urls.0"]], leaked.out);
  assert.match(leaked.err, /trigger Status: source\.urls\.0: .*credential in the clear/);
  assert.doesNotMatch(`${leaked.out}${leaked.err}`, new RegExp(token), "the token is printed nowhere");
  assert.equal(existsSync(fedOut), false, "nothing written");

  const sdk = await api("POST", "/agents", { definition: { id: "sdk-agent", name: "SDK", instructions: "Keep the policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] } });
  assert.equal(sdk.status, 201, JSON.stringify(sdk.body));
  const refused = await agentrun(["export", "sdk-agent", "--out", join(dir, "sdk-agent")]);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /not_exportable/);
  assert.equal(existsSync(join(dir, "sdk-agent")), false, "nothing written");
});
