import { describe, expect, it } from "vitest";
import { applyHarness, freeDefault, freeHarness, freeModels, runsFree, freeModelFor, webTools } from "./freeShelf";
import type { HarnessInfo } from "./models";
import type { TemplateView } from "./v2";

// The Free shelf reads only what capabilities and GET /v2/templates already say: the free models (local Ollama first),
// what web_search and web_fetch resolve to in the server's own words, and the templates whose package marks them free.

const LOCAL = { id: "ollama/qwen3:8b", context_window: 65536 };
const LOCAL_2 = { id: "ollama/smollm3:3b", context_window: 32768 };
const CATALOG = { id: "openrouter/example/free-model:free", context_window: 262144 };
const pi = (free: HarnessInfo["free_models"], default_model: string | null = "anthropic/claude-x"): HarnessInfo =>
  ({ id: "pi", available: true, default_model, models: ["anthropic/claude-x", ...(free ?? []).map((m) => m.id)], free_models: free });

describe("freeModels", () => {
  it("lists local Ollama models before free catalog ones, whatever order a harness gives them in, once each", () => {
    const harnesses: HarnessInfo[] = [
      pi([CATALOG, LOCAL]),
      { id: "codex", available: true, default_model: null, models: [LOCAL_2.id, CATALOG.id], free_models: [LOCAL_2, CATALOG] },
    ];
    expect(freeModels(harnesses).map((m) => [m.id, m.local])).toEqual([[LOCAL.id, true], [LOCAL_2.id, true], [CATALOG.id, false]]);
  });

  it("says a local model's tag and context, and a catalog one's id and context", () => {
    const [local, catalog] = freeModels([pi([LOCAL, CATALOG])]);
    expect(local).toMatchObject({ label: "qwen3:8b · local (Ollama)", context: "66K" });
    expect(catalog).toMatchObject({ label: CATALOG.id, context: "262K" });
  });

  it("is empty from a server with no free model, or none read yet", () => {
    expect(freeModels([pi([])])).toEqual([]);
    expect(freeModels(undefined)).toEqual([]);
  });
});

describe("freeDefault", () => {
  it("is the harness's default model when that one is free", () => {
    expect(freeDefault([pi([LOCAL, CATALOG], CATALOG.id)], "pi")).toBe(CATALOG.id);
  });
  it("else its first free model, local first", () => {
    expect(freeDefault([pi([CATALOG, LOCAL])], "pi")).toBe(LOCAL.id);
  });
  it("is null with no free model on the harness", () => {
    expect(freeDefault([pi([])], "pi")).toBeNull();
    expect(freeDefault([pi([LOCAL])], "codex")).toBeNull();
  });
  it("freeHarness: the first available harness with a free model, pi first", () => {
    const codex: HarnessInfo = { id: "codex", available: true, default_model: null, models: [CATALOG.id], free_models: [CATALOG] };
    expect(freeHarness([codex, pi([LOCAL])])).toBe("pi");
    expect(freeHarness([codex, pi([])])).toBe("codex");
    expect(freeHarness([pi([])])).toBeNull();
  });
});

describe("webTools", () => {
  const why = "keyless Firecrawl: each URL read goes to Firecrawl's keyless service; save a Parallel key to fetch directly";
  const tools = [
    { name: "bash", resolves: { pi: "native" }, why: { pi: "pi's own bash" } },
    { name: "web_fetch", resolves: { pi: "firecrawl-keyless", codex: "native" }, why: { pi: why, codex: "Codex's own fetch" } },
    { name: "web_search", resolves: { pi: "exa-keyless" }, why: { pi: "keyless Exa, picked in settings: Exa's free search, no key" } },
  ];
  it("gives web_search then web_fetch, each with what it resolves to on the harness and the server's why word for word", () => {
    expect(webTools(tools, "pi")).toEqual([
      { name: "web_search", resolves: "exa-keyless", why: "keyless Exa, picked in settings: Exa's free search, no key" },
      { name: "web_fetch", resolves: "firecrawl-keyless", why },
    ]);
  });
  it("leaves out a tool the server does not resolve on that harness, and reads nothing from a list it does not have", () => {
    expect(webTools(tools, "codex")).toEqual([{ name: "web_fetch", resolves: "native", why: "Codex's own fetch" }]);
    expect(webTools(undefined, "pi")).toEqual([]);
  });
});

