import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsList } from "./AgentsList";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// The console on a phone, each fix scoped to its viewport so the other is untouched. jsdom applies no media query, so
// these pin the variant classes and the structure; the walk measures real boxes at 390×844 and 844×390.
//  - Portrait only (a narrow, tall screen): the Agents search box drops its placeholder (only its first letter fitted)
//    and keeps the magnifying glass and its accessible name. Landscape and desktop keep the placeholder.
//  - Short viewports only (max-height 500px, a phone in landscape): the Playground's code panel starts folded behind Show code and response,
//    so the form gets the height; the agent header keeps its place; Send sits in its own row. Taller ones are unchanged.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const classes = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/);

function mount(el: React.ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

describe("Agents search box, portrait", () => {
  it("in portrait on a narrow screen the placeholder is not shown, the magnifier and the accessible name stay; elsewhere the placeholder stays", () => {
    const host = mount(createElement(AgentsList, { agents: [agentFixture("invoice-checker")] }));
    const input = host.querySelector('input[aria-label="Search agents"]');
    expect(input).not.toBeNull();
    // The placeholder is still there for wider screens and landscape; only a narrow portrait screen hides it.
    expect(input!.getAttribute("placeholder")).toBe("Search agents by name or description...");
    expect(classes(input)).toContain("max-sm:portrait:placeholder:text-transparent");
    expect(classes(input).some((c) => /^landscape:/.test(c))).toBe(false);
    expect(input!.closest("label")?.querySelector("svg")).not.toBeNull();
  });
});

describe("Playground in a short viewport (a phone in landscape)", () => {
  const base = agentFixture("invoice-checker");
  const open = () => mount(createElement(Playground, { agents: [base], efforts: [], origin: "http://serve.test", agentId: base.agent_id }));
  const codeSection = (host: HTMLElement) => host.querySelector('section[aria-label="Code and response"]');
  const toggle = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => /^(Show|Hide) code and response$/.test((b.textContent ?? "").trim())) as HTMLButtonElement | undefined;
  const body = (host: HTMLElement) => [...host.querySelectorAll("[id]")].find((e) => e.id === toggle(host)!.getAttribute("aria-controls")) ?? null;
  const request = (host: HTMLElement) => host.querySelector('section[aria-label="Request"]');
  // The panel starts open only where the two stand side by side: a wide and tall window.
  const short = (isShort: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: !isShort && query === "(min-width: 1024px) and (min-height: 501px)", media: query, addEventListener() {}, removeEventListener() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it("starts with the code panel folded to its bar there, and Show code and response puts it in the form's place", async () => {
    short(true);
    const host = open();
    const t = toggle(host);
    expect(t, "a Show code and response button").toBeTruthy();
    expect(t!.textContent?.trim()).toBe("Show code and response");
    expect(t!.getAttribute("aria-expanded")).toBe("false");
    expect(classes(body(host))).toContain("hidden");
    expect(classes(request(host))).not.toContain("short:hidden");
    await act(async () => { t!.click(); });
    expect(toggle(host)!.textContent?.trim()).toBe("Hide code and response");
    expect(toggle(host)!.getAttribute("aria-expanded")).toBe("true");
    expect(classes(body(host))).not.toContain("hidden");
    // One panel at a time in a short viewport: open, the code panel takes the form's place.
    expect(classes(request(host))).toContain("short:hidden");
  });

  it("a wide, tall window starts with the code panel open, and its own button folds it to one bar under the form", async () => {
    short(false);
    const host = open();
    const grid = request(host)!.parentElement;
    expect(toggle(host)!.textContent?.trim()).toBe("Hide code and response");
    expect(classes(body(host))).not.toContain("hidden");
    expect(classes(grid)).toContain("lg:[@media(min-height:501px)]:grid-cols-2");
    await act(async () => { toggle(host)!.click(); });
    expect(toggle(host)!.textContent?.trim()).toBe("Show code and response");
    expect(toggle(host)!.getAttribute("aria-expanded")).toBe("false");
    // Folded, the panel stays in the page (a run followed there keeps its place) and the form gets the whole width.
    expect(body(host)).not.toBeNull();
    expect(classes(body(host))).toContain("hidden");
    expect(classes(grid)).not.toContain("lg:[@media(min-height:501px)]:grid-cols-2");
    expect(classes(grid)).toContain("grid-rows-[minmax(0,1fr)_auto]");
  });

  it("a wide but short window gets one column too: the two-column grid applies only when the window is tall enough, so a folded panel leaves no half of the page empty", () => {
    const host = open();
    const grid = host.querySelector('section[aria-label="Request"]')!.parentElement;
    expect(classes(grid)).not.toContain("lg:grid-cols-2");
    expect(classes(grid)).toContain("lg:[@media(min-height:501px)]:grid-cols-2");
    expect(classes(grid)).toContain("grid-cols-1");
  });

  it("the agent header keeps its place and the page itself does not scroll: the form's own area scrolls", () => {
    const host = open();
    const header = host.querySelector('[aria-label="Playground agent"]');
    expect(header, "the agent header row").not.toBeNull();
    expect(classes(header)).toContain("shrink-0");
    const page = host.firstElementChild;
    expect(classes(page)).toContain("overflow-hidden");
  });

  it("Send request sits in its own row, inside the request section's footer, never on its edge", () => {
    const host = open();
    const send = [...host.querySelectorAll("button")].find((b) => /Send request/.test(b.textContent ?? ""));
    const footer = send?.closest("footer");
    expect(footer, "Send request inside a footer").toBeTruthy();
    expect(classes(footer)).toContain("shrink-0");
    expect(footer!.closest('section[aria-label="Request"]')).not.toBeNull();
  });
});
