import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// A run's header says its cost beside its spend cap, so a cap raised is seen: "$0.0059 est. of $1.00", and after a raise
// the raised cap, as the run is read again. A run with no cap says its cost alone, as before.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const run = (cap: number | null, status: Run["status"] = "completed"): Run => ({ sha: null, updated_at: "2026-11-11T11:01:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "r1", agent_id: "hello", agent_version: 8, revision: "rv8", kind: "agentic", status, state: status === "working" ? "working" : "idle", title: "Write a.md, then b.md",
  created_at: "2026-11-11T11:01:00Z", ended_at: status === "working" ? null : "2026-11-11T11:02:00Z", result: null, error: null, archived_at: null,
  cost: { usd: 0.0059, basis: "estimate", charge_state: null, cap_usd: cap },
});

function mount(r: Run) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunHeader, { run: r, agentName: "Hello, agentrun" })));
  return host;
}
const facts = (host: HTMLElement) => [...host.querySelectorAll("header span.font-mono")].map((s) => s.textContent);

describe("RunHeader, the cost and the cap", () => {
  it("a run with a cap says its cost of the cap", () => {
    const host = mount(run(1));
    expect(facts(host)).toContain("$0.0059 est. of $1.00");
  });

  it("after a raise, the run read again says the raised cap", () => {
    const host = mount(run(1, "working"));
    expect(facts(host)).toContain("$0.0059 est. of $1.00");
    act(() => root!.render(createElement(RunHeader, { run: run(2, "working"), agentName: "Hello, agentrun" })));
    expect(facts(host)).toContain("$0.0059 est. of $2.00");
    expect(facts(host)).not.toContain("$0.0059 est. of $1.00");
  });

  it("a run with no cap says its cost alone", () => {
    const host = mount(run(null));
    expect(facts(host)).toContain("$0.0059 est.");
    expect(host.textContent).not.toMatch(/ of \$|cap \$/);
  });
});
