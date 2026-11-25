import { describe, expect, it } from "vitest";
import { withoutRoutePrefix } from "./routePrefix";

// The one strip of a gateway's routing prefix (capabilities' models.route_prefix), shared by modelLabel and planRuns.
describe("withoutRoutePrefix", () => {
  it("takes off exactly the prefix the server names", () => {
    expect(withoutRoutePrefix("agent-model/chatgpt/gpt-6.1-sol", "agent-model")).toBe("chatgpt/gpt-6.1-sol");
    expect(withoutRoutePrefix("router-x/acme-7", "router-x")).toBe("acme-7");
  });
  it("leaves an id with another prefix, no prefix named, or nothing after the prefix as it is", () => {
    expect(withoutRoutePrefix("anthropic/claude-x", "agent-model")).toBe("anthropic/claude-x");
    expect(withoutRoutePrefix("agent-model/gpt-6-luna", null)).toBe("agent-model/gpt-6-luna");
    expect(withoutRoutePrefix("agent-model/gpt-6-luna", undefined)).toBe("agent-model/gpt-6-luna");
    expect(withoutRoutePrefix("agent-model/", "agent-model")).toBe("agent-model/");
    expect(withoutRoutePrefix("agent-modelx/y", "agent-model")).toBe("agent-modelx/y");
  });
});
