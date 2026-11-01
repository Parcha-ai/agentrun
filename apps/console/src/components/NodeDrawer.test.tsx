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