const template = (over: Partial<TemplateView>): TemplateView => ({
  id: "t", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name: "t", display_name: null, version: "0.1.0", description: "", license: null, author: null, repository: null, output: null,
  input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null, computer: null, needs: null,
  computer_here: null, model_tiers_here: { harness: "pi", fast: null, strong: null, note: null }, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [],
  evals: [], mcp: [], parameters: { type: "object", properties: {} }, ...over,
} as TemplateView);

describe("runsFree", () => {
  const harnesses = [pi([LOCAL, CATALOG])];
  it("takes the package's own mark: its free tag", () => {
    expect(runsFree(template({ tags: ["free", "research"] }), harnesses)).toBe(true);
  });
  it("or a preferred model, or a choice's, that is one of this server's free models", () => {
    expect(runsFree(template({ model: { tier: "fast", prefer: CATALOG.id } }), harnesses)).toBe(true);
    expect(runsFree(template({ model: { tier: "fast", choices: [{ id: "local", label: "Local", model: LOCAL.id, harness: "pi", warning: null, note: null, secrets: [] }] } }), harnesses)).toBe(true);
  });
  it("never a paid one, or one with no mark", () => {
    expect(runsFree(template({ model: { tier: "balanced", prefer: "anthropic/claude-x" } }), harnesses)).toBe(false);
    expect(runsFree(template({ tags: ["research"] }), harnesses)).toBe(false);
  });
  // A tag is the package author's own claim, and "Use free" swaps only the model: what else it asks for is read too.
  it("never one that asks for a key, an MCP toolkit, a browser, or a computer that is not this server's own", () => {
    const tagged = { tags: ["free"] };
    expect(runsFree(template({ ...tagged, secrets: ["MONID_API_KEY"] }), harnesses)).toBe(false);
    expect(runsFree(template({ ...tagged, mcp: [{ source: "composio", toolkit: "gmail", required: true, reason: null, tools: [] }] }), harnesses)).toBe(false);
    expect(runsFree(template({ ...tagged, tools: ["read", "mcp:github/get_file_contents"] }), harnesses)).toBe(false);
    expect(runsFree(template({ ...tagged, tools: ["browser_navigate"] }), harnesses)).toBe(false);
    const here = (computer: { kind: string; provider?: string }, shell: string | null) => ({ computer_here: { entry: "shell" as const, computer, shell, dropped: [], note: null } });
    expect(runsFree(template({ ...tagged, ...here({ kind: "sandbox", provider: "daytona" }, "the daytona sandbox") }), harnesses)).toBe(false);
    expect(runsFree(template({ ...tagged, ...here({ kind: "none" }, "Archil's serverless exec") }), harnesses)).toBe(false);
    expect(runsFree(template({ ...tagged, ...here({ kind: "sandbox", provider: "docker" }, "the docker sandbox"), tools: ["read", "bash", "web_fetch"] }), harnesses)).toBe(true);
    expect(runsFree(template({ ...tagged, ...here({ kind: "none" }, null) }), harnesses)).toBe(true);
  });
  // "Use free" swaps the agent's model, and a workflow package takes none (apply refuses overrides.model): its nodes run on
  // the server's models for their tiers, so its tag can't make it free.
  it("never a workflow package, even tagged free: it has no model to swap", () => {
    const flow = template({ tags: ["free"], harness: null, workflow: "router.workflow.json" });
    expect(runsFree(flow, harnesses)).toBe(false);
    expect(freeModelFor(flow, harnesses)).toBeNull();
    expect(runsFree(template({ tags: ["free"], harness: null, workflow: null }), harnesses)).toBe(true);
  });
  // Neither shows in a package's `secrets`: apply asks for Monid's key only where the server holds none, and a subagent's
  // tier runs on the package's model for it, else the host's (AGENT_MODEL_FAST, AGENT_MODEL_STRONG), which "Use free"
  // leaves as they are.
  it("never one that names a Monid endpoint, which books Monid's charges on the server's key", () => {
    expect(runsFree(template({ tags: ["free"], tools: ["read", "monid:apollo/people/match"] }), harnesses)).toBe(false);
  });
  // What a subagent of each tier runs on is the server's answer (model_tiers_here), never the package's model read here.
  const tiers = (fast: string | null, strong: string | null, harness = "pi", note: string | null = null) => ({ model_tiers_here: { harness, fast, strong, note } });
  it("one that grants subagent only where the server keeps a model for both its tiers, each one of this server's free models", () => {
    const sub = (fast: string | null, strong: string | null) => template({ tags: ["free"], tools: ["read", "subagent"], model: { tier: "fast", prefer: LOCAL.id, ...(fast ? { fast } : {}), ...(strong ? { strong } : {}) }, ...tiers(fast, strong) });
    expect(runsFree(sub(null, null), harnesses)).toBe(false);
    expect(runsFree(sub(LOCAL.id, null), harnesses)).toBe(false);
    expect(runsFree(sub(LOCAL.id, "anthropic/claude-x"), harnesses)).toBe(false);
    expect(runsFree(sub(LOCAL.id, CATALOG.id), harnesses)).toBe(true);
    expect(runsFree(template({ tags: ["free"], tools: ["read", "subagent"] }), harnesses)).toBe(false);
  });
  it("never one whose subagent tiers the server would not keep, though the package names free models for them: behind a model gateway they run on the host's models", () => {
    const named = { tags: ["free"], tools: ["read", "subagent"], model: { tier: "fast" as const, prefer: LOCAL.id, fast: LOCAL.id, strong: CATALOG.id } };
    const gateway = "this server reaches its models through a gateway, which has not said it serves that model";
    expect(runsFree(template({ ...named, ...tiers(LOCAL.id, CATALOG.id) }), harnesses)).toBe(true);
    expect(runsFree(template({ ...named, ...tiers(null, null, "pi", `model.fast ${LOCAL.id} is not used: ${gateway}.`) }), harnesses)).toBe(false);
    expect(runsFree(template({ ...named, ...tiers(LOCAL.id, null) }), harnesses)).toBe(false);
  });
  it("a subagent's tiers count as free only where the harness apply makes the agent on runs them free", () => {
    // claude-agent runs the local model; the catalog's free model is offered on pi alone.
    const claude: HarnessInfo = { id: "claude-agent", available: true, default_model: LOCAL.id, models: [LOCAL.id], free_models: [LOCAL] };
    const both = [claude, pi([LOCAL, CATALOG])];
    const sub = (fast: string, strong: string) => template({ tags: ["free"], harness: ["claude-agent"], tools: ["read", "subagent"], model: { tier: "fast", prefer: LOCAL.id, fast, strong }, ...tiers(fast, strong, "claude-agent") });
    expect(runsFree(sub(CATALOG.id, CATALOG.id), both)).toBe(false);
    expect(runsFree(sub(LOCAL.id, CATALOG.id), both)).toBe(false);
    expect(runsFree(sub(LOCAL.id, LOCAL.id), both)).toBe(true);
  });
  it("a free model only on a choice that needs no key", () => {
    const choice = (secrets: string[]) => ({ model: { tier: "fast" as const, choices: [{ id: "c", label: "C", model: LOCAL.id, harness: "pi", warning: null, note: null, secrets }] } });
    expect(runsFree(template(choice(["OPENROUTER_API_KEY"])), harnesses)).toBe(false);
    expect(runsFree(template(choice([])), harnesses)).toBe(true);
  });
  it("freeModelFor: the free default of the harness apply makes the agent on, as the server says", () => {
    expect(freeModelFor(template({ harness: ["codex", "pi"], ...tiers(null, null, "pi") }), harnesses)).toBe(LOCAL.id);
    expect(freeModelFor(template({ harness: null }), harnesses)).toBe(LOCAL.id);
    expect(freeModelFor(template({ harness: ["codex"], ...tiers(null, null, "codex") }), harnesses)).toBeNull();
  });
  it("never another harness's free model: apply would make the agent on a harness that can't run it", () => {
    const claude: HarnessInfo = { id: "claude-agent", available: true, default_model: "anthropic/claude-x", models: ["anthropic/claude-x"], free_models: [] };
    const both = [claude, pi([LOCAL])];
    const t = (harness: string) => template({ harness: ["claude-agent", "pi"], ...tiers(null, null, harness) });
    expect(applyHarness(t("claude-agent"))).toBe("claude-agent");
    expect(freeModelFor(t("claude-agent"), both)).toBeNull();
    expect(freeModelFor(t("pi"), both)).toBe(LOCAL.id);
  });
});
