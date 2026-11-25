import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Banner, Button, Checkbox, Chip, ConfirmDialog, CopyButton, Dialog, Field, fieldBoxClass, Input, Menu, MenuItem, NavItem, Picker, SearchPicker, type SearchPickerOption, Segmented, Spinner, tabPanelProps, Tabs, Textarea, ToastProvider, useToast } from ".";
import * as foundations from "@/design/Foundations.stories";
import * as primitives from "./Primitives.stories";
import { searchPick, searchPicker, shownIn } from "@/test/search-picker";

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
  it("uses the translucent primary treatment for both primary spellings", () => {
    const primary = html(<Button variant="primary">Run</Button>);
    expect(html(<Button variant="solid">Run</Button>)).toBe(primary);
    expect(primary).toContain("border-transparent");
    expect(primary).toContain("bg-primary/10");
    expect(primary).toContain("text-primary-action-text");
    expect(primary).not.toMatch(/text-(black|white)|\sbg-primary\s/);
  });
  it("has a size for every control height, and xs for a row", () => {
    for (const [size, cls] of [["xs", "h-7"], ["sm", "h-control-sm"], ["md", "h-control-md"], ["lg", "h-control-lg"], ["icon", "size-control-sm"]] as const) expect(html(<Button size={size}>x</Button>)).toContain(cls);
  });
});

describe("CopyButton", () => {
  afterEach(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
  it("is a button named by its label; one press writes the text and says Copied in a status a screen reader reads", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (t: string) => { writes.push(t); }) } });
    const host = mount(<CopyButton text="whsec_example" label="Copy secret" />);
    const button = host.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent?.trim()).toBe("Copy secret");
    expect(host.querySelector('[role="status"]')).toBeNull();
    await click(button);
    expect(writes).toEqual(["whsec_example"]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Copied");
  });
  it("with no clipboard (a page that is not secure), or a write the browser refuses, says to select the text instead", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    let host = mount(<CopyButton text="x" label="Copy URL" />);
    await click(host.querySelector("button")!);
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/Select it and copy it/);
    act(() => root?.unmount()); document.body.innerHTML = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    host = mount(<CopyButton text="x" label="Copy URL" />);
    await click(host.querySelector("button")!);
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/Select it and copy it/);
  });
});

