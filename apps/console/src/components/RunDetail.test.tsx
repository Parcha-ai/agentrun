import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run } from "@/lib/v2";

const page = (run: Run, rows: ReturnType<typeof runFixture>["page"]["rows"]) =>
  renderToStaticMarkup(createElement(RunDetail, { run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, onMessage: () => {} }))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const times = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// A run waiting on a question (recorded: run.input_required.waiting.1) asks it once: in the banner above, where it's
// answered. The timeline's step for it points there instead of saying it again.
describe("RunDetail, a run waiting on a question", () => {
  const f = runFixture("run.input_required.waiting.1");
  const question = "Which currency are these amounts in: USD or EUR?";

  it("shows the question once, in the banner, and the timeline points to it", () => {
    expect(f.page.rows.some((r) => r.kind === "waiting")).toBe(true);
    const shown = page(f.run, f.page.rows);
    expect(times(shown, question)).toBe(1);
    expect(shown).toContain("Input required");
    expect(shown).toContain("Asked you the question above.");
  });

  it("once it's answered, the timeline says the question again: the banner is gone", () => {
    const shown = page({ ...f.run, status: "working", state: "working" }, f.page.rows);
    expect(times(shown, question)).toBe(1);
    expect(shown).not.toContain("Asked you the question above.");
  });
});

// A run paused at its spend cap waits on a raise, not an answer: a message to it is refused (409 budget_reached).
describe("RunDetail, a run paused at its spend cap", () => {
  const f = runFixture("run.input_required.waiting.1");
  // Words with no apostrophe: the page's markup escapes one (&#x27;), and these tests read its text as written.
  const SAID = "Not sent: the run has spent $0.04 of its $0.05 cap, and its next faux-1 request needs at least $0.11. Raise the cap to at least $0.16 to run it.";
  const paused: Run = { ...f.run, pending: { kind: "budget", cap_usd: 0.05, spent_usd: 0, needs_usd: 0.1024, said: SAID, at: "2026-11-04T20:08:05.127Z" } };
  it("shows the cap's words in the banner and offers no composer: no answer, no follow-up", () => {
    const shown = page(paused, f.page.rows);
    expect(shown).toContain("Paused at its $0.05 spend cap");
    expect(shown).toContain(SAID);
    expect(shown).not.toContain("Answer the question");
    expect(shown).not.toContain("Ask a follow-up");
    // The banner is the cap's, not a question's (the run's header keeps its status, input required).
    expect(shown).not.toContain("Asked you the question above.");
  });
});
