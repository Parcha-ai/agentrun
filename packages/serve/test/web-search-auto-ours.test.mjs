// web_search's default, `auto`, is agentrun's own search on every harness: Parallel on the server's key, else keyless
// Firecrawl (keyless Exa behind it). A harness's own search (Claude's WebSearch, Codex's live search) and pi's request to
// its model provider's hosted search run only where `native` is picked, the agent's own setting or the server's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeOptions } from "../dist/adapters.js";
import { builtinHarness } from "../dist/harness-table.js";
import { explainCapability, isUnavailable, planeFor, TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { toolsView } from "../dist/tools.js";
import { builtinFacts, resolveOnBuiltin } from "./gate-support.mjs";

const base = { gateway: false, parallelKey: false };
const KEYLESS = "Firecrawl's free keyless search, no key, keyless Exa behind it";
const KEY = "your Parallel key (server)";
/** The harnesses and models that have a search of their own on a direct key: codex's, and pi's on Anthropic and OpenAI. */
const OWN = [
  { name: "codex", input: { harness: "codex" }, own: "Codex's own search" },
  { name: "pi on anthropic/claude-sonnet-5-5", input: { harness: "pi", model: "anthropic/claude-sonnet-5-5" }, own: "Anthropic's hosted search" },
  { name: "pi on openai/gpt-6.1-sol", input: { harness: "pi", model: "openai/gpt-6.1-sol" }, own: "OpenAI's hosted search" },
];
const facts = (harness) => builtinHarness(harness).facts;
const planeEnv = (plane) => ({ [TOOL_PLANE_ENV]: JSON.stringify(plane) });

test("auto resolves web_search to agentrun's own search on codex and on pi with a direct Anthropic or OpenAI model, never the harness's or the model provider's own search", () => {
  for (const { name, input, own } of OWN) {
    const keyless = explainCapability("web_search", { ...base, ...input, facts: builtinFacts(input.harness) });
    assert.deepEqual([keyless.resolves, keyless.why], ["firecrawl-keyless", `${KEYLESS}; ${own} is an explicit pick`], `${name}, auto with no Parallel key: agentrun's keyless Firecrawl, not ${own}`);
    const keyed = explainCapability("web_search", { ...base, ...input, parallelKey: true, facts: builtinFacts(input.harness) });
    assert.deepEqual([keyed.resolves, keyed.why], ["parallel", KEY], `${name}, auto with the server's Parallel key: Parallel, not ${own}`);
    assert.equal(resolveOnBuiltin("web_search", { ...base, ...input, pick: "auto" }), "firecrawl-keyless", `${name}, auto said: agentrun's own search`);
  }
  // A run's plane: what its tools read at launch. No `model` beside it, since no hosted search is asked.
  const direct = { AGENT_MODEL: "anthropic/claude-sonnet-5-5" };
  assert.deepEqual(planeFor(direct, { tools: ["web_search"] }, {}), { web_search: "firecrawl-keyless" }, "a pi run on Anthropic, auto: agentrun's keyless Firecrawl, not Anthropic's hosted search");
  assert.deepEqual(planeFor(direct, { tools: ["web_search"], model: "openai/gpt-6.1-sol" }, {}), { web_search: "firecrawl-keyless" }, "a pi run on OpenAI, auto: agentrun's keyless Firecrawl, not OpenAI's hosted search");
  assert.deepEqual(planeFor({ ...direct, PARALLEL_API_KEY: "not-a-secret" }, { tools: ["web_search"] }, {}), { web_search: "parallel" }, "a pi run on Anthropic, auto, the server's Parallel key: Parallel");
  assert.deepEqual(planeFor({ OPENAI_API_KEY: "not-a-secret" }, { harness: "codex", tools: ["web_search"] }, {}), { web_search: "firecrawl-keyless" }, "a codex run on OpenAI's key, auto: agentrun's keyless Firecrawl, not Codex's own search");
  assert.deepEqual(planeFor({ OPENAI_API_KEY: "not-a-secret", PARALLEL_API_KEY: "not-a-secret" }, { harness: "codex", tools: ["web_search"] }, {}), { web_search: "parallel" }, "a codex run on OpenAI's key, auto, the server's Parallel key: Parallel");
});

test("under auto Codex's own search stays off and agentrun's web_search is offered on codex", () => {
  const plane = planeFor({ OPENAI_API_KEY: "not-a-secret" }, { harness: "codex", tools: ["web_search"] }, {});
  assert.ok(!isUnavailable(plane.web_search), `codex, auto: agentrun's web_search runs there (${plane.web_search})`);
  assert.deepEqual(nativeOptions(facts("codex"), planeEnv(plane)), {}, "codex, auto: Codex's live search is not turned on");
  const view = toolsView({ OPENAI_API_KEY: "not-a-secret" }).find((tool) => tool.name === "web_search");
  assert.deepEqual([view.available, view.resolves.codex], [true, "firecrawl-keyless"], "capabilities: codex's web_search is agentrun's own on auto");
  assert.equal(view.why.codex, `${KEYLESS}; Codex's own search is an explicit pick`, "capabilities say Codex's own search is a pick");
});

test("a pick of native still turns on each harness's own search: Claude's WebSearch and Codex's live search through nativeOptions, pi's hosted search through its plane", () => {
  for (const { name, input } of OWN) assert.equal(resolveOnBuiltin("web_search", { ...base, ...input, pick: "native" }), "native", `${name}, native picked`);
  assert.equal(resolveOnBuiltin("web_search", { ...base, harness: "claude-agent", override: "native" }), "native", "claude-agent, native picked for the agent");
  const direct = { AGENT_MODEL: "anthropic/claude-sonnet-5-5" };
  const native = { web_search: { provider: "native" } };
  assert.deepEqual(planeFor(direct, { tools: ["web_search"] }, native), { web_search: "native", model: "anthropic/claude-sonnet-5-5" }, "pi, native picked in settings: its plane asks Anthropic's hosted search (adapter-run-spec turns its webSearch on)");
  assert.deepEqual(planeFor(direct, { tools: ["web_search"], model: "openai/gpt-6.1-sol", overrides: native }, {}), { web_search: "native", model: "openai/gpt-6.1-sol" }, "pi, native picked for the agent: OpenAI's hosted search");
  const codex = planeFor({ OPENAI_API_KEY: "not-a-secret" }, { harness: "codex", tools: ["web_search"] }, native);
  assert.equal(codex.web_search, "native");
  assert.deepEqual(nativeOptions(facts("codex"), planeEnv(codex)), { webSearch: "live" }, "codex, native picked: Codex's live search on");
  const claude = planeFor(direct, { harness: "claude-agent", tools: ["web_search"], overrides: native }, {});
  assert.equal(claude.web_search, "native");
  assert.deepEqual(nativeOptions(facts("claude-agent"), planeEnv(claude)), { webSearch: true, webSearchAllowance: 200_000 }, "claude-agent, native picked: Claude's WebSearch on");
});

test("claude-agent's auto is as it was: agentrun's own search, Claude's own an explicit pick", () => {
  const keyless = explainCapability("web_search", { ...base, harness: "claude-agent", facts: builtinFacts("claude-agent") });
  assert.deepEqual([keyless.resolves, keyless.why], ["firecrawl-keyless", `${KEYLESS}; Claude's own search is an explicit pick`]);
  const keyed = explainCapability("web_search", { ...base, harness: "claude-agent", parallelKey: true, facts: builtinFacts("claude-agent") });
  assert.deepEqual([keyed.resolves, keyed.why], ["parallel", KEY]);
  const plane = planeFor({ AGENT_MODEL: "anthropic/claude-sonnet-5-5" }, { harness: "claude-agent", tools: ["web_search"] }, {});
  assert.deepEqual(plane, { web_search: "firecrawl-keyless" });
  assert.deepEqual(nativeOptions(facts("claude-agent"), planeEnv(plane)), {}, "claude-agent, auto: Claude's WebSearch stays off");
});
