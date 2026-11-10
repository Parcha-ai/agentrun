import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentToolSettings } from "./ToolSettings";
import type { Agent } from "@/lib/agentForm";
import { toolGates } from "@/lib/toolSettings";
import { servedAgent } from "@/test/agent";

// What "ask" means differs by kind of agent, and the editor's line under Tool settings says which: an agentic run waits
// for the owner's approval at each call; a workflow's call node can't wait, so the server refuses the start (its 409
// agent_not_runnable, `details.asks`: "…a workflow's call node can't wait for an approval: set it to allow for this agent.").
const ALL = ["allow", "ask", "deny"];
const GATES = toolGates([{ name: "web_fetch", available: true, permission: "ask", default_permission: "allow", permissions: ALL }]);
const AGENTIC = "Each of these tools takes this server's setting (its default here) unless it is changed here. A tool on ask makes the run wait for your approval at each call.";
const WORKFLOW = "Each of these tools takes this server's setting (its default here) unless it is changed here. A call node can't wait for an approval: a tool set to ask stops the run from starting. Set it to allow.";
// The markup's text: tags dropped, the apostrophe React writes as &#x27; read back.
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const agent = (kind: Agent["kind"]): Agent => servedAgent({
  agent_id: "a1", kind, revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "A", ...(kind === "workflow" ? { workflow: {} } : { instructions: "Do it." }), skills: [], tools: ["web_fetch"] },
});
const render = (kind: Agent["kind"]) => text(renderToStaticMarkup(createElement(AgentToolSettings, {
  agent: agent(kind), harness: "pi", tools: ["web_fetch"], choices: [], gates: GATES, value: {}, issues: {}, onChange: () => {},
  ...(kind === "workflow" ? { callTools: ["web_fetch"] } : {}),
})));

describe("the Tool settings line on ask", () => {
  it("an agentic agent: a tool on ask makes the run wait for your approval at each call (unchanged)", () => {
    expect(render("agentic")).toContain(AGENTIC);
    expect(render("agentic")).not.toContain("call node");
  });

  it("a workflow agent: a call node can't wait, so a tool set to ask stops the run from starting", () => {
    expect(render("workflow")).toContain(WORKFLOW);
    expect(render("workflow")).not.toContain("makes the run wait for your approval");
  });
});
