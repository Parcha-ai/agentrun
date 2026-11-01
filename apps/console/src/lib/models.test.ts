import { describe, expect, it } from "vitest";
import { gatewayPrefix, harnessDefault, modelLabel } from "./models";

const gateway = { source: "gateway", default: "agent-model/gpt-6-luna" };

describe("model labels", () => {
  it("reads a gateway's routing prefix from the server's default, and takes it off; the full id is the title", () => {
    expect(gatewayPrefix(gateway)).toBe("agent-model");
    expect(modelLabel("agent-model/gpt-6-luna", gateway)).toEqual({ text: "gpt-6-luna", title: "agent-model/gpt-6-luna" });
    // Read, never named: another gateway's prefix is taken off the same way.
    expect(modelLabel("router-x/acme-7", { source: "gateway", default: "router-x/acme-1" })).toEqual({ text: "acme-7", title: "router-x/acme-7" });
  });
  it("leaves a provider's own id, and any id when the models do not come from a gateway, whole", () => {
    expect(modelLabel("openai/gpt-5", gateway)).toEqual({ text: "openai/gpt-5" });
    expect(modelLabel("anthropic/claude-sonnet-5", { source: "providers", default: "anthropic/claude-sonnet-5" })).toEqual({ text: "anthropic/claude-sonnet-5" });
    expect(gatewayPrefix({ source: "faux", default: "faux/faux-1" })).toBeUndefined();
  });
  it("offers the server's default to pi only, until the server says which harness takes what", () => {
    expect(harnessDefault("pi", "agent-model/gpt-6-luna")).toBe("agent-model/gpt-6-luna");
    expect(harnessDefault("claude-agent", "agent-model/gpt-6-luna")).toBeUndefined();
    expect(harnessDefault("codex", "agent-model/gpt-6-luna")).toBeUndefined();
  });
});
