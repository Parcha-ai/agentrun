// The adapter states its facts, and serve never branches on a harness's name: one table from a harness id to its entry
// (harness-table.ts), each adapter's facts (its wire, steer, memory, thinking, search, model, install, tool alias, MCP
// client and proxy policy), one providerFor by wire. A test's stand-in is a table entry (HARNESS_TABLE_ENV), never a
// branch in serve. Each module is imported by name inside its test, so a build without it fails each test on its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
/** Every .ts file under serve/src, as a path relative to it. */
const sources = (dir = SRC, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name), `${prefix}${entry.name}/`) : entry.name.endsWith(".ts") ? [`${prefix}${entry.name}`] : []));
/** Transcript formats name the tools they import from, not the harness that runs (import.ts, import-sources.ts); the
 *  table is where an id meets its entry. */
const EXCLUDED = new Set(["import.ts", "import-sources.ts", "harness-table.ts"]);
const NAMES = "pi|claude-agent|codex|opencode";
const BRANCH = new RegExp(`(===|!==)\\s*"(${NAMES})"|"(${NAMES})"\\s*(===|!==)|\\bcase\\s+"(${NAMES})"|(===|!==)\\s*DEFAULT_HARNESS\\b|\\bDEFAULT_HARNESS\\s*(===|!==)`);

test("serve/src outside the harness table compares no harness name: no ===/!== against pi, claude-agent, codex or opencode, no case on one, and no comparison with DEFAULT_HARNESS", () => {
  const hits = sources()
    .filter((file) => !EXCLUDED.has(file))
    .flatMap((file) => readFileSync(join(SRC, file), "utf8").split("\n").flatMap((line, index) => (BRANCH.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 140)}`] : [])));
  assert.deepEqual(hits, [], `harness-name branches:\n${hits.join("\n")}`);
});

test("production code never builds a stand-in harness: serve/src imports no @parcha/agentrun-kernel/testing and names no faux harness", () => {
  const hits = sources().flatMap((file) => readFileSync(join(SRC, file), "utf8").split("\n").flatMap((line, index) => (/agentrun-kernel\/testing|fauxAdapter|FauxOptions|FAUX_HARNESS/.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 140)}`] : [])));
  assert.deepEqual(hits, [], hits.join("\n"));
});

test("each adapter package exports its facts, and the table's entry for each id reads them: wire, steer, memory, thinking, search, own model, MCP client, tool alias", async () => {
  const [{ facts: claude }, { facts: codex }, { facts: opencode }, { builtinHarness }] = await Promise.all([import("@parcha/agentrun-harness-claude/facts"), import("@parcha/agentrun-harness-codex/facts"), import("../dist/harness-opencode/facts.js"), import("../dist/harness-table.js")]);
  const shape = (f) => ({ id: f.id, wire: f.wire, steer: f.steer, runMib: f.runMib, thinking: [...f.thinking], webSearch: f.webSearch, ownModel: f.ownModel, mcp: f.mcp, alias: Boolean(f.toolAlias), schema: typeof f.schemaProblems });
  assert.deepEqual(shape(claude), { id: "claude-agent", wire: "anthropic-messages", steer: false, runMib: 288, thinking: ["low", "medium", "high", "xhigh", "max"], webSearch: "native", ownModel: true, mcp: true, alias: false, schema: "function" });
  assert.deepEqual(shape(codex), { id: "codex", wire: "openai-responses", steer: false, runMib: 192, thinking: ["low", "medium", "high", "xhigh"], webSearch: "live", ownModel: false, mcp: true, alias: false, schema: "function" });
  assert.deepEqual(shape(opencode), { id: "opencode", wire: "openai-responses", steer: false, runMib: 704, thinking: ["low", "medium", "high", "xhigh"], webSearch: undefined, ownModel: false, mcp: false, alias: true, schema: "undefined" });
  for (const facts of [claude, codex, opencode]) {
    const entry = builtinHarness(facts.id);
    assert.equal(entry.facts, facts, `${facts.id}'s entry holds its package's facts`);
    assert.deepEqual([entry.steer, entry.runMib, entry.mcp], [facts.steer, facts.runMib, facts.mcp], facts.id);
    assert.ok(Object.isFrozen(facts), `${facts.id}'s facts are frozen`);
  }
  // pi has no adapter: it takes a message mid-turn, and one of its runs always fits.
  const pi = builtinHarness("pi");
  assert.deepEqual([pi.facts, pi.steer, pi.runMib, pi.oneAlwaysFits, pi.mcp], [undefined, true, 128, true, true]);
});

