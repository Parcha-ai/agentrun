import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Cost, Run } from "@/lib/v2";

// The run page's cost says "est." and carries the estimate disclaimer for the same reason: its basis.
const runWith = (c: Cost): Run => ({
  run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Q",
  created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: c, archived_at: null,
});
const DISCLAIMER = "A local estimate, not a bill";

describe("RunHeader's cost", () => {
  it("a charged cost has no estimate disclaimer", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 1.5, basis: "charge", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$1.50");
    expect(html).not.toContain(DISCLAIMER);
  });
  it("an estimated cost has it", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 1.5, basis: "estimate", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$1.50 est.");
    expect(html).toContain(DISCLAIMER);
  });
  it("an unknown cost reads Unknown, with no estimate disclaimer", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: null, basis: "estimate", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("Unknown");
    expect(html).not.toContain(DISCLAIMER);
  });
});

describe("RunHeader's cost when requests were cut", () => {
  const unknown = { usd: null, basis: "estimate", charge_state: null, cap_usd: null };
  it("with a bound, says ≤ the bound and that some requests were cut, in place of Unknown", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ ...unknown, at_most_usd: 0.0421 }), agentName: "Calc" }));
    expect(html).toContain("≤ $0.05");
    expect(html).toContain("some requests were cut");
    expect(html).not.toContain("Unknown");
  });
  it("without one, says Unknown as it always did, and nothing about cut requests", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith(unknown), agentName: "Calc" }));
    expect(html).toContain("Unknown");
    expect(html).not.toContain("≤");
    expect(html).not.toContain("some requests were cut");
  });
});
