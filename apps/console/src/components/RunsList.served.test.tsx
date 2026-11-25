import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunsList } from "./RunsList";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// A run a learned workflow answered alone (the server's `path` `workflow`, as GET .../learning/cost places it) says so on
// the runs list and on its run page, with the Learning tab's workflow series mark beside the words; every other run reads
// its kind, and a run the workflow handed back reads as the agent's, its hand-back named on the run page alone.
const base: Run = {
  sha: null, updated_at: "2026-11-18T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" }, learning_work: { state: "none", runs: [], ended_at: null, deadline_at: null },
  run_id: "r1", agent_id: "mcc", agent_version: 2, revision: "rv2", kind: "agentic", status: "completed", state: "idle", title: "Coffee shop",
  created_at: "2026-11-18T06:00:00Z", ended_at: "2026-11-18T06:00:03Z", result: null, error: null, cost: { usd: 0.002, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
};
const SERVED: Run = { ...base, run_id: "r-served", path: "workflow", workflow: { name: "mcc-guess", digest: "d".repeat(16), repick: null } };
const HANDED: Run = { ...base, run_id: "r-handed", path: "handed_back", workflow: { name: "mcc-guess", digest: "d".repeat(16), repick: null } };
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
    expect(facts({ ...SERVED, workflow: { name: null, digest: null, repick: null } })).toBe("Learned workflow · rev 2 · on the server");
  });
});

// A quote miss re-picks a compiled answer once before it hands back (the server's `workflow.repick`, from the run's loop
// rows): the run page says which pass answered, beside the served label; the runs list keeps its one word.
describe("a re-picked run's page header", () => {
  const repicked = (run: Run, repick: "found" | "missed"): Run => ({ ...run, workflow: { name: "mcc-guess", digest: "d".repeat(16), repick } });
  const repickOf = (run: Run) => header(run).querySelector('[data-run-kind="learned"] [data-run-repick]')?.getAttribute("data-run-repick");
  /** The run kind's own words on its run page (RunKind), never the rest of the header line. */
  const kindOf = (run: Run) => header(run).querySelector('[data-run-kind="agentic"]')?.textContent;
  it("a served run whose re-pick found its quotes is marked re-picked beside the served label", () => {
    expect(repickOf(repicked(SERVED, "found"))).toBe("found");
  });
  it("a handed-back run whose re-pick missed says so before its hand-back", () => {
    expect(kindOf(repicked(HANDED, "missed"))).toBe("agentic · handed back by mcc-guess after its re-pick missed");
  });
  it("a handed-back run whose re-pick found its quotes says it re-picked before its hand-back", () => {
    expect(kindOf(repicked(HANDED, "found"))).toBe("agentic · handed back by mcc-guess after a re-pick");
  });
  it("a run answered on its first pass is not marked, and the runs list keeps Learned workflow", () => {
    expect(header(SERVED).querySelector("[data-run-repick]")).toBeNull();
    const [served] = kinds([repicked(SERVED, "found")]);
    expect(served.textContent).toBe("Learned workflow");
  });
});
