import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { toolOffers } from "@/lib/agentForm";

// The server sends its tools as objects ({name, available, missing}): the Tools step lists them by name, and one the
// server can't run now can't be newly picked.
describe("AgentEditor's Tools step, on a server that sends tool objects", () => {
  const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools: toolOffers([{ name: "read", available: true }, { name: "browser", available: false, missing: ["BROWSERBASE_API_KEY"] }]) };
  it("lists each tool by its name, and the one it can't run is disabled", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps, step: "tools" }));
    expect(html).toContain('value="read"');
    expect(html).toContain('value="browser"');
    expect(html).toMatch(/value="browser"[^>]*disabled=""|disabled=""[^>]*value="browser"/);
  });
  it("takes the server's tool objects, or an older server's names", () => {
    expect(toolOffers(["read"])).toEqual([{ name: "read", available: true }]);
    expect(toolOffers([{ name: "read" }])).toEqual([{ name: "read", available: true }]);
  });
});
