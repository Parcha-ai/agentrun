import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

// A provider's icon is its site's own, from Google's favicon service; when that can't be had it is the bundled mark,
// else the key. jsdom loads no image, so a failed load is the error event a browser fires.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const draw = (id: string) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ProviderIcon, { id })));
  return host;
};
const fail = (host: HTMLElement) => act(() => { host.querySelector("img")!.dispatchEvent(new Event("error")); });

describe("a provider's icon", () => {
  it("asks Google's favicon service for the provider's own site, with no referrer, and is decorative", () => {
    const img = draw("openai").querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://www.google.com/s2/favicons?domain=chatgpt.com&sz=64");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("alt")).toBe("");
  });
  it("only ever asks the host the server's CSP allows", () => {
    for (const id of ["anthropic", "openai", "openrouter", "parallel", "monid", "browserbase", "kernel", "typesafe"]) {
      const img = draw(id).querySelector("img")!;
      expect(new URL(img.src).origin, id).toBe("https://www.google.com");
      act(() => root?.unmount());
    }
  });
  it("falls back to the bundled mark when the icon fails to load", () => {
    const host = draw("anthropic");
    fail(host);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg")!.getAttribute("data-provider-mark")).toBe("anthropic");
  });
  it("falls back to the key when the icon fails and there is no bundled mark", () => {
    const host = draw("openai");
    fail(host);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg")!.getAttribute("class")).toContain("lucide");
  });
  it("is the key, asking nothing, for a provider with no site here", () => {
    const host = draw("some-new-provider");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg")!.getAttribute("class")).toContain("lucide");
  });
});
