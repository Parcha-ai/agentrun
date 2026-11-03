import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFilter } from "./AgentFilter";

const agents = [{ agentId: "all", name: "Allrounder", runs: 2 }, { agentId: "calc", name: "Calculator", runs: 1 }];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); });

async function mount(value: string | null = null) {
  host = document.body.appendChild(document.createElement("div"));
  host.innerHTML = '<button>Before</button><div></div><button>After</button>';
  root = createRoot(host.querySelector("div")!);
  const onChange = vi.fn();
  await act(async () => { root.render(createElement(AgentFilter, { agents, value, onChange })); });
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')!;
  await act(async () => { trigger.click(); });
  return { trigger, search: document.querySelector<HTMLInputElement>('input[role="combobox"]')!, after: host.lastElementChild as HTMLButtonElement, onChange };
}

async function key(search: HTMLInputElement, value: string, extra: KeyboardEventInit = {}) {
  await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra })); });
}

async function query(search: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AgentFilter", () => {
  it.each(["Escape", "outside", "Tab", "scroll"])("dismisses with %s without applying the highlighted agent or trapping focus", async (dismiss) => {
    const { trigger, search, after, onChange } = await mount();
    expect(document.activeElement).toBe(search);
    await key(search, "ArrowDown");
    const highlighted = document.getElementById(search.getAttribute("aria-activedescendant")!);
    expect(highlighted?.getAttribute("aria-label")).toBe("Allrounder");
    expect(highlighted?.getAttribute("aria-selected")).toBe("false");
    if (dismiss === "outside") await act(async () => { after.dispatchEvent(new Event("pointerdown", { bubbles: true })); after.focus(); });
    else if (dismiss === "scroll") {
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(20, -80, 220, 38));
      await act(async () => { window.dispatchEvent(new Event("resize")); });
      await act(async () => { document.querySelector('[role="listbox"]')!.dispatchEvent(new Event("scroll")); });
      expect(document.activeElement).toBe(search);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      await act(async () => { host.dispatchEvent(new Event("scroll")); });
    }
    else await key(search, dismiss);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(dismiss === "Escape" ? trigger : dismiss === "scroll" ? document.body : after);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an empty search inert and distinguishes the all-agents choice from an agent named all", async () => {
    const { trigger, search, onChange } = await mount("calc");
    await query(search, "missing");
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    await key(search, "Enter");
    expect(onChange).not.toHaveBeenCalled();
    await query(search, "all");
    await key(search, "Enter", { isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    await key(search, "ArrowDown");
    await key(search, "Enter");
    expect(onChange.mock.calls).toEqual([["all"]]);
    expect(document.activeElement).toBe(trigger);
    await act(async () => { trigger.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="option"][aria-label="All agents"]')!.click(); });
    expect(onChange.mock.calls).toEqual([["all"], [null]]);
  });
});
