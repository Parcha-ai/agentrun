// `agentrun export AGENT --out DIR`: the agent's current revision written as a template package folder, from a server
// started with a faux model on loopback. Both lists of the server's report are printed; with anything blocked, or an
// agent the server does not export, it exits 2 and writes nothing.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "../../serve/test/fixtures/fake-mcp-server.mjs";
import { removeAtEnd } from "./support.mjs";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const TEMPLATES = new URL("../../serve/dist/templates.js", import.meta.url).pathname;
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-export-"));
  removeAtEnd(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name)));
  return { dir, env: { ...env, AGENTRUN_BOXES: "none", HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") } };
}

/** The server on DIR/data with a faux model, on loopback; resolves once it wrote its record. */
async function serve(t, dir, env) {
  const faux = join(dir, "faux.mjs");
  writeFileSync(faux, 'export default (context, faux) => faux.message("Done.");\n');
  const data = join(dir, "data");
  // A local install's MCP servers may be on loopback (one test's is).
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", faux], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_MCP_ALLOW_LOOPBACK: "1" } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { base_url: base } = JSON.parse(readFileSync(join(data, ".server.json"), "utf8"));
  const token = readFileSync(join(data, ".token"), "utf8").trim();
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { data, token, api };
}

const cliOf = (env, data) => (args) => {
  const run = spawnSync(process.execPath, [BIN, ...args, "--data", data], { env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(run.error);
  return { code: run.status, out: run.stdout, err: run.stderr };
};
const sha256Of = (files) => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) hash.update(file.path).update(Buffer.from([0])).update(Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")).update(Buffer.from([0]));
  return hash.digest("hex");
};

test("demo: agentrun export writes the agent as a package folder readPackage takes, prints what the target remakes, and exits 0", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const { data, token, api } = await serve(t, dir, env);
  const skill = "---\nname: triage\ndescription: How an inbound message is sorted.\n---\nSort it by urgency first.\n";
  const made = await api("POST", "/agents", { definition: { id: "inbox-triage", name: "Inbox triage", description: "Sorts the inbox.", instructions: "Sort each message you are given.", tools: ["read"], skills: ["triage"], max_cost_usd: 1, learning: false }, skills: { "triage/SKILL.md": skill } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const hook = await api("POST", "/triggers", { name: "Inbound", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "inbox-triage", input: { content: "A message." } } });
  assert.equal(hook.status, 201, JSON.stringify(hook.body));

  const out = join(dir, "inbox-triage");
  const cli = cliOf(env, data);
  const exported = cli(["export", "inbox-triage", "--out", out]);
  assert.equal(exported.code, 0, exported.err);
  const printed = JSON.parse(exported.out);
  assert.equal(printed.name, "inbox-triage");
  assert.deepEqual(printed.blocked, []);
  assert.ok(printed.remade.some((entry) => entry.kind === "trigger" && entry.name === "Inbound"), "the webhook trigger is printed as remade");
  assert.equal(printed.folder, out);
  // The folder holds the server's files, byte for byte, and is a package as `agentrun template validate` reads one.
  const answer = (await api("GET", "/agents/inbox-triage/package")).body;
  assert.equal(printed.sha256, answer.sha256);
  assert.equal(answer.sha256, sha256Of(answer.files));
  for (const file of answer.files) assert.deepEqual(readFileSync(join(out, file.path)), Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"), file.path);
  assert.equal(readFileSync(join(out, "skills", "triage", "SKILL.md"), "utf8"), skill);
  const { readPackage } = await import(TEMPLATES);
  const pkg = readPackage(out);
  assert.equal(pkg.instructions, "Sort each message you are given.");
  assert.deepEqual(pkg.triggers.map((trigger) => trigger.name), ["Inbound"]);
  const validated = cli(["template", "validate", out]);
  assert.equal(validated.code, 0, validated.err);
  assert.ok(!`${exported.out}${exported.err}`.includes(token), "the token is never printed");
  // A folder that already holds files is not written over.
  const again = cli(["export", "inbox-triage", "--out", out]);
  assert.equal(again.code, 2, again.err);
  assert.match(again.err, /not empty/);
});

test("agentrun export refuses a --out not named as the package, writes nothing and names the folder that validates; that folder exports and validates", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const { data, api } = await serve(t, dir, env);
  const cli = cliOf(env, data);
  // The package is named after the agent's name here, not its id: the folder the id suggests is not the package's.
  const made = await api("POST", "/agents", { definition: { id: "triage-2", name: "Inbox triage", instructions: "Sort each message you are given.", tools: ["read"], skills: [], learning: false } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const wrong = join(dir, "triage-2");
  const refused = cli(["export", "triage-2", "--out", wrong]);
  assert.equal(refused.code, 2, `${refused.err}${refused.out}`);
  const printed = JSON.parse(refused.out);
  assert.equal(printed.name, "inbox-triage");
  assert.equal(printed.folder, null);
  const right = join(dir, "inbox-triage");
  assert.ok(refused.err.includes("inbox-triage") && refused.err.includes(right), refused.err);
  assert.match(refused.err, /[Nn]othing was written/);
  assert.equal(existsSync(wrong), false, "nothing written");

  // The folder it names, given with a trailing slash, is written and passes validate.
  const exported = cli(["export", "triage-2", "--out", `${right}/`]);
  assert.equal(exported.code, 0, exported.err);
  assert.equal(JSON.parse(exported.out).folder, right);
  const validated = cli(["template", "validate", right]);
  assert.equal(validated.code, 0, validated.err);
});

test("agentrun export of an agent with no max_cost_usd whose trigger has its own $1 cap writes a package that validates; a trigger with no cap of its own blocks it, named", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const { data, api } = await serve(t, dir, env);
  const cli = cliOf(env, data);
  const made = await api("POST", "/agents", { definition: { id: "digest", name: "Digest", instructions: "Write the digest.", tools: ["read"], skills: [], learning: false } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const morning = await api("POST", "/triggers", { name: "morning", source: { kind: "schedule", cron: "0 9 * * *" }, target: { kind: "start_run", agent_id: "digest", input: { content: "Write the morning digest." }, max_cost_usd: 1 } });
  assert.equal(morning.status, 201, JSON.stringify(morning.body));
  const out = join(dir, "digest");
  const exported = cli(["export", "digest", "--out", out]);
  assert.equal(exported.code, 0, exported.err);
  assert.deepEqual(JSON.parse(exported.out).blocked, []);
  const validated = cli(["template", "validate", out]);
  assert.equal(validated.code, 0, validated.err);
  const { readPackage } = await import(TEMPLATES);
  const pkg = readPackage(out);
  assert.equal(pkg.budget, undefined);
  assert.deepEqual(pkg.triggers.map((trigger) => [trigger.name, trigger.target.max_cost_usd]), [["morning", 1]]);

  // A second trigger capped only by the agent's default, which is then cleared: that trigger blocks the export, named.
  const { version: _, ...definition } = (await api("GET", "/agents/digest")).body.definition;
  assert.equal((await api("PUT", "/agents/digest/definition", { definition: { ...definition, max_cost_usd: 0.5 } })).status, 200);
  const evening = await api("POST", "/triggers", { name: "evening", source: { kind: "schedule", cron: "0 18 * * *" }, target: { kind: "start_run", agent_id: "digest", input: { content: "Write the evening digest." } } });
  assert.equal(evening.status, 201, JSON.stringify(evening.body));
  const { version: __, ...capped } = (await api("GET", "/agents/digest")).body.definition;
  assert.equal((await api("PUT", "/agents/digest/definition", { definition: { ...capped, max_cost_usd: 0 } })).status, 200);
  const again = join(dir, "again", "digest");
  const refused = cli(["export", "digest", "--out", again]);
  assert.equal(refused.code, 2, `${refused.err}${refused.out}`);
  assert.deepEqual(JSON.parse(refused.out).blocked.map((note) => [note.kind, note.name]), [["trigger", "evening"]]);
  assert.match(refused.err, /trigger evening: .*max_cost_usd/);
  assert.ok(!refused.err.includes("morning"), refused.err);
  assert.equal(existsSync(again), false, "nothing written");
});

test("agentrun export writes nothing and exits 2 when the report blocks the export, or the server does not export the agent", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const { data, api } = await serve(t, dir, env);
  const cli = cliOf(env, data);
  // An MCP server on this machine's loopback: the target can't reach it.
  const local = await startFakeMcp({ name: "local" });
  t.after(() => local.close());
  const saved = await api("PUT", "/settings/mcp-servers/local", { url: local.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const made = await api("POST", "/agents", { definition: { id: "local-tools", name: "Local tools", instructions: "Use the local tools.", tools: ["read", "mcp:local/add"], skills: [] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const out = join(dir, "local-tools");
  const blocked = cli(["export", "local-tools", "--out", out]);
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
  const leaked = cli(["export", "fed", "--out", fedOut]);
  assert.equal(leaked.code, 2, leaked.err);
  assert.deepEqual(JSON.parse(leaked.out).blocked.map((entry) => [entry.kind, entry.name]), [["trigger", "Status: source.urls.0"]], leaked.out);
  assert.match(leaked.err, /trigger Status: source\.urls\.0: .*credential in the clear/);
  assert.doesNotMatch(`${leaked.out}${leaked.err}`, new RegExp(token), "the token is printed nowhere");
  assert.equal(existsSync(fedOut), false, "nothing written");

  const sdk = await api("POST", "/agents", { definition: { id: "sdk-agent", name: "SDK", instructions: "Keep the policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] } });
  assert.equal(sdk.status, 201, JSON.stringify(sdk.body));
  const refused = cli(["export", "sdk-agent", "--out", join(dir, "sdk-agent")]);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /not_exportable/);
  assert.equal(existsSync(join(dir, "sdk-agent")), false, "nothing written");
});
