import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolTable, toolRows } from "./ToolSettings";
import { toolGates } from "@/lib/toolSettings";

// Beside a tool whose permission is deny, the tools table says what deny does not do: it stops that tool only, and the
// agent's other tools can still reach the web. The same table is Settings → Tools (the server's) and an agent's own tool
// settings; an allow or an ask says nothing of it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const LINE = "Deny stops this tool only. The agent can still reach the web with other tools it has, such as browser, bash or web_search: deny those too to keep it offline.";
const ALL = ["allow", "ask", "deny"];
const GATES = toolGates([
  { name: "web_fetch", available: true, permission: "deny", default_permission: "allow", permissions: ALL },
  { name: "read", available: true, permission: "allow", default_permission: "allow", permissions: ALL },
  { name: "bash", available: true, permission: "ask", default_permission: "allow", permissions: ALL },
]);

function table(settings: Record<string, { permission: string }>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ToolTable, {
    label: "Tool settings", rows: toolRows([], GATES), settings: settings as never, fallbackOf: () => "", resolvesOf: () => null, issues: {}, onEdit: () => {},
  })));
  const row = (name: string) => host.querySelector(`tr[data-tool="${name}"]`)!.textContent ?? "";
  return { row };
}

describe("the tools table beside a deny", () => {
  it("says deny stops that tool only, beside a tool set to deny; not beside allow or ask", () => {
    const { row } = table({ web_fetch: { permission: "deny" }, bash: { permission: "ask" } });
    expect(row("web_fetch")).toContain(LINE);
    expect(row("read")).not.toContain(LINE);
    expect(row("bash")).not.toContain(LINE);
  });

  it("says it once a tool's permission is deny by its default too, and not once it is set to allow", () => {
    const denied = toolGates([{ name: "web_search", available: true, permission: "deny", default_permission: "deny", permissions: ALL }]);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(ToolTable, { label: "Tool settings", rows: toolRows([], denied), settings: {}, fallbackOf: () => "", resolvesOf: () => null, issues: {}, onEdit: () => {} })));
    expect(host.querySelector('tr[data-tool="web_search"]')!.textContent).toContain(LINE);
    act(() => root!.render(createElement(ToolTable, { label: "Tool settings", rows: toolRows([], denied), settings: { web_search: { permission: "allow" } }, fallbackOf: () => "", resolvesOf: () => null, issues: {}, onEdit: () => {} })));
    expect(host.querySelector('tr[data-tool="web_search"]')!.textContent).not.toContain(LINE);
  });
});
