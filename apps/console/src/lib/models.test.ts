import { describe, expect, it } from "vitest";
import { harnessDefault, modelLabel } from "./models";

describe("model labels", () => {
  it("takes off exactly the routing prefix the server names (models.route_prefix); the full id is the title", () => {
    expect(modelLabel("agent-model/gpt-6-luna", "agent-model")).toEqual({ text: "gpt-6-luna", title: "agent-model/gpt-6-luna" });
    // Named by the server, never in the console: another prefix is taken off the same way.
    expect(modelLabel("router-x/acme-7", "router-x")).toEqual({ text: "acme-7", title: "router-x/acme-7" });
  });
  it("a gateway default with no routing prefix keeps its full label: no prefix is read off an id", () => {
    expect(modelLabel("anthropic/claude-x", null)).toEqual({ text: "anthropic/claude-x" });
    expect(modelLabel("anthropic/claude-x", undefined)).toEqual({ text: "anthropic/claude-x" });
  });
  it("leaves a provider's own id, and any id when the models do not come from a gateway, whole", () => {
    expect(modelLabel("openai/gpt-5", "agent-model")).toEqual({ text: "openai/gpt-5" });
    expect(modelLabel("faux/faux-1", null)).toEqual({ text: "faux/faux-1" });
  });
  it("takes each harness's default from the server (harnesses[].default_model), none where it says null", () => {
    const harnesses = [{ id: "pi", default_model: "agent-model/gpt-6-luna" }, { id: "claude-agent", default_model: null }, { id: "codex", default_model: "agent-model/gpt-6-luna" }];
    expect(harnessDefault("codex", harnesses)).toBe("agent-model/gpt-6-luna");
    expect(harnessDefault("claude-agent", harnesses)).toBeUndefined();
    expect(harnessDefault("pi", [{ id: "pi", default_model: null }])).toBeUndefined();
  });
});
