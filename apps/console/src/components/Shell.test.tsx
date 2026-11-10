import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "./Shell";
import { THEME_KEY } from "@/lib/theme";

// The sidebar's foot carries the theme: System (the OS's), Light or Dark. A pick shows at once and is kept in this browser.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; document.documentElement.className = ""; localStorage.clear(); });

function mount(props: Partial<ComponentProps<typeof Shell>> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Shell, { active: "mission", children: "page", ...props })));
  const group = host.querySelector('[role="group"][aria-label="Theme"]')!;
  const pick = (name: string) => [...group.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name)!;
  return { host, group, pick };
}

describe("Shell's hosted navigation", () => {
  it("offers Learning Dojo as a separate active destination", () => {
    const onNavigate = vi.fn();
    const { host } = mount({ active: "dojo", onNavigate });
    const dojo = [...host.querySelectorAll<HTMLButtonElement>('nav button')].find((b) => b.textContent?.trim() === "Learning Dojo")!;
    expect(dojo).toBeTruthy();
    expect(dojo.getAttribute("aria-current")).toBe("page");
    expect(dojo.closest("#agent-navigation")).toBeNull();
    act(() => dojo.click());
    expect(onNavigate).toHaveBeenCalledWith("dojo");
  });

  it("groups working local agent destinations and leaves Settings at the foot", () => {
    const onNavigate = vi.fn();
    const onBuild = vi.fn();
    const { host } = mount({ settings: true, onNavigate, onBuild });
    const navigation = host.querySelector('nav[aria-label="Navigation"]')!;
    const button = (name: string) => [...navigation.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;
    expect(button("API playground")).toBeTruthy();
    const toggle = button("Agents");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => button("Build").click());
    expect(onBuild).toHaveBeenCalledOnce();
    act(() => button("Connected agents").click());
    expect(onNavigate).toHaveBeenLastCalledWith("agents");
    act(() => button("Runs").click());
    expect(onNavigate).toHaveBeenLastCalledWith("runs");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('#agent-navigation')?.hasAttribute("hidden")).toBe(true);
    act(() => button("Settings").click());
    expect(onNavigate).toHaveBeenLastCalledWith("settings");
    expect(button("Settings").closest('[data-sidebar-account]')).not.toBeNull();
    expect(navigation.textContent).not.toMatch(/Billing|Teams|Deployments|Managed agents/);
  });

  it("highlights Build separately from Connected agents and opens the section on navigation", () => {
    const { host } = mount({ active: "agents", building: true });
    const current = () => host.querySelector('[aria-current="page"]')?.textContent?.trim();
    expect(current()).toBe("Build");
    const toggle = host.querySelector<HTMLButtonElement>('[aria-controls="agent-navigation"]')!;
    act(() => toggle.click());
    act(() => root!.render(createElement(Shell, { active: "runs", children: "page" })));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(current()).toBe("Runs");
  });

  it("closes mobile navigation after picking a destination", () => {
    const onNavigate = vi.fn();
    const { host } = mount({ onNavigate });
    const menu = host.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')!;
    act(() => menu.click());
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const destination = [...host.querySelectorAll<HTMLButtonElement>('nav button')].find((b) => b.textContent?.trim() === "Connected agents")!;
    act(() => destination.click());
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(onNavigate).toHaveBeenCalledWith("agents");
  });
});

describe("Shell's theme switch", () => {
  it("starts on System, and a pick goes on the page and into this browser", () => {
    const { group, pick } = mount();
    expect([...group.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["System", "Light", "Dark"]);
    expect(pick("System").getAttribute("aria-pressed")).toBe("true");
    act(() => pick("Light").click());
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(pick("Light").getAttribute("aria-pressed")).toBe("true");
    act(() => pick("Dark").click());
    expect([...document.documentElement.classList]).toEqual(["dark"]);
    act(() => pick("System").click());
    // The OS's scheme (light here: the test's browser has no dark preference).
    expect([...document.documentElement.classList]).toEqual(["light"]);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("opens on the pick this browser kept", () => {
    localStorage.setItem(THEME_KEY, "dark");
    const { pick } = mount();
    expect(pick("Dark").getAttribute("aria-pressed")).toBe("true");
  });
});

// On a short screen (a phone on its side, 844x390) the sidebar is taller than the window: it scrolls, so Sign out at its
// foot is always reachable.
describe("Shell's sidebar on a short screen", () => {
  it("scrolls navigation while keeping Sign out reachable at its foot", () => {
    const { host } = mount();
    const aside = host.querySelector("aside")!;
    const navigation = aside.querySelector('nav[aria-label="Navigation"]')!;
    const signOut = [...aside.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Sign out")!;
    expect(aside.className.split(" ")).toContain("md:h-dvh");
    expect(navigation.className.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]));
    expect(navigation.contains(signOut)).toBe(false);
    expect(signOut.parentElement?.className.split(" ")).toContain("shrink-0");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')!.click());
    expect(aside.className.split(" ")).toEqual(expect.arrayContaining(["max-h-[60dvh]", "overflow-y-auto"]));
  });
});

describe("Shell's navigation", () => {
  const items = (triggers?: boolean) => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Shell, { active: "triggers", triggers, children: "page" })));
    return [...host.querySelectorAll('nav[aria-label="Navigation"] button')].map((b) => b.textContent?.trim());
  };
  it("offers Triggers where the server has them, after Runs, and not where it does not", () => {
    expect(items(true)).toEqual(["Mission Control", "API playground", "Agents", "Build", "Connected agents", "Templates", "Runs", "Triggers", "Learning Dojo"]);
    act(() => root?.unmount());
    expect(items(false)).toEqual(["Mission Control", "API playground", "Agents", "Build", "Connected agents", "Templates", "Runs", "Learning Dojo"]);
  });
});