describe("Chip", () => {
  it("writes each tone's words in the tone's -text colour", () => {
    for (const [tone, cls] of [["success", "text-success-text"], ["warning", "text-warning-text"], ["error", "text-destructive-text"], ["info", "text-info-text"], ["active", "text-run-active"]] as const) expect(html(<Chip tone={tone}>x</Chip>)).toContain(cls);
  });
  it("carries the CSS contract that keeps a status badge whole in a narrow row (\"INPUT REQUI\"): its words on one line, its own width, never shrunk", () => {
    // jsdom measures no layout, so this checks the classes the row's cut depends on; the measured cut (scrollWidth == clientWidth
    // in a real browser) is the autoqa step in QA.md (Beta.35, #3).
    const chip = mount(<Chip tone="warning">Input required</Chip>).querySelector("span.caps")!;
    expect(chip.textContent).toBe("Input required");
    expect(chip.className.split(" ")).toEqual(expect.arrayContaining(["whitespace-nowrap", "shrink-0"]));
  });
  it("a label chip (words of any length) shrinks with its row and cuts its words with an ellipsis, whole on hover; it is never shrink-0", () => {
    const chip = mount(<Chip label title="a long workflow node name">a long workflow node name</Chip>).querySelector("span.caps")!;
    expect(chip.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0"]));
    expect(chip.className.split(" ")).not.toContain("shrink-0");
    expect(chip.querySelector("span")!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(chip.getAttribute("title")).toBe("a long workflow node name");
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
  it("a picker inside a Field is described by the note and the error, so a screen reader says them with it", () => {
    const options = [{ value: "a", label: "Opus 5.5" }, { value: "b", label: "Sonnet 5.5" }];
    const host = mount(<Field label="Model" note="The agent's model." error="This harness can't run it."><Picker label="Model" value="a" onChange={() => {}} options={options} /></Field>);
    const button = host.querySelector("button")!;
    expect(host.querySelector("label")!.htmlFor).toBe(button.id);
    const described = (button.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["The agent's model.", "This harness can't run it."]);
    expect(button.getAttribute("aria-invalid")).toBe("true");
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
  it("as a bar, stands at least 48px tall so its bottom edge meets the edge under the navigation's logo row", () => {
    const bar = mount(<Banner bar tone="info" actions={<Button size="xs">Turn off</Button>}>Demo mode.</Banner>).querySelector('[role="status"]')!;
    expect(bar.className.split(" ")).toEqual(expect.arrayContaining(["min-h-12", "items-center", "border-b"]));
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
  it("stays while the keyboard is on it, though the pointer came and went", () => {
    vi.useFakeTimers();
    const host = mount(<ToastProvider><Say /></ToastProvider>);
    act(() => { host.querySelector("button")!.click(); });
    const card = document.querySelector('[role="status"]')!;
    act(() => { (card.querySelector("button") as HTMLElement).focus(); });
    act(() => { card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(20000); });
    expect(document.querySelector('[role="status"]')).not.toBeNull();
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

describe("Tabs and their panel", () => {
  it("with an id, each tab controls its panel and the panel is named by its tab", () => {
    const host = mount(<><Tabs id="agent" value="b" onChange={() => {}} tabs={[{ id: "a", label: "Overview" }, { id: "b", label: "Runs" }]} /><div {...tabPanelProps("agent", "b")} /></>);
    const tab = host.querySelector('[role="tab"][aria-selected="true"]')!;
    const panel = host.querySelector('[role="tabpanel"]')!;
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
  });
  it("a value that is no tab leaves the first tab reachable", () => {
    const host = mount(<Tabs value={"gone" as "a"} onChange={() => {}} tabs={[{ id: "a", label: "Overview" }, { id: "b", label: "Runs" }]} />);
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => (t as HTMLElement).tabIndex)).toEqual([0, -1]);
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

// A picker sized by its words changes width with each pick unless it is `steady`. jsdom lays nothing out, so this holds
// what the width comes from: every option's words in the field, hidden, in the picked words' own grid cell.
describe("Picker, steady", () => {
  const options = [{ value: "a", label: "GET · Short" }, { value: "b", label: "POST · The longest of them all" }];
  const sizers = (host: HTMLElement) => [...host.querySelectorAll("button [data-picker-sizer]")];

  it("holds every option's words in the field, hidden from sight and from a screen reader, whichever is picked", () => {
    const host = mount(<Picker steady label="Operation" value="a" onChange={() => {}} options={options} />);
    expect(sizers(host).map((n) => n.textContent)).toEqual(["GET · Short", "POST · The longest of them all"]);
    for (const n of sizers(host)) { expect(n.getAttribute("aria-hidden")).toBe("true"); expect(n.className).toContain("invisible"); expect(n.className).toContain("row-start-1"); }
    expect(host.querySelector("button")!.getAttribute("aria-label")).toBe("Operation");
  });

  it("opens a list no narrower than its longest row", async () => {
    const host = mount(<Picker steady label="Operation" value="a" onChange={() => {}} options={options} />);
    await click(host.querySelector("button")!);
    expect(document.querySelector("[data-picker-list]")!.className).toContain("w-max");
  });

  it("a picker that is not steady holds only the picked words, and its list is the field's width", async () => {
    const host = mount(<Picker label="Operation" value="a" onChange={() => {}} options={options} />);
    expect(sizers(host)).toEqual([]);
    await click(host.querySelector("button")!);
    expect(document.querySelector("[data-picker-list]")!.className).not.toContain("w-max");
  });
});

describe("SearchPicker", () => {
  const events: SearchPickerOption[] = [
    { value: "GITHUB_ISSUE_ADDED_EVENT", label: "Issue Added", keywords: ["GITHUB_ISSUE_ADDED_EVENT", "A new issue is opened."] },
    { value: "GITHUB_STAR_ADDED_EVENT", label: "Star Added", keywords: ["GITHUB_STAR_ADDED_EVENT", "Someone stars the repository."] },
    { value: "GITHUB_COMMIT_EVENT", label: "Commit", keywords: ["GITHUB_COMMIT_EVENT", "A commit is pushed."], disabled: true, title: "Not for this account" },
  ];
  function Search({ onSubmit = () => {} }: { onSubmit?: () => void }) {
    const [value, setValue] = useState("");
    return (
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <Field label="Event" note="What starts a run." error={value ? undefined : "Pick an event."}>
          <SearchPicker label="Event" name="event" value={value} onChange={setValue} options={events} placeholder="Search or pick an event" nothing={(q) => `No event matches “${q}”`} />
        </Field>
      </form>
    );
  }

  it("is one field its Field names, describes and marks refused, its list filtered by every word typed in its words or keywords", async () => {
    const host = mount(<Search />);
    const field = searchPicker(host, "Event")!;
    expect(field.getAttribute("role")).toBe("combobox");
    expect(host.querySelector(`label[for="${field.id}"]`)?.textContent).toBe("Event");
    expect(field.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual(["What starts a run.", "Pick an event."]);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.placeholder).toBe("Search or pick an event");
    expect((await shownIn(field)).options.map((o) => o.text), "the chevron opens the whole list").toEqual(["Issue Added", "Star Added", "Commit"]);
    expect((await shownIn(field, "added")).options.map((o) => o.value)).toEqual(["GITHUB_ISSUE_ADDED_EVENT", "GITHUB_STAR_ADDED_EVENT"]);
    expect((await shownIn(field, "repository star")).options.map((o) => o.text), "every word, in any order, keywords too").toEqual(["Star Added"]);
    expect((await shownIn(field, "COMMIT")).options, "case aside; a disabled option is listed and says so").toEqual([{ text: "Commit", value: "GITHUB_COMMIT_EVENT", disabled: true }]);
    const none = await shownIn(field, "nothing-like-it");
    expect([none.options, none.nothing]).toEqual([[], "No event matches “nothing-like-it”"]);
  });

  it("puts the picked option's words in the field and its value in the form; a search left unpicked goes back to them; Enter never submits", async () => {
    const sent = vi.fn();
    const host = mount(<Search onSubmit={sent} />);
    const field = searchPicker(host, "Event")!;
    await searchPick(field, "GITHUB_STAR_ADDED_EVENT", "star");
    expect([field.value, field.getAttribute("data-value"), (host.querySelector('input[type="hidden"][name="event"]') as HTMLInputElement | null)?.value]).toEqual(["Star Added", "GITHUB_STAR_ADDED_EVENT", "GITHUB_STAR_ADDED_EVENT"]);
    expect(field.getAttribute("aria-invalid"), "picked, its Field's error is gone").toBeNull();
    await shownIn(field, "iss");
    await key(field, "Escape");
    expect(field.value, "Esc puts the picked words back").toBe("Star Added");
    await shownIn(field, "issue");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(enter); });
    await settle();
    expect([enter.defaultPrevented, sent.mock.calls.length]).toEqual([true, 0]);
    await key(field, "ArrowDown");
    await key(field, "Enter");
    expect(sent).not.toHaveBeenCalled();
  });

  it("is off whole when disabled", () => {
    const host = mount(<SearchPicker label="Event" value="" onChange={() => {}} options={events} disabled placeholder="Composio offers no event for this toolkit" />);
    expect(searchPicker(host, "Event")!.disabled).toBe(true);
  });
});
