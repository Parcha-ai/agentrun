import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LearningChips } from "./LearningChips";
import type { Run } from "@/lib/v2";

// What a run started with and what it read, as the server says (its learning's `given` and `read`): "Started with: …"
// for the notes it was given, "Read: …" for the notes it opened. Each absent when the server names none.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const run = (learning: Run["learning"]): Run => ({
  run_id: "01a1a22b-0000", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "brooklinen.com",
  created_at: "2026-11-03T16:08:00Z", ended_at: "2026-11-03T16:08:12Z", result: null, error: null, cost: null, archived_at: null, learning,
});
const FIRST = { file: "try-policies-refund-policy-first.md", name: "Try /policies/refund-policy first" };
const MINE = { file: "keep-it-to-three-lines.md", name: "Keep the summary to three lines" };

const mount = (learning: Run["learning"]) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(LearningChips, { run: run(learning), link: true })));
  return host;
};
const chips = (host: Element) => [...host.querySelectorAll("a, span[title]")].map((x) => ({ label: x.getAttribute("aria-label") ?? "", href: x.getAttribute("href"), text: x.textContent ?? "" }));

describe("LearningChips, what a run started with and read", () => {
  it("says what it started with and what it read, each a link to those notes", () => {
    const host = mount({ state: "dropped", reason: "empty", given: [FIRST, MINE], read: [FIRST] } as Run["learning"]);
    const all = chips(host);
    const started = all.find((c) => c.text.includes("Started with"));
    expect(started?.text).toContain("Started with: 2 notes");
    expect(started?.label).toBe("Started with: 2 notes: Try /policies/refund-policy first, Keep the summary to three lines");
    expect(started?.href).toBe("#/agents/refunds/learning?note=try-policies-refund-policy-first.md&note=keep-it-to-three-lines.md");
    const read = all.find((c) => c.text.includes("Read:"));
    expect(read?.text).toContain("Read: 1 note");
    expect(read?.href).toBe("#/agents/refunds/learning?note=try-policies-refund-policy-first.md");
  });

  it("a run given notes that read none says only what it started with", () => {
    const host = mount({ state: "dropped", reason: "empty", given: [FIRST] } as Run["learning"]);
    expect(host.textContent).toContain("Started with: 1 note");
    expect(host.textContent).not.toContain("Read:");
  });

  it("a run that started with nothing and read nothing shows neither; `used` is no field the console reads", () => {
    const host = mount({ state: "dropped", reason: "empty", used: [FIRST] } as Run["learning"]);
    expect(host.textContent).toBe("");
  });
});
