import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// Where a run ran, as its start resolved it (Run.place).
const run = (place: unknown): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0,
  run_id: "r1", place, agent_id: "boxed", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Q",
  created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
} as Run);
const html = (r: Run) => renderToStaticMarkup(createElement(RunHeader, { run: r, agentName: "Boxed" }));

describe("RunHeader, where the run ran", () => {
  it("names the box a run ran in, or the server", () => {
    expect(html(run({ mode: "sandbox", box: "docker" }))).toContain("in a docker box");
    expect(html(run({ mode: "runner" }))).toContain("on the server");
  });

});
