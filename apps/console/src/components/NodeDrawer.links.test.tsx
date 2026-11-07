import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { workflowGraph } from "@dsl/graph";
import { NodeDrawer } from "@/components/NodeDrawer";
import type { Decision, RunGraph } from "@/lib/runGraph";

// A decision's evidence and images come from pages the provider fetched: a URL there is server data, never trusted. Only an
// http or https one is a link (or an image's source); any other is said as text, with no <a> and no <img>.
const BAD = ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)"];
const GOOD = ["https://example.com/refunds", "http://example.com/terms"];

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const drawer = (d: Partial<Decision>) => {
  const workflow = { v: 2, name: "t", root: { node: "route", label: "triage", provider: "jev", state: {}, instructions: "Which?",
    branches: { ok: { criteria: "fine", body: { node: "code", label: "a", code: "(s) => s" } }, no: { criteria: "not", body: { node: "code", label: "b", code: "(s) => s" } } } } };
  const decision: Decision = { id: "d1", node: "/root", executionPath: "/root", item: null, kind: "route", provider: "jev", model: "jev-1", status: "answered",
    questions: { branch: { type: "choice", instructions: "Which branch fits?", criteria: { ok: "fine", no: "not" } } },
    answers: { branch: { type: "choice", choice: "no", probabilities: { ok: 0.2, no: 0.8 }, confidence: 0.8 } },
    rule: { kind: "route", branches: ["ok", "no"], unsure: null }, action: { taken: "no" }, cost_usd: 0.0001, latency_ms: 300, ...d } as Decision;
  const g: RunGraph = {
    run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:02Z" },
    workflow, graph: workflowGraph(workflow), decisions: [decision], effects: [], totals: { cost_usd: 0.0001, decisions: 1, effects: 0, elapsed_ms: 2000 },
    nodes: { "/root": { status: "done" } },
  } as RunGraph;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(NodeDrawer, { data: g, selected: { path: "/root" }, onSelect: () => {}, onClose: () => {}, fileUrl: (r: string) => `/v2/runs/r/files/${r}` } as never)));
  return host;
};

describe("NodeDrawer, links from a decision's sources", () => {
  it("links only an http or https source; any other scheme is its title in plain text, with no link", () => {
    const host = drawer({ evidence: [...BAD, ...GOOD].map((url, k) => ({ url, title: `Source ${k + 1}`, excerpts: [] })) });
    const sources = [...host.querySelectorAll("section")].find((s) => s.textContent?.startsWith("Sources"))!;
    expect(sources.querySelectorAll("li")).toHaveLength(BAD.length + GOOD.length);
    for (let k = 0; k < BAD.length; k++) expect(sources.querySelectorAll("li")[k]!.textContent).toContain(`Source ${k + 1}`);
    expect([...sources.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(GOOD);
    expect([...host.querySelectorAll("a[href]")].filter((a) => !/^https?:\/\//.test(a.getAttribute("href")!))).toHaveLength(0);
  });
  it("shows only an http or https image a provider saw; any other is no image and no button", () => {
    const host = drawer({ images: [...BAD.map((url, k) => ({ token: `bad${k}`, ref: "", url })), { token: "good", ref: "", url: "https://example.com/shot.png" }, { token: "kept", ref: "pages/1.png" }] });
    expect(host.textContent).toContain("Which branch fits?");
    expect([...host.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["https://example.com/shot.png", "/v2/runs/r/files/pages/1.png"]);
  });
});
