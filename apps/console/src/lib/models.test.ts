import { describe, expect, it } from "vitest";
import { contextSize, freeRequestsNote, harnessDefault, harnessFree, modelLabel } from "./models";

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
    expect(modelLabel("openai/gpt-6.1-sol", "agent-model")).toEqual({ text: "openai/gpt-6.1-sol" });
    expect(modelLabel("faux/faux-1", null)).toEqual({ text: "faux/faux-1" });
  });
  it("a ChatGPT plan's model (chatgpt/<id>) reads its id and \"on your ChatGPT plan\", the full id its title, whatever the route prefix", () => {
    expect(modelLabel("chatgpt/gpt-6.1-sol", null)).toEqual({ text: "gpt-6.1-sol · on your ChatGPT plan", title: "chatgpt/gpt-6.1-sol" });
    expect(modelLabel("chatgpt/gpt-6.1-sol", "agent-model")).toEqual({ text: "gpt-6.1-sol · on your ChatGPT plan", title: "chatgpt/gpt-6.1-sol" });
    expect(modelLabel("chatgpt/", null)).toEqual({ text: "chatgpt/" });
  });
  it("takes each harness's default from the server (harnesses[].default_model), none where it says null", () => {
    const harnesses = [{ id: "pi", default_model: "agent-model/gpt-6-luna" }, { id: "claude-agent", default_model: null }, { id: "codex", default_model: "agent-model/gpt-6-luna" }];
    expect(harnessDefault("codex", harnesses)).toBe("agent-model/gpt-6-luna");
    expect(harnessDefault("claude-agent", harnesses)).toBeUndefined();
    expect(harnessDefault("pi", [{ id: "pi", default_model: null }])).toBeUndefined();
  });
});

describe("free models", () => {
  it("a context window reads as a person says it", () => {
    expect([1_048_576, 1_000_000, 1_024_000, 2_000_000, 1_500_000, 262_144, 65_536, 8_192].map(contextSize)).toEqual(["1M", "1M", "1M", "2M", "1.5M", "262K", "66K", "8K"]);
  });
  it("a harness's free models by id; none from a server that lists none", () => {
    const free = harnessFree("pi", [{ id: "pi", free_models: [{ id: "openrouter/x/y:free", context_window: 262_144 }] }]);
    expect([...free.keys()]).toEqual(["openrouter/x/y:free"]);
    expect(harnessFree("pi", [{ id: "pi" }]).size).toBe(0);
    expect(harnessFree("codex", undefined).size).toBe(0);
  });
  it("beside the cap, a free model's limit on requests, in the server's number; nothing for a plan's model, a paid model or no limit", () => {
    const harnesses = [{ id: "pi", free_models: [{ id: "openrouter/x/y:free", context_window: 262_144 }] }];
    expect(freeRequestsNote("openrouter/x/y:free", "pi", harnesses, 12)).toBe("free model: up to 12 requests");
    expect(freeRequestsNote("chatgpt/gpt-6.1-sol", "codex", harnesses, 60)).toBeNull();
    expect(freeRequestsNote("chatgpt/gpt-6.1-sol", "pi", harnesses, 60)).toBeNull();
    expect(freeRequestsNote("anthropic/claude-sonnet-5-5", "pi", harnesses, 60)).toBeNull();
    expect(freeRequestsNote("openrouter/x/y:free", "codex", harnesses, 60)).toBeNull();
    expect(freeRequestsNote("openrouter/x/y:free", "pi", harnesses, undefined)).toBeNull();
    expect(freeRequestsNote(null, "pi", harnesses, 60)).toBeNull();
  });
});
