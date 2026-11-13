import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { RunBar } from "./RunBar";
import { agentFixture } from "@/fixtures";

// Effort is how hard the model thinks (its thinking level), and each place that offers it says so in those words.
describe("the effort picker's words", () => {
  const agent = agentFixture("invoice-checker");
  it("the agent page's run bar says effort sets how hard the model thinks", () => {
    const html = renderToStaticMarkup(createElement(RunBar, { agent, efforts: ["low", "medium", "high"], v2: {} as never, go: () => {} }));
    expect(html).toContain("How hard the model thinks");
  });
  it("the Playground's effort field says it too, and that empty uses the agent's own", () => {
    const html = renderToStaticMarkup(createElement(Playground, { agents: [agent], efforts: ["low", "medium", "high"], origin: "http://serve.test", agentId: agent.agent_id }));
    expect(html).toContain("How hard the model thinks. Empty uses the agent&#x27;s own.");
  });
});
