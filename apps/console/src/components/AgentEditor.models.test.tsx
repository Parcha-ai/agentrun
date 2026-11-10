import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import type { Agent } from "@/lib/agentForm";
import { servedAgent } from "@/test/agent";

// The editor's Model field on a server whose models come through a gateway: the default without the gateway's routing
// prefix (the full id in a title), and no default offered to a harness that does not run it.
// Each harness's default as the server names it (capabilities' harnesses[].default_model).
const caps = { harnesses: [{ id: "pi", available: true, default_model: "agent-model/gpt-6-luna" }, { id: "claude-agent", available: true, default_model: null }, { id: "codex", available: true, default_model: null }], tools: [], thinking: [], routePrefix: "agent-model" };
const agentOn = (harness: Agent["definition"]["harness"], model?: string): Agent => servedAgent({ agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness, skills: [], tools: [], ...(model ? { model } : {}) } });
const settings = (agent: Agent) => renderToStaticMarkup(createElement(AgentEditor, { agent, caps, step: "settings" }));

describe("demo: each harness's default model, as the server names it", () => {
  // capabilities.harnesses[].default_model on a gateway server: codex runs the gateway's default, claude-agent has none.
  const named = { ...caps, harnesses: [{ id: "pi", available: true, default_model: "agent-model/gpt-6-luna" }, { id: "claude-agent", available: true, default_model: null }, { id: "codex", available: true, default_model: "agent-model/gpt-6-luna" }] };
  it("codex shows the gateway's default, claude-agent shows none", () => {
    const codex = renderToStaticMarkup(createElement(AgentEditor, { agent: agentOn("codex"), caps: named, step: "settings" }));
    expect(codex).toContain(`Empty uses the server&#x27;s default (<span title="agent-model/gpt-6-luna">gpt-6-luna</span>).`);
    const claude = renderToStaticMarkup(createElement(AgentEditor, { agent: agentOn("claude-agent"), caps: named, step: "settings" }));
    expect(claude).toContain("No default for this harness yet: add a model key in Settings → Model keys, or choose a model here.");
    expect(claude).not.toContain("gpt-6-luna");
  });
});

describe("AgentEditor, the Model field", () => {
  it("on pi, names the server's default without the gateway's prefix, the full id in its title; the placeholder is a value a save takes", () => {
    const html = settings(agentOn("pi"));
    expect(html).toContain(`Empty uses the server&#x27;s default (<span title="agent-model/gpt-6-luna">gpt-6-luna</span>).`);
    expect(html).toContain('placeholder="provider/model"');
  });
  it("from a server that does not name each harness's default, offers none to claude-agent or codex", () => {
    for (const harness of ["claude-agent", "codex"] as const) {
      const html = settings(agentOn(harness));
      expect(html, harness).toContain("No default for this harness yet: add a model key in Settings → Model keys, or choose a model here.");
      expect(html, harness).not.toContain("gpt-6-luna");
      expect(html, harness).toContain('placeholder="provider/model"');
    }
  });
});
