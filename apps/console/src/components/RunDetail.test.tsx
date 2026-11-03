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
