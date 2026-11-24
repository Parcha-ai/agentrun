import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolkitIcon, ToolkitIcons } from "./ToolkitIcon";

// A template's MCP needs, as icons: each toolkit's site's own icon from Google's favicon service (the one off-origin host
// the server's CSP allows), named for a screen reader and on hover; in words when there is no icon to be had. jsdom
// loads no image, so a failed load is the error event a browser fires.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const draw = (element: ReactElement) => {
  act(() => root?.unmount());
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
};

describe("a toolkit's icon", () => {
  it("is its site's icon with no referrer, named with where its tools come from and whether it is optional", () => {
    const img = draw(createElement(ToolkitIcon, { toolkit: "hubspot", source: "composio", required: false })).querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://www.google.com/s2/favicons?domain=hubspot.com&sz=64");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.alt).toBe("HubSpot through Composio");
    expect(img.title).toBe("HubSpot through Composio, optional");
  });
  it("names GitHub's own server GitHub alone, and a server added by address as one", () => {
    expect(draw(createElement(ToolkitIcon, { toolkit: "github", source: "github", required: true })).querySelector("img")!.alt).toBe("GitHub");
    expect(draw(createElement(ToolkitIcon, { toolkit: "linear", source: "url", required: true })).querySelector("img")!.alt).toBe("Linear from an MCP server you add");
  });
  it("only ever asks the host the server's CSP allows", () => {
    for (const toolkit of ["fal", "firecrawl", "github", "gmail", "googlecalendar", "googledrive", "hubspot", "linear", "notion", "parallel", "salesforce", "slack"]) {
      const img = draw(createElement(ToolkitIcon, { toolkit, source: "composio", required: true })).querySelector("img")!;
      expect(new URL(img.src).origin, toolkit).toBe("https://www.google.com");
    }
  });
  it("is its name in words when the icon fails to load", () => {
    const host = draw(createElement(ToolkitIcon, { toolkit: "gmail", source: "composio", required: false }));
    act(() => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("Gmail");
    expect(host.querySelector("[title]")!.getAttribute("title")).toBe("Gmail through Composio, optional");
  });
  it("is its slug in words, asking nothing, for a toolkit with no site here", () => {
    const host = draw(createElement(ToolkitIcon, { toolkit: "acme-crm", source: "url", required: true }));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("acme-crm");
  });
});

describe("a template's toolkits", () => {
  const needs = (...list: [string, boolean][]) => list.map(([toolkit, required]) => ({ toolkit, source: "composio" as const, required }));
  it("ends optional ones with the word optional", () => {
    const host = draw(createElement(ToolkitIcons, { needs: needs(["hubspot", false], ["slack", false]) }));
    expect([...host.querySelectorAll("img")].map((i) => i.alt)).toEqual(["HubSpot through Composio", "Slack through Composio"]);
    expect(host.textContent).toBe("optional");
  });
  it("puts the ones it needs first, apart from the optional ones", () => {
    const host = draw(createElement(ToolkitIcons, { needs: needs(["slack", false], ["github", true]) }));
    expect([...host.querySelectorAll("img")].map((i) => i.dataset.toolkit)).toEqual(["github", "slack"]);
    expect(host.textContent).toBe("·optional");
  });
  it("says nothing more when every one is needed", () => {
    const host = draw(createElement(ToolkitIcons, { needs: needs(["github", true]) }));
    expect(host.textContent).toBe("");
  });
});
