import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolsPage } from "./ToolsPage";
import type { McpServer } from "@/lib/mcp";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import type { ToolSettings } from "@/lib/v2";
import { optionsOf, pick, valueOf } from "@/test/picker";

// Settings → Tools lists each saved MCP server's tools (`mcp:<server>/<tool>`) beside the built-ins, each with the
// permission the server's read gives it (in force under this server's settings), its built-in default named, so the
// owner can see a server-wide setting, set it and undo it. The page keeps no rule of its own: a tool the read gives no
// permissions (a meta tool, never granted) has no row.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ALL = ["allow", "ask", "deny"] as ("allow" | "ask" | "deny")[];
const RAW = [{ name: "read", permissions: ALL, default_permission: "allow", available: true, permission: "allow" }];
const ITEM = "mcp:hn/HACKERNEWS_GET_ITEM_WITH_ID";
const USER = "mcp:hn/HACKERNEWS_GET_USER";

/** The hn server as GET /v2/settings/mcp-servers reads it under `settings`: each tool's permission in force (its key, else
 *  the server's wildcard, else ask), its default ask; and one meta tool the read gives no permissions. */
const hn = (settings: ToolSettings): McpServer => ({
  name: "hn", url: "https://mcp.example.test/mcp", auth: { type: "none" }, credential: null,
  tools: [
    ...["HACKERNEWS_GET_ITEM_WITH_ID", "HACKERNEWS_GET_USER"].map((name) => ({ name, permission: settings[`mcp:hn/${name}`]?.permission ?? settings["mcp:hn/*"]?.permission ?? ("ask" as const), default_permission: "ask" as const, permissions: ALL })),
    { name: "COMPOSIO_MULTI_EXECUTE_TOOL", grantable: false as const, reason: "a meta tool" },
  ],
});

async function open(start: ToolSettings, { mcp = true, failMcp = false } = {}) {
  let held: ToolSettings = { ...start };
  const puts: ToolSettings[] = [];
  let listed = 0;
  const v2 = {
    toolSettings: async () => ({ ...held }),
    saveToolSettings: async (body: ToolSettings) => { puts.push(body); held = { ...body }; return { ...held }; },
    listMcpServers: async () => { listed++; if (failMcp) throw new Error("offline"); return { servers: [hn(held)] }; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: toolChoices(RAW), gates: toolGates(RAW), mcp, onSaved: () => {} })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`tr[data-tool="${tool}"]`);
  const permission = (tool: string) => row(tool)!.querySelector<HTMLButtonElement>(`button[aria-haspopup=listbox][aria-label="${tool} permission"]`)!;
  const choose = async (tool: string, value: string) => { await pick(permission(tool), value); await settle(); };
  return { host, puts, row, permission, choose, listed: () => listed };
}

describe("ToolsPage, each saved MCP server's tools", () => {
  it("lists them with the permission in force, a server-wide deny marked, and never a tool the read gives no permissions", async () => {
    const page = await open({ [ITEM]: { permission: "deny" } });
    expect(valueOf(page.permission(ITEM))).toBe("deny");
    expect(page.row(ITEM)!.textContent).toContain("default: ask");
    expect(valueOf(page.permission(USER))).toBe("ask");
    expect((await optionsOf(page.permission(USER))).map((o) => o.text)).toEqual(["allow", "ask (default)", "deny"]);
    expect(page.row("mcp:hn/COMPOSIO_MULTI_EXECUTE_TOOL")).toBeNull();
    expect(page.row("read")).toBeTruthy();
  });

  it("a deny set here is saved with everything else, and choosing the default again undoes it", async () => {
    const page = await open({ bash: { permission: "deny" } });
    await page.choose(USER, "deny");
    expect(page.puts.at(-1)).toEqual({ bash: { permission: "deny" }, [USER]: { permission: "deny" } });
    await page.choose(USER, "ask");
    expect(page.puts.at(-1)).toEqual({ bash: { permission: "deny" } });
  });

  it("a server's wildcard is a tool's default here, as the server applies it", async () => {
    const page = await open({ "mcp:hn/*": { permission: "allow" } });
    expect(valueOf(page.permission(USER))).toBe("allow");
    expect((await optionsOf(page.permission(USER))).map((o) => o.text)).toEqual(["allow (default)", "ask", "deny"]);
  });

  it("a list that can't be read says so with Retry; a server with no MCP client lists none and never asks", async () => {
    const failed = await open({}, { failMcp: true });
    expect(failed.host.textContent).toContain("The MCP servers' tools could not be read");
    expect(failed.row("read")).toBeTruthy();
    act(() => root?.unmount());
    const off = await open({}, { mcp: false });
    expect(off.listed()).toBe(0);
    expect(off.row(USER)).toBeNull();
  });
});
