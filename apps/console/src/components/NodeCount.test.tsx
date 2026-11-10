import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { WorkflowEditor } from "./WorkflowEditor";
import { createBody } from "@/lib/agentForm";

// The graph's node count is the nodes it draws: a new Workflow agent draws one box and says "1 node", a new Decision agent
// draws four (the judge and its three exits) and says "4 nodes". The root chain the steps hang on is no box of its own.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const starter = (harness: "workflow" | "decision") =>
  createBody({ name: harness, description: "", instructions: "", harness, tools: [], decisionProvider: "jev" }).definition.workflow;
const TEMPLATES = [["Workflow", starter("workflow"), "1 node"], ["Decision", starter("decision"), "4 nodes"]] as const;

// What the drawing shows as boxes: every node group but a chain's, the line its steps sit on (as a click names them).
const drawn = (host: Element) => host.querySelectorAll("svg g[data-path]:not(.chain)").length;
// The count the graph's header prints.
const said = (host: Element) => [...host.querySelectorAll("span")].map((s) => s.textContent ?? "").find((t) => /^\d+ nodes?\b/.test(t)) ?? "";

describe("the workflow editor's node count", () => {
  for (const [name, workflow, words] of TEMPLATES) {
    it(`a new ${name} agent's graph says "${words}", the boxes it draws`, () => {
      const host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
      act(() => root!.render(createElement(WorkflowEditor, { text: JSON.stringify(workflow, null, 2), onText: () => {} })));
      expect(said(host)).toBe(words);
      expect(`${drawn(host)} ${drawn(host) === 1 ? "node" : "nodes"}`).toBe(words);
    });
  }
});

describe("the agent page's Workflow tab node count", () => {
  for (const [name, workflow, words] of TEMPLATES) {
    it(`a new ${name} agent's page says "${words}", the boxes it draws`, async () => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const agent = { agent_id: "flow", kind: "workflow", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Flow", workflow, skills: [], tools: [] } };
      vi.stubGlobal("fetch", async (url: string) => {
        const path = new URL(url, "http://serve.test").pathname;
        if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
        if (path === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
        if (path === "/v2/agents") return json(200, { agents: [agent], next_cursor: null });
        if (path === "/v2/agents/flow") return json(200, agent);
        if (path.endsWith("/runs") || path.endsWith("/revisions")) return json(200, { runs: [], revisions: [], next_cursor: null });
        return json(404, { error: { code: "not_found", message: path, retryable: false } });
      });
      location.hash = "#/agents/flow/workflow";
      const host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
      act(() => root!.render(createElement(App)));
      const end = Date.now() + 4000;
      while (!host.querySelector('svg[aria-label="The workflow\'s graph"] g[data-path]') && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
      expect(said(host).split(" · ")[0]).toBe(words);
      expect(`${drawn(host)} ${drawn(host) === 1 ? "node" : "nodes"}`).toBe(words);
    });
  }
});
