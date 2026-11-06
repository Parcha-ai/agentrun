import type { Meta, StoryObj } from "@storybook/react-vite";
import { MissionControl } from "@/components/MissionControl";
import { NeedsYouStrip } from "@/components/NeedsYouStrip";
import { StartHere } from "@/components/StartHere";
import { Shell } from "@/components/Shell";
import { editorCaps, recorded } from "@/fixtures";
import type { Run } from "@/lib/v2";
import { type Analytics, type MissionView, rangeFrom } from "@/lib/mission";

// Mission Control, the console's first page, on the recorded runs (src/fixtures).
const meta: Meta = { title: "Mission Control" };
export default meta;
type Story = StoryObj;
// The analytics: 30 days of runs, two harnesses, a day with failures, tools with errors, some runs
// imported, and token sums that leave a few runs out.
const g = (runs: number, completed: number, failed: number, withMetrics: number, tokens: number, cost: number | null, unknown = 0, review = 0) =>
  ({ runs, completed, failed, needs_review: review, runs_with_metrics: withMetrics, tokens, cost_usd: cost, unknown_cost_runs: unknown });
// Relative to today, so the trend (the last 30 days) always has these days to draw.
const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
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
  tools: [{ tool: "fetch_page", label: "Fetch web pages", calls: 412, errors: 31 }, { tool: "bash", label: "Run commands", calls: 280, errors: 4 }, { tool: "read", label: "Read files", calls: 190, errors: 0 }, { tool: "pdf_pages", label: "Read PDF pages", calls: 44, errors: 6 }, { tool: "write", label: "Write files", calls: 37, errors: 1 }],
};
/** No runs in the range: the analytics as they read then. */
const quiet: Analytics = { ...analytics, totals: { ...g(0, 0, 0, 0, 0, null), input: 0, cache_read: 0, cache_write: 0, output: 0, requests: 0, unmetered: 0 }, time: { ended_runs: 0, wall_ms: 0, active_runs: 0, active_ms: 0 }, by_harness_effort: [], by_day: [], by_source: [], tools: [] };
const view = (cost: MissionView["cost"]): MissionView => ({
  agents: 4, runs: { total: 32, active: 2, needsInput: 3, failed: 5, statusUnknown: 1, needsReview: 1 },
  perAgent: [{ agentId: "meeting-notes", name: "Meeting notes", runs: 12 }, { agentId: "invoice-checker", name: "Invoice checker", runs: 9 }, { agentId: "lead-scorer", name: "Lead scorer", runs: 7 }, { agentId: "support-triage", name: "Support triage", runs: 4 }],
  cost, recent: recorded<{ runs: Run[] }>("runs.list").body.runs.slice(0, 10), analytics,
});
export const Typical: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: 0.0431, basis: "estimate", unknownRuns: 2 })} /></Shell> };
export const CostUnknown: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: null, basis: null, unknownRuns: 32 })} /></Shell> };
export const EmptyStore: Story = { render: () => <Shell active="mission"><MissionControl view={{ agents: 0, runs: { total: 0, active: 0, needsInput: 0, failed: 0, statusUnknown: 0, needsReview: 0 }, perAgent: [], cost: { usd: null, basis: null, unknownRuns: 0 }, recent: [], analytics: quiet }} /></Shell> };
export const Phone: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: 1.25, basis: "estimate", unknownRuns: 0 })} /></Shell>, globals: { viewport: { value: "mobile1" } } };

const scope = { range: "30d" as const, onRange: () => {}, agent: null, onAgent: () => {} };
export const WithAnalytics: Story = { render: () => <Shell active="mission"><MissionControl view={{ ...view({ usd: 1.6381, basis: "estimate", unknownRuns: 7 }), analytics }} scope={scope} /></Shell> };
export const AnalyticsNoRuns: Story = { render: () => <Shell active="mission"><MissionControl view={{ ...view({ usd: null, basis: null, unknownRuns: 0 }), analytics: quiet }} scope={{ ...scope, range: "7d" }} /></Shell> };

// What needs a person, first: two questions (one with the choices it offers), two runs stopped by the same error and one
// by its own, and a run at work.
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const needRun = (id: string, agent: string, over: Partial<Run>): Run => ({
  run_id: id, agent_id: agent, agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: id, created_at: ago(12),
  ended_at: null, result: null, error: null, cost: null, archived_at: null, ...over,
});
const overloaded = { code: "run_failed", message: "529 overloaded: the provider is over capacity, try again shortly", retryable: false };
const names: Record<string, string> = { "invoice-checker": "Invoice checker", "support-triage": "Support triage", "lead-scorer": "Lead scorer", "meeting-notes": "Meeting notes" };
const strip = (
  <NeedsYouStrip agentName={(id) => names[id] ?? id} onAnswer={async () => null} onRunAgain={async (runs) => ({ started: runs.map((r) => r.run_id), problem: null })} onStop={async () => null}
    asking={[
      needRun("q1", "invoice-checker", { status: "input_required", state: "waiting", title: "Check invoice INV-2310 from Contoso Freight, a new vendor.", pending: { kind: "question", question: "Contoso Freight isn't on the vendor list yet. Which approval limit applies: the $5,000 standard or the $25,000 preferred tier?", asked_at: ago(9) } }),
      needRun("q2", "support-triage", { status: "input_required", state: "waiting", title: "Triage ticket #4427: refund request over the policy limit.", pending: { kind: "question", question: "Which product or plan was charged twice?", asked_at: ago(3) } }),
    ]}
    failed={[
      needRun("f1", "lead-scorer", { status: "failed", title: "Score the lead: Hooli, partner referral.", error: overloaded, ended_at: ago(8) }),
      needRun("f2", "support-triage", { status: "failed", title: "Triage ticket #4425: webhook retries never stop.", error: overloaded, ended_at: ago(8) }),
      needRun("f3", "invoice-checker", { status: "failed", title: "Check invoice INV-2299 against PO-7790.", error: { code: "spend_cap_reached", message: "the run hit its $0.50 spend cap", retryable: false }, ended_at: ago(20) }),
    ]}
    live={[needRun("w1", "meeting-notes", { status: "working", state: "working", title: "Summarize this week's planning call.", created_at: ago(2), cost: { usd: 0.0031, basis: "estimate", charge_state: null, cap_usd: null } })]} />
);
export const NeedsYou: Story = { render: () => <Shell active="mission"><MissionControl view={{ ...view({ usd: 1.6381, basis: "estimate", unknownRuns: 7 }), analytics }} scope={scope} needsYou={strip} /></Shell> };
// Before the owner's first run: three templates, one click each, and the sessions imported from this machine.
const ready = [{ id: "pi", available: true, default_model: "faux/faux-1" }];
export const StartHereFirstRun: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: null, basis: null, unknownRuns: 0 })} startHere={<StartHere harnesses={ready} tools={editorCaps.tools} onTry={async () => null} imported={6} />} /></Shell> };
// No harness here has a model to run: the model step comes first.
export const StartHereNoModel: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: null, basis: null, unknownRuns: 0 })} startHere={<StartHere harnesses={[{ id: "pi", available: true, default_model: null }]} tools={editorCaps.tools} onTry={async () => null} />} /></Shell> };
