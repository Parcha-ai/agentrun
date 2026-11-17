import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsList } from "./AgentsList";
import { MissionControl } from "./MissionControl";
import { Shell } from "./Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function show(element: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}
/** The icon's own name: lucide puts it in the svg's class (`lucide-layout-grid`). */
const iconOf = (el: Element | null | undefined) => [...(el?.querySelector("svg")?.classList ?? [])].find((c) => /^lucide-/.test(c) && c !== "lucide");

// A place has one icon: the page's header shows the one its navigation item does.
describe("a section's header icon", () => {
  const navIcon = (name: string) => {
    const host = show(createElement(Shell, { active: "mission", onNavigate: () => {}, onSignOut: () => {}, children: null }));
    const icon = iconOf([...host.querySelectorAll("nav button, nav a")].find((b) => b.textContent?.trim() === name));
    act(() => root?.unmount());
    document.body.innerHTML = "";
    return icon;
  };

  it("is the navigation's, for Mission Control", () => {
    const nav = navIcon("Mission Control");
    expect(nav).toBeTruthy();
    const host = show(createElement(MissionControl, { view: null }));
    expect(iconOf(host.querySelector("h1"))).toBe(nav);
  });

  it("is the navigation's, for Connected agents", () => {
    const nav = navIcon("Connected agents");
    expect(nav).toBeTruthy();
    const host = show(createElement(AgentsList, { agents: [] }));
    expect(iconOf(host.querySelector("h1"))).toBe(nav);
  });
});
