import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import { StatusBadge } from "./StatusBadge";
import { failedWith } from "@/fixtures";
import { NO_MESSAGES } from "@/lib/runState";

describe("StatusBadge", () => {
  it("reads a paused workflow run as Paused", () => {
    expect(renderToStaticMarkup(createElement(StatusBadge, { run: { status: "paused", state: "idle", kind: "workflow" } }))).toContain("Paused");
  });
  it("reads a recorded escalated run as Escalated, in the runs list and the run's header, never Failed", () => {
    const { run } = failedWith("escalated");
    expect(run.status).toBe("failed");
    const badge = renderToStaticMarkup(createElement(StatusBadge, { run }));
    expect(badge).toContain("Escalated");
    expect(badge).not.toContain("Failed");
    for (const html of [renderToStaticMarkup(createElement(RunsList, { runs: [run], agentName: (id: string) => id, onOpen: () => {} })), renderToStaticMarkup(createElement(RunHeader, { run, agentName: "Agent" }))]) {
      expect(html).toContain("Escalated");
      expect(html).not.toContain(">Failed<");
    }
    const detail = renderToStaticMarkup(createElement(RunDetail, { run, agentName: "Agent", messages: NO_MESSAGES, harnessSteers: true, rows: [], files: [] }));
    expect(detail).toContain("The run escalated");
    expect(detail).not.toContain("The run failed");
  });
});
