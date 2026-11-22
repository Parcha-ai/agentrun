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
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", faux], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0" } });
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

test("agentrun export writes nothing and exits 2 when the report blocks the export, or the server does not export the agent", { timeout: 120_000 }, async (t) => {
  const { dir, env } = scratch();
  const { data, api } = await serve(t, dir, env);
  const cli = cliOf(env, data);
  // `mcp:stdio-tools/run`: a server saved nowhere here, as a local process the agent was given on its own machine is.
  const made = await api("POST", "/agents", { definition: { id: "local-tools", name: "Local tools", instructions: "Use the local tools.", tools: ["read", "mcp:stdio-tools/run"], skills: [] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const out = join(dir, "local-tools");
  const blocked = cli(["export", "local-tools", "--out", out]);
  assert.equal(blocked.code, 2, blocked.err);
  const printed = JSON.parse(blocked.out);
  assert.ok(printed.blocked.some((entry) => entry.kind === "mcp_server" && entry.name === "stdio-tools"), blocked.out);
  assert.equal(printed.folder, null);
  assert.match(blocked.err, /[Nn]othing was written/);
  assert.equal(existsSync(out), false, "nothing written");

  const sdk = await api("POST", "/agents", { definition: { id: "sdk-agent", name: "SDK", instructions: "Keep the policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] } });
  assert.equal(sdk.status, 201, JSON.stringify(sdk.body));
  const refused = cli(["export", "sdk-agent", "--out", join(dir, "sdk-agent")]);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /not_exportable/);
  assert.equal(existsSync(join(dir, "sdk-agent")), false, "nothing written");
});
