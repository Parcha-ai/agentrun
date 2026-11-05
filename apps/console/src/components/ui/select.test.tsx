import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "./select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

const options: SelectOption[] = [
  { value: "alpha", label: "Alpha" }, { value: "beta", label: "Beta", disabled: true },
  { value: "blue", label: "Blue", description: "A supported choice" }, { value: "bravo", label: "Bravo" }, { value: "charlie", label: "Charlie" },
];
type Props = Parameters<typeof Select>[0];
async function mount(props: Partial<Props> = {}, container: "body" | "console" | "dialog" = "body") {
  host = document.body.appendChild(document.createElement("div"));
  host.innerHTML = container === "dialog" ? '<div class="ar-console"><dialog open><div></div></dialog></div>' : container === "console" ? '<div class="ar-console"><div></div></div>' : "<div></div>";
  const target = container === "dialog" ? host.querySelector("dialog > div")! : container === "console" ? host.querySelector(".ar-console > div")! : host.firstElementChild!;
  root = createRoot(target);
  const onValueChange = vi.fn();
  const initial: Props = { value: "alpha", onValueChange, options, "aria-label": "Harness", ...props };
  const render = async (patch: Partial<Props> = {}) => { await act(async () => { root.render(createElement(Select, { ...initial, ...patch })); }); };
  await render();
  const trigger = target.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  return { trigger, render, onValueChange };
}
async function key(trigger: HTMLButtonElement, value: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra });
  await act(async () => { trigger.dispatchEvent(event); });
  return event;
}
const active = (trigger: HTMLButtonElement) => document.getElementById(trigger.getAttribute("aria-activedescendant")!);

describe("Select", () => {
  it("previews enabled options without committing, cancels on Escape, and applies a changed value only once", async () => {
    const { trigger, onValueChange, render } = await mount({ autoFocus: true });
    expect(document.activeElement).toBe(trigger);
    await key(trigger, "ArrowDown");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Alpha");
    await key(trigger, "ArrowDown");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Blue");
    expect(active(trigger)?.getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector('[role="option"][aria-label="Alpha"]')?.getAttribute("aria-selected")).toBe("true");
    expect(onValueChange).not.toHaveBeenCalled();
    const escape = await key(trigger, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    await key(trigger, "End");
    await key(trigger, "Enter");
    expect(onValueChange.mock.calls).toEqual([["charlie"]]);
    expect(document.activeElement).toBe(trigger);
    await render({ value: "charlie" });
    await key(trigger, " ");
    await key(trigger, " ");
    expect(onValueChange.mock.calls).toEqual([["charlie"]]);
    await key(trigger, "Home");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Alpha");
    await key(trigger, "ArrowUp");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Alpha");
  });

  it("uses buffered typeahead and repeated-letter cycling, skipping disabled choices without selecting them", async () => {
    vi.useFakeTimers();
    const { trigger, onValueChange } = await mount();
    trigger.focus();
    await key(trigger, "b");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Blue");
    await key(trigger, "b");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Bravo");
    await key(trigger, "r");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Bravo");
    await key(trigger, "Enter", { isComposing: true });
    expect(onValueChange).not.toHaveBeenCalled();
    await act(async () => { vi.runOnlyPendingTimers(); });
    await key(trigger, "c");
    expect(active(trigger)?.getAttribute("aria-label")).toBe("Charlie");
    await key(trigger, "Enter");
    expect(onValueChange.mock.calls).toEqual([["charlie"]]);
  });

  it.each(["body", "console", "dialog"] as const)("keeps the popup in its %s host and allows Tab or outside focus to dismiss without changing the value", async (container) => {
    const { trigger, onValueChange } = await mount({ id: "harness", "aria-label": undefined, "aria-labelledby": "harness-label" }, container);
    const label = document.createElement("label"); label.id = "harness-label"; label.htmlFor = "harness"; label.textContent = "Harness"; host.prepend(label);
    trigger.focus();
    await act(async () => { trigger.click(); });
    const menu = document.querySelector('[role="listbox"]')!;
    expect(menu.parentElement).toBe(container === "dialog" ? host.querySelector("dialog") : container === "console" ? host.querySelector(".ar-console") : document.body);
    expect(menu.getAttribute("aria-labelledby")).toBe("harness-label");
    expect(document.activeElement).toBe(trigger);
    const event = await key(trigger, "Tab");
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => { trigger.click(); });
    const outside = host.appendChild(document.createElement("button"));
    await act(async () => { outside.dispatchEvent(new Event("pointerdown", { bubbles: true })); outside.focus(); });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it.each([{ disabled: true }, { options: [] }, { options: options.map((option) => ({ ...option, disabled: true })) }])("disables selection for an unavailable field: %j", async (props) => {
    const { trigger, onValueChange } = await mount(props);
    expect(trigger.disabled).toBe(true);
    await act(async () => { trigger.click(); });
    await key(trigger, "ArrowDown");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
