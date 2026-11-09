import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { Run } from "@/lib/v2";

// A run of an agent that never asks (Run.approvals, from the revision it started on) says Unattended in its header: no
// call of it waits for the owner.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const run = (approvals?: "ask" | "never"): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0,
  run_id: "r1", agent_id: "watcher", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Watch the repo",
  created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, ...(approvals ? { approvals } : {}),
} as Run);
const header = (r: Run) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunHeader, { run: r, agentName: "Watcher" })));
  return host;
};

describe("RunHeader, a run that never asks", () => {
  it("says Unattended for a run whose agent never asks, and nothing for one that asks", () => {
    const chip = (host: HTMLElement) => [...host.querySelectorAll("header *")].find((e) => e.children.length === 0 && e.textContent === "Unattended");
    expect(chip(header(run("never")))).toBeTruthy();
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(chip(header(run("ask")))).toBeUndefined();
    act(() => root?.unmount()); document.body.innerHTML = "";
    expect(chip(header(run()))).toBeUndefined();
  });
});
