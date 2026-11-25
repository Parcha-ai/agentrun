import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunsList } from "./RunsList";

// A server with no run yet says what a run is and offers the two ways to the first one. A filter that matches nothing
// is a different thing: it says so in a line, and offers nothing to start.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const draw = (filter = {}, onFilter: (f: object) => void = () => {}) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunsList, { runs: [], agentName: (id: string) => id, onOpen: () => {}, filter, onFilter })));
  return host;
};

describe("the Runs page with no runs", () => {
  it("offers a first run from the Playground, and the templates", () => {
    const host = draw();
    expect(host.querySelector("h2")?.textContent).toBe("Start your first run");
    expect(host.querySelector('a[href="#/playground"]')?.textContent?.trim()).toBe("Start a run");
    expect(host.querySelector('a[href="#/templates"]')?.textContent).toBe("Browse templates");
  });
  it("a filter that matches nothing, or no archived runs, says so and offers nothing to start", () => {
    for (const [filter, words] of [[{ status: "failed" }, "No run matches."], [{ archived: true }, "No archived runs."]] as const) {
      const host = draw(filter);
      expect(host.textContent).toContain(words);
      expect(host.querySelector('a[href="#/playground"]')).toBeNull();
      act(() => root?.unmount());
    }
  });
  it("a window or a model no run has says so, and each one's button takes it off", () => {
    const [from, to] = ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"];
    const asked: object[] = [];
    const host = draw({ from, to, model: "openai/gpt-5" }, (f) => asked.push(f));
    expect(host.textContent).toContain("No run matches.");
    expect(host.querySelector('a[href="#/playground"]')).toBeNull();
    const button = (start: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(start))!;
    act(() => button("Used openai/gpt-5").click());
    act(() => button(new Date(from).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })).click());
    expect(asked).toEqual([{ from, to, model: undefined }, { from: undefined, to: undefined, model: "openai/gpt-5" }]);
  });
});
