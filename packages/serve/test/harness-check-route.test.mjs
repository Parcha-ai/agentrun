// harness-check on a model the route translates onto a recipe's wire (an Ollama model on Anthropic's Messages): the
// check's recorder wraps the next hop, the route's own fetch, so the recipe's agent reaches Ollama through the route as a
// server's run of it does, and the check still sees every request. All on loopback: a fake Ollama
// (fixtures/fake-ollama.mjs) and the stand-in agent (fixtures/model-acp-agent.mjs) installed as a recipe's release; no
// real Ollama is asked, no key is held.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";
import { fakeOllama } from "./fixtures/fake-ollama.mjs";

const { installRecipe, loadRecipe } = await import("../dist/harness-recipe.js");
const { archivePlatform } = await import("../dist/harness-archive.js");
const { harnessCheck } = await import("../dist/harness-check.js");

// The suites turn every Ollama off (support.mjs, OLLAMA_OFF_ENV); this file asks its own fake alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

const AGENT = new URL("./fixtures/model-acp-agent.mjs", import.meta.url).pathname;
const PLATFORM = archivePlatform();
const URL_OF = "https://releases.example.invalid/model-agent-1.0.0.tar.bz2";
const TOOLS = "synth-tools:2b";
const linux = process.platform === "linux" ? false : "the agent's environment and its kill are read from /proc";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The stand-in agent's release (`./agent`, a script that runs it) packed in a .tar.bz2, and a recipe file for it on
 *  Anthropic's Messages, its archive's sha256 the release's, installed into a data directory of its own. */
async function installedAgent(t) {
  const dir = await scratch(t);
  const tree = join(dir, "tree");
  mkdirSync(tree);
  writeFileSync(join(tree, "agent"), `#!/bin/sh\nexec '${process.execPath}' '${AGENT}' "$@"\n`);
  chmodSync(join(tree, "agent"), 0o755);
  const archive = join(dir, "agent.tar.bz2");
  const packed = spawnSync("tar", ["-cjf", archive, "-C", tree, "./agent"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  const recipe = {
    id: "model-agent",
    label: "Model Agent",
    release: { registry: "model-agent", version: "1.0.0", archives: { [PLATFORM]: { url: URL_OF, format: "tar.bz2", sha256: sha256(bytes), cmd: "./agent" } } },
    env: { MODEL_AGENT_MODE: "good" },
    model: { billing: "proxy", wire: "anthropic-messages", env: "MODEL_AGENT_MODEL" },
    files: { ".config/model-agent/settings.json": "{\"telemetry\": false}\n" },
    state: [".model-agent/sessions"],
    declares: { load: true, mcp: "http" },
    // Goose's way: the agent runs our tools unasked, and the check's gate asks at the MCP call.
    allowFile: { path: ".config/goose/permission.yaml", form: "goose-permission" },
  };
  const file = join(dir, "recipe.json");
  writeFileSync(file, `${JSON.stringify(recipe, null, 2)}\n`);
  const data = join(dir, "agents");
  await installRecipe(loadRecipe(file).recipe, file, data, { fetch: async (url) => (String(url) === URL_OF ? new Response(bytes, { status: 200 }) : new Response("no", { status: 404 })) });
  return { file, data };
}

/** The scripted model on Ollama's /api/chat for the check's turns: it calls the tool the last prompt names, with the text
 *  it gives, and answers a tool's result with it. */
function checkStep(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  if (last?.role === "tool") return { text: `RESULT ${String(last.content).slice(0, 80)}` };
  const names = (body.tools ?? []).map((tool) => tool.function?.name);
  const prompt = messages.filter((message) => message.role === "user").map((message) => String(message.content)).join("\n");
  const use = [...prompt.matchAll(/Use the (check_\w+) tool once, with the text argument set to (\w+)/g)].at(-1);
  if (use) {
    const name = names.find((each) => each?.endsWith(use[1]));
    return name ? { calls: [{ name, arguments: { text: use[2] } }] } : { text: `NO ${use[1]} among ${names}` };
  }
  return { text: "ready" };
}

/** The process's environment with no model key and no gateway: the fake Ollama is the only model here. */
function keyless(extra) {
  const env = { ...process.env, AGENTRUN_TELEMETRY: "0" };
  for (const name of Object.keys(env)) if (/_API_KEY$|_TOKEN$|^AGENT_MODEL|^ANTHROPIC_|^OPENAI_|^OPENROUTER_/.test(name)) delete env[name];
  return { ...env, ...extra };
}

test("harness-check on an Ollama model: the recorder wraps the route's own fetch, so the agent's turns reach the fake's /api/chat and mcp_tool passes", { skip: linux, timeout: 120_000 }, async (t) => {
  const ollama = await fakeOllama(t, { reply: checkStep });
  const { file, data } = await installedAgent(t);
  const report = await harnessCheck({ recipe: file, data, model: `ollama/${TOOLS}`, env: keyless({ OLLAMA_HOST: ollama.host }) });
  assert.equal(report.refused, undefined, JSON.stringify(report.refused));
  // Before: the recorder forwarded to the network, so every request went to the route's placeholder origin and failed.
  assert.equal(report.stage3?.mcp_tool?.ok, true, JSON.stringify(report.stage3?.mcp_tool));
  assert.equal(report.stage3.mcp_tool.calls, 1);
  assert.equal(report.stage3.mcp_tool.resultReachedModel, true, "the recorder still saw the echo reach the model");
  assert.ok(ollama.got.chat.length >= 2, `the turns reached /api/chat: ${ollama.got.chat.length}`);
  assert.deepEqual([...new Set(ollama.got.chat.map((body) => body.model))], [TOOLS]);
});
