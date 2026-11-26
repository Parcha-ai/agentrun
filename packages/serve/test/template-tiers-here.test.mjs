// What a package's subagents would run on here, as the server decides it (packageTiers on the harness apply picks):
// GET /v2/templates and GET /v2/templates/{template} say it as `model_tiers_here`, so a page (the console's Free shelf)
// reads the server's answer instead of the package's `model.fast` and `model.strong`. Behind a model gateway, the
// package's tiers are not used, and its subagents run on the host's models for them, whatever the package names.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch, serve, withEnv } from "./support.mjs";

const FAST = "anthropic/claude-haiku-4-5";
const STRONG = "anthropic/claude-sonnet-4-5";
const DELEGATES = `---\nname: delegates\nversion: 1.0.0\ndescription: Hands work to subagents.\ntools: [read, subagent]\nmodel:\n  tier: fast\n  fast: ${FAST}\n  strong: ${STRONG}\n---\nDelegate.\n`;
/** Its own tier, fast, names no model of its own: its fast subagents run on the agent's own model, `prefer`. */
const OWN_TIER = `---\nname: own-tier\nversion: 1.0.0\ndescription: Hands work to subagents on its own tier.\ntools: [read, subagent]\nmodel:\n  tier: fast\n  prefer: ${FAST}\n  strong: ${STRONG}\n---\nDelegate.\n`;
const PLAIN = "---\nname: plain\nversion: 1.0.0\ndescription: Reads.\ntools: [read]\n---\nRead.\n";
const GATEWAY = { AGENT_MODEL_BASE_URL: "https://gateway.example/v1", AGENT_MODEL_API_KEY: "fake-test-key", AGENT_MODEL: "gpt-6-luna" };

async function server(t, env) {
  const dir = join(await scratch(t), "templates");
  for (const [name, text] of Object.entries({ delegates: DELEGATES, "own-tier": OWN_TIER, plain: PLAIN })) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "agent.md"), text);
  }
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), ...env }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t, { faux: undefined, runner: false, accounts: true, openSetup: true, templates: dir });
  const listed = async (name) => (await api("GET", "/templates")).body.templates.find((one) => one.name === name).model_tiers_here;
  const read = async (name) => (await api("GET", `/templates/${name}`)).body.template.model_tiers_here;
  const applied = async (name) => {
    const made = await api("POST", `/templates/${name}/apply`, {});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const { definition } = (await api("GET", `/agents/${made.body.agent_id}`)).body;
    return { tiers: definition.model_tiers, warnings: made.body.warnings.filter((w) => w.field === "model").map((w) => w.message) };
  };
  return { listed, read, applied };
}

test("a server that runs a package's tier models lists them as its subagents' models here, the ones apply keeps", async (t) => {
  const { listed, read, applied } = await server(t, { ANTHROPIC_API_KEY: "fake-test-key" });
  const here = { harness: "pi", fast: FAST, strong: STRONG, note: null };
  assert.deepEqual(await listed("delegates"), here);
  assert.deepEqual(await read("delegates"), here, "one package's read says the same");
  assert.deepEqual(await applied("delegates"), { tiers: { fast: FAST, strong: STRONG }, warnings: [] }, "apply keeps what the listing said");
  assert.deepEqual(await listed("plain"), { harness: "pi", fast: null, strong: null, note: null }, "a package that names no model: its subagents on the server's");
  // A tier the package names no model for that is the agent's own runs on the agent's model, as apply saves it.
  assert.deepEqual(await listed("own-tier"), { harness: "pi", fast: FAST, strong: STRONG, note: null }, "the own tier is the agent's model, prefer");
  assert.deepEqual((await applied("own-tier")).tiers, { fast: FAST, strong: STRONG }, "as apply saves it");
});

test("behind a model gateway, the package's tier models are listed as not used, with apply's warning, though a key for their provider is here", async (t) => {
  const { listed, read, applied } = await server(t, { ...GATEWAY, ANTHROPIC_API_KEY: "fake-test-key" });
  const here = await listed("delegates");
  assert.deepEqual({ ...here, note: undefined }, { harness: "pi", fast: null, strong: null, note: undefined });
  assert.match(here.note, new RegExp(`model\\.fast ${FAST} is not used: this server reaches its models through a gateway.*model\\.strong ${STRONG} is not used`));
  assert.deepEqual(await read("delegates"), here);
  const made = await applied("delegates");
  assert.equal(made.tiers, undefined, "apply keeps neither");
  assert.ok(made.warnings.includes(here.note), `apply's warning is the note listed: ${JSON.stringify(made.warnings)}`);
});
