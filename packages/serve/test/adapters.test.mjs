// Where a codex run's model requests go, and why they cannot: OpenAI with its key, or a gateway at its origin; any
// other provider, a missing key, or a gateway under a path the proxy cannot reach is a reason capabilities shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeModel, claudeModelId, claudeOf, claudeProvider, codexOf, codexProvider, HarnessUnavailable, priceOf, startedByNpx, startReason } from "../dist/adapters.js";
import { linkHarnesses } from "./support.mjs";
import * as adapters from "../dist/adapters.js";
import * as files from "../dist/files.js";
import { HARNESS_INSTALLS, installLine } from "../dist/harness-install.js";
const CLAUDE_LOCK = HARNESS_INSTALLS["claude-agent"].lock;
import { fileURLToPath } from "node:url";

const openai = { provider: "openai", modelId: "gpt-5.4-mini" };
const refused = (pattern) => (error) => error instanceof HarnessUnavailable && pattern.test(error.message);

test("codex's provider: OpenAI with its key; a gateway at its base, also given as base/v1; and why not otherwise", () => {
  const direct = codexProvider({ OPENAI_API_KEY: "k-1" }, openai);
  assert.deepEqual([direct.origin, direct.credential()], ["https://api.openai.com", "k-1"]);
  for (const base of ["http://127.0.0.1:4000", "http://127.0.0.1:4000/", "http://127.0.0.1:4000/v1"]) {
    const gateway = codexProvider({ AGENT_MODEL_BASE_URL: base, AGENT_MODEL_API_KEY: "gw" }, { provider: "agent-model", modelId: "x" });
    assert.deepEqual([gateway.origin, gateway.credential()], ["http://127.0.0.1:4000", "gw"], base);
  }
  assert.equal(codexProvider({ AGENT_MODEL_BASE_URL: "https://host.example/proxy/v1" }, openai).origin, "https://host.example/proxy", "a gateway under a path keeps it");
  assert.throws(() => codexProvider({}, openai), refused(/OPENAI_API_KEY/));
  assert.throws(() => codexProvider({ ANTHROPIC_API_KEY: "a" }, { provider: "anthropic", modelId: "claude-x" }), refused(/codex runs OpenAI models/));
});

test("codex's price is the catalog's per million tokens, cached input at its own rate; a model with no price is unknown", () => {
  const models = { getModel: (_p, id) => (id === "priced" ? { cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } } : undefined) };
  assert.equal(priceOf({ model: { provider: "openai", modelId: "priced" }, models })("priced", { input: 1000, output: 100, cacheRead: 2000 }), (1000 * 1 + 100 * 2 + 2000 * 0.5) / 1e6);
  assert.equal(priceOf({ model: { provider: "openai", modelId: "unpriced" }, models })("unpriced", { input: 1, output: 1 }), null);
});

