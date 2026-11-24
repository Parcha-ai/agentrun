import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Settings } from "./Settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const classes = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/);

// The tab row is the Settings page's top bar: 48px like every other page's bar (pageToolbarClass), so its bottom edge
// meets the edge under the navigation's logo row (Shell, h-12). Its tabs fill the row, so each underline sits on it.
it("draws the tab row 48px tall, its tabs filling it with the label centred", () => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<Settings active="keys" offered={["keys", "tools", "demo"]}><p>Page</p></Settings>));
  const nav = host.querySelector('nav[aria-label="Settings"]');
  expect(classes(nav)).toEqual(expect.arrayContaining(["min-h-12", "border-b"]));
  const tabs = [...nav!.querySelectorAll("a")];
  expect(tabs).toHaveLength(3);
  for (const tab of tabs) {
    expect(classes(tab)).toEqual(expect.arrayContaining(["flex", "items-center", "py-0", "max-sm:py-0", "border-b-2"]));
    expect(classes(tab)).not.toContain("py-3");
  }
});
