import type { Meta, StoryObj } from "@storybook/react";
import { MissionControl } from "@/components/MissionControl";
import { Shell } from "@/components/Shell";
import { recorded } from "@/fixtures";
import type { Run } from "@/lib/v2";
import { type Analytics, type MissionView, rangeFrom } from "@/lib/mission";

// Mission Control, the console's first page, on the recorded runs (src/fixtures).
const meta: Meta = { title: "Mission Control" };
export default meta;
type Story = StoryObj;
const view = (cost: MissionView["cost"]): MissionView => ({
  agents: 4, runs: { total: 32, active: 2, needsInput: 3, failed: 5, statusUnknown: 1 },
  perAgent: [{ agentId: "meeting-notes", name: "Meeting notes", runs: 12 }, { agentId: "invoice-checker", name: "Invoice checker", runs: 9 }, { agentId: "lead-scorer", name: "Lead scorer", runs: 7 }, { agentId: "support-triage", name: "Support triage", runs: 4 }],
  cost, recent: recorded<{ runs: Run[] }>("runs.list").body.runs.slice(0, 10),
});
export const Typical: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: 0.0431, basis: "estimate", unknownRuns: 2 })} /></Shell> };
export const CostUnknown: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: null, basis: null, unknownRuns: 32 })} /></Shell> };
export const EmptyStore: Story = { render: () => <Shell active="mission"><MissionControl view={{ agents: 0, runs: { total: 0, active: 0, needsInput: 0, failed: 0, statusUnknown: 0 }, perAgent: [], cost: { usd: null, basis: null, unknownRuns: 0 }, recent: [] }} /></Shell> };
export const Phone: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: 1.25, basis: "estimate", unknownRuns: 0 })} /></Shell>, globals: { viewport: { value: "mobile1" } } };

// With a newer server's analytics: 30 days of runs, two harnesses, a day with failures, tools with errors, some runs
// imported, and token sums that leave a few runs out.
const g = (runs: number, completed: number, failed: number, withMetrics: number, tokens: number, cost: number | null, unknown = 0) =>
  ({ runs, completed, failed, runs_with_metrics: withMetrics, tokens, cost_usd: cost, unknown_cost_runs: unknown });
const today = Date.UTC(2026, 10, 1);
const days: Analytics["by_day"] = Array.from({ length: 30 }, (_, k) => {
  const runs = [0, 1, 2, 4, 3, 0, 5, 6, 2, 1][k % 10]!, failed = k % 7 === 3 ? 2 : k % 5 === 0 && runs ? 1 : 0;
  return { day: new Date(today - (29 - k) * 86_400_000).toISOString().slice(0, 10), ...g(runs, Math.max(0, runs - failed - (k === 29 ? 1 : 0)), Math.min(failed, runs), runs, runs * 42_000 + k * 1_500, runs ? runs * 0.021 : null) };
}).filter((d) => d.runs > 0);
const analytics: Analytics = {
  filter: { from: rangeFrom("30d", today) ?? null, to: null, agent: null },
  totals: { ...g(78, 64, 11, 71, 3_412_000, 1.6381, 7), input: 720_000, cache_read: 2_150_000, cache_write: 140_000, output: 402_000, requests: 611, unmetered: 9 },
  time: { ended_runs: 76, wall_ms: 31_320_000, active_runs: 41, active_ms: 12_960_000 },
  by_harness_effort: [{ harness: "codex", effort: "high", ...g(22, 19, 3, 22, 1_480_000, 0.902) }, { harness: "codex", effort: "medium", ...g(14, 12, 2, 14, 610_000, 0.311) }, { harness: "pi", effort: null, ...g(31, 24, 5, 28, 1_090_000, 0.4251, 3) }, { harness: "workflow", effort: null, ...g(11, 9, 1, 7, 232_000, null, 4) }],
  by_day: days,
  by_source: [{ source: "live", ...g(66, 54, 10, 59, 2_900_000, 1.6381, 4) }, { source: "codex", ...g(12, 10, 1, 12, 512_000, null, 3) }],
  tools: [{ tool: "fetch_page", calls: 412, errors: 31 }, { tool: "bash", calls: 280, errors: 4 }, { tool: "read", calls: 190, errors: 0 }, { tool: "pdf_pages", calls: 44, errors: 6 }, { tool: "write", calls: 37, errors: 1 }],
};
const scope = { range: "30d" as const, onRange: () => {}, agent: null, onAgent: () => {} };
export const WithAnalytics: Story = { render: () => <Shell active="mission"><MissionControl view={{ ...view({ usd: 1.6381, basis: "estimate", unknownRuns: 7 }), analytics }} scope={scope} /></Shell> };
export const AnalyticsNoRuns: Story = { render: () => <Shell active="mission"><MissionControl view={{ ...view({ usd: null, basis: null, unknownRuns: 0 }), analytics: { ...analytics, totals: { ...g(0, 0, 0, 0, 0, null), input: 0, cache_read: 0, cache_write: 0, output: 0, requests: 0, unmetered: 0 }, time: { ended_runs: 0, wall_ms: 0, active_runs: 0, active_ms: 0 }, by_harness_effort: [], by_day: [], by_source: [], tools: [] } }} scope={{ ...scope, range: "7d" }} /></Shell> };
