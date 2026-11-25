import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LearningChips } from "./LearningChips";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// A run's learning at a glance: the workflow drafts it kept, on its header (links into the agent's Learning tab) and in
// run rows (text, since the row is the link).
const run = (learning: Run["learning"]): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" }, learning_work: { state: "none", runs: [], ended_at: null, deadline_at: null },
  run_id: "01a1a22b-0000", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "brooklinen.com",
  created_at: "2026-11-03T16:08:00Z", ended_at: "2026-11-03T16:08:12Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, learning,
});
const at = "2026-11-03T16:52:09Z";
const KEPT = [{ file: "workflows/check-refunds/workflow.json", name: "check-refunds" }];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("LearningChips", () => {
  it("a run that does not learn, or that kept nothing new, shows none", () => {
    for (const l of [undefined, null, { state: "dropped" as const, reason: "empty" as const, detail: null, at }, { state: "seeded" as const, reason: null, detail: null, at }]) {
      expect(renderToStaticMarkup(createElement(LearningChips, { run: run(l) }))).toBe("");
    }
  });
  it("a kept run that names no workflow shows none: never a guess", () => {
    expect(renderToStaticMarkup(createElement(LearningChips, { run: run({ detail: null, at, state: "merged", reason: null }) }))).toBe("");
  });
  it("says the workflow a run learned, linking to the agent's Learning tab", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, detail: null, at, workflows: KEPT }), link: true }));
    expect(text(html)).toContain("Learned 1 workflow");
    expect(html).toContain('href="#/agents/refunds/learning"');
    expect(html).toContain('aria-label="Learned 1 workflow: check-refunds"');
  });
  it("counts in words: 2 workflows", () => {
    const two = [...KEPT, { file: "workflows/sort-invoice/workflow.json", name: "sort-invoice" }];
    expect(text(renderToStaticMarkup(createElement(LearningChips, { run: run({ detail: null, at, state: "merged", reason: null, workflows: two }) })))).toContain("Learned 2 workflows");
  });
  it("in a row, which is itself a link, the chip is text that names the workflows in its title", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ detail: null, at, state: "merged", reason: null, workflows: KEPT }) }));
    expect(html).not.toContain("<a ");
    expect(html).toContain('title="Learned 1 workflow: check-refunds"');
  });
  it("while it decides what to keep, says it is looking back", () => {
    expect(text(renderToStaticMarkup(createElement(LearningChips, { run: run({ detail: null, at, state: "reflecting", reason: null }) })))).toContain("Looking back");
  });
  it("the run header carries them, as links", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: run({ detail: null, at, state: "merged", reason: null, workflows: KEPT }), agentName: "Refunds" }));
    expect(html).toContain('href="#/agents/refunds/learning"');
    expect(text(html)).toContain("Learned 1 workflow");
  });
  it("a workflow the run kept for the owner's OK says so instead of learned", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, detail: null, at, workflows: [{ ...KEPT[0]!, pending: true }] }), link: true }));
    expect(text(html)).toContain("1 workflow waits for your OK");
    expect(text(html)).not.toContain("Learned 1 workflow");
    expect(html).toContain('aria-label="1 workflow waits for your OK: check-refunds"');
  });
  it("in a row, it is text that says the same in its title", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ detail: null, at, state: "merged", reason: null, workflows: [{ file: "workflows/a/workflow.json", name: "a", pending: true }, { file: "workflows/b/workflow.json", name: "b", pending: true }] }) }));
    expect(html).toContain('title="2 workflows wait for your OK: a, b"');
    expect(html).not.toContain("<a ");
  });
});
