import { describe, expect, it } from "vitest";
import { ownSettings, toolChoices, toolGates, withPermission, withProvider } from "./toolSettings";
import type { ToolSettings } from "./v2";

// Each tool's permission (serve's tool gate): allow runs it, ask waits for the owner's approval, deny refuses it. The
// server's settings and an agent's own carry it beside a provider, by settings key, catalog tools (monid.<tool>,
// mcp:<server>/<tool>) and an MCP server's wildcard (mcp:<server>/*) among them. PUT /v2/settings/tools replaces the
// whole map, so a save the console makes must carry every setting it does not show.
const CAPS_TOOLS = [
  { name: "read", summary: "Read files", available: true, permission: "allow", default_permission: "allow", permissions: ["allow", "ask", "deny"] },
  { name: "ask_person", summary: "Ask a person", available: true, permission: "allow", default_permission: "allow", permissions: ["allow", "deny"] },
  { name: "web_search", summary: "Search the web", available: true, providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "auto", default_provider: "auto", resolves: { pi: "exa-keyless" }, permission: "ask", default_permission: "allow", permissions: ["allow", "ask", "deny"] },
];

describe("tool permissions", () => {
  it("reads each tool's permission, the owner's default and those offered, in the server's order; none from an older server", () => {
    expect(toolGates(CAPS_TOOLS)).toEqual([
      { name: "read", permission: "allow", default_permission: "allow", permissions: ["allow", "ask", "deny"] },
      { name: "ask_person", permission: "allow", default_permission: "allow", permissions: ["allow", "deny"] },
      { name: "web_search", permission: "ask", default_permission: "allow", permissions: ["allow", "ask", "deny"] },
    ]);
    expect(toolGates([{ name: "read", available: true }])).toEqual([]);
    expect(toolGates(undefined)).toEqual([]);
  });

  it("keeps that ask needs the password sign-in, where the server says so (accounts off)", () => {
    expect(toolGates([{ ...CAPS_TOOLS[0], ask_needs: "password" }])[0]).toMatchObject({ name: "read", ask_needs: "password" });
  });

  it("a permission equal to the layer's default is no setting, and setting one keeps the tool's provider", () => {
    const start: ToolSettings = { web_search: { provider: "parallel" } };
    expect(withPermission(start, "web_search", "deny", "allow")).toEqual({ web_search: { provider: "parallel", permission: "deny" } });
    expect(withPermission({ web_search: { provider: "parallel", permission: "deny" } }, "web_search", "allow", "allow")).toEqual({ web_search: { provider: "parallel" } });
    expect(withPermission({ bash: { permission: "deny" } }, "bash", undefined, "allow")).toEqual({});
    expect(start).toEqual({ web_search: { provider: "parallel" } });
  });

  it("a provider change keeps the tool's permission, and a provider reset leaves the permission set", () => {
    const start: ToolSettings = { web_search: { provider: "parallel", permission: "ask" } };
    expect(withProvider(start, "web_search", "native", "auto")).toEqual({ web_search: { provider: "native", permission: "ask" } });
    expect(withProvider(start, "web_search", undefined, "auto")).toEqual({ web_search: { permission: "ask" } });
  });

  it("as on main, a capability's provider equal to its default is the default filled in, not a setting: dropped", () => {
    const choices = toolChoices([CAPS_TOOLS[2], { name: "web_fetch", providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel" }]);
    expect(ownSettings({ web_search: { provider: "auto" }, web_fetch: { provider: "kernel" } }, choices)).toEqual({});
    expect(ownSettings({ web_search: { provider: "native" }, web_fetch: { provider: "kernel" } }, choices)).toEqual({ web_search: { provider: "native" } });
  });

  it("the server's own settings keep every permission it holds, a catalog tool's and an MCP server's wildcard included", () => {
    const answer: ToolSettings = {
      web_search: { provider: "auto", permission: "ask" as const },
      web_fetch: { provider: "parallel" },
      bash: { permission: "deny" as const },
      "monid.run": { permission: "allow" as const },
      "mcp:linear/*": { permission: "deny" as const },
    };
    expect(ownSettings(answer, toolChoices([CAPS_TOOLS[2], { name: "web_fetch", providers: ["kernel", "parallel"], provider: "parallel", default_provider: "kernel" }]))).toEqual({
      web_search: { permission: "ask" },
      web_fetch: { provider: "parallel" },
      bash: { permission: "deny" },
      "monid.run": { permission: "allow" },
      "mcp:linear/*": { permission: "deny" },
    });
  });
});
