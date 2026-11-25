import type { Meta, StoryObj } from "@storybook/react-vite";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_START, TRACE_USD } from "@/components/RunTrace.sample";
import { Shell } from "@/components/Shell";
import { TraceCompare } from "@/components/TraceCompare";
import { runFixture } from "@/fixtures";
import type { Run, RunTrace } from "@/lib/v2";

// The compare page (#/compare?runs=…) over the Dev tools tab's hand-written traces (RunTrace.sample.ts), in the shell.
const meta: Meta<typeof TraceCompare> = { title: "Run detail/Compare runs", component: TraceCompare };
export default meta;
type Story = StoryObj<typeof TraceCompare>;

const runOf = (id: string, title: string, over: Partial<Run> = {}): Run => ({ ...runFixture("run.with-files").run, run_id: id, title, created_at: new Date(TRACE_START).toISOString(), ended_at: new Date(TRACE_END).toISOString(), cost: { usd: TRACE_USD, basis: "estimate" }, ...over });
const RUNS: Record<string, { run: Run; trace: RunTrace }> = {
  run_a: { run: runOf("run_a", "Screen Northwind Freight Ltd before onboarding"), trace: TRACE },
  run_b: { run: runOf("run_b", "Fix the failing totals test", { ended_at: new Date(TRACE_START + 21_000).toISOString(), cost: { usd: 0.4379, basis: "estimate" } }), trace: TRACE_CLI },
  run_c: { run: runOf("run_c", "Screen Northwind Freight Ltd, second try", { cost: { usd: 0.5102, basis: "estimate" } }), trace: { ...TRACE, spans: TRACE.spans.filter((span) => span.status !== "failed").slice(0, 18) } },
};
const v2 = { getRun: async (id: string) => RUNS[id]!.run, runTrace: async (id: string) => RUNS[id]!.trace };
const story = (ids: string[]): Story => ({ render: () => <Shell active="runs"><TraceCompare v2={v2} ids={ids} now={TRACE_END} /></Shell> });

export const TwoRuns: Story = story(["run_a", "run_c"]);
export const AgainstACliRun: Story = story(["run_a", "run_b"]);
export const ThreeRuns: Story = story(["run_a", "run_c", "run_b"]);
export const OneRunNamed: Story = story(["run_a"]);
