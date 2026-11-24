import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunDetail } from "@/components/RunDetail";
import { Shell } from "@/components/Shell";
import { failedWith, recorded, recordedFileText, runFixture, messageFeatures } from "@/fixtures";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

// Every story renders a run AgentRun Server returned (src/fixtures), in the shell, as the console shows it.
const meta: Meta<typeof RunDetail> = { title: "Run detail", component: RunDetail };
export default meta;
type Story = StoryObj<typeof RunDetail>;

const noop = () => {};
const story = (name: string, extra: Partial<React.ComponentProps<typeof RunDetail>> = {}): Story => ({
  render: () => {
    const [code, message] = name.startsWith("failed:") ? name.slice(7).split("|") : [];
    const f = code ? failedWith(code, message ? new RegExp(message) : undefined) : runFixture(name);
    return (
      <Shell active="runs">
        <RunDetail run={f.run} agentName={f.agentName} messages={messageFeatures} harnessSteers rows={f.page.rows} files={f.files} actions={{ onStop: noop, onCancel: noop }} onMessage={noop}
          readFile={async () => recordedFileText()} {...extra} />
      </Shell>
    );
  },
});

const agenticWorking = ["run.working.working.1", "run.working.working.2"].find((n) => recorded<Run>(n).body.kind === "agentic")!;
const workflowWorking = ["run.working.working.1", "run.working.working.2"].find((n) => recorded<Run>(n).body.kind === "workflow")!;

export const Completed: Story = story("run.with-files");
export const CompletedWorkflow: Story = story("run.completed.idle.1");
export const Working: Story = story(agenticWorking);
export const WorkingWorkflow: Story = story(workflowWorking);
export const WorkingAfterRestart: Story = story("run.working.idle.1");
export const Queued: Story = story("run.queued.working.1");
export const InputRequired: Story = story("run.input_required.waiting.1");
export const Stopped: Story = story("run.input_required.idle.1");
export const Cancelled: Story = story("run.cancelled.idle.1");
export const FailedProvider: Story = story("failed:run_failed|503");
export const FailedSpendCap: Story = story("failed:spend_cap_reached");
export const FailedEscalated: Story = story("failed:escalated");
export const Files: Story = story("run.with-files", { tab: "files" });
export const ArtifactOpen: Story = {
  render: () => {
    const f = runFixture("run.with-files");
    return (
      <Shell active="runs">
        <RunDetail run={f.run} agentName={f.agentName} messages={messageFeatures} harnessSteers rows={f.page.rows} files={f.files} tab="files" openFile={f.files[0] as RunFile} readFile={async () => recordedFileText()} />
      </Shell>
    );
  },
};
export const Phone: Story = { ...story("run.input_required.waiting.1"), globals: { viewport: { value: "mobile1" } } };

// A finished run that recorded its computer's screen: the Screen tab plays its recordings, a picker for the two, with the
// steps the run took while each was recorded beside it (a step moves the video to its time). The file is the story's own
// path beside it (none ships with Storybook, so the player shows its controls on an empty frame).
const RECORDED_AT = Date.parse("2026-11-05T09:00:00Z");
const recordedRows = (kind: "desktop" | "phone"): TimelineRow[] => {
  let seq = 10_000;
  const row = (at: number, rowKind: TimelineRow["kind"], summary: string, more: Partial<TimelineRow> = {}) => {
    const timestamp = new Date(RECORDED_AT + at * 1000).toISOString();
    return { id: `rec-${(seq += 1)}`, seq, kind: rowKind, summary, text: null, timestamp, created_at: timestamp, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null,
      tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, ...more } as TimelineRow;
  };
  const tool = (at: number, name: string, did: string, id: string, took = 2) => [
    row(at, "tool_use", name, { tool_name: name, tool_use_id: id }),
    row(at + took, "tool_result", `${did}: ok`, { tool_name: name, tool_use_id: id, tool_status: "success" }),
  ];
  return [
    row(0, "phase", `Recording the ${kind}'s screen into recordings/${kind}.mp4.`),
    ...tool(3, "computer_act", "Opened Chrome", "rec-1"),
    ...tool(9, "computer_observe", "Looked at Chrome", "rec-2", 1),
    row(14, "thinking", "Thinking: Six results, two of them nonstop. Filter to nonstop and sort by price."),
    ...tool(18, "computer_act", "Clicked the check box “Nonstop only”, clicked the pop-up “Sort”, clicked “Price: low to high”", "rec-3"),
    row(24, "phase", `You took over the ${kind}`),
    row(31, "phase", `You handed the ${kind} back`),
    ...tool(34, "computer_act", "Clicked “Select”", "rec-4"),
    row(40, "final_answer", "The cheapest nonstop is Skyline 214 at $238."),
    row(60, "phase", `Recording the ${kind}'s screen into recordings/${kind}-2.mp4.`),
    ...tool(64, "computer_observe", "Looked at Chrome", "rec-5", 1),
    ...tool(70, "computer_act", "Typed into the text box “Name”", "rec-6"),
  ];
};
const recordedRun = (kind: "desktop" | "phone"): Story => ({
  render: () => {
    const f = runFixture("run.with-files");
    const recordings = [1, 2].map((n) => ({ path: `recordings/${kind}${n === 1 ? "" : `-${n}`}.mp4`, computer: kind, seconds: 42, bytes: 3_145_728, finished: true }));
    const run = { ...f.run, computer: { kind, provider: "docker", state: "ready" }, recordings } as Run;
    return (
      <Shell active="runs">
        <RunDetail run={run} agentName={f.agentName} messages={messageFeatures} harnessSteers rows={[...f.page.rows, ...recordedRows(kind)]} files={f.files} tab="screen" fileUrl={(path) => path}
          readComputer={async () => ({ state: "none", kind, hold: "agent", session: "closed" })} />
      </Shell>
    );
  },
});
export const RecordingPlayed: Story = recordedRun("desktop");
export const RecordingPlayedPhone: Story = recordedRun("phone");