test("facts decide, not names: thinking clamps at a harness's highest level, native options follow its search, the tool alias is OpenCode's alone, memory follows runMib", async () => {
  const [{ nativeOptions, thinkingFor }, { builtinHarness }, { settingsKeyOf }, { runMibOf, runsThatFit, SERVER_MIB }] = await Promise.all([import("../dist/adapters.js"), import("../dist/harness-table.js"), import("../dist/tool-gate.js"), import("../dist/host.js")]);
  const facts = (id) => builtinHarness(id).facts;
  assert.deepEqual(["claude-agent", "codex", "opencode"].map((id) => thinkingFor(facts(id), "max")), ["max", "xhigh", "xhigh"], "max runs at each harness's highest");
  assert.deepEqual(["claude-agent", "codex", "opencode"].map((id) => thinkingFor(facts(id), "low")), ["low", "low", "low"], "a level a harness takes is kept");
  const native = { AGENTRUN_SERVE_TOOL_PLANE: JSON.stringify({ web_search: "native" }) };
  assert.deepEqual(["claude-agent", "codex", "opencode"].map((id) => nativeOptions(facts(id), native)), [{ webSearch: true, webSearchAllowance: 200_000 }, { webSearch: "live" }, {}]);
  assert.deepEqual(["claude-agent", "codex", "opencode"].map((id) => settingsKeyOf(id, "srv_lookup", ["srv"])), [undefined, undefined, "mcp:srv/lookup"], "only a harness whose facts name an alias maps `<server>_<tool>`");
  assert.deepEqual(["pi", "claude-agent", "codex", "opencode"].map(runMibOf), [128, 288, 192, 704]);
  const tiny = (SERVER_MIB + 100) * 2 ** 20;
  assert.deepEqual(["pi", "codex"].map((id) => runsThatFit(id, tiny)), [1, 0], "one pi run always fits (its entry's oneAlwaysFits); no codex run does");
});

