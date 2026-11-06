import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LearningChips } from "./LearningChips";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// A run's learning at a glance: the notes it read and the notes it kept, on its header (links into the agent's Learning
// tab) and in run rows (text, since the row is the link).
const run = (learning: Run["learning"]): Run => ({
  run_id: "01a1a22b-0000", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "brooklinen.com",
  created_at: "2026-11-03T16:08:00Z", ended_at: "2026-11-03T16:08:12Z", result: null, error: null, cost: null, archived_at: null, learning,
});
const USED = [{ file: "shopify-refund-policy-path.md", name: "Shopify refund policy path" }];
const LEARNED = [{ file: "try-policies-refund-policy-first.md", name: "Try /policies/refund-policy first", supersedes: ["shopify-refund-policy-path.md"] }];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("LearningChips", () => {
  it("a run that does not learn, or that read and kept nothing, shows none", () => {
    for (const l of [undefined, null, { state: "dropped" as const, reason: "empty" }, { state: "seeded" as const, reason: null }]) {
      expect(renderToStaticMarkup(createElement(LearningChips, { run: run(l) }))).toBe("");
    }
  });
  it("an older server's short form, kept but naming no note, shows none: never a guess", () => {
    expect(renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null }) }))).toBe("");
  });
  it("says how many notes it read and kept, names them on hover, and says what a kept note replaces", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, read: USED, learned: LEARNED }), link: true }));
    expect(text(html)).toContain("Read: 1 note");
    expect(text(html)).toContain("Learned 1 note");
    expect(text(html)).toContain("This run read Shopify refund policy path");
    expect(text(html)).toContain("This run kept Try /policies/refund-policy first");
    expect(text(html)).toContain("Replaces 1 older note.");
    expect(html).toContain('href="#/agents/refunds/learning?note=shopify-refund-policy-path.md"');
    expect(html).toContain('href="#/agents/refunds/learning?note=try-policies-refund-policy-first.md"');
    expect(html).toContain('aria-label="Read: 1 note: Shopify refund policy path"');
    // The tooltip describes the link, the focusable element, not a span around it.
    const link = /<a [^>]*aria-label="Read: 1 note[^>]*>/.exec(html)?.[0] ?? "";
    const id = /aria-describedby="([^"]+)"/.exec(link)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`role="tooltip" id="${id}"`);
  });
  it("counts in words: 2 notes", () => {
    const two = [...USED, { file: "keep-it-short.md", name: "Keep it short" }];
    expect(text(renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "dropped", reason: "empty", read: two }) })))).toContain("Read: 2 notes");
  });
  it("in a row, which is itself a link, the chips are text that names the notes in its title, with no tooltip", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, read: USED, learned: LEARNED }) }));
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('role="tooltip"');
    expect(html).toContain('title="Read: 1 note: Shopify refund policy path"');
    expect(html).toContain('title="Learned 1 note: Try /policies/refund-policy first (replaces 1 older note)"');
  });
  it("a note whose name the server cut of a secret is named as it was cut, and never linked", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, read: [{ file: "[redacted]", name: "[redacted]" }], learned: LEARNED }), link: true }));
    expect(html).toContain('title="Read: 1 note: [redacted]"');
    expect(html).not.toContain("redacted%5D");
    expect(html).toContain('href="#/agents/refunds/learning?note=try-policies-refund-policy-first.md"');
  });
  it("while it decides what to keep, says it is looking back", () => {
    for (const state of ["reflecting", "proposed"] as const) expect(text(renderToStaticMarkup(createElement(LearningChips, { run: run({ state, reason: null }) })))).toContain("Looking back");
  });
  it("the run header carries them, as links", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: run({ state: "merged", reason: null, read: USED, learned: LEARNED }), agentName: "Refunds" }));
    expect(html).toContain('href="#/agents/refunds/learning?note=try-policies-refund-policy-first.md"');
    expect(text(html)).toContain("Learned 1 note");
  });
  it("a note the run kept for the owner's OK says so, linking to it in the Learning tab", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "pending", reason: null, pending: [{ file: "trust-acme.md", name: "Trust acme.com for refunds" }] }), link: true }));
    expect(text(html)).toContain("1 note waits for your OK");
    expect(html).toContain('href="#/agents/refunds/learning?note=trust-acme.md"');
    expect(html).toContain('aria-label="1 note waits for your OK: Trust acme.com for refunds"');
    expect(text(html)).toContain("Waits for your OK before any run reads it");
  });
  it("a run waiting with no note named still links to the agent's Learning tab", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "pending", reason: null }), link: true }));
    expect(text(html)).toContain("A note waits for your OK");
    expect(html).toContain('href="#/agents/refunds/learning"');
  });
  it("in a row, it is text that says the same in its title", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, pending: [{ file: "a.md", name: "A" }, { file: "b.md", name: "B" }] }) }));
    expect(html).toContain('title="2 notes wait for your OK: A, B"');
    expect(html).not.toContain("<a ");
  });
});

describe("LearningChips, skills and workflows", () => {
  it("says the skill and the workflow a run learned, and one that waits for the OK", () => {
    const html = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, skills: [{ file: "skills/find-policies/SKILL.md", name: "find-policies" }], workflows: [{ file: "workflows/check-refunds/workflow.json", name: "check-refunds" }] } as Run["learning"]), link: true }));
    expect(text(html)).toContain("Learned 1 skill");
    expect(text(html)).toContain("Learned 1 workflow");
    expect(html).toContain('href="#/agents/refunds/learning"');
    const waits = renderToStaticMarkup(createElement(LearningChips, { run: run({ state: "merged", reason: null, skills: [{ file: "skills/find-policies/SKILL.md", name: "find-policies", pending: true }] } as Run["learning"]) }));
    expect(text(waits)).toContain("1 skill waits for your OK");
    expect(text(waits)).not.toContain("Learned 1 skill");
  });
});
