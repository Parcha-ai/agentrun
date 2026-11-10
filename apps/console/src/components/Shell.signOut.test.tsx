import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Shell } from "./Shell";

// Sign out signs out this browser. Signing out every browser and phone is its own action, below it, and asks first, in
// one line that says what it does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const CONFIRM = "Signs out every browser and phone signed in to this server, this one too.";

function mount() {
  const said: string[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Shell, { active: "mission", onSignOut: () => said.push("this browser"), onSignOutEverywhere: () => said.push("everywhere"), children: "page" } as never)));
  const button = (name: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === name);
  return { host, said, button };
}

describe("Shell's sign-outs", () => {
  it("Sign out signs out this browser only", () => {
    const p = mount();
    act(() => p.button("Sign out")[0]!.click());
    expect(p.said).toEqual(["this browser"]);
  });

  it("Sign out everywhere asks first, in its one line, and goes only on the confirm", () => {
    const p = mount();
    expect(p.host.textContent).not.toContain(CONFIRM);
    act(() => p.button("Sign out everywhere")[0]!.click());
    expect(p.said).toEqual([]);
    expect(p.host.querySelector('[role="alertdialog"]')?.textContent).toContain(CONFIRM);
    act(() => p.button("Cancel")[0]!.click());
    expect(p.host.textContent).not.toContain(CONFIRM);
    expect(p.said).toEqual([]);
    act(() => p.button("Sign out everywhere")[0]!.click());
    const dialog = p.host.querySelector('[role="alertdialog"]') as HTMLElement;
    act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sign out everywhere")!.click());
    expect(p.said).toEqual(["everywhere"]);
  });

  it("keeps the keyboard's place: opening it focuses Cancel, Cancel or Escape closes it and focuses its trigger again", () => {
    const p = mount();
    act(() => p.button("Sign out everywhere")[0]!.click());
    expect((document.activeElement as HTMLElement | null)?.textContent?.trim()).toBe("Cancel");
    act(() => p.button("Cancel")[0]!.click());
    expect(p.host.querySelector('[role="alertdialog"]')).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.textContent?.trim()).toBe("Sign out everywhere");
    act(() => p.button("Sign out everywhere")[0]!.click());
    const dialog = p.host.querySelector('[role="alertdialog"]') as HTMLElement;
    act(() => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(p.host.querySelector('[role="alertdialog"]')).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.textContent?.trim()).toBe("Sign out everywhere");
    expect(p.said).toEqual([]);
  });
  it("keeps the scrollbar on the page's own box: the window's box clips, and both hold what is positioned inside them", () => {
    // Text kept for a screen reader alone (sr-only) is absolutely positioned. With no positioned box around it, it is
    // placed in the document and stretches it past the window, so the whole console scrolls away.
    const p = mount();
    const main = p.host.querySelector("main")!;
    const outer = main.closest(".h-dvh")!;
    expect(outer.className).toMatch(/(?:^| )relative(?: |$)/);
    expect(outer.className).toMatch(/(?:^| )overflow-hidden(?: |$)/);
    expect(main.className).toMatch(/(?:^| )relative(?: |$)/);
    expect(main.className).toMatch(/(?:^| )overflow-auto(?: |$)/);
  });
});
