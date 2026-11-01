import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import type { Agent } from "@/lib/agentForm";

// The editor's Model field on a server whose models come through a gateway: the default without the gateway's routing
// prefix (the full id in a title), and no default offered to a harness that does not run it.
const caps = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: true }], tools: [], thinking: [], defaultModel: "agent-model/gpt-6-luna", modelSource: "gateway" };
const agentOn = (harness: string, model?: string): Agent => ({ agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness, skills: [], tools: [], ...(model ? { model } : {}) } });
const settings = (agent: Agent) => renderToStaticMarkup(createElement(AgentEditor, { agent, caps, step: "settings" }));

describe("AgentEditor, the Model field", () => {
  it("on pi, names the server's default without the gateway's prefix, the full id in its title", () => {
    const html = settings(agentOn("pi"));
    expect(html).toContain(`Empty uses the server&#x27;s default (<span title="agent-model/gpt-6-luna">gpt-6-luna</span>).`);
    expect(html).toContain('placeholder="gpt-6-luna"');
  });
  it("on claude-agent or codex, offers no default it may not run: the person chooses a model", () => {
    for (const harness of ["claude-agent", "codex"]) {
      const html = settings(agentOn(harness));
      expect(html, harness).toContain("No default for this harness: choose a model.");
      expect(html, harness).not.toContain("gpt-6-luna");
      expect(html, harness).toContain('placeholder="provider/model"');
    }
  });
});
