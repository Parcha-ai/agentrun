import type { Meta, StoryObj } from "@storybook/react-vite";
import { Race } from "@/components/Race";
import { runFixture } from "@/fixtures";
import type { Run, TimelinePage } from "@/lib/v2";

const meta: Meta<typeof Race> = { title: "Race", component: Race };
export default meta;
type Story = StoryObj<typeof Race>;

/** A server that answers a race from the recorded runs: each fixture becomes a lane, with its timeline as recorded. */
function recordedRace(lanes: { fixture: string; harness: string; model: string }[]) {
  const runs = lanes.map(({ fixture, harness, model }, i): { run: Run; page: TimelinePage } => {
    const f = runFixture(fixture);
    return { run: { ...f.run, run_id: `${f.run.run_id}-${i}`, labels: { race: "story", lane: String(i + 1), harness, model } }, page: { ...f.page, final: true, has_more: false } };
  });
  return {
    listRuns: async () => ({ runs: runs.map((r) => r.run), next_cursor: null }),
    getRun: async (id: string) => runs.find((r) => r.run.run_id === id)!.run,
    getTimeline: async (id: string) => runs.find((r) => r.run.run_id === id)!.page,
  } as never;
}

export const TwoLanes: Story = {
  args: { label: "story", v2: recordedRace([{ fixture: "run.completed.idle.1", harness: "pi", model: "anthropic/claude-sonnet-5-5" }, { fixture: "run.with-files", harness: "codex", model: "openai/gpt-6.1-sol" }]) },
};

export const FourLanes: Story = {
  args: { label: "story", v2: recordedRace([
    { fixture: "run.completed.idle.1", harness: "pi", model: "anthropic/claude-sonnet-5-5" },
    { fixture: "run.with-files", harness: "codex", model: "openai/gpt-6.1-sol" },
    { fixture: "run.cancelled.idle.1", harness: "claude-agent", model: "anthropic/claude-opus-5-5" },
    { fixture: "run.working.working.1", harness: "cursor", model: "cursor/auto" },
  ]) },
};

export const Empty: Story = { args: { label: "nobody", v2: { listRuns: async () => ({ runs: [], next_cursor: null }) } as never } };
