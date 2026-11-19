import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Cost, Run } from "@/lib/v2";

// The run page's cost says "est." and carries the estimate disclaimer for the same reason: its basis.
const runWith = (c: Cost): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
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
  it("a cost the provider or gateway reported says so, with no estimate disclaimer", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 0.0042, basis: "reported", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$0.0042 reported");
    expect(html).toContain("As the provider or gateway reported it");
    expect(html).not.toContain(DISCLAIMER);
  });
  it("a cost no model request was priced for says so", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 0, basis: "unpriced", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("$0.0000");
    expect(html).toContain("No model request was priced");
    expect(html).not.toContain(DISCLAIMER);
  });
  it("its tokens: input, output, the cache's reads and writes, and the requests that reported none", () => {
    const tokens = { input: 12_400, output: 1_250, cache_read: 3_000, cache_write: 0, requests: 3, unmetered: 1 };
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 0.0042, basis: "reported", charge_state: null, cap_usd: null, tokens }), agentName: "Calc" }));
    expect(html).toContain("12.4K in · 1,250 out · 3,000 cache read · 1 request unmetered");
    expect(html).not.toContain("cache write");
  });
  it("no tokens line when the run says none", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: 1.5, basis: "estimate", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).not.toContain(" out");
  });
  it("an unknown cost reads Unknown, with no estimate disclaimer", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ usd: null, basis: "estimate", charge_state: null, cap_usd: null }), agentName: "Calc" }));
    expect(html).toContain("Unknown");
    expect(html).not.toContain(DISCLAIMER);
  });
});

describe("RunHeader's cost when some charges have no price", () => {
  const unknown = { usd: null, basis: "estimate" as const, charge_state: null, cap_usd: null };
  it("an ended run says what the priced charges cost and how many have no price, in place of Unknown, and why it is not the whole cost", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith({ ...unknown, so_far_usd: 0.0421, unpriced: 2 }), agentName: "Calc" }));
    expect(html).toContain("$0.0421 est. known · 2 not priced");
    expect(html).toContain("not the whole cost");
    expect(html).not.toContain("Unknown");
  });
  it("without them, says Unknown as it always did", () => {
    const html = renderToStaticMarkup(createElement(RunHeader, { run: runWith(unknown), agentName: "Calc" }));
    expect(html).toContain("Unknown");
    expect(html).not.toContain("so far");
  });
});
