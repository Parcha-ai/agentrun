import { describe, expect, it } from "vitest";
import { issuesFor, ownSettings, providerHelp, providerLabel, resolution, toolChoices, withProvider } from "./toolSettings";
import type { ToolSettings } from "./v2";

// capabilities.tools as the server lists them: a capability with a provider choice carries its providers (the built-in
// default first), the server's pick, the default, and what it resolves to per harness; the rest carry none.
const CAPS_TOOLS = [
  { name: "read", summary: "Read files", nodes: true, calls: true, available: true, harnesses: ["pi"] },
  { name: "web_search", summary: "Search the web", nodes: true, calls: true, available: true, harnesses: ["pi", "claude-agent", "codex"], providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "exa-keyless", default_provider: "auto", resolves: { pi: "exa-keyless", "claude-agent": "exa-keyless", codex: "native" } },
  { name: "web_fetch", summary: "Fetch a page", nodes: true, calls: true, available: true, harnesses: ["pi"], providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel", resolves: { pi: "kernel", "claude-agent": "native", codex: "native" } },
];

describe("tool settings", () => {
  it("takes the capabilities with a provider choice, in the server's order, their providers as given, the default first", () => {
    const choices = toolChoices(CAPS_TOOLS);
    expect(choices.map((c) => [c.name, c.providers, c.provider, c.default_provider])).toEqual([
      ["web_search", ["auto", "native", "exa-keyless", "parallel", "off"], "exa-keyless", "auto"],
      ["web_fetch", ["kernel", "parallel"], "kernel", "kernel"],
    ]);
    expect(toolChoices(undefined)).toEqual([]);
  });

  it("keeps whether a capability runs here, and the server's reason when it does not", () => {
    const off = toolChoices([{ ...CAPS_TOOLS[1], provider: "off", available: false, reason: "web_search is turned off in settings" }])[0];
    expect([off.available, off.reason]).toEqual([false, "web_search is turned off in settings"]);
    expect(toolChoices(CAPS_TOOLS).map((c) => [c.available, c.reason])).toEqual([[true, undefined], [true, undefined]]);
  });

  it("a provider equal to the layer's default is no setting, a reset takes the row back, and the settings are never changed", () => {
    const start: ToolSettings = { web_search: { provider: "exa-keyless" }, web_fetch: { provider: "parallel" } };
    expect(withProvider(start, "web_search", "auto", "auto")).toEqual({ web_fetch: { provider: "parallel" } });
    expect(withProvider(start, "web_fetch", undefined, "kernel")).toEqual({ web_search: { provider: "exa-keyless" } });
    expect(withProvider({}, "web_search", "parallel", "auto")).toEqual({ web_search: { provider: "parallel" } });
    expect(start.web_search).toEqual({ provider: "exa-keyless" });
  });

  it("the server's own settings are those of its answer unlike their default", () => {
    expect(ownSettings({ web_search: { provider: "exa-keyless" }, web_fetch: { provider: "kernel" } }, toolChoices(CAPS_TOOLS))).toEqual({ web_search: { provider: "exa-keyless" } });
  });

  it("describes each known provider in a line, native as never a third party; an unknown one has its id and no line", () => {
    expect(providerHelp("native")).toMatch(/never a third party/);
    expect(providerHelp("auto")).toMatch(/else keyless Exa/);
    expect([providerLabel("brave-beta"), providerHelp("brave-beta")]).toEqual(["brave-beta", undefined]);
  });

  it("says a resolution plainly: a provider's name, or the server's unavailable with its reason", () => {
    expect(resolution("exa-keyless")).toEqual({ text: "Exa keyless", unavailable: false });
    expect(resolution("unavailable: PARALLEL_API_KEY is not set")).toEqual({ text: "unavailable: PARALLEL_API_KEY is not set", unavailable: true });
  });

  it("puts a refusal's issues on their tool, the longest name first, and the rest apart", () => {
    const fields = { "definition.tool_settings.web_search.provider": "not offered", "definition.tool_settings.teleport": "no such tool", "definition.model": "not a model" };
    expect(issuesFor(fields, "definition.tool_settings", ["web_search", "web_fetch"])).toEqual({ byTool: { web_search: ["not offered"] }, rest: ["no such tool"] });
  });
});
