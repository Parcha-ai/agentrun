import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LearningChips } from "./LearningChips";
import type { Run } from "@/lib/v2";

// A run whose learning kept nothing for a reason other than "nothing new" (the grader turned it away, a check refused
// it, it was skipped or stopped) says so on its page: a "Kept nothing" chip with the server's own sentence, linking to
// the agent's Learning tab. A run with nothing new to remember stays silent.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const run = (learning: Run["learning"]): Run => ({
  run_id: "01a1ae2c-dd4b", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "kith.com",
  created_at: "2026-11-05T22:00:00Z", ended_at: "2026-11-05T22:00:12Z", result: null, error: null, cost: null, archived_at: null, learning,
});
const mount = (learning: Run["learning"], link = true) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(LearningChips, { run: run(learning), link })));
  return host;
};
const SAID = "Not kept: it's about one shop's returns portal, and a skill it wrote is lost with it.";

describe("LearningChips, a run that kept nothing", () => {
  it("turned away by the grader: a Kept nothing chip with the server's sentence, linking to the Learning tab", () => {
    const host = mount({ state: "dropped", reason: "grader", detail: SAID });
    expect(host.textContent).toContain("Kept nothing");
    expect(host.textContent).toContain(SAID);
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("Kept nothing"));
    expect(link?.getAttribute("href")).toBe("#/agents/refunds/learning");
    expect(link?.getAttribute("aria-label")).toBe(`Kept nothing: ${SAID}`);
  });

  it("skipped (no learning budget) or stopped: the chip too", () => {
    expect(mount({ state: "dropped", reason: "no_budget", detail: "Skipped: no learning budget was left for this run." }).textContent).toContain("Kept nothing");
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(mount({ state: "dropped", reason: "crashed", detail: "Not kept: learning stopped." }).textContent).toContain("Kept nothing");
  });

  it("nothing new to remember: no chip", () => {
    expect(mount({ state: "dropped", reason: "empty", detail: "Nothing new to remember from this run." }).textContent).toBe("");
  });

  it("in a row, which is itself a link, the chip is text that says the sentence in its title", () => {
    const host = mount({ state: "dropped", reason: "grader", detail: SAID }, false);
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector(`[title="Kept nothing: ${SAID}"]`)?.textContent).toContain("Kept nothing");
  });
});