test("providerFor goes by the wire: opencode and codex, both on the Responses API, take one route, key and model; claude-agent's wire never takes the gateway", async () => {
  const [{ providerFor }, { runKeyOf }] = await Promise.all([import("../dist/provider.js"), import("../dist/key-refusal.js")]);
  const view = (p) => ({ origin: p.origin, auth: p.auth, modelId: p.modelId, priceModel: p.priceModel, key: p.credential() });
  const openai = { provider: "openai", modelId: "gpt-6-sol" };
  for (const env of [{ OPENAI_API_KEY: `not-a-secret-${"o"}` }, { OPENROUTER_API_KEY: `not-a-secret-${"r"}` }, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000/v1", AGENT_MODEL_API_KEY: `not-a-secret-${"g"}` }]) {
    assert.deepEqual(view(providerFor("openai-responses", env, openai, "opencode")), view(providerFor("openai-responses", env, openai, "codex")), JSON.stringify(Object.keys(env)));
    assert.deepEqual(runKeyOf(env, "opencode", "openai/gpt-6-sol"), runKeyOf(env, "codex", "openai/gpt-6-sol"), JSON.stringify(Object.keys(env)));
  }
  const both = { ANTHROPIC_API_KEY: `not-a-secret-${"a"}`, AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000", AGENT_MODEL_API_KEY: `not-a-secret-${"g"}` };
  assert.equal(providerFor("anthropic-messages", both, { provider: "anthropic", modelId: "claude-sonnet-5.5" }, "claude-agent").origin, "https://api.anthropic.com", "the gateway serves the Responses wire alone");
  assert.equal(runKeyOf(both, "claude-agent", "anthropic/claude-sonnet-5-5").field, "ANTHROPIC_API_KEY");
  assert.equal(runKeyOf(both, "codex", "openai/gpt-6-sol").field, "AGENT_MODEL_API_KEY");
});

test("a test's table module (HARNESS_TABLE_ENV) merges its entries over the built-ins by id, and the server's own environment never names one", async (t) => {
  const [{ HARNESS_TABLE_ENV, harnessOf, harnessTable }, { harnessRuns, withoutFaux }] = await Promise.all([import("../dist/harness-table.js"), import("../dist/model.js")]);
  assert.equal(HARNESS_TABLE_ENV, "AGENTRUN_HARNESS_TABLE");
  const dir = await scratch(t);
  const module = join(dir, "table.mjs");
  writeFileSync(module, "export const entries = (builtins) => ({ codex: { runs: () => false, refusal: async () => ({ reason: `stood in for ${builtins.codex.facts.label}` }) } });\n");
  const env = { [HARNESS_TABLE_ENV]: module };
  assert.equal(harnessRuns(env, "openai/gpt-6-sol", "codex"), false, "the module's entry decides");
  assert.equal(harnessRuns({}, "openai/gpt-6-sol", "codex"), true, "the built-in one, without it");
  assert.deepEqual(await harnessOf(env, "codex").refusal(env, undefined, { atStart: false }), { reason: "stood in for Codex" });
  assert.equal(harnessOf(env, "codex").facts, harnessOf({}, "codex").facts, "an entry merged over keeps the facts it does not name");
  assert.equal(harnessOf(env, "claude-agent"), harnessOf({}, "claude-agent"), "an id the module names not is the built-in entry");
  assert.equal(harnessTable(env), harnessTable({ ...env }), "loaded once per module");
  const missing = join(dir, "none.mjs");
  writeFileSync(missing, "export const script = () => [];\n");
  assert.throws(() => harnessTable({ [HARNESS_TABLE_ENV]: missing }), /exports no entries\(builtins\)/);
  assert.deepEqual(Object.keys(withoutFaux({ [HARNESS_TABLE_ENV]: module, KEEP: "1" })), ["KEEP"], "an operator's environment never loads a table module");
});

test("outside a test runner (no NODE_TEST_CONTEXT in the environment it is given), AGENTRUN_HARNESS_TABLE loads nothing: the table is the built-in one, whatever module it names", async (t) => {
  const { HARNESS_TABLE_ENV, harnessTable, builtinHarness } = await import("../dist/harness-table.js");
  const dir = await scratch(t);
  const module = join(dir, "table.mjs");
  const marker = join(dir, "loaded");
  writeFileSync(module, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\nexport const entries = () => ({ codex: { runs: () => false } });\n`);
  const table = harnessTable({ [HARNESS_TABLE_ENV]: module });
  assert.equal(table.codex, builtinHarness("codex"), "the built-in codex entry");
  assert.equal(existsSync(marker), false, "the module was never loaded");
  assert.notEqual(harnessTable({ [HARNESS_TABLE_ENV]: module, NODE_TEST_CONTEXT: "child-v8" }).codex, builtinHarness("codex"), "under a test runner it is merged");
});

test("pi's gateway takes the one base rule (provider.ts gatewayBase): a base its key could leave this machine for in the clear, or that reads other than it points, is refused by name before any request", async () => {
  const { runModels } = await import("../dist/model.js");
  for (const base of ["http://gateway.example/v1", "https://user@gateway.example", "https://gateway.example/a/../b", "https://gateway.example/?x=1"]) {
    await assert.rejects(runModels({ AGENT_MODEL_BASE_URL: base, AGENT_MODEL: "team/model", AGENT_MODEL_API_KEY: `not-a-secret-${"g"}`, AGENT_MODEL_PRICE: "1,1" }, undefined), /AGENT_MODEL_BASE_URL must be an https URL of a gateway/, base);
  }
  const ok = await runModels({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000/api/v1", AGENT_MODEL: "team/model", AGENT_MODEL_API_KEY: `not-a-secret-${"g"}`, AGENT_MODEL_PRICE: "1,1" }, undefined);
  assert.equal(ok.models.getModel(ok.model.provider, ok.model.modelId).baseUrl, "http://127.0.0.1:4000/api/v1", "one trailing /v1 off, then the API under <base>/v1");
});

test("the one base rule finds a dot segment however the slashes after the scheme are written: the URL parser reads each of these as the named host, so the path is read after the scheme and the host, never after the first // in the text", async () => {
  const { gatewayBase } = await import("../dist/provider.js");
  for (const value of ["https:/gw.example//../x", "https:gw.example/../x", "https:///gw.example/a/../b", "https://gw.example//%2e%2e/x"]) {
    assert.equal(new URL(value).hostname, "gw.example", `the URL parser names the host: ${value}`);
    assert.throws(() => gatewayBase("AGENT_MODEL_BASE_URL", value), /has a \. or \.\. path segment/, value);
  }
  assert.equal(gatewayBase("AGENT_MODEL_BASE_URL", "https://gw.example/api/v1"), "https://gw.example/api", "a plain base is as before");
});

test("each module of the provider, model and table cycle loads first in a fresh process: the table's built-in entries never read a wire's settings before they exist", () => {
  // A child of a test runner that inherits NODE_TEST_CONTEXT runs as that runner's child; this one is a plain process.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const name of ["provider.js", "model.js", "harness-table.js"]) {
    const url = new URL(`../dist/${name}`, import.meta.url).href;
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(loaded.status, 0, `dist/${name} imported first exits 0: ${loaded.stderr}`);
    assert.doesNotMatch(loaded.stderr, /ReferenceError/, `dist/${name} imported first throws no ReferenceError`);
  }
});
