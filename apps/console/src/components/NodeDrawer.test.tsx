import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { workflowGraph } from "@dsl/graph";
import { NodeDrawer, ToolCard } from "@/components/NodeDrawer";
import type { Decision, Effect, RunGraph } from "@/lib/runGraph";

const effect = (over: Partial<Effect>): Effect => ({ node: "/root", executionPath: "/root", item: null, tool: "check", status: "done", input: {}, output: null, startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:01Z", ...over });
const html = (e: Effect) => renderToStaticMarkup(<ToolCard e={e} fileUrl={(r) => r} zoom={() => {}} />);

describe("ToolCard", () => {
  it("shows a finished call's false, 0 or empty answer as its output, never as running", () => {
    for (const output of [false, 0, ""]) {
      const h = html(effect({ output }));
      expect(h).toContain("Output");
      expect(h).not.toContain("Running");
    }
  });
  it("says a finished call with no output finished, and a call in flight is running", () => {
    expect(html(effect({ output: null }))).toContain("Finished with no output.");
    expect(html(effect({ output: null, status: "working", endedAt: null }))).toContain("Running");
  });
});

describe("NodeDrawer, a map item", () => {
  it("shows a judged route's answer inside the item, though a route holds other nodes", () => {
    const workflow = { v: 2, name: "t", root: { node: "map", label: "each", itemsPath: "docs", as: "rows", body: { node: "route", label: "triage", provider: "jev", state: {}, instructions: "Which?",
      branches: { ok: { criteria: "fine", body: { node: "code", label: "a", code: "(s) => s" } }, no: { criteria: "not", body: { node: "code", label: "b", code: "(s) => s" } } } } } };
    const graph = workflowGraph(workflow);
    const d: Decision = { id: "d1", node: "/root/body", executionPath: "/root/items/0/body", item: 0, kind: "route", provider: "jev", model: "jev-1", status: "answered",
      questions: { branch: { type: "choice", instructions: "Which branch fits?", criteria: { ok: "fine", no: "not" } } },
      answers: { branch: { type: "choice", choice: "no", probabilities: { ok: 0.2, no: 0.8 }, confidence: 0.8 } },
      rule: { kind: "route", branches: ["ok", "no"], unsure: null }, action: { taken: "no" }, cost_usd: 0.0001, latency_ms: 300 };
    const g: RunGraph = {
      run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:02Z" },
      workflow, graph, decisions: [d], effects: [], totals: { cost_usd: 0.0001, decisions: 1, effects: 0, elapsed_ms: 2000 },
      nodes: { "/root": { status: "done", items: [{ index: 0, status: "done", executionPath: "/root/items/0" }] } },
    };
    const h = renderToStaticMarkup(<NodeDrawer data={g} selected={{ path: "/root", item: 0 }} onSelect={() => {}} onClose={() => {}} fileUrl={(r) => r} />);
    expect(h).toContain("Which branch fits?");
    expect(h).toContain("Took &quot;no&quot;");
  });
});

// A run's model node, in its details: its header names its tier and the model it ran on, as its card does.
describe("NodeDrawer, a model node's model", () => {
  it("its header reads its kind, tier and model; one of no tier its kind and model", () => {
    const workflow = { v: 2, name: "t", root: { node: "chain", steps: [
      { node: "extract", label: "quick look", tier: "fast", instructions: "Look.", out: "Out", as: "a" },
      { node: "extract", label: "final answer", instructions: "Answer.", out: "Out", as: "b" },
    ] } };
    const graph = workflowGraph(workflow);
    const g: RunGraph = {
      run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:02Z" },
      workflow, graph, decisions: [], effects: [], totals: { cost_usd: null, decisions: 0, effects: 0, elapsed_ms: 2000 },
      nodes: { "/root": { status: "done" }, "/root/steps/0": { status: "done", model: "gpt-5-mini", tier: "fast" }, "/root/steps/1": { status: "done", model: "gpt-5-4-mini" } },
    };
    const header = (path: string) => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<NodeDrawer data={g} selected={{ path, item: null }} onSelect={() => {}} onClose={() => {}} fileUrl={(r) => r} />);
      return host.querySelector("header p")?.textContent;
    };
    expect(header("/root/steps/0")).toBe("extract · fast · gpt-5-mini");
    expect(header("/root/steps/1")).toBe("extract · gpt-5-4-mini");
  });
});

// An MCP server's tool in a call node (`tool: "mcp:<server>/<tool>"`): the drawer's header and its tool call card read
// "<tool> on <server>" with an MCP mark, as the graph's card does, never the raw key; any other tool reads as before.
describe("NodeDrawer, an MCP call node", () => {
  const workflow = { v: 2, name: "t", root: { node: "call", label: "file the bug", via: "tool", tool: "mcp:linear/create_issue", args: {}, out: "Out", as: "issue" } };
  const graph = workflowGraph(workflow);
  const run = (tool: string): RunGraph => ({
    run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:02Z" },
    workflow: tool === "web_fetch" ? { ...workflow, root: { ...workflow.root, tool } } : workflow, graph, decisions: [], effects: [effect({ node: "/root", tool, output: { id: "ISS-1" } })],
    totals: { cost_usd: null, decisions: 0, effects: 1, elapsed_ms: 2000 }, nodes: { "/root": { status: "done" } },
  });
  const drawer = (tool: string) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<NodeDrawer data={run(tool)} selected={{ path: "/root", item: null }} onSelect={() => {}} onClose={() => {}} fileUrl={(r) => r} />);
    return host;
  };
  it("its header and its tool call read <tool> on <server>, each with an MCP mark, never the raw mcp: key", () => {
    const h = drawer("mcp:linear/create_issue");
    expect(h.querySelector("header p")?.textContent).toContain("call · create_issue on linear");
    expect([...h.querySelectorAll("[data-mcp]")].map((x) => x.textContent)).toEqual(["MCP", "MCP"]);
    const card = h.querySelector("section header")!;
    expect(card.textContent).toContain("create_issue on linear");
    // The raw key stays where the node's JSON is shown as written (its Definition), and nowhere a person reads it as a name.
    for (const named of [h.querySelector("header")!, card]) expect(named.textContent).not.toContain("mcp:linear/create_issue");
    expect(card.querySelector("[title]")?.getAttribute("title")).toBe("mcp:linear/create_issue");
  });
  it("another tool reads as before: its name, no MCP mark", () => {
    const h = drawer("web_fetch");
    expect(h.querySelector("header p")?.textContent).toContain("call · web_fetch");
    expect(h.querySelector("section header")?.textContent).toContain("web_fetch");
    expect(h.querySelectorAll("[data-mcp]")).toHaveLength(0);
  });
});
