import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Banner, Button, Checkbox, Chip, ConfirmDialog, Dialog, Field, fieldBoxClass, Input, Menu, MenuItem, NavItem, Segmented, Spinner, Tabs, Textarea, ToastProvider, useToast } from ".";
import * as foundations from "@/design/Foundations.stories";
import * as primitives from "./Primitives.stories";

// What each primitive promises a person on a keyboard or a screen reader (docs/console-design-system.md), checked on the
// rendered DOM.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver; });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function mount(node: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); }); await settle(); };
const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Button", () => {
  it("draws its text on the solid fill in the fill's own foreground, never a literal", () => {
    const solid = html(<Button variant="solid">Run</Button>);
    expect(solid).toContain("text-primary-foreground");
    expect(solid).not.toMatch(/text-(black|white)/);
  });
  it("has a size for every control height, and xs for a row", () => {
    for (const [size, cls] of [["xs", "h-7"], ["sm", "h-control-sm"], ["md", "h-control-md"], ["lg", "h-control-lg"], ["icon", "size-control-sm"]] as const) expect(html(<Button size={size}>x</Button>)).toContain(cls);
  });
});

describe("Chip", () => {
  it("writes each tone's words in the tone's -text colour", () => {
    for (const [tone, cls] of [["success", "text-success-text"], ["warning", "text-warning-text"], ["error", "text-destructive-text"], ["info", "text-info-text"], ["active", "text-run-active"]] as const) expect(html(<Chip tone={tone}>x</Chip>)).toContain(cls);
  });
});

describe("Field", () => {
  it("names its control by the label and describes it by the note and the error, which marks it refused", () => {
    const host = mount(<Field label="Cost cap" note="In dollars." error="Enter an amount."><Input /></Field>);
    const input = host.querySelector("input")!;
    const label = host.querySelector("label")!;
    expect(label.htmlFor).toBe(input.id);
    expect(input.id).not.toBe("");
    const described = input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["In dollars.", "Enter an amount."]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Enter an amount.");
  });
  it("keeps the caller's id, and a field with no error is not marked refused", () => {
    const host = mount(<Field label="Instructions" id="agent-instructions"><Textarea /></Field>);
    const area = host.querySelector("textarea")!;
    expect(area.id).toBe("agent-instructions");
    expect(host.querySelector("label")!.htmlFor).toBe("agent-instructions");
    expect(area.hasAttribute("aria-invalid")).toBe(false);
    expect(area.hasAttribute("aria-describedby")).toBe(false);
  });
  it("as a group, names the set of controls and leaves each its own label", () => {
    const host = mount(<Field group label="Tools" note="What the agent may use."><Checkbox label="web_fetch" /><Checkbox label="shell" /></Field>);
    const group = host.querySelector('[role="group"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Tools");
    expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toBe("What the agent may use.");
    expect([...host.querySelectorAll("label")].map((l) => l.textContent)).toEqual(["web_fetch", "shell"]);
    expect(host.querySelector("input")!.id).toBe("");
  });
  it("a hint after the control describes it too, in reading order: note, hint, error", () => {
    const host = mount(<Field label="At" note="Your time." hint="= 09:00 UTC" error="In the past."><Input /></Field>);
    const described = host.querySelector("input")!.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Your time.", "= 09:00 UTC", "In the past."]);
  });
  it("a bare control draws no edge of its own; its box shows the focus for it", () => {
    const out = html(<span className={fieldBoxClass}><Input bare aria-label="Search" /></span>);
    expect(out).toContain("focus-within:outline-ring");
    expect(out.match(/<input[^>]*>/)![0]).not.toMatch(/\bborder\b/);
    expect(out.match(/<input[^>]*>/)![0]).toContain("bg-transparent");
  });
  it("as a heading only, adds no group round controls that name themselves", () => {
    const host = mount(<Field group="heading" label="Range"><div role="radiogroup" aria-label="Range" /></Field>);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(host.querySelector("label")).toBeNull();
    expect(host.querySelector("span")!.textContent).toBe("Range");
  });
  it("a control outside a Field takes its own props", () => {
    expect(html(<Input id="q" aria-describedby="hint" />)).toMatch(/id="q"[^>]*aria-describedby="hint"|aria-describedby="hint"[^>]*id="q"/);
  });
});

describe("Banner", () => {
  it("interrupts for an error and waits its turn for every other tone", () => {
    expect(mount(<Banner tone="error" title="Not saved" />).querySelector('[role="alert"]')?.textContent).toBe("Not saved");
    for (const tone of ["neutral", "info", "success", "warning"] as const) expect(html(<Banner tone={tone}>x</Banner>), tone).toContain('role="status"');
  });
  it("says its tone with an icon as well as a colour, hidden from a screen reader", () => {
    const host = mount(<Banner tone="warning" title="Enter these keys again">Why.</Banner>);
    expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("p")?.className).toContain("text-warning-text");
  });
});

