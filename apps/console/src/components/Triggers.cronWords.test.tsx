import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulesPage } from "./Schedules";
import { createClient } from "@/lib/client";
import type { Trigger } from "@/lib/v2";

// A schedule's cron line reads in words on the Triggers list and on its page, in the viewer's time with its own in
// parentheses ("At 3:00 AM your time (08:00 UTC), only on Monday · next Mon Nov 16, 3:00 AM EST" from New York); the raw
// line stays the words' tooltip (and the editor's field), never the text.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.stubEnv("TZ", "America/New_York"); });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllEnvs(); });
const LINE = "At 3:00 AM your time (08:00 UTC), only on Monday · next Mon Nov 16, 3:00 AM EST";

const DIGEST: Trigger = {
  id: "trg_d", name: "weekly-digest", enabled: true, source: { kind: "schedule", cron: "0 8 * * 1", timezone: "UTC" },
  target: { kind: "start_run", agent_id: "monitor", input: { content: "Write the weekly digest." }, max_cost_usd: 2 },
  catchup_window_s: 0, max_active_runs: 1, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-16T08:00:00Z", last_firing: null,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const v2 = () => createClient({ fetch: (async (url: string) => {
  const path = new URL(String(url), "http://serve.test").pathname;
  if (path === "/v2/triggers") return json(200, { triggers: [DIGEST] });
  if (path === "/v2/triggers/trg_d") return json(200, DIGEST);
  if (path === "/v2/triggers/trg_d/firings") return json(200, { firings: [] });
  return json(404, { error: { code: "not_found", message: path, retryable: false } });
}) as typeof globalThis.fetch });

async function open(view: Parameters<typeof SchedulesPage>[0]["view"]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(SchedulesPage, { v2: v2(), view, go: () => {}, agentName: (id: string) => id })));
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

describe("a schedule's cron in words", () => {
  it("in the list: the words, with the raw line only as their title", async () => {
    const host = await open({});
    const row = host.querySelector('[data-trigger="trg_d"]')!;
    expect(row.querySelector('[title="0 8 * * 1"]')!.textContent).toBe(`${LINE} · monitor`);
    expect(row.textContent).not.toContain("0 8 * * 1");
  });

  it("on its page: the words and its next time, the raw line only as their title", async () => {
    const host = await open({ trigger: "trg_d" });
    expect(host.querySelector('[title="0 8 * * 1"]')!.textContent).toBe(LINE);
    expect(host.textContent).not.toContain("0 8 * * 1");
  });
});
