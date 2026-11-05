import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsList } from "./AgentsList";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// The console on a phone, each fix scoped to its viewport so the other is untouched. jsdom applies no media query, so
// these pin the variant classes and the structure; the walk measures real boxes at 390×844 and 844×390.
//  - Portrait only (a narrow, tall screen): the Agents search box drops its placeholder (only its first letter fitted)
//    and keeps the magnifying glass and its accessible name. Landscape and desktop keep the placeholder.
//  - Short viewports only (max-height 500px, a phone in landscape): the Playground's code panel folds behind Show code,
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
  const toggle = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => /^(Show|Hide) code$/.test((b.textContent ?? "").trim())) as HTMLButtonElement | undefined;

  it("folds the code panel behind Show code there, and only there: a taller viewport shows it as before", async () => {
    const host = open();
    expect(classes(codeSection(host))).toContain("short:hidden");
    const t = toggle(host);
    expect(t, "a Show code toggle").toBeTruthy();
    expect(t!.getAttribute("aria-expanded")).toBe("false");
    // The toggle shows only in a short viewport.
    expect(classes(t)).toContain("hidden");
    expect(classes(t)).toContain("short:inline-flex");
    await act(async () => { t!.click(); });
    expect(classes(codeSection(host))).not.toContain("short:hidden");
    expect(toggle(host)!.textContent?.trim()).toBe("Hide code");
    expect(toggle(host)!.getAttribute("aria-expanded")).toBe("true");
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
