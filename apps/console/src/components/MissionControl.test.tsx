import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { costLine, missionFrom, type MissionView } from "@/lib/mission";
import { MissionControl } from "./MissionControl";
import type { Run } from "@/lib/v2";

const run = (id: string, status: Run["status"], state: Run["state"], title: string): Run => ({
  run_id: id, agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status, state, title, created_at: "2026-10-30T03:00:00Z",
  ended_at: null, result: null, error: null, cost: null, archived_at: null,
});
const view: MissionView = {
  agents: 2,
  runs: { total: 7, active: 1, needsInput: 2, failed: 1 },
  perAgent: [{ agentId: "calc", name: "Calc", runs: 5 }, { agentId: "notes", name: "Meeting notes", runs: 2 }],
  cost: { usd: 0.0043, basis: "mixed", unknownRuns: 2 },
  recent: [run("run-1", "completed", "idle", "What is six times seven?"), run("run-2", "working", "working", "Summarize the standup")],
};

// Mission Control: the console's first page. Counts, cost said honestly, runs per agent and the latest runs, linked.
describe("MissionControl", () => {
  it("shows the agents, the runs and how many are active, waiting on a person, or failed", () => {
    const html = renderToStaticMarkup(createElement(MissionControl, { view }));
    for (const s of ["Mission Control", ">2<", ">7<", "Active", "Needs input", "Failed"]) expect(html).toContain(s);
  });
  it("links each recent run to its page, and each agent to its runs", () => {
    const html = renderToStaticMarkup(createElement(MissionControl, { view }));
    expect(html).toContain('href="#/runs/run-1"');
    expect(html).toContain('href="#/runs/run-2"');
    expect(html).toContain('href="#/runs?agent=calc"');
  });
  it("renders a store with nothing in it, without error", () => {
    const empty: MissionView = { agents: 0, runs: { total: 0, active: 0, needsInput: 0, failed: 0 }, perAgent: [], cost: { usd: null, basis: null, unknownRuns: 0 }, recent: [] };
    const html = renderToStaticMarkup(createElement(MissionControl, { view: empty }));
    expect(html).toContain("No agents yet");
    expect(html).toContain("No runs yet");
    expect(html).not.toMatch(/\$0(\.0+)?\b/);
  });
});

describe("costLine: a total said honestly, never $0 for a cost not known", () => {
  it("is Unknown when no run's cost is known", () => {
    expect(costLine({ usd: null, basis: null, unknownRuns: 3 })).toBe("Unknown");
  });
  it("marks an estimate, and a mix of estimate and reported, as est.", () => {
    expect(costLine({ usd: 1.5, basis: "estimate", unknownRuns: 0 })).toBe("$1.50 est.");
    expect(costLine({ usd: 0.0043, basis: "mixed", unknownRuns: 0 })).toBe("$0.0043 est.");
  });
  it("says a reported total plainly", () => {
    expect(costLine({ usd: 1.5, basis: "reported", unknownRuns: 0 })).toBe("$1.50");
  });
  it("says how many runs aren't in the total", () => {
    expect(costLine({ usd: 0.0043, basis: "mixed", unknownRuns: 2 })).toBe("$0.0043 est. · 2 runs unknown");
    expect(costLine({ usd: 0.0043, basis: "estimate", unknownRuns: 1 })).toBe("$0.0043 est. · 1 run unknown");
  });
});

describe("missionFrom: GET /v2/stats and the latest runs, as the page shows them", () => {
  const stats = {
    agents: 2, runs: { total: 7, active: 1, needs_input: 2, failed: 1 },
    per_agent: [{ agent_id: "calc", name: "Calc", runs: 5 }],
    cost: { usd: null, basis: null, unknown_runs: 7 }, archived: { agents: 1, runs: 3 },
  };
  it("maps the server's fields, keeps an all-unknown cost null, and leaves archived out of the counts", () => {
    const v = missionFrom(stats, view.recent);
    expect(v).toEqual({
      agents: 2, runs: { total: 7, active: 1, needsInput: 2, failed: 1 }, perAgent: [{ agentId: "calc", name: "Calc", runs: 5 }],
      cost: { usd: null, basis: null, unknownRuns: 7 }, recent: view.recent,
    });
    expect(costLine(v.cost)).toBe("Unknown");
  });
});
