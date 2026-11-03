import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { readHarness } from "@/lib/liveRun";
import type { Run } from "@/lib/v2";

// Where a run ran, as its start resolved it (Run.place), and a run whose start narrowed its revision's box to the server.
const run = (place?: unknown): Run => ({
  run_id: "r1", agent_id: "boxed", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Q",
  created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: null, ...(place ? { place } : {}),
} as Run);
const html = (r: Run, revisionPlace?: unknown) => renderToStaticMarkup(createElement(RunHeader, { run: r, agentName: "Boxed", revisionPlace } as never));

describe("RunHeader, where the run ran", () => {
  it("names the box a run ran in, or the server", () => {
    expect(html(run({ mode: "sandbox", box: "docker" }))).toContain("in a docker box");
    expect(html(run({ mode: "runner" }))).toContain("on the server");
  });
  it("marks a run its start narrowed: its revision names a box, and it ran on the server", () => {
    expect(html(run({ mode: "runner" }), { mode: "sandbox", box: "docker" })).toContain("on the server, not in its docker box");
    expect(html(run({ mode: "runner" }), { mode: "runner" })).not.toContain("not in its");
  });
  it("says nothing of a place for a run an older server kept without one", () => {
    expect(html(run())).not.toMatch(/in a \w+ box|on the server/);
  });
  it("reads the revision's place with its harness, in the one revisions read the page makes", async () => {
    const v2 = { listRevisions: async () => ({ revisions: [{ revision: "rv1", definition: { harness: "pi", place: { mode: "sandbox", box: "docker" } } }], next_cursor: null }) };
    expect(await readHarness(v2, { agent_id: "boxed", revision: "rv1" })).toEqual({ state: "read", id: "pi", place: { mode: "sandbox", box: "docker" } });
  });
});
