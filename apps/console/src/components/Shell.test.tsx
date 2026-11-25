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

  it("offers flat Agents, Templates and Runs destinations and leaves Settings at the foot", () => {
    const onNavigate = vi.fn();
    const { host } = mount({ settings: true, onNavigate });
    const navigation = host.querySelector('nav[aria-label="Navigation"]')!;
    const button = (name: string) => [...navigation.querySelectorAll("button")].find(control => control.textContent?.trim() === name)!;
    expect(button("Build")).toBeUndefined();
    expect(button("Connected agents")).toBeUndefined();
    expect(button("Agents").getAttribute("aria-expanded")).toBeNull();
    expect(host.querySelector("#agent-navigation")).toBeNull();
    for (const [label, destination] of [["Agents", "agents"], ["Templates", "templates"], ["Runs", "runs"]]) {
      expect(button(label).parentElement).toBe(button("API playground").parentElement);
      act(() => button(label).click());
      expect(onNavigate).toHaveBeenLastCalledWith(destination);
    }
    act(() => button("Settings").click());
    expect(onNavigate).toHaveBeenLastCalledWith("settings");
    expect(button("Settings").closest('[data-sidebar-account]')).not.toBeNull();
    expect(navigation.textContent).not.toMatch(/Billing|Teams|Deployments|Managed agents/);
  });

  it("highlights each flat agent destination as its page becomes active", () => {
    const { host } = mount({ active: "agents" });
    const current = () => host.querySelector('[aria-current="page"]')?.textContent?.trim();
    expect(current()).toBe("Agents");
    act(() => root!.render(createElement(Shell, { active: "templates", children: "page" })));
    expect(current()).toBe("Templates");
    act(() => root!.render(createElement(Shell, { active: "runs", children: "page" })));
    expect(current()).toBe("Runs");
  });

  it("closes mobile navigation after picking a destination", () => {
    const onNavigate = vi.fn();
    const { host } = mount({ onNavigate });
    const menu = host.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')!;
    act(() => menu.click());
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const destination = [...host.querySelectorAll<HTMLButtonElement>('nav button')].find((b) => b.textContent?.trim() === "Agents")!;
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
    expect(aside.className.split(" ")).toContain("roomy:h-dvh");
    expect(navigation.className.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]));
    expect(navigation.contains(signOut)).toBe(false);
    expect(signOut.parentElement?.className.split(" ")).toContain("shrink-0");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')!.click());
    expect(aside.className.split(" ")).toEqual(expect.arrayContaining(["max-h-[60dvh]", "overflow-y-auto"]));
  });

  // jsdom applies no media query: the sidebar's variant is `roomy:` (md wide AND over 500 px tall), never `md:` alone, so a phone
  // on its side gets the top bar. The e2e flow phone-landscape measures it in a real browser.
  it("shows at roomy sizes only, never at a plain md width", () => {
    mount();
    const all = [document.querySelector("aside")!, document.querySelector("header")!, document.querySelector("aside")!.parentElement!];
    for (const el of all) expect(el.className.split(" ").some((c) => c.startsWith("md:"))).toBe(false);
    expect(document.querySelector("header")!.className.split(" ")).toContain("roomy:hidden");
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
    expect(items(true)).toEqual(["Mission Control", "API playground", "Free", "Agents", "Suggested", "Templates", "Runs", "Triggers", "Learning Dojo"]);
    act(() => root?.unmount());
    expect(items(false)).toEqual(["Mission Control", "API playground", "Free", "Agents", "Suggested", "Templates", "Runs", "Learning Dojo"]);
  });
});

describe("Shell, for the keyboard and the browser's tab", () => {
  it("names the place in the document's title", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Shell, { active: "runs", children: "page" })));
    expect(document.title).toBe("Runs · AgentRun");
    act(() => root!.render(createElement(Shell, { active: "agents", children: "page" })));
    expect(document.title).toBe("Agents · AgentRun");
  });

  it("starts with a control that puts the focus on the page, past the navigation", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Shell, { active: "mission", children: "page" })));
    const first = host.querySelector("button, a[href], input")!;
    expect(first.textContent).toBe("Skip to the page");
    act(() => (first as HTMLButtonElement).click());
    expect(document.activeElement).toBe(host.querySelector("main"));
  });
});