test("claude-agent's provider: Anthropic Messages only, at ANTHROPIC_BASE_URL's base or api.anthropic.com, with its key; serve's gateway neither disables it nor ever receives its requests", () => {
  const anthropic = { provider: "anthropic", modelId: "claude-haiku-4-5" };
  const key = `not-a-secret-${"a"}`;
  const direct = claudeProvider({ ANTHROPIC_API_KEY: key }, anthropic);
  assert.deepEqual([direct.origin, direct.credential()], ["https://api.anthropic.com", key]);
  assert.equal(claudeProvider({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "http://127.0.0.1:5000/" }, anthropic).origin, "http://127.0.0.1:5000");
  // The other harnesses' gateway beside it: Claude still runs, at its own endpoint, never the gateway's.
  for (const [own, origin] of [[{}, "https://api.anthropic.com"], [{ ANTHROPIC_BASE_URL: "http://127.0.0.1:5000" }, "http://127.0.0.1:5000"]]) {
    const beside = claudeProvider({ ANTHROPIC_API_KEY: key, AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000", AGENT_MODEL_API_KEY: "gw", ...own }, anthropic);
    assert.deepEqual([beside.origin, beside.credential()], [origin, key]);
  }
  assert.equal(claudeProvider({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "https://host.example/api" }, anthropic).origin, "https://host.example/api", "an endpoint under a path keeps it");
  assert.throws(() => claudeProvider({}, anthropic), refused(/ANTHROPIC_API_KEY/));
  assert.throws(() => claudeProvider({ ANTHROPIC_API_KEY: key }, { provider: "openai", modelId: "gpt-5.4-mini" }), refused(/claude-agent runs Anthropic models/));
});

test("the model id codex is given is the one model.ts chose: OpenAI's own id direct, the gateway's whole name through a gateway", async (t) => {
  const { chooseModel } = await import("../dist/model.js");
  // pi-ai's providers look for their key in the environment.
  const saved = process.env.OPENAI_API_KEY;
  t.after(() => (saved === undefined ? delete process.env.OPENAI_API_KEY : (process.env.OPENAI_API_KEY = saved)));
  process.env.OPENAI_API_KEY = `not-a-secret-${"direct"}`;
  const key = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  assert.deepEqual((await chooseModel(key, "openai/gpt-4o")).model, { provider: "openai", modelId: "gpt-4o" }, "direct: OpenAI's id, the provider already taken out");
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1" };
  assert.equal((await chooseModel(gateway, "openai/gpt-4o")).model.modelId, "openai/gpt-4o", "through a gateway: its name, whole");
  assert.equal((await chooseModel({ ...gateway, AGENT_MODEL_GATEWAY_IDS: "bare" }, "openai/gpt-4o")).model.modelId, "gpt-4o", "unless the gateway takes bare ids");
});

test("the model id claude-agent sends and prices is Anthropic's own: dots as dashes, as a gateway such as OpenRouter names its models with dots", () => {
  assert.equal(claudeModelId({ provider: "anthropic", modelId: "claude-sonnet-5.5" }), "claude-sonnet-5-5", "OpenRouter's name, as Anthropic's id");
  assert.equal(claudeModelId({ provider: "anthropic", modelId: "claude-sonnet-5-5" }), "claude-sonnet-5-5", "Anthropic's own id, unchanged");
  assert.equal(claudeModelId({ provider: "anthropic", modelId: "claude-haiku-4.5" }), "claude-haiku-4-5");
  assert.equal(claudeModelId({ provider: "other", modelId: "a.b" }), "a.b", "another provider's id is never rewritten");
});

test("claude-agent's model is one provider and the model's own id: the doubled anthropic/anthropic/<model> is refused, naming the form to use", () => {
  assert.deepEqual(claudeModel({}, "anthropic/claude-sonnet-5.5"), { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }, "the run's model is Anthropic's own id, for every lookup of it");
  const doubled = claudeModel({}, "anthropic/anthropic/claude-sonnet-5.5");
  assert.equal(doubled.host, false, "the revision's own model: a refusal at save, which no host setting fixes");
  assert.match(doubled.why, /name it anthropic\/claude-sonnet-5\.5\./);
  assert.equal(claudeModel({ AGENT_MODEL: "anthropic/anthropic/claude-haiku-4.5" }, undefined).host, true, "the host's default: a setting of the host");
});

test("a gateway base with a path: codex sends to <base>/v1/responses and claude-agent to <base>/v1/messages, a trailing /v1 taken once, so one OpenRouter-style base serves both", () => {
  const anthropic = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  const key = `not-a-secret-${"k"}`;
  // What each base gives: the base the proxy appends the route's /v1/... to.
  for (const [base, joined] of [
    ["https://gw.example", "https://gw.example"],
    ["https://gw.example/v1", "https://gw.example"],
    ["https://gw.example/api", "https://gw.example/api"],
    ["https://gw.example/api/v1", "https://gw.example/api"],
    ["https://gw.example/api/v1/", "https://gw.example/api"],
  ]) {
    assert.equal(codexProvider({ AGENT_MODEL_BASE_URL: base, AGENT_MODEL_API_KEY: key }, { provider: "agent-model", modelId: "x" }).origin, joined, `codex, ${base}`);
    assert.equal(claudeProvider({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: base }, anthropic).origin, joined, `claude-agent, ${base}`);
  }
});

test("a gateway base that could send a key somewhere else than it reads is refused before any request, naming its setting", () => {
  const anthropic = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  const key = `not-a-secret-${"k"}`;
  for (const base of [
    // A base naming a user, built in two parts so the source holds no URL with a credential in it.
    "https://user" + ":pw@gw.example/api",
    "https://gw.example/api?route=x",
    "https://gw.example/api#frag",
    "https://gw.example/api/../other",
    "https://gw.example/./api",
    "https://gw.example/api/%2e%2e/other",
    "https://gw.example/%2E/api",
    // A backslash is a path separator to the URL parser, so dot segments between backslashes resolve too.
    "https://gw.example/api\\..\\other",
    "https://gw.example/api\\%2e%2e\\other",
    "http://gw.example/api",
    "https://gw.example/ api",
    " https://gw.example/api",
    "not a url",
  ]) {
    assert.throws(() => codexProvider({ AGENT_MODEL_BASE_URL: base, AGENT_MODEL_API_KEY: key }, { provider: "agent-model", modelId: "x" }), refused(/AGENT_MODEL_BASE_URL/), `codex, ${base}`);
    assert.throws(() => claudeProvider({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: base }, anthropic), refused(/ANTHROPIC_BASE_URL/), `claude-agent, ${base}`);
  }
  // A loopback gateway may be plain http (a local server, or a test's).
  assert.equal(codexProvider({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000/api/v1" }, { provider: "agent-model", modelId: "x" }).origin, "http://127.0.0.1:4000/api");
  assert.equal(claudeProvider({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "http://localhost:5000" }, anthropic).origin, "http://localhost:5000");
});

/** An installed SDK as claudeOf loads it (harness-install.ts loadSdk): a test's, which no adapter here runs. */
const loadedSdk = async (version) => ({ sdk: { query() {} }, sdkVersion: version, cliPath: "/nowhere/claude", mcp: { server: {}, types: {} } });

test("claude-agent with Claude Code not installed in the data, and no key: the reason is the install, with the command that installs it into the data's harnesses, never the key a person would set first", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "agentrun-adapters-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const needs = { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, models: { getModel: () => undefined } };
  await assert.rejects(claudeOf({ AGENTRUN_SERVE_DATA: data }, needs), (error) => {
    assert.ok(error instanceof HarnessUnavailable, String(error));
    assert.match(error.message, /not installed/);
    assert.ok(error.message.includes(installLine(join(data, "harnesses", "claude-agent"), CLAUDE_LOCK)), error.message);
    // The locked install, exactly: npm ci in a fresh directory with no script, then that put in place of the harnesses.
    const [dir, shipped] = [join(data, "harnesses", "claude-agent"), fileURLToPath(new URL("../harnesses/claude-agent/", import.meta.url))];
    assert.equal(installLine(dir, CLAUDE_LOCK), `rm -rf ${dir}.new && mkdir -p ${dir}.new && cp ${join(shipped, "package.json")} ${join(shipped, "package-lock.json")} ${dir}.new/ && npm ci --prefix ${dir}.new --ignore-scripts --include=optional && (chmod -R u+w ${dir} 2>/dev/null || true) && rm -rf ${dir} && mv ${dir}.new ${dir}`);
    assert.doesNotMatch(error.message, /ANTHROPIC_API_KEY/);
    return true;
  });
  // With the SDK in place, a missing key is still said.
  const real = await import("@parcha/agentrun-harness-claude");
  const load = async () => ({ ...real, claudeAgentAdapter: () => ({ id: "claude-agent" }) });
  await assert.rejects(claudeOf({}, needs, load, loadedSdk), refused(/claude-agent needs ANTHROPIC_API_KEY/));
});

test("claude-agent's adapter is handed the SDK, its CLI and the MCP library as the install loaded them, and the adapter's own install line is the data's", async () => {
  const real = await import("@parcha/agentrun-harness-claude");
  const given = [];
  const load = async () => ({ ...real, claudeAgentAdapter: (options) => (given.push(options), { id: "claude-agent" }) });
  const needs = { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, models: { getModel: () => undefined } };
  const env = { ANTHROPIC_API_KEY: `not-a-secret-${"k"}`, AGENTRUN_SERVE_DATA: "/d" };
  const sdk = await loadedSdk("0.3.286");
  await claudeOf(env, needs, load, async () => sdk);
  assert.deepEqual([given[0].sdk, given[0].sdkVersion, given[0].cliPath, given[0].mcp], [sdk.sdk, "0.3.286", "/nowhere/claude", sdk.mcp]);
  // The adapter's refusal names a project's install line; serve's names the data's harnesses directory instead.
  const unpinned = async () => ({ ...real, claudeAgentAdapter: () => { throw new real.ClaudeAgentPinMismatch("cli_version", real.CLAUDE_AGENT_CLI_VERSION, "0.0.1", "/nowhere/claude"); } });
  const pinned = async () => ({ ...real, claudeAgentAdapter: () => { throw new real.ClaudeAgentNotInstalled("no CLI here", real.CLAUDE_AGENT_SDK_INSTALL); } });
  for (const broken of [unpinned, pinned]) {
    await assert.rejects(claudeOf(env, needs, broken, async () => sdk), (error) => {
      assert.ok(error instanceof HarnessUnavailable, String(error));
      assert.ok(error.message.includes(installLine("/d/harnesses/claude-agent", CLAUDE_LOCK)), error.message);
      assert.ok(!error.message.includes(real.CLAUDE_AGENT_SDK_INSTALL), error.message);
      return true;
    });
  }
});

test("claude-agent's native skills reach the adapter as serve gives them, and an adapter with none is given no skills option", async () => {
  const real = await import("@parcha/agentrun-harness-claude");
  const given = [];
  const load = async () => ({ ...real, claudeAgentAdapter: (options) => (given.push(options), { id: "claude-agent" }) });
  const needs = { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, models: { getModel: () => undefined } };
  const env = { ANTHROPIC_API_KEY: `not-a-secret-${"k"}` };
  const skills = [{ name: "cite", files: { "SKILL.md": "---\nname: cite\ndescription: Cite sources.\n---\nCite.\n", "reference/sources.md": "Primary first.\n" } }];
  await claudeOf(env, { ...needs, skills }, load, loadedSdk);
  await claudeOf(env, { ...needs, skills: [] }, load, loadedSdk);
  await claudeOf(env, needs, load, loadedSdk);
  assert.deepEqual(given[0].skills, skills, "the skills, as given");
  assert.deepEqual(given.slice(1).map((options) => "skills" in options), [false, false], "none: no option, so the adapter keeps its Skill tool off");
});

test("claude-agent's check of skills is the installed adapter's own skillProblems; none where the package is not installed", async () => {
  const { claudeSkillCheck } = await import("../dist/adapters.js");
  const real = await import("@parcha/agentrun-harness-claude");
  assert.equal(await claudeSkillCheck(async () => real), real.skillProblems, "the adapter's own function, not a copy");
  assert.equal(await claudeSkillCheck(), real.skillProblems, "by default, the package installed beside serve");
  assert.equal(await claudeSkillCheck(() => Promise.reject(new Error("Cannot find package"))), undefined, "not installed: no check, so every skill stays inlined");
  assert.equal(await claudeSkillCheck(async () => ({ ...real, skillProblems: undefined })), undefined, "an adapter with no check of its own: none");
});

const SERVE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// What a run from npx says to do about a missing harness: one command that starts this same AgentRun again with the
// harness's package beside it (OpenCode's alone: claude-agent and codex install themselves into the data). `none` stands in
// for nothing installed beside the server.
const none = () => undefined;
/** A home directory for the hints to name: any absolute path. */
const HOME_DIR = "/h/person";
const home = (more = {}) => ({ HOME: HOME_DIR, ...more });

test("codex with Codex not installed in the data, or not its pinned build: the reason names the command that installs it into the data's harnesses, never an npx or npm line beside the server", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "agentrun-adapters-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const codex = await import("@parcha/agentrun-harness-codex");
  const needs = { model: { provider: "openai", modelId: "gpt-5.4-mini" }, models: { getModel: () => undefined } };
  const line = installLine(join(data, "harnesses", "codex"), HARNESS_INSTALLS.codex.lock);
  assert.match(line, / npm ci --prefix \S+ --ignore-scripts --include=optional && /);
  const reason = (load) => codexOf({ AGENTRUN_SERVE_DATA: data, OPENAI_API_KEY: `not-a-secret-${"k"}` }, needs, load).then(() => assert.fail("refused"), (error) => (assert.ok(error instanceof HarnessUnavailable, String(error)), error.message));
  const missing = await reason(async () => codex);
  assert.match(missing, /^Codex \(@openai\/codex@0\.164\.0\) is not installed in /);
  assert.ok(missing.includes(line), missing);
  assert.doesNotMatch(missing, /npx -p|npm install /);
  // Installed, but not the pinned build: the adapter's own words, with the line that installs it into the data.
  await linkHarnesses(data);
  const unpinned = async () => ({ ...codex, verifyCodex: () => { throw new codex.CodexPinMismatch("version", codex.CODEX_VERSION, "0.0.1", "/x/codex"); } });
  const off = await reason(unpinned);
  assert.match(off, /is not the pinned build/);
  assert.ok(off.includes(line) && !off.includes(codex.CODEX_INSTALL), off);
  assert.equal(startReason(new HarnessUnavailable("codex needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL.")), "codex needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL.", "a reason a setting fixes: as it is");
});


test("demo: run from npx, a missing OpenCode says the npx line that starts this same AgentRun with it, on this server's store, keeping the other harnesses here", async () => {
  const opencode = await import("../dist/harness-opencode/index.js");
  const absent = async () => ({ ...opencode, verifyOpenCode: () => { throw new opencode.OpenCodeNotInstalled("no binary for this platform"); } });
  const needs = { model: { provider: "openai", modelId: "gpt-5.4-mini" }, models: { getModel: () => undefined } };
  const store = `${HOME_DIR}/store`;
  const reason = await adapters.opencodeOf({ AGENTRUN_SERVE_DATA: store }, needs, absent, true).then(() => assert.fail("refused"), (error) => (assert.ok(error instanceof HarnessUnavailable, String(error)), error.message));
  assert.ok(reason.endsWith(`; restart AgentRun with it: npx -p @parcha/agentrun-serve@${SERVE} -p opencode-ai@1.19.5 agentrun-serve --data ${store}`), reason);
});

test("demo: a server started by npx @parcha/agentrun hints that same command, one line for an OpenCode user: the server at its version and OpenCode beside it, on ~/.agentrun", () => {
  const sdk = "opencode-ai@1.19.5";
  const env = home({ AGENTRUN_NPX_PACKAGE: "@parcha/agentrun@0.3.0", AGENTRUN_SERVE_DATA: `${HOME_DIR}/.agentrun` });
  assert.equal(adapters.npxLine?.(sdk, env, none), `npx -p @parcha/agentrun@0.3.0 -p @parcha/agentrun-serve@${SERVE} -p ${sdk} agentrun --data ${HOME_DIR}/.agentrun`);
  // A Codex beside the server (an older install) is never kept: Codex installs itself into the data.
  assert.equal(adapters.npxLine?.(sdk, env, (name) => (name === "@openai/codex" ? "0.164.0" : undefined)), `npx -p @parcha/agentrun@0.3.0 -p @parcha/agentrun-serve@${SERVE} -p ${sdk} agentrun --data ${HOME_DIR}/.agentrun`);
  // Every version of the command gets the server pinned: 0.3.1 fetches the server on its own, and only the pin puts the
  // harness's package beside the server that runs.
  assert.equal(adapters.npxLine?.(sdk, { ...env, AGENTRUN_NPX_PACKAGE: "@parcha/agentrun@0.3.1" }, none), `npx -p @parcha/agentrun@0.3.1 -p @parcha/agentrun-serve@${SERVE} -p ${sdk} agentrun --data ${HOME_DIR}/.agentrun`);
  // Only this command's own package at a version is taken from the environment: anything else hints the server's own.
  for (const door of ["@parcha/agentrun", "@parcha/agentrun@latest; rm -rf ~", "other@1.0.0", "@parcha/agentrun-serve@1.0.0"]) {
    assert.equal(adapters.npxLine?.(sdk, { ...env, AGENTRUN_NPX_PACKAGE: door }, none), `npx -p @parcha/agentrun-serve@${SERVE} -p ${sdk} agentrun-serve --data ${HOME_DIR}/.agentrun`, door);
  }
});

// npx @parcha/agentrun keeps its data in ~/.agentrun and hands it to the server as --data; agentrun-serve's own default
// is ~/.local/share/agentrun/agents. A hint names the store whenever the command it names would not open it by default.
test("the hinted command opens the store this server has: npx @parcha/agentrun's line always names it; agentrun-serve's names any but its own default", () => {
  const sdk = "opencode-ai@1.19.5";
  const npx = (env) => adapters.npxLine?.(sdk, { AGENTRUN_NPX_PACKAGE: "@parcha/agentrun@0.3.0", ...env }, none);
  const serve = (env) => adapters.npxLine?.(sdk, env, none);
  const agentrun = `npx -p @parcha/agentrun@0.3.0 -p @parcha/agentrun-serve@${SERVE} -p ${sdk} agentrun`;
  const plain = `npx -p @parcha/agentrun-serve@${SERVE} -p ${sdk} agentrun-serve`;
  // agentrun-serve's default, which its import and reset-password share; npx @parcha/agentrun never relies on it.
  assert.equal(files.defaultData?.(home()), join(HOME_DIR, ".local", "share", "agentrun", "agents"));
  assert.equal(files.defaultData?.(home({ XDG_DATA_HOME: "/data/xdg" })), join("/data/xdg", "agentrun", "agents"));
  assert.equal(files.DATA_ENV, "AGENTRUN_SERVE_DATA");
  assert.equal(npx(home({ AGENTRUN_SERVE_DATA: `${HOME_DIR}/.agentrun` })), `${agentrun} --data ${HOME_DIR}/.agentrun`, "~/.agentrun, as an absolute path");
  assert.equal(npx(home({ AGENTRUN_SERVE_DATA: `${HOME_DIR}/.local/share/agentrun/agents` })), `${agentrun} --data ${HOME_DIR}/.local/share/agentrun/agents`, "a store given with --data, even agentrun-serve's default: without it the command would open ~/.agentrun");
  assert.equal(npx(home({ AGENTRUN_SERVE_DATA: `${HOME_DIR}/my agents/it's` })), `${agentrun} --data '${HOME_DIR}/my agents/it'\\''s'`, "quoted for the shell");
  assert.equal(npx(home({ AGENTRUN_SERVE_DATA: "relative/store" })), `${agentrun} --data ${join(process.cwd(), "relative", "store")}`, "a relative --data, made absolute, so the line opens it from any directory");
  assert.equal(npx(home()), agentrun, "a server that does not say where its store is: none named");
  assert.equal(serve(home({ AGENTRUN_SERVE_DATA: `${HOME_DIR}/.local/share/agentrun/agents` })), plain, "agentrun-serve's own default: no --data");
  assert.equal(serve(home({ AGENTRUN_SERVE_DATA: `${HOME_DIR}/.local/share/agentrun/agents/` })), plain, "the same directory, however it is written");
  assert.equal(serve(home({ XDG_DATA_HOME: "/data/xdg", AGENTRUN_SERVE_DATA: "/data/xdg/agentrun/agents" })), plain, "XDG_DATA_HOME's default");
  assert.equal(serve(home({ AGENTRUN_SERVE_DATA: `${HOME_DIR}/.agentrun` })), `${plain} --data ${HOME_DIR}/.agentrun`);
});

// A person who started AgentRun with `npx -y … --port 8123 --no-open` gets a hint that keeps those, so running it verbatim
// starts the server they had: npx's own -y (npm hands it on as npm_config_yes), the port they named, and no browser.
// The server records what it was started with (AGENTRUN_SERVE_PORT, the port when one was named; AGENTRUN_SERVE_OPEN, 1
// with --open, 0 without); a flag the person did not give is never added.
test("the hinted command keeps how AgentRun was started: npx's -y, the --port named, and --no-open; none added when not given", () => {
  const spec = "opencode-ai@1.19.5";
  const door = { AGENTRUN_NPX_PACKAGE: "@parcha/agentrun@0.3.0", AGENTRUN_SERVE_DATA: `${HOME_DIR}/.agentrun` };
  const pkgs = `-p @parcha/agentrun@0.3.0 -p @parcha/agentrun-serve@${SERVE} -p ${spec}`;
  // npx @parcha/agentrun: --open unless --no-open (its start.mjs), so the server's 0 is the person's --no-open.
  assert.equal(adapters.npxLine?.(spec, home({ ...door, npm_config_yes: "true", AGENTRUN_SERVE_PORT: "8123", AGENTRUN_SERVE_OPEN: "0" }), none), `npx -y ${pkgs} agentrun --data ${HOME_DIR}/.agentrun --port 8123 --no-open`, "all three kept");
  assert.equal(adapters.npxLine?.(spec, home({ ...door, AGENTRUN_SERVE_OPEN: "1" }), none), `npx ${pkgs} agentrun --data ${HOME_DIR}/.agentrun`, "none given: none added (the browser opens as it did)");
  assert.equal(adapters.npxLine?.(spec, home({ ...door, npm_config_yes: "false", AGENTRUN_SERVE_PORT: "7340", AGENTRUN_SERVE_OPEN: "1" }), none), `npx ${pkgs} agentrun --data ${HOME_DIR}/.agentrun --port 7340`, "-y only when npx had it; the port when it was named, its default included");
  // agentrun-serve itself: it opens no browser unless --open, which the hint then keeps.
  const plain = `npx -y -p @parcha/agentrun-serve@${SERVE} -p ${spec} agentrun-serve`;
  assert.equal(adapters.npxLine?.(spec, home({ npm_config_yes: "true", AGENTRUN_SERVE_PORT: "9000", AGENTRUN_SERVE_OPEN: "1" }), none), `${plain} --port 9000 --open`);
  assert.equal(adapters.npxLine?.(spec, home({ npm_config_yes: "true", AGENTRUN_SERVE_OPEN: "0" }), none), plain, "no --open given: none added");
  // A port that is not one is never put in a command.
  assert.equal(adapters.npxLine?.(spec, home({ ...door, AGENTRUN_SERVE_PORT: "80; rm -rf ~", AGENTRUN_SERVE_OPEN: "1" }), none), `npx ${pkgs} agentrun --data ${HOME_DIR}/.agentrun`);
});

test("the server records how it was started for its hints: the port when --port named one, and whether --open was given", async () => {
  const { startedWith } = await import("../dist/adapters.js");
  assert.deepEqual(startedWith?.({ port: "8123", open: false }), { AGENTRUN_SERVE_PORT: "8123", AGENTRUN_SERVE_OPEN: "0" });
  assert.deepEqual(startedWith?.({ open: true }), { AGENTRUN_SERVE_OPEN: "1" });
});

test("npx is told by where serve's files are: under npm's _npx cache, not a project's node_modules, and not this checkout", () => {
  assert.equal(startedByNpx("/var/cache/npm/_npx/one-run/node_modules/@parcha/agentrun-serve/dist/adapters.js"), true);
  assert.equal(startedByNpx("/work/app/node_modules/@parcha/agentrun-serve/dist/adapters.js"), false, "a project's install");
  assert.equal(startedByNpx("/work/_npx-notes/node_modules/@parcha/agentrun-serve/dist/adapters.js"), false, "a directory merely named like it");
  assert.equal(startedByNpx(), false, "this checkout's build");
});
