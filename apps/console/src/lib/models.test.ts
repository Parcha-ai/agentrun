import { describe, expect, it } from "vitest";
import { gatewayPrefix, harnessDefault, modelLabel } from "./models";

const gateway = { source: "gateway", default: "agent-model/gpt-6-luna", route_prefix: "agent-model" };

describe("model labels", () => {
  it("takes off exactly the routing prefix the server names (models.route_prefix); the full id is the title", () => {
    expect(gatewayPrefix(gateway)).toBe("agent-model");
    expect(modelLabel("agent-model/gpt-6-luna", gateway)).toEqual({ text: "gpt-6-luna", title: "agent-model/gpt-6-luna" });
    // Named by the server, never in the console: another prefix is taken off the same way.
    expect(modelLabel("router-x/acme-7", { source: "gateway", default: "router-x/acme-1", route_prefix: "router-x" })).toEqual({ text: "acme-7", title: "router-x/acme-7" });
  });
  it("a gateway default with no routing prefix keeps its full label: no prefix is read off an id", () => {
    const bare = { source: "gateway", default: "anthropic/claude-x", route_prefix: null };
    expect(gatewayPrefix(bare)).toBeUndefined();
    expect(modelLabel("anthropic/claude-x", bare)).toEqual({ text: "anthropic/claude-x" });
    // A server that names no prefix at all: nothing is taken off either.
    expect(modelLabel("anthropic/claude-x", { source: "gateway", default: "anthropic/claude-x" })).toEqual({ text: "anthropic/claude-x" });
  });
  it("leaves a provider's own id, and any id when the models do not come from a gateway, whole", () => {
    expect(modelLabel("openai/gpt-5", gateway)).toEqual({ text: "openai/gpt-5" });
    expect(modelLabel("anthropic/claude-sonnet-5", { source: "providers", default: "anthropic/claude-sonnet-5" })).toEqual({ text: "anthropic/claude-sonnet-5" });
    expect(gatewayPrefix({ source: "faux", default: "faux/faux-1" })).toBeUndefined();
  });
  it("takes each harness's default from the server (harnesses[].default_model), none where it says null", () => {
    const harnesses = [{ id: "pi", default_model: "agent-model/gpt-6-luna" }, { id: "claude-agent", default_model: null }, { id: "codex", default_model: "agent-model/gpt-6-luna" }];
    expect(harnessDefault("codex", harnesses, "agent-model/gpt-6-luna")).toBe("agent-model/gpt-6-luna");
    expect(harnessDefault("claude-agent", harnesses, "agent-model/gpt-6-luna")).toBeUndefined();
    expect(harnessDefault("pi", [{ id: "pi", default_model: null }], "agent-model/gpt-6-luna")).toBeUndefined();
  });
  it("from a server that does not say, offers its default to pi alone", () => {
    const harnesses = [{ id: "pi" }, { id: "codex" }];
    expect(harnessDefault("pi", harnesses, "agent-model/gpt-6-luna")).toBe("agent-model/gpt-6-luna");
    expect(harnessDefault("codex", harnesses, "agent-model/gpt-6-luna")).toBeUndefined();
  });
});