describe("Dialog", () => {
  function Demo({ onClosed }: { onClosed?: () => void }) {
    const [open, setOpen] = useState(false);
    return (<>
      <button type="button" id="opener" onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onClose={() => { setOpen(false); onClosed?.(); }} title="New schedule" description="Runs the agent at a time you set." footer={<Button>Create</Button>}><Input aria-label="When" /></Dialog>
    </>);
  }
  it("is a modal dialog named by its title and described by its description", async () => {
    const host = mount(<Demo />);
    await click(host.querySelector("#opener")!);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("New schedule");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Runs the agent at a time you set.");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
  it("closes on Escape and on its Close button", async () => {
    const closed = vi.fn();
    const host = mount(<Demo onClosed={closed} />);
    await click(host.querySelector("#opener")!);
    await key(document.activeElement!, "Escape");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(host.querySelector("#opener")!);
    await click(document.querySelector('[role="dialog"] button[aria-label="Close"]')!);
    expect(closed).toHaveBeenCalledTimes(2);
  });
});

describe("ConfirmDialog", () => {
  it("starts the keyboard on Cancel, names the action, and does it only when asked", async () => {
    const [confirm, cancel] = [vi.fn(), vi.fn()];
    mount(<ConfirmDialog open title="Delete invoice-checker?" confirm="Delete agent" onConfirm={confirm} onCancel={cancel}>This cannot be undone.</ConfirmDialog>);
    await settle();
    const buttons = [...document.querySelectorAll('[role="dialog"] button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Delete agent"]);
    expect(document.activeElement).toBe(buttons[0]);
    await key(document.activeElement!, "Escape");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    await click(buttons[1]!);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("while busy, neither button answers and Escape does not close it", async () => {
    const cancel = vi.fn();
    mount(<ConfirmDialog open busy title="Delete?" confirm="Delete agent" onConfirm={() => {}} onCancel={cancel} />);
    await settle();
    const buttons = [...document.querySelectorAll('[role="dialog"] button')] as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    await key(document.querySelector('[role="dialog"]')!, "Escape");
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("Menu", () => {
  it("opens a menu of items from a button that says it has one, and does the picked action", async () => {
    const edit = vi.fn();
    const host = mount(<Menu trigger="Actions"><MenuItem onSelect={edit}>Edit</MenuItem><MenuItem onSelect={() => {}} disabled>Archive</MenuItem></Menu>);
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(["Edit", "Archive"]);
    expect(items[1]!.getAttribute("aria-disabled")).toBe("true");
    await click(items[0]!);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("names an icon-only button by its label", () => {
    expect(mount(<Menu trigger={<svg aria-hidden />} label="More actions"><MenuItem onSelect={() => {}}>x</MenuItem></Menu>).querySelector("button")!.getAttribute("aria-label")).toBe("More actions");
  });
});

describe("Toast", () => {
  function Say({ tone, duration }: { tone?: "success" | "error"; duration?: number }) {
    const toast = useToast();
    return <button type="button" onClick={() => toast({ title: `Saved ${tone ?? ""}`.trim(), tone, duration })}>say</button>;
  }
  it("says a status politely, leaves by itself, and an error interrupts and stays", async () => {
    vi.useFakeTimers();
    const host = mount(<ToastProvider><Say tone="success" /><Say tone="error" /></ToastProvider>);
    const [ok, bad] = [...host.querySelectorAll("button")];
    act(() => { ok!.click(); bad!.click(); });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Saved success");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Saved error");
    act(() => { vi.advanceTimersByTime(5000); });
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    act(() => { (document.querySelector('[role="alert"] button[aria-label="Dismiss"]') as HTMLElement).click(); });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it("waits while the pointer is on it, and shows at most three", () => {
    vi.useFakeTimers();
    const host = mount(<ToastProvider><Say /></ToastProvider>);
    const say = host.querySelector("button")!;
    act(() => { say.click(); });
    const card = document.querySelector('[role="status"]')!;
    act(() => { card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(20000); });
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    act(() => { say.click(); say.click(); say.click(); say.click(); });
    expect(document.querySelectorAll('[role="status"]').length).toBe(3);
  });
  it("outside a provider, a toast is nothing and throws nothing", () => {
    const host = mount(<Say />);
    expect(() => act(() => host.querySelector("button")!.click())).not.toThrow();
  });
});

describe("Tabs", () => {
  function Demo() {
    const [tab, setTab] = useState<"a" | "b" | "c">("a");
    return <Tabs label="Agent" value={tab} onChange={setTab} tabs={[{ id: "a", label: "Overview" }, { id: "b", label: "Runs" }, { id: "c", label: "Learning" }]} />;
  }
  it("is one Tab stop; arrows, Home and End move the open tab and the focus with it", async () => {
    const host = mount(<Demo />);
    const tabs = () => [...host.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    const open = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")!.textContent;
    expect(host.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("Agent");
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    await key(tabs()[0]!, "ArrowRight");
    expect(open()).toBe("Runs");
    expect(document.activeElement).toBe(tabs()[1]);
    await key(tabs()[1]!, "End");
    expect(open()).toBe("Learning");
    await key(tabs()[2]!, "ArrowRight");
    expect(open()).toBe("Overview");
    await key(tabs()[0]!, "ArrowLeft");
    expect(open()).toBe("Learning");
    await key(tabs()[2]!, "Home");
    expect(open()).toBe("Overview");
    await click(tabs()[1]!);
    expect(open()).toBe("Runs");
  });
});

describe("Segmented, NavItem, Spinner", () => {
  it("Segmented is a named radio group whose pick is the checked radio", async () => {
    const picked = vi.fn();
    const host = mount(<Segmented label="Range" name="range" value="7d" onChange={picked} options={[{ value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days", disabled: true }]} />);
    expect(host.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Range");
    const radios = [...host.querySelectorAll("input")] as HTMLInputElement[];
    expect(radios.map((r) => [r.name, r.checked, r.disabled])).toEqual([["range", false, false], ["range", true, false], ["range", false, true]]);
    await click(radios[0]!);
    expect(picked).toHaveBeenCalledWith("24h");
  });
  it("NavItem says which place you are on", () => {
    expect(html(<NavItem active>Agents</NavItem>)).toContain('aria-current="page"');
    expect(html(<NavItem>Runs</NavItem>)).not.toContain("aria-current");
  });
  it("Spinner says what it waits for only when asked to", () => {
    expect(html(<Spinner label="Reading the runs" />)).toContain('role="status"');
    expect(html(<Spinner />)).not.toContain("role=");
  });
});

describe("the design-system stories", () => {
  it("every story renders, in a light and a dark panel", async () => {
    for (const [file, stories] of [["Foundations", foundations], ["Primitives", primitives]] as const) {
      for (const [name, story] of Object.entries(stories)) {
        if (name === "default") continue;
        const host = mount((story as { render: () => ReactElement }).render());
        await settle();
        expect([...host.querySelectorAll("[data-theme]")].map((panel) => panel.getAttribute("data-theme")), `${file}/${name}`).toEqual(["light", "dark"]);
        expect(host.querySelector('[data-theme="dark"]')!.textContent!.length, `${file}/${name}`).toBeGreaterThan(20);
        act(() => root?.unmount());
        root = undefined;
      }
    }
  });
});
