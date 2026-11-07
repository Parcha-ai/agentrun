import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Shell } from "./Shell";
import { THEME_KEY } from "@/lib/theme";

// The sidebar's foot carries the theme: System (the OS's), Light or Dark. A pick shows at once and is kept in this browser.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; document.documentElement.className = ""; localStorage.clear(); });

function mount() {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Shell, { active: "mission", children: "page" })));
  const group = host.querySelector('[role="group"][aria-label="Theme"]')!;
  const pick = (name: string) => [...group.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name)!;
  return { group, pick };
}

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
  it("scrolls at every width it shows at", () => {
    mount();
    const aside = document.querySelector("aside")!;
    expect(aside.className.split(" ")).toContain("md:overflow-y-auto");
  });
});

describe("Shell's navigation", () => {
  const items = (schedules?: boolean) => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Shell, { active: "schedules", schedules, children: "page" })));
    return [...host.querySelectorAll('nav[aria-label="Navigation"] button')].map((b) => b.textContent?.trim());
  };
  it("offers Schedules where the server has them, after Runs, and not where it does not", () => {
    expect(items(true)).toEqual(["Mission Control", "Playground", "Agents", "Runs", "Schedules"]);
    act(() => root?.unmount());
    expect(items(false)).toEqual(["Mission Control", "Playground", "Agents", "Runs"]);
  });
});
