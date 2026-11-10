import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const draw = (id: string) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ProviderIcon, { id })));
  return host.querySelector("svg")!;
};

describe("a provider's icon", () => {
  it("is the provider's bundled mark, in the text's colour, hidden from a screen reader", () => {
    const svg = draw("anthropic");
    expect(svg.getAttribute("data-provider-mark")).toBe("anthropic");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("path")?.getAttribute("d")).toMatch(/^M/);
  });
  it("is the key for a provider with no mark here", () => {
    const svg = draw("some-new-provider");
    expect(svg.hasAttribute("data-provider-mark")).toBe(false);
    expect(svg.getAttribute("class")).toContain("lucide");
  });
  it("loads nothing from another site", () => {
    for (const id of ["anthropic", "openrouter", "none"]) { const svg = draw(id); expect(svg.outerHTML).not.toMatch(/<image|href=|src=|url\(/); act(() => root?.unmount()); }
  });
});
