import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";

const caps = { harnesses: [{ id: "pi", available: true }], tools: ["read"], thinking: ["low"] };

// A new agent is agentic (instructions) or a workflow pasted as JSON: the server validates the workflow as on any save.
describe("AgentEditor, a new agent", () => {
  it("offers both kinds, and starts agentic: instructions, tools and settings", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps }));
    expect(html).toContain("Workflow (JSON)");
    expect(html).toContain("Instructions");
    expect(html).toContain("Settings");
  });
  it("as a workflow: a JSON field in place of instructions, and no tools or settings steps", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, initialKind: "workflow" }));
    expect(html).toContain("Paste the workflow");
    expect(html).not.toContain("Describe what the agent does");
    expect(html).not.toContain("Harness, thinking and model");
    expect(html).not.toContain("What this agent can do");
  });
});
