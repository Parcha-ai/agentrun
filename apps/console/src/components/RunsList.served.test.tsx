import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunsList } from "./RunsList";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// A run a learned workflow answered alone (the server's `served`, its path as GET .../learning/cost places it) says so on
// the runs list and on its run page, with the Learning tab's workflow series mark beside the words; every other run reads
// its kind, and a run the workflow handed back reads as the agent's, its hand-back named on the run page alone.
const base: Run = {
  sha: null, updated_at: "2026-11-18T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "r1", agent_id: "mcc", agent_version: 2, revision: "rv2", kind: "agentic", status: "completed", state: "idle", title: "Coffee shop",
  created_at: "2026-11-18T06:00:00Z", ended_at: "2026-11-18T06:00:03Z", result: null, error: null, cost: { usd: 0.002, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
};
const SERVED: Run = { ...base, run_id: "r-served", served: { workflow: "mcc-guess", digest: "d".repeat(16) } };
const HANDED: Run = { ...base, run_id: "r-handed", handed_back: { workflow: "mcc-guess", digest: "d".repeat(16) } };
const AGENT: Run = { ...base, run_id: "r-agent" };

const host = (html: string) => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
};
/** Each row's Kind cell (the fourth), by run. */
const kinds = (runs: Run[]) => {
  const page = host(renderToStaticMarkup(createElement(RunsList, { runs, agentName: (id: string) => id, onOpen: () => {} })));
  return [...page.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[3]);
};
const header = (run: Run) => host(renderToStaticMarkup(createElement(RunHeader, { run, agentName: "MCC" })));
const facts = (run: Run) => [...header(run).querySelectorAll("span.font-mono")].map((span) => span.textContent ?? "").find((text) => text.includes(" · rev "));

describe("a served run on the runs list", () => {
  it("reads Learned workflow in the Kind cell, with the workflow series mark; every other run reads its kind", () => {
    const [served, handed, agent] = kinds([SERVED, HANDED, AGENT]);
    expect(served.textContent).toBe("Learned workflow");
    expect(served.querySelector('[data-run-kind="learned"] .fill-chart-workflow'), "the series mark beside the words").not.toBeNull();
    expect(served.querySelector(".text-chart-workflow"), "the series token is a mark's colour, never the words' ink").toBeNull();
    expect(handed.textContent).toBe("agentic");
    expect(agent.textContent).toBe("agentic");
    expect(handed.querySelector(".fill-chart-workflow")).toBeNull();
  });
  it("a workflow run reads workflow", () => {
    const [flow] = kinds([{ ...base, kind: "workflow" }]);
    expect(flow.textContent).toBe("workflow");
  });
});

describe("a served run's page header", () => {
  it("reads Learned workflow and its name before the revision and where it ran", () => {
    expect(facts(SERVED)).toBe("Learned workflow mcc-guess · rev 2 · on the server");
    expect(header(SERVED).querySelector('[data-run-kind="learned"] .fill-chart-workflow')).not.toBeNull();
  });
  it("a handed-back run reads agentic, handed back by its workflow; an agent run reads agentic", () => {
    expect(facts(HANDED)).toBe("agentic · handed back by mcc-guess · rev 2 · on the server");
    expect(facts(AGENT)).toBe("agentic · rev 2 · on the server");
  });
  it("a served run whose workflow is not named reads Learned workflow alone", () => {
    expect(facts({ ...SERVED, served: { workflow: null, digest: null } })).toBe("Learned workflow · rev 2 · on the server");
  });
});
