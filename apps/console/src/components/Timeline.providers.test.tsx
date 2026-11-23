import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "./Timeline";
import type { Run, TimelineRow } from "@/lib/v2";

const row = (over: Partial<TimelineRow>): TimelineRow => ({
  id: "tool", seq: 1, kind: "tool_result", timestamp: "2026-11-17T00:00:00Z", created_at: "2026-11-17T00:00:00Z",
  summary: "Looked up the company", text: null, agent_label: null, tool_name: "monid.run", tool_use_id: "call",
  tool_status: "success", tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, ...over,
});
const draw = (rows: TimelineRow[], computer?: Run["computer"]) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Timeline rows={rows} computer={computer} live={false} />);
  return host;
};

describe("provider identity on a timeline step", () => {
  it("shows Monid on a folded call and result, alongside the existing tool label", () => {
    const host = draw([row({ id: "call", kind: "tool_use" }), row({ id: "result", seq: 2 })]);
    expect(host.querySelectorAll('[data-provider-icon="monid"]')).toHaveLength(1);
    expect(host.querySelector("[data-label]")?.textContent).toBe("Monid.run");
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("keeps approval, failure and pause signals beside the provider", () => {
    const approval = draw([row({ kind: "tool_approval_requested", summary: "Waiting for your approval: monid.run" })]);
    expect(approval.querySelector(".lucide-shield-question")).not.toBeNull();
    expect(approval.querySelector('[data-provider-icon="monid"]')).not.toBeNull();
    expect(approval.textContent).toContain("Approval required");
    const failed = draw([row({ tool_status: "failed" })]);
    expect(failed.querySelector('[data-provider-icon="monid"]')).not.toBeNull();
    expect(failed.textContent).toContain("Error");
    const paused = draw([row({ kind: "phase", paused: true })]);
    expect(paused.querySelector(".lucide-circle-pause")).not.toBeNull();
    expect(paused.querySelector("img")).toBeNull();
  });

  it("uses the run's pinned browser provider only for browser tools", () => {
    const computer = { kind: "browser", provider: "kernel", state: "ready" } as const;
    const browser = draw([row({ tool_name: "snapshot" })], computer);
    expect(browser.querySelector('[data-provider-icon="kernel"]')).not.toBeNull();
    const search = draw([row({ tool_name: "web_search" })], computer);
    expect(search.querySelector('[data-provider-icon="kernel"]')).toBeNull();
    expect(search.querySelector('[data-provider-icon="parallel"]')).toBeNull();
  });

  it("uses the desktop provider for computer tools and the recorded computer-call group", () => {
    const host = draw([row({ tool_name: "computer_act", computer_calls: [{ method: "ui.act", ok: true, ms: 30, started_at: "2026-11-17T00:00:00Z" }] })],
      { kind: "desktop", provider: "orgo", state: "ready" });
    expect(host.querySelectorAll('[data-provider-icon="orgo"]')).toHaveLength(2);
    expect(host.textContent).toContain("1 computer call");
  });

  it.each(["docker", "daytona", "modal", "e2b", "agent37"])("shows %s on sandbox shell calls, including background processes", (provider) => {
    for (const tool_name of ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]) {
      const host = draw([row({ tool_name })], { kind: "sandbox", provider, state: "ready" });
      expect(host.querySelector("img")?.getAttribute("data-provider-icon"), tool_name).toBe(provider);
    }
  });

  it("does not label unrelated tools or a shell with no pinned sandbox as the sandbox provider", () => {
    for (const tool_name of ["web_search", "web_fetch", "codemode", "read", "write", "mcp:custom/bash"]) {
      const host = draw([row({ tool_name })], { kind: "sandbox", provider: "modal", state: "ready" });
      expect(host.querySelector('[data-provider-icon="modal"]'), tool_name).toBeNull();
    }
    expect(draw([row({ tool_name: "bash" })]).querySelector("img")).toBeNull();
  });
});
