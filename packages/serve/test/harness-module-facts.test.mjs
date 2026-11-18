// A harness's facts by id are its entry's on the owner's table (harness-table.ts factsOf), so a module's adapter harness
// is offered, keyed and gated as a built-in one is, from its own facts. The built-in harnesses read exactly as before: the
// same facts objects, and the same offers, key rows, default models, search and tool names whether a module is loaded
// or not. A test table's stand-in keeps the facts of the harness it stands in for.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
import { scratch } from "./support.mjs";

const [table, model, modelForm, toolPlane, toolGate, harness, adapterFacts, { facts: openCodeFacts }] = await Promise.all([
  import("../dist/harness-table.js"), import("../dist/model.js"), import("../dist/model-form.js"), import("../dist/tool-plane.js"),
  import("../dist/tool-gate.js"), import("../dist/harness.js"), import("../dist/adapter-facts.js"), import("../dist/harness-opencode/facts.js"),
]);
const { factsOf, HARNESS_MODULES_ENV, HARNESS_TABLE_ENV, harnessIds, harnessOf } = table;

/** A module adding the adapter harness `id` on `wire` with the kit's adapterEntry: an adapter that passes its check and
 *  runs nothing, a native tool of its own named to bash's setting, and no search of its own. */
function acmeModule(dir, { id = "acme", wire = "anthropic-messages" } = {}) {
  const path = join(dir, `${id}-module.mjs`);
  writeFileSync(path, `export const entries = (_builtins, kit) => ({ ${JSON.stringify(id)}: kit.adapterEntry({
  id: ${JSON.stringify(id)}, label: "Acme", wire: ${JSON.stringify(wire)}, steer: false, rerunsStarted: false, recoversCutAnswers: 0,
  runMib: 64, thinking: ["high"], ownModel: false,
  install: { npmLine: "acme install", spec: "acme@1.0.0", codes: { install: "ACME_MISSING", pins: "ACME_PINS" } },
  nativeTools: { acme_shell: "bash" },
  policy: () => ({ route: () => undefined }),
}, (launch) => ({ id: ${JSON.stringify(id)}, check: () => [], open: async () => { throw new Error("acme opens no session here: " + launch.model); } })) });\n`);
  return path;
}

/** The environments a built-in harness's offers are compared on: no key, each vendor's key, OpenRouter's alone, all of
 *  them, and a gateway. Each with its own data directory, so no install is shared. */
async function environments(t) {
  const shapes = [
    {},
    { ANTHROPIC_API_KEY: "sk-ant-placeholder-0000" },
    { OPENAI_API_KEY: "sk-openai-placeholder-0000" },
    { OPENROUTER_API_KEY: "sk-or-placeholder-0000" },
    { ANTHROPIC_API_KEY: "sk-ant-placeholder-0000", OPENAI_API_KEY: "sk-openai-placeholder-0000", OPENROUTER_API_KEY: "sk-or-placeholder-0000" },
    { AGENT_MODEL_BASE_URL: "https://gateway.example.com/v1", AGENT_MODEL: "gateway-model", AGENT_MODEL_API_KEY: "gw-placeholder-0000" },
  ];
  return Promise.all(shapes.map(async (shape) => ({ AGENTRUN_SERVE_DATA: await scratch(t), ...shape })));
}

/** What a built-in harness reads off its facts on `env`: its picker's models, its free models, the key rows that name
 *  it, its default model, its web search, and its tool names. */
async function builtinReads(env) {
  const out = {};
  for (const id of harness.HARNESSES) {
    out[id] = {
      picker: modelForm.pickerCandidates(env, id),
      free: await modelForm.freeCandidates(env, id),
      rows: model.MODEL_KEYS.filter((row) => model.keyHarnesses(row, env).includes(id)).map((row) => row.id),
      host: model.hostModel(env, "default", id) ?? null,
      shape: modelForm.modelShape(env, id),
      search: ["native", "auto"].map((provider) => toolPlane.planeFor(env, { harness: id, tools: ["web_search"] }, { web_search: { provider } }).web_search ?? null),
      names: [...toolGate.nameMapOf(id, factsOf(env, id))].sort(),
    };
  }
  return out;
}

test("guard: each built-in harness's facts by id are the same objects its package states, with or without a harness module, and a test table's stand-in keeps them", async (t) => {
  const dir = await scratch(t);
  const fixed = { "claude-agent": claudeFacts, codex: codexFacts, opencode: openCodeFacts, ...(adapterFacts.GOOSE_FACTS ? { goose: adapterFacts.GOOSE_FACTS } : {}) };
  assert.deepEqual([...adapterFacts.ADAPTER_FACTS], [claudeFacts, codexFacts, openCodeFacts]);
  const stand = join(dir, "stand-in.mjs");
  writeFileSync(stand, "export const entries = () => ({ codex: { facts: { id: 'codex', label: 'Not codex', wire: 'anthropic-messages' } } });\n");
  const modules = { [HARNESS_MODULES_ENV]: JSON.stringify([acmeModule(dir)]) };
  for (const env of [{}, modules, { ...modules, NODE_TEST_CONTEXT: "child-v8", [HARNESS_TABLE_ENV]: stand }]) {
    assert.equal(factsOf(env, "pi"), undefined, "pi has no adapter");
    assert.equal(factsOf(env, undefined), undefined, "nor the default, which is pi");
    for (const [id, facts] of Object.entries(fixed)) assert.equal(factsOf(env, id), facts, `${id} on ${JSON.stringify(Object.keys(env))}`);
  }
  assert.equal(harnessOf({ ...modules, NODE_TEST_CONTEXT: "child-v8", [HARNESS_TABLE_ENV]: stand }, "codex").facts.label, "Not codex", "the test table's entry is in the table");
  assert.equal(factsOf({}, "acme"), undefined, "a module's harness is read only where its module is loaded");
  assert.equal(factsOf(modules, "acme").label, "Acme");
});

