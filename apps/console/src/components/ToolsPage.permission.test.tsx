import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolsPage } from "./ToolsPage";
import { type ToolGate, toolChoices, toolGates } from "@/lib/toolSettings";
import type { ToolSettings } from "@/lib/v2";
import { optionsOf, pick, valueOf } from "@/test/picker";

// Settings → Tools: each tool's permission (allow, ask, deny) on this server, the owner's default named, beside the
// providers. A change is saved at once, as the whole of the server's settings: what the page does not show (a catalog
// tool's permission, an MCP server's wildcard) goes back as it was.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ALL = ["allow", "ask", "deny"];
const capsTools = (settings: ToolSettings, askNeeds = false) => [
  { name: "read", permissions: ALL, default_permission: "allow" },
  { name: "bash", permissions: ALL, default_permission: "allow" },
  { name: "ask_person", permissions: ["allow", "deny"], default_permission: "allow" },
  // web_fetch as the server lists it: a GET answers its provider filled in, which the page knows as the default.
  { name: "web_fetch", permissions: ALL, default_permission: "allow", providers: ["kernel", "parallel"], provider: settings.web_fetch?.provider ?? "kernel", default_provider: "kernel", resolves: { pi: "kernel", "claude-agent": "native", codex: "native" } },
  { name: "web_search", permissions: ALL, default_permission: "allow", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: settings.web_search?.provider ?? "auto", default_provider: "auto", resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } },
].map((t) => ({ ...t, available: true, permission: settings[t.name]?.permission ?? t.default_permission, ...(askNeeds && t.permissions.includes("ask") ? { ask_needs: "password" } : {}) }));

async function open(start: ToolSettings, { askNeeds = false }: { askNeeds?: boolean } = {}) {
  let held: ToolSettings = { ...start };
  // GET's answer: each capability's provider (its default filled in), and each permission set, by settings key.
  const whole = (): ToolSettings => ({ ...held, web_search: { provider: held.web_search?.provider ?? "auto", ...(held.web_search?.permission ? { permission: held.web_search.permission } : {}) }, web_fetch: { provider: held.web_fetch?.provider ?? "kernel" } });
  const puts: ToolSettings[] = [];
  const v2 = { toolSettings: async () => whole(), saveToolSettings: async (body: ToolSettings) => { puts.push(body); held = { ...body }; return whole(); } };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = () => act(() => {
    const raw = capsTools(held, askNeeds);
    const gates: ToolGate[] = toolGates(raw);
    root!.render(createElement(ToolsPage, { v2: v2 as never, choices: toolChoices(raw), gates, onSaved: () => render() }));
  });
  render();
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`tr[data-tool="${tool}"]`);
  const permission = (tool: string) => row(tool)!.querySelector<HTMLButtonElement>(`button[aria-haspopup=listbox][aria-label="${tool} permission"]`)!;
  const choose = async (tool: string, value: string) => {
    await pick(permission(tool), value);
    await settle();
  };
  return { host, puts, row, permission, choose };
}

describe("ToolsPage, each tool's permission", () => {
  it("lists every tool, each with the permissions offered for it and the owner's default named, in a table that scrolls on a phone", async () => {
    const page = await open({});
    expect(["read", "bash", "ask_person", "web_search"].map((t) => !!page.row(t))).toEqual([true, true, true, true]);
    expect((await optionsOf(page.permission("read"))).map((o) => o.text)).toEqual(["allow (default)", "ask", "deny"]);
    expect((await optionsOf(page.permission("ask_person"))).map((o) => o.text)).toEqual(["allow (default)", "deny"]);
    expect(valueOf(page.permission("bash"))).toBe("allow");
    // A tool with no provider choice says so in the provider column; web_search keeps its provider select.
    expect(page.row("read")!.querySelector("button[aria-haspopup=listbox][aria-label='read provider']")).toBeNull();
    expect(page.row("web_search")!.querySelector("button[aria-haspopup=listbox][aria-label='web_search provider']")).toBeTruthy();
    expect(page.host.querySelector("table")!.parentElement!.className).toMatch(/overflow-x-auto/);
    expect([...page.host.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Tool", "Permission", "Provider", "Resolves to", "Reset"]);
  });

  it("a permission set here is marked and saved with everything else the server holds, a catalog tool's and a wildcard's included", async () => {
    const page = await open({ web_search: { provider: "parallel" }, "monid.run": { permission: "allow" }, "mcp:linear/*": { permission: "deny" } });
    await page.choose("bash", "deny");
    expect(page.puts).toEqual([{ web_search: { provider: "parallel" }, bash: { permission: "deny" }, "monid.run": { permission: "allow" }, "mcp:linear/*": { permission: "deny" } }]);
    expect(page.row("bash")!.textContent).toContain("default: allow");
  });

  it("a provider change keeps every permission set", async () => {
    const page = await open({ web_search: { permission: "ask" }, bash: { permission: "deny" } });
    await pick(page.row("web_search")!.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox][aria-label='web_search provider']")!, "native");
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(page.puts).toEqual([{ web_search: { provider: "native", permission: "ask" }, bash: { permission: "deny" } }]);
  });

  it("choosing the default again drops the setting", async () => {
    const page = await open({ bash: { permission: "deny" } });
    await page.choose("bash", "allow");
    expect(page.puts).toEqual([{}]);
  });

  it("with accounts off, ask is offered disabled with why, and a tool already on ask says each call is refused", async () => {
    const page = await open({ "web_search": { permission: "ask" } }, { askNeeds: true });
    const ask = (await optionsOf(page.permission("read"))).find((o) => o.value === "ask")!;
    expect(ask.disabled).toBe(true);
    expect(page.host.textContent).toContain("Ask is off on this server: approving a call takes the owner's password sign-in, and this server runs with accounts off.");
    expect(page.row("web_search")!.textContent).toContain("Each call is refused: no one can approve it here.");
    expect(page.row("read")!.textContent).not.toContain("Each call is refused");
  });
});
