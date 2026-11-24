import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunDetail } from "@/components/RunDetail";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_LIVE, TRACE_LIVE_NOW, TRACE_START, TRACE_USD, USAGE_MACHINES, USAGE_REDO } from "@/components/RunTrace.sample";
import { Shell } from "@/components/Shell";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run, RunTrace, RunUsage } from "@/lib/v2";

// The run page's Dev tools tab over hand-written traces (RunTrace.sample.ts), in the shell, as the console shows it.
const meta: Meta<typeof RunDetail> = { title: "Run detail/Dev tools", component: RunDetail };
export default meta;
type Story = StoryObj<typeof RunDetail>;

const noop = () => {};
/** A recorded run dressed as the sample trace's run: its title, its times and its cost. */
const runOf = (name: string, over: Partial<Run>): Run => ({ ...runFixture(name).run, title: "Screen Northwind Freight Ltd before onboarding", created_at: new Date(TRACE_START).toISOString(), ...over });
const ENDED = runOf("run.with-files", { ended_at: new Date(TRACE_END).toISOString(), cost: { usd: TRACE_USD, basis: "estimate" } });

const story = (run: Run, trace: RunTrace, at: NonNullable<React.ComponentProps<typeof RunDetail>["traceAt"]>, usage?: RunUsage): Story => ({
  render: () => {
    const f = runFixture("run.with-files");
    return (
      <Shell active="runs">
        <RunDetail run={run} agentName="supplier-screening" messages={messageFeatures} harnessSteers rows={f.page.rows} files={f.files} actions={{ onStop: noop, onCancel: noop }} onMessage={noop}
          tab="trace" readTrace={async () => trace} readUsage={usage ? async () => usage : undefined} traceAt={at} />
      </Shell>
    );
  },
});

export const Calls: Story = story(ENDED, TRACE, { now: TRACE_END });
export const ModelRequest: Story = story(ENDED, TRACE, { now: TRACE_END, open: "m:0:24" });
export const ToolCall: Story = story(ENDED, TRACE, { now: TRACE_END, open: "t:0:call_08" });
export const FailedCall: Story = story(ENDED, TRACE, { now: TRACE_END, open: "t:0:call_07" });
export const Breakdown: Story = story(ENDED, TRACE, { now: TRACE_END, view: "breakdown" });
export const Live: Story = story(runOf("run.working.working.1", { cost: { usd: null, basis: "estimate", so_far_usd: 0.3583, unpriced: 0 } }), TRACE_LIVE, { now: TRACE_LIVE_NOW, open: "t:0:call_15" });
export const CliHarness: Story = story(runOf("run.with-files", { ended_at: new Date(TRACE_START + 21_000).toISOString(), title: "Fix the failing totals test" }), TRACE_CLI, { now: TRACE_START + 21_000 });
export const NoCalls: Story = story(ENDED, { run_id: "run_7f3a9c2e", model_requests: "priced", spans: [], dropped: 0 }, { now: TRACE_END });
export const Phone: Story = { ...story(ENDED, TRACE, { now: TRACE_END, open: "m:0:24" }), globals: { viewport: { value: "mobile1" } } };
// The run's computer and its browser session, each a lane under its calls (and a row of the Breakdown).
export const ComputersAndSessions: Story = story(ENDED, TRACE, { now: TRACE_END }, USAGE_MACHINES);
// A run that stopped short for its $0.75 cap, one turn of which was worked twice: both stand out, the cost tile says its
// share of the cap, and each cost line says its attempt.
const SHORT = { ...ENDED, cost: { ...ENDED.cost!, cap_usd: 0.75 }, stopped_for: "budget" as const, budget_refused_calls: 3 };
export const BudgetStopAndRedoneWork: Story = story(SHORT, TRACE, { now: TRACE_END, view: "breakdown" }, { ...USAGE_REDO, run_id: TRACE.run_id, computer_intervals: USAGE_MACHINES.computer_intervals, browser_sessions: USAGE_MACHINES.browser_sessions });