test("guard: a harness module changes nothing a built-in harness is offered: its models, free models, key rows, default model, model words, search and tool names", async (t) => {
  const dir = await scratch(t);
  const path = acmeModule(dir);
  for (const env of await environments(t)) {
    const plain = await builtinReads(env);
    const withModule = await builtinReads({ ...env, [HARNESS_MODULES_ENV]: JSON.stringify([path]) });
    assert.deepEqual(withModule, plain, JSON.stringify(Object.keys(env)));
  }
});

test("guard: the built-in harnesses' offers in capabilities are the same with a harness module loaded, and the module's harness is offered after them", async (t) => {
  const dir = await scratch(t);
  const path = acmeModule(dir);
  for (const env of await environments(t)) {
    const plain = await harness.harnessOffers(env);
    const loaded = await harness.harnessOffers({ ...env, [HARNESS_MODULES_ENV]: JSON.stringify([path]) });
    assert.deepEqual(loaded.slice(0, plain.length), plain, JSON.stringify(Object.keys(env)));
    assert.deepEqual(loaded.slice(plain.length).map((offer) => offer.id), ["acme"]);
  }
});

test("a module's adapter harness is offered its wire's vendor's models only, named on that vendor's key row and OpenRouter's, and defaults to the row's model for its vendor", async (t) => {
  const dir = await scratch(t);
  const anthropic = { [HARNESS_MODULES_ENV]: JSON.stringify([acmeModule(dir)]) };
  const openai = { [HARNESS_MODULES_ENV]: JSON.stringify([acmeModule(dir, { id: "acme-oai", wire: "openai-responses" })]) };
  const keys = { ANTHROPIC_API_KEY: "sk-ant-placeholder-0000", OPENAI_API_KEY: "sk-openai-placeholder-0000", OPENROUTER_API_KEY: "sk-or-placeholder-0000" };
  assert.deepEqual([...harnessIds(anthropic)].slice(-1), ["acme"]);

  const onAnthropic = modelForm.pickerCandidates({ ...anthropic, ...keys }, "acme");
  assert.ok(onAnthropic.length > 0 && onAnthropic.every((id) => id.startsWith("anthropic/")), onAnthropic.join(", "));
  const onOpenAI = modelForm.pickerCandidates({ ...openai, ...keys }, "acme-oai");
  assert.ok(onOpenAI.length > 0 && onOpenAI.every((id) => id.startsWith("openai/")), onOpenAI.join(", "));
  assert.deepEqual(await modelForm.freeCandidates({ ...anthropic, ...keys }, "acme"), [], "an adapter harness runs its wire's vendor's models, never pi's free ones");

  const rowsOf = (env, id) => model.MODEL_KEYS.filter((row) => model.keyHarnesses(row, env).includes(id)).map((row) => row.id);
  assert.deepEqual(rowsOf(anthropic, "acme"), ["anthropic", "openrouter"]);
  assert.deepEqual(rowsOf(openai, "acme-oai"), ["openai", "openrouter"]);

  const routerOnly = { ...anthropic, OPENROUTER_API_KEY: keys.OPENROUTER_API_KEY };
  assert.equal(model.hostModel(routerOnly, "default", "acme"), model.hostModel(routerOnly, "default", "claude-agent"), "on OpenRouter's key alone, its vendor's default there, as claude-agent's");
  assert.notEqual(model.hostModel(routerOnly, "default", "acme"), model.hostModel(routerOnly, "default", "pi"), "not pi's, which is OpenAI's");
  assert.match(modelForm.modelShape({ ...anthropic, ANTHROPIC_API_KEY: keys.ANTHROPIC_API_KEY }, "acme"), /like anthropic\//);
});

test("a module's adapter harness is gated and searched by its own facts: its native tool is held to the setting it names, and it has no native search of its own", async (t) => {
  const dir = await scratch(t);
  const env = { [HARNESS_MODULES_ENV]: JSON.stringify([acmeModule(dir)]), ANTHROPIC_API_KEY: "sk-ant-placeholder-0000" };
  assert.equal(toolGate.settingsKeyOf("acme", "acme_shell", toolGate.nameMapOf("acme", factsOf(env, "acme"))), "bash");
  const plane = toolPlane.planeFor(env, { harness: "acme", tools: ["web_search"], model: "anthropic/claude-sonnet-5-5" }, { web_search: { provider: "native" } });
  assert.match(plane.web_search, /^unavailable: no native search for acme, whose model requests carry no provider-hosted tool/, "read off its own facts, not pi's hosted search");
  const pi = toolPlane.planeFor(env, { tools: ["web_search"], model: "anthropic/claude-sonnet-5-5" }, { web_search: { provider: "native" } });
  assert.equal(pi.web_search, "native", "pi on the same model has Anthropic's hosted search");
});
