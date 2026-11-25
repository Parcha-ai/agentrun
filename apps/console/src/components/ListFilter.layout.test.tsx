import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ListFilter } from "./ListFilter";

// Picking a filter never changes the box's width: its count stands inside the box, at its end, so the row beside it
// holds the same things whether a filter is in force or not.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

describe("ListFilter's count", () => {
  it("stands inside the box, and the row's items are the same with a filter in force or not", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const draw = (active: boolean) => act(() => root!.render(createElement(ListFilter, { value: "", onChange: () => {}, label: "Filter calls", placeholder: "Filter", shown: 3, total: 5, active },
      createElement("span", { "data-kinds": "" }, "All 5"))));
    draw(false);
    const row = host.firstElementChild!;
    const items = () => [...row.children].map((c) => c.tagName + (c.hasAttribute("data-kinds") ? "[kinds]" : ""));
    const before = items();
    const box = row.querySelector("label")!;
    expect(box.querySelector('[role="status"]')!.textContent).toBe("");
    draw(true);
    expect(items()).toEqual(before);
    expect(items()).toEqual(["LABEL", "SPAN[kinds]"]);
    expect(box.querySelector('[role="status"]')!.textContent).toBe("3 of 5 shown");
    expect(box.querySelector("input")!.className).toContain("min-w-0");
  });
});
