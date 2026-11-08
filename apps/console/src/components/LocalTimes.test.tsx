import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunFiles } from "./RunFiles";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import { Timeline } from "./Timeline";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

// Every time the console shows reads in the viewer's own zone. A run that started at 20:50:47Z shows 4:50 PM to a viewer
// in Puerto Rico (UTC-4), never 8:50 PM: its header, the Runs list, its Timeline and its Files.
const AT = "2026-11-04T20:50:47Z";
const run: Run = { sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0,
  run_id: "01a1a869-ce4e-7cf5-abf8-c5407893934a", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle",
  title: "Name three primes above 100.", created_at: AT, ended_at: "2026-11-04T20:50:50Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
} as Run;
const text = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the console's times, in the viewer's zone (Puerto Rico, UTC-4)", () => {
  beforeEach(() => { vi.stubEnv("TZ", "America/Puerto_Rico"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the run header", () => {
    const t = text(createElement(RunHeader, { run, agentName: "Calc" }));
    expect(t).toContain("Nov 4, 4:50 PM");
    expect(t).not.toContain("8:50 PM");
  });
  it("the Runs list", () => {
    const t = text(createElement(RunsList, { runs: [run], agentName: () => "Calc", onOpen: () => {} }));
    expect(t).toContain("Nov 4, 4:50 PM");
    expect(t).not.toContain("8:50 PM");
  });
  it("the Timeline", () => {
    const row = { id: "r1", seq: 1, kind: "user_message", summary: "Name three primes above 100.", text: "Name three primes above 100.", timestamp: AT, tool_name: null } as TimelineRow;
    const t = text(createElement(Timeline, { rows: [row], live: false }));
    expect(t).toContain("04:50 PM");
    expect(t).not.toContain("08:50 PM");
  });
  it("the Files tab", () => {
    const file = { path: "hello.md", size_bytes: 6, modified_at: AT, content_type: "text/markdown" } as RunFile;
    const t = text(createElement(RunFiles, { files: [file], onOpen: () => {} }));
    expect(t).toContain("Nov 4, 4:50 PM");
    expect(t).not.toContain("8:50 PM");
  });
});
