// Where a codex run's model requests go, and why they cannot: OpenAI with its key, or a gateway at its origin; any
// other provider, a missing key, or a gateway under a path the proxy cannot reach is a reason capabilities shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { claudeModel, claudeModelId, claudeOf, claudeProvider, codexOf, codexProvider, HarnessUnavailable, installHint, priceOf, startedByNpx } from "../dist/adapters.js";

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

test("claude-agent with no SDK and no key: the reason is the missing SDK, with its install line, never the key a person would set first", async () => {
  const real = await import("@parcha/agentrun-harness-claude");
  // The package itself is here (as in serve's image); its SDK is not: the adapter's own check, with nothing installed.
  const noSdk = async () => ({ ...real, claudeAgentAdapter: () => real.verifyClaudeAgent({}, () => undefined) });
  const needs = { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, models: { getModel: () => undefined } };
  await assert.rejects(claudeOf({}, needs, noSdk), (error) => {
    assert.ok(error instanceof HarnessUnavailable, String(error));
    assert.match(error.message, /not installed/);
    assert.match(error.message, /npm install (?:--?[A-Za-z][A-Za-z-]* )*@/, "with its install line, as the image smoke reads it");
    assert.doesNotMatch(error.message, /ANTHROPIC_API_KEY/);
    return true;
  });
  // With the SDK in place, a missing key is still said.
  const sdk = async () => ({ ...real, claudeAgentAdapter: () => ({ id: "claude-agent" }) });
  await assert.rejects(claudeOf({}, needs, sdk), refused(/claude-agent needs ANTHROPIC_API_KEY/));
});

test("claude-agent's native skills reach the adapter as serve gives them, and an adapter with none is given no skills option", async () => {
  const real = await import("@parcha/agentrun-harness-claude");
  const given = [];
  const load = async () => ({ ...real, claudeAgentAdapter: (options) => (given.push(options), { id: "claude-agent" }) });
  const needs = { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, models: { getModel: () => undefined } };
  const env = { ANTHROPIC_API_KEY: `not-a-secret-${"k"}` };
  const skills = [{ name: "cite", files: { "SKILL.md": "---\nname: cite\ndescription: Cite sources.\n---\nCite.\n", "reference/sources.md": "Primary first.\n" } }];
  await claudeOf(env, { ...needs, skills }, load);
  await claudeOf(env, { ...needs, skills: [] }, load);
  await claudeOf(env, needs, load);
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

test("demo: run from npx, a missing Claude Agent SDK says the npx line that runs this server with it; installed in a project, the npm line", async () => {
  const claude = await import("@parcha/agentrun-harness-claude");
  const sdk = `@anthropic-ai/claude-agent-sdk@${claude.CLAUDE_AGENT_SDK_VERSION}`;
  const missingSdk = new claude.ClaudeAgentNotInstalled("its CLI is not here", claude.CLAUDE_AGENT_SDK_INSTALL).message;
  assert.equal(installHint(missingSdk, claude.CLAUDE_AGENT_SDK_INSTALL, sdk, true), `Claude Agent SDK not installed: its CLI is not here; install it with: npx -p @parcha/agentrun-serve@${SERVE} -p @anthropic-ai/claude-agent-sdk@0.3.286 agentrun-serve`);
  assert.equal(installHint(missingSdk, claude.CLAUDE_AGENT_SDK_INSTALL, sdk, false), missingSdk, "in a project: npm install --save-exact, as the adapter says");
  assert.match(missingSdk, /install it with: npm install --save-exact @anthropic-ai\/claude-agent-sdk@0\.3\.286$/);
  // A message with no such line is left as it is.
  assert.equal(installHint("claude-agent needs ANTHROPIC_API_KEY", claude.CLAUDE_AGENT_SDK_INSTALL, sdk, true), "claude-agent needs ANTHROPIC_API_KEY");
  // Through serve's own check of the harness: the reason a person reads.
  const real = claude;
  const noSdk = async () => ({ ...real, claudeAgentAdapter: () => real.verifyClaudeAgent({}, () => undefined) });
  const needs = { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, models: { getModel: () => undefined } };
  await assert.rejects(claudeOf({}, needs, noSdk, true), (error) => error instanceof HarnessUnavailable && error.message.includes(`install it with: npx -p @parcha/agentrun-serve@${SERVE} -p ${sdk} agentrun-serve`) && !error.message.includes("npm install"));
});

test("demo: run from npx, a missing Codex says the npx line that runs this server with it; installed in a project, the npm line", async () => {
  const codex = await import("@parcha/agentrun-harness-codex");
  const missing = new codex.CodexNotInstalled("no binary for this platform").message;
  assert.ok(missing.endsWith(`; ${codex.CODEX_INSTALL}`), missing);
  const spec = `@openai/codex@${codex.CODEX_VERSION}`;
  assert.equal(installHint(missing, codex.CODEX_INSTALL, spec, true), missing.replace(codex.CODEX_INSTALL, `npx -p @parcha/agentrun-serve@${SERVE} -p @openai/codex@0.164.0 agentrun-serve`));
  assert.equal(installHint(missing, codex.CODEX_INSTALL, spec, false), missing, "in a project: the adapter's npm line");
  // Through serve's own check of the harness: the reason a person reads, under npx and in a project.
  const absent = async () => ({ ...codex, verifyCodex: () => { throw new codex.CodexNotInstalled("no binary for this platform"); } });
  const needs = { model: { provider: "openai", modelId: "gpt-5.4-mini" }, models: { getModel: () => undefined } };
  const reason = async (npx) => codexOf({}, needs, absent, npx).then(() => assert.fail("refused"), (error) => (assert.ok(error instanceof HarnessUnavailable, String(error)), error.message));
  assert.ok((await reason(true)).endsWith(`; npx -p @parcha/agentrun-serve@${SERVE} -p ${spec} agentrun-serve`));
  assert.ok((await reason(false)).endsWith(`; ${codex.CODEX_INSTALL}`));
  // As the start's probe says it (startReason): in a project, the restart that shows the install; under npx, the npx
  // line alone, since running it is the restart.
  const { startReason } = await import("../dist/adapters.js");
  const said = async (npx) => startReason(await codexOf({}, needs, absent, npx).then(() => assert.fail("refused"), (error) => error));
  assert.equal(await said(false), `${await reason(false)}; once it is installed, restart AgentRun to pick it up.`);
  assert.equal(await said(true), await reason(true), "under npx: the npx line, no restart clause");
  const unpinned = async () => ({ ...codex, verifyCodex: () => { throw new codex.CodexPinMismatch("version", codex.CODEX_VERSION, "0.0.1", "/x/codex"); } });
  assert.match(startReason(await codexOf({}, needs, unpinned, false).catch((error) => error)), /is not the pinned build[^]*; once the pinned build is installed, restart AgentRun\.$/);
  assert.equal(startReason(new HarnessUnavailable("codex needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL.")), "codex needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL.", "a reason a setting fixes: as it is");
});

test("npx is told by where serve's files are: under npm's _npx cache, not a project's node_modules, and not this checkout", () => {
  assert.equal(startedByNpx("/var/cache/npm/_npx/one-run/node_modules/@parcha/agentrun-serve/dist/adapters.js"), true);
  assert.equal(startedByNpx("/work/app/node_modules/@parcha/agentrun-serve/dist/adapters.js"), false, "a project's install");
  assert.equal(startedByNpx("/work/_npx-notes/node_modules/@parcha/agentrun-serve/dist/adapters.js"), false, "a directory merely named like it");
  assert.equal(startedByNpx(), false, "this checkout's build");
});
