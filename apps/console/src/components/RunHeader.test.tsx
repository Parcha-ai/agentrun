import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Cost, Run } from "@/lib/v2";

// The run page's cost says "est." and carries the estimate disclaimer for the same reason: whose number it is.
const runWith = (c: Cost): Run => ({
  run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Q",
  created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: c, archived_at: null,
});
const DISCLAIMER = "A local estimate, not a bill";

describe("RunHeader's cost", () => {
  it("a cost a provider reported has no estimate disclaimer, though its basis is estimate", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 1.5, basis: "estimate", source: "reported", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$1.50");
    expect(html).not.toContain(DISCLAIMER);
  });
  it("an estimated cost has it, whatever its basis says", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 1.5, basis: "charge", source: "estimate", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$1.50 est.");
    expect(html).toContain(DISCLAIMER);
  });
  it("an unknown cost reads Unknown, with no estimate disclaimer, whatever its source or basis says", () => {
    for (const c of [{ source: "estimate" as const, basis: "estimate" }, { basis: "estimate" }]) {
      const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: null, charge_state: null, cap_usd: null, ...c }), agentName: "Calc" }));
      expect(html).toContain("Unknown");
      expect(html).not.toContain(DISCLAIMER);
    }
  });
});
